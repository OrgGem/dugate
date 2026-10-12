import http from 'node:http';

const calls = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (request.url === '/__stats') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ count: calls.length, calls }));
    return;
  }
  let bodyShape = null;
  try {
    const value = JSON.parse(body.toString('utf8'));
    bodyShape = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
  } catch { /* the fixture records only the shape of valid JSON, never its values */ }
  calls.push({
    method: request.method || '',
    path: request.url || '',
    bodyBytes: body.length,
    bodyKeys: bodyShape,
    hasAuthorization: Boolean(request.headers.authorization),
    hasApiKeyHeader: Boolean(request.headers['x-api-key']),
  });
  const isOpenAi = (request.url || '').startsWith('/v1/chat/completions');
  const payload = isOpenAi
    ? {
        id: 'chatcmpl-orv14-synthetic',
        object: 'chat.completion',
        model: 'orv14-vfy-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic provider response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    : { content: 'synthetic legacy connector response' };
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ status: 'LISTENING', host: '127.0.0.1', port: address.port }) + '\n');
});

function stop() {
  server.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
