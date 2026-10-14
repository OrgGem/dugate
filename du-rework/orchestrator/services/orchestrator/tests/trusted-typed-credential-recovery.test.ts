import { createCipheriv, randomBytes } from 'node:crypto';
import { verifyTypedConnectorCredentialCiphertext } from '../src/modules/maintenance/trusted-isolated-restore-runtime-ports';

const tenantId='11111111-1111-4111-8111-111111111111';
const credentialRef='22222222-2222-4222-8222-222222222222';
const context={tenantId,connectorId:'sample-connector',revision:7,credentialRef,credentialVersion:3};
const key=Buffer.alloc(32,0x4b);

function seal(secret:string, row=context, encryptionKey=key):Buffer {
  const nonce=randomBytes(12);
  const aad=Buffer.from(JSON.stringify({purpose:'du.connector.typed-credential.v1',tenantId:row.tenantId.toLowerCase(),
    connectorId:row.connectorId,revision:row.revision,credentialRef:row.credentialRef.toLowerCase(),
    credentialVersion:row.credentialVersion}),'utf8');
  const cipher=createCipheriv('aes-256-gcm',encryptionKey,nonce);
  cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]);
}

describe('trusted typed Connector credential restore proof',()=>{
  test('authenticates the row-bound ciphertext and emits only opaque hashes',()=>{
    const secret='typed-restore-secret-sentinel';
    const proof=verifyTypedConnectorCredentialCiphertext({ ...context,ciphertext:seal(secret),key,keyVersion:'connector-v1' });
    expect(proof).toMatchObject({recordKind:'typed-credential',keyVersion:'connector-v1'});
    expect(JSON.stringify(proof)).not.toContain(secret);
    expect(proof.secretVersionIdSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.plaintextSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('accepts canonical PostgreSQL tenant UUID sentinels without relaxing credential refs',()=>{
    const sentinelTenant='00000000-0000-0000-0000-000000000001';
    const row={...context,tenantId:sentinelTenant};
    const ciphertext=seal('typed-restore-sentinel-tenant',row);
    expect(verifyTypedConnectorCredentialCiphertext({ ...row,ciphertext,key,keyVersion:'connector-v1' }))
      .toMatchObject({recordKind:'typed-credential',keyVersion:'connector-v1'});
    expect(()=>verifyTypedConnectorCredentialCiphertext({ ...row,tenantId:'00000000-0000-0000-0000-00000000001',ciphertext,key,keyVersion:'connector-v1' }))
      .toThrow('RESTORE_CONNECTOR_TYPED_CREDENTIAL_BINDING_INVALID');
    expect(()=>verifyTypedConnectorCredentialCiphertext({ ...row,credentialRef:'00000000-0000-0000-0000-000000000001',ciphertext,key,keyVersion:'connector-v1' }))
      .toThrow('RESTORE_CONNECTOR_TYPED_CREDENTIAL_BINDING_INVALID');
  });

  test('rejects wrong keys, tampered bytes, and every changed row-binding dimension',()=>{
    const ciphertext=seal('typed-restore-secret-sentinel');
    expect(()=>verifyTypedConnectorCredentialCiphertext({ ...context,ciphertext,key:Buffer.alloc(32,0x5c),keyVersion:'connector-v1' }))
      .toThrow('RESTORE_CONNECTOR_TYPED_CREDENTIAL_AUTH_FAILED');
    const tampered=Buffer.from(ciphertext);const last=tampered.length-1;tampered[last]=tampered[last]!^0x01;
    expect(()=>verifyTypedConnectorCredentialCiphertext({ ...context,ciphertext:tampered,key,keyVersion:'connector-v1' }))
      .toThrow('RESTORE_CONNECTOR_TYPED_CREDENTIAL_AUTH_FAILED');
    const contexts=[
      {...context,tenantId:'33333333-3333-4333-8333-333333333333'},
      {...context,connectorId:'other-connector'},
      {...context,revision:8},
      {...context,credentialRef:'44444444-4444-4444-8444-444444444444'},
      {...context,credentialVersion:4},
    ];
    for (const row of contexts) {
      expect(()=>verifyTypedConnectorCredentialCiphertext({ ...row,ciphertext,key,keyVersion:'connector-v1' }))
        .toThrow('RESTORE_CONNECTOR_TYPED_CREDENTIAL_AUTH_FAILED');
    }
  });
});
