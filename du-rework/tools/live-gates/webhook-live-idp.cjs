#!/usr/bin/env node
/**
 * LIVE-GATES step 3 (Claude review §10.7-5 / §11.4-5) — live HTTPS webhook
 * IdP + receiver dispatch against the tagged candidate.
 *
 * Modes:
 *   --mode self-test   Start the HTTPS IdP + receiver locally and prove the
 *                      token + signed-callback contract end to end (no
 *                      candidate needed). Also validates cert generation.
 *   --mode serve       Start the servers and keep them running (manual runs).
 *   --mode live        (requires --run-live) Start the servers, then execute
 *                      the one-off dispatcher INSIDE the candidate
 *                      orchestrator container (same dist code path as
 *                      production) against a synthetic delivery row, and
 *                      assert: IdP token issued, receiver got a valid HMAC +
 *                      Bearer callback, durable row DELIVERED.
 *
 * The candidate reaches the harness through compose extra_hosts aliases
 * (idp.live-gates.test / receiver.live-gates.test -> host-gateway) and trusts
 * the harness CA via NODE_EXTRA_CA_CERTS, both supplied by
 * `compose/live-gates.override.yml` (used by run-live-gates.ps1). The harness
 * dispatcher call passes `allowPrivateNetworks: true` because the receiver is
 * a loopback-side fixture; the SSRF fence for real destinations is covered by
 * the unit matrices and is not weakened in product code.
 *
 * Exit: 0 PASS, 1 FAIL, 2 config/prereq.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const {
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_CONFIG,
  REPO_ROOT,
  HARNESS_DIR,
  defaultReportsDir,
  parseArgs,
  loadEnvFile,
  configError,
  ensureDir,
  writeReport,
  runCompose,
  runComposeAsync,
} = require('./lib/live-common.cjs');
const { ensureCerts } = require('./lib/certs.cjs');

const DEFAULT_IDP_PORT = 8443;
const DEFAULT_RECEIVER_PORT = 9443;
const IDP_NAME = 'idp.live-gates.test';
const RECEIVER_NAME = 'receiver.live-gates.test';

function signBody(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function makeIdp(options) {
  const issued = new Map();
  let counter = 0;
  const server = https.createServer({ key: options.key, cert: options.cert }, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'https://idp');
      if (req.method !== 'POST' || url.pathname !== '/token') {
        return json(res, 404, { error: 'not_found' });
      }
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'client_credentials') {
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      let clientId = form.get('client_id');
      let clientSecret = form.get('client_secret');
      const auth = req.headers.authorization;
      if (auth?.startsWith('Basic ')) {
        const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        clientId = decodeURIComponent(decoded.slice(0, sep));
        clientSecret = decodeURIComponent(decoded.slice(sep + 1));
      }
      if (clientId !== options.clientId || clientSecret !== options.clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      counter += 1;
      const token = `live-oauth-token-${counter}-${crypto.randomBytes(8).toString('hex')}`;
      issued.set(token, Date.now() + 60_000);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 60 });
    } catch {
      return json(res, 500, { error: 'idp_failure' });
    }
  });
  return { server, issued, issuedCount: () => issued.size };
}

function makeReceiver(options) {
  const receipts = [];
  const receiptsPath = options.receiptsPath;
  const server = https.createServer({ key: options.key, cert: options.cert }, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'https://receiver');
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const body = await readBody(req);
      const deliveryId = req.headers['x-du-delivery-id'] ?? null;
      const timestamp = req.headers['x-du-timestamp'] ?? null;
      const signature = req.headers['x-du-signature'] ?? null;
      const authorization = req.headers.authorization ?? null;
      const signatureValid =
        typeof timestamp === 'string'
        && typeof signature === 'string'
        && signature === signBody(options.webhookSecret, timestamp, body);
      const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : null;
      const tokenValid = bearer !== null && options.idp.issued.has(bearer);
      const receipt = {
        at: new Date().toISOString(),
        kind: options.kind,
        attempt: receipts.length + 1,
        path: url.pathname,
        deliveryId,
        signatureValid,
        tokenPresent: bearer !== null,
        tokenValid,
        tokenRef: bearer ? shortHash(bearer) : null,
        bodySha256: shortHash(body),
        status: 0,
      };
      const failAuth = options.first401 === true && receipt.attempt === 1;
      receipt.status = !signatureValid || !tokenValid ? 401 : failAuth ? 401 : 200;
      receipts.push(receipt);
      fs.appendFileSync(receiptsPath, JSON.stringify(receipt) + '\n', 'utf8');
      if (receipt.status !== 200) {
        return json(res, 401, { error: signatureValid ? 'invalid_token' : 'invalid_signature' });
      }
      return json(res, 200, { ok: true, deliveryId });
    } catch {
      return json(res, 500, { error: 'receiver_failure' });
    }
  });
  return { server, receipts };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function httpsJson(options) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const payload = options.body ?? '';
    const request = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? 'POST',
        headers: {
          'content-type': options.contentType ?? 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(payload),
          ...(options.headers ?? {}),
        },
        ca: options.ca,
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body;
          try {
            body = text.length ? JSON.parse(text) : undefined;
          } catch {
            body = { raw: text };
          }
          resolve({ status: response.statusCode, body, text });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(options.timeoutMs ?? 10_000, () => request.destroy(new Error('probe timeout')));
    request.end(payload);
  });
}

async function selfTest(args) {
  const reportsDir = args['report-dir'] ?? defaultReportsDir();
  const certDir = args['cert-dir'] ?? path.join(HARNESS_DIR, '.certs');
  const certs = ensureCerts(certDir, { force: args['force-certs'] === true });
  const ca = fs.readFileSync(certs.caPath);
  const key = fs.readFileSync(certs.keyPath);
  const cert = fs.readFileSync(certs.certPath);
  const webhookSecret = args['webhook-secret'] ?? 'live-gates-synthetic-hmac-secret';
  const clientId = 'live-gates-client';
  const clientSecret = 'LIVE-CLIENT-SECRET-' + crypto.randomBytes(12).toString('hex');
  const evidenceDir = ensureDir(path.join(reportsDir, 'webhook-self-test'));
  const receiptsPath = path.join(evidenceDir, 'receipts.jsonl');
  fs.rmSync(receiptsPath, { force: true });

  const idp = makeIdp({ key, cert, clientId, clientSecret });
  const receiver = makeReceiver({ key, cert, webhookSecret, idp, receiptsPath, kind: 'self-test' });
  const idpPort = await listen(idp.server, Number(args['idp-port'] ?? 0));
  const receiverPort = await listen(receiver.server, Number(args['receiver-port'] ?? 0));
  const lines = [`self-test ports: idp=${idpPort} receiver=${receiverPort}`, `ca: ${certs.caPath}`];
  try {
    const token = await httpsJson({
      url: `https://127.0.0.1:${idpPort}/token`,
      ca,
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
    });
    lines.push(`idp token status=${token.status} type=${token.body?.token_type}`);
    const accessToken = token.body?.access_token;
    if (token.status !== 200 || typeof accessToken !== 'string') {
      return writeReport(reportsDir, 'webhook-live-idp-self-test', { step: 'webhook-live-idp', mode: 'self-test', pass: false, summary: { tokenStatus: token.status } }, lines);
    }
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ deliveryId: 'self-test', eventType: 'operation.succeeded' });
    const good = await httpsJson({
      url: `https://127.0.0.1:${receiverPort}/callback`,
      ca,
      body,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-du-signature': signBody(webhookSecret, timestamp, body),
        'x-du-timestamp': timestamp,
        'x-du-delivery-id': 'self-test',
      },
    });
    const bad = await httpsJson({
      url: `https://127.0.0.1:${receiverPort}/callback`,
      ca,
      body,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-du-signature': 'sha256=deadbeef',
        'x-du-timestamp': timestamp,
        'x-du-delivery-id': 'self-test-bad',
      },
    });
    lines.push(`receiver valid callback status=${good.status}`);
    lines.push(`receiver tampered callback status=${bad.status}`);
    const pass = good.status === 200 && bad.status === 401
      && receiver.receipts[0]?.signatureValid === true && receiver.receipts[0]?.tokenValid === true
      && receiver.receipts[1]?.signatureValid === false;
    return writeReport(reportsDir, 'webhook-live-idp-self-test', {
      step: 'webhook-live-idp',
      mode: 'self-test',
      pass,
      summary: {
        idpPort,
        receiverPort,
        caPath: certs.caPath,
        receipts: receiver.receipts,
        tokenIssued: idp.issuedCount(),
        clientSecretRef: shortHash(clientSecret),
      },
    }, lines);
  } finally {
    await Promise.all([close(idp.server), close(receiver.server)]);
  }
}

function livePlan(args) {
  const reportsDir = args['report-dir'] ?? defaultReportsDir();
  const certDir = args['cert-dir'] ?? path.join(HARNESS_DIR, '.certs');
  const idpPort = Number(args['idp-port'] ?? DEFAULT_IDP_PORT);
  const receiverPort = Number(args['receiver-port'] ?? DEFAULT_RECEIVER_PORT);
  return {
    reportsDir,
    certDir,
    idpPort,
    receiverPort,
    webhookSecret: args['webhook-secret'] ?? process.env.WEBHOOK_SECRET ?? 'live-gates-synthetic-hmac-secret',
    clientId: args['client-id'] ?? 'live-gates-client',
    clientSecret: args['client-secret'] ?? ('LIVE-CLIENT-SECRET-' + crypto.randomBytes(12).toString('hex')),
    first401: args['expect-first-401'] === true,
    operationId: args['operation-id'],
    composeService: args['compose-service'] ?? 'orchestrator',
  };
}

async function runLive(args) {
  if (args['run-live'] !== true) {
    throw configError('live mode sends real HTTP to the candidate: re-run with --run-live to confirm');
  }
  const plan = livePlan(args);
  const certs = ensureCerts(plan.certDir, { force: args['force-certs'] === true });
  const ca = fs.readFileSync(certs.caPath);
  const key = fs.readFileSync(certs.keyPath);
  const cert = fs.readFileSync(certs.certPath);
  const evidenceDir = ensureDir(path.join(plan.reportsDir, 'webhook-live'));
  const receiptsPath = path.join(evidenceDir, 'receipts.jsonl');
  fs.rmSync(receiptsPath, { force: true });
  const sentinelHmac = 'LIVE-SENTINEL-HMAC-' + crypto.randomBytes(10).toString('hex');
  fs.writeFileSync(path.join(plan.reportsDir, 'sentinels.json'), JSON.stringify({
    sentinels: [plan.clientSecret, sentinelHmac],
  }, null, 2), 'utf8');

  const idp = makeIdp({ key, cert, clientId: plan.clientId, clientSecret: plan.clientSecret });
  const receiver = makeReceiver({ key, cert, webhookSecret: plan.webhookSecret, idp, receiptsPath, kind: 'live', first401: plan.first401 });
  await listen(idp.server, plan.idpPort);
  await listen(receiver.server, plan.receiverPort);
  const lines = [
    `live servers: idp=:${plan.idpPort} receiver=:${plan.receiverPort}`,
    `sentinels written to ${path.join(plan.reportsDir, 'sentinels.json')}`,
  ];
  try {
    const probe = crypto.randomUUID();
    const receiverUrl = `https://${RECEIVER_NAME}:${plan.receiverPort}/callback?probe=${probe}`;
    const idpUrl = `https://${IDP_NAME}:${plan.idpPort}/token`;
    // Container-side connectivity preflight (records DNS/TLS/HTTP evidence and
    // separates "host path blocked" from "auth rejected" when something fails).
    const preflightExec = await runComposeAsync([
      'exec', '-T', plan.composeService,
      'node', '/live-gates/inside/connectivity-probe.cjs', idpUrl,
    ], { timeoutMs: 60_000 });
    const preflight = preflightExec.stdout
      .trim().split('\n').filter((line) => line.startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    lines.push(`preflight exit=${preflightExec.status} ${JSON.stringify(preflight)}`);
    const exec = await runComposeAsync([
      'exec', '-T',
      '-e', `LIVE_RECEIVER_URL=${receiverUrl}`,
      '-e', `LIVE_IDP_URL=${idpUrl}`,
      '-e', `LIVE_WEBHOOK_SECRET=${plan.webhookSecret}`,
      '-e', `LIVE_CLIENT_ID=${plan.clientId}`,
      '-e', `LIVE_CLIENT_SECRET=${plan.clientSecret}`,
      ...(plan.operationId ? ['-e', `LIVE_OPERATION_ID=${plan.operationId}`] : []),
      plan.composeService,
      'node', '/live-gates/inside/run-dispatcher-inside.cjs',
    ], { timeoutMs: Number(args['timeout-ms'] ?? 180_000) });
    lines.push(`inside exit=${exec.status}`);
    lines.push(exec.stdout.trim().split('\n').slice(-6).join('\n'));
    if (exec.status !== 0) lines.push(`inside stderr: ${exec.stderr.trim().slice(0, 800)}`);
    const inside = (() => {
      const last = exec.stdout.trim().split('\n').reverse().find((line) => line.trim().startsWith('{'));
      try {
        return last ? JSON.parse(last) : undefined;
      } catch {
        return undefined;
      }
    })();
    const successes = receiver.receipts.filter((r) => r.status === 200 && r.signatureValid && r.tokenValid);
    const tokenRefs = new Set(receiver.receipts.map((r) => r.tokenRef));
    const pass = exec.status === 0
      && inside?.receipt?.status === 'DELIVERED'
      && successes.length >= 1
      && (plan.first401 ? receiver.receipts.length >= 2 && tokenRefs.size >= 2 : true);
    lines.push(`receipts: ${receiver.receipts.length}, delivered=${successes.length}, distinctTokenRefs=${tokenRefs.size}`);
    return writeReport(plan.reportsDir, 'webhook-live-idp', {
      step: 'webhook-live-idp',
      mode: 'live',
      pass,
      summary: {
        receiverUrl,
        idpUrl,
        caPath: certs.caPath,
        clientSecretRef: shortHash(plan.clientSecret),
        hmacSentinelRef: shortHash(sentinelHmac),
        first401Expected: plan.first401,
        preflight,
        inside: inside ?? null,
        insideExit: exec.status,
        receipts: receiver.receipts,
        idpTokensIssued: idp.issuedCount(),
      },
    }, lines);
  } finally {
    await Promise.all([close(idp.server), close(receiver.server)]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args['env-file'] ?? path.join(REPO_ROOT, '.env.docker'));
  const mode = args.mode ?? (args['run-live'] ? 'live' : 'self-test');
  if (args['dry-run'] === true) {
    const reportsDir = args['report-dir'] ?? defaultReportsDir();
    return writeReport(reportsDir, 'webhook-live-idp-dry-run', {
      step: 'webhook-live-idp',
      mode: 'dry-run',
      pass: true,
      plan: {
        mode,
        idpPort: Number(args['idp-port'] ?? DEFAULT_IDP_PORT),
        receiverPort: Number(args['receiver-port'] ?? DEFAULT_RECEIVER_PORT),
        certDir: args['cert-dir'] ?? path.join(HARNESS_DIR, '.certs'),
        runLive: args['run-live'] === true,
        composeFiles: process.env.DU_LIVE_COMPOSE_FILES ?? '(default docker-compose.yml)',
      },
    }, [
      'dry-run: no server started, nothing sent',
      'run with --mode self-test (local contract proof) or --mode live --run-live (candidate)',
    ]);
  }
  if (mode === 'self-test') return selfTest(args);
  if (mode === 'serve') {
    const plan = livePlan(args);
    const certs = ensureCerts(plan.certDir, { force: args['force-certs'] === true });
    const idp = makeIdp({
      key: fs.readFileSync(certs.keyPath), cert: fs.readFileSync(certs.certPath),
      clientId: plan.clientId, clientSecret: plan.clientSecret,
    });
    const receiver = makeReceiver({
      key: fs.readFileSync(certs.keyPath), cert: fs.readFileSync(certs.certPath),
      webhookSecret: plan.webhookSecret, idp, receiptsPath: path.join(ensureDir(plan.reportsDir), 'serve-receipts.jsonl'), kind: 'serve',
    });
    await listen(idp.server, plan.idpPort);
    await listen(receiver.server, plan.receiverPort);
    process.stdout.write(`READY idp=https://${IDP_NAME}:${plan.idpPort}/token receiver=https://${RECEIVER_NAME}:${plan.receiverPort}/callback\n`);
    return new Promise(() => undefined);
  }
  if (mode === 'live') return runLive(args);
  throw configError(`unknown mode: ${mode}`);
}

main()
  .then((code) => process.exit(code ?? EXIT_PASS))
  .catch((error) => {
    process.stderr.write(`[live-gates] webhook config/prereq error: ${error.message}\n`);
    process.exit(error.harnessConfig ? EXIT_CONFIG : EXIT_FAIL);
  });
