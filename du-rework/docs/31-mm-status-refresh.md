# 31. MM status refresh (W42-CX10, docs-only, supersedes docs/25 by pointer)

docs/25-mm-status-crosscheck.md is SUPERSEDED by this file; its rows are not
duplicated. Plan states from tasks/PLAN-MISMATCH-FIXES-2026-09-23.md vs
on-disk state checked this turn. No DB, no test runs except the offline
validator noted. Nothing ticked.

| MM | Plan vs disk | Holder lane | Evidence (file + line) | Still missing | Toi KHONG kiem chung duoc |
|---|---|---|---|---|---|
| MM-01 | TODO, unchanged | sdk+platform | worker-sdk/src/connector-invoker.ts:50 content-type only; connector entrypoint.ts:16 + http/server.ts:66 identity required | production service auth in default invoker; deny tests | live 401 reproduction; SDK lane out of rotation |
| MM-02 | TODO, unchanged | platform | server.ts:559 submit; submission.ts:164/180 input-only persist; server.ts:670 empty artifacts; docs/21 x-absent | public upload/download flow; CR-12/13 | live route behavior; platform lane owns |
| MM-03 | TODO, unchanged | platform | submission.ts:81 version-before-binding; runtime.ts:1006 slice digest + :1014 empty prompts | version selection, locks, resolved snapshot tests | live profile semantics |
| MM-04 | TODO, unchanged | platform | facade.ts:32 drops wait; server.ts:645 nextCursor null | public wait lookup, durable progress, pagination | live pagination behavior |
| MM-05 | TODO, unchanged | platform | dispatcher.ts:32 undispatched-only; runtime.ts:757 RUNNING-only sweep; **[corrected W48/Tester-3-run: `/health` is structured `{status,db,redis,activeLeases}` at server.ts:433-461 — old "server.ts:510 constant HEALTHY" phrase STALE; still NO queue-integrity signal]** | READY reconciliation, scheduled expiry, durable health | Redis-loss drill — p8-02b MM-05a/b/c (sweep escape verified, replay durable verified; reconciliation still missing) |
| MM-06 | TODO, SDK held | connector (Codex-2 — W43-Q16) + platform+sdk | connector invoke.ts:52 stored PENDING, no poll scheduler — POLL IMPLEMENTATION ASSIGNED TO Codex-2 via `services/connector` ownership (13:10) | poll/result convergence across restart | live provider restart |
| MM-07 | TODO, unchanged | connector (Codex-2 — W43-Q16) + platform | invoke.ts:42-59 SUCCEEDED/UNKNOWN/PENDING only | IN_FLIGHT/CANCELLED replay ownership test | live replay race |
| MM-08 | TODO, unchanged | platform | services.ts:79 per-tenant quota key; invoke.ts:69 30s lease | account-wide cap, renewal, deadline bound | multi-tenant quota run |
| MM-09 | TODO, slice exists | platform | registry-tool.ts digests descriptor; no running-image/ACL proof | real digests, provisioned identities, denied cross-queue | deployment inspection |
| MM-10 | TODO, slice exists | admin-ui+platform | p7-04 file NOT FOUND (rg empty); p8-02 file exists | rendered editor flow; same-epoch cancel; recovery | browser/UI run |
| MM-11 | TODO, docs slice done | docs | tools/openapi/validate_openapi.py exit 0, 23/23 PASS (this turn); docs/23 decision | spec-extracted examples + real HTTP responses | live HTTP responses |
| MM-12 | TODO, unchanged | platform | package.json start dist/server.js; server.ts factory+listen :275 | prod entrypoint/container/health/migration/restore | deployment run |
| MM-13 | PARTIAL disputed, harness wired in wave 41/42 | test-infra | tests/isolation/namespace.ts + concurrent-runner.ps1 Batch mode; docs/28 104 suites (82 OFFLINE run) | default-consumer wiring; two-default-run proof | live concurrent proof |

Wave 41/42 changes: MM-13 harness wired + 82 offline suites run (docs/28);
FIX-CR-11 DONE (ingress-bounded 8/8 per wave log); FIX-CR-13 in progress
(Claude Code, blob GET raw); P8-04 promoted [x] with 6 security classes
(P8 task file); orphans p4-05/p4-08 now owned by Codex-2 (cycle 62), P9
parked unassigned. Validator rerun this turn: `python
du-rework/tools/openapi/validate_openapi.py` exit 0, 23/23 PASS. NO DB USED.

### Live-batch 19:05-19:24 delta (testing lane, DB RELEASED)

- MM-01/MM-06/MM-12: unchanged by this batch (no new evidence for auth,
  PENDING convergence, or deployment entrypoint).
- p4-05: 6 passed / 1 failed (base64 JSON wrapping mismatch on download) --
  SDK streaming half holds; wire-format expectation open, see docs/34
  pattern for spec-first handling.
- p4-08: 0 total, TS2345 at test:334:44 -- BLOCKED, SDK owner stopped;
  see docs/34-p4-08-type-drift-spec.md.
- multi-container-e2e: timeout 50s at :1858 for the rate-limit barrier --
  flake/perf signal, not a code verdict; needs rerun, not a tick change.
- GREEN-BUT-EXIT-1 (open handle): three orchestrator suites passed all
  tests internally but exited 1 on an open handle. New acceptance rule:
  exit code is part of the verdict -- a suite is PASS only with exit 0;
  GREEN-BUT-EXIT-1 is a distinct state requiring handle-hygiene fix, never
  counted as green.
### W42-CX13 delta (docs lane, NO DB USED, zero tests run)
(a) P1-03 and P0-06 are [x] per USER authorization relayed by orchestrator: validator offline rerun this turn python du-rework/tools/openapi/validate_openapi.py exit 0 23 of 23 PASS OPENAPI-EXAMPLES-VALIDATED; three non-proofs so lanes do not re-ask: 1 examples are independent fixtures not spec-extracted, 2 no live HTTP response shapes checked, 3 no in-repo CI wiring beyond manual command; P0-06 two-doc set docs/22 plus workload-assumptions stays TARGET vs IMPLEMENTED split, P8-05 may now read docs/22.
(b) P4-08 owner is now Codex-2 per USER decision 19:45; SDK lane dead label withdrawn; TS2345 at test :334:44 still BLOCKED, see docs/34; Codex-2 owns adoption, this lane does not touch P4-05/P4-08.
(c) New evidence class GREEN-BUT-EXIT1: blob-wire-binary 5 of 5, ingress-bounded 8 of 8, usage-summary 9 of 9 all green internally but exit 1 on afterAll 30s app.close drain timeout; W42-A65 forensic root cause runtime.ts getActiveLeasesCount counts expired RUNNING leases so drain loops 30s; suite is PASS only with exit 0. NOTE: testing lane usage-summary 9 of 9 green mislabeled [FAIL] in one summary table while batch table says GREEN-EXIT1; quoted conflict, not edited here; orchestrator forcing relabel.

---

## PLAN CHANGES 09-24 (Qwen-2 lane, docs-only — two new task plans, NO DB, nothing ticked)

Plan-level mapping (chi tiết trong docs/36 §7). Không đổi trạng thái MM-01..13; chỉ ghi nhận delta cho tương lai.

| New plan / row | plan vs disk | Holder lane (gợi ý) | Chạm MM nào | Evidence class cần | Cổng phủ |
|---|---|---|---|---|---|
| SEC-OIDC-VAULT-2026-09-24.md — ADM-BASE-01/02 (16 rows; codex3.md review 09:02) | TODO, plan-only | Platform + Admin UI | MM-10 (p7-04 UI), MM-04 (wait), MM-02 | LIVE + BROWSER | G-SEC |
| SEC — ADM-BASE-03 error/log boundary | TODO | Platform | MM-02 | LIVE + LOG tear-down | G-SEC |
| SEC — OIDC-01..04 | TODO | Platform/auth + Admin UI | MM-01 (auth) | BROWSER (fake IdP) | G-SEC |
| SEC — VAULT-01..06 | TODO | Platform + Connector + contracts | MM-03 (version/binding), MM-06/07 (invoke flags) | LIVE + BROWSER + multi-container | G-SEC |
| SEC — SEC-INT-01/02 | TODO | Testing/integration + infra | MM-12/13 (deploy/harness) | multi-container + infra E2E | G-SEC |
| DEPLOY-STORAGE-LOGGING-2026-09-24.md — DATA-00..05 (10 rows: 9 dev + G-DATA) | TODO, plan-only | Orchestrator + DBA | MM-02 (upload/download → S3), MM-03 | LIVE (S3-compatible) | G-DATA |
| DEPLOY — DATA-03/04 | TODO | worker-sdk + document-core | MM-06 (replay), MM-03 | LIVE + multi-container | G-DATA |
| DEPLOY — LOG-01/02 | TODO | observability + ops | MM-02 | LIVE + infra | G-DATA |
| DEPLOY — DEP-01/DATA-INT-01 (G-DATA gate) | TODO | infra + integration | MM-12, MM-13 | cross-host E2E, fault matrix | G-DATA |

Ghi chú: cả hai plan thuộc lớp bằng chứng LIVE_INFRA/BROWSER/multi-container — **không có suite OFFLINE mới**; không dùng tick cũ của P2/P3/P6/P8 làm bằng chứng cho OIDC/Vault hay S3/ES (codex3.md:41; tasks/README:11,13). Qwen-2 không sở hữu row nào trong hai plan; chỉ giữ các acceptance oracle offline đã đóng góp (P0-01 BR-05/UC-07; R24-01 fence).

---

## W43-Q16 OWNERSHIP RE-BROADCAST (coordinator 13:10, USER decision — Qwen-2 ghi vào docs của mình)

- **P4-08 (`tests/integration/p4-08-sdk-consumer.integration.test.ts`): owner = Codex-2, connector-poll IN PROGRESS.**
  p4-08 fail tại RUNTIME (provider trả HTTP 202 → PENDING, không ai poll → operation timeout FAILED)
  — **KHÔNG còn lỗi biên dịch** (TS2345 đã cleared từ lâu, docs/34 done). Nguyên nhân = thiếu poll scheduler
  (chính MM-06/MM-07). USER chỉ định Codex-2 = owner `services/connector` (13:10) và giao implement
  provider-poll cho invocation PENDING → mở P4-08.
- **MM-06 / MM-07 gắn `services/connector` (Codex-2)** — đã sửa cell owner trong bảng MM phía trên
  ("connector (Codex-2 — W43-Q16)"), vì invoke.ts:52 PENDING + invoke.ts:42-59 states là code trong
  `services/connector` mà Codex-2 nay sở hữu.
- **Quy tắc skip cho `connector-client 19 passed / 1 SKIPPED`**: offline `npx jest --runInBand` →
  `Tests: 1 skipped, 19 passed, 20 total` exit 0 — test skipped là
  `invoke/poll/wait/cancel behave end-to-end over real HTTP` (`orchestrator/packages/connector-client/tests/real-service.test.ts:152`,
  gate `CONNECTOR_INTEGRATION=1`). **Theo luật fleet: SKIP KHÔNG tính là pass** — test thứ 20 (live E2E)
  **vẫn MỞ/unproven ở chế độ offline**; chỉ được coi là có bằng chứng khi chạy gated live (A72 từng ghi
  1/1 exit 0 với gate bật — nếu cần kích hoạt lại, đó là RUN REQUEST cho antigravity, không phải offline pass).
- Hàng đợi live của docs/29: thêm **PENDING RUN REQUEST p4-08 (13/13 executed, no skip)** chờ Codex-2 nộp fix; routing antigravity `term_47a1d44b`.
