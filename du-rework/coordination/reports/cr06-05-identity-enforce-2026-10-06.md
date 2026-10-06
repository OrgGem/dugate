# CR06-05 — Fail-closed service identity trên mọi composition path

- **Task:** CR06-05 / MEDIUM (SEC, G-SEC nối CR28-02), parent `tasks/CODE-REVIEW-FOLLOWUP-2026-10-06.md:15`
- **Owner:** oc_4 (OpenCode), Connector lane
- **Ngày:** 2026-10-06
- **HEAD:** `b088eececcb5f3df0b4edbe073a29401dafda624` (branch `codex/fix-workflow-builder`)
- **Trạng thái:** IMPLEMENTED offline — **chưa** VERIFIED độc lập, **chưa** ACCEPTED. **Không commit, không tick** theo yêu cầu packet.
- **Phạm vi:** `services/connector/src` + test harness consumer + note `docs/08-connector-api.md`. Không tạo gate mới; G-SEC giữ NO-GO.

## 1. Hiện trạng trước khi sửa (đọc tại chỗ, không suy từ receipt)

- `services/connector/src/http/server.ts:131`: `if (dependencies.identityVerifier && path !== '/health/live' && path !== '/health/ready')` → thiếu verifier = mở toàn bộ non-health route (`/connectors*`, `/invocations*`, `/capabilities`).
- `services/connector/src/composition.ts:82-84`: production branch throw khi thiếu `serviceIdentityVerifier || grantVerifier || credentialCipher`; **nhánh `overrides` (:55-80) không guard** → composition test/override chạy không verifier mà không báo.
- Hệ quả: mọi harness override/direct-constructor (routing, lifecycle, provider diagnostics, credential lifecycle, readiness) chạy trần; behavior fail-open không bị bất kỳ test nào bắt.

## 2. Thay đổi

| File | Thay đổi |
|---|---|
| `services/connector/src/http/server.ts` | Thêm `ConnectorHttpDependencies.allowUnauthenticatedTestTraffic?` (JSDoc carve-out, :60-75). Thêm `resolveIdentityVerifier()` fail-closed (:87-108): có verifier → dùng; flag + test runner → `null` + `console.warn`; flag ngoài test runner (không `NODE_ENV=test`/`JEST_WORKER_ID`/`VITEST`) → throw; không có gì → throw. `createConnectorServer` resolve **một lần lúc construction** (:117) và truyền verifier đã resolve vào `route` (:176, :185). Health probes vẫn ngoài enforcement. |
| `services/connector/src/composition.ts` | Nhánh `overrides` (:55-61) thêm `identityVerifier: overrides.http.identityVerifier ?? config.serviceIdentityVerifier` → override path enforce cùng contract với production; thiếu cả hai thì server construction fail-closed. |
| `services/connector/src/identity.ts` | JSDoc threat-model HMAC ngắn trên `HmacServiceIdentityVerifier` (:5-18), trỏ về note đầy đủ trong docs. |
| `docs/08-connector-api.md` | Thêm mục **“Threat-model note — HMAC service identity (CR06-05)”** (bề mặt/tài sản, giả mạo chữ ký, replay, audience/scope, fail-closed + carve-out, residual risk). Cập nhật line ref router `:128`→`:169`, `:131`→`:178`. |
| Test harness opt-in carve-out (mỗi file +1 dòng `allowUnauthenticatedTestTraffic: true`) | `services/connector/tests/{runtime-foundations (x2), retry-signal-passthrough, reliability-security, r1-d-lifecycle-offline, r1-d-03-mock-provider-reconciliation.functional, provider-rejection-diagnostics, security-lifecycle, composition}.test.ts`, `tests/integration/sec-int-01-credential-lifecycle.integration.test.ts`. |
| `services/connector/tests/cr06-05-identity-enforcement.test.ts` | **Mới**: 19 test — ma trận identity trên cả hai path + guard fail-closed/carve-out. |

### Quyết định thiết kế (fail-closed + carve-out tường minh)

Chọn **fail-closed mặc định**: `createConnectorServer` throw ngay khi construction nếu không có verifier và không có carve-out. Vì ~9 harness offline cố ý chạy server trần (routing/lifecycle/diagnostics/readiness/credential HTTP), nếu chỉ fail-closed thuần sẽ phải gắn verifier thật vào từng harness — đổi ngữ nghĩa test không liên quan — nên dùng **carve-out test-only với 3 khóa**:

1. **Flag tường minh per-harness** `allowUnauthenticatedTestTraffic: true` → allowlist grep được (`grep -r allowUnauthenticatedTestTraffic`);
2. **Chỉ chấp nhận dưới test runner** (`NODE_ENV=test` hoặc `JEST_WORKER_ID` hoặc `VITEST`); ngoài test runner là **throw**, không âm thầm mở;
3. **Log** `console.warn` mỗi lần carve-out kích hoạt.

Production composition không có đường bật cờ (`ConnectorConfig` không chứa field này), và production branch đã guard security config từ trước — nay có thêm lớp throw tại server construction. Nếu coordinator muốn siết hơn (bỏ hẳn carve-out), chỉ cần chuyển các harness trong allowlist sang verifier thật; test CR06-05 sẽ là lưới bắt.

## 3. Threat-model note HMAC (nội dung chính)

Note đầy đủ tại `docs/08-connector-api.md` § *Threat-model note — HMAC service identity (CR06-05)*:

- **Giả mạo:** HMAC-SHA256 trên `header.payload`, secret 32 byte chia sẻ; so sánh `timingSafeEqual` (`contract-grants.ts:30`), từ chối `alg != HS256`; secret từ `SERVICE_IDENTITY_SECRET`, không log.
- **Replay trong TTL:** chấp nhận có kiểm soát (token management `exp=iat+60`), chưa có `nbf/iat`/revocation list — thu hồi bằng xoay secret.
- **Audience/scope:** bắt buộc `aud=connector`; `/connectors*` cần `connector:manage`, còn lại (trừ health) cần `connector:invoke`; thiếu scope 403 `BINDING_DENIED`, thiếu/sai/hết hạn 401 `GRANT_INVALID`.
- **Fail-closed + carve-out test:** như mục 2; production không bật được cờ.
- **Residual:** ai giữ secret mint được mọi token (symmetric); vẫn phải chặn public ingress vào Connector.

## 4. Bằng chứng test (cwd `D:\Git\dugate\du-rework`, Windows, Node v22.16.0, pnpm 10.18.3)

| # | Lệnh | Kết quả | Raw |
|---|---|---|---|
| 1 | `pnpm --filter @du/connector exec jest tests/cr06-05-identity-enforcement.test.ts --runInBand` | **1 suite / 19 passed / 0 failed**, exit 0 | `coordination/reports/raw/cr06-05-focused-2026-10-06.txt` |
| 2 | `pnpm --filter @du/connector run test:unit` | **29 suites passed / 374 passed / 1 skipped / 375 total**, exit 0 | `coordination/reports/raw/cr06-05-connector-unit-2026-10-06.txt` |
| 3 | `pnpm --filter @du/connector run typecheck` | exit **0** | (output rỗng) |
| 4 | `pnpm --filter @du/connector run build` | exit **0** | (output rỗng) |
| 5 | `pnpm --filter @du/orchestrator exec jest tests/connector-revision-http-offline.functional.test.ts --runInBand` | **1 suite / 8 passed**, exit 0 — consumer nạp **connector dist** sau rebuild | `coordination/reports/raw/cr06-05-orchestrator-dist-consumer-2026-10-06.txt` |

Ghi chú trung thực về run #2: suite thứ 29 là `services/connector/tests/cr06-04-async-202-session.test.ts` do **lane khác thêm đồng thời** lúc 13:31 trong lúc packet này chạy — không thuộc CR06-05; run 28-suite trước đó (366 passed) đã xanh trước khi file kia xuất hiện. Ca `1 skipped` là `live usage_events projection` bị `jest.unit.config.cjs` loại từ trước (pre-existing), không phải skip mới.

### Ma trận test CR06-05 (19 test)

- **Direct `createConnectorServer` path** (verifier thật `HmacServiceIdentityVerifier`): missing / wrong signature / expired → **401 `GRANT_INVALID`** trước khi store/runtime được gọi (assert `list`/`invoke` không chạy) cho cả `/connectors` lẫn `/invocations`; wrong scope → **403 `BINDING_DENIED`**; valid manage/invoke → 200 (chứng minh không phải blanket deny); health no-auth → 200.
- **Composition overrides path**: (a) verifier chỉ ở `config.serviceIdentityVerifier` → missing/wrong/expired **401**, valid → 200; (b) verifier qua `overrides.http.identityVerifier` → 401 khi thiếu token; (c) không verifier + không flag → **construction throw**; (d) flag + test runner → log `CR06-05 test-only carve-out active` và phục vụ không identity.
- **Construction guards**: `resolveIdentityVerifier` throw khi thiếu cả hai; flag bị **reject khi giả lập runtime production** (xóa `JEST_WORKER_ID`/`VITEST`, `NODE_ENV=production`) — env được restore trong `finally`; production branch thiếu security config vẫn throw (giữ test cũ trong `composition.test.ts`).

### Mutation evidence

| Mutation | Kết quả | Ý nghĩa | Raw |
|---|---|---|---|
| **M1**: trả `null` thay vì throw khi thiếu verifier + gỡ guard test-runner (restore hành vi fail-open trước CR06-05) | **4 failed / 15 passed / 19** | Đúng 4 ca fail-closed chết: `resolveIdentityVerifier throws`, `carve-out rejected outside test runner`, `createConnectorServer refuses`, `composition override refuses` | `coordination/reports/raw/cr06-05-mutation-m1-2026-10-06.txt` |
| **M2**: gỡ dòng fallback `?? config.serviceIdentityVerifier` ở composition overrides | **1 failed / 18 passed / 19** | Đúng ca `enforces the verifier inherited from composition config` chết | `coordination/reports/raw/cr06-05-mutation-m2-2026-10-06.txt` |

Cả hai mutation chạy trên file backup riêng; **restore byte-exact** (đối chiếu SHA256 tại chỗ) và suite xanh lại 19/19 sau restore.

## 5. Contract / consumer

- Thêm field optional `allowUnauthenticatedTestTraffic?: boolean` (test-only) vào `ConnectorHttpDependencies`; export mới `resolveIdentityVerifier`.
- **Hành vi thay đổi (fail-closed):** mọi call-site `createConnectorServer` không có verifier và không opt-in sẽ **throw lúc construction**. Trong repo đã rà toàn bộ call-site active: các harness trần đã opt-in (mục 2), các call-site khác đều đã có verifier (`plat-mig-03`, `p8-01`, `p4-08`, `connector-usage`, `multi-container-e2e`, `connector-client/real-service`, `worker-sdk/worker-service-auth`, `orchestrator/connector-revision`, `black-box-durable`).
- `createConnectorComposition` override giờ kế thừa `config.serviceIdentityVerifier`; consumer chỉ truyền verifier ở config cũng enforce.
- Note docs: `docs/08-connector-api.md` đã cập nhật. `docs/19`, `docs/28`, `docs/35` **chưa sync** — đề xuất docs lane sync theo receipt độc lập (đúng quy trình evidence), không tự sửa trong packet này.

## 6. Không chạy / giới hạn

- Không chạy test cần DB/Redis/S3/Vault/live: `black-box-durable.test.ts`, `durable-integration.test.ts`, `tests/integration/*` (p8-01, p4-08, connector-usage, sec-int-01), `businesses/document-core/tests/multi-container-e2e.integration.test.ts`, `packages/connector-client/tests/real-service.test.ts` (gated `CONNECTOR_INTEGRATION`), browser/e2e. Các file này đã được cập nhật flag hoặc đã có verifier nhưng **chưa thực thi** trong packet này — cần Tester/live window nếu muốn bằng chứng đầy đủ.
- `migration-candidates/orchestrator/**` là bản snapshot, **giữ nguyên**, không thuộc active tree.
- Worktree đang bẩn do nhiều lane chạy song song; `services/connector/src/entrypoint.ts`, `invoke.ts`, `ledger.ts`, `types.ts` đã dirty **trước** packet này và tôi không sửa.
- Không commit, không tick (đúng yêu cầu).

## 7. Files & SHA256 (working tree lúc kết thúc packet)

| File | SHA256 |
|---|---|
| `services/connector/src/http/server.ts` | `586F84DB111A43D020168EE0781B86133E44DA60C92E7EAECCDD3D71FA35F97D` |
| `services/connector/src/composition.ts` | `DCFECA8E7B282CC516A48ACE33CCD10F927FBBD5167B116E6B6BA4FB26899C15` |
| `services/connector/src/identity.ts` | `3EAAF6CF9B54BAED743BFF87CBD16E86CD825A492AC380CBEF5CFBDB02899429` |
| `services/connector/tests/cr06-05-identity-enforcement.test.ts` | `9053E20619CD0CEAAE6282F4D19CE9B43CEC769B378F96C7014B493D59E47FE4` |
| `docs/08-connector-api.md` | `7A729F8C1B224DAE128EAA55C84FC934E3C19BFCFC126F42A99DAAD9566F0C09` |

Hai file `composition.ts`/`identity.ts` và test file mới đã được chuẩn hóa line-ending về CRLF theo worktree convention (`core.autocrlf=true`); diff vẫn chỉ là các dòng thay đổi dự kiến (`git diff --numstat`: server +57/-3, composition +6/-0, identity +14/-0, docs +47/-3, mỗi harness +1).

Danh sách harness đã opt-in (`allowUnauthenticatedTestTraffic: true`, mỗi file +1 dòng): `services/connector/tests/composition.test.ts`, `runtime-foundations.test.ts` (+2), `retry-signal-passthrough.test.ts`, `reliability-security.test.ts`, `r1-d-lifecycle-offline.test.ts`, `r1-d-03-mock-provider-reconciliation.functional.test.ts`, `provider-rejection-diagnostics.test.ts`, `security-lifecycle.test.ts`, và `tests/integration/sec-int-01-credential-lifecycle.integration.test.ts`.

## 8. Đề xuất cho coordinator

1. **Codex Tester độc lập** verify CR06-05 trên đúng hash/working tree này (focused #1 + full offline #2; có thể lặp mutation M1/M2 nếu muốn).
2. **Claude Code review** theo gate hiện hành trước khi đóng acceptance; parent row giữ `[~]`, không tick.
3. Nếu muốn siết carve-out (phương án “fail-closed mọi path” không ngoại lệ): chuyển allowlist harness sang verifier thật — danh sách nằm ở mục 2; coordinator quyết định trước khi live connector evidence được dùng.
4. Docs lane sync `docs/19/28/35` sau khi có receipt độc lập (không dùng receipt này thay verdict).
