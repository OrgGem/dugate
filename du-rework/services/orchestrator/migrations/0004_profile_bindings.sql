-- P2-02 / R08-02 profile-bound connector grants (W13-C).
-- API key -> authorized profile/action/version; the operation pins the
-- connector binding/revision at submit time; grant issuance uses the pin.
--
-- One immutable row per (profile_id, revision). A key is "in profile mode"
-- when at least one row names its api_key_id; keys with no rows stay on the
-- legacy path (manifest-declared slots + deployment connector opts) so
-- existing consumers keep working until they adopt profiles. This interim
-- policy is documented in coordination/reports/claude.md; the strict
-- end-state (every key profile-bound) is a follow-up once consumers migrate.
-- A revision change (new row, same profile_id) affects NEW submissions only;
-- in-flight operations keep the pin captured at submit (PRF-02).

CREATE TABLE IF NOT EXISTS profile_bindings (
  profile_id         uuid NOT NULL,
  revision           integer NOT NULL,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  api_key_id         uuid NOT NULL REFERENCES api_keys(id),
  business_id        text NOT NULL,
  business_version   text NOT NULL,
  action             text NOT NULL,
  -- slot -> { connectorId: string, revision: number }
  connector_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, revision)
);
CREATE INDEX IF NOT EXISTS profile_bindings_key_action
  ON profile_bindings (api_key_id, business_id, business_version, action, revision DESC);

-- Operation-time pin (immutable once written at submit).
ALTER TABLE operations ADD COLUMN IF NOT EXISTS profile_id uuid NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS profile_revision integer NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS connector_bindings jsonb NULL;
