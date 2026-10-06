// SEC-ENC-05 wiring check (receipt evidence, not product code).
// Feeds the generated CONNECTOR_INVOCATION_ENCRYPTION_KEYS value through the
// REAL connector parser (resolveInvocationStorageCryptoFromEnv's
// parseLocalInvocationKekConfig) in two modes:
//   node --experimental-strip-types check-invocation-kek.mjs --env-file <file>
//   docker compose ... config --format json | node --experimental-strip-types check-invocation-kek.mjs
// Prints only structural fields (never the key material).
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cryptoModule = await import(
  pathToFileURL(path.resolve(here, '../../../../services/connector/src/db/invocation-crypto.ts')).href
);

function checkRaw(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { valuePresent: false, parserWouldRefuse: true };
  }
  const parsed = cryptoModule.parseLocalInvocationKekConfig(raw);
  return {
    valuePresent: true,
    keyRef: parsed.keyRef,
    activeVersion: parsed.activeVersion,
    versions: Object.keys(parsed.keysByVersion),
    kekBytes: Buffer.from(parsed.keysByVersion[String(parsed.activeVersion)], 'base64').length,
  };
}

if (process.argv[2] === '--env-file') {
  const text = fs.readFileSync(process.argv[3], 'utf8');
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith('CONNECTOR_INVOCATION_ENCRYPTION_KEYS='));
  if (!line) throw new Error('CONNECTOR_INVOCATION_ENCRYPTION_KEYS missing from env file');
  console.log(JSON.stringify({ source: 'env-file', ...checkRaw(line.slice(line.indexOf('=') + 1)) }));
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const project = JSON.parse(input);
  const raw = project.services.connector.environment.CONNECTOR_INVOCATION_ENCRYPTION_KEYS;
  console.log(JSON.stringify({
    source: 'compose-config',
    forwarded: typeof raw === 'string' && raw.length > 0,
    ...checkRaw(raw),
  }));
}
