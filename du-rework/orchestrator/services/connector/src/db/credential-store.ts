import { ConnectorCredentialSourceSchema, type EncryptedDbCredentialSource } from '@du/contracts';
import { ConnectorError } from '../errors';
import {
  validateSourceCredentialContext,
  type ContextBoundCredentialCipher,
  type SourceCredentialContext,
} from './source-credential-crypto';
import type { SqlClient } from './sql';

export interface TypedCredentialBinding extends Omit<SourceCredentialContext, 'credentialRef' | 'credentialVersion'> {
  credentialRef: string;
  credentialVersion: number;
}

interface CredentialCiphertextRow {
  ciphertext: Uint8Array;
}

/** Stores only AES-GCM ciphertext. Each row is authenticated against the exact
 * tenant, connector, revision, opaque reference, and pinned version. */
export class PostgresTypedCredentialStore {
  public constructor(
    private readonly db: SqlClient,
    private readonly cipher: ContextBoundCredentialCipher,
  ) {}

  /** Called from the draft-intent transaction so the credential and its
   * idempotency receipt either commit together or leave no stored effect. */
  public async stage(
    client: SqlClient,
    binding: TypedCredentialBinding,
    sourceValue: unknown,
    secret: string,
  ): Promise<void> {
    const { source, context } = parseBinding(binding, sourceValue);
    if (secret.length < 1 || secret.length > 16_384) {
      throw new ConnectorError('INVALID_INPUT', 'Connector credential value is invalid.');
    }
    const ciphertext = Buffer.from(this.cipher.encryptBound(secret, context));
    try {
      const inserted = await client.query(
        `INSERT INTO connector_parity_credentials
          (tenant_id,connector_id,revision,credential_ref,credential_version,ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [context.tenantId, context.connectorId, context.revision, source.credentialRef,
          source.version, ciphertext],
      );
      if (inserted.rowCount !== 1) throw new ConnectorError('CREDENTIAL_INVALID', 'Typed Connector credential could not be stored.');
    } finally {
      ciphertext.fill(0);
    }
  }

  /** Copy a prior typed credential into a new revision by opening it against
   * its original row and resealing under the new row's associated data. */
  public async copy(
    client: SqlClient,
    sourceBinding: TypedCredentialBinding,
    sourceValue: unknown,
    targetBinding: TypedCredentialBinding,
    targetValue: unknown,
  ): Promise<void> {
    const value = await this.open(client, sourceBinding, sourceValue);
    await this.stage(client, targetBinding, targetValue, value);
  }

  public async resolve(binding: TypedCredentialBinding, sourceValue: unknown): Promise<string> {
    return this.open(this.db, binding, sourceValue);
  }

  private async open(client: SqlClient, binding: TypedCredentialBinding, sourceValue: unknown): Promise<string> {
    const { source, context } = parseBinding(binding, sourceValue);
    let result: { rows: CredentialCiphertextRow[] };
    try {
      result = await client.query<CredentialCiphertextRow>(
        `SELECT ciphertext FROM connector_parity_credentials
          WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3
            AND credential_ref=$4 AND credential_version=$5`,
        [context.tenantId, context.connectorId, context.revision, source.credentialRef, source.version],
      );
    } catch {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector credential storage is unavailable.');
    }
    const row = result.rows[0];
    if (!row || !(row.ciphertext instanceof Uint8Array)) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Typed Connector credential is not available for this revision.');
    }
    try {
      return this.cipher.decryptBound(row.ciphertext, context);
    } catch {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Typed Connector credential binding could not be verified.');
    }
  }
}

function parseBinding(binding: TypedCredentialBinding, value: unknown): {
  source: EncryptedDbCredentialSource;
  context: SourceCredentialContext;
} {
  const parsed = ConnectorCredentialSourceSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== 'encrypted-db'
    || parsed.data.credentialRef !== binding.credentialRef
    || parsed.data.version !== binding.credentialVersion) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Typed Connector credential source does not match its row binding.');
  }
  const source = parsed.data;
  const context: SourceCredentialContext = {
    tenantId: binding.tenantId,
    connectorId: binding.connectorId,
    revision: binding.revision,
    credentialRef: source.credentialRef,
    credentialVersion: source.version,
  };
  validateSourceCredentialContext(context);
  // Keep a canonical `encrypted-db` source after parsing through the additive
  // alias-aware union used by the legacy/Vault runtime.
  return { source, context };
}
