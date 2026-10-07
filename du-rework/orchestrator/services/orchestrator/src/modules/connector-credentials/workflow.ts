import { HttpError, conflict, notFound, unavailable } from '../../http/errors';
import {
  ConnectorCredentialSourceSchema,
  ConnectorRevisionBindingSchema,
  matchesVaultAccountPath,
  VaultKv2RefSchema,
  type ConnectorCredentialSource,
  type VaultCredentialSource,
} from '@du/contracts';

/**
 * VAULT-03 (tasks/SEC-OIDC-VAULT-2026-09-24.md, SEC-04): the Admin write-only
 * credential workflow for provider keys — Vault KV v2 CAS write → PENDING
 * revision pin → idempotent activation, with safe reconcile.
 *
 * Ordering is the safety property (SEC-04): the Vault version is written
 * FIRST (CAS-guarded), only then does a PENDING revision pin it, and only an
 * explicit activation (expected-current guard) makes it routable. Consequences:
 *   - a crash AFTER the vault write but BEFORE createPending leaves an orphan
 *     vault version that NOTHING references — harmless, never routable;
 *   - a crash AFTER createPending leaves PENDING — PENDING is never routable
 *     (the connector refuses state !== 'ACTIVE'); reconcile retries activation
 *     or retires the row, and no half-committed ref can serve an invocation;
 *   - a concurrent activation wins only ONE ACTIVE slot (expectedCurrent CAS)
 *     and every loser keeps its revision PENDING with an explicit
 *     reconcileRequired result — never a second ACTIVE revision.
 *
 * Secrets are write-only through this seam: requests carry `value`, every
 * response and audit detail is the MASKED projection (mount/path/key/version/
 * hasValue), and the workflow itself never logs or stores plaintext.
 */

export interface VaultRefFields {
  account: string;
  mount: string;
  path: string;
  key: string;
}

export interface VaultCredentialWriter {
  /** KV v2 CAS write; resolves to the NEW version. Rejects with {code, retryable}. */
  writeCas(ref: VaultRefFields, value: string, cas?: number): Promise<number>;
  /** Metadata read (never values) for the masked GET surface. */
  readVersions(ref: VaultRefFields): Promise<{ current_version: number; versions: number[] }>;
}

export type PinnedSource = VaultCredentialSource;

export interface RevisionRow {
  revision: number;
  adapter: string;
  state: 'PENDING' | 'ACTIVE' | 'RETIRED';
  credentialSource: ConnectorCredentialSource;
  /** Migration 008 trusted ownership columns; never sourced from rotate input. */
  tenantId?: string;
  accountId?: string;
}

export interface ConnectorRevisionStore {
  /**
   * W-VAULT-LEGACY-TRANSITION-1: optional chain selector. Absent/empty =
   * the unbound legacy chain (wire-compatible pre-binding behavior); a
   * named tenant selects ONLY that tenant chain. The selector is always a
   * trusted platform coordinate, never caller input.
   */
  get(connectorId: string, scope?: { tenantId?: string }): Promise<RevisionRow | undefined>;
  /** Create revision current+1 pinned to source, state PENDING, copied adapter/config. */
  createPending(connectorId: string, source: PinnedSource): Promise<RevisionRow>;
  /**
   * W-VAULT-LEGACY-TRANSITION-1: atomically bootstrap the BOUND chain from
   * a legacy unbound revision - the only store operation allowed to create
   * an ACTIVE first revision (there is no prior row to CAS against).
   * Optional by design: a store without it makes rotate() fail CLOSED with
   * 501 after the vault write, never a half-bound chain.
   */
  bootstrap?(connectorId: string, source: PinnedSource): Promise<RevisionRow>;
  /**
   * CAS activation: succeed only while the ACTIVE revision still equals
   * expectedCurrentRevision; otherwise leave state untouched and return false.
   */
  activate(connectorId: string, revision: number, expectedCurrentRevision: number): Promise<boolean>;
  /** Reconcile support: retire a stranded PENDING (crash-recovery path). */
  retire(connectorId: string, revision: number): Promise<void>;
  /**
   * VAULT-04 emergency revoke: RETIRE every row of the connector (the
   * connector's disable semantics). Optional — stores without it make
   * revoke() fail closed with 501, never a partial revoke.
   */
  revokeAll?(connectorId: string): Promise<void>;
}

export interface CredentialAuditSink {
  record(event: { action: string; resource: string; detail: Record<string, unknown> }): Promise<void>;
}

/**
 * W-VAULT-LEGACY-TRANSITION-1: the platform-declared FIRST binding for a
 * connector whose stored revision is still the legacy unbound (tenant_id
 * '', credential_source kind 'legacy-db') row. SEC-04 keeps the invariant 'a
 * Vault ref cannot establish its own tenant/account': the only legitimate
 * source of those coordinates is platform configuration (compose/deploy
 * wiring), validated at construction time, never a rotate request field.
 */
export interface TrustedInitialBinding {
  tenantId: string;
  accountId: string;
}

export interface IdempotencyPort {
  lookup(key: string): Promise<{ payloadHash: string; result: CredentialWorkflowResult } | undefined>;
  store(key: string, payloadHash: string, result: CredentialWorkflowResult): Promise<void>;
}

export interface RotateInput {
  connectorId: string;
  ref: VaultRefFields;
  value: string;
  cas?: number;
  /** Replay guard (route supplies readIdempotencyKey + canonicalPayloadHash). */
  idempotencyKey?: string;
  payloadHash?: string;
}

export interface TrustedConnectorBinding {
  tenantId: string;
  connectorId: string;
  accountId: string;
}

export interface CredentialWorkflowResult {
  connectorId: string;
  revision: number;
  version: number;
  state: 'ACTIVE' | 'PENDING';
  /** Concurrent winner already ACTIVATED a newer chain position. */
  reconcileRequired?: boolean;
  replayed?: boolean;
}

export interface MaskedCredentialMetadata {
  connectorId: string;
  revision: number;
  state: RevisionRow['state'];
  source: { kind: 'vault-kv2'; mount: string; path: string; key: string; pinnedVersion: number; hasValue: true };
  vaultVersions: number[];
  currentVaultVersion: number;
}

function refIssue(err: unknown): never {
  const code = (err as { code?: unknown })?.code;
  const retryable = (err as { retryable?: unknown })?.retryable === true;
  if (code === 'CAS_CONFLICT') throw conflict('VAULT_CAS_CONFLICT', 'Vault check-and-set conflict; no revision was created.');
  if (code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID' || code === 'NO_VAULT_IDENTITY') {
    throw new HttpError(403, 'VAULT_IDENTITY_REJECTED', 'Vault machine identity rejected: ' + String(code));
  }
  if (code === 'CAPABILITY_DENIED' || code === 'PREFIX_DENIED') {
    throw new HttpError(403, 'VAULT_POLICY_DENIED', 'Vault policy denied the write: ' + String(code));
  }
  if (retryable) throw unavailable('vault unavailable; retry the rotation');
  throw new HttpError(502, 'VAULT_WRITE_FAILED', 'Vault write failed: ' + String(code ?? 'unknown'));
}

export function createCredentialWorkflow(deps: {
  vault: VaultCredentialWriter;
  revisions: ConnectorRevisionStore;
  audit?: CredentialAuditSink;
  idempotency?: IdempotencyPort;
  /** connectorId -> platform-declared binding enabling the legacy->bound
   * transition for that connector. Absent entry = rotate stays bound-only
   * (403 BINDING_DENIED on an unbound legacy base), exactly as before. */
  initialBindings?: Record<string, TrustedInitialBinding>;
}) {
  // Fail CLOSED at construction on a malformed platform binding: a typo in
  // deploy config must never surface as a rotation that binds to the wrong
  // tenant at first use.
  for (const [connectorId, declared] of Object.entries(deps.initialBindings ?? {})) {
    if (!ConnectorRevisionBindingSchema.safeParse({
      tenantId: declared.tenantId,
      connectorId,
      accountId: declared.accountId,
    }).success) {
      throw new Error('invalid platform initial binding for connector ' + connectorId);
    }
  }
  const assertRef = (ref: VaultRefFields, connectorId: string): VaultRefFields => {
    const parsed = VaultKv2RefSchema.safeParse({ ...ref });
    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'credential ref is not a valid VaultKv2Ref');
    }
    if (!matchesVaultAccountPath(parsed.data, { connectorId })) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'credential ref is outside the connector account path');
    }
    return ref;
  };

  const run = async (input: RotateInput, replayGuard: boolean): Promise<CredentialWorkflowResult> => {
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'credential value must be a non-empty string (write-only field)');
    }
    // W-VAULT-LEGACY-TRANSITION-1: resolve WHICH chain this rotate extends.
    // Declared platform bindings unlock the legacy->bound transition; with no
    // declaration the behavior is byte-identical to the pre-cycle flow.
    const declared = deps.initialBindings?.[input.connectorId];
    let base: RevisionRow;
    let binding: { tenantId: string; connectorId: string; accountId: string };
    let transition = false;
    if (declared) {
      const bound = await deps.revisions.get(input.connectorId, { tenantId: declared.tenantId });
      if (bound) {
        const parsedBound = ConnectorRevisionBindingSchema.safeParse({
          tenantId: bound.tenantId,
          connectorId: input.connectorId,
          accountId: bound.accountId,
        });
        if (!parsedBound.success) {
          throw new HttpError(403, 'BINDING_DENIED', 'connector ownership binding is unavailable');
        }
        if (parsedBound.data.tenantId !== declared.tenantId || parsedBound.data.accountId !== declared.accountId) {
          // Platform config and the trusted row disagree; rotating under
          // either interpretation could strand the secret in the wrong
          // account. Refuse before any Vault write.
          throw new HttpError(403, 'BINDING_DENIED', 'stored connector binding disagrees with the platform binding');
        }
        base = bound;
        binding = parsedBound.data;
      } else {
        const legacy = await deps.revisions.get(input.connectorId, {});
        if (!legacy) {
          throw notFound(`connector ${input.connectorId} has no revision to extend`);
        }
        if (legacy.credentialSource.kind !== 'legacy-db') {
          // An unbound chain that already carries a vault source is not a
          // legacy revision - the transition is exclusively for legacy-db.
          throw new HttpError(403, 'BINDING_DENIED', 'connector is neither a bound vault chain nor a migratable legacy revision');
        }
        base = legacy;
        binding = { tenantId: declared.tenantId, connectorId: input.connectorId, accountId: declared.accountId };
        transition = true;
      }
    } else {
      const current = await deps.revisions.get(input.connectorId);
      if (!current) throw notFound(`connector ${input.connectorId} has no revision to extend`);
      const bindingResult = ConnectorRevisionBindingSchema.safeParse({
        tenantId: current.tenantId,
        connectorId: input.connectorId,
        accountId: current.accountId,
      });
      if (!bindingResult.success) {
        throw new HttpError(403, 'BINDING_DENIED', 'connector ownership binding is unavailable');
      }
      base = current;
      binding = bindingResult.data;
    }
    // The caller may supply mount/key and a candidate path, but account and
    // tenant ownership come from the stored connector revision. Validate the
    // candidate shape against that trusted binding, then write the canonical
    // path assembled from the trusted coordinates.
    const candidate = VaultKv2RefSchema.safeParse({
      ...input.ref,
      account: binding.accountId,
    });
    if (!candidate.success || !matchesVaultAccountPath(candidate.data, binding)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'credential ref is outside the connector account path');
    }
    const trustedRef: VaultRefFields = {
      ...input.ref,
      account: binding.accountId,
      path: `du/tenants/${binding.tenantId}/connectors/${binding.connectorId}/accounts/${binding.accountId}`,
    };

    let version: number;
    try {
      version = await deps.vault.writeCas(trustedRef, input.value, input.cas);
    } catch (err) {
      refIssue(err);
    }

    // From here on the vault version exists; every failure path below must
    // leave NOTHING routable (SEC-04 "không mở provider call bằng ref nửa chừng").
    const pinnedResult = ConnectorCredentialSourceSchema.safeParse({ kind: 'vault-kv2', ...trustedRef, version });
    if (!pinnedResult.success || pinnedResult.data.kind !== 'vault-kv2') {
      throw new HttpError(502, 'VAULT_REF_INVALID', 'Vault returned an invalid pinned credential reference.');
    }
    const pinned: PinnedSource = pinnedResult.data;
    let committed: RevisionRow;
    let activated = false;
    if (transition) {
      if (!deps.revisions.bootstrap) {
        // Fail CLOSED: the vault version stays an unreferenced orphan
        // (harmless, never routable); nothing about the chain changed.
        throw new HttpError(
          501,
          'BOOTSTRAP_UNSUPPORTED',
          'revision store cannot bootstrap a bound chain; no revision was activated',
        );
      }
      try {
        committed = await deps.revisions.bootstrap(input.connectorId, pinned);
      } catch (err) {
        // Crash window A (transition flavor): orphan vault version, zero
        // revision churn. Reconcile tooling owns the orphan (VAULT-06).
        throw err;
      }
      // A bootstrapped first revision has no prior ACTIVE row to retire:
      // the store activates atomically at creation. A PENDING echo means
      // the store deviated from that contract - reconcile owns it.
      if (committed.state === 'ACTIVE') activated = true;
      else if (committed.state !== 'PENDING') {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'bootstrap returned an unknown revision state');
      }
    } else {
      try {
        committed = await deps.revisions.createPending(input.connectorId, pinned);
      } catch (err) {
        // Crash window A: orphan vault version, zero revision churn. Re-thrown
        // as-is; reconcile tooling can delete/ignore the version (VAULT-06).
        throw err;
      }
      try {
        activated = await deps.revisions.activate(input.connectorId, committed.revision, base.revision);
      } catch (err) {
        // Crash window B: revision stays PENDING — not routable. Explicit
        // reconcile (retry activate / retire) owns it now.
        throw err;
      }
    }
    const result: CredentialWorkflowResult = {
      connectorId: input.connectorId,
      revision: committed.revision,
      version,
      state: activated ? 'ACTIVE' : 'PENDING',
      ...(activated ? {} : { reconcileRequired: true }),
      ...(replayGuard ? { replayed: false } : {}),
    };
    await deps.audit?.record({
      action: 'connector.credential_rotate',
      resource: `connector:${input.connectorId}@rev${committed.revision}`,
      detail: {
        mount: trustedRef.mount,
        path: trustedRef.path,
        key: trustedRef.key,
        vaultVersion: version,
        hasValue: true,
        state: result.state,
        ...(result.reconcileRequired ? { reconcileRequired: true } : {}),
        ...(transition ? { transition: true } : {}),
      },
    });
    return result;
  };

  return {
    async resolveBinding(connectorId: string): Promise<TrustedConnectorBinding> {
      const row = await deps.revisions.get(connectorId);
      if (!row) throw notFound(`connector ${connectorId} has no revision to extend`);
      const parsed = ConnectorRevisionBindingSchema.safeParse({
        tenantId: row.tenantId,
        connectorId,
        accountId: row.accountId,
      });
      if (!parsed.success) throw new HttpError(403, 'BINDING_DENIED', 'connector ownership binding is unavailable');
      return parsed.data;
    },
    async rotate(input: RotateInput): Promise<CredentialWorkflowResult> {
      if (input.idempotencyKey !== undefined) {
        if (!deps.idempotency || !input.payloadHash) {
          // A promised replay guard that cannot be persisted must fail CLOSED.
          throw new HttpError(503, 'IDEMPOTENCY_UNAVAILABLE', 'idempotency store not configured');
        }
        const existing = await deps.idempotency.lookup(input.idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different payload');
          }
          return { ...existing.result, replayed: true };
        }
        const fresh = await run(input, true);
        await deps.idempotency.store(input.idempotencyKey, input.payloadHash, fresh);
        return fresh;
      }
      return run(input, false);
    },

    /** VAULT-04: emergency revoke of the CURRENT credential — every row is
     *  retired, so no NEW invocation can route while in-flight rows keep their
     *  pinned (now RETIRED) revision for reconcile. No ACTIVE orphan survives. */
    async revoke(connectorId: string): Promise<{ revoked: boolean; previousRevision?: number }> {
      const current = await deps.revisions.get(connectorId);
      if (!current) return { revoked: false };
      if (!deps.revisions.revokeAll) {
        throw new HttpError(501, 'REVOKE_UNSUPPORTED', 'revision store cannot revoke ACTIVE rows');
      }
      await deps.revisions.revokeAll(connectorId);
      await deps.audit?.record({
        action: 'connector.credential_revoke',
        resource: `connector:${connectorId}@rev${current.revision}`,
        detail: { state: 'RETIRED', previousRevision: current.revision, hasValue: true },
      });
      return { revoked: true, previousRevision: current.revision };
    },

    /** Reconcile a stranded PENDING (crash window B): activate if the chain
     *  still expects it, else retire. Returns the post-state. */
    async reconcile(connectorId: string, revision: number, expectedCurrentRevision: number): Promise<'ACTIVE' | 'RETIRED'> {
      const ok = await deps.revisions.activate(connectorId, revision, expectedCurrentRevision);
      if (ok) return 'ACTIVE';
      await deps.revisions.retire(connectorId, revision);
      return 'RETIRED';
    },

    /** Masked metadata for GET — never contains the plaintext value. */
    async describe(connectorId: string): Promise<MaskedCredentialMetadata> {
      const row = await deps.revisions.get(connectorId);
      if (!row) throw notFound(`connector ${connectorId} not found`);
      if (row.credentialSource.kind !== 'vault-kv2') {
        throw conflict('CREDENTIAL_SOURCE_NOT_VAULT', 'revision does not pin a vault-kv2 source');
      }
      const meta = await deps.vault.readVersions(row.credentialSource);
      return {
        connectorId,
        revision: row.revision,
        state: row.state,
        source: {
          kind: 'vault-kv2',
          mount: row.credentialSource.mount,
          path: row.credentialSource.path,
          key: row.credentialSource.key,
          pinnedVersion: row.credentialSource.version,
          hasValue: true,
        },
        vaultVersions: meta.versions,
        currentVaultVersion: meta.current_version,
      };
    },
  };
}

export type CredentialWorkflow = ReturnType<typeof createCredentialWorkflow>;
