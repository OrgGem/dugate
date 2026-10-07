-- P730-ADMIN-MUTATE (Δ8): T-AUD-01 must record the REAL principal behind a
-- mutation — issuer/sub/role — not only the coarse `actor` string. The
-- columns are additive and nullable: legacy/self-contained credentials keep
-- NULL here and their `actor` fallback (`admin:<role>`) byte-for-byte.
--
-- `actor` keeps its existing contract (never a raw credential); these columns
-- carry server-derived session identity only (opaque session store), so no
-- caller-supplied string ever lands here.

ALTER TABLE admin_audit_events ADD COLUMN IF NOT EXISTS actor_issuer text;
ALTER TABLE admin_audit_events ADD COLUMN IF NOT EXISTS actor_sub text;
ALTER TABLE admin_audit_events ADD COLUMN IF NOT EXISTS actor_role text;
