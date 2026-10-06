# COMMIT-PLAN-PREP — checklist stage/commit 1→6 + unit mới (READ-ONLY soạn kế hoạch) — 2026-10-05

**Packet:** COMMIT-PLAN-PREP · lane cc_1 · dispatch 02:22. **Mode:** chuẩn bị thuần — **KHÔNG stage/commit/push**. Dry-run `git add -n` per group (literal, §2) và `git diff --cached --stat` = **RỖNG** (chứng minh chưa stage gì — literal: lệnh exit 0, không dòng output).
**Nguồn:** `PLAN-COMPLETION` §12 (commit plan Part3+4, baseline đã reviewed) + §14/:294 + `plan-update-795` §15 + receipts các packet (focused suites đã đo). Snapshot: 2026-10-05 02:2x +07 · HEAD `b088eec`.

## 0. Quy tắc & sự thật nền

- **dist bị ignore** (`du-rework/.gitignore:2: dist/`) → `packages/contracts/dist/**` **KHÔNG nằm trong bất kỳ commit nào**; committer rebuild `tsc -p packages/contracts/tsconfig.json` **trước mỗi tsc/test của bước tiêu thụ contracts**.
- **File dùng chung nhiều unit** (hunk-split bắt buộc bằng `git add -p`/worktree staging): `submission.ts`, `runtime.ts`, `create-app.ts`, `dispatcher.ts`, `contracts/index.ts`, `contracts/runtime.ts`, `metadata-crypto.ts`, `connector-management.ts`, `route-context.ts`, `server.ts`, `admin.ts`. Hunk-map ở §3.
- **Dry-run chỉ liệt kê FILE** (`git add -n` không có chế độ hunk) — với file dùng chung, dòng `add '<file>'` trong dry-run **không** có nghĩa add cả file; committer phải chọn hunk theo §3.
- **Không gộp** (lane khác/in-flight/meta) — §4.
- Thứ tự đề xuất (§1) giữ prefix c1→c6 của plan gốc; các unit mới xếp sau với lý do.

## 1. Thứ tự đề xuất

`c1 → c2 → c3 → c4 → c5 → c6 → u7 → u8 → u9 → u11 → u12 → u13 → u14 → u15`
(fold **u10 CAPFIX vào u9** — xem §3-Δ; nếu coordinator muốn tách, u10 = runtime.ts caps-hunk + T2 test-add, chạy ngay sau u9).

Phụ thuộc chính: c4 cần c1; u7 sau c2+c3 (sửa chung submission/runtime/create-app); u8 sau c5 (§294: "Composition sau c5"); u9 sau u7 (chung 3 file + contracts field); **u11 sau u9** (SDK forward cần contracts `pinned.promptOverrides` đã vào tree); u12 độc lập c1–c6 nhưng đặt sau u9 cho gọn chung-file; u13 sau u12 (bootstrap/build trên CW-A); u14 độc lập, sau u9; u15 độc lập (admin-read).

## 2. Dry-run literal (`git add -n`, không stage) — 12 nhóm

**c1 — contract freeze** (focused: contracts jest `profile-policy` + `profile-commands` + build exports; tsc cả hai package):
```
add 'du-rework/packages/contracts/src/index.ts'          [SHARED: export c1 + u12]
add 'du-rework/packages/contracts/src/runtime.ts'        [SHARED: c1 + u9]
add 'du-rework/packages/contracts/src/profile-commands.ts'
add 'du-rework/packages/contracts/src/profile-policy.ts'
add 'du-rework/packages/contracts/tests/profile-commands.test.ts'
add 'du-rework/packages/contracts/tests/profile-policy.test.ts'
```
**c2 — producer W1** (focused: w1-sub02 + w1-sub03 + artifact-submit-guards + public-upload-encryption-gateway + url-ingestion ×3 + tsc; import-closure cần `profiles/policy.ts` + `profiles/file-url-auth.ts`):
```
add 'du-rework/services/orchestrator/src/modules/operations/submission.ts'   [SHARED: c2/u7/u9 hunks]
add 'du-rework/services/orchestrator/src/modules/profiles/file-url-auth.ts'
add 'du-rework/services/orchestrator/src/modules/profiles/policy.ts'
add 'du-rework/services/orchestrator/tests/w1-sub02-snapshot-secret.test.ts'
add 'du-rework/services/orchestrator/tests/w1-sub03-sourceurl-extension.test.ts'
```
**c3 — claim + P2** (focused: p730-profile-snapshot + p730-legacy-snapshot-failclosed + mm10 + P2/DD03 controls + tsc):
```
add 'du-rework/services/orchestrator/src/modules/runtime/runtime.ts'         [SHARED: c3/u7/u9/u14 hunks]
add 'du-rework/services/orchestrator/tests/p730-legacy-snapshot-failclosed.test.ts'
add 'du-rework/services/orchestrator/tests/p730-profile-snapshot.test.ts'
```
**c4 — W3 atomic slice** (focused: p730-admin-mutate + p730-prof03-publish-cas + p730-prof03-invariant1 + tsc; ⚠ `apps/admin-web/src/lib/api/client.ts` nằm trong cây `apps/` hoàn toàn untracked mới — đề xuất **defer field này sang unit AWEB**, committer chốt):
```
add 'du-rework/services/orchestrator/migrations/0028_profile_name.sql'
add 'du-rework/services/orchestrator/migrations/0029_audit_actor_principal.sql'
add 'du-rework/services/orchestrator/src/modules/admin-actions/profile-actions.ts'
add 'du-rework/services/orchestrator/src/modules/admin-actions/dispatcher.ts'   [SHARED: c4/u12/u13]
add 'du-rework/services/orchestrator/src/modules/admin-actions/rbac.ts'
add 'du-rework/services/orchestrator/src/modules/auth/session-store.ts'
add 'du-rework/services/orchestrator/src/modules/audit/audit.ts'
add 'du-rework/services/orchestrator/src/app/admin/bff/profiles.ts'      [bff/ có 9 file; CHỈ file này]
add 'du-rework/apps/admin-web/src/lib/api/client.ts'                     [⚠ xem cảnh báo]
add 'du-rework/services/orchestrator/tests/p730-admin-mutate-offline.test.ts'
add 'du-rework/services/orchestrator/tests/p730-prof03-invariant1.test.ts'
add 'du-rework/services/orchestrator/tests/p730-prof03-publish-cas.test.ts'
```
**c5 — W1c leaf/consumer** (focused: p730-acquire-ref-resolver + p730-acquire-consumer-auth + url-ingestion ×3 + tsc):
```
add 'du-rework/services/orchestrator/src/modules/operations/ingestion-consumer.ts'
add 'du-rework/services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts'
add 'du-rework/services/orchestrator/tests/p730-acquire-consumer-auth.test.ts'
add 'du-rework/services/orchestrator/tests/p730-acquire-ref-resolver.test.ts'
```
**c6 — PREFCONSUME leaf** (focused: p730-prefconsume + execution-pin immutable + businesses tsc):
```
add 'du-rework/businesses/document-core/src/actions/prompt-precedence.ts'
add 'du-rework/businesses/document-core/tests/p730-prefconsume.test.ts'
```
**u7 — marker 0030** (§294 "unit riêng": cột+parser cả producer/claim+producer bootstrap; focused: p745-prompt-producer-impl + w1-sub02/03 + tsc):
```
add 'du-rework/services/orchestrator/migrations/0030_prompt_revisions_pin.sql'
add 'du-rework/services/orchestrator/src/modules/operations/submission.ts'   [SHARED: marker hunks]
add 'du-rework/services/orchestrator/src/modules/runtime/runtime.ts'         [SHARED: marker hunks]
add 'du-rework/services/orchestrator/src/app/bootstrap/create-app.ts'        [SHARED: promptOverrides wiring]
add 'du-rework/services/orchestrator/tests/p745-prompt-producer-impl.test.ts'
```
**u8 — Δ-composition** (§294 "composition sau c5 trong lease/commit riêng"; focused: p730-acquire-composition + url-ingestion ×3 + tsc):
```
add 'du-rework/services/orchestrator/src/app/bootstrap/create-app.ts'        [SHARED: resolver compose hunks]
add 'du-rework/services/orchestrator/tests/p730-acquire-composition.test.ts'
```
**u9 — carrier-A (+CAPFIX fold)** (focused 11-suite ×3 đã đo: carrier T1/T2 + producer-impl + w1-sub02/03 + p730-profile/legacy + mm10 + url ×3 + contracts build + tsc):
```
add 'du-rework/packages/contracts/src/runtime.ts'            [SHARED: promptOverrides field hunks]
add 'du-rework/services/orchestrator/migrations/0031_prompt_overrides_ref.sql'
add 'du-rework/services/orchestrator/src/modules/runtime/metadata-crypto.ts'  [SHARED: slot hunks]
add 'du-rework/services/orchestrator/src/modules/operations/submission.ts'    [SHARED: carrier hunks]
add 'du-rework/services/orchestrator/src/modules/runtime/runtime.ts'          [SHARED: carrier+caps hunks]
add 'du-rework/services/orchestrator/tests/p745-prompt-carrier-producer.test.ts'
add 'du-rework/services/orchestrator/tests/p745-prompt-carrier-claim.test.ts'
```
**u11 — SDK pin transport (W1b + B1)** (focused: p745-carrier-sdk-forward + p730-sdk-consume-pin + p730-pinned-policy + worker.test; full SDK 30 suite/691; SDK tsc; chờ u9 vào tree vì cần field contracts):
```
add 'du-rework/packages/worker-sdk/src/task-context.ts'   [SHARED: W1b + B1 hunks]
add 'du-rework/packages/worker-sdk/src/types.ts'          [SHARED: W1b + B1 hunks]
add 'du-rework/packages/worker-sdk/src/worker.ts'         [SHARED: W1b + B1 hunks]
add 'du-rework/packages/worker-sdk/tests/p730-pinned-policy.test.ts'
add 'du-rework/packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts'
add 'du-rework/packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts'
```
**u12 — connector-wire A** (focused: p745-connector-{proxy,actions,boot} + admin-actions-vault04 + connector-revision/credentials + crx01/02 + enc-meta-outbox + tsc):
```
add 'du-rework/packages/contracts/src/connector-management.ts'   [SHARED: view/params (u12) + bootstrap (u13)]
add 'du-rework/packages/contracts/src/index.ts'                  [SHARED: +connector-management export]
add 'du-rework/services/orchestrator/src/modules/connectors/connector-management-store.ts'  [SHARED: core+bootstrap hunks]
add 'du-rework/services/orchestrator/src/http/routes/admin.ts'   [SHARED: CW-A routes + tapi01 (u15)]
add 'du-rework/services/orchestrator/src/modules/admin-actions/dispatcher.ts'  [SHARED: connector.* hunks]
add 'du-rework/services/orchestrator/src/http/route-context.ts'  [SHARED: +connectorManagement +metadataCrypto (u14)]
add 'du-rework/services/orchestrator/src/server.ts'              [SHARED: +connectorManagementHeaders]
add 'du-rework/services/orchestrator/src/app/bootstrap/create-app.ts'  [SHARED: management compose hunks]
add 'du-rework/services/orchestrator/tests/p745-connector-actions.test.ts'
add 'du-rework/services/orchestrator/tests/p745-connector-boot-composition.test.ts'
add 'du-rework/services/orchestrator/tests/p745-connector-management-proxy.test.ts'
```
**u13 — credworkflow** (focused: vault-kv2-writer + compose + e2e + regression 9-suite + contracts build + tsc):
```
add 'du-rework/services/orchestrator/src/modules/connector-credentials/vault-kv2-writer.ts'
add 'du-rework/services/orchestrator/src/modules/connector-credentials/compose.ts'
add 'du-rework/services/orchestrator/src/app/bootstrap/create-app.ts'   [SHARED: compose hunks]
add 'du-rework/services/orchestrator/src/modules/admin-actions/dispatcher.ts'  [SHARED: connector.bootstrap hunks]
add 'du-rework/packages/contracts/src/connector-management.ts'   [SHARED: bootstrap schema hunks]
add 'du-rework/services/orchestrator/src/modules/connectors/connector-management-store.ts'  [SHARED: bootstrap hunks]
add 'du-rework/services/orchestrator/tests/vault-kv2-writer-offline.functional.test.ts'
add 'du-rework/services/orchestrator/tests/credworkflow-compose.test.ts'
add 'du-rework/services/orchestrator/tests/credworkflow-e2e-offline.functional.test.ts'
```
**u14 — ENCMETA-resultref** (focused: encmeta-resultref + detector flip + runtime-lease-fencing + crx01/02 + outbox-source-url + p730 ×2 + tsc):
```
add 'du-rework/services/orchestrator/src/modules/runtime/metadata-crypto.ts'  [SHARED: 2 slots + readStoredText]
add 'du-rework/services/orchestrator/src/modules/runtime/runtime.ts'          [SHARED: writer/R2/R3 hunks]
add 'du-rework/services/orchestrator/src/app/bootstrap/create-app.ts'         [SHARED: metadataCrypto pass hunk]
add 'du-rework/services/orchestrator/src/http/route-context.ts'               [SHARED: metadataCrypto field hunk]
add 'du-rework/services/orchestrator/src/http/routes/public.ts'
add 'du-rework/services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts'
add 'du-rework/services/orchestrator/tests/encmeta-resultref-offline.functional.test.ts'
```
**u15 — T-API-01 closure** (§294 "route/read helper + additive detail contract/test là unit riêng"; focused: tapi01-closure-offline + tsc):
```
add 'du-rework/services/orchestrator/src/http/routes/admin.ts'               [SHARED: tapi hunks]
add 'du-rework/services/orchestrator/src/modules/admin-read/api-key-list.ts'
add 'du-rework/services/orchestrator/src/modules/admin-read/audit-list.ts'
add 'du-rework/services/orchestrator/src/modules/admin-read/business-list.ts'
add 'du-rework/services/orchestrator/src/modules/admin-read/keyset.ts'
add 'du-rework/services/orchestrator/src/modules/admin-read/profile-detail.ts'
add 'du-rework/services/orchestrator/tests/tapi01-closure-offline.test.ts'
```

## 3. Hunk-map cho file dùng chung (committer dùng `git add -p`)

| File | c2 | c3 | c4 | u7 | u9 | u12 | u13 | u14 | u15 |
|---|---|---|---|---|---|---|---|---|---|
| `submission.ts` | W1 snapshot/sourceUrl/CR28 | — | — | bucket read+marker+INSERT $17+options seam | carrier helper+seal+INSERT $18 | — | — | — | — |
| `runtime.ts` | — | P2/T-SUB-04+tuple | — | `parsePromptRevisionsPin`+map+SELECT pin | `openPromptCarrier`+map+SELECT ref+caps | — | — | slots usage/sealResultRef/readStoredText R1(no)/R2/R3 | — |
| `create-app.ts` | — | — | — | `promptOverrides` wiring | — | `connectorManagement` compose+pass+seam+headers | credentialWorkflow compose+seam+adapter | `metadataCrypto` pass | — |
| `dispatcher.ts` | — | — | PROFILE_ACTIONS+profile cases | — | — | `connector.upsert/activate/disable/retire/test` | `connector.bootstrap` | — | — |
| `contracts/index.ts` | profile-policy+commands exports | — | — | — | — | +connector-management | — | — | — |
| `contracts/runtime.ts` | P2/T-SUB-04 snapshot DTO hunks | — | — | — | +`PinnedPromptOverrideSchema`+`promptOverrides` | — | — | — | — |
| `metadata-crypto.ts` | — | — | — | — | +carrier slot | — | — | +2 result slots+`readStoredText` | — |
| `connector-management.ts` | — | — | — | — | — | view/params/targets/test | +bootstrap schema | — | — |
| `route-context.ts` | — | — | — | — | — | +`connectorManagement` | — | +`metadataCrypto` | — |
| `admin.ts` | — | — | — | — | — | CW-A routes+capabilities | — | — | T-API-01 hunks |
| `server.ts` | — | — | — | — | — | +`connectorManagementHeaders` | — | — | — |

**Δ-đề-xuất (gộp CAPFIX vào u9):** CAPFIX (claim caps) sửa cùng file/hunk-vùng với u9 và đã được review+verify chung đợt carrier → gộp cho một commit coherent, tránh 2 commit chạm cùng feature chưa merge. Nếu coordinator muốn theo §397 ("B1/CAPFIX atomic"), tách: u10 = runtime.ts caps-hunk + 2 case trong `p745-prompt-carrier-claim.test.ts`, chạy ngay sau u9.

## 4. KHÔNG gộp (lane khác / in-flight / meta) — tuyệt đối không nhét vào c1–c6/u7–u15

| Nhóm | Ví dụ path (status) | Lý do |
|---|---|---|
| **config.ts lane khác** | `businesses/document-core/src/config.ts` (M) | §12 :292 chỉ đích danh — lane khác |
| **crypto-storage lane khác** | `packages/worker-sdk/src/crypto-storage.ts` (M), `packages/worker-sdk/tests/crypto-storage-plaintext-bound.test.ts`, `services/orchestrator/tests/crypto-storage-plaintext-bound.test.ts` | §12 :292 "worker-sdk/crypto-storage.ts thuộc lane khác" |
| **B2/session wiring (qwen_2, in-flight)** | `businesses/document-core/src/{worker,actions/*,types/*}` (M), `tests/execution-pin.functional.test.ts`, `tests/parser-budgets.test.ts`, `tests/p730-sdk-consume-forwarding*` | đang chạy; chưa có receipt đóng |
| **options/session-leg (qwen_1/cc_3)** | `services/connector/tests/{p745-options-passthrough,p745-session-leg}.test.ts`, `packages/contracts/src/{connector,operations}.ts` (M), `packages/contracts/tests/p745-options-allowlist.test.ts`, `services/orchestrator/tests/p745-options-passthrough?` | unit riêng của lane khác |
| **br12-fix (cc_2)** | `services/orchestrator/tests/br12-isolation-offline.test.ts` (M) + `reports/br12-fix-2026-10-05.md` | unit cc_2 |
| **AWEB/BFF/web** | `services/orchestrator/src/app/admin/bff/*` (8 file còn lại), `tests/aweb0*` (7), `apps/` (toàn bộ), `tests/browser/**`, `components/ui/`, `lib/utils.ts` | UI lane; apps/ untracked toàn cây |
| **coordination/meta** | `coordination/**` (reviews/state/reports/evidence…), `scratch/**`, `.commandcode/**` | vận hành/meta — không phải sản phẩm |
| **docs/infra/perf** | `docs/**`, `tasks/**`, `architecture/**`, `infra/**`, `scripts/dev-live*`, `opt-perf-*.cjs`, `pnpm-lock/workspace`, `services/orchestrator/src/main.ts` (M) | unit riêng (deployment/doc/perf/CONV) |
| **legacy ngoài du-rework** | `app/**` (root), `package.json` root, `tsconfig.json` root, `.gitignore` | dirty cũ ngoài phạm vi du-rework |

## 5. Lưu ý treo (committer/coordinator chốt)

1. **`apps/admin-web/src/lib/api/client.ts` (c4)**: cả `apps/` là untracked mới — thêm 1 file lẻ từ cây chưa có commit nào là bất thường; đề xuất dời sang unit AWEB. c4 giữ danh sách còn lại.
2. **c4 hunk của `audit.ts`/`rbac.ts`/`session-store.ts`**: gồm cả seam additive của các lane sau (T-AUD-01/Δ8) — committer đối chiếu receipt W3 trước khi lấy hunk.
3. **`execution-pin.functional.test.ts` (M)** ruột của c6 nhưng do lane B2 đang sửa — c6 chỉ commit khi file về trạng thái chốt của owner (không tự lấy).
4. **Rebuild contracts dist** trước mọi tsc/test của c2+, u9+, u12+ (dist không tracked).
5. Mọi nhóm phải chạy **focused + tsc trên đúng tree sẽ commit** (§12) — bảng §2 ghi bộ đã đo trong receipts; committer lặp lại trên staged tree trước từng commit.
6. **Không có nhóm nào đã được stage trong packet này** — literal: `git diff --cached --stat` → không output, exit 0.

READ-ONLY compliance: chỉ receipt này được ghi; **0 file staged/committed/pushed**; mọi `git add -n` là dry-run.
