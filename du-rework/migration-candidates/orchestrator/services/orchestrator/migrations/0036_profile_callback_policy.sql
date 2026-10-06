-- CB-02 (PROFILE-CALLBACK-20261006) — B3 admission source for the callback
-- policy pin.
--
-- `operations.callback_policy` (migration 0035) is written at submission from
-- the pinned profile revision; this column is where that policy lives on the
-- immutable profile_bindings row. NULL = no callback policy configured
-- (legacy notification-only delivery, byte-identical to P2-08).
--
-- The stored value is the frozen CB-01 `ProfileCallbackPolicy` (secret
-- REFERENCES only, never values, never raw storage URLs). Additive and
-- nullable; existing rows keep NULL until their next publish.

ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS callback_policy jsonb;
