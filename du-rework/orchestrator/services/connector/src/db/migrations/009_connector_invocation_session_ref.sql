-- CR06-04: an async provider may return a continuation sessionRef in the 202
-- accept body. The pending record stores it so the session survives the
-- worker's pending-yield resume (the stable invocationId replays to the same
-- provider execution, and the connector re-attaches the stored session on the
-- poll). Additive, nullable: pre-CR06-04 rows keep session_ref NULL and the
-- wire shape is unchanged.
ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS session_ref TEXT;
