-- WOC-10: named aggregate profile revisions. Each member points at an
-- existing immutable profile_bindings row; no aggregate credential or worker
-- mapping is introduced.

CREATE TABLE IF NOT EXISTS profile_groups (
  group_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active_revision   integer NOT NULL DEFAULT 0 CHECK (active_revision >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_groups_tenant_name_unique UNIQUE (tenant_id, name),
  CONSTRAINT profile_groups_id_tenant_unique UNIQUE (group_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS profile_group_revisions (
  group_id          uuid NOT NULL REFERENCES profile_groups(group_id) ON DELETE RESTRICT,
  revision          integer NOT NULL CHECK (revision > 0),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  api_key_id        uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, revision),
  CONSTRAINT profile_group_revisions_tenant_fk
    FOREIGN KEY (group_id, tenant_id)
    REFERENCES profile_groups (group_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS profile_group_revisions_history
  ON profile_group_revisions (group_id, revision DESC);

ALTER TABLE profile_groups
  ADD CONSTRAINT profile_groups_active_revision_fk
  FOREIGN KEY (group_id, active_revision)
  REFERENCES profile_group_revisions (group_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS profile_group_members (
  group_id           uuid NOT NULL,
  group_revision     integer NOT NULL,
  business_id        text NOT NULL,
  business_version   text NOT NULL,
  manifest_digest    text NOT NULL,
  function_kind      text NOT NULL CHECK (function_kind IN ('endpoint', 'workflow')),
  function_id        text NOT NULL,
  action             text NOT NULL,
  endpoint_slug      text NULL,
  workflow_revision  integer NULL CHECK (workflow_revision IS NULL OR workflow_revision > 0),
  profile_id         uuid NOT NULL,
  binding_revision   integer NOT NULL CHECK (binding_revision > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, group_revision, business_id, business_version, function_kind, function_id),
  CONSTRAINT profile_group_members_revision_fk
    FOREIGN KEY (group_id, group_revision)
    REFERENCES profile_group_revisions (group_id, revision) ON DELETE RESTRICT,
  CONSTRAINT profile_group_members_binding_fk
    FOREIGN KEY (profile_id, binding_revision)
    REFERENCES profile_bindings (profile_id, revision) ON DELETE RESTRICT,
  CONSTRAINT profile_group_members_function_shape
    CHECK ((function_kind = 'endpoint' AND endpoint_slug IS NOT NULL)
        OR (function_kind = 'workflow' AND endpoint_slug IS NULL))
);

CREATE INDEX IF NOT EXISTS profile_group_members_child
  ON profile_group_members (profile_id, binding_revision);

ALTER TABLE profile_names
  ADD COLUMN IF NOT EXISTS group_id uuid NULL REFERENCES profile_groups(group_id) ON DELETE RESTRICT;

ALTER TABLE profile_names
  ADD CONSTRAINT profile_names_profile_group_unique UNIQUE (profile_id, group_id);

ALTER TABLE profile_names
  ADD CONSTRAINT profile_names_group_tenant_fk
  FOREIGN KEY (group_id, tenant_id)
  REFERENCES profile_groups (group_id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE profile_group_members
  ADD CONSTRAINT profile_group_members_child_owner_fk
  FOREIGN KEY (profile_id, group_id)
  REFERENCES profile_names (profile_id, group_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS profile_names_group_id
  ON profile_names (group_id, profile_id)
  WHERE group_id IS NOT NULL;
