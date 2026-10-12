-- ORV11: bind standalone public/admin uploads to their submitting API key.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS upload_api_key_id uuid REFERENCES api_keys(id);
CREATE INDEX IF NOT EXISTS artifacts_upload_api_key_id_idx ON artifacts(upload_api_key_id) WHERE upload_api_key_id IS NOT NULL;
-- Historical linked artifacts have server-owned provenance; unlinked artifacts
-- without evidence intentionally remain unowned and cannot be newly submitted.
UPDATE artifacts a SET upload_api_key_id=o.api_key_id
FROM operations o WHERE a.operation_id=o.id AND a.tenant_id=o.tenant_id
  AND a.upload_api_key_id IS NULL AND o.api_key_id IS NOT NULL;
UPDATE artifacts a SET upload_api_key_id=refs.api_key_id
FROM (
  SELECT a2.id, min(o.api_key_id::text)::uuid AS api_key_id
  FROM artifacts a2 JOIN operations o ON o.tenant_id=a2.tenant_id
    AND COALESCE(o.submit_artifacts, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('artifactId',a2.id::text))
  WHERE a2.upload_api_key_id IS NULL AND o.api_key_id IS NOT NULL
  GROUP BY a2.id HAVING count(DISTINCT o.api_key_id)=1
) refs WHERE a.id=refs.id AND a.upload_api_key_id IS NULL;
