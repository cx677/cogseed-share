import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../src/services/chunker.js';
import { genShareId, genInviteCode } from '../src/lib/shareid.js';
import { safeEqual, signManageToken, verifyManageToken } from '../src/lib/auth.js';

describe('chunker', () => {
  it('空输入返回空数组', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   ')).toEqual([]);
  });

  it('按标题切段', () => {
    const md = '# 标题1\n\n内容1\n\n## 标题2\n\n内容2';
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('标题1');
    expect(chunks.some((c) => c.includes('标题2'))).toBe(true);
  });

  it('超长段滑窗 + 重叠', () => {
    const long = 'x'.repeat(2000);
    const chunks = chunkMarkdown(long, { maxLen: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].length).toBeLessThanOrEqual(500);
  });
});

describe('shareid', () => {
  it('生成指定长度 base62 短码', () => {
    expect(genShareId(8)).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(genInviteCode(6)).toMatch(/^[0-9A-Za-z]{6}$/);
  });
  it('两次生成大概率不同', () => {
    expect(genShareId(8)).not.toBe(genShareId(8));
  });
});

describe('auth', () => {
  it('safeEqual 恒定时间比较', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });

  it('管理 token 签名/验证', () => {
    const secret = 'test-secret';
    const token = signManageToken(secret, 'share123');
    expect(verifyManageToken(secret, token, 'share123')).toBe(true);
    expect(verifyManageToken(secret, token, 'share999')).toBe(false);
    expect(verifyManageToken('wrong', token, 'share123')).toBe(false);
  });
});
