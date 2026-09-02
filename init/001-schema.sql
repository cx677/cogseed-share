-- cogseed-share 数据库初始化（方案 C，含成员管理与权限透传 §6.3）
CREATE EXTENSION IF NOT EXISTS vector;

-- 分享主表：access=link|apply 由 join_mode 决定；member_permission 控制访客可看/可导出
CREATE TABLE shares (
  share_id           text PRIMARY KEY,          -- base62 短码
  owner_uid          text NOT NULL,             -- CogSeed 用户（匿名化）
  name               text NOT NULL,
  access             text NOT NULL DEFAULT 'link',  -- link=链接可访问 | closed=已关闭
  join_mode          text NOT NULL DEFAULT 'direct', -- direct=直接加入 | apply=申请加入 | invite=仅邀请
  member_permission  text NOT NULL DEFAULT 'view_export', -- view_export | view_only | hidden
  status             text NOT NULL DEFAULT 'active',    -- active | revoked | expired
  content_hash       text NOT NULL,
  expire_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shares_status ON shares(status);
CREATE INDEX idx_shares_owner ON shares(owner_uid);

-- 文件表：发布内容快照
CREATE TABLE share_files (
  id            bigserial PRIMARY KEY,
  share_id      text NOT NULL REFERENCES shares(share_id) ON DELETE CASCADE,
  path          text NOT NULL,
  title         text NOT NULL,
  content_md    text,
  summary       text,
  size_bytes    bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_files_share ON share_files(share_id);

-- 向量块表（RAG 检索）
CREATE TABLE share_chunks (
  id            bigserial PRIMARY KEY,
  share_id      text NOT NULL REFERENCES shares(share_id) ON DELETE CASCADE,
  file_id       bigint REFERENCES share_files(id) ON DELETE CASCADE,
  chunk_index   int NOT NULL,
  content       text NOT NULL,
  embedding     vector(1024)
);
CREATE INDEX idx_chunks_share ON share_chunks(share_id);
CREATE INDEX ON share_chunks USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);

-- 问答统计（问题文本可一键清空）
CREATE TABLE share_questions (
  id            bigserial PRIMARY KEY,
  share_id      text NOT NULL REFERENCES shares(share_id) ON DELETE CASCADE,
  question      text NOT NULL,
  answered_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_questions_share ON share_questions(share_id, answered_at);

-- 成员表（§6.3.2）：join_mode=apply/invite 的申请/审核/成员状态
CREATE TABLE share_members (
  id            bigserial PRIMARY KEY,
  share_id      text NOT NULL REFERENCES shares(share_id) ON DELETE CASCADE,
  visitor_key   text NOT NULL,                  -- 访客匿名标识（不存 PII）
  status        text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | revoked
  display_name  text,                            -- 申请时昵称/邮箱（可选）
  note          text,                            -- 申请理由（可选）
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  UNIQUE (share_id, visitor_key)
);
CREATE INDEX idx_members_share ON share_members(share_id, status);

-- 邀请码表（§6.3.2）：join_mode=invite 时创建者生成
CREATE TABLE share_invites (
  id            bigserial PRIMARY KEY,
  share_id      text NOT NULL REFERENCES shares(share_id) ON DELETE CASCADE,
  code          text NOT NULL UNIQUE,
  max_uses      int  NOT NULL DEFAULT 1,
  used_count    int  NOT NULL DEFAULT 0,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invites_share ON share_invites(share_id);
