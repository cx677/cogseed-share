/** 问答路由：SSE 流式回答 + 引用溯源 + 限流 + 预算护栏 + 成员/权限校验 */

import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/pool.js';
import { streamChat } from '../lib/llm.js';
import { rateLimitHit } from '../lib/ratelimit.js';
import { createEmbedder } from '../services/embedder.js';
import { retrieve } from '../services/retrieve.js';
import { visitorKeyFrom } from '../lib/shareid.js';
import type { AppConfig } from '../config.js';

interface ShareMeta {
  share_id: string;
  name: string;
  status: string;
  join_mode: string;
  member_permission: string;
  expire_at: string | null;
}

/** 校验访客能否访问（join_mode + member_permission）：
 *  - direct：直接可看（hidden 时内容 403）
 *  - apply：需 approved 成员
 *  - invite：需 approved 成员（邀请码加入即 approved）
 * 返回 { allowed, reason } */
async function checkAccess(shareId: string, req: { headers: Record<string, string | string[] | undefined> }, share: ShareMeta): Promise<{ allowed: boolean; reason?: string }> {
  if (share.member_permission === 'hidden') {
    return { allowed: false, reason: 'content hidden' };
  }
  if (share.join_mode === 'direct') return { allowed: true };
  const vk = visitorKeyFrom(req);
  const member = await queryOne<{ status: string }>(
    `SELECT status FROM share_members WHERE share_id = $1 AND visitor_key = $2`,
    [shareId, vk],
  );
  if (member?.status === 'approved') return { allowed: true };
  if (member?.status === 'pending') return { allowed: false, reason: 'pending' };
  return { allowed: false, reason: 'apply_or_invite_required' };
}

export function registerAskRoute(app: FastifyInstance, cfg: AppConfig): void {
  const embedder = createEmbedder(cfg.embed);

  app.post('/api/v1/shares/:shareId/ask', async (req, reply) => {
    const { shareId } = req.params as { shareId: string };
    const share = await queryOne<ShareMeta>(
      `SELECT share_id, name, status, join_mode, member_permission, expire_at FROM shares WHERE share_id = $1`,
      [shareId],
    );
    if (!share || share.status !== 'active') {
      return reply.code(404).send({ ok: false, error: 'share not found' });
    }
    if (share.expire_at && new Date(share.expire_at).getTime() < Date.now()) {
      return reply.code(403).send({ ok: false, error: 'share expired' });
    }
    const access = await checkAccess(shareId, req, share);
    if (!access.allowed) {
      return reply.code(403).send({ ok: false, error: access.reason ?? 'forbidden' });
    }

    const body = req.body as { question?: unknown };
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 2000) : '';
    if (!question) return reply.code(400).send({ ok: false, error: 'question required' });

    // 限流：按 IP + shareId
    const ip = String(req.ip ?? '');
    const lim = rateLimitHit(`ask:${ip}:${shareId}`, cfg.rateLimit.max, cfg.rateLimit.windowMs);
    if (!lim.allowed) {
      return reply.code(429).send({ ok: false, error: 'rate limited', retryAfterMs: lim.retryAfterMs });
    }

    // 检索
    let chunks: Awaited<ReturnType<typeof retrieve>> = [];
    try {
      const [qVec] = await embedder.embed([question]);
      if (qVec?.length) {
        chunks = await retrieve({ query: query as unknown as (t: string, p: unknown[]) => Promise<unknown[]> }, { shareId, questionVec: qVec, questionText: question });
      }
    } catch (err) {
      console.error(`[ask] embed/retrieve failed: ${(err as Error).message}`);
    }

    // 检索为空：明确提示（索引未就绪或内容无匹配）
    if (chunks.length === 0) {
      reply.send({
        ok: true,
        degraded: 'no_index',
        answer: '知识库内容尚未索引完成或没有匹配的内容，暂时无法回答。请稍后重试（若刚发布，索引可能需要几秒）。',
        citations: [],
      });
      return;
    }

    // 预算护栏：每日 LLM 消耗估算（按问答数粗算；正式按 token 需接计费接口）
    const budgetRow = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM share_questions WHERE share_id = $1 AND answered_at > now() - interval '1 day'`,
      [shareId],
    );
    const dailyCount = Number(budgetRow?.n ?? 0);
    // 粗估：单问约 0.02 元（deepseek 输入+输出），预算 5 元 → 250 问/天
    const estimatedCost = dailyCount * 0.02;
    if (estimatedCost >= cfg.dailyLlmBudgetYuan) {
      // 降级：检索摘要直出（不走 LLM）
      const digest = chunks.slice(0, 4).map((c, i) => `[${i + 1}] ${c.path}: ${c.content.slice(0, 120)}`).join('\n');
      return reply.send({
        ok: true, degraded: 'budget', answer: digest || '今日问答预算已用尽，以下为相关片段摘要。',
        citations: chunks.slice(0, 4).map((c) => ({ n: chunks.indexOf(c) + 1, path: c.path, snippet: c.content.slice(0, 200) })),
      });
    }

    // 组装 prompt + SSE 流式
    const system = `你是「${share.name}」知识库助手。仅基于给定片段回答，按 [n] 标注出处；片段没有答案时明确说"知识库中未找到相关内容"。回答用中文，简洁分点。`;
    const context = chunks.map((c, i) => `[${i + 1}] ${c.path}：${c.content}`).join('\n\n');
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: `片段：\n${context || '(无匹配片段)'}\n\n问题：${question}` },
    ];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let answer = '';
    try {
      const gen = streamChat({
        apiKey: cfg.llm.apiKey,
        baseUrl: cfg.llm.baseUrl,
        model: cfg.llm.model,
        messages,
        maxTokens: 1024,
        signal: (req.raw as { signal?: AbortSignal }).signal ?? undefined,
      });
      for await (const delta of gen) {
        answer += delta;
        reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    } catch (err) {
      const raw = (err as Error).message;
      const friendly = /401|Authentication|invalid.*key|api key/i.test(raw)
        ? '问答服务配置异常（LLM 密钥无效），请联系知识库管理员。'
        : `回答生成失败：${raw.slice(0, 120)}`;
      reply.raw.write(`data: ${JSON.stringify({ error: friendly })}\n\n`);
    }

    // 引用
    const citations = chunks.slice(0, 6).map((c, i) => ({ n: i + 1, path: c.path, snippet: c.content.slice(0, 200) }));
    reply.raw.write(`data: ${JSON.stringify({ done: true, citations })}\n\n`);
    reply.raw.end();

    // 异步记录统计
    void query(`INSERT INTO share_questions (share_id, question) VALUES ($1,$2)`, [shareId, question]).catch(() => undefined);
  });

  // 统计（客户端）
  app.get('/api/v1/shares/:shareId/stats', async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (!cfg.adminApiKeys.includes(token)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId } = req.params as { shareId: string };
    const total = (await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM share_questions WHERE share_id = $1`, [shareId]))?.n ?? '0';
    const top = await query<{ q: string; n: string }>(
      `SELECT question AS q, count(*)::text AS n FROM share_questions WHERE share_id = $1 GROUP BY question ORDER BY count(*) DESC LIMIT 10`,
      [shareId],
    );
    return { ok: true, totalAsks: Number(total), topQuestions: top.map((t) => ({ q: t.q, n: Number(t.n) })) };
  });
}
