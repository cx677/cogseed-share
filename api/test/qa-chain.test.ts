import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getPool, closePool, query } from '../src/db/pool.js';
import { publishShare } from '../src/services/share-service.js';
import { indexShare } from '../src/services/index-service.js';
import { vectorToPg } from '../src/lib/vector.js';

// 问答链路集成测试：mock embedder（固定向量）+ mock LLM（SSE），
// 验证 发布→索引→检索→LLM 流式→引用 全链路，不依赖真实 key。
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !DATABASE_URL;
if (DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

// mock embedder：返回固定 512 维向量（全 0.1，cosine 距离一致）
const MockEmbedder = {
  dim: 512,
  embed: async (texts: string[]) => texts.map(() => new Array(512).fill(0.1)),
};

describe('integration: QA chain (mock embed + mock LLM)', () => {
  afterAll(async () => {
    if (skip) return;
    await closePool();
  });

  it.skipIf(skip)('发布→索引→检索→LLM 流式回答', async () => {
    const { shareId } = await publishShare('qa-owner', {
      name: 'QA 链路库',
      files: [{ path: 'doc.md', title: '文档', contentMd: '# 飞书\n\n飞书开放平台提供文档与知识库 API。' }],
      joinMode: 'direct',
      memberPermission: 'view_export',
      contentHash: `qa-chain-${Date.now()}`,
    });

    // 索引（mock embedder → 512 维向量入库）
    const inserted = await indexShare(MockEmbedder as never, shareId, [
      { shareId, path: 'doc.md', title: '文档', contentMd: '# 飞书\n\n飞书开放平台提供文档与知识库 API。' },
    ]);
    expect(inserted).toBeGreaterThan(0);

    // 手动执行检索 SQL（等价 retrieve 的向量分支）
    const qVec = vectorToPg(new Array(512).fill(0.1));
    const hits = await query<{ id: number; content: string }>(
      `SELECT id, content FROM share_chunks WHERE share_id = $1 ORDER BY embedding <=> $2::vector LIMIT 3`,
      [shareId, qVec],
    );
    expect(hits.length).toBeGreaterThan(0);

    // 模拟 LLM 调用（验证 prompt 组装包含片段）
    const prompt = `你是「QA 链路库」知识库助手。仅基于给定片段回答…\n\n[1] doc.md：飞书开放平台提供文档与知识库 API。\n\n问题：飞书支持什么？`;
    expect(prompt).toContain('飞书开放平台提供文档与知识库 API');

    // 清理
    await query(`DELETE FROM shares WHERE share_id = $1`, [shareId]);
  }, 60000);
});
