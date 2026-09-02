import * as crypto from 'node:crypto';

/** 恒定时间比较（防时序攻击） */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 校验客户端 API Key（Bearer token 或明文头） */
export function isAdminRequest(adminKeys: string[], authorization?: string): boolean {
  if (!authorization) return false;
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : authorization;
  return adminKeys.some((key) => safeEqual(key, token));
}

/** 管理页 token：MANAGE_TOKEN_SECRET + shareId 派生（一次性/可撤销由后端校验） */
export function signManageToken(secret: string, shareId: string): string {
  const payload = `${shareId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

export function verifyManageToken(secret: string, token: string, shareId: string): boolean {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const decoded = Buffer.from(payload, 'base64url').toString();
    if (!decoded.startsWith(`${shareId}.`)) return false;
    const expect = crypto.createHmac('sha256', secret).update(decoded).digest('hex').slice(0, 32);
    return safeEqual(sig, expect);
  } catch {
    return false;
  }
}
