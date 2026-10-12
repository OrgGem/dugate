import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  createDb,
  type Db,
} from '../../../orchestrator/services/orchestrator/src/db/db';
import {
  createAuditService,
} from '../../../orchestrator/services/orchestrator/src/modules/audit/audit';
import {
  createConnectorSecretImportService,
  type ConnectorSecretImportActor,
} from '../../../orchestrator/services/orchestrator/src/modules/connectors/connector-secret-imports';
import {
  createSecretInDb,
  disableSecretInDb,
  rotateSecretInDb,
} from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-catalog-store';
import type { SecretCatalogKeyring } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-revision-resolver';
import {
  createMetadataCrypto,
  type MetadataCrypto,
  type SealedMetadata,
} from '../../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import { VaultTransitProvider } from '../../../orchestrator/services/orchestrator/src/modules/encryption/vault-transit-provider';
import { createConnectorManagementAuthorizationProvider } from '../../../orchestrator/services/orchestrator/src/modules/connectors/management-service-identity';
import { createTestIsolationContext, assertSafeIsolationConfig } from '../../isolation/namespace';
import { createConnectorComposition } from '../../../orchestrator/services/connector/src/composition';
import { HmacServiceIdentityVerifier } from '../../../orchestrator/services/connector/src/identity';
import { ContractSignedGrantVerifier, HmacSignedGrantSource } from '../../../orchestrator/services/connector/src/contract-grants';
import { AesCredentialCipher } from '../../../orchestrator/services/connector/src/services';
import {
  createInvocationFieldCrypto,
  createLocalInvocationKekProvider,
  parseLocalInvocationKekConfig,
} from '../../../orchestrator/services/connector/src/db/invocation-crypto';
import type { ConnectorDraftUpsert, ConnectorParityDraftResult } from '../../../orchestrator/packages/contracts/src/connector';
import type { SecretCatalogCreate } from '../../../orchestrator/packages/contracts/src/secret-catalog';
import { VaultKv2RefSchema } from '../../../orchestrator/packages/contracts/dist/vault';

const runSuffix = process.env.ORV14_VFY_RUN_ID ?? `${Date.now()}_${randomBytes(5).toString('hex')}`;
const pgBase = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const redisBase = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';
const vaultAddress = process.env.ORV14_VFY_VAULT_ADDR ?? 'http://127.0.0.1:28200';
const vaultRootToken = process.env.ORV14_VFY_VAULT_ROOT_TOKEN ?? 'orv14-vfy-dev-only';
const orchIsolation = createTestIsolationContext({
  runId: `orv14_vfy_import_orch_${runSuffix}`,
  baseArtifactPath: 'tests/workflow-api/orv14-vfy/artifacts',
});
const connectorIsolation = createTestIsolationContext({
  runId: `orv14_vfy_import_connector_${runSuffix}`,
  baseArtifactPath: 'tests/workflow-api/orv14-vfy/artifacts',
});
const orchDatabaseUrl = orchIsolation.getDatabaseUrlWithSchema(pgBase);
const connectorDatabaseUrl = connectorIsolation.getDatabaseUrlWithSchema(pgBase);
const redisUrl = new URL(connectorIsolation.getRedisUrl(redisBase));
redisUrl.pathname = `/${connectorIsolation.redisDbIndex}`;
const scopedRedisUrl = redisUrl.toString();
assertSafeIsolationConfig({ databaseUrl: orchDatabaseUrl, isolationCtx: orchIsolation });
assertSafeIsolationConfig({ databaseUrl: connectorDatabaseUrl, redisUrl: scopedRedisUrl, isolationCtx: connectorIsolation });

const tenantId = randomUUID();
const foreignTenantId = randomUUID();
const catalogSecret = `ORV14 synthetic old credential ${randomUUID()}`;
const rotatedSecret = `ORV14 synthetic rotated credential ${randomUUID()}`;
const catalogKeyV1 = randomBytes(32);
const catalogKeyV2 = randomBytes(32);
const catalogKeyring: SecretCatalogKeyring = {
  activeVersion: 'catalog-key-v1',
  keys: { 'catalog-key-v1': catalogKeyV1, 'catalog-key-v2': catalogKeyV2 },
};
const actor: ConnectorSecretImportActor = {
  actor: `admin-session:${randomUUID()}`,
  role: 'platform',
  issuer: 'orv14-vfy-local',
  sub: `admin-${randomUUID()}`,
  correlationId: `orv14-vfy-${randomUUID()}`,
};

const connectorServiceSecret = randomBytes(32);
const invocationGrantSecret = randomBytes(32);
const invocationKek = randomBytes(32);
const metadataKeyRef = `orv14-vfy-meta-${randomBytes(5).toString('hex')}`;
const transitMount = `orv14vfytransit_${randomBytes(5).toString('hex')}`;
const transitKeyName = `metadata_${randomBytes(5).toString('hex')}`;
const transitPolicyName = `orv14vfytransit_${randomBytes(5).toString('hex')}`;
const approleMount = `orv14vfyapprole_${randomBytes(5).toString('hex')}`;
const approleName = `writer_${randomBytes(5).toString('hex')}`;
const approlePolicyName = `orv14vfykv_${randomBytes(5).toString('hex')}`;
const vaultConnectorId = `orv14-${randomBytes(5).toString('hex')}`;
const vaultKvPath = `du/tenants/${tenantId}/connectors/${vaultConnectorId}/accounts/recipe`;

let baseDb: Db | undefined;
let orchDb: Db | undefined;
let connectorReadDb: Db | undefined;
let connectorComposition: ReturnType<typeof createConnectorComposition> | undefined;
let vaultRuntime: ReturnType<typeof import('../../../orchestrator/services/connector/src/vault/runtime').createConnectorVaultRuntime> | undefined;
let schemaCreated = false;
let connectorSchemaCreated = false;
let started = false;
let kvWritePosts = 0;
let kvMetadataPathOwned = false;
let connectorPort = 0;
let managementAuth: ReturnType<typeof createConnectorManagementAuthorizationProvider>;
let metadataCrypto: MetadataCrypto;
let importer: ReturnType<typeof createConnectorSecretImportService>;
let tracedImporterDb: Db;
let catalogReadCount = 0;
let claimRequestCount = 0;
let draftRequestCount = 0;
let injectedLostAck = false;
let lastUpsertFailure = 'no-request';
let lastVaultDestinationValidation = 'not-called';
let lastVaultWritePlanValidation = 'not-called';
let originalSecretEntry: Awaited<ReturnType<typeof createSecretInDb>>;
let originalSecretId = '';
let transitEncryptToken = '';
let transitDecryptToken = '';
let approleClientToken = '';
let transitMountOwned = false;
let transitPolicyOwned = false;
let approleMountOwned = false;
let approlePolicyOwned = false;

interface VaultJson extends Record<string, unknown> {
  data?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

class ConnectorResponseError extends Error {
  public constructor(public readonly status: number, public readonly code: string, public readonly safeMessage: string) {
    super(`Connector management returned HTTP ${status} (${code || 'no-code'})`);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSafeName(value: string): void {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('test generated an unsafe namespace name');
}

async function vaultRequest(
  method: string,
  path: string,
  body?: unknown,
  token = vaultRootToken,
): Promise<{ status: number; json: VaultJson }> {
  const response = await fetch(new URL(path.replace(/^\//, ''), `${vaultAddress.replace(/\/+$/, '')}/`), {
    method,
    headers: {
      'x-vault-token': token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
  });
  const text = await response.text();
  let json: VaultJson = {};
  if (text.length > 0) {
    try { json = JSON.parse(text) as VaultJson; }
    catch { throw new Error(`isolated Vault ${method} request returned non-JSON HTTP ${response.status}`); }
  }
  return { status: response.status, json };
}

async function vaultOk(method: string, path: string, body?: unknown): Promise<VaultJson> {
  const result = await vaultRequest(method, path, body);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`isolated Vault setup ${method} ${path} returned HTTP ${result.status}`);
  }
  return result.json;
}

async function createVaultIdentity(policy: string): Promise<string> {
  const response = await vaultOk('POST', 'v1/auth/token/create', {
    policies: [policy],
    no_default_policy: true,
    ttl: '30m',
    renewable: false,
  });
  const token = response.auth?.client_token;
  if (typeof token !== 'string' || token.length < 8) throw new Error('isolated Vault did not issue a scoped service token');
  return token;
}

function noteCatalogQuery(sql: string): void {
  if (sql.includes('FROM secret_catalog c') && sql.includes('secret_catalog_revisions')) catalogReadCount += 1;
}

function instrumentCatalogReads(db: Db): Db {
  const trackedQuery = async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
    noteCatalogQuery(sql);
    return db!.query<T>(sql, params);
  };
  return {
    pool: db.pool,
    query: trackedQuery,
    tx: <T>(fn: (client: PoolClient) => Promise<T>) => db!.tx((client) => {
      const trackedClient = new Proxy(client, {
        get(target, property, receiver) {
          if (property === 'query') {
            return (sql: string, params?: unknown[]) => {
              noteCatalogQuery(sql);
              return target.query(sql, params as never[]);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return fn(trackedClient);
    }),
    close: () => db!.close(),
  };
}

function recipe() {
  return {
    adapter: 'openai-compatible' as const,
    method: 'POST' as const,
    endpointUrl: 'https://provider.synthetic.invalid/v1/chat/completions',
    auth: { kind: 'bearer' as const, secretSlot: 'api_key' },
    headers: [],
    request: {
      promptField: 'prompt',
      modelField: 'model',
      fields: [{ name: 'model', source: 'model' as const }],
    },
    response: { contentPath: 'choices.0.message.content' },
    session: { capture: [], inject: [] },
    timeoutMs: 10_000,
    responseBytes: 16_384,
  };
}

function importRequest(input: {
  tenantId?: string;
  secretId: string;
  idempotencyKey?: string;
  recipe?: ReturnType<typeof recipe>;
}): ConnectorDraftUpsert {
  return {
    tenantId: input.tenantId ?? tenantId,
    expectedHeadRevision: 0,
    recipe: input.recipe ?? recipe(),
    credentialChange: { action: 'vault-ref', reference: input.secretId },
    idempotencyKey: input.idempotencyKey ?? `orv14-vfy-import-${randomUUID()}`,
  };
}

function makeImporter(options: { db?: Db; crypto?: MetadataCrypto; keyring?: SecretCatalogKeyring; disableCrypto?: boolean } = {}) {
  return createConnectorSecretImportService({
    db: options.db ?? tracedImporterDb,
    audit: createAuditService(options.db ?? tracedImporterDb),
    metadataCrypto: options.disableCrypto ? undefined : (options.crypto ?? metadataCrypto),
    catalogKeyring: options.keyring ?? catalogKeyring,
    connector: {
      async claimRecipeDraft(input) {
        claimRequestCount += 1;
        const result = await connectorManagementCall(
          'POST',
          `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/claim`,
          {
            tenantId: input.tenantId,
            expectedHeadRevision: input.expectedHeadRevision,
            idempotencyKey: input.idempotencyKey,
          },
        ) as { claimed: boolean; expectedHeadRevision: number };
        return result;
      },
      async upsertResolvedRecipeDraft(input) {
        draftRequestCount += 1;
        let result: ConnectorParityDraftResult;
        try {
          result = await connectorManagementCall(
            'PUT',
            `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/draft`,
            {
              tenantId: input.tenantId,
              expectedHeadRevision: input.expectedHeadRevision,
              recipe: input.recipe,
              credentialChange: input.credentialChange,
              credentialImportSource: input.credentialImportSource,
              idempotencyKey: input.idempotencyKey,
            },
          ) as ConnectorParityDraftResult;
        } catch (error) {
          lastUpsertFailure = error instanceof ConnectorResponseError
            ? `HTTP-${error.status}-${error.code}-${error.safeMessage}`
            : error instanceof Error ? error.name : typeof error;
          throw error;
        }
        if (!injectedLostAck) {
          injectedLostAck = true;
          throw new Error('independent fixture dropped the response after Connector HTTP 201');
        }
        return result;
      },
    },
  });
}

async function connectorManagementCall(method: string, path: string, body?: unknown, authorization?: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${connectorPort}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : { authorization: managementAuth('connector:management') }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  if (response.status !== 204) {
    try { json = await response.json() as Record<string, unknown>; }
    catch { throw new Error(`Connector management ${method} returned an unreadable HTTP ${response.status}`); }
  }
  if (!response.ok) {
    const error = json.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === 'string' ? error.message : '';
    const safeMessage = [catalogSecret, rotatedSecret, approleClientToken, transitEncryptToken, transitDecryptToken]
      .filter((value) => value.length > 0)
      .reduce((current, value) => current.replaceAll(value, '[REDACTED]'), message)
      .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 180);
    throw new ConnectorResponseError(
      response.status,
      typeof error?.code === 'string' ? error.code : '',
      safeMessage || 'EMPTY_SAFE_MESSAGE',
    );
  }
  return json;
}

async function createCatalogSecret(
  name: string,
  options: {
    purpose?: SecretCatalogCreate['purpose'];
    services?: SecretCatalogCreate['services'];
    provider?: SecretCatalogCreate['provider'];
    value?: string;
    keyring?: SecretCatalogKeyring;
  } = {},
) {
  return createSecretInDb(orchDb!, {
    tenantId,
    name: `orv14 ${name} ${randomBytes(3).toString('hex')}`,
    purpose: options.purpose ?? 'connector.credential',
    services: options.services ?? ['connector'],
    provider: options.provider ?? { kind: 'managed_value' },
    ...(options.provider?.kind === 'vault_reference' ? {} : { value: { kind: 'literal' as const, value: options.value ?? `synthetic ${randomUUID()}` } }),
  }, undefined, options.keyring ?? catalogKeyring);
}

async function journalRows(connectorId: string): Promise<number> {
  const result = await orchDb!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM connector_secret_imports WHERE tenant_id=$1 AND connector_id=$2',
    [tenantId, connectorId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function connectorEndpoint(): Promise<string> {
  if (!connectorPort) throw new Error('Connector fixture listener is unavailable');
  return `http://127.0.0.1:${connectorPort}`;
}

beforeAll(async () => {
  assertSafeName(orchIsolation.dbSchema);
  assertSafeName(connectorIsolation.dbSchema);
  baseDb = createDb(pgBase);
  for (const schema of [orchIsolation.dbSchema, connectorIsolation.dbSchema]) {
    const before = await baseDb.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [schema],
    );
    if (before.rows[0]?.exists) throw new Error('unique ORV14 importer schema unexpectedly exists before creation');
    await baseDb.query(`CREATE SCHEMA "${schema}"`);
    if (schema === orchIsolation.dbSchema) schemaCreated = true;
    else connectorSchemaCreated = true;
  }
  orchDb = createDb(orchDatabaseUrl);
  const platformSql = readFileSync(join(process.cwd(), 'orchestrator/services/orchestrator/migrations/0001_platform_v1.sql'), 'utf8');
  const tenantsDdl = platformSql.match(/CREATE TABLE IF NOT EXISTS tenants \([\s\S]*?\n\);/)?.[0];
  if (!tenantsDdl) throw new Error('base tenant DDL could not be read from the canonical migration');
  // Apply only the tenants prerequisite from 0001: the isolated fixture does
  // not need a database-global extension or the rest of the platform schema.
  await orchDb.query(tenantsDdl);
  for (const filename of [
    '0010_admin_audit.sql',
    '0029_audit_actor_principal.sql',
    '0038_secret_catalog.sql',
    '0055_secret_catalog_versions.sql',
    '0060_connector_secret_imports.sql',
  ]) {
    const sql = readFileSync(join(process.cwd(), 'orchestrator/services/orchestrator/migrations', filename), 'utf8');
    await orchDb.query(sql);
  }
  await orchDb.query('INSERT INTO tenants(id,name,state) VALUES($1,$2,\'ACTIVE\'),($3,$4,\'ACTIVE\')', [
    tenantId, 'ORV14 synthetic importer tenant', foreignTenantId, 'ORV14 synthetic foreign tenant',
  ]);
  tracedImporterDb = instrumentCatalogReads(orchDb);

  const mountSnapshot = await vaultOk('GET', 'v1/sys/mounts');
  const authSnapshot = await vaultOk('GET', 'v1/sys/auth');
  const mounts = mountSnapshot.data ?? {};
  const authMounts = authSnapshot.data ?? {};
  if (Object.hasOwn(mounts, `${transitMount}/`) || Object.hasOwn(authMounts, `${approleMount}/`)) {
    throw new Error('unique ORV14 Vault mount unexpectedly existed before creation');
  }
  const kvBefore = await vaultRequest('GET', `v1/secret/metadata/${vaultKvPath}`);
  if (kvBefore.status !== 404) throw new Error('unique ORV14 Connector Vault KV path unexpectedly existed before creation');

  await vaultOk('POST', `v1/sys/mounts/${transitMount}`, { type: 'transit' });
  transitMountOwned = true;
  await vaultOk('POST', `v1/${transitMount}/keys/${transitKeyName}`, { type: 'aes256-gcm96' });
  const transitPolicy = [
    `path "${transitMount}/encrypt/${transitKeyName}" { capabilities = ["update"] }`,
    `path "${transitMount}/decrypt/${transitKeyName}" { capabilities = ["update"] }`,
  ].join('\n');
  await vaultOk('PUT', `v1/sys/policies/acl/${transitPolicyName}`, { policy: transitPolicy });
  transitPolicyOwned = true;
  transitEncryptToken = await createVaultIdentity(transitPolicyName);
  transitDecryptToken = await createVaultIdentity(transitPolicyName);
  const transitProvider = new VaultTransitProvider({
    vaultAddress,
    transitMount,
    allowedKeyRefs: { [metadataKeyRef]: transitKeyName },
    encryptIdentity: { token: () => transitEncryptToken },
    decryptIdentity: { token: () => transitDecryptToken },
  });
  metadataCrypto = createMetadataCrypto(adaptKeyProviderForMetadata(transitProvider), metadataKeyRef);

  await vaultOk('POST', `v1/sys/auth/${approleMount}`, { type: 'approle' });
  approleMountOwned = true;
  const approlePolicy = [
    `path "secret/data/${vaultKvPath}" { capabilities = ["create", "update", "read"] }`,
    `path "secret/metadata/${vaultKvPath}" { capabilities = ["read"] }`,
  ].join('\n');
  await vaultOk('PUT', `v1/sys/policies/acl/${approlePolicyName}`, { policy: approlePolicy });
  approlePolicyOwned = true;
  await vaultOk('POST', `v1/auth/${approleMount}/role/${approleName}`, {
    token_policies: [approlePolicyName],
    token_no_default_policy: true,
    token_ttl: '30m',
    token_max_ttl: '30m',
    secret_id_ttl: '30m',
    secret_id_num_uses: 5,
  });
  const roleIdResponse = await vaultOk('GET', `v1/auth/${approleMount}/role/${approleName}/role-id`);
  const roleId = roleIdResponse.data?.role_id;
  const secretIdResponse = await vaultOk('POST', `v1/auth/${approleMount}/role/${approleName}/secret-id`, {});
  const secretId = secretIdResponse.data?.secret_id;
  if (typeof roleId !== 'string' || typeof secretId !== 'string') throw new Error('isolated AppRole did not issue service credentials');

  const { createConnectorVaultRuntime } = await import('../../../orchestrator/services/connector/src/vault/runtime');
  vaultRuntime = createConnectorVaultRuntime({
    address: vaultAddress,
    roleId,
    secretId,
    authMountPath: approleMount,
    scopes: [{ mount: 'secret', pathPrefix: 'du/tenants' }],
    daemon: { safetyMarginMs: 5_000, minLeadMs: 1_000 },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/secret/data/${vaultKvPath}` && init?.method === 'POST') {
        kvWritePosts += 1;
        kvMetadataPathOwned = true;
      }
      return fetch(input, init);
    },
  });
  const actualCurrentVersion = vaultRuntime.secretWriter.currentVersion.bind(vaultRuntime.secretWriter);
  const actualWritePlanned = vaultRuntime.secretWriter.writePlanned.bind(vaultRuntime.secretWriter);
  vaultRuntime.secretWriter.currentVersion = async (input) => {
    const parsed = VaultKv2RefSchema.safeParse({ ...input, version: 1 });
    lastVaultDestinationValidation = parsed.success
      ? 'valid'
      : parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`).join(',').slice(0, 240);
    return actualCurrentVersion(input);
  };
  vaultRuntime.secretWriter.writePlanned = async (plan, secret) => {
    const parsed = VaultKv2RefSchema.safeParse({
      account: plan.account,
      mount: plan.mount,
      path: plan.path,
      key: plan.key,
      version: plan.targetVersion,
    });
    lastVaultWritePlanValidation = `${parsed.success ? 'valid' : parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`).join(',').slice(0, 240)};keys=${Object.keys(plan).sort().join(',')}`;
    return actualWritePlanned(plan, secret);
  };

  managementAuth = createConnectorManagementAuthorizationProvider(connectorServiceSecret);
  const invocationConfig = parseLocalInvocationKekConfig(JSON.stringify({
    keyRef: `orv14-vfy-connector-${randomBytes(5).toString('hex')}`,
    activeVersion: 1,
    keys: { '1': invocationKek.toString('base64') },
  }));
  if (!invocationConfig) throw new Error('synthetic invocation key config was not parsed');
  const probe = await import('node:net');
  const addressProbe = probe.createServer();
  await new Promise<void>((resolve, reject) => {
    addressProbe.once('error', reject);
    addressProbe.listen(0, '127.0.0.1', resolve);
  });
  connectorPort = (addressProbe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => addressProbe.close((error) => error ? reject(error) : resolve()));
  connectorComposition = createConnectorComposition({
    port: connectorPort,
    host: '127.0.0.1',
    databaseUrl: connectorDatabaseUrl,
    redisUrl: scopedRedisUrl,
    redisKeyPrefix: connectorIsolation.redisPrefix,
    migrationDirectory: join(process.cwd(), 'orchestrator/services/connector/src/db/migrations'),
    drainTimeoutMs: 2_000,
    serviceIdentityVerifier: new HmacServiceIdentityVerifier(connectorServiceSecret),
    grantVerifier: new ContractSignedGrantVerifier(new HmacSignedGrantSource(invocationGrantSecret)),
    credentialCipher: new AesCredentialCipher(randomBytes(32)),
    invocationStorageCrypto: {
      fieldCrypto: createInvocationFieldCrypto(createLocalInvocationKekProvider(invocationConfig), invocationConfig.keyRef),
    },
    vaultRuntime,
    providerAllowHosts: ['provider.synthetic.invalid'],
  });
  await connectorComposition.start();
  started = true;
  connectorPort = (connectorComposition.address() as { port: number }).port;
  if (!connectorPort) throw new Error('Connector listener did not bind an ephemeral port');
  connectorReadDb = createDb(connectorDatabaseUrl);

  console.log('ORV14 importer fixture namespace', JSON.stringify({
    runSuffix,
    orchestratorSchema: orchIsolation.dbSchema,
    connectorSchema: connectorIsolation.dbSchema,
    redisDb: connectorIsolation.redisDbIndex,
    redisPrefix: connectorIsolation.redisPrefix,
    queuePrefix: connectorIsolation.queuePrefix,
    connectorPort,
    vaultKvPath,
    transitMount,
    transitPolicyName,
    approleMount,
    approlePolicyName,
    approleName,
  }));

  originalSecretEntry = await createCatalogSecret('original', { value: catalogSecret });
  originalSecretId = originalSecretEntry.secretId;
  importer = makeImporter();
});

afterAll(async () => {
  const cleanupErrors: string[] = [];
  if (vaultRuntime?.daemon.current()) approleClientToken = vaultRuntime.daemon.current()!.value;
  vaultRuntime?.stop();
  try {
    await connectorComposition?.shutdown({ timeoutMs: 0 });
    started = false;
  } catch { cleanupErrors.push('Connector shutdown failed'); }
  try { await orchDb?.close(); } catch { cleanupErrors.push('Orchestrator pool close failed'); }
  try { await connectorReadDb?.close(); } catch { cleanupErrors.push('Connector evidence pool close failed'); }

  if (approleClientToken) {
    try {
      const revoked = await vaultRequest('POST', 'v1/auth/token/revoke', { token: approleClientToken });
      if (revoked.status < 200 || revoked.status >= 300) cleanupErrors.push('AppRole token revoke returned non-success');
    }
    catch { cleanupErrors.push('AppRole token revoke failed'); }
  }
  for (const token of [transitEncryptToken, transitDecryptToken]) {
    if (!token) continue;
    try {
      const revoked = await vaultRequest('POST', 'v1/auth/token/revoke', { token });
      if (revoked.status < 200 || revoked.status >= 300) cleanupErrors.push('Transit token revoke returned non-success');
    }
    catch { cleanupErrors.push('Transit token revoke failed'); }
  }
  if (kvMetadataPathOwned) {
    try {
      const removed = await vaultRequest('DELETE', `v1/secret/metadata/${vaultKvPath}`);
      if (![204, 404].includes(removed.status)) cleanupErrors.push('owned KV path delete returned non-success');
      const absent = await vaultRequest('GET', `v1/secret/metadata/${vaultKvPath}`);
      if (absent.status !== 404) cleanupErrors.push('owned KV path absence check failed');
    } catch { cleanupErrors.push('owned KV path cleanup failed'); }
  }
  if (approleMountOwned) {
    try {
      const removed = await vaultRequest('DELETE', `v1/sys/auth/${approleMount}`);
      if (removed.status !== 204) cleanupErrors.push('owned AppRole mount delete returned non-success');
      const remaining = await vaultOk('GET', 'v1/sys/auth');
      if (Object.hasOwn(remaining.data ?? {}, `${approleMount}/`)) cleanupErrors.push('owned AppRole mount remains after deletion');
    }
    catch { cleanupErrors.push('owned AppRole mount cleanup failed'); }
  }
  if (transitMountOwned) {
    try {
      const removed = await vaultRequest('DELETE', `v1/sys/mounts/${transitMount}`);
      if (removed.status !== 204) cleanupErrors.push('owned Transit mount delete returned non-success');
      const remaining = await vaultOk('GET', 'v1/sys/mounts');
      if (Object.hasOwn(remaining.data ?? {}, `${transitMount}/`)) cleanupErrors.push('owned Transit mount remains after deletion');
    }
    catch { cleanupErrors.push('owned Transit mount cleanup failed'); }
  }
  if (approlePolicyOwned) {
    try {
      const removed = await vaultRequest('DELETE', `v1/sys/policies/acl/${approlePolicyName}`);
      if (removed.status !== 204) cleanupErrors.push('owned AppRole policy delete returned non-success');
    }
    catch { cleanupErrors.push('owned AppRole policy cleanup failed'); }
  }
  if (transitPolicyOwned) {
    try {
      const removed = await vaultRequest('DELETE', `v1/sys/policies/acl/${transitPolicyName}`);
      if (removed.status !== 204) cleanupErrors.push('owned Transit policy delete returned non-success');
    }
    catch { cleanupErrors.push('owned Transit policy cleanup failed'); }
  }
  if (baseDb) {
    for (const [schema, owned] of [[orchIsolation.dbSchema, schemaCreated], [connectorIsolation.dbSchema, connectorSchemaCreated]] as const) {
      if (!owned) continue;
      try {
        await baseDb.query(`DROP SCHEMA "${schema}" CASCADE`);
        const remaining = await baseDb.query<{ exists: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [schema],
        );
        if (remaining.rows[0]?.exists) cleanupErrors.push('owned PostgreSQL schema still exists');
      } catch { cleanupErrors.push('owned PostgreSQL schema cleanup failed'); }
    }
  }
  try { await baseDb?.close(); } catch { cleanupErrors.push('base pool close failed'); }
  orchIsolation.cleanupArtifactDir();
  connectorIsolation.cleanupArtifactDir();
  if (cleanupErrors.length > 0) throw new Error(`ORV14 importer fixture cleanup incomplete: ${cleanupErrors.join('; ')}`);
});

describe('ORV14 Secret Catalog importer with real PostgreSQL, Vault Transit, KV v2, and Connector HTTP', () => {
  test('durably seals before Connector, recovers a lost acknowledgement from the pinned Catalog revision, and writes one KV v2 version', async () => {
    const idempotencyKey = `orv14-vfy-lost-ack-${randomUUID()}`;
    const request = importRequest({ secretId: originalSecretId, idempotencyKey });
    const firstCatalogReadCount = catalogReadCount;

    let lostAckResponse: unknown;
    try { await importer.importCredential(vaultConnectorId, request, actor); }
    catch (error) { lostAckResponse = error; }
    expect(lostAckResponse).toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    if (!injectedLostAck) throw new Error(`lost-ack boundary not reached; Connector upsert=${lastUpsertFailure}; current-version schema=${lastVaultDestinationValidation}; write-plan schema=${lastVaultWritePlanValidation}; Vault KV POST count=${kvWritePosts}`);
    expect(injectedLostAck).toBe(true);
    expect(catalogReadCount).toBe(firstCatalogReadCount + 1);
    expect(kvWritePosts).toBe(1);
    kvMetadataPathOwned = true;

    const journal = await orchDb!.query<{
      import_id: string;
      state: string;
      source_revision: number;
      source_key_version: string;
      resolved_payload: SealedMetadata;
      result: unknown;
    }>(
      `SELECT import_id,state,source_revision,source_key_version,resolved_payload,result
         FROM connector_secret_imports WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3`,
      [tenantId, vaultConnectorId, idempotencyKey],
    );
    expect(journal.rowCount).toBe(1);
    const pending = journal.rows[0]!;
    expect(pending).toMatchObject({ state: 'PENDING', source_revision: 1, source_key_version: 'catalog-key-v1', result: null });
    const envelopeJson = JSON.stringify(pending.resolved_payload);
    expect(envelopeJson.includes(catalogSecret)).toBe(false);
    const opened = await metadataCrypto.open(pending.resolved_payload, {
      tenantId,
      slot: 'connector_secret_imports.resolved_payload',
      refId: pending.import_id,
    }) as Record<string, any>;
    expect(digest(opened.credentialChange.secret)).toBe(digest(catalogSecret));
    expect(opened.tenantId).toBe(tenantId);
    expect(opened.connectorId).toBe(vaultConnectorId);
    expect(opened.expectedHeadRevision).toBe(0);
    expect(opened.idempotencyKey).toBe(idempotencyKey);
    expect(opened.credentialImportSource).toEqual({ catalogVersionRef: `${originalSecretId}@1`, catalogKeyVersion: 'catalog-key-v1' });
    await expect(metadataCrypto.open(pending.resolved_payload, {
      tenantId: foreignTenantId,
      slot: 'connector_secret_imports.resolved_payload',
      refId: pending.import_id,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

    await rotateSecretInDb(orchDb!, originalSecretId, {
      secretId: originalSecretId,
      expectedRevision: 1,
      value: { kind: 'literal', value: rotatedSecret },
    }, undefined, catalogKeyring);
    const currentCatalog = await orchDb!.query<{ revision: number }>('SELECT revision FROM secret_catalog WHERE secret_id=$1', [originalSecretId]);
    expect(currentCatalog.rows[0]?.revision).toBe(2);

    const result = await importer.importCredential(vaultConnectorId, request, actor);
    expect(result).toMatchObject({
      expectedHeadRevision: 0,
      revision: { tenantId, connectorId: vaultConnectorId, revision: 1, state: 'PENDING', expectedHeadRevision: 0, credentialVersion: 1 },
    });
    expect(/^recipe-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.revision.credentialRef ?? '')).toBe(true);
    expect(JSON.stringify(result).includes(catalogSecret)).toBe(false);
    expect(JSON.stringify(result).includes(rotatedSecret)).toBe(false);
    expect(catalogReadCount).toBe(firstCatalogReadCount + 1);
    expect(kvWritePosts).toBe(1);
    expect(claimRequestCount).toBeGreaterThanOrEqual(2);
    expect(draftRequestCount).toBe(2);

    const completed = await orchDb!.query<{ state: string; source_revision: number; source_key_version: string; resolved_payload: unknown; result: unknown }>(
      `SELECT state,source_revision,source_key_version,resolved_payload,result
         FROM connector_secret_imports WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3`,
      [tenantId, vaultConnectorId, idempotencyKey],
    );
    expect(completed.rows[0]).toMatchObject({ state: 'COMPLETED', source_revision: 1, source_key_version: 'catalog-key-v1' });
    expect(JSON.stringify(completed.rows[0]?.resolved_payload).includes(catalogSecret)).toBe(false);
    expect(JSON.stringify(completed.rows[0]?.result).includes(catalogSecret)).toBe(false);
    expect(JSON.stringify(completed.rows[0]?.result).includes(rotatedSecret)).toBe(false);

    const connectorRevision = await connectorComposition!.dependencies.parityManagement!.getRevision(tenantId, vaultConnectorId, 1);
    expect(connectorRevision).toMatchObject({
      tenantId,
      connectorId: vaultConnectorId,
      revision: 1,
      state: 'PENDING',
      credentialRef: result.revision.credentialRef,
      credentialVersion: 1,
    });
    const storedPin = await connectorComposition!.dependencies.parityManagement!.getRuntimeRevision(tenantId, vaultConnectorId, 1);
    expect(storedPin?.credentialSource).toMatchObject({ mount: 'secret', path: vaultKvPath, account: 'recipe', version: 1 });
    expect(storedPin?.credentialRef).toBe(result.revision.credentialRef);

    const targetCredentialKey = storedPin?.credentialSource?.key;
    if (!targetCredentialKey) throw new Error('Connector revision omitted its opaque KV v2 field pin');
    const kvData = await vaultRequest('GET', `v1/secret/data/${vaultKvPath}?version=1`);
    expect(kvData.status).toBe(200);
    const values = (kvData.json.data?.data ?? {}) as Record<string, unknown>;
    expect(typeof values[targetCredentialKey]).toBe('string');
    expect(digest(String(values[targetCredentialKey]))).toBe(digest(catalogSecret));
    expect(digest(String(values[targetCredentialKey]))).not.toBe(digest(rotatedSecret));

    const exactRevision = await connectorManagementCall(
      'GET',
      `/internal/admin/connector-revisions/${encodeURIComponent(vaultConnectorId)}/1?tenantId=${encodeURIComponent(tenantId)}`,
    ) as Record<string, any>;
    expect(exactRevision).toMatchObject({ tenantId, connectorId: vaultConnectorId, revision: 1, credentialRef: result.revision.credentialRef });
    expect(JSON.stringify(exactRevision).includes(catalogSecret)).toBe(false);
    await expect(connectorManagementCall(
      'GET',
      `/internal/admin/connector-revisions/${encodeURIComponent(vaultConnectorId)}/1?tenantId=${encodeURIComponent(foreignTenantId)}`,
    )).rejects.toMatchObject({ status: 404 });

    const completedReadCount = catalogReadCount;
    const completedReplay = await importer.importCredential(vaultConnectorId, request, actor);
    expect(completedReplay.revision.credentialRef).toBe(result.revision.credentialRef);
    expect(catalogReadCount).toBe(completedReadCount);
    expect(kvWritePosts).toBe(1);

    const changedRequest = importRequest({
      secretId: originalSecretId,
      idempotencyKey,
      recipe: { ...recipe(), timeoutMs: 5_000 },
    });
    await expect(importer.importCredential(vaultConnectorId, changedRequest, actor)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(kvWritePosts).toBe(1);
    expect(await journalRows(vaultConnectorId)).toBe(1);
  });

  test('rejects invalid scope, purpose, provider, state, key version, and current role before creating an import journal', async () => {
    const directConnectorId = `orv14-${randomBytes(5).toString('hex')}`;
    const unauthenticated = await fetch(
      `${await connectorEndpoint()}/internal/admin/connector-revisions/${directConnectorId}/claim`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, expectedHeadRevision: 0, idempotencyKey: `orv14-vfy-${randomUUID()}` }) },
    );
    expect(unauthenticated.status).toBe(401);
    const wrongScope = await fetch(
      `${await connectorEndpoint()}/internal/admin/connector-revisions/${directConnectorId}/claim`,
      {
        method: 'POST',
        headers: { authorization: managementAuth('connector:manage'), 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, expectedHeadRevision: 0, idempotencyKey: `orv14-vfy-${randomUUID()}` }),
      },
    );
    expect(wrongScope.status).toBe(403);
    const noSideEffect = await connectorReadDb!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM connector_parity_claim_intents WHERE connector_id=$1', [directConnectorId],
    );
    expect(noSideEffect.rows[0]?.count).toBe('0');

    const claimCountBeforeNoCrypto = claimRequestCount;
    const noCryptoImporter = makeImporter({ disableCrypto: true });
    await expect(noCryptoImporter.importCredential(`orv14-${randomBytes(5).toString('hex')}`, importRequest({ secretId: originalSecretId }), actor))
      .rejects.toMatchObject({ status: 503, code: 'METADATA_ENCRYPTION_REQUIRED' });
    expect(claimRequestCount).toBe(claimCountBeforeNoCrypto);

    const roleDeniedId = `orv14-${randomBytes(5).toString('hex')}`;
    await expect(importer.importCredential(
      roleDeniedId,
      importRequest({ secretId: originalSecretId }),
      { actor: 'viewer-session', role: 'viewer' } as unknown as ConnectorSecretImportActor,
    )).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(await journalRows(roleDeniedId)).toBe(0);

    const beforeForeignCatalogReads = catalogReadCount;
    await expect(importer.importCredential(
      vaultConnectorId,
      importRequest({ tenantId: foreignTenantId, secretId: originalSecretId, idempotencyKey: `orv14-vfy-foreign-${randomUUID()}` }),
      actor,
    )).rejects.toMatchObject({ status: 409, code: 'CONNECTOR_SCOPE_CONFLICT' });
    expect(catalogReadCount).toBe(beforeForeignCatalogReads);

    const wrongPurpose = await createCatalogSecret('wrong-purpose', { purpose: 'generic', value: `purpose ${randomUUID()}` });
    const wrongPurposeConnector = `orv14-${randomBytes(5).toString('hex')}`;
    await expect(importer.importCredential(wrongPurposeConnector, importRequest({ secretId: wrongPurpose.secretId }), actor))
      .rejects.toMatchObject({ status: 403, code: 'SECRET_REFERENCE_DENIED' });
    expect(await journalRows(wrongPurposeConnector)).toBe(0);

    const wrongService = await createCatalogSecret('wrong-service', { services: ['orchestrator'], value: `service ${randomUUID()}` });
    const wrongServiceConnector = `orv14-${randomBytes(5).toString('hex')}`;
    await expect(importer.importCredential(wrongServiceConnector, importRequest({ secretId: wrongService.secretId }), actor))
      .rejects.toMatchObject({ status: 403, code: 'SECRET_REFERENCE_DENIED' });
    expect(await journalRows(wrongServiceConnector)).toBe(0);

    const vaultReference = await createCatalogSecret('vault-reference', {
      provider: {
        kind: 'vault_reference',
        connectionId: `orv14-vfy-${randomBytes(4).toString('hex')}`,
        mount: 'secret',
        path: `du/tenants/${tenantId}/external`,
        field: 'token',
        version: { mode: 'latest' },
      },
    });
    const vaultReferenceConnector = `orv14-${randomBytes(5).toString('hex')}`;
    await expect(importer.importCredential(vaultReferenceConnector, importRequest({ secretId: vaultReference.secretId }), actor))
      .rejects.toMatchObject({ status: 403, code: 'SECRET_REFERENCE_DENIED' });
    expect(await journalRows(vaultReferenceConnector)).toBe(0);

    const disabled = await createCatalogSecret('disabled', { value: `disabled ${randomUUID()}` });
    await disableSecretInDb(orchDb!, disabled.secretId, { secretId: disabled.secretId, expectedRevision: 1, reason: 'synthetic importer denial fixture' });
    const disabledConnector = `orv14-${randomBytes(5).toString('hex')}`;
    await expect(importer.importCredential(disabledConnector, importRequest({ secretId: disabled.secretId }), actor))
      .rejects.toMatchObject({ status: 403, code: 'SECRET_REFERENCE_DENIED' });
    expect(await journalRows(disabledConnector)).toBe(0);

    const missingVersionKeyring: SecretCatalogKeyring = { activeVersion: 'catalog-key-v2', keys: { 'catalog-key-v2': catalogKeyV2 } };
    const missingVersionSecret = await createCatalogSecret('missing-key-version', {
      value: `exact key version ${randomUUID()}`,
      keyring: missingVersionKeyring,
    });
    const missingVersionConnector = `orv14-${randomBytes(5).toString('hex')}`;
    await expect(makeImporter({ keyring: { activeVersion: 'catalog-key-v1', keys: { 'catalog-key-v1': catalogKeyV1 } } })
      .importCredential(missingVersionConnector, importRequest({ secretId: missingVersionSecret.secretId }), actor))
      .rejects.toMatchObject({ status: 503, code: 'SECRET_KEY_VERSION_UNAVAILABLE' });
    expect(await journalRows(missingVersionConnector)).toBe(0);
  });
});
