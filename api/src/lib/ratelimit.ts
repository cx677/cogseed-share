/** 内存限流：按 IP + 键 双维度（单机起步；多实例换 Redis） */
interface Bucket { count: number; resetAt: number; }

const buckets = new Map<string, Bucket>();

export function rateLimitHit(key: string, max: number, windowMs: number): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/** 定期清理过期桶（防内存增长） */
export function startRateLimitSweeper(intervalMs = 60000): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }, intervalMs);
}
