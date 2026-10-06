# DESIGN REVIEW — Delta-PC-1 sealed prompt-content carrier (Form A) — 2026-10-04

**Packet:** DESIGN-REVIEW-CARRIER · reviewer claude (review-only lane) · dispatch 2026-10-04 23:49.
**Scope:** `p745-carrier-design-2026-10-04.md` + adjudications CARRIER-PC1-SET / DELTA-PC-SET / P745-PRODUCER-MARKER + spot-checks (metadata-crypto slot/AAD, contracts schema, submission carrier build/caps/seal, runtime claim open+cross-check, 0031 migration, worker-sdk forwarding gap).
**Role:** READ-ONLY — no source/test edits, no tick/commit. DB window: FREE.

## Verdict: APPROVED-WITH-CONDITIONS (IMPL-A/B may proceed)

Form A is the correct choice vs B/C/D. Conditions in §7 must ride with IMPL-A/B.

## 1. Sealed carrier Form A — key policy / AAD / no-plaintext

- Per-value random DEK (32B) + Vault Transit wrap; no caller-supplied key; envelope self-describing (version/algorithm/keyRef/dek/nonce/tag/aad/ciphertext/plaintextSha256).
- AAD = sha256(tenantId|slot|refId), fixed 32B, no row-id leak; compared with timingSafeEqual BEFORE decrypt → cross-tenant / cross-row / cross-column replay yields CONTEXT_MISMATCH, never decrypt-with-wrong-binding.
- NEW slot `operations.prompt_overrides_ref` preserves cross-column separation: carrier blob replayed into input_ref (or vice versa) is refused. Form D (reuse of input_ref slot) would violate this — correctly rejected.
- Canonical JSON before hash keeps plaintextSha256 stable across key reorder.
- No-plaintext holds IF producer seals before tx and never logs/queues plaintext. Design pins sentinel absent from every param bound (incl. base64) with presence only in `promptOverrides` at claim; carrier lives in the operations row, not copied to tasks/outbox/queue payload.
- **Risk:** debug logging of full envelope verbatim in prod (opaque but noisy); step_checkpoints/output_ref path must never duplicate carrier content.

## 2. Cross-check markers↔carrier — strong enough for its threat

- Equality of two views of ONE admission bucket read (same filter/sort, same revision formula `sha256:hex(sha256(connectionId|stepId|content))`, sorted deterministic).
- Checks: row-count equality, duplicate `connectionId::stepId` deny, `markers[key]===row.revision`, recompute `sha256(conn|step|content)===both`.
- Tamper/drift/wrong-slot → AUTHENTICATION_FAILED / INVALID_SCHEMA / CONTEXT_MISMATCH, fail-closed inside claim tx with 0 committed writes.
- **Honest limit:** both pins derive from the same listFor bucket, so a poisoned bucket at admission agrees with itself. Accepted admission-trust boundary (bucket pre-scoped via listFor), not a claim-bypass. Invariant: single bucket read reused for both pins — keep for all future edits (no TOCTOU).

## 3. Caps 64 / 16 KiB / 256 KiB + 422 — reasonable

- Prevents Vault-hold + row bloat + silent truncation DoS. 16 KiB/row fits prompt-override use; 256 KiB total fits jsonb; 64 rows bounds connection-step cardinality.
- Caps-first ordering (before seal/tx) is critical — no cost, no partial write. Over-cap → 422 PROMPT_CARRIER_TOO_LARGE, 0 INSERT. No silent truncation.

## 4. No-seam NULL+markers — safe

- No plaintext fallback by construction: seal only when `metadataCrypto && rows>0`; else carrier NULL, markers still written. Markers are revision hashes, not content → no content leak.
- NULL maps to `null` never `[]` — preserves old-vs-empty distinction. Pre-0031 rows immutable NULL → null.
- **Condition for IMPL-B:** business-side null handling must fall back to connector default explicitly (apply:false path), not to stale/empty string.

## 5. Additive field — non-breaking (with one operational caveat)

- `pinned.promptOverrides` nullable default null is additive; old readers ignore, new readers get null on old rows.
- Still Δ-CONTRACTS: needs contracts dist rebuild + SDK strict-parse check. SDK forward intentionally deferred to PACKET-B — correct lease hygiene, but end-to-end substitution NOT yet live after IMPL-A alone.

## 6. IMPL-A risk surface (contracts + 0031 + producer + claim)

- 0031 `IF NOT EXISTS`, nullable, no backfill, same-tx as markers — low risk.
- Producer CR28-04 ordering (bucket → caps → seal → tx) + 0-write on key-provider fail.
- Claim tx rollback on open/cross-check throw (tamper/drift/wrong-slot/no-crypto all 0 writes).
- Fail-closed classes distinct and correct.
- `allowPlaintext=false` carrier-only is correct adversarial design (new column, no legacy rows); `openMetadata` keeps `true` for input_ref/payload legacy window — no seam change.

## 7. Conditions for IMPL-A / IMPL-B

1. (B) SDK forward `pinned.promptOverrides` → DefaultTaskContext + 6-site build-prompt wiring + T5 pass-through test; define null-handling (null → connector default apply:false).
2. Keep single-bucket invariant (one listFor read feeds both markers + carrier).
3. No plaintext/ciphertext debug logging in prod; verify queue/outbox/checkpoint never copy carrier content.
4. Live window still open: real PG + real Vault envelope-on-row, claim live, worker-kill immutability, observed provider request.
5. Commit carrier core as one bisect-clean unit: 0031 + contracts src+dist + metadata-crypto + submission + runtime + 2 new tests; exclude SDK/document-core/publish/profile-commands (other lanes).
