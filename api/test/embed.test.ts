import { describe, it, expect } from 'vitest';
import { createEmbedder } from '../src/services/embedder.js';

// 本地 fastembed 验证：需 EMBED_MODEL_DIR 指向模型目录（如主项目
// resources/embedding-model/fast-bge-small-zh-v1.5）。未设置时跳过
// （避免测试触发模型下载）。
const hasModelDir = Boolean(process.env.EMBED_MODEL_DIR);

describe('local fastembed', () => {
  it.skipIf(!hasModelDir)('加载本地模型并生成 512 维向量', async () => {
    const emb = createEmbedder({ provider: 'local', apiKey: '', model: 'fast-bge-small-zh-v1.5', dim: 512 });
    expect(emb.dim).toBe(512);
    const res = await emb.embed(['这是一个测试文本', '第二条内容']);
    expect(res.length).toBe(2);
    expect(res[0]?.length).toBe(512);
    expect(res[0]?.some((v) => v !== 0)).toBe(true);
  }, 60000);
});
