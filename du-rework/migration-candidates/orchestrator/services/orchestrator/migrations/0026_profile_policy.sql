-- Profiles Tab Parity, phase 1 / T-DB-01: the storage the Profile policy tab
-- needs, ported from the legacy dugate `ProfileEndpoint` + `ExternalApiOverride`
-- + `UserProfileAssignment` tables.
--
-- The plan fixes every column below (see Phan 3 Nhom F, T-DB-01/T-DB-02 and
-- the self-review corrections in
-- coordination/reports/profile-parity-plan-self-review-2026-10-04.md). Where
-- the schema had a genuine choice, the choice and its reason are recorded here
-- rather than left implicit.
--
-- Additive only, matching the runner's contract (CREATE ... IF NOT EXISTS /
-- ALTER ... ADD COLUMN IF NOT EXISTS, no down-migrations in v1).

-- ## 1. Policy columns on `profile_bindings` — why NOT a child table
--
-- Chosen: extend `profile_bindings` in place (this block).
-- Rejected: a `profile_endpoint_policy` child table keyed by the same tuple.
--
-- A `profile_bindings` row IS already the (api_key, business@version, action)
-- tuple at a revision — the exact thing legacy's unique
-- `(apiKeyId, endpointSlug)` row was. A child table would put the policy one
-- join away from the row `resolveBinding` already reads on the submission hot
-- path (modules/operations/submission.ts:214), and would need its own revision
-- column that could disagree with the parent row's. Legacy's
-- `connectionsOverride`/`parameters`/`jobPriority` were all per-endpoint, i.e.
-- per-row, not per-profile.
--
-- Every ADD carries a DEFAULT so the existing rows created by 0004 (connector
-- bindings only) stay valid and keep their current semantics: an unconfigured
-- key stays in "legacy mode" and its bindings resolve exactly as before.

-- Legacy `enabled` (default true) — the toggle in the endpoint card. A
-- disabled endpoint is fail-closed at submit (T-SUB-02), never silently
-- ignored.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- Legacy `parameters`: `{ "<paramKey>": { "value": <any>, "isLocked": bool } }`.
-- jsonb (not text) because the legacy column was a JSON string we would
-- otherwise re-parse on every read. Contract shape lives in
-- packages/contracts/src/profile-policy.ts (ProfileEndpointPolicyWriteSchema);
-- the DB does NOT validate it — validation belongs at the contract boundary,
-- and a CHECK on jsonb keys would duplicate it badly.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS parameters jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Legacy `jobPriority` (LOW/MEDIUM/HIGH -> BullMQ 20/10/1). The CHECK is the
-- legacy VALID_PRIORITIES list, kept as a DB invariant because a wrong value
-- would silently dispatch at the wrong rate.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS job_priority text NOT NULL DEFAULT 'MEDIUM'
    CHECK (job_priority IN ('LOW', 'MEDIUM', 'HIGH'));

-- Legacy `allowedFileExtensions`: a CSV string, split on ',' and trimmed by the
-- legacy resolver. Stored verbatim (text, NOT an array) so the legacy
-- projection is byte-comparable; per self-review correction #3 the legacy code
-- only trim()s and never validates MIME types, so there is no CHECK to add and
-- the UI must not imply validation it does not get.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS allowed_file_extensions text NOT NULL DEFAULT '';

-- Legacy `fileUrlAuthConfig`, encrypted. See correction #1: the stored value is
-- the legacy crypto.ts wire form `iv_hex:tag_hex:ciphertext_hex`
-- (12-byte IV = 24 hex chars, 16-byte tag = 32 hex chars), NOT a JSON
-- envelope. Read path falls back to plain JSON when the value does not have
-- three parts (legacy wrote plaintext configs before crypto was enabled).
--
-- NULL means "not configured" — that is a real state the UI must render, not a
-- placeholder for an empty config.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS file_url_auth_cipher text NULL;

-- Legacy `connectionsOverride`: ConnectionStep[] when present, but the legacy
-- column also accepted a bare `string[]` of slugs (profile-resolver.ts
-- `parseConnectionSteps`). Stored as jsonb holding the normalized
-- ConnectionStep[] shape; the bare-slug form is normalized on write, not
-- preserved, because nothing in du-rework reads the legacy raw form.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS connections_override jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ## 2. T-SUB-02 snapshot column on `operations`
--
-- Chosen: a new `profile_policy_snapshot jsonb` column, captured at submit.
-- Rejected: overloading the existing `connector_bindings` pin with policy
-- fields, or a second snapshot table.
--
-- PRF-02 requires an operation to keep the exact policy it was admitted
-- under, and the worker must never query the live profile. The snapshot
-- therefore has to be written inside the same INSERT as
-- `profile_id`/`profile_revision`/`connector_bindings` (submission.ts:314-338),
-- before any task is created.
--
-- It is its own column rather than a merged blob because
-- `connector_bindings` has a different lifetime and a different consumer: it
-- is the grant-issuance pin (slot -> connectorId@revision), while the snapshot
-- is the admission-time record of enabled/parameters/lock/priority/file-url
-- auth/extensions/connections. Merging them would make the grant path unable
-- to read the pin without also parsing policy it does not use.
--
-- NULL on purpose: an operation submitted before this migration (or in legacy
-- mode, i.e. the api key had no profile_bindings rows at all) has no policy
-- snapshot. Consumers must not coalesce NULL into an empty policy — legacy
-- mode means "no profile policy applied", which is a different answer from
-- "an empty policy applied".
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS profile_policy_snapshot jsonb NULL;

-- ## 3. `connector_prompt_overrides` — legacy `ExternalApiOverride` (PAR-13)
--
-- Unique key mirrors legacy `ext_override_unique_idx`
-- (connectionId, apiKeyId, endpointSlug, stepId) with the legacy
-- `stepId DEFAULT '_default'` default preserved.
--
-- `connection_id uuid NOT NULL` with deliberately NO foreign key: du-rework has
-- no connections table (see the CREATE TABLE list — the Connector service owns
-- connection lifecycle; the platform only holds `connectorBaseUrls` config).
-- Adding a FK would require inventing a table outside this packet's scope, and
-- a dangling connection id must fail at call time (no such connector configured)
-- rather than be impossible to record. Correction #2 in the self-review: keep
-- this uuid-only, do NOT widen it to text to hold legacy's text ids.
CREATE TABLE IF NOT EXISTS connector_prompt_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  connection_id    uuid NOT NULL,
  api_key_id       uuid NOT NULL REFERENCES api_keys(id),
  endpoint_slug    text NOT NULL,
  step_id          text NOT NULL DEFAULT '_default',
  prompt_override  text,
  -- Legacy semantics (app/api/internal/ext-overrides/route.ts): posting
  -- isActive=false DELETES the row rather than parking it. The column is kept
  -- because the plan's action schema carries it, but a stored row always means
  -- active; the repository deletes instead of setting false. Documented here so
  -- nobody later "fixes" the delete into an update and strands rows.
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_prompt_overrides_unique
    UNIQUE (connection_id, api_key_id, endpoint_slug, step_id)
);

-- Read path: resolve the effective override for (api_key, endpoint) and filter
-- by step. The unique index above serves the upsert's conflict target but leads
-- with connection_id, which is not a read predicate.
CREATE INDEX IF NOT EXISTS connector_prompt_overrides_key_endpoint
  ON connector_prompt_overrides (api_key_id, endpoint_slug, step_id);

-- ## 4. `user_profile_assignments` — legacy `UserProfileAssignment`
--
-- Assigns a scoped USER to an api key (legacy `getAssignedProfileIds` reads
-- `apiKeyId`, not `profileId`, and `requireProfileAccess` gates on it). Kept
-- faithful to that: assigning by api_key_id is what makes a scoped user see
-- exactly the profiles bound to that key.
--
-- Both FKs ON DELETE RESTRICT: revoking an api key or deleting a local user
-- must not silently widen or erase another user's access surface. Deleting the
-- assignment is the explicit act.
--
-- This table is the storage for T-AUTH-03 / VFY-LOCAL. Until that gate closes,
-- no route may read it to grant access — scoped-user self-service stays
-- fail-closed with an explicit reason (see the plan's gate section).
CREATE TABLE IF NOT EXISTS user_profile_assignments (
  user_id     uuid NOT NULL REFERENCES admin_local_users(id) ON DELETE RESTRICT,
  api_key_id  uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, api_key_id)
);

-- Read path for the Admin API: "which users are assigned to this key".
CREATE INDEX IF NOT EXISTS user_profile_assignments_key_user
  ON user_profile_assignments (api_key_id, user_id);

-- ## Deliberately NOT backfilled
--
-- `docs/14-reference-compatibility.md` states the rework is a fresh project
-- with no data/credential migration from the legacy deployment, so there are no
-- legacy ProfileEndpoint / ExternalApiOverride / UserProfileAssignment rows to
-- import. The DEFAULTs above make every existing `profile_bindings` row read as
-- a fully-enabled, no-policy, MEDIUM-priority revision — which is exactly the
-- behavior those rows had before this migration, so resolution is unchanged.
