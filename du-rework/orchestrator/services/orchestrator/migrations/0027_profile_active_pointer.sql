-- Profiles Tab Parity, phase 1 / T-DB-02: the "active revision" pointer for a
-- profile (plan Phan 5, T-DB-02). publish/rollback move this pointer;
-- `profile_bindings` rows themselves stay immutable (append-only, one row per
-- (profile_id, revision)).
--
-- ## The choice: a pointer TABLE, not an `is_active` column
--
-- Chosen: `profile_active_revisions`, one row per profile_id.
-- Rejected: `ALTER TABLE profile_bindings ADD COLUMN is_active boolean` with a
-- partial unique index — the pattern 0006 used for `business_versions`.
--
-- Why the 0006 pattern does not port: 0006's `business_versions` row IS the
-- version (status lives on the same row). A `profile_bindings` revision is
-- contractually immutable — 0004 documents "One immutable row per
-- (profile_id, revision)", and a rollback to revision N must yield byte-identical
-- data on read. Putting `is_active` on the row means every publish/rollback
-- rewrites a row that is supposed to be an immutable audit record, and it makes
-- the pointer's history unrecoverable (moved_at would have nowhere to live).
-- A side table keeps "the revision's content" and "which revision is live" as
-- two facts that can change independently, which is the whole point of
-- publish-vs-append.
--
-- ## Composite FK, not a single-column FK
--
-- `profile_bindings`' primary key is (profile_id, revision), so a foreign key
-- on `profile_id` alone is impossible: there is no unique index on profile_id
-- by itself (that would wrongly forbid multiple revisions of the same profile).
-- The FK is therefore on the composite pair and points at the actual PK, with
-- ON DELETE RESTRICT so an active revision can never be orphaned by a row
-- deletion. Re-pinning to a revision that does not exist fails at the database
-- rather than at read time.
CREATE TABLE IF NOT EXISTS profile_active_revisions (
  profile_id uuid   NOT NULL,
  revision   integer NOT NULL,
  moved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id),
  CONSTRAINT profile_active_revisions_revision_fk
    FOREIGN KEY (profile_id, revision)
    REFERENCES profile_bindings (profile_id, revision)
    ON DELETE RESTRICT
);

-- ## Backfill: highest existing revision per profile
--
-- Chosen: max(revision). Rejected: first row, or no backfill.
--
-- The invariant this file establishes is stated below and must be preserved by
-- every later writer. It is the same resolution semantics `profiles.resolveBinding`
-- has today (`ORDER BY revision DESC LIMIT 1`), so seeding the pointer from
-- MAX(revision) makes the pointer a no-op on the day it lands: reads that switch
-- to it in a later phase return exactly what they return now.
--
-- ON CONFLICT DO NOTHING makes the backfill re-runnable, matching the
-- additive-only runner (a re-run must not yank a pointer an operator has since
-- moved).
INSERT INTO profile_active_revisions (profile_id, revision)
SELECT profile_id, max(revision)
FROM profile_bindings
GROUP BY profile_id
ON CONFLICT DO NOTHING;

-- ## Invariant the implementing code MUST uphold (phase 2)
--
-- 1. Every appended revision becomes active by default. `createRevision`
--    inserts the new `profile_bindings` row AND (re)pins
--    `profile_active_revisions` in the SAME transaction, so a profile created
--    by a create always resolves to its own new revision. Without this, a
--    brand-new profile_id would have no pointer row at all and resolution
--    would fail closed.
-- 2. publish/rollback UPDATE the pointer only; they never modify
--    `profile_bindings`.
-- 3. Pointer missing <=> no revisions exist for that profile. The read path
--    must distinguish "no pointer, no revisions" (404 / legacy mode) from
--    "pointer row present" — it must never fall back to MAX(revision), or the
--    pointer stops being the source of truth and rollback silently no-ops.
--
-- Recorded here because the risk is real: if phase 2 switches the
-- `resolveBinding` read to this table without (1), every new profile resolves
-- to a stale or absent pointer while submissions keep working against the old
-- MAX semantics in a different code path.
