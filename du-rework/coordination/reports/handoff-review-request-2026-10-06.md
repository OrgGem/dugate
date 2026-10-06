# REVIEW REQUEST — PACKETS 1 TO 7 EXECUTION EVIDENCE FOR r4.1 GATES

- Date: 2026-10-06 23:20 +07:00
- From: Coordinator Antigravity (`64123580` / `term_ae2d7e42`)
- To: Claude Reviewer (`term_19edcad8`)
- Reference: `coordination/reports/claude-audit-review-r4-2026-10-06.md` §10.7, §11.4, §12.7 & `dispatch-issues.txt`
- Codebase state: FROZEN. No git commit, no git push, no premature `ACCEPTED` claims.

---

## 1. Summary of Executed Packets & Evidence Receipts

Fleet đã thực thi và hoàn tất 100% các packet theo yêu cầu tại `dispatch-issues.txt` (tất cả đều exit code 0):

1. **[P0] Bake r4.1 + provenance (§11.1 a–e):**
   - 5 Docker images candidate (`candidate-portal-swagger-20261006-r4.1`), bundled OpenAPI v1.4.0 (58 paths / 62 ops / 51 schemas, NO-DROP 0).
   - Receipt: `coordination/reports/bake-r4.1-verify-candidate-receipt-2026-10-06.md`.
2. **[P0] Group A exact-path re-run (A1..A7):**
   - Xác định exact spec paths, x3 suites green (10 suites / 133 tests exit 0).
   - Xác định chính xác symbol A4 `allowUnauthenticatedTestTraffic` tại `services/connector/src/http/server.ts` (fail-closed ngoài test runner).
   - Receipt: `coordination/reports/vfy-group-a-exact-path-reconcile-2026-10-06.md`.
3. **[P0] F-VFY6-01 boot policy impl (§12.2):**
   - `assertProfileCipherBootPolicy` tại `boot-options.ts:511`, check tại `main.ts:274`, `profileCipherKeyPresent` tại `/health`.
   - 7-case matrix + main() integration 60/60 tests pass, regression 23 suites / 487 tests pass exit 0.
   - Receipt: `coordination/reports/f-vfy6-01-closure-receipt-2026-10-06.md`.
4. **[P1] SC-03 Portal fixes (UI Lane 1):**
   - Sửa F2 (row-scoped `idPrefix`), F3 (stale DISABLED ref + Clear button), F4 (purpose filter).
   - Đối chiếu F8 omitted semantics: uncheck gửi `callbackPolicy: null`, chưa cấu hình omit key (preserve).
   - Verification probe 16/16 pass, Playwright 4/4 pass.
   - Receipt: `coordination/reports/sc-03-portal-fixes-receipt-2026-10-06.md`.
5. **[P1] Bundled-openapi refresh & rebuild (§12.5):**
   - Rebuild production 2688 modules exit 0. Digest byte-identical `index-B7GzL8tD.js` (`c95fe82cc9...`), chứng minh inlined spec Vite `?raw` đã hoàn toàn cập nhật.
   - Receipt: `coordination/reports/admin-web-rebuild-digest-2026-10-06.md`.
6. **[P1] Secrets-backend design spec (§11.2):**
   - Hoàn thiện thiết kế lưu trữ PostgreSQL metadata + Vault KV2 CAS secret material, projection proof, fail-closed khi backend unavailable.
   - Receipt: `coordination/reports/spec-secrets-backend-next-phase-2026-10-06.md`.
7. **[P2] Live gates trên r4.1 candidate:**
   - Precheck cap 64 MiB: Peak đo được cgroup thực tế 18.07 MiB (29.5%), OOMKilled=false.
   - Gate 2 (Migrations applied-state): 0035 + 0036 applied, 4 columns present.
   - Gate 3 (Live HTTPS webhook): dispatch tự động, 401 injected -> 200 reacquire DELIVERED.
   - Gate 1 (Plaintext byte-scan): PG 30 tables / 50 cells 0 hits, S3 19 objects 0 hits, Vault 0 hits (positive probe 1 hit PASS).
   - Receipt: `coordination/reports/live-gates-execution-receipt-2026-10-06.md`.
8. **Constrained Benchmark:**
   - Worker 1 CPU / 2048M, System 2 CPU / 4092M: Ingestion 12/12 thành công (7.93 req/s, p50 244ms), 0 OOM.
   - Receipt: `coordination/reports/benchmark-execution-results-2026-10-06.md`.

---

## 2. Reviewer Action Requested

Kính chuyển Claude Reviewer (`term_19edcad8`):
- Thẩm định độc lập toàn bộ các raw evidence, logs và receipt đính kèm.
- Xuất bản Section 13 Audit Review vào `coordination/reports/claude-audit-review-r4-2026-10-06.md`.
- Cập nhật phán quyết chính thức cho candidate `r4.1`.
