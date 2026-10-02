# D5 — document-core: đăng ký `doc-compare` thành handler kind + action thật

## Bối cảnh

D3 (disbursement) đã **committed** (`6fb5294`) — `worker.ts`/`manifest` đã free, lease HIGH trước đây đã hết.
Probe `coordination/reports/codex-d5-scope-probe-doc-compare-registration-2026-10-01.md` đã map đủ **13 mount point**;
kết luận: doc-compare là **kind + action riêng, KHÔNG gộp vào `compare`** (input contract khác, execution model
multi-turn khác, precedent manifest tách action).

**Coordinator decisions:** (1) connector slot dùng **1 slot mặc định `reasoning`** theo `DEFAULT_DOC_COMPARE_BINDING`;
(2) connector-side task names `doc_compare_structure`/`doc_compare_references` vẫn **OPEN** — chỉ ghi nhận, KHÔNG tự đổi connector.

## Mục tiêu (theo probe §1)

1. `src/worker.ts`: import public surface doc-compare; register key `doc-compare` trong `documentCoreHandlers` (:1244);
   handler block dùng `createDocCompareRuntime` (runner D4 — mỏng, không inline connector như disbursement);
   continuation đúng `spawn-chunk-children | wait-for-review | terminate`; checkpoint save/restore; join; resume;
   **fail-closed** khi thiếu connector slot / lỗi connector / evidence thiếu ⇒ FAILED + errorCode; KHÔNG fabricate output; KHÔNG fake terminal state.
2. `src/manifest/document-core.manifest.ts`: thêm `'doc-compare'` vào `handlerKinds` (:19); action object mới
   (input/output/profile schemas, `connectorSlots` **1 slot**, artifactPolicy, capabilities, defaultLimits);
   cập nhật comment danh sách kinds (:1242).
3. `src/recipes/step-keys.ts`: group `DOC_COMPARE`; `src/recipes/recipe-definitions.ts`: `'doc-compare'` vào action union (:16)
   + `WORKFLOW_RECIPES['doc-compare:workflow']` + `getWorkflowRecipe`.
4. `src/pipelines/workflows/doc-compare/index.ts`: thêm re-export `createDocCompareRuntime` từ `./runner` (gap của D4, probe §0b).
5. Cập nhật test hiện có **trung thực** (action/kinds count, missing-variants nếu bị ảnh hưởng); thêm test registration tối thiểu
   theo pattern D3. Ghi rõ số cũ → số mới trong receipt.

## Ranh giới (tuyệt đối)

- KHÔNG chạm: `pipelines/workflows/disbursement/**` (qwen_2), `actions/compare/**`, `server.ts`, `contracts/**`,
  gates, `tasks/*.md`, `AGENTS.md`, lockfile.
- KHÔNG đổi public wire; nếu thấy bắt buộc đổi wire → **STOP + báo** (thuộc COMP-00).
- KHÔNG tick gate; KHÔNG commit. 31 variant giữ nguyên.

## Acceptance

- Focused: `manifest.test.ts` + `sdk-consumer.test.ts` + `missing-variants.test.ts` (+ `p9-03-doc-compare*.test.ts` nếu liên quan) → 0 red, exit 0.
- Full document-core suite: ghi literal counts, **không thêm red mới** so với baseline verified gần nhất (P9-01 verify: P9-01 49/49, manifest 15/15).
- `tsc --noEmit` document-core + orchestrator → exit 0.
- Receipt: `coordination/reports/qwen-d5-doc-compare-registration-2026-10-02.md` — diff tóm tắt + số liệu + §OPEN (connector task names, slot decision).

## COMMON

- Lease: `worker.ts` + `manifest` + `recipes/**` + `doc-compare/**` thuộc lane này (D4 cũ của bạn); disbursement/** thuộc qwen_2.
- Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai, ADMIN fallback, plaintext fallback, fake terminal state).
- Không nhắn `nocobase-10`. Không sửa AGENTS.md/tasks/README/execution overlay.
- DEV TEST ISOLATION nếu cần (dự kiến không cần).
