/** 分享业务：发布/更新/撤销 + 成员/邀请（§6.3）。 */

import { query, queryOne } from '../db/pool.js';
import { genShareId, genInviteCode } from '../lib/shareid.js';

export interface ShareFileInput {
  path: string;
  title: string;
  contentMd?: string;
  summary?: string;
  sizeBytes?: number;
}

export interface PublishInput {
  name: string;
  files: ShareFileInput[];
  joinMode: 'direct' | 'apply' | 'invite';
  memberPermission: 'view_export' | 'view_only' | 'hidden';
  contentHash: string;
  expireDays?: number;
}

export interface ShareRow {
  share_id: string;
  owner_uid: string;
  name: string;
  access: string;
  join_mode: string;
  member_permission: string;
  status: string;
  content_hash: string;
  expire_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 发布/覆盖：contentHash 相同返回 { changed:false, existing } */
export async function publishShare(ownerUid: string, input: PublishInput): Promise<{ changed: boolean; share: ShareRow; shareId: string }> {
  // 幂等：同名 + 同 owner + active + 同 hash → 复用
  const existing = await queryOne<ShareRow>(
    `SELECT * FROM shares WHERE owner_uid = $1 AND name = $2 AND status = 'active' AND content_hash = $3`,
    [ownerUid, input.name, input.contentHash],
  );
  if (existing) return { changed: false, share: existing, shareId: existing.share_id };

  // 覆盖旧版本（同名 active 先标记 revoked）
  await query(`UPDATE shares SET status = 'revoked' WHERE owner_uid = $1 AND name = $2 AND status = 'active'`, [ownerUid, input.name]);

  const shareId = genShareId();
  const expireAt = input.expireDays ? new Date(Date.now() + input.expireDays * 86400000).toISOString() : null;
  await query(
    `INSERT INTO shares (share_id, owner_uid, name, access, join_mode, member_permission, status, content_hash, expire_at)
     VALUES ($1,$2,$3,'link',$4,$5,'active',$6,$7)`,
    [shareId, ownerUid, input.name, input.joinMode, input.memberPermission, input.contentHash, expireAt],
  );

  // 文件入库（先删旧再插新）
  for (const f of input.files) {
    await query(
      `INSERT INTO share_files (share_id, path, title, content_md, summary, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [shareId, f.path, f.title, f.contentMd ?? null, f.summary ?? null, f.sizeBytes ?? null],
    );
  }

  const share = await queryOne<ShareRow>(`SELECT * FROM shares WHERE share_id = $1`, [shareId]);
  if (!share) throw new Error('share insert failed');
  return { changed: true, share, shareId };
}

/** 读分享（含 join_mode/member_permission） */
export async function getShare(shareId: string): Promise<ShareRow | null> {
  return queryOne<ShareRow>(`SELECT * FROM shares WHERE share_id = $1`, [shareId]);
}

/** 撤销：关闭链接（外部不可访问；join_mode=apply 的申请也失效） */
export async function revokeShare(shareId: string): Promise<void> {
  await query(`UPDATE shares SET status = 'revoked' WHERE share_id = $1`, [shareId]);
}

/** 更新权限（join_mode/member_permission 变化时增量同步） */
export async function updateSharePolicy(
  shareId: string,
  policy: { joinMode?: 'direct' | 'apply' | 'invite'; memberPermission?: 'view_export' | 'view_only' | 'hidden' },
): Promise<void> {
  if (policy.joinMode) {
    await query(`UPDATE shares SET join_mode = $2, updated_at = now() WHERE share_id = $1`, [shareId, policy.joinMode]);
  }
  if (policy.memberPermission) {
    await query(`UPDATE shares SET member_permission = $2, updated_at = now() WHERE share_id = $1`, [shareId, policy.memberPermission]);
  }
}

// ── 成员管理（§6.3）───────────────────────────────────────────────────────

export async function applyJoin(shareId: string, visitorKey: string, displayName?: string, note?: string): Promise<{ status: 'created' | 'exists' }> {
  const existing = await queryOne<{ status: string }>(
    `SELECT status FROM share_members WHERE share_id = $1 AND visitor_key = $2`,
    [shareId, visitorKey],
  );
  if (existing) return { status: 'exists' };
  await query(
    `INSERT INTO share_members (share_id, visitor_key, status, display_name, note) VALUES ($1,$2,'pending',$3,$4)`,
    [shareId, visitorKey, displayName ?? null, note ?? null],
  );
  return { status: 'created' };
}

export async function getMemberStatus(shareId: string, visitorKey: string): Promise<{ status: string } | null> {
  return queryOne<{ status: string }>(
    `SELECT status FROM share_members WHERE share_id = $1 AND visitor_key = $2`,
    [shareId, visitorKey],
  );
}

export async function listMembers(shareId: string): Promise<Array<{ id: number; status: string; display_name: string | null; note: string | null; created_at: string }>> {
  return query(
    `SELECT id, status, display_name, note, created_at FROM share_members WHERE share_id = $1 ORDER BY created_at ASC`,
    [shareId],
  );
}

export async function reviewMember(shareId: string, memberId: number, verdict: 'approved' | 'rejected'): Promise<void> {
  await query(
    `UPDATE share_members SET status = $3, reviewed_at = now() WHERE id = $1 AND share_id = $2`,
    [memberId, shareId, verdict],
  );
}

export async function removeMember(shareId: string, memberId: number): Promise<void> {
  await query(`DELETE FROM share_members WHERE id = $1 AND share_id = $2`, [memberId, shareId]);
}

// ── 邀请码（§6.3）─────────────────────────────────────────────────────────

export async function createInvite(shareId: string, maxUses = 1, ttlDays = 7): Promise<{ code: string }> {
  const code = genInviteCode();
  const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();
  await query(
    `INSERT INTO share_invites (share_id, code, max_uses, used_count, expires_at) VALUES ($1,$2,$3,0,$4)`,
    [shareId, code, maxUses, expiresAt],
  );
  return { code };
}

export async function redeemInvite(shareId: string, code: string, visitorKey: string): Promise<boolean> {
  const normalized = code.toUpperCase();
  const invite = await queryOne<{ id: number; max_uses: number; used_count: number; expires_at: string | null }>(
    `SELECT id, max_uses, used_count, expires_at FROM share_invites WHERE share_id = $1 AND UPPER(code) = $2`,
    [shareId, normalized],
  );
  if (!invite) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return false;
  if (invite.used_count >= invite.max_uses) return false;
  await query(`UPDATE share_invites SET used_count = used_count + 1 WHERE id = $1`, [invite.id]);
  // 使用邀请码即成为 approved 成员
  await query(
    `INSERT INTO share_members (share_id, visitor_key, status, display_name) VALUES ($1,$2,'approved','邀请码加入')
     ON CONFLICT (share_id, visitor_key) DO UPDATE SET status = 'approved'`,
    [shareId, visitorKey],
  );
  return true;
}

export async function listInvites(shareId: string): Promise<Array<{ code: string; max_uses: number; used_count: number; expires_at: string | null }>> {
  return query(
    `SELECT code, max_uses, used_count, expires_at FROM share_invites WHERE share_id = $1 ORDER BY created_at DESC`,
    [shareId],
  );
}
