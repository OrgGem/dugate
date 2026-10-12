-- ORV14-INCIDENTS-UI: persistent source-bound incident state and scoped maintenance suppressions.
CREATE TABLE IF NOT EXISTS admin_incidents (
  incident_id uuid PRIMARY KEY,
  tenant_id text,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'tenant')),
  source text NOT NULL CHECK (source IN ('runtime','queue','connector','provider','delivery','deployment','maintenance')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 128),
  signal_code text NOT NULL CHECK (length(signal_code) BETWEEN 1 AND 128),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  status text NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  source_state text NOT NULL CHECK (source_state IN ('active','recovered','reconciled')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 3 AND 240),
  owner_id text CHECK (owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 128),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_sampled_at timestamptz NOT NULL,
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  threshold_revision text NOT NULL CHECK (length(threshold_revision) BETWEEN 1 AND 128),
  affected_resources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(affected_resources) = 'array'),
  counters jsonb CHECK (counters IS NULL OR jsonb_typeof(counters) = 'object'),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_evidence_ref text CHECK (resolution_evidence_ref IS NULL OR length(resolution_evidence_ref) <= 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'platform' AND tenant_id IS NULL) OR (scope_kind = 'tenant' AND tenant_id IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_incidents_active_dedupe
  ON admin_incidents(dedupe_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS admin_incidents_tenant_recent
  ON admin_incidents(tenant_id, last_seen_at DESC, incident_id DESC);
CREATE INDEX IF NOT EXISTS admin_incidents_source_recent
  ON admin_incidents(source, source_ref, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS admin_incident_events (
  event_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES admin_incidents(incident_id),
  kind text NOT NULL CHECK (kind IN ('detected','signal_repeated','source_recovered','reconciliation_confirmed','assigned','acknowledged','resolved')),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 240),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 128),
  source_state text CHECK (source_state IS NULL OR source_state IN ('active','recovered','reconciled')),
  details jsonb CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_incident_events_timeline
  ON admin_incident_events(incident_id, created_at ASC, event_id ASC);
CREATE INDEX IF NOT EXISTS admin_incident_events_resolution_evidence
  ON admin_incident_events(event_id, incident_id, kind)
  WHERE kind IN ('source_recovered','reconciliation_confirmed');

CREATE TABLE IF NOT EXISTS admin_maintenance_suppressions (
  suppression_id uuid PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform','tenant','service','queue','connector','operation')),
  scope_ref text CHECK (scope_ref IS NULL OR length(scope_ref) BETWEEN 1 AND 128),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK ((scope_kind = 'platform' AND scope_ref IS NULL) OR (scope_kind <> 'platform' AND scope_ref IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS admin_maintenance_suppressions_active
  ON admin_maintenance_suppressions(starts_at, expires_at DESC);
