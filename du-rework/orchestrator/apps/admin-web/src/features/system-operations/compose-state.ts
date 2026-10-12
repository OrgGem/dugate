import type {
  AdminApiProblem,
  ComposeAction,
  ComposeCatalog,
  ComposeCatalogProject,
  ComposeJobState,
  ComposePreview,
  ComposeSafeErrorCode,
} from '@/lib/api';

export const COMPOSE_LOCAL_STALE_AFTER_MS = 60_000;

export type ComposeFreshness = 'fresh' | 'stale' | 'unavailable' | 'unknown';

const SAFE_ERROR_MESSAGES: Record<ComposeSafeErrorCode, string> = {
  RUNNER_NOT_CONFIGURED: 'The host-side Compose runner is not configured.',
  SNAPSHOT_NOT_RECEIVED: 'The host runner has not reported an observation yet.',
  SNAPSHOT_INVALID: 'The last host observation could not be validated.',
  MANIFEST_DIGEST_MISMATCH: 'The host manifest does not match the approved digest.',
  DOCKER_UNAVAILABLE: 'Docker is unavailable to the host runner.',
  INVENTORY_UNAVAILABLE: 'The host runner could not read service inventory.',
  HEALTHCHECK_FAILED: 'The host did not confirm the requested service health.',
  COMMAND_FAILED: 'The host runner reported a command failure.',
  COMMAND_TIMEOUT: 'The host runner timed out; check job state before taking another action.',
  OUTPUT_LIMIT: 'The host runner stopped because its bounded output limit was reached.',
  TARGET_BUSY: 'Another unresolved job already holds this Compose project.',
  STALE_SAMPLE: 'The host observation changed or expired; refresh it and request a new preview.',
  STALE_PREVIEW: 'This preview expired or no longer matches current state; request a new preview.',
  TARGET_REVISION_CONFLICT: 'The desired target revision changed after this preview.',
  IDEMPOTENCY_CONFLICT: 'This submission key was already used with different job input.',
  EXECUTION_UNCERTAIN: 'The host action may have taken effect; reconcile it before submitting another action.',
  RUNNER_REPORT_REJECTED: 'The host runner report could not be accepted. Check the job detail before proceeding.',
};

export function composeSafeErrorMessage(code: string | null | undefined): string | null {
  if (code && Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, code)) {
    return SAFE_ERROR_MESSAGES[code as ComposeSafeErrorCode];
  }
  return null;
}

export function composeProblemMessage(problem: AdminApiProblem): string {
  const safeMessage = composeSafeErrorMessage(problem.code);
  if (safeMessage) return safeMessage;
  if (problem.status === 0) return 'The Admin API could not be reached. Refresh job history before retrying.';
  if (problem.status === 401) return 'Your Admin session expired. Sign in again before continuing.';
  if (problem.status === 403) return 'Your current Admin session cannot access host operations.';
  if (problem.status === 409) return 'The Compose target changed or became busy. Refresh it and request a new preview.';
  return `The Compose request failed (HTTP ${problem.status}).`;
}

export function composeFreshness(
  availability: ComposeCatalog['availability'],
  sampledAt: string | null,
  receivedAt: string | null,
  nowMs: number,
  staleAfterMs = COMPOSE_LOCAL_STALE_AFTER_MS,
): ComposeFreshness {
  if (availability === 'UNAVAILABLE') return 'unavailable';
  if (!sampledAt || !receivedAt || !Number.isFinite(Date.parse(sampledAt)) || !Number.isFinite(Date.parse(receivedAt))) return 'unknown';
  if (availability === 'STALE') return 'stale';
  const sampleAge = nowMs - Date.parse(sampledAt);
  const receiptAge = nowMs - Date.parse(receivedAt);
  if (sampleAge < 0 || receiptAge < 0) return 'unknown';
  return sampleAge > staleAfterMs || receiptAge > staleAfterMs ? 'stale' : 'fresh';
}

export function composeActionBlockReason(
  catalog: ComposeCatalog,
  project: ComposeCatalogProject,
  nowMs: number,
): string | null {
  if (!catalog.configured || !catalog.hostId || !catalog.manifestDigest) {
    return composeSafeErrorMessage(catalog.lastErrorCode) ?? 'Compose host configuration is unavailable.';
  }
  if (catalog.availability !== 'FRESH') {
    return composeSafeErrorMessage(catalog.lastErrorCode) ?? `Host catalog is ${catalog.availability.toLowerCase()}; actions are disabled.`;
  }
  if (project.availability !== 'FRESH') {
    return composeSafeErrorMessage(project.lastErrorCode) ?? `Project observation is ${project.availability.toLowerCase()}; actions are disabled.`;
  }
  if (!project.manifestDigest || project.manifestDigest !== catalog.manifestDigest) {
    return 'The project manifest digest does not match the current host catalog.';
  }
  if (!project.observedDigest || !project.sampledAt || !project.receivedAt) {
    return 'A fresh, complete host observation is required before an action can be previewed.';
  }
  if (composeFreshness(project.availability, project.sampledAt, project.receivedAt, nowMs) !== 'fresh'
      || composeFreshness(catalog.availability, catalog.receivedAt, catalog.receivedAt, nowMs) !== 'fresh') {
    return 'The last host observation is stale in this page; refresh before requesting a preview.';
  }
  if (project.activeJob) {
    return `Job ${project.activeJob.jobId} is ${project.activeJob.state.toLowerCase()} and holds this Compose project.`;
  }
  if (project.targetRevision < 0 || !Number.isSafeInteger(project.targetRevision)) {
    return 'The desired target revision is unavailable.';
  }
  return null;
}

export function composeReleasesForAction(
  project: ComposeCatalogProject,
  action: ComposeAction,
): ComposeCatalogProject['releases'] {
  if (action !== 'rollback_release') return project.releases;
  if (!project.desiredReleaseId) return [];
  const desiredReleaseId = project.desiredReleaseId;
  return project.releases.filter((release) => release.rollbackAllowedFrom.includes(desiredReleaseId));
}

export function composePreviewExpired(preview: ComposePreview, nowMs: number): boolean {
  const expiry = Date.parse(preview.expiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs;
}

export function composePreviewMatchesCurrent(
  preview: ComposePreview,
  catalog: ComposeCatalog,
  project: ComposeCatalogProject,
  nowMs: number,
): boolean {
  return !composePreviewExpired(preview, nowMs)
    && catalog.configured
    && catalog.hostId === preview.hostId
    && catalog.availability === 'FRESH'
    && project.projectId === preview.projectId
    && project.availability === 'FRESH'
    && project.manifestDigest === preview.manifestDigest
    && project.observedDigest === preview.observedDigest
    && project.targetRevision === preview.expectedTargetRevision
    && project.activeJob === null
    && composeActionBlockReason(catalog, project, nowMs) === null;
}

export function composeJobStateLabel(state: ComposeJobState): string {
  switch (state) {
    case 'QUEUED': return 'Queued';
    case 'CLAIMED': return 'Claimed by host runner';
    case 'RUNNING': return 'Running on host';
    case 'SUCCEEDED': return 'Succeeded and observed';
    case 'FAILED': return 'Failed';
    case 'PARTIAL': return 'Partial per-service result';
    case 'UNKNOWN': return 'Unknown execution outcome';
    case 'RECONCILED': return 'State reconciled';
  }
}

export function composeJobStateGuidance(state: ComposeJobState): string | null {
  switch (state) {
    case 'UNKNOWN': return 'The action may have taken effect. Do not resubmit. Ask the deployment operator to reconcile the host using the deployment runbook; this page does not provide a shell or retry action.';
    case 'RECONCILED': return 'The host state was reconciled. This does not turn an uncertain command outcome into a confirmed success.';
    case 'PARTIAL': return 'Review each service outcome and the observed after-state before planning another change.';
    case 'FAILED': return 'Review the safe error code and observed after-state before requesting another preview.';
    default: return null;
  }
}
