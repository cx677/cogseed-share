/** Embedding 提供者（可插拔：siliconflow / local-fastembed / jina）。
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

/** 本地 fastembed（fast-bge-small-zh-v1.5，512 维）——无需外部 API key */
class LocalFastembedEmbedder implements Embedder {
  private model: import('fastembed').FlagEmbedding | null = null;
  readonly dim: number;
  private readonly modelDir: string;
  private modelName: string;

  constructor(opts: { dim: number; modelDir?: string; modelName?: string }) {
    this.dim = opts.dim;
    this.modelDir = opts.modelDir ?? process.env.EMBED_MODEL_DIR ?? '';
    this.modelName = opts.modelName ?? 'model_optimized.onnx';
  }

  private async getModel(): Promise<import('fastembed').FlagEmbedding> {
    if (this.model) return this.model;
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    if (this.modelDir) {
      // 本地模型目录（如主项目 resources/embedding-model/fast-bge-small-zh-v1.5，
      // 内含 model_optimized.onnx + tokenizer.json + config.json）
      this.model = await FlagEmbedding.init({
        model: EmbeddingModel.CUSTOM,
        modelAbsoluteDirPath: this.modelDir,
        modelName: this.modelName,
      });
    } else {
      // 标准模型名（首次自动下载到缓存）
      this.model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallZH });
    }
    return this.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = await this.getModel();
    const out: number[][] = [];
    for await (const batch of model.embed(texts, 16)) {
      out.push(...batch);
    }
    return out;
  }
}

export function createEmbedder(cfg: { provider: 'siliconflow' | 'local' | 'jina'; apiKey: string; model: string; dim: number }): Embedder {
  switch (cfg.provider) {
    case 'siliconflow':
      return new HttpEmbedder('https://api.siliconflow.cn/v1/embeddings', cfg.apiKey, cfg.dim, cfg.model);
    case 'jina':
      return new HttpEmbedder('https://api.jina.ai/v1/embeddings', cfg.apiKey, cfg.dim, cfg.model);
    case 'local':
      // 本地 fastembed（bge-small-zh 512 维；或经 EMBED_MODEL_DIR 指定目录）
      return new LocalFastembedEmbedder({ dim: cfg.dim, modelDir: process.env.EMBED_MODEL_DIR });
    default:
      throw new Error(`unknown embed provider: ${cfg.provider}`);
  }
}
