import { timingSafeEqual } from 'node:crypto';
import { ConnectorError } from './errors';
import type { GrantClaims, LocalInvocationRequest } from './types';
import { assertArtifactGrantBindings } from './artifact-content';
import type { ProviderTestGrantClaims } from '@du/contracts';
import { workflowOverridesDigest } from '@du/contracts';

export interface GrantVerifier {
  verify(token: string): Promise<GrantClaims>;
}

/** Separate audience-purpose verifier; admin test grants never enter the
 * ordinary invocation verifier or expose PENDING revisions to worker calls. */
export interface ProviderTestGrantVerifier {
  verify(token: string): Promise<ProviderTestGrantClaims>;
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
  assertWorkflowOverrideBinding(claims, request);
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
  assertWorkflowOverrideBinding(claims, request);
  return claims;
}

function assertWorkflowOverrideBinding(claims: GrantClaims, request: LocalInvocationRequest): void {
  if (!request.workflowOverrides) {
    if (claims.workflowOverridesDigest !== undefined) {
      throw new ConnectorError('BINDING_DENIED', 'Workflow recipe grant binding is invalid.');
    }
    return;
  }
  if (!claims.workflowOverridesDigest || !claims.bindingSlot) {
    throw new ConnectorError('BINDING_DENIED', 'Workflow recipe grant binding is invalid.');
  }
  const connectorRevision = request.workflowOverrides.connectorRevision;
  const revisionSuffix = `:${connectorRevision}`;
  if (!claims.connectorRevision.endsWith(revisionSuffix)) {
    throw new ConnectorError('BINDING_DENIED', 'Workflow recipe grant binding is invalid.');
  }
  const connectorId = claims.connectorRevision.slice(0, -revisionSuffix.length);
  if (!connectorId || request.workflowOverrides.connectorId !== connectorId
    || workflowOverridesDigest({
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      connectorId,
      connectorRevision,
      workflowOverrides: request.workflowOverrides,
    }) !== claims.workflowOverridesDigest) {
    throw new ConnectorError('BINDING_DENIED', 'Workflow recipe grant binding is invalid.');
  }
}

export function equalOpaqueTokens(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
