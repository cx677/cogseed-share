/**
 * 本地 mock LLM（OpenAI 兼容 /chat/completions SSE）——用于无真实 key 时
 * 验证 cogseed-share 的问答全链路（检索→prompt→流式→引用）。
 * 用法：node scripts/mock-llm.mjs   （监听 8899）
 */
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let question = '';
      try {
        const parsed = JSON.parse(body);
        question = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
      } catch { /* ignore */ }
      // 从 question 里尝试提取 [n] 引用编号（模拟 RAG 引用）
      const cites = [...question.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).slice(0, 3);

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunks = ['这是', '来自', '本地', 'mock', '模型', '的回答', '。'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
          i++;
        } else {
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
        }
      }, 20);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(8899, () => console.log('mock LLM listening on :8899'));
