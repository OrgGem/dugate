import { createHmac, randomBytes } from 'node:crypto';

export const DEFAULT_LOCAL_LOGIN_GUARD_OPTIONS = Object.freeze({
  maxAttemptsPerWindow: 20,
  windowMs: 60_000,
  maxFailures: 5,
  lockoutMs: 15 * 60_000,
  maxSubjects: 10_000,
});

const MAX_CONFIGURED_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CONFIGURED_SUBJECTS = 100_000;
const MAX_SUBJECT_BYTES = 512;

export type LoginGuardDecisionReason =
  | 'allowed'
  | 'locked'
  | 'rate-limited'
  | 'capacity'
  | 'invalid-subject';

export interface LoginGuardDecision {
  allowed: boolean;
  reason: LoginGuardDecisionReason;
  retryAfterMs: number;
}

export interface LocalLoginGuard {
  /** Reserve one attempt before any account lookup or password comparison. */
  beginAttempt(subjectKey: string): Promise<LoginGuardDecision>;
  /** Record a failed password check and start lockout at the configured threshold. */
  recordFailure(subjectKey: string): Promise<LoginGuardDecision>;
  /** Clear all in-memory attempt state after a successful authentication. */
  recordSuccess(subjectKey: string): Promise<void>;
}

export interface LocalLoginGuardOptions {
  maxAttemptsPerWindow?: number;
  windowMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
  maxSubjects?: number;
  now?: () => number;
}

interface SubjectState {
  attemptWindowStartedAt: number;
  attempts: number;
  failureWindowStartedAt: number;
  failures: number;
  lockedUntil: number | null;
}

interface ResolvedOptions {
  maxAttemptsPerWindow: number;
  windowMs: number;
  maxFailures: number;
  lockoutMs: number;
  maxSubjects: number;
  now: () => number;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function deny(reason: LoginGuardDecisionReason, retryAfterMs = 0): LoginGuardDecision {
  return { allowed: false, reason, retryAfterMs: Math.max(0, retryAfterMs) };
}

function allow(): LoginGuardDecision {
  return { allowed: true, reason: 'allowed', retryAfterMs: 0 };
}

function resolveOptions(options: LocalLoginGuardOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    maxAttemptsPerWindow:
      options.maxAttemptsPerWindow ?? DEFAULT_LOCAL_LOGIN_GUARD_OPTIONS.maxAttemptsPerWindow,
    windowMs: options.windowMs ?? DEFAULT_LOCAL_LOGIN_GUARD_OPTIONS.windowMs,
    maxFailures: options.maxFailures ?? DEFAULT_LOCAL_LOGIN_GUARD_OPTIONS.maxFailures,
    lockoutMs: options.lockoutMs ?? DEFAULT_LOCAL_LOGIN_GUARD_OPTIONS.lockoutMs,
    maxSubjects: options.maxSubjects ?? DEFAULT_LOCAL_LOGIN_GUARD_OPTIONS.maxSubjects,
    now: options.now ?? Date.now,
  };

  if (
    !isPositiveSafeInteger(resolved.maxAttemptsPerWindow) ||
    !isPositiveSafeInteger(resolved.windowMs) ||
    !isPositiveSafeInteger(resolved.maxFailures) ||
    !isPositiveSafeInteger(resolved.lockoutMs) ||
    !isPositiveSafeInteger(resolved.maxSubjects) ||
    resolved.maxFailures > resolved.maxAttemptsPerWindow ||
    resolved.windowMs > MAX_CONFIGURED_WINDOW_MS ||
    resolved.lockoutMs > MAX_CONFIGURED_WINDOW_MS ||
    resolved.maxSubjects > MAX_CONFIGURED_SUBJECTS
  ) {
    throw new Error('Local login guard configuration is invalid');
  }

  return resolved;
}

/**
 * Bounded process-local limiter/lockout primitive. Subject keys are HMACed with
 * an instance-only random key before being retained. Capacity exhaustion denies
 * new subjects until expired entries can be reclaimed.
 */
export function createLocalLoginGuard(options: LocalLoginGuardOptions = {}): LocalLoginGuard {
  const resolved = resolveOptions(options);
  const hmacKey = randomBytes(32);
  const subjects = new Map<string, SubjectState>();

  const digestSubject = (subjectKey: string): string | null => {
    if (
      typeof subjectKey !== 'string' ||
      Buffer.byteLength(subjectKey, 'utf8') === 0 ||
      Buffer.byteLength(subjectKey, 'utf8') > MAX_SUBJECT_BYTES
    ) {
      return null;
    }
    return createHmac('sha256', hmacKey).update(subjectKey, 'utf8').digest('hex');
  };

  const readNow = (): number | null => {
    try {
      const now = resolved.now();
      return Number.isSafeInteger(now) && now >= 0 &&
        now <= Number.MAX_SAFE_INTEGER - MAX_CONFIGURED_WINDOW_MS
        ? now
        : null;
    } catch {
      return null;
    }
  };

  const normalize = (state: SubjectState, now: number): void => {
    if (state.lockedUntil !== null && now >= state.lockedUntil) {
      state.lockedUntil = null;
      state.failures = 0;
      state.failureWindowStartedAt = now;
    }
    if (now >= state.attemptWindowStartedAt + resolved.windowMs) {
      state.attemptWindowStartedAt = now;
      state.attempts = 0;
    }
    if (now >= state.failureWindowStartedAt + resolved.windowMs) {
      state.failureWindowStartedAt = now;
      state.failures = 0;
    }
  };

  const pruneExpired = (now: number): void => {
    for (const [digest, state] of subjects) {
      const notLocked = state.lockedUntil === null || now >= state.lockedUntil;
      const attemptWindowExpired = now >= state.attemptWindowStartedAt + resolved.windowMs;
      const failureWindowExpired = now >= state.failureWindowStartedAt + resolved.windowMs;
      if (notLocked && attemptWindowExpired && failureWindowExpired) subjects.delete(digest);
    }
  };

  const getOrCreate = (digest: string, now: number): SubjectState | null => {
    const existing = subjects.get(digest);
    if (existing) {
      normalize(existing, now);
      return existing;
    }
    if (subjects.size >= resolved.maxSubjects) return null;
    const created: SubjectState = {
      attemptWindowStartedAt: now,
      attempts: 0,
      failureWindowStartedAt: now,
      failures: 0,
      lockedUntil: null,
    };
    subjects.set(digest, created);
    return created;
  };

  return {
    async beginAttempt(subjectKey): Promise<LoginGuardDecision> {
      const digest = digestSubject(subjectKey);
      const now = readNow();
      if (!digest || now === null) return deny('invalid-subject');
      pruneExpired(now);

      const state = getOrCreate(digest, now);
      if (!state) return deny('capacity', resolved.windowMs);
      if (state.lockedUntil !== null && now < state.lockedUntil) {
        return deny('locked', state.lockedUntil - now);
      }
      if (state.attempts >= resolved.maxAttemptsPerWindow) {
        return deny(
          'rate-limited',
          state.attemptWindowStartedAt + resolved.windowMs - now,
        );
      }

      state.attempts += 1;
      return allow();
    },

    async recordFailure(subjectKey): Promise<LoginGuardDecision> {
      const digest = digestSubject(subjectKey);
      const now = readNow();
      if (!digest || now === null) return deny('invalid-subject');
      pruneExpired(now);

      const state = getOrCreate(digest, now);
      if (!state) return deny('capacity', resolved.windowMs);
      if (state.lockedUntil !== null && now < state.lockedUntil) {
        return deny('locked', state.lockedUntil - now);
      }
      if (now >= state.failureWindowStartedAt + resolved.windowMs) {
        state.failureWindowStartedAt = now;
        state.failures = 0;
      }

      state.failures += 1;
      if (state.failures >= resolved.maxFailures) {
        state.lockedUntil = now + resolved.lockoutMs;
        return deny('locked', resolved.lockoutMs);
      }
      return allow();
    },

    async recordSuccess(subjectKey): Promise<void> {
      const digest = digestSubject(subjectKey);
      if (digest) subjects.delete(digest);
    },
  };
}
