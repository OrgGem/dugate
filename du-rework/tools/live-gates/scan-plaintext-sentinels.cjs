#!/usr/bin/env node
/**
 * LIVE-GATES step 1 (Claude review §10.7-5 / §11.4-5) — plaintext byte-scan.
 *
 * Scans the candidate's durable stores for synthetic credential sentinels and
 * high-confidence credential shapes:
 *   - PostgreSQL: every text/varchar/json/jsonb/bytea cell in `public`
 *     (paged by ctid, bytea via `encode(col,'escape')` so printable bytes are
 *     searched literally);
 *   - S3 (MinIO/S3-compatible): every object body + key;
 *   - Vault mock: every KV v2 secret under the configured mounts — occurrences
 *     are expected ONLY under the approved prefixes (default `du/`); anywhere
 *     else, or in any listing/metadata response, is a leak.
 *
 * Usage (from du-rework, Windows or POSIX):
 *   node tools/live-gates/scan-plaintext-sentinels.cjs \
 *     --pg-url postgresql://du:...@127.0.0.1:5433/du_orchestrator_test \
 *     --sentinels "LIVE-SENTINEL-...,LIVE-CLIENT-SECRET-..." \
 *     --s3-endpoint http://127.0.0.1:9003 --s3-bucket du-artifacts \
 *     --vault-addr http://127.0.0.1:8200 --vault-token root-dev-token
 *
 * Flags: --dry-run (validate config only), --skip-pg/--skip-s3/--skip-vault,
 * --vault-allow-prefix du/ (repeatable via comma), --vault-must-contain <s>,
 * --max-object-bytes N (oversize objects are SKIPPED=fail unless
 * --allow-skip-oversize), --max-cell-bytes N.
 *
 * Exit: 0 clean, 1 leak/skip, 2 config/prereq.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_CONFIG,
  REPO_ROOT,
  requireFromOrchestrator,
  defaultReportsDir,
  parseArgs,
  loadEnvFile,
  configError,
  ensureDir,
  writeReport,
  loadSentinels,
  scanBytes,
  resolveDatabaseUrl,
} = require('./lib/live-common.cjs');

const EXPR_LIMIT_DEFAULT = 8 * 1024 * 1024;
const PAGE_SIZE = 250;

function log(lines, message) {
  lines.push(message);
}

async function scanPostgres(args, sentinels, lines) {
  const { Client } = requireFromOrchestrator('pg');
  const connectionString = resolveDatabaseUrl(args);
  const maxCellBytes = Number(args['max-cell-bytes'] ?? EXPR_LIMIT_DEFAULT);
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  const summary = { enabled: true, cells: 0, tables: 0, hits: [], oversizedCells: 0, errors: [] };
  await client.connect();
  try {
    const columnsRes = await client.query(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='public'
          AND data_type IN ('text','character varying','character','json','jsonb','bytea')
        ORDER BY table_name, column_name`,
    );
    const tables = new Map();
    for (const row of columnsRes.rows) {
      if (!tables.has(row.table_name)) tables.set(row.table_name, []);
      tables.get(row.table_name).push(row);
    }
    for (const [table, columns] of tables) {
      summary.tables += 1;
      const selectList = columns
        .map((c) => {
          const type = c.data_type === 'bytea'
            ? `encode("${c.column_name}", 'escape')`
            : `"${c.column_name}"::text`;
          return `${type} AS "${c.column_name}"`;
        })
        .join(', ');
      let lastCtid = '(0,0)';
      for (;;) {
        const page = await client.query(
          `SELECT ctid::text AS _ctid, ${selectList} FROM "${table}"
            WHERE ctid > $1::tid ORDER BY ctid LIMIT ${PAGE_SIZE}`,
          [lastCtid],
        );
        if (page.rowCount === 0) break;
        for (const row of page.rows) {
          lastCtid = row._ctid;
          summary.cells += 1;
          for (const column of columns) {
            const value = row[column.column_name];
            if (value === null || value === undefined) continue;
            const text = String(value);
            if (text.length > maxCellBytes) {
              summary.oversizedCells += 1;
              continue;
            }
            const hits = scanBytes(text, sentinels);
            for (const hit of hits) {
              summary.hits.push({
                store: 'postgres',
                table,
                column: column.column_name,
                rowRef: row._ctid,
                ...hit,
              });
            }
          }
        }
      }
      log(lines, `pg: scanned ${table} (${columns.length} columns)`);
    }
  } catch (error) {
    summary.errors.push(String(error && error.message ? error.message : error));
  } finally {
    await client.end().catch(() => undefined);
  }
  return summary;
}

async function scanS3(args, sentinels, lines) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = requireFromOrchestrator('@aws-sdk/client-s3');
  const endpoint = args['s3-endpoint'] ?? process.env.ARTIFACT_S3_ENDPOINT ?? 'http://127.0.0.1:9003';
  const bucket = args['s3-bucket'] ?? process.env.ARTIFACT_S3_BUCKET ?? 'du-artifacts';
  const accessKeyId = args['s3-access-key'] ?? process.env.AWS_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? 'minioadmin';
  const secretAccessKey =
    args['s3-secret-key'] ?? process.env.AWS_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin_secret';
  const maxObjectBytes = Number(args['max-object-bytes'] ?? 64 * 1024 * 1024);
  const allowSkipOversize = args['allow-skip-oversize'] === true;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const summary = { enabled: true, endpoint, bucket, objects: 0, bytes: 0, hits: [], skipped: [], errors: [] };
  let token;
  try {
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const item of page.Contents ?? []) {
        summary.objects += 1;
        const keyHits = scanBytes(String(item.Key ?? ''), sentinels);
        for (const hit of keyHits) summary.hits.push({ store: 's3', key: item.Key, kind: 'key', ...hit });
        const size = Number(item.Size ?? 0);
        if (size > maxObjectBytes) {
          summary.skipped.push({ key: item.Key, size, reason: 'oversize' });
          if (!allowSkipOversize) {
            summary.hits.push({ store: 's3', key: item.Key, kind: 'skipped-oversize', size });
          }
          continue;
        }
        const body = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.Key }));
        const chunks = [];
        for await (const chunk of body.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        summary.bytes += bytes.length;
        const hits = scanBytes(bytes, sentinels);
        for (const hit of hits) summary.hits.push({ store: 's3', key: item.Key, kind: 'body', ...hit });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (error) {
    summary.errors.push(String(error && error.message ? error.message : error));
  } finally {
    client.destroy?.();
  }
  log(lines, `s3: scanned ${summary.objects} objects (${summary.bytes} bytes)`);
  return summary;
}

async function vaultRequest(args, method, urlPath, body) {
  const base = String(args['vault-addr'] ?? process.env.VAULT_ADDR ?? 'http://127.0.0.1:8200').replace(/\/+$/, '');
  const token = args['vault-token'] ?? process.env.VAULT_TOKEN ?? process.env.VAULT_DEV_ROOT_TOKEN_ID ?? 'root-dev-token';
  const namespace = args['vault-namespace'] ?? process.env.VAULT_NAMESPACE;
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'x-vault-token': String(token),
      ...(namespace ? { 'x-vault-namespace': String(namespace) } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function listVaultSecrets(args, mount, prefix, out, depth) {
  if (depth > 10) return;
  const result = await vaultRequest(args, 'LIST', `/v1/${encodeURIComponent(mount)}/metadata/${prefix}`);
  if (result.status === 404) return;
  if (result.status !== 200) {
    throw new Error(`vault LIST ${mount}/${prefix} -> HTTP ${result.status}`);
  }
  const keys = Array.isArray(result.json?.data?.keys) ? result.json.data.keys : [];
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const child = prefix.length > 0 ? `${prefix}/${key}` : key;
    if (key.endsWith('/')) {
      await listVaultSecrets(args, mount, child.slice(0, -1), out, depth + 1);
    } else {
      out.push(child);
    }
  }
}

async function scanVault(args, sentinels, lines) {
  const mounts = String(args['vault-mounts'] ?? process.env.DU_LIVE_VAULT_MOUNTS ?? 'secret')
    .split(',').map((part) => part.trim()).filter(Boolean);
  const allowPrefixes = String(args['vault-allow-prefix'] ?? 'du/')
    .split(',').map((part) => part.trim()).filter(Boolean);
  const mustContain = typeof args['vault-must-contain'] === 'string' && args['vault-must-contain'].length >= 8
    ? args['vault-must-contain']
    : undefined;
  const summary = { enabled: true, mounts, allowPrefixes, secrets: 0, expectedHits: 0, hits: [], errors: [], mustContainPresent: mustContain === undefined };
  try {
    for (const mount of mounts) {
      const paths = [];
      await listVaultSecrets(args, mount, '', paths, 0);
      for (const secretPath of paths) {
        const result = await vaultRequest(
          args,
          'GET',
          `/v1/${encodeURIComponent(mount)}/data/${secretPath.split('/').map(encodeURIComponent).join('/')}`,
        );
        if (result.status !== 200) {
          summary.errors.push(`vault GET ${mount}/${secretPath} -> HTTP ${result.status}`);
          continue;
        }
        summary.secrets += 1;
        const payloadText = JSON.stringify(result.json?.data?.data ?? {});
        if (mustContain !== undefined && payloadText.includes(mustContain)) {
          summary.mustContainPresent = true;
        }
        const hits = scanBytes(payloadText, sentinels);
        const allowed = allowPrefixes.some((p) => secretPath === p.replace(/\/$/, '') || secretPath.startsWith(p));
        for (const hit of hits) {
          if (allowed) {
            summary.expectedHits += 1;
          } else {
            summary.hits.push({ store: 'vault', mount, path: secretPath, kind: 'disallowed-path', ...hit });
          }
        }
      }
    }
  } catch (error) {
    summary.errors.push(String(error && error.message ? error.message : error));
  }
  log(lines, `vault: scanned ${summary.secrets} secrets across [${mounts.join(', ')}] (${summary.expectedHits} expected-store hits)`);
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args['env-file'] ?? path.join(REPO_ROOT, '.env.docker'));
  const reportsDir = args['report-dir'] ?? defaultReportsDir();
  const lines = [];
  const sentinels = loadSentinels(args);
  if (sentinels.length === 0) {
    throw configError('no sentinels provided: pass --sentinels/--sentinels-file or DU_LIVE_SENTINELS (the live webhook step prints its sentinels)');
  }
  const plan = {
    dryRun: args['dry-run'] === true,
    sentinelCount: sentinels.length,
    postgres: args['skip-pg'] !== true,
    s3: args['skip-s3'] !== true,
    vault: args['skip-vault'] !== true,
    reportsDir,
  };
  log(lines, `plan: ${JSON.stringify(plan)}`);

  if (args['dry-run'] === true) {
    const payload = {
      step: 'scan-plaintext-sentinels',
      mode: 'dry-run',
      pass: true,
      plan,
      sentinels: sentinels.map((_, index) => `sentinel-${index + 1}`),
      hits: [],
    };
    return writeReport(reportsDir, 'scan-plaintext-sentinels', payload, lines);
  }

  const summary = {};
  if (args['skip-pg'] !== true) summary.postgres = await scanPostgres(args, sentinels, lines);
  if (args['skip-s3'] !== true) summary.s3 = await scanS3(args, sentinels, lines);
  if (args['skip-vault'] !== true) summary.vault = await scanVault(args, sentinels, lines);

  const hits = [
    ...(summary.postgres?.hits ?? []),
    ...(summary.s3?.hits ?? []),
    ...(summary.vault?.hits ?? []),
  ];
  const errors = [
    ...(summary.postgres?.errors ?? []),
    ...(summary.s3?.errors ?? []),
    ...(summary.vault?.errors ?? []),
  ];
  const mustContain = args['vault-must-contain'];
  const mustContainFailed =
    typeof mustContain === 'string' && summary.vault && summary.vault.mustContainPresent !== true;
  for (const hit of hits) {
    log(lines, `LEAK: ${hit.store} ${hit.table ? `${hit.table}.${hit.column}` : hit.path ?? hit.key} ${hit.kind}:${hit.label ?? ''} @${hit.offset}`);
  }
  for (const error of errors) log(lines, `SCAN ERROR: ${error}`);
  if (mustContainFailed) log(lines, `vault must-contain sentinel not found in allowed paths`);

  const pass = hits.length === 0 && errors.length === 0 && !mustContainFailed;
  const payload = {
    step: 'scan-plaintext-sentinels',
    mode: 'live',
    pass,
    plan,
    sentinelCount: sentinels.length,
    summary,
    hits,
    errors,
  };
  return writeReport(reportsDir, 'scan-plaintext-sentinels', payload, lines);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[live-gates] scan config/prereq error: ${error.message}\n`);
    process.exit(error.harnessConfig ? EXIT_CONFIG : EXIT_FAIL);
  });
