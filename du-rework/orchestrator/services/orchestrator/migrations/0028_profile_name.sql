-- P730-ADMIN-MUTATE (Δ7 ruling (A)): the
-- (tenant, api key, business, version, action, profile_name) -> profile_id
-- registry that lets `profile.upsert` address a profile by its published NAME.
--
-- Why a registry TABLE rather than a `profile_name` column on
-- `profile_bindings`:
--   1. `profile_bindings` is append-only, one immutable row per
--      (profile_id, revision). A UNIQUE key spanning the name tuple would
--      forbid appending revision N+1 of the very profile it identifies, so the
--      constraint cannot live there.
--   2. The write path that owns this identity is the dispatcher leaf
--      (`modules/admin-actions/profile-actions.ts`); keeping it in its own
--      table preserves the single-writer boundary on `profiles.ts`.
--
-- The unique index IS the race guard: two concurrent first-saves of the same
-- name serialize on it instead of creating two profile_ids for one name. The
-- leaf resolves via this table BEFORE any write, per the Δ7-A ruling.
--
-- Additive only, matching the runner's contract (CREATE ... IF NOT EXISTS, no
-- down-migrations in v1).

CREATE TABLE IF NOT EXISTS profile_names (
  profile_id       uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  api_key_id       uuid NOT NULL REFERENCES api_keys(id),
  business_id      text NOT NULL,
  business_version text NOT NULL,
  action           text NOT NULL,
  profile_name     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_names_identity
  ON profile_names (tenant_id, api_key_id, business_id, business_version, action, profile_name);
