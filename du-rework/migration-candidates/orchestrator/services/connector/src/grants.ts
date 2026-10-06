import { timingSafeEqual } from 'node:crypto';
import { ConnectorError } from './errors';
import type { GrantClaims, LocalInvocationRequest } from './types';
import { assertArtifactGrantBindings } from './artifact-content';

export interface GrantVerifier {
  verify(token: string): Promise<GrantClaims>;
}

export async function validateGrant(
  token: string,
  request: LocalInvocationRequest,
  inputHash: string,
  verifier: GrantVerifier,
  now = Date.now(),
): Promise<GrantClaims> {
  let claims: GrantClaims;
  try {
    claims = await verifier.verify(token);
  } catch {
    throw new ConnectorError('GRANT_INVALID', 'Invocation grant is invalid.');
  }
  const expected = [
    claims.audience === 'connector',
    claims.tenantId === request.tenantId,
    claims.operationId === request.operationId,
    claims.taskId === request.taskId,
    claims.stepKey === request.stepKey,
    claims.invocationId === request.invocationId,
    claims.inputHash === inputHash,
    Date.parse(claims.expiresAt) > now,
  ];
  if (!expected.every(Boolean)) {
    throw new ConnectorError('BINDING_DENIED', 'Invocation grant binding is invalid.');
  }
  assertArtifactGrantBindings(request.input.artifacts, claims.artifactIds, claims.artifactPins);
  return claims;
}

export function validateGrantClaims(
  claims: GrantClaims,
  request: LocalInvocationRequest,
  inputHash: string,
  now = Date.now(),
): GrantClaims {
  if (
    claims.audience !== 'connector' ||
    claims.tenantId !== request.tenantId ||
    claims.operationId !== request.operationId ||
    claims.taskId !== request.taskId ||
    claims.stepKey !== request.stepKey ||
    claims.invocationId !== request.invocationId ||
    claims.inputHash !== inputHash ||
    Date.parse(claims.expiresAt) <= now
  ) {
    throw new ConnectorError('BINDING_DENIED', 'Invocation grant binding is invalid.');
  }
  assertArtifactGrantBindings(request.input.artifacts, claims.artifactIds, claims.artifactPins);
  return claims;
}

export function equalOpaqueTokens(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
