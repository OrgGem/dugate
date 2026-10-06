#!/usr/bin/env node
'use strict';
// tests/pipelines/worker-slots.live-check.cjs
// P3 bonus independent check: runs the EXACT Lua scripts extracted from
// lib/queue/worker-slots.ts against a disposable Redis instance (isolated
// container, prefix-scoped keys). This closes what mocks cannot: the real
// counter arithmetic behind cap checks, the guarded DECR, and the TTL.
//
// Usage: CHECK_REDIS_URL=redis://127.0.0.1:6399 node tests/pipelines/worker-slots.live-check.cjs
// Exit: 0 all checks pass, 1 a check failed, 2 script/setup error.

const fs = require('node:fs');
const path = require('node:path');
const IORedis = require('ioredis');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lib', 'queue', 'worker-slots.ts'),
  'utf8',
);
const acquireMatch = source.match(/const ACQUIRE_LUA = `([\s\S]*?)`;/);
const releaseMatch = source.match(/const lua = `([\s\S]*?)`;/);
if (!acquireMatch || !releaseMatch) {
  console.error('failed to extract the Lua scripts from lib/queue/worker-slots.ts');
  process.exit(2);
}
const ACQUIRE = acquireMatch[1];
const RELEASE = releaseMatch[1];

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
}

(async () => {
  const redis = new IORedis(process.env.CHECK_REDIS_URL || 'redis://127.0.0.1:6399', {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });
  const key = 'workerslots:p3-live-check:demo';
  const cap1Key = 'workerslots:p3-live-check:cap1';
  await redis.del(key, cap1Key);

  const acquire = (cap, ttl, k = key) => redis.eval(ACQUIRE, 1, k, String(cap), String(ttl));
  const release = (k = key) => redis.eval(RELEASE, 1, k);

  const a1 = await acquire(2, 30);
  const a2 = await acquire(2, 30);
  const a3 = await acquire(2, 30);
  check('cap=2: first acquire returns 1', a1 === 1, { a1 });
  check('cap=2: second acquire returns 1', a2 === 1, { a2 });
  const counterAfterRefusal = await redis.get(key);
  check(
    'cap=2: third acquire refused (0) and the refused INCR was rolled back',
    a3 === 0 && counterAfterRefusal === '2',
    { a3, counter: counterAfterRefusal },
  );

  const ttl = await redis.ttl(key);
  check('TTL is set on first INCR (crash reclaim)', ttl > 0 && ttl <= 30, { ttl });

  const r1 = await release();
  const r2 = await release();
  const r3 = await release();
  check('guarded DECR walks 2 -> 1 -> 0', r1 === 1 && r2 === 0, { r1, r2 });
  const counterAfterExtraRelease = await redis.get(key);
  check(
    'guard: an extra release never goes below 0',
    r3 === 0 && counterAfterExtraRelease === '0',
    { r3, counter: counterAfterExtraRelease },
  );

  await redis.del(key); // simulate TTL expiry between acquire and release
  const rExpired = await release();
  const existsAfterExpiredRelease = await redis.exists(key);
  check(
    'release after expiry returns 0 and does not recreate the key',
    rExpired === 0 && existsAfterExpiredRelease === 0,
    { rExpired, exists: existsAfterExpiredRelease },
  );

  const b1 = await acquire(1, 30, cap1Key);
  const b2 = await acquire(1, 30, cap1Key);
  check('cap=1: second acquire refused', b1 === 1 && b2 === 0, { b1, b2 });
  await redis.del(cap1Key);

  await redis.quit();
  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name} ${JSON.stringify(result.detail)}`);
  }
  const pass = results.every((result) => result.pass);
  console.log(JSON.stringify({ script: 'worker-slots.live-check', pass, checks: results.length }));
  process.exit(pass ? 0 : 1);
})().catch((error) => {
  console.error('live check error:', error && error.message ? error.message : error);
  process.exit(2);
});
