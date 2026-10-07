import type { AuditService } from '../audit/audit';
import type { AdminActionAuth } from '../admin-actions/rbac';
import { canRetireLegacyPayloads } from './legacy-payload-migration';
import type { MetadataReadPolicy } from './metadata-read-policy';
import {
  type MetadataBackfillProgress,
  type MetadataWindowMetrics,
} from './metadata-window-metrics';

export type MetadataWindowControlErrorCode =
  | 'WINDOW_NOT_ACTIVE'
  | 'OPERATOR_AUTH_REQUIRED'
  | 'WINDOW_NOT_READY'
  | 'AUDIT_REQUIRED';

export class MetadataWindowControlError extends Error {
  constructor(
    readonly code: MetadataWindowControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MetadataWindowControlError';
  }
}

export interface MetadataWindowCloseAuthorization {
  readonly nextMode: 'forbid';
  readonly restartRequired: true;
  readonly window: { readonly startsAtMs: number; readonly expiresAtMs: number };
  readonly auditEventId: string;
  readonly authorizedBy: { readonly issuer: string; readonly subject: string };
}

export interface MetadataWindowControlOptions {
  readonly policy: MetadataReadPolicy;
  readonly metrics: MetadataWindowMetrics;
  readonly audit: Pick<AuditService, 'record'>;
  /** Must resolve credentials from trusted server-side auth, including CSRF. */
  readonly resolveAuth: (
    headers: Record<string, string | undefined>,
  ) => Promise<AdminActionAuth | null>;
  readonly now?: () => number;
}

type StablePlatformOperator = Extract<AdminActionAuth, { kind: 'cookie' }> & {
  readonly role: 'admin';
  readonly csrfOk: true;
  readonly principalId: string;
  readonly issuer: string;
};

function isStablePlatformOperator(auth: AdminActionAuth | null): auth is StablePlatformOperator {
  return auth !== null
    && auth.kind === 'cookie'
    && auth.role === 'admin'
    && auth.csrfOk
    && typeof auth.principalId === 'string'
    && auth.principalId.length > 0
    && typeof auth.issuer === 'string'
    && auth.issuer.length > 0;
}

/**
 * Explicit, audited approval for the next boot to use `forbid`.
 *
 * This deliberately does not mutate the immutable, boot-built read policy.
 * Design §5 requires an environment change plus restart; a runtime auto-flip
 * would create a partially closed deployment. No timer or metric callback
 * invokes requestCloseForNextBoot.
 */
export function createMetadataWindowControl(options: MetadataWindowControlOptions) {
  const now = options.now ?? Date.now;
  let latestProgress: MetadataBackfillProgress | undefined;

  return Object.freeze({
    recordBackfillProgress(progress: MetadataBackfillProgress): void {
      options.metrics.recordBackfillProgress(progress);
      latestProgress = Object.freeze({ ...progress });
    },

    async requestCloseForNextBoot(
      headers: Record<string, string | undefined>,
      confirmation: { readonly backupSignedOff: boolean },
    ): Promise<MetadataWindowCloseAuthorization> {
      const { policy } = options;
      const window = policy.window;
      if (policy.mode !== 'window' || window === null || !window.allowsLegacyRead(now())) {
        throw new MetadataWindowControlError(
          'WINDOW_NOT_ACTIVE',
          'metadata read window is not active; no close request was recorded',
        );
      }

      const auth = await options.resolveAuth(headers);
      if (!isStablePlatformOperator(auth)) {
        throw new MetadataWindowControlError(
          'OPERATOR_AUTH_REQUIRED',
          'a CSRF-verified platform admin session with a server-side subject is required',
        );
      }

      const progress = latestProgress;
      if (
        progress === undefined
        || progress.state !== 'complete'
        || progress.unresolvedReferences !== 0
        || progress.blockers !== 0
        || !canRetireLegacyPayloads(
          { unresolvedReferences: progress.unresolvedReferences },
          confirmation.backupSignedOff,
        )
      ) {
        throw new MetadataWindowControlError(
          'WINDOW_NOT_READY',
          'metadata window close requires complete backfill, zero unresolved references and blockers, and signed backup approval',
        );
      }

      const resource = `metadata-read-window:${window.startsAtMs}:${window.expiresAtMs}`;
      let auditEvent: { id: string };
      try {
        auditEvent = await options.audit.record({
          tenantId: null,
          actor: 'admin',
          actorIssuer: auth.issuer,
          actorSub: auth.principalId,
          actorRole: auth.role,
          action: 'metadata_read.window_close_requested',
          resource,
          severity: 'warning',
        });
      } catch {
        throw new MetadataWindowControlError(
          'AUDIT_REQUIRED',
          'metadata window close was not authorized because its audit record could not be written',
        );
      }

      return Object.freeze({
        nextMode: 'forbid',
        restartRequired: true,
        window: Object.freeze({ startsAtMs: window.startsAtMs, expiresAtMs: window.expiresAtMs }),
        auditEventId: auditEvent.id,
        authorizedBy: Object.freeze({ issuer: auth.issuer, subject: auth.principalId }),
      });
    },
  });
}
