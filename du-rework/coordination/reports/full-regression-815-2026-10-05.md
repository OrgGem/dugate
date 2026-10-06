# FULL-REGRESSION-815 — 2026-10-05

Độc lập chạy regression trên working tree hiện tại, chỉ đọc product/test source. Không sửa source hoặc test, không commit và không tick checkbox. Kết quả hiện tại: không có regression fail mới trong `@du/orchestrator` hoặc `@du/worker-sdk`; `@du/contracts` có 2 assertion fail đã được chứng minh tồn tại trước wave bằng A/B hash trong receipt P745.

## Full package suites

| Package / command | Suites | Tests | Exit |
|---|---:|---:|---:|
| `pnpm --filter @du/orchestrator test` | 190 passed, 26 skipped, 0 failed / 216 | 4,712 passed, 230 skipped, 0 failed / 4,942 | **0** |
| `pnpm --filter @du/contracts test` | 26 passed, 1 failed / 27 | 525 passed, 2 failed / 527 | **1** |
| `pnpm --filter @du/worker-sdk test` | 30 passed, 0 failed / 30 | 692 passed, 1 todo, 0 failed / 693 | **0** |
| **Gộp, không tính các lượt focused chạy lặp** | 246 passed, 26 skipped, 1 failed / 273 | 5,929 passed, 230 skipped, 2 failed, 1 todo / 6,162 | — |

Raw output và file exit code tương ứng: [orchestrator](raw/full-regression-815-2026-10-05/orchestrator-full-suite.log), [contracts](raw/full-regression-815-2026-10-05/contracts-full-suite.log), [worker-sdk](raw/full-regression-815-2026-10-05/worker-sdk-full-suite.log). Mỗi package có file `.exit.txt` cùng tên gốc; exit được ghi literal (`EXIT_CODE=0`, `EXIT_CODE=1`, `EXIT_CODE=0`).

### Phân loại lỗi

Lỗi duy nhất là `packages/contracts/tests/vault-policies.test.ts`: dòng 104 và 179 gọi `expect(...).toThrowError(...)`, nhưng runner trả `TypeError: expect(...).toThrowError is not a function`. Chạy lại riêng qua test script của package cho **1 suite; 2 failed, 60 passed / 62; exit 1** ([raw rerun](raw/full-regression-815-2026-10-05/contracts-vault-policies-test-script.log), [exit](raw/full-regression-815-2026-10-05/contracts-vault-policies-test-script.exit.txt)).

Đây là lỗi **pre-existing**, không quy cho wave: [receipt P745](p745-carrier-impl-a-2026-10-04.md) ghi nhận A/B đã khôi phục và hash-verify byte-exact contracts source pre-edit (`prev sha 4cc34f0f… MATCH: true`), rồi chạy riêng đúng suite với đúng hai `toThrowError is not a function`, **2 failed/60 passed, exit 1**. Hiện không thấy assertion failure mới trong ba package từ lần chạy này. Những lỗi fixture/compile đã nêu ở các receipt giữa wave không tái hiện ở đây: full orchestrator hiện compile và chạy qua 190 suite; nhóm outbox hiện xanh.

## Suites tập trung vào các thay đổi của wave

Chạy cùng lượt focused với `jest --runInBand --runTestsByPath`; kết quả **12 suites passed, 275 tests passed, 0 failed, exit 0** ([raw](raw/full-regression-815-2026-10-05/orchestrator-metadata-ingestion-outbox-focused.log), [exit](raw/full-regression-815-2026-10-05/orchestrator-metadata-ingestion-outbox-focused.exit.txt)). Các file được chạy:

| Phần cần hồi quy | Suite được chạy | Kết quả xác nhận |
|---|---|---|
| BA-01 / BA-02 / BA-05 | `bypass-fix-810.test.ts` | Reader TEXT mở envelope, no-seam fail-closed cho envelope, và gate yêu cầu đủ đúng tám slot có test. Receipt nền ghi suite riêng 13/13. |
| BA-04 | `ba04-fix-811.test.ts`, `url-ingestion-consumer-offline.functional.test.ts` | Nhánh consumer xử lý chuỗi/envelope, tamper, AAD sai tenant và không có seam được kiểm tra; hiện cả hai suite nằm trong lượt focused xanh. Receipt BA-04 ghi 13/13 cho suite mới và regression 9 suite ×3, 186/186 mỗi lượt. |
| Wrapper / no-seam | `wrapper-fix-812.test.ts` | Wrapper và reader cùng từ chối sealed TEXT/JSONB khi thiếu seam; plaintext hợp lệ vẫn giữ hành vi; tamper và AAD sai bị từ chối. Receipt ghi suite 11/11. |
| A17 auth counter | `gate-authenticate-808.test.ts` | Kiểm tra census tenant độc lập, tenant thiếu, counters/coverage, empty-slot reasons và gate fail-closed; hiện suite xanh trong lượt focused. |
| Metadata crypto / kết quả | `runtime-encryption-metadata.test.ts`, `encmeta-resultref-offline.functional.test.ts`, `encmeta-enc09-kind.test.ts`, `submission-metadata-crypto-e2e.test.ts` | Có regression quanh seal/open, runtime metadata, result-reference và submission. |
| Legacy migration | `legacy-payload-migration.test.ts` | Migration payload legacy được chạy và pass. |
| Outbox | `enc-meta-sentinel-outbox-source-url.test.ts`, `enc-meta-sentinel-runtime-refs.test.ts` | Hai suite outbox/source URL và runtime refs đều nằm trong lượt focused 275/275 xanh. Receipt [VERIFY-WRAPPER-FIX-813](verifier-wrapper-fix-813-2026-10-05.md) cũng xác nhận suite outbox hiện hành 6/6, exit 0; lỗi mock 5/6 cũ đã được sửa và không tái hiện. |

Focused rerun gồm cả suite mới và regression trực tiếp; kết quả này không cộng lần thứ hai vào tổng package suite phía trên.

### A17 trên PostgreSQL 16 disposable

Để xác nhận RLS thay vì chỉ dựa vào fake DB, chạy `gate-authenticate-808-pg16.test.ts` trên PostgreSQL 16 mới, loopback-only, data directory tmpfs, database `gate810`; test tự migrate schema và tạo restricted reader/policy. Kết quả **1 suite passed; 2 tests passed, 0 failed; exit 0** ([raw](raw/full-regression-815-2026-10-05/orchestrator-a17-pg16-live-test.log), [exit](raw/full-regression-815-2026-10-05/orchestrator-a17-pg16-live-test.exit.txt)). Ca RLS xác nhận census thấy hai tenant qua connection không bị giới hạn, reader chỉ nhìn thấy một tenant; dù đủ 8/8 slot query thành công, coverage đánh dấu tenant còn thiếu và gate trả `FAIL`. Ca cùng suite còn xác nhận dữ liệu có envelope sai/tamper/plaintext làm gate fail. Container đã dừng và bị xóa theo `--rm`; không kết nối DB dự án.

Đây là kiểm chứng DB PostgreSQL thật cho logic census/RLS. Key provider trong fixture là deterministic stand-in theo mô tả của test, **không phải Vault thật**.

## TypeScript noEmit

| Command | Exit | Output |
|---|---:|---|
| `pnpm --filter @du/contracts exec tsc --noEmit -p tsconfig.json` | **0** | rỗng |
| `pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json` | **0** | rỗng |
| `pnpm --filter @du/worker-sdk exec tsc --noEmit -p tsconfig.json` | **0** | rỗng |
| `pnpm --filter @du/admin-web exec tsc --noEmit -p tsconfig.json` | **0** | rỗng |

Mỗi lệnh có raw `.log` (0 byte) và `.exit.txt` trong thư mục raw bên dưới.

## Phần chưa được chứng minh

- 26 suite / 230 test của orchestrator bị skip trong full run; các live-gate env chưa được bật khi chạy package suite. Không tính các test này là pass.
- Không chạy trên Vault thật, không xác minh unwrap bằng Vault thật, và không đọc inventory DB dự án. PG16 test chứng minh behavior của counter với census/role/policy fixture, không chứng minh production census đầy đủ hay cấu hình RLS của môi trường dự án.
- Không có bằng chứng từ lượt này về giá trị/dữ liệu production trong tám slot. Vì vậy không kết luận DB dự án đang sạch hay gate trên DB đó sẽ pass.

## Raw evidence và SHA-256

Toàn bộ raw logs, exit code files và danh sách digest: [thư mục raw](raw/full-regression-815-2026-10-05/) · [SHA256SUMS.canonical.txt](raw/full-regression-815-2026-10-05/SHA256SUMS.canonical.txt). Đã xác minh đủ **20/20** digest trong manifest; SHA-256 của manifest là `B89C73F1E36739E984814B623358E47E4078B3FD9CE91443420E90E7EBCB4845`.
