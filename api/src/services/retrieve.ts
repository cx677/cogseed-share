/** 检索：向量 topK + 关键词兜底（tsvector），RRF 融合去重。 */

export interface RetrievedChunk {
  chunkId: number;
  fileId: number;
  path: string;
  content: string;
  score: number;
}

interface RankedRow {
  chunkId: number;
  fileId: number;
  path: string;
  content: string;
  rank: number;
  source: 'vec' | 'kw';
}

const RRF_K = 60;

function rrfMerge(rows: RankedRow[], topK: number): RetrievedChunk[] {
  const scores = new Map<number, { chunkId: number; fileId: number; path: string; content: string; score: number }>();
  for (const row of rows) {
    const cur = scores.get(row.chunkId) ?? {
      chunkId: row.chunkId, fileId: row.fileId, path: row.path, content: row.content, score: 0,
    };
    cur.score += 1 / (RRF_K + row.rank);
    scores.set(row.chunkId, cur);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 向量 + 关键词融合检索（RAG topK 片段） */
export async function retrieve(
  run: { query: (text: string, params: unknown[]) => Promise<unknown[]> },
  opts: {
    shareId: string;
    questionVec: number[];
    questionText: string;
    topK?: number;
    vecTopK?: number;
    kwTopK?: number;
  },
): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? 6;
  const vecTopK = opts.vecTopK ?? 10;
  const kwTopK = opts.kwTopK ?? 10;
  const rows: RankedRow[] = [];

  // 向量检索
  try {
    const vecRows = await run.query(
      `SELECT c.id AS "chunkId", c.file_id AS "fileId", f.path, c.content
       FROM share_chunks c JOIN share_files f ON f.id = c.file_id
       WHERE c.share_id = $1
       ORDER BY c.embedding <=> $2::vector
       LIMIT $3`,
      [opts.shareId, JSON.stringify(opts.questionVec), vecTopK],
    );
    (vecRows as Array<{ chunkId: number; fileId: number; path: string; content: string }>)
      .forEach((r, i) => rows.push({ ...r, rank: i + 1, source: 'vec' }));
  } catch { /* 向量检索失败不阻断，走关键词 */ }

  // 关键词兜底（simple 分词；中文效果有限，够用起步）
  try {
    const kwRows = await run.query(
      `SELECT c.id AS "chunkId", c.file_id AS "fileId", f.path, c.content
       FROM share_chunks c JOIN share_files f ON f.id = c.file_id
       WHERE c.share_id = $1
         AND to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $2)
       ORDER BY ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $2)) DESC
       LIMIT $3`,
      [opts.shareId, opts.questionText, kwTopK],
    );
    (kwRows as Array<{ chunkId: number; fileId: number; path: string; content: string }>)
      .forEach((r, i) => rows.push({ ...r, rank: i + 1, source: 'kw' }));
  } catch { /* 关键词失败忽略 */ }

  return rrfMerge(rows, topK);
}
