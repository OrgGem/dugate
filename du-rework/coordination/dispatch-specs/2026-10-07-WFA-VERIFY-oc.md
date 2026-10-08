# DISPATCH SPEC: WFA-VERIFY-BASELINE — verify baseline + fixture prep (song song với qwen_2)

- Task: `WFA-VERIFY-BASELINE` (canonical plan: `du-rework/tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §6 WFA-T01..T38, hỗ trợ WFA-04)
- Assigned Agent: **OC lane** (`term_169a5da5-5a0c-4cbf-b226-7f2d51264b24`)
- Role: independent verifier support (kế thừa phương pháp WFA-04 của `/root/workflow_verify`)
- Status: DISPATCHED / LEASE_ASSIGNED
- Repo scope: `du-rework`
- Canonical plan: `du-rework/tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md`
- Directives:
  - **Do NOT commit, do NOT push.**
  - Write scope: **`du-rework/tests/workflow-api/` + report này**. Product source **read-only tuyệt đối** (kể cả test-owned `wfa-*` trong `services/orchestrator/tests/` — đó là lease của qwen_2/Codex).
  - **Không chạy `http-worker.integration.test.ts` khi qwen_2 đang chạy worker suites** (tránh can nhiễu PG schema/Redis dùng chung). Trước mỗi lần chạy worker suite, đọc `coordination/reports/wfa-qwen-handover-2026-10-07.md` xem qwen có đang chạy không; nếu không rõ → chỉ chạy non-worker suites.
  - Isolated infra only: PG `du-wfa-20261007-55498-pg` @ `127.0.0.1:55498`, Redis `du-wfa-20261007-56398-redis` @ `127.0.0.1:56398`; unique PG schema + non-default Redis DB theo `tests/workflow-api/isolation.ts`. Không đụng production/legacy DB. Xong việc KHÔNG stop 2 containers (verifier chính dùng tiếp).
  - Fail-first là bình thường ở phase prep: test đỏ vì implementation chưa có thì ghi `BASELINE-FAIL (expected, pending qwen items)` — không phải bug report, không sửa product source để cho xanh.

---

## 1. Việc phải làm (theo thứ tự)

| # | Acceptance | Việc làm | Kiểm tra đóng |
|---|---|---|---|
| 1 | Infra | Kiểm tra 2 containers còn chạy không; mất thì dựng lại theo `tests/workflow-api/isolation.ts` (loopback-only, từ chối non-loopback URLs) | containers up, harness refuse non-loopback OK |
| 2 | Baseline non-worker | Rerun các suite KHÔNG cần worker trên Node 24: `baseline-fixtures`, `decoder-contract`, `schema-catalog.postgres`, `http-admission.integration`, `route-projection`, `http-schema-pin` — lệnh: `node <node24>/node.exe tests/workflow-api/run-jest.cjs <log-name>` từ `du-rework/`, Node `>=24.21.0 <25` | exit 0, counts ghi receipt; baseline cũ: 4/4, 10/10, 11/11, 14/14, 16/16 |
| 3 | T01/T02 prep | Viết fixture + test scaffolding cho **disbursement success** và **lc-checker success** qua HTTP → worker → poll/result/download (dùng fixtures `tests/workflow-api/fixtures/`, synthetic docs, loopback mock providers). Chưa pass cũng được — ghi BASELINE-FAIL | test file mới trong `tests/workflow-api/`, log raw giữ lại |
| 4 | T03 + leaf prep | Scaffolding cho doc-compare **2-file success** + 6 leaf nodes (T15,T18..T22: `connector`, `file_parse`, `file_url_download`, `callback`, `archive_compress`, `archive_extract`) với mock local + bounds/traversal/SSRF fences | như trên |
| 5 | Full worker rerun | **Chỉ khi qwen_2 báo xong mục 1–4 của `WFA-HANDOVER`** (đọc receipt qwen): chạy full `http-worker.integration.test.ts` KHÔNG `-t` filter, thay receipt 6+2 cũ bằng pass ổn định | 8/8 (hoặc full pass), exit 0, log raw |

Node 24 path baseline: `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` (kiểm tra tồn tại, mất thì báo).

## 2. Bằng chứng mẫu (giữ thông lệ WFA-04)

- Mỗi lần chạy: command + cwd + Node version + exit code + passed/failed/skipped + test IDs.
- Log raw tại `du-rework/tests/workflow-api/logs/<case>-node24-2026-10-07.log`; **giữ cả receipt fail-đầu**, không xóa.
- Không in secret/API-key patterns vào receipt (dùng synthetic key wrapper như harness hiện tại).

## 3. Bàn giao

- Receipt: `du-rework/coordination/reports/wfa-verify-baseline-2026-10-07.md` (§baseline counts, §prep status từng T-ID, §worker-rerun khi có, §open items chuyển verifier chính).
- Đồng bộ `docs/28-test-inventory.md` cho test mới.
- Full WFA-T01..38 ACCEPTED vẫn do verifier chính + independent review đóng (WFA plan §8); lane này không tự tick ACCEPTED.
