-- Add OIDC Admin recipients to the first-party cost-alert inbox without
-- rewriting local-owner history. OIDC issuer/subject are authentication keys
-- only: no browser DTO exposes either field and no local-user UUID is minted
-- from them. The resource tenant remains on each binding/alert/delivery.

CREATE TABLE IF NOT EXISTS cost_alert_oidc_recipients (
  principal_id uuid PRIMARY KEY,
  display_code text NOT NULL UNIQUE CHECK (display_code ~ '^[A-F0-9]{10}$'),
  issuer text COLLATE "C" NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  subject text COLLATE "C" NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  observed_role text NOT NULL CHECK (observed_role IN ('admin','operator','viewer')),
  observed_tenant_id uuid,
  state text NOT NULL CHECK (state IN ('ENABLED','DISABLED','REVOKED')),
  authorization_version bigint NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
  last_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer,subject)
);

CREATE INDEX IF NOT EXISTS cost_alert_oidc_recipients_catalog
  ON cost_alert_oidc_recipients (principal_id)
  WHERE state='ENABLED' AND observed_role='admin' AND observed_tenant_id IS NULL;

CREATE TABLE IF NOT EXISTS cost_alert_oidc_recipient_audit (
  audit_id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('DISABLE','ENABLE','REVOKE')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  previous_state text NOT NULL CHECK (previous_state IN ('ENABLED','DISABLED','REVOKED')),
  next_state text NOT NULL CHECK (next_state IN ('ENABLED','DISABLED','REVOKED')),
  previous_authorization_version bigint NOT NULL CHECK (previous_authorization_version >= 1),
  next_authorization_version bigint NOT NULL CHECK (next_authorization_version > previous_authorization_version),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cost_alert_oidc_recipient_commands (
  principal_id uuid NOT NULL REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id,idempotency_key)
);

-- Existing local references remain valid and historical rows stay local.
ALTER TABLE cost_budget_alert_bindings ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE cost_budget_alert_bindings
  ADD COLUMN IF NOT EXISTS owner_recipient_kind text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS owner_oidc_principal_id uuid,
  ADD COLUMN IF NOT EXISTS owner_authorization_version bigint;
ALTER TABLE cost_budget_alert_bindings
  ADD CONSTRAINT cost_budget_alert_bindings_oidc_recipient_fk
    FOREIGN KEY (owner_oidc_principal_id) REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT cost_budget_alert_bindings_recipient_shape CHECK (
    (owner_recipient_kind='local' AND owner_user_id IS NOT NULL AND owner_oidc_principal_id IS NULL AND owner_authorization_version IS NULL)
    OR (owner_recipient_kind='oidc' AND owner_user_id IS NULL AND owner_oidc_principal_id IS NOT NULL AND owner_authorization_version BETWEEN 1 AND 9007199254740991)
  );

ALTER TABLE cost_budget_alert_binding_history ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE cost_budget_alert_binding_history
  ADD COLUMN IF NOT EXISTS owner_recipient_kind text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS owner_oidc_principal_id uuid,
  ADD COLUMN IF NOT EXISTS owner_authorization_version bigint;
ALTER TABLE cost_budget_alert_binding_history
  ADD CONSTRAINT cost_budget_alert_binding_history_oidc_recipient_fk
    FOREIGN KEY (owner_oidc_principal_id) REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT cost_budget_alert_binding_history_recipient_shape CHECK (
    (owner_recipient_kind='local' AND owner_user_id IS NOT NULL AND owner_oidc_principal_id IS NULL AND owner_authorization_version IS NULL)
    OR (owner_recipient_kind='oidc' AND owner_user_id IS NULL AND owner_oidc_principal_id IS NOT NULL AND owner_authorization_version BETWEEN 1 AND 9007199254740991)
  );

-- Replace the two old owner-shape checks with a discriminated local/OIDC
-- equivalent while preserving the existing ROUTED/UNROUTED invariant.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='cost_budget_alerts'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%owner_user_id%'
  LOOP
    EXECUTE format('ALTER TABLE cost_budget_alerts DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;

ALTER TABLE cost_budget_alerts ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE cost_budget_alerts
  ADD COLUMN IF NOT EXISTS owner_recipient_kind text,
  ADD COLUMN IF NOT EXISTS owner_oidc_principal_id uuid,
  ADD COLUMN IF NOT EXISTS owner_authorization_version bigint;
UPDATE cost_budget_alerts
   SET owner_recipient_kind=CASE WHEN owner_user_id IS NULL THEN NULL ELSE 'local' END
 WHERE owner_recipient_kind IS NULL;
ALTER TABLE cost_budget_alerts
  ADD CONSTRAINT cost_budget_alerts_oidc_recipient_fk
    FOREIGN KEY (owner_oidc_principal_id) REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT cost_budget_alerts_recipient_routing_shape CHECK (
    (routing_state='ROUTED' AND binding_revision IS NOT NULL AND owner_display_name IS NOT NULL
      AND jsonb_array_length(channel_refs)>0 AND (
        (owner_recipient_kind='local' AND owner_user_id IS NOT NULL AND owner_oidc_principal_id IS NULL AND owner_authorization_version IS NULL)
        OR (owner_recipient_kind='oidc' AND owner_user_id IS NULL AND owner_oidc_principal_id IS NOT NULL AND owner_authorization_version BETWEEN 1 AND 9007199254740991)
      ))
    OR (routing_state='UNROUTED' AND (
      (owner_user_id IS NULL AND owner_oidc_principal_id IS NULL AND owner_display_name IS NULL
        AND owner_recipient_kind IS NULL AND owner_authorization_version IS NULL)
      OR (owner_display_name IS NOT NULL AND (
        (owner_recipient_kind='local' AND owner_user_id IS NOT NULL AND owner_oidc_principal_id IS NULL AND owner_authorization_version IS NULL)
        OR (owner_recipient_kind='oidc' AND owner_user_id IS NULL AND owner_oidc_principal_id IS NOT NULL AND owner_authorization_version BETWEEN 1 AND 9007199254740991)
      ))
    ))
  );

ALTER TABLE cost_alert_deliveries ALTER COLUMN recipient_user_id DROP NOT NULL;
ALTER TABLE cost_alert_deliveries
  ADD COLUMN IF NOT EXISTS recipient_kind text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS recipient_oidc_principal_id uuid,
  ADD COLUMN IF NOT EXISTS recipient_authorization_version bigint;
ALTER TABLE cost_alert_deliveries
  ADD CONSTRAINT cost_alert_deliveries_oidc_recipient_fk
    FOREIGN KEY (recipient_oidc_principal_id) REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT cost_alert_deliveries_recipient_shape CHECK (
    (recipient_kind='local' AND recipient_user_id IS NOT NULL AND recipient_oidc_principal_id IS NULL AND recipient_authorization_version IS NULL)
    OR (recipient_kind='oidc' AND recipient_user_id IS NULL AND recipient_oidc_principal_id IS NOT NULL AND recipient_authorization_version BETWEEN 1 AND 9007199254740991)
  );

ALTER TABLE cost_alert_inbox ALTER COLUMN recipient_user_id DROP NOT NULL;
ALTER TABLE cost_alert_inbox
  ADD COLUMN IF NOT EXISTS recipient_kind text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS recipient_oidc_principal_id uuid,
  ADD COLUMN IF NOT EXISTS recipient_authorization_version bigint;
ALTER TABLE cost_alert_inbox
  ADD CONSTRAINT cost_alert_inbox_oidc_recipient_fk
    FOREIGN KEY (recipient_oidc_principal_id) REFERENCES cost_alert_oidc_recipients(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT cost_alert_inbox_recipient_shape CHECK (
    (recipient_kind='local' AND recipient_user_id IS NOT NULL AND recipient_oidc_principal_id IS NULL AND recipient_authorization_version IS NULL)
    OR (recipient_kind='oidc' AND recipient_user_id IS NULL AND recipient_oidc_principal_id IS NOT NULL AND recipient_authorization_version BETWEEN 1 AND 9007199254740991)
  );

CREATE INDEX IF NOT EXISTS cost_alert_inbox_oidc_owner_created
  ON cost_alert_inbox (tenant_id,recipient_oidc_principal_id,delivered_at DESC,delivery_id DESC)
  WHERE recipient_kind='oidc';

-- A frozen recipient that is no longer eligible is held with an explicit
-- error. It is never silently redirected to the binding's newer owner.
ALTER TABLE cost_alert_deliveries
  DROP CONSTRAINT IF EXISTS cost_alert_deliveries_state_check,
  ADD CONSTRAINT cost_alert_deliveries_state_check
    CHECK (state IN ('PENDING','CLAIMED','DELIVERED','RETRY','EXHAUSTED','HELD'));
