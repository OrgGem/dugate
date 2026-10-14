import { ConnectorError } from '../errors';
import { isTenantUuid } from '@du/contracts';

export interface SourceCredentialContext {
  tenantId: string;
  connectorId: string;
  revision: number;
  credentialRef: string;
  credentialVersion: number;
}

/** AES-GCM implementation lives on the Connector's existing AES credential
 * cipher so the legacy and typed stores share the required process key while
 * keeping their ciphertext formats separate. */
export interface ContextBoundCredentialCipher {
  encryptBound(secret: string, context: SourceCredentialContext): Uint8Array;
  decryptBound(value: Uint8Array, context: SourceCredentialContext): string;
}

export function sourceCredentialAad(context: SourceCredentialContext): Buffer {
  validateSourceCredentialContext(context);
  return Buffer.from(JSON.stringify({
    purpose: 'du.connector.typed-credential.v1',
    tenantId: context.tenantId.toLowerCase(),
    connectorId: context.connectorId,
    revision: context.revision,
    credentialRef: context.credentialRef.toLowerCase(),
    credentialVersion: context.credentialVersion,
  }), 'utf8');
}

export function validateSourceCredentialContext(context: SourceCredentialContext): void {
  if (!isTenantUuid(context.tenantId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.connectorId)
    || context.connectorId.includes('..')
    || !Number.isSafeInteger(context.revision) || context.revision < 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.credentialRef)
    || !Number.isSafeInteger(context.credentialVersion) || context.credentialVersion < 1) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Typed Connector credential binding is invalid.');
  }
}
