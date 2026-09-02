import * as crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 生成 base62 短码（len 位）；带重试防碰撞（调用方插入失败时重试） */
export function genShareId(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 生成邀请码（join_mode=invite 用） */
export function genInviteCode(len = 6): string {
  return genShareId(len);
}

/** 访客匿名标识：浏览器指纹 → 稳定 hash（不存 PII） */
export function visitorKeyFrom(req: { headers: Record<string, string | string[] | undefined> }): string {
  const ua = String(req.headers['user-agent'] ?? '');
  const acceptLang = String(req.headers['accept-language'] ?? '');
  return crypto.createHash('sha256').update(`${ua}|${acceptLang}`).digest('hex').slice(0, 24);
}
