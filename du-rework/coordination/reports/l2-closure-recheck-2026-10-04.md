# L2-CLOSURE-RECHECK — verify sweep `PAR-##` → `ORCH-PAR-##` (READ-ONLY) — 2026-10-04

**Packet:** `coordination/dispatch-specs/2026-10-04-1952-L2-CLOSURE-RECHECK.md` · **Lane:** cc_1 (`term_c03791d1`) · **Run:** `run_069ecd6957cd` (task `task_d7d810a38799`, dispatch `ctx_356ec2b1dfad`).
**Input:** `coordination/reports/plan-merge-fix-2-2026-10-04.md` (claim 33 dòng/34 token ở 4 file; validator 13 docs/210 links). **Snapshot đo:** 2026-10-04 **19:52:31–19:57 +07** (5 docs sửa 19:43:41; không edit mới trong cửa sổ).
**Mode:** READ-ONLY — file duy nhất ghi là receipt này; không tick; không commit/push.

## 0. TL;DR

| Hạng mục | Kết quả |
|---|---|
| Re-grep `(?<!ORCH-)PAR-\d+` — 4 file chỉ định (README/WTV/CFGADM/LPG) | **0 dòng, 0 token** — sweep đúng ngữ nghĩa |
| Toàn suite (`tasks/*.md` + TOPOLOGY) | **≠ 0 — còn 58 token ở 4 file parent ngoài scope** (ACUI 3 / ORCH-PAR-00 15 / PARITY-BOUNDARIES 13 / LEGACY-FEATURE-PARITY 27) |
| `PAR-XA-*` | Preserved: ORCH-CONFIG **5**, LPG **1** ✓; `ORCH-ORCH-` typo = 0 |
| CURL Q1/Q2/Q3 pointers (AWEB/CFGADM) | **2/2 verified** đủ nội dung đã chốt (§3) |
| Hash pins | **5/5 khớp** pin merge-fix-2 + ORCH-CONFIG read-only pin không đổi (§4) |
| Link count (cc_1, 10 docs) | **183 / 0 broken / 0 anchor** (literal; scope khác 210/13-docs của họ — §4) |

**Verdict:** L2 **FIXED cho 4 file được giao**; **suite-wide PARTIAL** — phần còn lại nằm ngoài scope merge-fix-2 (không phải regression), cần coordinator quyết: sweep tiếp 4 file parent hoặc chấp nhận shorthand/alias-note.

## 1. Target check (spec item 1)

| File | Trước (delta-2) | Sau | Ghi chú |
|---|---:|---:|---|
| `README.md` | 3 | **0** | `:17` `[ORCH-PAR-11..17]`, `:31`, `:133` đã đổi hết |
| `WORKTREE-VERIFY-COMMIT-2026-10-03.md` | 1 | **0** | `:14` `[ORCH-PAR-11..17]` |
| `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` | 25 | **0** | refs `ORCH-PAR-##` trong scope/parent/dependency; 17-key map + 12 row `[ ]` nguyên |
| `LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md` | 4 | **0** | parent/dependency; PAR-XA-01..05 giữ |

Regex chạy: `(?<!ORCH-)PAR-\d+`; helper đối chiếu `PAR-XA-\d+` và typo `ORCH-ORCH-`.

## 2. Residual (suite-wide) — ngoài scope, cần quyết định

Scan rộng `tasks/*.md` (42 file) + `COORDINATION-TOPOLOGY.md`: **58 bare token** còn lại ở 4 file (mtime 18:17–18:19 — chưa từng được đưa vào bất kỳ sweep nào):

| File | bare token | Dòng (mẫu) |
|---|---:|---|
| `ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` | 27 | `:9`, `:38-39`, `:47-49`… (dạng `PAR-00`, `PAR-01`) |
| `ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` | 15 | `:5`, `:10`, `:19`, `:24`, `:35`, `:39`… |
| `ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md` | 13 | `:39`, `:44`, `:50`, `:52`, `:58-59`… |
| `ADMIN-CONTROL-PLANE-UI-2026-10-02.md` | 3 | `:5` (`PAR-12`), `:23` (`PAR-02`), `:24` (`PAR-03`) |

Đây là các **parent plan** tự dùng shorthand `PAR-##` trong thân tài liệu (heading canonical vẫn `ORCH-PAR-`). Không phải lỗi mới/regression: merge-fix-2 chỉ claim 4 file, validator của họ cũng chỉ check noncanonical PAR ở 3 file canonical (`plan-merge-fix-2:140`). **Đề xuất (không thực thi):** một trong hai — (a) sweep tiếp `(?<!ORCH-)PAR-\d+` cho 4 file này; (b) quyết định shorthand `PAR-##` **trong thân parent docs** là chấp nhận được (alias-note 1 chỗ) để chốt L2 toàn suite. `PAR-XA-*` phải giữ nguyên.

## 3. CURL Q pointers (spec item 2)

- `ADMIN-WEB-DELIVERY-2026-10-04.md:9` và `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:7`: block `> **CURL Q1/Q2/Q3 — coordinator chấp nhận 2026-10-04 19:45:**` đủ nội dung đã chốt — Q1 fail-closed malformed/unsupported/command-substitution; Q2 heuristic + **toggle mask/unmask per-form-field**; Q3 `onApply` **accept-only**, không autosave/network; kèm `COMPONENT_SPEC_VERIFIED / INTEGRATION_PENDING`, chưa UI_APPROVED, save/test/activate cần backend thật, Δ-DEV-03 user-gated; link `curl-ui-review-2026-10-04.md#5-kết-luận` resolve.
- AWEB thêm decision row `:145` (19:45) supersede 3 OPEN của snapshot 735; history OPEN giữ. **2/2 pointer đúng nội dung, không overclaim.**

## 4. Literal numbers & pins

- **Link checker (cc_1, 10 docs):** `TOTAL LINKS: 183 | BROKEN: 0 | ANCHOR ISSUES: 0` (trước merge-fix-2: 177; +6 link mới). Scope note: validator merge-fix-2 báo **210 link/13 docs** — bộ 13 gồm thêm 3 receipt (`plan-merge-fix`, `plan-refresh`, `plan-merge-fix-2`); hai bộ cùng 0 broken, không so chênh lệch count như regression.
- **SHA-256 — 5/5 khớp pin merge-fix-2:** README `f0578f95…62a6`; WTV `44b205cf…f6cb`; CFGADM `d56b44b0…6ab8`; LPG `39bb68bf…ffd6`; AWEB `e6bc4530…9f3e`. ORCH-CONFIG read-only pin `e35edb80…3ec48` **không đổi**. → delta ổn định từ 19:43:41.
- **Checkbox literal (5 file):** README `4/5/4`; WTV `1/0/10`; CFGADM `0/0/12`; LPG `1/0/2`; AWEB `1/0/0` — khớp baseline merge-fix-2 (sequence 5/5 unchanged).

## 5. Limitations

- "Toàn suite" đo trên `tasks/**` + TOPOLOGY (42+1 file); các receipt lịch sử (delta/delta-2/merge-fix) vẫn chứa từ `PAR-##` dạng trích dẫn — **không thuộc phạm vi sửa** và không tính vào 58 token.
- Anchor check dựa heading/line-count (không render GitHub); external URL bỏ qua (offline).
- Line number theo snapshot 19:52:31–19:57; re-anchor nếu còn delta.

READ-ONLY compliance: chỉ receipt này được ghi; không tick/sửa; không commit/push.
