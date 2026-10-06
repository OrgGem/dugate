'use strict';

const http = require('node:http');

const PORT = 8090;
const INVOICE_NUMBER = 'INV-ARCH-PHASE-B-MOCK-001';
let calls = 0;

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && request.url === '/stats') {
    // Count-only: request bodies and authorization headers are never retained.
    send(response, 200, { calls });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/extract') {
    send(response, 404, { error: 'not_found' });
    return;
  }

  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(response, 400, { error: 'invalid_json_object' });
      return;
    }
    if (!String(request.headers.authorization || '').startsWith('Bearer ')) {
      send(response, 401, { error: 'authorization_required' });
      return;
    }

    // The request content is parsed only to validate the wire shape and is
    // deliberately discarded. The fixture result is deterministic/synthetic.
    const hasInput = ['prompt', 'text', 'task', 'artifacts'].some((key) => key in body);
    if (!hasInput) {
      send(response, 400, { error: 'extract_input_missing' });
      return;
    }
    calls += 1;
    send(response, 200, {
      data: {
        supplier: { name: 'Mock Provider Ltd', taxId: 'MOCK-TAX-001' },
        buyer: { name: 'Fixture Buyer' },
        invoiceNumber: INVOICE_NUMBER,
        invoiceDate: '2026-10-06',
        lineItems: [{ description: 'Synthetic test item', quantity: 1, unitPrice: 4250, amount: 4250 }],
        subtotal: 4250,
        total: 4250,
        currency: 'USD',
      },
      providerRequestId: `extract-mock-${calls}`,
    });
  } catch {
    // No request values or parse errors are emitted to logs.
    send(response, 400, { error: 'invalid_request' });
  }
});

server.listen(PORT, '0.0.0.0');
