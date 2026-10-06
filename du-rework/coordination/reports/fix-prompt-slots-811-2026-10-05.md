# FIX-PROMPT-SLOTS-811

- Task: `task_f2ca1256273e`; context: `ctx_c9c0515e5fbc`.
- Owner: Codex, yêu cầu trực tiếp; lease: settings contract, references liên quan, regression test.
- Receipt: 2026-10-05, khoảng 10:00–10:05 Asia/Bangkok (UTC+07).
- Workspace: `D:/Git/dugate/du-rework`, working tree chưa commit; các file contract/fixture đang untracked từ trước trong shared workspace nên không dùng `git diff` làm bằng chứng đầy đủ.

## Nguồn chuẩn và thay đổi

Đã đọc `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:65–69`: `ai_image_prompt → promptDefaults.image`, `ai_pdf_prompt → promptDefaults.pdf`, `ai_docx_prompt → promptDefaults.docx`, `ai_compare_prompt → promptDefaults.compare`, `ai_generate_prompt → promptDefaults.generate`. UI catalog `apps/admin-web/src/features/settings/catalog.ts:44–48` đã khớp spec. Danh sách slot theo đúng thứ tự spec là `image, pdf, docx, compare, generate`; không lấy tên các dịch vụ API làm slot.

Source sửa trong packet:

1. `packages/contracts/src/settings.ts`: sửa tuple `SETTINGS_PROMPT_SLOTS`, schema `SettingsPromptDefaultsSchema` và comment nguồn chuẩn. Type `SettingsPromptSlot`, `SettingsPromptDefaults`, read DTO và partial write DTO tự suy ra từ contract đã sửa. Partial prompt write dùng `.strict()` để từ chối tên sai thay vì âm thầm bỏ field; read vẫn strip unknown fields như redaction contract hiện hành.
2. `services/orchestrator/tests/bff-settings-identity.test.ts`: sửa upstream fixture sang năm slot đúng. BFF source dùng `SettingsReadSchema` chung nên không có mapping riêng cần đổi; đã rebuild contracts dist trước test/typecheck orchestrator.
3. `packages/contracts/tests/settings-prompt-slots-spec.test.ts`: đọc file spec thực từ filesystem, trích mapping tại mục 3, kiểm cardinality/uniqueness, tuple/order/schema, giữ đúng từng value, thiếu bất kỳ slot nào phải fail, partial write đúng slot và reject tên dịch vụ cũ. Test cũng đọc UI catalog hiện có và đối chiếu legacy-key/slot mapping với spec. Expected danh sách đúng được lấy từ spec, không hardcode trong test.

Đã tìm toàn bộ tham chiếu `promptDefaults`, `SettingsPromptDefaults`, `SettingsPromptSlot`, `SETTINGS_PROMPT_SLOTS` trong contracts, orchestrator và admin-web (và source/test TypeScript của rework): không còn mapping `promptDefaults` sang extract/analyze/transform ngoài negative regression assertions. Admin-web catalog đã đúng nên không sửa source UI. Các tên dịch vụ extract/analyze/transform ở nghiệp vụ/API khác không bị đổi.

Không sửa UI catalog, spec, migration; không commit, không tick task, không đổi rollout/gate/ledger.

## Regression trước/sau và kiểm tra thực

Môi trường offline: Jest/ts-jest, BFF với HTTP loopback stub; không DB/Redis/S3/Vault thật. `tsc` là source checks theo tsconfig của từng package; regression test được ts-jest compile trong lượt chạy test. Không chạy live UI hoặc toàn bộ orchestrator suite.

| Kiểm tra | Cwd dưới workspace | Lệnh | Kết quả | Exit | Raw output |
|---|---|---|---|---|---|
| Regression trước sửa contract | `packages/contracts` | `pnpm test -- --runTestsByPath tests/settings-prompt-slots-spec.test.ts` | **3 failed, 2 passed, 5 total**: tuple/schema không khớp spec, write bỏ mất image | **1** | Tool output của lượt red trước sửa; không redirect ra file |
| Regression sau sửa | `packages/contracts` | `pnpm test -- --runTestsByPath tests/settings-prompt-slots-spec.test.ts` | **5 passed / 5** | **0** | [spec-regression.log](fix-prompt-slots-811-spec-regression.log) |
| Full contracts suite | `packages/contracts` | `pnpm test` | **525 passed, 2 failed / 527**; 26 suites pass, 1 fail | **1** | [contracts-tests.log](fix-prompt-slots-811-contracts-tests.log) |
| BFF settings/identity | `services/orchestrator` | `pnpm test -- --runTestsByPath tests/bff-settings-identity.test.ts` | **24 passed / 24**, 1 suite pass | **0** | [orchestrator-tests.log](fix-prompt-slots-811-orchestrator-tests.log) |
| Contracts build | `packages/contracts` | `pnpm build` (`tsc -p tsconfig.json`) | Build thành công, refresh dist cho consumers | **0** | [contracts-build.log](fix-prompt-slots-811-contracts-build.log) |
| Contracts tsc | `packages/contracts` | `pnpm exec tsc --noEmit -p tsconfig.json` | Không diagnostics | **0** | [contracts-tsc.log](fix-prompt-slots-811-contracts-tsc.log) (empty stdout/stderr) |
| Orchestrator tsc | `services/orchestrator` | `pnpm exec tsc --noEmit -p tsconfig.json` | Không diagnostics | **0** | [orchestrator-tsc.log](fix-prompt-slots-811-orchestrator-tsc.log) (empty stdout/stderr) |
| Admin-web tsc | `apps/admin-web` | `pnpm exec tsc --noEmit -p tsconfig.json` | Không diagnostics | **0** | [admin-web-tsc.log](fix-prompt-slots-811-admin-web-tsc.log) (empty stdout/stderr) |

Hai lỗi full contracts suite: `tests/vault-policies.test.ts:104` và `:179`, cùng `TypeError: expect(...).toThrowError is not a function`. File này không bị sửa trong packet. Không báo full suite xanh và không sửa test Vault ngoài lease.

Lượt dựng test ban đầu gặp TS2538/TS2464 do regex captures được strict TypeScript coi là có thể undefined (0 tests, exit 1). Đã sửa handling captures trước lượt red thực nêu trong bảng; không tính lỗi compile đó là bằng chứng regression.

5 test regression đã nằm trong 527 test full contracts; không cộng lượt chạy lặp thành test độc lập. Focused checks liên quan task: 5 regression + 24 BFF = **29/29 pass**; broader full contracts vẫn có 2 lỗi như trên. Chưa có reviewer verdict hoặc acceptance độc lập.

SHA256 nguồn chuẩn lúc rà soát (chỉ đọc trong packet):

- Spec: `B15CE8FC3A7199618E8001C494AAA2CBE70F3C00FAD6A400C6DEFA0C24C53AA1`.
- UI catalog: `FF3B977E003ABB022E6EB9B7F21C30E245A97F6D6B78E10077F304C628955CDD`.
