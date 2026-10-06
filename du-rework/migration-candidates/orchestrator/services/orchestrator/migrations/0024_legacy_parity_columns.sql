-- COMP-08/07 legacy wire parity: the columns the legacy response envelope
-- reads, on the columns the legacy list/billing routes read.
--
-- Every ADD is IF NOT EXISTS so this is re-runnable, matching the runner's
-- additive-only contract (no down-migrations in v1).
--
-- ## Why the columns live on `operations` and not a side table
--
-- The legacy formatter (`lib/pipelines/format.ts:17-73`) read them straight
-- off the operation row, and the legacy billing routes aggregated them per
-- API key. Projecting from a side table would be a schema redesign; adding the
-- columns keeps the compat path a plain SELECT, which is what makes a
-- golden-fixture comparison meaningful.
--
-- ## Nullable on purpose
--
-- `result_ref` already carries the canonical artifact pointer, so these are
-- NOT the system of record for content — they are the legacy projection
-- surface. A NULL here means "the canonical path has no legacy projection";
-- it never means zero cost or zero tokens. Callers must not coalesce a NULL
-- into 0 for a SUCCEEDED operation, because legacy emitted the column's real
-- value and a fabricated 0 reads as "this call was free".
--
-- ## Deliberately NOT backfilled
--
-- There is no legacy data to import: the legacy database is a separate
-- deployment and `docs/14-reference-compatibility.md` states the rework is a
-- fresh project with no data/credential migration. Backfilling 0 would make
-- billing report zero spend for every pre-existing operation, which is a lie
-- a client cannot distinguish from a real measurement.

-- Soft delete: the legacy routes treated a row with deleted_at set as absent
-- in list, by-id, download and cancel alike.
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Legacy metadata projection (`metadata.*` on every operation response).
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS pipeline_json jsonb,
  ADD COLUMN IF NOT EXISTS steps_result_json jsonb,
  ADD COLUMN IF NOT EXISTS current_step integer,
  ADD COLUMN IF NOT EXISTS progress_percent integer,
  ADD COLUMN IF NOT EXISTS progress_message text,
  ADD COLUMN IF NOT EXISTS endpoint_slug text;

-- Legacy `result` block (emitted only when done && state = 'SUCCEEDED').
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS output_format text,
  ADD COLUMN IF NOT EXISTS output_content text,
  ADD COLUMN IF NOT EXISTS extracted_data jsonb,
  ADD COLUMN IF NOT EXISTS output_file_path text,
  ADD COLUMN IF NOT EXISTS declared_filename text;

-- Legacy `usage` block. numeric(20,6) for cost: legacy summed fractional
-- USD per operation and a float column would drift across many rows.
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS total_input_tokens bigint,
  ADD COLUMN IF NOT EXISTS total_output_tokens bigint,
  ADD COLUMN IF NOT EXISTS pages_processed integer,
  ADD COLUMN IF NOT EXISTS model_used text,
  ADD COLUMN IF NOT EXISTS total_cost_usd numeric(20,6),
  ADD COLUMN IF NOT EXISTS usage_breakdown jsonb;

-- Legacy `error` block (emitted only when done && state = 'FAILED').
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS failed_at_step integer;

-- `api_key_name` for the billing balance response. Kept alongside the key
-- row so a renamed key still names the operations it billed.

-- Legacy per-API-KEY balance. NOT derivable from tenant usage: legacy read
-- `spending_limit - total_used` from the api_keys row, and
-- `docs/06-public-api.md:29` plus API-COMPAT-DUGATE-2026-09-28.md:57 both
-- forbid substituting a tenant total for a key total.
--
-- `spending_limit = 0` (the default) means "no limit set", which is why the
-- legacy balance route returns a NULL balance in that case rather than
-- `-total_used`.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS spending_limit numeric(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_used numeric(20,6) NOT NULL DEFAULT 0;

-- The list route orders by created_at and walks a keyset keyed on
-- (created_at, id); a partial index keeps that scan off the soft-deleted rows
-- without changing the canonical composite index that ADM-UX-02 relies on.
CREATE INDEX IF NOT EXISTS operations_tenant_created_undeleted
  ON operations (tenant_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- billing/usage aggregates per key over a created_at range.
CREATE INDEX IF NOT EXISTS operations_api_key_created
  ON operations (api_key_id, created_at);
