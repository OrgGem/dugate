# P730-PLAN-MERGE-FIX — receipt doc-only — 2026-10-04

**Owner:** codex_arch / plan editor · **Run:** `run_069ecd6957cd` · **Task:** `task_2f228e1c6e1a` · **Dispatch:** `ctx_9fa07f36fd15`.
**Spec:** [packet 18:52](../dispatch-specs/2026-10-04-1852-P730-PLAN-MERGE-FIX.md). **Input:** [cc_1 delta §1](plan-graph-delta-2026-10-04.md#1-đối-chiếu-m1m4--l1l7). **Thời điểm kiểm tra:** 2026-10-04 19:04:42 +07 (12:04:42 UTC). **cwd:** `D:/Git/dugate`.

**Kết quả:** áp đủ 10 doc fixes M2/M3/M4/L1–L7 trên sáu file được giao. M1 đã sửa từ delta trước, không tính lại. Đây là `DOC FIX APPLIED` + tự kiểm tài liệu; không independent product verification hoặc acceptance. Không sửa source/test, ledger hay receipt gốc của lane khác; không commit/push; mọi checkbox task/gate giữ nguyên.

## 1. Fix applied từng item

| Item | Target / thay đổi | Evidence và giới hạn |
|---|---|---|
| M2 | [WTV](../../tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md): cập nhật status mô tả và bảng evidence với **7 receipt refs** WTV-01b/02/03/04/05/06/08. | Ghi rõ offline/structural/prep, live/external/deletion gaps; 97 runtime tests là skipped. WTV-00/full WTV-01 chưa suy ra accepted; **WTV-07 commit/push vẫn `[ ]`/mở**. |
| M3 | [AWEB](../../tasks/ADMIN-WEB-DELIVERY-2026-10-04.md): append đúng năm receipt 15:12–16:31 sau row 14:56, giữ log cũ. | aweb04 wire conformance; phase1 CHANGES_REQUIRED; F-PP1 VERIFIED closure riêng; docs UX pointer; legacy inventory. Verdict owner-reported được gắn phạm vi, không nâng parent/UI_APPROVED. **Mtime/hash guard pass trước patch**. |
| M4 | [Live plan](../../tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md): service inventory và cuối runbook Connector đều `8091`. | Khớp env CONNECTOR_PORT và health URL; giữ comment lịch sử 8081 đã bị service khác chiếm để giải thích deviation. Không đổi service port/source. |
| L1 | [README](../../tasks/README.md): bỏ anchor chết `qwen-docs.md#Muc-23`, giữ link tới receipt qwen-docs. | Không chọn heading giả; four remaining anchors trong scope check đều resolve. |
| L2 | [PLAN-COMPLETION](../../tasks/PLAN-COMPLETION-2026-10-04.md), AWEB, [ORCH config](../../tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md): đổi shorthand prefix `PAR-##` thành `ORCH-PAR-##`. | 6/9/18 references được chuẩn hóa tương ứng; giữ namespace `PAR-XA-*`, không tạo/đổi task ID definition hoặc register acceptance. |
| L3 | README Mermaid: thêm `CFGADM` node với inputs P6/P3/DATA, output ADMIN → P8. | Hai graphs được kiểm không cycle; CFGADM là requirement trong graph, không mới gate. |
| L4 | PLAN-COMPLETION: fold requirements trực tiếp vào CONT-01/04 row text. | CONT-01 có defaults/storage generations/user grants/schema+mapping revisions; CONT-04 có Admin setup/edit/test/publish/apply/rollback rehearsal và continuity, không chỉ public submit. Checkboxes không đổi. |
| L5 | AWEB: câu thiếu `apps/*` chuyển thành snapshot quá khứ, ghi bootstrap đã thêm và hiện workspace có pattern. | Đọc đối chiếu `pnpm-workspace.yaml`; không sửa workspace/lockfile/source. |
| L6 | WTV inventory và acceptance WTV-02: **7 file mới + remaining = 8 test files**, harness riêng. | Khớp wtv02 receipt; hai runtime files có trước nằm ngoài split count, live skip không thành pass. |
| L7 | AWEB integrator write set: `src/{app-shell,components,features,lib,routes,styles}` và router/build config thực. | Bỏ `src/app/` không tồn tại; shared primitives/styles chỉ ghi sau owner bàn giao lease, không mở blanket concurrent writer. |

## 2. Mtime/hash guard và scope pins

Đọc snapshot sáu files trước sửa; recheck exact nanosecond mtime **dạng decimal string** + SHA-256 trước patch. Guard toàn sáu files trả `MTIME_HASH_GUARD: PASS`; AWEB được recheck riêng ngay trước append trả `AWEB_MTIME_HASH_GUARD: PASS`. Normalization của ba files tiếp tục kiểm bytes/mtime trước ghi. Không phát hiện thay đổi ngoài lane giữa các guard hợp lệ.

AWEB trước append: mtime_ns `1791112789010854200`, SHA-256 `f64c71d2f2dc68f6c329991aa41478d2930d60991ea6f53cfa732eee5c68ec1a`. SHA-256 sau delta của sáu file:

| File dưới tasks/ | SHA-256 sau patch |
|---|---|
| `WORKTREE-VERIFY-COMMIT-2026-10-03.md` | `301569a528c984557c541399f64bc87ded68f50727fd0d795688d39f274abec4` |
| `ADMIN-WEB-DELIVERY-2026-10-04.md` | `2033fc75788e67e27929eb14d6345963c2cd1d4b9ff03e1e88b23025870ecb67` |
| `LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md` | `439804d36d44d0fe663a05c38d26371eee2f8aa09fa61cf6ddec0343507691c7` |
| `README.md` | `cb398d73cc8d932d95a09f83022748943e763f184647de5381a4432601c6a1ab` |
| `PLAN-COMPLETION-2026-10-04.md` | `4cb7cacaca814e5cace769172a35d56099272e7ea89ecc14589265a9bfdab4ac` |
| `ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` | `e35edb80e2ee620deb7374ee30b88e3ea71b0ad17f0015bf8f8b1fd33fd3ec48` |

## 3. Validator — output literal

Lệnh thực chạy từ cwd trên: PowerShell here-string inline validator → **`python -`**. Scope: sáu docs sửa + CFGADM + LPG + topology + plan-review-730 = **10 docs**. Kiểm full local links/anchors (không gọi external URLs), task definitions/duplicates, 17-key map, open CFGADM/P730 rows, Mermaid cycles, refs/log/count/port/CONT requirements, canonical ORCH-PAR và checkbox equality với snapshot trước sửa. Literal Exit Code **0**:

```json
{"docs_checked": 10, "local_links_checked": 162, "anchors_checked": 4, "task_definitions": 56, "duplicate_task_definitions": 0, "acyclic_mermaid_graphs": 2, "legacy_settings": 17, "CFGADM_open_rows": 12, "P730_open_rows": 6, "WTV_receipt_refs": 7, "AWEB_appended_receipts": 5, "checkboxes_unchanged": 6, "errors": []}
```

Mỗi receipt reference resolve trên filesystem; validator không tái chạy tests được các receipt trích dẫn và không verify build sản phẩm. New receipt này được kiểm local links/whitespace riêng khi ghi; số 162 ở trên là lần scan 10 docs, không tự cộng receipt mới vào số đó.

Git command literal:

```powershell
git -c core.autocrlf=false -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check -- du-rework/tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md du-rework/tasks/ADMIN-WEB-DELIVERY-2026-10-04.md du-rework/tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md du-rework/tasks/README.md du-rework/tasks/PLAN-COMPLETION-2026-10-04.md du-rework/tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md
```

**Output literal:** rỗng (0 bytes). **Exit Code: 0.** Untracked docs không nằm trong git diff được validator filesystem kiểm trailing whitespace. Hai lệnh là docs checks, không product test pass.

Tooling correction trước lượt pass cuối: nanosecond mtime vượt safe integer của JavaScript nên đã đổi sang decimal string; Unicode literal trong pipe Windows được viết bằng escape `\u0394` khi kiểm Δ-DEV-03. Các check lỗi tooling đầu không là finding mới của docs hoặc product; không thay assertion để che lỗi tài liệu.

## 4. Phần còn open / handoff

Sau khi ghi receipt mới, đã mở rộng cùng validator sang **11 docs** (gồm receipt này). Literal Exit Code **0**, output:

```json
{"docs_checked": 11, "local_links_checked": 170, "anchors_checked": 5, "task_definitions": 56, "duplicate_task_definitions": 0, "acyclic_mermaid_graphs": 2, "legacy_settings": 17, "CFGADM_open_rows": 12, "P730_open_rows": 6, "WTV_receipt_refs": 7, "AWEB_appended_receipts": 5, "checkboxes_unchanged": 6, "errors": []}
```

Recheck SHA-256/mtime sáu docs sau khi ghi receipt: `POST_RECEIPT_SNAPSHOT_GUARD: PASS (6 docs unchanged)`, Exit Code **0**. Chỉ receipt mới được append metadata này; six-doc scope pins trên không đổi.

- **Δ-DEV-03 `/admin/workflows`: PENDING USER DECISION**, đã ghi tường minh trong AWEB §5. Không chốt route/redirect/cutover, không mở source packet từ fix này.
- WTV-07 commit/push, live/external WTV evidence, owner cleanup/disposition, RFX-06/RFX-12 decisions và các product/release gates vẫn theo parent/receipt hiện hành; không thay trạng thái từ doc merge.
- cc_1/coordinator có thể re-scan delta để đối chiếu 10 findings; receipt cc_1 cũ giữ nguyên làm lịch sử. Code/source/build/browser/live/DB/Redis/S3/Vault executions trong lượt này: **0**; product pass/fail/skipped **0/0/0**.
