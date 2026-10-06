# Verify + fix + commit worktree RFX/CONV/CRX/ENC-META chưa track (2026-10-03)

**Trạng thái cập nhật 2026-10-04:** đã có bảy receipt WTV-01b/02/03/04/05/06/08 của ngày 2026-10-03, với phạm vi offline/structural/preparation cụ thể ở bảng evidence bên dưới. Chưa đạt full-task `ACCEPTED`; các checkbox giữ nguyên. **WTV-07 commit/push vẫn mở**, không thực hiện commit/push trong packet doc-only này.
Worktree hiện chứa implementation của nhiều lane (RFX crypto/upload, CONV tách file, CRX/ENC-META seam)
tại thời điểm lập plan **chưa có packet track việc verify, fix lệch và commit chúng**. WTV đã bổ sung receipt kiểm tra/preparation; các phần live, cleanup được owner cho phép và commit vẫn cần evidence riêng:
không implement lại, chỉ kiểm tra — sửa lệch — dọn debris — commit.
Các gate `G-ENC`, `G-DATA`, `G-SEC`, `G-COMP`, `G-ADMIN-OPS`, `G-LOCAL-ADMIN`, `G6` giữ **NO-GO**.
Cần coordinator cấp file-lease + Claude Code `APPROVED` trước khi tick `[x]`.

**Quan hệ với packet hiện có (không trùng, không tick thay):**
[RFX-01..16](ORCH-REVIEW-FIXES-2026-10-02.md) = acceptance từng lỗi (giữ nguyên);
[CONV-00..13](CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md) = spec tách file (giữ nguyên);
[CRX-01..05](CODE-REVIEW-ADDENDUM-2026-10-01.md) = seam còn hở (giữ nguyên);
[ORCH-PAR-11..17](ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md) = parity field-level,
vẫn `SPECIFIED` chưa implement, không đụng ở đây.
WTV chỉ chứng nhận **worktree hiện tại** khớp các spec trên rồi đưa lên git.

**Inventory worktree chưa commit (quanh HEAD `b088eec`, đếm lại trước khi nhận — branch dùng chung, nhiều lane):**
12 src modified (`server.ts` 4299→375 dòng + 6 module dirs untracked
`http/routes/`, `app/bootstrap/`, `modules/admin-read/`, `modules/operations/list-query.ts|mappers.ts`;
`audit.ts`, `delivery-encryption.ts`, `crypto-storage-facade.ts`, `upload-encryption-gateway.ts`,
`multipart-service.ts`, `storage-migration.ts`, `integrity-scanner.ts`, `artifact-read-decrypt.ts`,
`submission.ts`, `ingestion-consumer.ts`, `artifacts.ts`);
`runtime.test.ts` 3869→1785 (remaining) + **7 file `runtime-*.test.ts` mới = 8 file test thuộc split**, cộng `helpers/runtime-harness.ts` riêng (CONV-07); hai file runtime có trước không thuộc phép đếm này. Đây là số đo trong receipt WTV-02, không là số test LIVE đã pass;
7 test mới `conv13/crx01/crx02/enc-meta-sentinel/crypto-storage-plaintext-bound` (+1 bản worker-sdk);
`__probe-c63.test.ts` (xóa); markers trong diff: RFX-01/02/03/05/08/15, CRX-01/02, ENC-META-FIX-G1,
CONV-01/02/03/13; **không thấy marker** RFX-04/06/07/09/10/11/12/13/14 (xem WTV-08).

## Task rows

| ID | Task `[ ]` / owner đề xuất | Acceptance cụ thể |
|---|---|---|
| WTV-00 `[ ]` | Reconcile ledger: map từng file modified/untracked → owner packet duy nhất, xác nhận serialize | Bảng file→packet→lease, không file 2 owner cùng lúc; số dòng trước/sau; coordinator ký trước khi WTV-01..05 chạy. |
| WTV-01 `[ ]` | Verify tách `server.ts` (CONV-01/02/03): route inventory trước/sau method/path/auth/status/body/header + 405/unknown; public re-export đủ cho consumer; không circular import; `server.ts` <2000 dòng | Route matrix + focused HTTP tests pass; typecheck; xác nhận fix RFX-10/11/12 không mất trong refactor (cùng đụng `server.ts`). |
| WTV-02 `[ ]` | Verify tách `runtime.test.ts` (CONV-07): đếm test IDs/assertions trước/sau không giảm; giữ `DU_LIVE_INFRA` skip guard; cleanup đúng namespace; mỗi file chạy độc lập, không port/DB collision | 8 file test thuộc split (7 mới + runtime.test.ts remaining), cộng harness riêng; kiểm độc lập + typecheck, receipt ghi namespace/teardown và phân biệt skip-mode với test LIVE thực thi. |
| WTV-03 `[ ]` | Verify RFX crypto: RFX-01 tamper từng header → fail tag, round-trip đúng; RFX-02 matrix RSA/X25519 × pin/compat → `DELIVERY_SUITE_INCOMPATIBLE` fail-closed; RFX-08 vượt ngưỡng fail-closed + RSS trần; RFX-16 rationale đã ghi comment | Focused crypto suites pass; consumer-side decrypt evidence cho wire change RFX-01; 2 bản `crypto-storage-plaintext-bound` (orchestrator + worker-sdk) cùng pass pending quyết định CONV-04/CONV-D01. |
| WTV-04 `[ ]` | Verify RFX upload/storage: RFX-03 public-multipart decision đã thi hành (chặn hoặc seal, không 2 write path lặng lẽ); RFX-05 VersionId pin + delete đúng version; RFX-07 grant replay/conflict; RFX-09 orphan sweep; RFX-13 lock window; RFX-04/06 claim TTL; RFX-14 single-flight + cancel; RFX-15 grant transport hoặc TTL/single-use + log-redaction doc | Focused gateway/multipart/migration suites pass; live S3 versioned-bucket evidence cho row chạm storage (RFX-03/05/09/13). |
| WTV-05 `[ ]` | Verify CRX/ENC-META seam: CRX-01 seal VALUE trước INSERT + READY re-seal + read cùng seam (absent = plaintext lịch sử, không fail sai); CRX-02; ENC-META-FIX-G1 outbox `sourceUrl` sealed | `crx01/crx02/enc-meta-sentinel` suites pass; không vỡ replay/submission test hiện có. |
| WTV-06 `[ ]` | Dọn worktree: xóa `__probe-c63.test.ts`; disposition debris (`.qwen/`, `.qwen-tmp/`, `.openclaude/`, `Q1`, `tl*.json`, `.cache/`) — giữ ngoài commit (gitignore hoặc xóa sau xác nhận owner); `DUGATE_ADMIN_UI_FUNCTIONS.md` ở root: giữ (đưa vào docs/) hay xóa; dispatch-specs untracked giữ làm history | `git status` sau dọn chỉ còn paths verify + plan; secret-scan staged content sạch (không Vault token/private key/`ghp_`) trước push. |
| WTV-07 `[ ]` | Commit + push: stage **chỉ** paths đã verify (src/tests/plan), loại debris; pull --rebase (branch dùng chung) rồi push; message + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` | Remote có commit mới; secret-scan pass; không amend commit đã push. |
| WTV-08 `[ ]` | Gap-check các row RFX không marker (04/06/07/09/10/11/12/13/14): đối chiếu từng row với diff — implemented-không-marker hay còn mở | Mỗi row có verdict `done-in-worktree` (chỉ file:line) hoặc giữ mở về đúng owner RFX; không đóng row bằng suy đoán. |

## Evidence WTV đã có — giới hạn theo từng receipt

Các verdict dưới đây trích phạm vi receipt gốc, không là re-verification trên build mới hoặc full-task acceptance. WTV-00 reconcile/lease và các điều kiện live/review còn thiếu vẫn phải chứng minh trước commit; WTV-07 không có commit/push receipt trong input packet này.

| Row / receipt | Phạm vi đã được báo cáo | Phần còn mở / giới hạn |
|---|---|---|
| WTV-01b — [RFX preserved](../coordination/reports/wtv01b-rfx-preserved-2026-10-03.md) | Independent offline cross-check RFX-10/11/12 sống sót sau CONV; 15/15 tests, tsc 0; `PRESERVED`, drift list rỗng. | Không đóng toàn bộ WTV-01 route inventory; live boot/proxy, PUBLIC_BASE_URL composition và RFX-12 literal deviation còn ngoài proof. |
| WTV-02 — [Runtime split verify](../coordination/reports/wtv02-runtime-split-verify-2026-10-03.md) | `IDENTICAL`: 574 assertions, 97 test names, 8 describe names; 7 file mới + remaining = 8 test files, harness riêng; tsc 0. | **97 test skipped**, không LIVE pass; DB cleanup/parallel LIVE chưa chứng minh, không lấy exit 0 skip-mode làm acceptance hành vi. |
| WTV-03 — [Crypto verify](../coordination/reports/wtv03-crypto-verify-2026-10-03.md) | Offline crypto policy/bound/tamper/RSS, 321 tests pass, 0 fail/skip theo receipt. | External consumer AAD evidence và registry-algorithm finding còn mở; không đóng G-ENC từ offline. |
| WTV-04 — [Upload/storage verify](../coordination/reports/wtv04-upload-storage-verify-2026-10-03.md) | Offline/HTTP-local mechanisms: 225 pass, 5 live-gated skip, tsc 0; VersionId/cancel/single-use findings được đối chiếu. | Live S3/versioned bucket/0025 apply/live PG và các decision còn thiếu; không thay full storage acceptance. |
| WTV-05 — [CRX/ENC-META verify](../coordination/reports/wtv05-crx-encmeta-verify-2026-10-03.md) | Offline seal/read/READY/sentinel seam và 87/87 replay/submission/ingestion regression; CRX-02 pass cô lập, batch có port flake được ghi rõ. | Live encrypted S3/manifest/version/migration-window required-mode chưa được chứng minh; không chuyển offline mocks thành live receipt. |
| WTV-06 — [Cleanup preparation](../coordination/reports/wtv06-prep-2026-10-03.md) | Debris inventory/gitignore và secret-scan trên tập will-commit của snapshot gốc; **0 file bị xóa**. | Deletion/untrack/disposition cần owner decision riêng; secret-scan staged set phải chạy lại trước push, không reuse số 368 cho worktree hiện tại. |
| WTV-08 — [RFX gap-check](../coordination/reports/wtv08-rfx-gapcheck-2026-10-03.md) | Static mechanisms/diff inventory; phân biệt done-in-worktree, self-authored và còn mở; WTV-01b bổ sung independent verify cho RFX-10/11/12. | RFX-06 TTL decision/wiring, RFX-12 deviation và live lock/consumer/storage proof còn mở; static verdict không tự tick RFX/WTV parent. |

## Thứ tự

WTV-00 reconcile trước. WTV-01..05 song song theo lease file-disjoint (WTV-01 giữ `server.ts`/routes/bootstrap
độc quyền; WTV-03/04/05 disjoint modules). WTV-08 chạy cùng lượt verify để khỏi commit thiếu. WTV-06 → WTV-07
cuối cùng, sau khi mọi verify có receipt (command, cwd, build digest, pass/fail/skip, exit code, raw log).
Live S3/Vault/PG evidence cho row chạm storage/crypto/migration; mock xanh không thay live.
Không sửa behavior trong WTV (lệch behavior → mở task chức năng riêng, không lẫn vào verify/commit).
