# cogseed-share

CogSeed 共享知识库后端（方案 C）：把 CogSeed 空间发布为公网可访问的 Web 分享页，支持 AI 问答、引用溯源、成员管理与权限透传（join_mode / member_permission 三档）。

## 能力

- **发布/更新/撤销**：空间内容 → 后端快照 + 向量索引 → 公网链接 `share.cogseed.dev/s/{shareId}`
- **AI 问答**：RAG（向量 + 关键词融合）→ DeepSeek 流式 SSE → 引用溯源
- **成员管理（§6.3）**：join_mode = direct（直接）/ apply（申请→审核）/ invite（邀请码）；member_permission = view_export / view_only / hidden
- **限流 + 预算护栏**：IP+share 限流；每日 LLM 预算超限降级

## 技术栈

Node 20 + TypeScript + Fastify + Postgres 16 + pgvector + DeepSeek + 硅基流动/本地 BGE embedding + Caddy（自动 HTTPS）

## 快速开始

```bash
cp .env.example .env        # 填密钥
docker compose up -d --build
curl http://localhost:3000/healthz   # {"ok":true}
```

## API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/shares` | Key | 发布/覆盖（contentHash 幂等） |
| GET | `/api/v1/shares/{id}` | 公开 | 元信息（SSR） |
| PATCH | `/api/v1/shares/{id}/policy` | Key | 权限增量同步（join/member） |
| DELETE | `/api/v1/shares/{id}` | Key | 撤销 |
| POST | `/api/v1/shares/{id}/ask` | 公开(限流) | SSE 流式问答 |
| POST | `/api/v1/shares/{id}/apply` | 公开 | 申请加入（apply 模式） |
| POST | `/api/v1/shares/{id}/join` | 公开 | 邀请码加入（invite 模式） |
| GET | `/api/v1/shares/{id}/members` | Key | 成员列表/待审 |
| POST | `/api/v1/shares/{id}/members/{mid}/{approve\|reject}` | Key | 审核 |
| POST | `/api/v1/shares/{id}/invites` | Key | 生成邀请码 |
| GET | `/api/v1/shares/{id}/stats` | Key | 问答统计 |

## 开发

```bash
cd api && npm install
npm run typecheck && npm test
npm run dev
```

## 协议

MIT（对齐 CogSeed 开源定位；独立仓库发布）。
