import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const requests = [];
const maxBodyBytes = 2 * 1024 * 1024;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8081');
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/__control/reset') {
    requests.length = 0;
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__control/requests') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(requests));
    return;
  }

  let size = 0;
  const chunks = [];
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const authorization = request.headers.authorization ?? '';
    const safeRecord = {
      method: request.method ?? 'GET',
      path: url.pathname,
      status: 200,
      bytes: body.length,
      bodySha256: digest(body),
      contentType: request.headers['content-type'] ?? null,
      authorizationPresent: authorization.length > 0,
      authorizationSha256: authorization.length > 0 ? digest(Buffer.from(authorization)) : null,
      requestId: request.headers['x-request-id'] ?? null,
    };
    const fault = url.searchParams.get('fault');
    if (fault === '429') safeRecord.status = 429;
    else if (fault === 'auth') safeRecord.status = 401;
    requests.push(safeRecord);

    if (fault === 'timeout') {
      setTimeout(() => {
        if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      }, 30_000);
      return;
    }
    if (fault === 'unknown') {
      response.destroy();
      return;
    }
    if (fault === '429' || fault === 'auth') {
      response.writeHead(safeRecord.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: fault === '429' ? 'rate_limited' : 'unauthorized' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', contentSha256: safeRecord.bodySha256 }));
  });
});

server.listen(8081, '0.0.0.0');
