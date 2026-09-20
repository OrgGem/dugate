import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { validateGrant } from './grants';
import { hashInvocationInput } from './hash';
import { invokeAdapter, type ProviderTransport } from './invoke';
import { redactConnectorRevision } from './config';
import { ConnectorError } from './errors';
import type { ConnectorHttpStore, ConnectorRuntime, HttpInvocationResult } from './http/server';
import type { ConnectorConfigRepository, ConnectorRevision } from './db/repository';
import type { PostgresInvocationLedger } from './db/repository';
import type { PostgresUsageOutbox } from './db/usage-outbox';
import type { AdapterConfig, LocalInvocationRequest, QuotaStore } from './types';
import { AdapterRegistry } from './adapters/registry';
import { FetchProviderTransport } from './adapters/transport';
import { parseContractInvocationRequest } from './contracts';
import type { InvocationRequest } from '@du/contracts';

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
  ) {}

  public async invoke(body: unknown): Promise<HttpInvocationResult> {
    const request = parseContractInvocationRequest(body);
    const unsignedClaims = await this.grantVerifier.verify(request.grant);
    const local = toLocalRequest(request, unsignedClaims.tenantId);
    const claims = await validateGrant(request.grant, local, hashInvocationInput(local), {
      verify: async () => unsignedClaims,
    });
    const [connectorId, revisionText] = claims.connectorRevision.split(':');
    const revision = await this.repository.getRevision(connectorId, Number(revisionText));
    if (!revision || revision.state !== 'ACTIVE') throw new ConnectorError('CONNECTOR_DISABLED', 'Connector revision is not active.');
    const adapter = this.registry.get(revision.adapter);
    const credential = await this.repository.getActiveCredential(revision.credentialRef);
    if (!credential) throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential is not active.');
    const config = withCredential(revision.config, this.cipher.decrypt(credential));
    const outcome = await invokeAdapter(local, {
      ledger: this.ledger,
      quota: this.quota,
      adapter,
      config,
      transport: this.transport,
      quotaKey: `${connectorId}:${revision.revision}:${local.tenantId}`,
      providerTimeoutMs: revision.config.timeoutMs,
      credential: { isActive: async () => Boolean(await this.repository.getActiveCredential(revision.credentialRef)) },
    });
    if (outcome.state === 'completed') {
      const event = outcome.result.usage
        ? { eventId: `${local.invocationId}:1`, invocationId: local.invocationId, operationId: local.operationId, taskId: local.taskId, usage: outcome.result.usage, createdAt: new Date().toISOString() }
        : undefined;
      if (event) await this.outbox.append(event);
      return { invocationId: local.invocationId, state: 'completed', result: outcome.result as Record<string, unknown> };
    }
    return { invocationId: local.invocationId, state: 'pending', nextPollAt: outcome.nextPollAt };
  }

  public async get(invocationId: string): Promise<HttpInvocationResult | undefined> {
    const record = await this.ledger.get(invocationId);
    return record ? toHttpResult(record) : undefined;
  }

  public async cancel(invocationId: string, _reason: string): Promise<HttpInvocationResult> {
    return toHttpResult(await this.ledger.cancel(invocationId));
  }
}

export class DurableConnectorManagement implements ConnectorHttpStore {
  public constructor(
    private readonly repository: ConnectorConfigRepository,
    private readonly cipher: CredentialCipher,
    private readonly registry: AdapterRegistry,
  ) {}

  public async list(): Promise<ConnectorRevision[]> {
    return (await this.repository.list()).map(redactConnectorRevision);
  }

  public async get(connectorId: string): Promise<ConnectorRevision | undefined> {
    const revision = await this.repository.get(connectorId);
    return revision ? redactConnectorRevision(revision) : undefined;
  }

  public async createRevision(input: Omit<ConnectorRevision, 'revision'>): Promise<ConnectorRevision> {
    this.registry.get(input.adapter);
    if (!Number.isFinite(input.config.timeoutMs) || input.config.timeoutMs <= 0) {
      throw new ConnectorError('INVALID_INPUT', 'Connector timeout must be positive.');
    }
    return this.repository.createRevision(input);
  }

  public async rotateCredential(connectorId: string, secret: string): Promise<void> {
    const revision = await this.repository.get(connectorId);
    if (!revision) throw new ConnectorError('INVALID_INPUT', 'Connector does not exist.');
    await this.repository.put(revision.credentialRef, this.cipher.encrypt(secret));
  }

  public async disable(connectorId: string): Promise<void> {
    await this.repository.disable(connectorId);
  }

  public async test(connectorId: string): Promise<{ ok: boolean; errorCode?: string }> {
    const revision = await this.repository.get(connectorId);
    if (!revision || revision.state !== 'ACTIVE') return { ok: false, errorCode: 'CONNECTOR_DISABLED' };
    this.registry.get(revision.adapter);
    return { ok: true };
  }
}

function toLocalRequest(request: InvocationRequest, tenantId: string): LocalInvocationRequest {
  const { grant: _grant, ...local } = request;
  return { ...local, tenantId };
}

function withCredential(config: AdapterConfig, secret: string): AdapterConfig {
  return {
    ...config,
    headers: { ...(config.headers ?? {}), authorization: `Bearer ${secret}` },
  };
}

function toHttpResult(record: import('./types').InvocationRecord): HttpInvocationResult {
  const state = record.state === 'SUCCEEDED'
    ? 'completed'
    : record.state === 'PENDING'
      ? 'pending'
      : record.state === 'UNKNOWN'
        ? 'unknown'
        : record.state === 'CANCELLED'
          ? 'cancelled'
          : 'failed';
  return {
    invocationId: record.request.invocationId,
    state,
    result: record.result as Record<string, unknown> | undefined,
    providerRequestId: record.providerRequestId,
    error: record.errorCode ? { code: record.errorCode, message: 'Invocation did not complete.' } : undefined,
    nextPollAt: record.nextPollAt,
  };
}
