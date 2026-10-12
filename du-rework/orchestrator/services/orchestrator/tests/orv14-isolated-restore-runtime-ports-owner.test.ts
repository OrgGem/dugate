import {
  createTrustedIsolatedRestoreRuntimePorts,
  metadataRecoveryRefId,
  verifyNftPolicy,
} from '../src/modules/maintenance/trusted-isolated-restore-runtime-ports';
import type { RestoreSourceRef } from '../src/modules/maintenance/trusted-isolated-restore-probe';
import { createMetadataCrypto, type MetadataContext, type MetadataWrappedDek } from '../src/modules/runtime/metadata-crypto';

const refs = [
  'orchestratorSourceDb', 'connectorSourceDb', 'sourceCatalogKeyring', 'sourceConnectorRecoveryRegistry',
  'sourceMetadataTransit', 'sourceArtifactTransit', 'sourceVault',
] as const satisfies readonly RestoreSourceRef[];

const sourceEndpoints = Object.fromEntries(refs.map((ref, index) => [ref, {
  host: `198.51.100.${index + 10}`,
  port: index < 2 ? 5432 : 8200 + index,
}])) as Record<RestoreSourceRef, { host: string; port: number }>;
const sourceRuleIds = Object.fromEntries(refs.map((ref) => [ref, `deny-${ref}`])) as Record<RestoreSourceRef, string>;
const sourcePolicy = { sourceEndpoints, networkPolicy: { sourceRuleIds } };

function nftMatch(protocol: 'ip' | 'ip6' | 'tcp', field: 'daddr' | 'dport', right: string | number) {
  return { match: { op: '==', left: { payload: { protocol, field } }, right } };
}

function denyRule(ref: RestoreSourceRef) {
  const endpoint = sourceEndpoints[ref];
  return {
    family: 'inet', table: 'du_restore', chain: 'output', comment: sourceRuleIds[ref],
    expr: [
      nftMatch('ip', 'daddr', endpoint.host),
      { match: { op: '==', left: { meta: { key: 'l4proto' } }, right: 'tcp' } },
      nftMatch('tcp', 'dport', endpoint.port),
      { drop: null },
    ],
  };
}

function observation(extraRules: unknown[] = []) {
  return { nftables: [
    { chain: { family: 'inet', table: 'du_restore', name: 'output', hook: 'output', policy: 'drop' } },
    ...refs.map((ref) => ({ rule: denyRule(ref) })),
    ...extraRules.map((rule) => ({ rule })),
  ] };
}

describe('ORV14 isolated restore concrete runtime ports owner checks', () => {
  test('accepts native nft JSON only when the target output chain drops by default and has each exact source deny', () => {
    expect(() => verifyNftPolicy(observation(), sourcePolicy)).not.toThrow();
  });

  test('rejects a source comment whose rule does not match the exact pinned address and port', () => {
    const rules = refs.map((ref) => denyRule(ref));
    rules[0] = { ...rules[0]!, expr: [...rules[0]!.expr.slice(0, 2), nftMatch('tcp', 'dport', 5433), { drop: null }] };
    const value = { nftables: [
      { chain: { family: 'inet', table: 'du_restore', name: 'output', hook: 'output', policy: 'drop' } },
      ...rules.map((rule) => ({ rule })),
    ] };

    expect(() => verifyNftPolicy(value, sourcePolicy)).toThrow('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  });

  test('rejects broad accepts and accepts to a pinned source host even on a different port', () => {
    const broadAccept = {
      family: 'inet', table: 'du_restore', chain: 'output',
      expr: [
        { match: { op: '==', left: { meta: { key: 'l4proto' } }, right: 'tcp' } },
        nftMatch('tcp', 'dport', 443), { accept: null },
      ],
    };
    expect(() => verifyNftPolicy(observation([broadAccept]), sourcePolicy))
      .toThrow('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');

    const sourceAccept = {
      family: 'inet', table: 'du_restore', chain: 'output',
      expr: [
        nftMatch('ip', 'daddr', sourceEndpoints.sourceVault.host),
        { match: { op: '==', left: { meta: { key: 'l4proto' } }, right: 'tcp' } },
        nftMatch('tcp', 'dport', 443), { accept: null },
      ],
    };
    expect(() => verifyNftPolicy(observation([sourceAccept]), sourcePolicy))
      .toThrow('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  });

  test('constructs concrete launch, health, control, source, DB, application, and independent recovery ports', () => {
    const ports = createTrustedIsolatedRestoreRuntimePorts({
      manifestPath: '/etc/dugate/maintenance.json',
      expectedManifestSha256: 'a'.repeat(64),
    });

    expect(typeof ports.launch.start).toBe('function');
    expect(typeof ports.launch.stopAndWait).toBe('function');
    expect(typeof ports.health.observeOrchestrator).toBe('function');
    expect(typeof ports.health.observeConnector).toBe('function');
    expect(typeof ports.databaseReader.readCounts).toBe('function');
    expect(typeof ports.sourceIsolation.probeFromRuntime).toBe('function');
    expect(typeof ports.applicationReader.exerciseLoginAndHistory).toBe('function');
    expect(typeof ports.applicationReader.selectArtifactForDownload).toBe('function');
    expect(typeof ports.applicationReader.downloadArtifact).toBe('function');
    expect(typeof ports.recoveryReader.recoverArtifactTransitKey).toBe('function');
    expect(typeof ports.recoveryReader.recoverSecretCatalogKey).toBe('function');
    expect(typeof ports.recoveryReader.recoverConnectorInvocationKey).toBe('function');
    expect(typeof ports.recoveryReader.recoverConnectorCredentialKey).toBe('function');
    expect(typeof ports.recoveryReader.recoverMetadataTransitKey).toBe('function');
    expect(typeof ports.recoveryReader.readVaultCredential).toBe('function');
  });

  test('fails closed for a missing or malformed trusted manifest digest', () => {
    expect(() => createTrustedIsolatedRestoreRuntimePorts(undefined as never))
      .toThrow('RESTORE_RUNTIME_MANIFEST_REQUIRED');
    expect(() => createTrustedIsolatedRestoreRuntimePorts({
      manifestPath: '/etc/dugate/maintenance.json', expectedManifestSha256: 'bad',
    })).toThrow('RESTORE_RUNTIME_MANIFEST_REQUIRED');
  });

  test('opens wrapped metadata fixtures only with the producer AAD identity for every stored slot', async () => {
    const wrappedDeks = new Map<string, Buffer>();
    let sequence = 0;
    const provider = {
      async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<MetadataWrappedDek> {
        const wrappedKey = `fixture-dek-${sequence++}`;
        wrappedDeks.set(wrappedKey, Buffer.from(dek));
        return { version: 1, keyName: keyRef, keyVersion: keyVersion ?? 3, wrappedKey };
      },
      async unwrapDek(wrapped: MetadataWrappedDek): Promise<Buffer> {
        const dek = wrappedDeks.get(wrapped.wrappedKey);
        if (!dek) throw new Error('unknown fixture wrapped DEK');
        return Buffer.from(dek);
      },
    };
    const crypto = createMetadataCrypto(provider, 'metadata-test-key');
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const cases: Array<{ slot: MetadataContext['slot']; storedRefId: string; expectedRefId: string }> = [
      { slot: 'operations.input_ref', storedRefId: 'operation-a', expectedRefId: 'operation-a' },
      { slot: 'tasks.payload_ref', storedRefId: 'task-a', expectedRefId: 'task-a' },
      { slot: 'human_waits.response_ref', storedRefId: 'wait-a', expectedRefId: 'wait-a' },
      { slot: 'step_checkpoints.output_ref', storedRefId: 'task-a:render', expectedRefId: 'task-a:render' },
      { slot: 'step_checkpoints.session_ref', storedRefId: 'task-a:render:4', expectedRefId: 'task-a:render:4' },
      { slot: 'operations.prompt_overrides_ref', storedRefId: 'operation-a', expectedRefId: 'operation-a' },
      { slot: 'tasks.result_ref', storedRefId: 'task-a', expectedRefId: 'task-a' },
      { slot: 'operations.result_ref', storedRefId: 'operation-a', expectedRefId: 'operation-a' },
      { slot: 'legacy_workflow_schemas.schema_ref', storedRefId: 'invoice-v2:8', expectedRefId: 'invoice-v2:8' },
      { slot: 'settings_revisions.payload_ref', storedRefId: 'global-models:5', expectedRefId: 'global-models:5' },
      { slot: 'connector_prompt_overrides.prompt_override', storedRefId: '["connection-a", "api-key-a", "extract", "classify"]',
        expectedRefId: '["connection-a","api-key-a","extract","classify"]' },
      { slot: 'global_settings.tenant_revision', storedRefId: `${tenantId}:providers:7`, expectedRefId: `${tenantId}:providers:7` },
      { slot: 'operations.tenant_defaults_ref', storedRefId: 'operation-a', expectedRefId: 'operation-a' },
      { slot: 'operations.connector_recipe_pins_ref', storedRefId: 'operation-a', expectedRefId: 'operation-a' },
      { slot: 'connector_secret_imports.resolved_payload', storedRefId: 'import-a', expectedRefId: 'import-a' },
    ];

    try {
      for (const [index, item] of cases.entries()) {
        const context: MetadataContext = { tenantId, slot: item.slot, refId: item.expectedRefId };
        const value = { fixtureIndex: index, slot: item.slot };
        const envelope = await crypto.seal(value, context, { keyVersion: 3 });
        const recoveredRefId = metadataRecoveryRefId(item.slot, item.storedRefId);
        expect(recoveredRefId).toBe(item.expectedRefId);
        await expect(crypto.open(envelope, { ...context, refId: recoveredRefId })).resolves.toEqual(value);
        await expect(crypto.open(envelope, { ...context, refId: `${recoveredRefId}:wrong-row` }))
          .rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
      }
      expect(() => metadataRecoveryRefId('connector_prompt_overrides.prompt_override', 'not-json'))
        .toThrow('RESTORE_METADATA_CONTEXT_INVALID');
    } finally {
      for (const dek of wrappedDeks.values()) dek.fill(0);
    }
  });
});
