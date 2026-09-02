/** 环境配置（.env 提供；不信任任何空默认值） */
export interface AppConfig {
  databaseUrl: string;
  adminApiKeys: string[];
  manageTokenSecret: string;
  llm: { apiKey: string; baseUrl: string; model: string };
  embed: { provider: 'siliconflow' | 'local' | 'jina'; apiKey: string; model: string; dim: number };
  rateLimit: { max: number; windowMs: number };
  dailyLlmBudgetYuan: number;
  publicBaseUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    adminApiKeys: (process.env.ADMIN_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    manageTokenSecret: required('MANAGE_TOKEN_SECRET'),
    llm: {
      apiKey: required('LLM_API_KEY'),
      baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
      model: process.env.LLM_MODEL ?? 'deepseek-chat',
    },
    embed: {
      provider: (process.env.EMBED_PROVIDER ?? 'local') as AppConfig['embed']['provider'],
      apiKey: process.env.EMBED_API_KEY ?? '',
      model: process.env.EMBED_MODEL ?? 'BAAI/bge-m3',
      dim: Number(process.env.EMBED_DIM ?? 512),
    },
    rateLimit: {
      max: Number(process.env.RATE_LIMIT_MAX ?? 10),
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
    },
    dailyLlmBudgetYuan: Number(process.env.DAILY_LLM_BUDGET_YUAN ?? 5),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://share.cogseed.dev',
  };
}
