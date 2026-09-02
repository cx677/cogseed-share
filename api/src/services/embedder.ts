/** Embedding 提供者（可插拔：siliconflow / local / jina）。
 * 接口统一 embed(texts) → number[][]；dim 与建表 vector(dim) 匹配。 */

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  dim: number;
}

class HttpEmbedder implements Embedder {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    readonly dim: number,
    private readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embed http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const data = body.data ?? [];
    return data.map((d) => d.embedding);
  }
}

export function createEmbedder(cfg: { provider: 'siliconflow' | 'local' | 'jina'; apiKey: string; model: string; dim: number }): Embedder {
  switch (cfg.provider) {
    case 'siliconflow':
      return new HttpEmbedder('https://api.siliconflow.cn/v1/embeddings', cfg.apiKey, cfg.dim, cfg.model);
    case 'jina':
      return new HttpEmbedder('https://api.jina.ai/v1/embeddings', cfg.apiKey, cfg.dim, cfg.model);
    case 'local':
      // 本地 BGE HTTP 服务（如 fastembed 封装），endpoint 约定 /embed
      return new HttpEmbedder(`${process.env.EMBED_LOCAL_URL ?? 'http://localhost:8080'}/embed`, '', cfg.dim, cfg.model);
    default:
      throw new Error(`unknown embed provider: ${cfg.provider}`);
  }
}
