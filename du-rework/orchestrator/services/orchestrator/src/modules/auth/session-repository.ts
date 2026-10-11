import type { SessionRecord } from './session-store';

/** Storage contract for opaque admin sessions. */
export interface SessionRepository {
  get(sessionId: string): Promise<SessionRecord | null>;
  /** Upsert for newly created/rotated session ids. */
  set(session: SessionRecord): Promise<void>;
  /**
   * Atomically touch a session only while this session generation still
   * exists. Persistent/shared repositories must implement this operation;
   * the store has a serialized compatibility path for single-process adapters.
   */
  touchIfExists?(expected: SessionRecord, lastSeenAt: number): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<boolean>;
  /** Index-by-principal is a deployment choice; absence fails closed. */
  revokePrincipal?(issuer: string, sub: string): Promise<number>;
}
