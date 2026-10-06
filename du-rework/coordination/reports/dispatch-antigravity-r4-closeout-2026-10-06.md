# Handoff → Antigravity: re-check plan & dispatch agents to close r4 gaps

- Date: 2026-10-06
- From: claude (independent audit `claude-audit-review-r4-2026-10-06.md`, verdict CHANGES_REQUIRED)
- Full detail: `coordination/reports/claude-audit-review-r4-2026-10-06.md`
- Candidate: `candidate-portal-swagger-20261006-r4` · CWD: `D:\Git\dugate\du-rework`
- Rules for all agents: read-only verify where stated; no secrets/hostnames/tenant data in evidence; record file SHAs + exit codes.

## Group A — Re-run & record (implement xong, owner báo pass, cần verify độc lập)

| # | Task | Pass criteria |
|---|---|---|
| A1 | Re-run CR06-01 prompt-wiring suites (claimed 27/27 + 153/153 RED→GREEN) | exit 0, checkpoint hash unchanged |
| A2 | Re-run CR06-03 session-seam (claimed 99/99, 11 sites/6 actions) | exit 0, exact step-key match, no alias |
| A3 | Re-run CR06-04 async-202 (claimed 10 tests) + confirm migration 009 applied + vendor parity note (vendor chưa re-vendor) | exit 0 |
| A4 | Re-run CR06-05 identity (claimed 19 tests + M1/M2) + grep-guard `allowUnauthenticatedTestTraffic` test-only, never prod | exit 0, guard in CI |
| A5 | Re-run CR06-06 redaction (claimed 5 suites/88 tests) + ghi nhận known limit: top-level keys only | exit 0 |
| A6 | Re-run CR06-07 tri-state (claimed 4 tests + ×3 33 passed) + confirm crypto-seam red là pre-existing, không do r4 | exit 0 (trừ red cũ đã pin) |
| A7 | Re-run CB-01 (16 tests) + CB-02 cluster (23/23 ×3, 80/80) + CB-03 (20 tests) | exit 0 |

## Group B — Finish implementation (thiếu thật, verify cũng FAIL)

| # | Task | Done criteria |
|---|---|---|
| B1 | CR06-08: chốt decision `profileId` uuid (`profile-policy.ts:546-547`) + implement + test | decision ghi file + suite pass |
| B2 | CR06-10: locate encryption-required site (owner chưa locate được, 0 tests) + implement + test | site pointer + suite pass |
| B3 | CB-02: production resolver + admission writer (receipt tự ghi OPEN) | wired + tested |
| B4 | CB-03: dispatcher wiring modes × auth (receipt tự ghi OPEN) | dispatcher → receipt cả 2 modes |

## Group C — Evidence from scratch (chưa đủ bằng chứng, chưa thể nói đúng/sai)

| # | Task | Done criteria |
|---|---|---|
| C1 | VFY-06: encrypt-on-write call-sites S3 + từng DB blob column (+ migration refs); đọc ciphertext-only từ PG/S3 (không plaintext); boot matrix thiếu `ENCRYPTION_KEY` / Vault token / Vault unreachable → refuse boot (log excerpt, không secret) | ciphertext proof + 3 boot cases |
| C2 | VFY-SC-01: audit GET/response `/admin/web/secrets` + mọi API trả object chứa secret → redacted/masked; KV2 resolver negative paths (Vault down / denied → fail-closed, không fallback plaintext) | readback audit + negative tests |
| C3 | VFY-CB-01: dispatcher wiring proof mode → auth → send → receipt cả `notification_only` + `notification_with_result`; OAuth2 live/recorded VFY (token fetch/expiry/retry, không credential thật); migration 0035 apply/rollback + immutable-snapshot check | e2e evidence |
| C4 | OpenAPI v1.4.0: recount từ file `docs/21-openapi.json` (claimed 58 paths / 62 ops / 51 schemas) + generator provenance `codex_arch` | số đếm lại + provenance |

## Re-review gate

Khi A+B+C xong: chạy lại audit độc lập VFY-06 / VFY-SC-01 / VFY-CB-01 / REVIEW-07 rồi mới quyết ACCEPTED hay vẫn CHANGES_REQUIRED. Không promote r4 production trước gate này.
