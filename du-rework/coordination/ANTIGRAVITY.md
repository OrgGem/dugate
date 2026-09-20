# Assignment — Antigravity — document business lane

## Objective

Implement business document-core chứa cả sáu API actions và document-kit package theo plan. User đã cho phép implementation, không chỉ tiếp tục viết plan. Checkout `C:/Users/gem/Documents/GitHub/dugate`; app cũ chỉ đọc tham khảo.

Read `coordination/README.md`, docs 01/03/05/09/10/13/14 và task packets P0/P4/P5.

## Owned paths

`du-rework/businesses/document-core/**`, `du-rework/packages/document-kit/**`, `coordination/reports/antigravity.md`, `coordination/requests/antigravity.md`.

Không sửa root config/lock, contracts, worker-sdk, connector-client, services, infra/shared tests, central docs/tasks/gates. Không sửa .env, migrate old DB hoặc import source cũ. Không chạy npm install hay tạo nested lockfile; tạo package manifests cho lane mình và gửi dependency requests cho Claude.

## Start now — useful independent work

1. P0-02/05: viết đủ sáu business action BRDs trong `businesses/document-core/docs/`, field dictionary, expected result và 28 variant case matrix: ingest4/extract5/analyze5/transform5/generate6/compare3.
2. Inventory reference registry/runner/parsers nhưng không copy lỗi checkpoint/implicit native parser bypass inference. Input/output compatibility khác biệt ghi trong business-local doc, đề nghị Claude cập nhật central docs khi cần.
3. P4 document-kit subset: generic stream/parser/converter/archive interfaces, synthetic DOCX/XLSX fixtures, test cases và pure local functions. Worker-sdk sở hữu runtime artifact grant/access client; document-kit nhận authorized stream/adapter qua interface, không gọi platform DB.
4. Document-core local validation/formatting/recipe design và tests có thể làm trước shared runtime ready. Wire/public DTO đợi contracts-v1; không create duplicate @du/contracts schema.

## After gates

Claude sẽ publish `coordination/gates/contracts-v1.md`, `workspace-ready.md`, `runtime-ready.md`, `sdk-ready.md`. Đọc ở mỗi checkpoint, dùng exact exported interfaces.

Sau action BRDs và contract freeze: P5-01..03 manifest/common pipeline interfaces/tests. Sau SDK actual readiness: P5-04..09 implement cả sáu actions, provider calls chỉ qua ctx connector facade, local parse qua document-kit, stable step IDs/full checkpoints, correct output validation. Sau Connector/runtime ready: P5-10 six-action E2E và 28 variant coverage với mock provider.

Không dừng chỉ ở action happy path hoặc README. Implement local behavior đầy đủ trong scope; dependent integration chỉ làm khi gates sẵn sàng. Nếu hết independent work trước gate, ghi WAITING_GATE rõ trong report rồi checkpoint; Claude sẽ nudge continuation. Không tự edit SDK/contracts để bypass dependency.

## Acceptance

DOC-01..06 và ART parser/archive controls; 28 variants typed inputs/results; native parse không thay thế extraction/analysis; source/target validation; full checkpoint >500 chars; provider malformed output không succeeded; schema/format errors rõ; one document-core image, one versioned manifest. Report commands/actual results và unresolved integration gates, không tuyên bố mock/stub-only là production done.

Không git checkout/stash/reset/clean, không commit/stage shared repo, không spawn agent. Tất cả coordination write chỉ report/request file của bạn, không task master hoặc peer files.
