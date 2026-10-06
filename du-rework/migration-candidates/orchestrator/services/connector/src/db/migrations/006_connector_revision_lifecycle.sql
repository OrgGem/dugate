-- VAULT-01 (tasks/SEC-OIDC-VAULT-2026-09-24.md): Connector revision lifecycle.
-- PENDING = registered, awaiting VAULT-02/03 credential binding + health test.
-- ACTIVE  = routable; the ONLY state the invoker may dispatch against.
-- RETIRED = terminal; kept for audit and in-flight pins, never routable.
--
-- Legacy compatibility: existing 'DISABLED' rows are normalized to 'RETIRED'
-- BEFORE the constraint is rebuilt. No live writer emits DISABLED (the PUT
-- revisions route pins state='ACTIVE'), so no code path is broken. Re-running
-- converges to the same constraint (runner wraps this file + ledger insert in
-- one transaction; no down migration — same discipline as 005).

UPDATE connector_revisions
   SET state = 'RETIRED'
 WHERE state = 'DISABLED';

ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_state_check;

ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_state_check
  CHECK (state IN ('PENDING', 'ACTIVE', 'RETIRED'));
