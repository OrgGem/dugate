-- Membership: WHICH API keys belong to a profile.
--
-- Before this file the relationship was implicit and effectively 1:1.
-- `profile_bindings.api_key_id` records the key that WROTE a revision, and
-- the request path resolved a profile by `WHERE p.api_key_id = $1`, so a
-- profile was only reachable through the key of its own revision: issuing a
-- second key for one profile created a SECOND profile_id instead of a second
-- credential, and the admin read (profile_names by name, most recently moved
-- pointer wins) was ambiguous the moment two keys shared a name.
--
-- `profile_bindings.api_key_id` stays exactly as it is: it is the audit fact
-- "this key authored this revision", and rotation must not rewrite history.
--
-- Backfill source: DISTINCT profile_bindings, NOT profile_names.api_key_id.
-- Membership has always meant "every key that authored a revision of this
-- profile"; seeding only the registry key would silently strip access from
-- keys that were legitimately in the set - a behaviour change dressed up as a
-- migration.
--
-- No FK on profile_id: the 0028 registry does not cover profiles created
-- BEFORE 0028 (no backfill shipped with it), so an FK to profile_names would
-- abort this migration on exactly the rows it exists to preserve. Adding that
-- FK later requires a profile_names backfill first.
CREATE TABLE IF NOT EXISTS profile_api_keys (
  profile_id uuid NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  state      text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (profile_id, api_key_id)
);

-- Hot path: "this key -> which profile(s) may it use for this action". state is
-- in the index so a REVOKED membership stops resolving without a second probe.
CREATE INDEX IF NOT EXISTS profile_api_keys_key_lookup
  ON profile_api_keys (api_key_id, state);

CREATE INDEX IF NOT EXISTS profile_api_keys_tenant_profile
  ON profile_api_keys (tenant_id, profile_id);

-- Re-runnable on purpose: the runner records one sequence, but a hand re-run
-- inside a live window must not duplicate rows. `WHERE true` disambiguates
-- ON CONFLICT from the SELECT's own ON clause (Postgres' documented trap for
-- INSERT ... SELECT ... ON CONFLICT).
INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
SELECT DISTINCT b.profile_id, b.api_key_id, b.tenant_id, 'ACTIVE'
  FROM profile_bindings b
 WHERE true
 ON CONFLICT (profile_id, api_key_id) DO NOTHING;
