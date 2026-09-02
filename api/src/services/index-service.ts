/** 索引服务：发布内容 → 切分 → embedding → 写向量库（异步，幂等） */

import { query } from '../db/pool.js';
import { chunkMarkdown } from './chunker.js';
import type { Embedder } from './embedder.js';
import { vectorToPg } from '../lib/vector.js';

export interface IndexFileInput {
  shareId: string;
  path: string;
  title: string;
  contentMd?: string;
}

/** 为分享重建向量索引：删旧块 → 每个文件切分 → embedding → 插入。
 * 返回索引块数。失败抛错（调用方决定重试策略）。 */
export async function indexShare(embedder: Embedder, shareId: string, files: IndexFileInput[]): Promise<number> {
  await query(`DELETE FROM share_chunks WHERE share_id = $1`, [shareId]);

  const chunksToEmbed: Array<{ fileId: number; index: number; content: string }> = [];

  for (const f of files) {
    const md = (f.contentMd ?? '').trim();
    if (!md) continue;
    const fileRow = await query<{ id: number }>(
      `SELECT id FROM share_files WHERE share_id = $1 AND path = $2`,
      [shareId, f.path],
    );
    const fileId = fileRow[0]?.id;
    if (!fileId) continue;
    const pieces = chunkMarkdown(md);
    pieces.forEach((content, idx) => chunksToEmbed.push({ fileId, index: idx, content }));
  }

  // 分批 embedding（单次最多 64 条）
  const BATCH = 64;
  let inserted = 0;
  for (let i = 0; i < chunksToEmbed.length; i += BATCH) {
    const batch = chunksToEmbed.slice(i, i + BATCH);
    const embeddings = await embedder.embed(batch.map((c) => c.content));
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      const emb = embeddings[j];
      if (!emb || emb.length === 0) continue;
      await query(
        `INSERT INTO share_chunks (share_id, file_id, chunk_index, content, embedding)
         VALUES ($1,$2,$3,$4,$5::vector)`,
        [shareId, c.fileId, c.index, c.content, vectorToPg(emb)],
      );
      inserted++;
    }
  }
  return inserted;
}
