import { PoolClient } from 'pg';
import { Db } from '../../db/db';
import { HttpError, conflict, notFound } from '../../http/errors';

/**
 * T-PROF-03 — publish / rollback over the `profile_active_revisions` pointer
 * (migration 0027).
 *
 * The whole module exists to uphold ONE invariant from migration 0027:
 * "the content of a revision" and "which revision is live" are two independent
 * facts. `profile_bindings` rows are immutable audit records; this file only
 * ever moves a pointer.
 *
 * ## The invariant that is easy to get wrong
 *
 * Migration 0027 carries this warning, and it is the highest-risk line in the
 * whole feature:
 *
 *   Every appended revision becomes active by default. `createRevision`
 *   inserts the new `profile_bindings` row AND (re)pins
 *   `profile_active_revisions` in the SAME transaction.
 *
 * Without it, a profile created by a create has no pointer row at all, and
 * `getEffectiveRevision` fails closed — submissions against brand-new profiles
 * break while everything else looks healthy. `pinActiveRevision` is therefore
 * exported and called from `createProfileService.createRevision`, not from
 * here alone.
 */

/**
 * Point `profile_id` at `revision`. MUST be called inside the same transaction
 * as the `profile_bindings` insert that created `revision`.
 *
 * The composite FK makes a pointer to a non-existent revision fail at the
 * database, so a caller cannot strand the pointer on a row that was rolled
 * back.
 */
export async function pinActiveRevision(
  client: PoolClient,
  profileId: string,
  revision: number
): Promise<void> {
  await client.query(
    `INSERT INTO profile_active_revisions (profile_id, revision, moved_at)
     VALUES ($1, $2, now())
     ON CONFLICT (profile_id)
     DO UPDATE SET revision = EXCLUDED.revision, moved_at = now()`,
    [profileId, revision]
  );
}

/**
 * Read the active revision for a profile.
 *
 * NEVER falls back to `MAX(revision)`. Migration 0027 invariant #3: "pointer
 * missing ⇔ no revisions exist". If the read path guessed, the pointer would
 * stop being the source of truth and a rollback would silently no-op — the one
 * failure mode the whole table exists to prevent.
 *
 * `null` therefore means exactly one thing: this profile has no revisions.
 */
export async function getEffectiveRevision(
  db: Db,
  profileId: string
): Promise<number | null> {
  const res = await db.query<{ revision: number }>(
    'SELECT revision FROM profile_active_revisions WHERE profile_id=$1',
    [profileId]
  );
  return res.rowCount ? res.rows[0]!.revision : null;
}

export interface RevisionMoveInput {
  profileId: string;
  /** CAS guard. When set, must equal the CURRENT active revision. */
  expectedRevision?: number;
  /** `undefined` for publish (move to the latest revision). */
  targetRevision?: number;
}

/**
 * Move the active pointer under a CAS guard.
 *
 * A stale `expectedRevision` is 409 `REVISION_CONFLICT` — the two operators
 * racing to publish are both owed an answer, and the loser's answer is "retry",
 * not "silently overwrite the winner".
 */
async function moveActiveRevision(
  client: PoolClient,
  input: RevisionMoveInput
): Promise<number> {
  // Lock the pointer row (or the absence of one) so two concurrent moves
  // serialize here instead of both reading the same "current" revision.
  const current = await client.query<{ revision: number }>(
    'SELECT revision FROM profile_active_revisions WHERE profile_id=$1 FOR UPDATE',
    [input.profileId]
  );

  if (input.expectedRevision !== undefined) {
    const actual = current.rowCount ? current.rows[0]!.revision : null;
    if (actual !== input.expectedRevision) {
      throw conflict(
        'REVISION_CONFLICT',
        `expected active revision ${input.expectedRevision} but the profile is at ` +
          `${actual === null ? 'no revision' : actual}`
      );
    }
  }

  const target =
    input.targetRevision ??
    (await client.query<{ m: number | null }>(
      'SELECT max(revision) AS m FROM profile_bindings WHERE profile_id=$1',
      [input.profileId]
    )).rows[0]?.m;

  if (target === null || target === undefined) {
    throw notFound('profile has no revisions to activate');
  }

  // The composite FK raises 23503 when the target does not exist, so a bad
  // rollback target is refused by the database rather than by a read path.
  await pinActiveRevision(client, input.profileId, target);
  return target;
}

export function createProfileRevisionService(db: Db) {
  return {
    async getEffectiveRevision(profileId: string): Promise<number | null> {
      return getEffectiveRevision(db, profileId);
    },

    /**
     * Activate the newest revision. `expectedRevision` is REQUIRED — publish is
     * a CAS move, and an unconditional publish lets two operators overwrite each
     * other.
     */
    async publishRevision(
      input: RevisionMoveInput & { expectedRevision: number },
      client?: PoolClient
    ): Promise<number> {
      const run = async (c: PoolClient) =>
        moveActiveRevision(c, { profileId: input.profileId, expectedRevision: input.expectedRevision });
      return client ? run(client) : db.tx(run);
    },

    /**
     * Re-point at an older revision. The target row is NOT modified, so a
     * rollback read is byte-identical to the original (R-03).
     */
    async rollbackTo(
      input: RevisionMoveInput & { targetRevision: number },
      client?: PoolClient
    ): Promise<number> {
      const run = async (c: PoolClient) =>
        moveActiveRevision(c, {
          profileId: input.profileId,
          expectedRevision: input.expectedRevision,
          targetRevision: input.targetRevision,
        });
      return client ? run(client) : db.tx(run);
    },
  };
}

export type ProfileRevisionService = ReturnType<typeof createProfileRevisionService>;

/** The 409 code the admin route surfaces for a stale CAS. Re-exported so the
 *  route and the service cannot drift on the spelling. */
export const REVISION_CONFLICT = 'REVISION_CONFLICT';

/** Narrow an unknown DB error to the composite-FK violation (unknown revision). */
export function isUnknownRevisionError(err: unknown): boolean {
  return err instanceof HttpError === false && (err as { code?: unknown })?.code === '23503';
}