/** 分享管理路由（客户端 API Key 鉴权）：发布/更新/撤销/权限同步/成员管理 */

import type { FastifyInstance } from 'fastify';
import { isAdminRequest } from '../lib/auth.js';
import { createEmbedder } from '../services/embedder.js';
import { indexShare } from '../services/index-service.js';
import {
  publishShare, getShare, revokeShare, updateSharePolicy,
  applyJoin, getMemberStatus, listMembers, reviewMember, removeMember,
  createInvite, redeemInvite, listInvites,
} from '../services/share-service.js';
import { query } from '../db/pool.js';
import type { AppConfig } from '../config.js';
import { visitorKeyFrom } from '../lib/shareid.js';

const JOIN_MODES = new Set(['direct', 'apply', 'invite']);
const MEMBER_PERMS = new Set(['view_export', 'view_only', 'hidden']);

function validateFiles(files: unknown): boolean {
  return Array.isArray(files) && files.length <= 200
    && files.every((f) => f && typeof f === 'object'
      && typeof (f as { path?: unknown }).path === 'string'
      && typeof (f as { title?: unknown }).title === 'string');
}

export function registerShareRoutes(app: FastifyInstance, cfg: AppConfig): void {
  // 发布/覆盖
  app.post('/api/v1/shares', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as {
      name?: unknown; files?: unknown; joinMode?: unknown; memberPermission?: unknown;
      contentHash?: unknown; expireDays?: unknown;
    };
    if (typeof body.name !== 'string' || !body.name.trim()) return reply.code(400).send({ ok: false, error: 'name required' });
    if (!validateFiles(body.files)) return reply.code(400).send({ ok: false, error: 'files invalid' });
    const joinMode = JOIN_MODES.has(String(body.joinMode ?? 'direct')) ? String(body.joinMode) as 'direct' | 'apply' | 'invite' : 'direct';
    const memberPermission = MEMBER_PERMS.has(String(body.memberPermission ?? 'view_export'))
      ? String(body.memberPermission) as 'view_export' | 'view_only' | 'hidden' : 'view_export';
    const contentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
    const expireDays = typeof body.expireDays === 'number' && body.expireDays > 0 ? Math.min(body.expireDays, 365) : undefined;

    const ownerUid = String(req.headers['x-owner-uid'] ?? 'anon');
    const files = (body.files as Array<{ path: string; title: string; contentMd?: string; summary?: string; sizeBytes?: number }>)
      .map((f) => ({ path: f.path, title: f.title, contentMd: f.contentMd, summary: f.summary, sizeBytes: f.sizeBytes }));

    const { changed, share, shareId } = await publishShare(ownerUid, {
      name: body.name.trim(), files, joinMode, memberPermission, contentHash, expireDays,
    });
    // 内容变化才重建索引（异步，不阻塞发布响应）
    if (changed) {
      const embedder = createEmbedder(cfg.embed);
      const indexInput = files.map((f) => ({ shareId, path: f.path, title: f.title, contentMd: f.contentMd }));
      void indexShare(embedder, shareId, indexInput).catch((err) => {
        console.error(`[index] share ${shareId} failed:`, (err as Error).message);
      });
    }
    return { ok: true, changed, shareId, url: `${cfg.publicBaseUrl}/s/${shareId}` };
  });

  // 读分享（公开：SSR 元信息）
  app.get('/api/v1/shares/:shareId', async (req, reply) => {
    const { shareId } = req.params as { shareId: string };
    const share = await getShare(shareId);
    if (!share || share.status !== 'active') return reply.code(404).send({ ok: false, error: 'not found' });
    if (share.expire_at && new Date(share.expire_at).getTime() < Date.now()) {
      return reply.code(403).send({ ok: false, error: 'expired' });
    }
    const fileCount = (await query<{ n: string }>(`SELECT count(*)::text AS n FROM share_files WHERE share_id = $1`, [shareId]))[0]?.n ?? '0';
    return {
      ok: true,
      share: {
        shareId: share.share_id, name: share.name, joinMode: share.join_mode,
        memberPermission: share.member_permission, fileCount: Number(fileCount), updatedAt: share.updated_at,
      },
    };
  });

  // 撤销
  app.delete('/api/v1/shares/:shareId', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId } = req.params as { shareId: string };
    await revokeShare(shareId);
    return { ok: true };
  });

  // 权限增量同步（join_mode/member_permission 变化）
  app.patch('/api/v1/shares/:shareId/policy', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId } = req.params as { shareId: string };
    const body = req.body as { joinMode?: unknown; memberPermission?: unknown };
    const joinMode = JOIN_MODES.has(String(body.joinMode)) ? String(body.joinMode) as 'direct' | 'apply' | 'invite' : undefined;
    const memberPermission = MEMBER_PERMS.has(String(body.memberPermission))
      ? String(body.memberPermission) as 'view_export' | 'view_only' | 'hidden' : undefined;
    if (!joinMode && !memberPermission) return reply.code(400).send({ ok: false, error: 'no policy change' });
    await updateSharePolicy(shareId, { joinMode, memberPermission });
    return { ok: true };
  });

  // ── 成员（§6.3）────────────────────────────────────────────────────────
  // 申请加入（join_mode=apply）
  app.post('/api/v1/shares/:shareId/apply', async (req, reply) => {
    const { shareId } = req.params as { shareId: string };
    const share = await getShare(shareId);
    if (!share || share.status !== 'active') return reply.code(404).send({ ok: false, error: 'not found' });
    if (share.join_mode !== 'apply') return reply.code(409).send({ ok: false, error: 'not apply mode' });
    const body = req.body as { displayName?: unknown; note?: unknown };
    const vk = visitorKeyFrom(req);
    const result = await applyJoin(shareId, vk, typeof body.displayName === 'string' ? body.displayName : undefined, typeof body.note === 'string' ? body.note : undefined);
    return { ok: true, status: result.status };
  });

  // 查自己申请状态
  app.get('/api/v1/shares/:shareId/apply/status', async (req) => {
    const { shareId } = req.params as { shareId: string };
    const vk = visitorKeyFrom(req);
    const member = await getMemberStatus(shareId, vk);
    return { ok: true, status: member?.status ?? 'none' };
  });

  // 邀请码加入（join_mode=invite）
  app.post('/api/v1/shares/:shareId/join', async (req, reply) => {
    const { shareId } = req.params as { shareId: string };
    const share = await getShare(shareId);
    if (!share || share.status !== 'active') return reply.code(404).send({ ok: false, error: 'not found' });
    if (share.join_mode !== 'invite') return reply.code(409).send({ ok: false, error: 'not invite mode' });
    const body = req.body as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!code) return reply.code(400).send({ ok: false, error: 'code required' });
    const vk = visitorKeyFrom(req);
    const ok = await redeemInvite(shareId, code, vk);
    if (!ok) return reply.code(403).send({ ok: false, error: 'invalid or expired invite code' });
    return { ok: true };
  });

  // 成员列表 + 待审（客户端）
  app.get('/api/v1/shares/:shareId/members', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId } = req.params as { shareId: string };
    const members = await listMembers(shareId);
    return { ok: true, members };
  });

  // 审核
  app.post('/api/v1/shares/:shareId/members/:memberId/:verdict', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId, memberId, verdict } = req.params as { shareId: string; memberId: string; verdict: string };
    if (verdict !== 'approve' && verdict !== 'reject') return reply.code(400).send({ ok: false, error: 'verdict must be approve|reject' });
    await reviewMember(shareId, Number(memberId), verdict === 'approve' ? 'approved' : 'rejected');
    return { ok: true };
  });

  // 移除成员
  app.delete('/api/v1/shares/:shareId/members/:memberId', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId, memberId } = req.params as { shareId: string; memberId: string };
    await removeMember(shareId, Number(memberId));
    return { ok: true };
  });

  // 邀请码管理
  app.post('/api/v1/shares/:shareId/invites', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId } = req.params as { shareId: string };
    const body = req.body as { maxUses?: unknown; ttlDays?: unknown };
    const maxUses = typeof body.maxUses === 'number' && body.maxUses > 0 ? Math.min(body.maxUses, 100) : 1;
    const ttlDays = typeof body.ttlDays === 'number' && body.ttlDays > 0 ? Math.min(body.ttlDays, 30) : 7;
    const { code } = await createInvite(shareId, maxUses, ttlDays);
    return { ok: true, code };
  });

  app.get('/api/v1/shares/:shareId/invites', async (req, reply) => {
    if (!isAdminRequest(cfg.adminApiKeys, req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { shareId } = req.params as { shareId: string };
    const invites = await listInvites(shareId);
    return { ok: true, invites };
  });
}
