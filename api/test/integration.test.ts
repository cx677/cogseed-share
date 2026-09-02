import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/db/pool.js';
import { publishShare, getShare, applyJoin, getMemberStatus, reviewMember, listMembers } from '../src/services/share-service.js';
import { indexShare } from '../src/services/index-service.js';
import { createEmbedder } from '../src/services/embedder.js';
import { chunkMarkdown } from '../src/services/chunker.js';
import { query } from '../src/db/pool.js';

// 集成测试：需本地 Postgres（docker compose db，端口 5433）+
// EMBED_MODEL_DIR（本地 fastembed 模型）。未设置环境变量则跳过。
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const MODEL_DIR = process.env.EMBED_MODEL_DIR;
const skip = !DATABASE_URL || !MODEL_DIR;
// 顶层设置，确保模块加载前可用（vitest 每文件独立进程）
if (DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

describe('integration: publish → index → members', () => {
  afterAll(async () => {
    if (skip) return;
    await closePool();
  });

  it.skipIf(skip)('发布 → 索引（本地 embedding）→ 成员申请审核 全链路', async () => {
    const embedder = createEmbedder({ provider: 'local', apiKey: '', model: 'fast-bge-small-zh-v1.5', dim: 512 });

    // 1. 发布
    const { changed, shareId } = await publishShare('test-owner', {
      name: '集成测试库',
      files: [{ path: 'doc.md', title: '文档', contentMd: '# 知识库\n\n飞书支持文档分享，CogSeed 可以对接问答。' }],
      joinMode: 'apply',
      memberPermission: 'view_only',
      contentHash: `it-hash-${Date.now()}`,
    });
    expect(changed).toBe(true);
    expect(shareId).toBeTruthy();

    // 2. 索引（本地 embedding）
    const inserted = await indexShare(embedder, shareId, [
      { shareId, path: 'doc.md', title: '文档', contentMd: '# 知识库\n\n飞书支持文档分享，CogSeed 可以对接问答。' },
    ]);
    expect(inserted).toBeGreaterThan(0);

    // 3. 向量块确实入库
    const chunks = await query<{ n: string }>(`SELECT count(*)::text AS n FROM share_chunks WHERE share_id = $1`, [shareId]);
    expect(Number(chunks[0]?.n)).toBeGreaterThan(0);

    // 4. join_mode/member_permission 透传
    const share = await getShare(shareId);
    expect(share?.join_mode).toBe('apply');
    expect(share?.member_permission).toBe('view_only');

    // 5. 成员申请 → 审核
    await applyJoin(shareId, 'visitor-key-abc', '张三', '想加入');
    const pending = await getMemberStatus(shareId, 'visitor-key-abc');
    expect(pending?.status).toBe('pending');
    const members = await listMembers(shareId);
    expect(members.length).toBe(1);
    await reviewMember(shareId, members[0].id, 'approved');
    const after = await getMemberStatus(shareId, 'visitor-key-abc');
    expect(after?.status).toBe('approved');

    // 清理
    await query(`DELETE FROM shares WHERE share_id = $1`, [shareId]);
  }, 120000);

  it('chunker 生成可索引片段（标题保留为上下文）', () => {
    const chunks = chunkMarkdown('# 标题\n\n正文内容，飞书开放平台提供文档 API。\n\n- 列表项一\n- 列表项二');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain('标题');
    expect(chunks[0]).toContain('正文内容');
    // 两个标题 → 至少两段
    const multi = chunkMarkdown('# 一\n\n内容一\n\n# 二\n\n内容二');
    expect(multi.length).toBeGreaterThanOrEqual(2);
  });
});
