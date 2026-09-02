/** Markdown 切分：按标题/段落滑窗，重叠防截断语义。纯函数可单测。 */

export interface ChunkOptions {
  maxLen?: number;
  overlap?: number;
}

/** 按 \n#{1,3} 标题切段，保留标题前缀作上下文；段内超长再滑窗 */
export function chunkMarkdown(md: string, opts: ChunkOptions = {}): string[] {
  const { maxLen = 800, overlap = 100 } = opts;
  const text = (md ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];

  // 1. 按标题切段
  const sections: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  const flush = () => {
    const s = current.join('\n').trim();
    if (s) sections.push(s);
    current = [];
  };
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) flush();
    current.push(line);
  }
  flush();

  // 2. 段内超长滑窗（按字符，重叠 overlap）
  const out: string[] = [];
  for (const section of sections) {
    if (section.length <= maxLen) {
      out.push(section);
      continue;
    }
    let start = 0;
    while (start < section.length) {
      const end = Math.min(start + maxLen, section.length);
      out.push(section.slice(start, end));
      if (end === section.length) break;
      start = end - overlap;
    }
  }
  return out;
}
