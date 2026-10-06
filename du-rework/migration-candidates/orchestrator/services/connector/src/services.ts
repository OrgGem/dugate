import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { validateGrant } from './grants';
import { hashInvocationInput } from './hash';
import { invokeAdapter, type ProviderTransport } from './invoke';
import { redactConnectorRevision } from './config';
import { ConnectorError } from './errors';
import type { ConnectorHttpStore, ConnectorRuntime, HttpInvocationResult } from './http/server';
import type { ConnectorConfigRepository, ConnectorRevision, NewConnectorRevision } from './db/repository';
import type { PostgresInvocationLedger } from './db/repository';
import type { PostgresUsageOutbox } from './db/usage-outbox';
import type { AdapterConfig, GrantClaims, InvocationRecord, LocalInvocationRequest, QuotaStore } from './types';
import { AdapterRegistry } from './adapters/registry';
import { applyCredentialSlot, parseCredentialSource, SecretResolver } from './vault/resolver';
import { deriveRevisionBinding, isBoundRevisionTenant, type RevisionScope } from './db/repository';
import { FetchProviderTransport } from './adapters/transport';
import { parseContractInvocationRequest } from './contracts';
import {
  ConnectorRevisionBindingSchema,
  matchesVaultRevisionBinding,
  type ConnectorRevisionBinding,
  type InvocationRequest,
} from '@du/contracts';

export interface CredentialCipher {
  encrypt(secret: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

export class AesCredentialCipher implements CredentialCipher {
  public constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('Connector credential key must be 32 bytes.');
  }

  public encrypt(secret: string): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  public decrypt(value: Uint8Array): string {
    const bytes = Buffer.from(value);
    if (bytes.length < 28) throw new ConnectorError('CREDENTIAL_INVALID', 'Stored credential is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    try {
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Stored credential is invalid.');
    }
  }
}

export class DurableConnectorRuntime implements ConnectorRuntime {
  public constructor(
    private readonly ledger: PostgresInvocationLedger,
    private readonly repository: ConnectorConfigRepository,
    private readonly quota: QuotaStore,
    private readonly outbox: PostgresUsageOutbox,
    private readonly registry: AdapterRegistry,
    private readonly transport: ProviderTransport,
    private readonly cipher: CredentialCipher,
    private readonly grantVerifier: { verify(token: string): Promise<import('./types').GrantClaims> },
    /** VAULT-05: optional seam; absent = vault-backed revisions fail closed. */
    private readonly secretResolver?: SecretResolver,
  ) {}

  public async invoke(body: unknown): Promise<HttpInvocationResult> {
    const request = parseContractInvocationRequest(body);
    let unsignedClaims: GrantClaims;
    try {
      unsignedClaims = await this.grantVerifier.verify(request.grant);
    } catch {
      throw new ConnectorError('GRANT_INVALID', 'Invocation grant is invalid.');
    }
    const local = toLocalRequest(request, unsignedClaims.tenantId);
    const claims = await validateGrant(request.grant, local, hashInvocationInput(local), {
      verify: async () => unsignedClaims,
    });
    const revisionParts = claims.connectorRevision.split(':');
    if (
      revisionParts.length !== 2
      || !revisionParts[0]
      || !/^[1-9]\d*$/.test(revisionParts[1] ?? '')
    ) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
    }
    const connectorId = revisionParts[0];
    const revisionNumber = Number(revisionParts[1]);
    if (!Number.isSafeInteger(revisionNumber)) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
    }
    // W-VAULT01-BIND-1R: the tenant_id predicate is part of the row lookup, so
    // a foreign tenant's revision never leaves the database. revision.tenantId
    // is the row's OWN trusted binding (storage projection), not grant data:
    // a bound row must name exactly the tenant carried by the verified grant.
    const revision = await this.repository.getRevision(connectorId, revisionNumber, { tenantId: claims.tenantId });
    if (!revision || revision.connectorId !== connectorId || revision.revision !== revisionNumber) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
    }
    if (isBoundRevisionTenant(revision.tenantId) && revision.tenantId !== claims.tenantId) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
    }
    if (revision.state !== 'ACTIVE') throw new ConnectorError('CONNECTOR_DISABLED', 'Connector revision is not active.');
    const source = parseCredentialSource(revision.credentialSource);
    let secret: string;
    if (source.kind === 'vault-kv2') {
      // The signed invocation grant supplies the tenant scope. The persisted
      // revision supplies the trusted (tenant, connector, account) binding.
      // Check the exact KV path before a resolver can issue any Vault read.
      if (!matchesVaultRevisionBinding(source, {
        tenantId: revision.tenantId,
        connectorId: revision.connectorId,
        accountId: revision.accountId,
      })) {
        throw new ConnectorError('BINDING_DENIED', 'Vault credential does not match the trusted revision binding.');
      }
      if (!this.secretResolver) {
        throw new ConnectorError('CREDENTIAL_INVALID', 'Vault-backed revision requires a configured SecretResolver.');
      }
      secret = (await this.secretResolver.resolve(source)).value;
    } else {
      if (isBoundRevisionTenant(revision.tenantId)) {
        // Storage invariant (migration 008): tenant-bound chains never carry
        // legacy-db credentials. Fail closed instead of reading a secret whose
        // owner the row cannot vouch for.
        throw new ConnectorError('CREDENTIAL_INVALID', 'Legacy-db credential on a tenant-bound revision is invalid.');
      }
      const credential = await this.repository.getActiveCredential(source.credentialRef, { tenantId: claims.tenantId });
      if (!credential) throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential is not active.');
      secret = this.cipher.decrypt(credential);
    }
    const adapter = this.registry.get(revision.adapter);
    const config = applyCredentialSlot(revision.config, secret);
    const outcome = await invokeAdapter(local, {
      ledger: this.ledger,
      quota: this.quota,
      adapter,
      config,
      transport: this.transport,
      // credentialRef identifies the shared provider account; tenant IDs must not
      // create separate maxInFlight buckets for the same provider credential.
      quotaKey: revision.credentialRef,
      providerTimeoutMs: revision.config.timeoutMs,
      credential: {
        isActive: async () => source.kind === 'vault-kv2'
          || Boolean(await this.repository.getActiveCredential(source.credentialRef, { tenantId: claims.tenantId })),
      },
    });
    if (outcome.state === 'completed') {
      const event = outcome.result.usage
        ? { eventId: `${local.invocationId}:1`, invocationId: local.invocationId, operationId: local.operationId, taskId: local.taskId, usage: outcome.result.usage, createdAt: new Date().toISOString() }
        : undefined;
      if (event) await this.outbox.append(event);
      return { invocationId: local.invocationId, state: 'completed', result: outcome.result as Record<string, unknown> };
    }
    return {
      invocationId: local.invocationId,
      state: 'pending',
      nextPollAt: outcome.nextPollAt,
      providerRequestId: outcome.providerRequestId,
    };
  }

  public async get(invocationId: string, invocationGrant?: string): Promise<HttpInvocationResult | undefined> {
    const record = await this.ledger.get(invocationId);
    if (!record) return undefined;
    await this.authorizeInvocation(record, invocationGrant);
    return toHttpResult(record);
  }

  public async cancel(invocationId: string, _reason: string, invocationGrant?: string): Promise<HttpInvocationResult> {
    const record = await this.ledger.get(invocationId);
    if (!record) throw new ConnectorError('INVALID_INPUT', 'Invocation not found.');
    await this.authorizeInvocation(record, invocationGrant);
    const cancelled = await this.ledger.cancel(invocationId);
    if (record.quotaLease) {
      try {
        await this.quota.release(record.quotaLease);
      } catch {
        // The lease has a deadline-bounded Redis expiry; a failed eager release
        // cannot leave capacity reserved indefinitely.
      }
    }
    return toHttpResult(cancelled);
  }

  private async authorizeInvocation(record: InvocationRecord, invocationGrant?: string): Promise<void> {
    if (!invocationGrant) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant is required to read or cancel this invocation.');
    }
    await validateGrant(invocationGrant, record.request, record.inputHash, this.grantVerifier);
  }
}

export class DurableConnectorManagement implements ConnectorHttpStore {
  public constructor(
    private readonly repository: ConnectorConfigRepository,
    private readonly cipher: CredentialCipher,
    private readonly registry: AdapterRegistry,
    private readonly secretResolver?: SecretResolver,
  ) {}

  public async list(): Promise<ConnectorRevision[]> {
    return (await this.repository.list()).map(redactConnectorRevision);
  }

  public async get(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    const revision = await this.repository.get(connectorId, scope);
    return revision ? redactConnectorRevision(revision) : undefined;
  }

  public async createRevision(input: NewConnectorRevision): Promise<ConnectorRevision> {
    this.registry.get(input.adapter);
    if (!Number.isFinite(input.config.timeoutMs) || input.config.timeoutMs <= 0) {
      throw new ConnectorError('INVALID_INPUT', 'Connector timeout must be positive.');
    }
    const credentialSource = parseCredentialSource(input.credentialSource ?? {
      kind: 'legacy-db',
      credentialRef: input.credentialRef,
    });
    if (credentialSource.kind === 'vault-kv2') {
      if (!matchesVaultRevisionBinding(credentialSource, {
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        accountId: input.accountId,
      })) {
        throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
      }
    }
    if (credentialSource.kind === 'legacy-db' && credentialSource.credentialRef !== input.credentialRef) {
      throw new ConnectorError('INVALID_INPUT', 'Legacy credential source does not match credentialRef.');
    }
    return this.repository.createRevision({ ...input, credentialSource });
  }

  /** VAULT-06: clone CURRENT's adapter/config/credentialRef into a new PENDING. */
  public async createPendingRevision(
    connectorId: string,
    credentialSource: unknown,
    binding: ConnectorRevisionBinding,
  ): Promise<ConnectorRevision> {
    const source = parseCredentialSource(credentialSource);
    if (source.kind !== 'vault-kv2') {
      throw new ConnectorError('INVALID_INPUT', 'createPendingRevision requires a vault-kv2 credential source.');
    }
    const parsedBinding = ConnectorRevisionBindingSchema.safeParse(binding);
    if (!parsedBinding.success
      || parsedBinding.data.connectorId !== connectorId
      || !matchesVaultRevisionBinding(source, parsedBinding.data)) {
      throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
    }
    // Scope comes from the trusted writer context; it is never inferred from
    // the ref path. The ref is checked against this independent binding.
    const current = await this.repository.getActiveRevision(connectorId, { tenantId: parsedBinding.data.tenantId });
    if (!current) throw new ConnectorError('INVALID_INPUT', 'Connector has no ACTIVE revision to extend.');
    if (current.accountId !== parsedBinding.data.accountId) {
      throw new ConnectorError('BINDING_DENIED', 'Connector account binding cannot change within a revision chain.');
    }
    this.registry.get(current.adapter);
    return this.repository.createRevision({
      connectorId,
      adapter: current.adapter,
      config: current.config,
      credentialRef: current.credentialRef,
      state: 'PENDING',
      tenantId: parsedBinding.data.tenantId,
      accountId: parsedBinding.data.accountId,
      credentialSource: source,
    });
  }

  /**
   * W-VAULT-LEGACY-TRANSITION-1: open the tenant-bound chain for a connector
   * whose CURRENT is still the unbound legacy-db revision. The transition
   * key facts mirror migration 008 instead of fighting it: the shared legacy
   * credential_ref can never join a bound chain, so bootstrap derives a
   * fresh chain key and clones adapter/config from the validated legacy row.
   * The storage layer re-checks the legacy precondition inside the write
   * transaction; a replay against an already-open identical pin returns the
   * existing ACTIVE row.
   */
  public async bootstrapRevision(
    connectorId: string,
    credentialSource: unknown,
    binding: ConnectorRevisionBinding,
  ): Promise<{ revision: ConnectorRevision; replayed: boolean }> {
    const source = parseCredentialSource(credentialSource);
    if (source.kind !== 'vault-kv2') {
      throw new ConnectorError('INVALID_INPUT', 'bootstrapRevision requires a vault-kv2 credential source.');
    }
    const parsedBinding = ConnectorRevisionBindingSchema.safeParse(binding);
    if (!parsedBinding.success
      || parsedBinding.data.connectorId !== connectorId
      || !matchesVaultRevisionBinding(source, parsedBinding.data)) {
      throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
    }
    const legacy = await this.repository.get(connectorId, {});
    if (!legacy) {
      throw new ConnectorError('INVALID_INPUT', 'Connector has no unbound legacy revision to transition.');
    }
    if (legacy.credentialSource.kind !== 'legacy-db') {
      throw new ConnectorError('INVALID_INPUT', 'The unbound revision is not legacy-db.');
    }
    const credentialRef = 'cred-' + connectorId + '-' + parsedBinding.data.accountId;
    if (credentialRef === legacy.credentialRef) {
      throw new ConnectorError('INVALID_INPUT', 'The derived credential_ref collides with the shared legacy ref.');
    }
    this.registry.get(legacy.adapter);
    return this.repository.bootstrapVaultRevision({
      connectorId,
      adapter: legacy.adapter,
      config: legacy.config,
      credentialRef,
      credentialSource: source,
      tenantId: parsedBinding.data.tenantId,
      accountId: parsedBinding.data.accountId,
    });
  }

  public async getCurrentRevision(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    return redacted(this.repository.getActiveRevision(connectorId, scope));
  }

  public async getRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    return redacted(this.repository.getRevision(connectorId, revision, scope));
  }

  public async activateRevision(
    connectorId: string,
    revision: number,
    expectedCurrentRevision: number,
    scope?: RevisionScope,
  ): Promise<boolean> {
    return this.repository.activateRevision(connectorId, revision, expectedCurrentRevision, scope);
  }

  public async retireRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<void> {
    await this.repository.retireRevision(connectorId, revision, scope);
  }

  public async rotateCredential(connectorId: string, secret: string, scope?: RevisionScope): Promise<void> {
    const revision = await this.repository.get(connectorId, scope);
    if (!revision) throw new ConnectorError('INVALID_INPUT', 'Connector does not exist.');
    await this.repository.put(revision.credentialRef, this.cipher.encrypt(secret));
  }

  public async disable(connectorId: string, scope?: RevisionScope): Promise<void> {
    await this.repository.disable(connectorId, scope);
  }

  public async test(connectorId: string, scope?: RevisionScope): Promise<{ ok: boolean; errorCode?: string }> {
    const revision = await this.repository.get(connectorId, scope);
    if (!revision || revision.state !== 'ACTIVE') return { ok: false, errorCode: 'CONNECTOR_DISABLED' };
    this.registry.get(revision.adapter);
    // VAULT-05 (SEC-05): test must verify the secret ref AND a real read —
    // an ACTIVE adapter row alone is not proof the credential works.
    let source: ReturnType<typeof parseCredentialSource>;
    try {
      source = parseCredentialSource(revision.credentialSource);
    } catch (err) {
      return { ok: false, errorCode: err instanceof ConnectorError ? err.code : 'CREDENTIAL_INVALID' };
    }
    if (source.kind === 'vault-kv2') {
      if (!matchesVaultRevisionBinding(source, {
        tenantId: revision.tenantId,
        connectorId,
        accountId: revision.accountId,
      })) {
        return { ok: false, errorCode: 'BINDING_DENIED' };
      }
      if (!this.secretResolver) return { ok: false, errorCode: 'CREDENTIAL_INVALID' };
      return this.secretResolver.probe(source);
    }
    const active = await this.repository.getActiveCredential(source.credentialRef, scope);
    return active ? { ok: true } : { ok: false, errorCode: 'CREDENTIAL_INVALID' };
  }
}

async function redacted(
  promise: Promise<ConnectorRevision | undefined>,
): Promise<ConnectorRevision | undefined> {
  const revision = await promise;
  return revision ? redactConnectorRevision(revision) : undefined;
}

function toLocalRequest(request: InvocationRequest, tenantId: string): LocalInvocationRequest {
  const { grant: _grant, ...local } = request;
  return { ...local, tenantId };
}

function toHttpResult(record: import('./types').InvocationRecord): HttpInvocationResult {
  const state = record.state === 'SUCCEEDED'
    ? 'completed'
    : record.state === 'PENDING' || record.state === 'POLLING'
      ? 'pending'
      : record.state === 'UNKNOWN' || record.state === 'IN_FLIGHT'
        ? 'unknown'
        : record.state === 'CANCELLED'
          ? 'cancelled'
          : 'failed';
  const errorCode = record.errorCode
    ?? (record.state === 'IN_FLIGHT' || record.state === 'UNKNOWN' ? 'INVOCATION_UNKNOWN' : undefined);
  return {
    invocationId: record.request.invocationId,
    state,
    result: record.result as Record<string, unknown> | undefined,
    providerRequestId: record.providerRequestId,
    error: errorCode ? { code: errorCode, message: 'Invocation did not complete.' } : undefined,
    nextPollAt: record.nextPollAt,
  };
}
