import { parseContractGrantClaims, localGrantClaimsFromContract } from './contracts';
import type { GrantClaims } from './types';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedGrantSource {
  verify(token: string): Promise<unknown>;
}

export class ContractSignedGrantVerifier {
  public constructor(private readonly source: SignedGrantSource) {}

  public async verify(token: string): Promise<GrantClaims> {
    const claims = parseContractGrantClaims(await this.source.verify(token));
    return localGrantClaimsFromContract(claims);
  }
}

export class HmacSignedGrantSource implements SignedGrantSource {
  public constructor(private readonly secret: Uint8Array) {}

  public async verify(token: string): Promise<unknown> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token.');
    const [encodedHeader, encodedPayload, signature] = parts;
    const expected = createHmac('sha256', this.secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    const actualBytes = Buffer.from(signature, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error('Invalid signature.');
    }
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') throw new Error('Invalid algorithm.');
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;
  }
}
