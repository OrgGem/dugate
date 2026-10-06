# CB-02 — Webhook result delivery logic & snapshot (PROFILE-CALLBACK-20261006)

- Task: `CB-02` (`tasks/PROFILE-CALLBACK-2026-10-06.md`), parent PROFILE-CALLBACK-20261006
- Owner: OpenCode 3 (`oc_3` / `term_8a432ae3-63b7-41fd-929e-0797860c7426`), Webhook & Result Delivery Developer
- HEAD tham chiếu: `b088eec` (worktree dirty, nhiều lane mở)
- Constraints honored: **không commit, không push, không cutover**; offline only (NO PostgreSQL/Redis/S3/Vault/real receiver)
- Status: **IMPLEMENTED + offline-verified**; **independent VFY-CB-01 (real PG + HTTPS receiver/token) + Claude review còn thiếu. Không claim ACCEPTED, không tick.**

## 0. TL;DR

- Hai mode delivery hoạt động theo pin CB-01: `notification_only` giữ nguyên envelope P2-08 byte-for-byte; `notification_with_result` snapshot `CallbackResultEnvelope` (result projection + artifact descriptors + usage) **một lần duy nhất tại terminal transition**, trong cùng transaction với state change.
- Bao phủ `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`; failure/cancel/timeout → `result=null` + lý do `UNAVAILABLE` tường minh; sealed result_ref → `ENCRYPTED_ONLY`; quá hạn inline → `OVERSIZED` (không bao giờ truncate).
- Giới hạn: inline result ≤ 256 KiB (CB-01), body ≤ 512 KiB, ≤ 32 descriptors; artifact lớn chỉ trả **relative authenticated reference** `/api/v1/artifacts/{id}/download` + `expiresAt` (không bytes, không storage URL).
- `deliveryId` ổn định (row + header `x-du-delivery-id`); retry at-least-once replay payload y nguyên → `occurredAt` (= `completed_at` từ 0034, bất biến) không đổi.
- CB-03 auth integration: `configured_headers`/OAuth2 gắn header qua session CB-03; destination authorization chạy trước; policy lỗi/thiếu resolver → **fail closed**, không bao giờ gửi unauthenticated; `redirect:'error'`.
- Offline evidence: CB-02 suite **23/23 ×3**, cụm webhook liên quan **80/80**, orchestrator `tsc` exit 0, `git diff --check` exit 0; full unit: 4881 passed, 8 suite đỏ **còn lại của lane khác** (không có suite webhook nào đỏ).

## 1. Requirement → implementation map

| Yêu cầu (dispatch + task CB-02) | Thực hiện |
|---|---|
| 2 mode: `notification_only` (envelope cũ) + `notification_with_result` (result + artifact descriptors) | `maybeScheduleWebhook` đọc pin `operations.callback_policy`; mode `notification_only` giữ `WebhookPayload` cũ + stamping `deliveryId`; mode result dựng `CallbackResultEnvelope` CB-01 |
| Bao phủ SUCCEEDED/FAILED/CANCELLED/TIMED_OUT | `eventTypeFor` giữ nguyên; result mode: chỉ SUCCEEDED có inline result, còn lại `result=null` + `UNAVAILABLE` |
| Immutable snapshot khi terminal | Payload dựng trong cùng transaction với terminal UPDATE; `ON CONFLICT (operation_id,state_version,destination_url) DO NOTHING`; retry chỉ đọc lại payload, không bao giờ ghi đè |
| Body size limit | Inline ≤ `CALLBACK_MAX_INLINE_RESULT_BYTES` (256 KiB) → `OVERSIZED`; envelope ≤ `CALLBACK_MAX_DELIVERY_BODY_BYTES` (512 KiB); ≤ 32 descriptors |
| File/artifact lớn chỉ trả reference URL có hạn, không bytes | Descriptor `download.path` relative + `expiresAt`; không có `contentBase64`/storage URL |
| `deliveryId` ổn định | Legacy: stamp vào payload + header; result mode: header `x-du-delivery-id` (schema CB-01 strict không có field này) |
| Retry at-least-once không đổi terminal times | `occurredAt = completed_at` (trigger 0034 bất biến); test chứng minh 2 lần gửi body byte-identical, payload DB không đổi |
| Timeout/failure đúng | Transport timeout → `WEBHOOK_TRANSPORT_FAILED (TimeoutError)`, attempts+1, PENDING; failure 5xx retry backoff; hết budget → FAILED; operation outcome không đổi |

## 2. Thay đổi và hash

| File | SHA-256 |
|---|---|
| `services/orchestrator/migrations/0035_webhook_result_delivery.sql` (new) | `AC769D1B51130E51582466A7C96025AC5C2771032182184F61F0CE413CA8BD61` |
| `services/orchestrator/src/modules/webhooks/webhooks.ts` | `19226078D1FE1BD4A9210ED1655F6415338CC6E5F236504FE57F2C0B573D361C` |
| `services/orchestrator/src/modules/webhooks/result-projection.ts` (new) | `4AB9C3F1480DE99428F15C040F2AE2EDE997917F2B3476C6831327DC4FAAE517` |
| `services/orchestrator/tests/cb-02-webhook-result-delivery.test.ts` (new) | `0614CD35BC4667634CA805EA9C5E45808AFE5B3C591542F3718E59AB6E90344D` |
| `services/orchestrator/tests/br08-cancel-resume-race-offline.test.ts` | `54D0698037707D6C5136246B4BE439BE3EE7D53623AABD3BEE11FD4D131840F9` |
| `services/orchestrator/tests/p730-acquire-consumer-auth.test.ts` | `77F63DC7595B4BA80587D28F60666F2C03626E4FB34249775A60ABE226D4162E` |
| `services/orchestrator/tests/runtime-lease-fencing-offline.test.ts` | `8857CB43B2D1518DCAC8FBF80539E164DF3E25C3A4E6DA1671314E91389FC5F0` |
| `services/orchestrator/tests/url-ingestion-consumer-offline.functional.test.ts` | `57075F2A16BB864B9F853F411BC941BEBD6DEB08EFD630065D6181FE744598D2` |
| `services/orchestrator/tests/v1-boot-typed-denial.test.ts` | `9428006704AE2DA2F55D978844CB4D25C40194B7A542D15343DDA94DDCF6AC54` |

5 file test cuối là **scripted SQL fakes** pin chính xác chuỗi SELECT cũ của `maybeScheduleWebhook` (`... callback_url, updated_at FROM operations ...`). SELECT mới thêm `completed_at, callback_policy`; tôi đổi match sang prefix `SELECT id, tenant_id, state, state_version, callback_url,` (row cũ vẫn hợp lệ: `completed_at`/`callback_policy` undefined = legacy). **5 suite này đang đỏ vì chính thay đổi của packet; sau sửa đã xanh trở lại** (xem §5).

Không sửa: `outbound-auth.ts`/`oauth2-client.ts` (lease CB-03), `create-app.ts`/`runtime.ts`/`submission.ts` (integrator), `packages/contracts` (CB-01).

## 3. Storage & scheduling decision

Migration `0035`:
- `operations.callback_policy jsonb` — pin tại admission (CB-01 `ProfileCallbackPolicySnapshot` hoặc bare `ProfileCallbackPolicy`). **Ai ghi**: submission/profile admission thuộc integrator (ngoài lease); absent = legacy notification-only, không thay đổi hành vi hiện tại.
- `webhook_deliveries.mode text NOT NULL DEFAULT 'notification_only'` — phân biệt envelope đã đóng băng.
- `webhook_deliveries.callback_policy jsonb` — bản sao pin tại terminal (chỉ secret REFERENCES + destination authorization; không value, không raw storage URL) để dispatcher không bao giờ đọc lại profile revision sống.

Policy parse là **tri-state**: absent → legacy; valid → mode/auth/destination; **invalid → fail closed ở dispatcher** (`WEBHOOK_POLICY_INVALID`, không gửi unauthenticated). Scheduling với pin invalid vẫn tạo row (mode `notification_only`, raw pin giữ nguyên) để operator thấy và sửa, không mất event.

Result projection (`result-projection.ts`) mirror `GET /api/v1/operations/:id/result`: `data.resultRef` (chỉ plaintext; sealed → `ENCRYPTED_ONLY`), artifacts từ READY rows + role `submit_artifacts`, usage aggregate như `usage.project` (không đọc được → omit, không bịa). `expiresAt` = **min(artifact.expires_at nếu có, terminal + `DEFAULT_CALLBACK_REFERENCE_TTL_MS` 24h)** — 24h khớp horizon cleanup operation-file hiện có; là **reference-validity bound đóng băng lúc terminal**, không phải thay đổi retention (SD-05/06 vẫn mở). Manual resend replay snapshot nên không thể gia hạn.

## 4. CB-03 auth integration (dispatcher)

- Pin hợp lệ có auth credential → `authorizeCallbackDestination(destination_url, auth, destination)` trước; deny → `DESTINATION_DENIED`, **fetch không được gọi**.
- Thiếu `resolveCallbackSecret` (production wiring thuộc integrator) → `WEBHOOK_AUTH_UNAVAILABLE`, fail closed, không fallback `none`.
- `createOutboundAuthSession` + `dispatchWithAuth`: 401 OAuth2 → invalidate + reacquire 1 lần, **cùng body/signature/deliveryId**; 403 không retry; mọi lỗi auth ghi code cố định `WEBHOOK_AUTH_UNAVAILABLE (<code>)`.
- `redirect:'error'` trên mọi callback request; HMAC headers giữ nguyên, auth chỉ thêm header của nó.
- Production `create-app.ts` **chưa** truyền resolver (ngoài lease) — handoff §8.

## 5. Evidence (offline; literal)

| Command (cwd `services/orchestrator`) | Kết quả |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit **0** |
| `npx jest tests/cb-02-webhook-result-delivery.test.ts --runInBand` ×3 | mỗi lần **1 suite / 23 tests passed**, exit **0** |
| `npx jest tests/cb-02-... tests/cb-03-outbound-auth tests/webhook-error-boundaries.boundary tests/webhook-delivery-encryption --runInBand --forceExit` | **4 suites / 80 tests passed**, exit **0** |
| `npx jest tests/br08-... tests/p730-... tests/runtime-lease-fencing-... tests/url-ingestion-... tests/v1-boot-typed-denial --runInBand` | **5 suites / 86 tests passed**, exit **0** (5 suite đỏ do SELECT cũ đã hết) |
| `npx jest --config jest.unit.config.cjs --runInBand --forceExit` | **196 passed suites / 4881 passed, 62 failed, 105 skipped**; 8 suite đỏ **không có webhook/CB-02** |
| `git diff --check -- services/orchestrator/...` | exit **0** |

Raw logs: `coordination/reports/raw/cb-02/orchestrator-unit-full-final.log` (final full run), `other-lane-reds.log` (chẩn đoán 8 suite ngoài lane).

8 suite đỏ còn lại (other-lane, không liên quan webhook): `admin-operations-sort`, `admin-operations-sort-http-offline`, `admin-operations-sql`, `admin-shell-session-lifecycle`, `artifact-read-authorization` (SEC-ENC-04), `migration-0032-rollback` + `migration-verify-trap-fix` (đã đỏ sẵn do 0033/0034 — đã kiểm chứng bằng cách tạm rút 0035: vẫn `35 rows vs 33 expected`), `rv01-loopback-http-offline`. Không suite nào chứa `FAIL.*webhook`/`FAIL.*cb-02`.

## 6. Acceptance mapping (CB-02 row §31)

| Acceptance | Trạng thái |
|---|---|
| Both modes across success/failure/cancel/timeout | **PASS** offline (schedule + dispatch tests) |
| Immutable encrypted snapshots | **PASS (immutability + wire encryption)**: payload đóng băng, retry byte-identical; tenant delivery encryption W-ENC-08 áp dụng nguyên cho envelope result. At-rest sealing `webhook_deliveries.payload` là **SEC-ENC PLANNED purpose `webhook.delivery.payload`** (docs/41 row 11) — không claim trong packet này |
| Result/expiry bounds | **PASS**: 256 KiB inline / 512 KiB body / 32 descriptors; expiry đóng băng, không truncation |
| Same-transaction scheduling | **PASS**: vẫn gọi trong tx terminal; thêm query projection trong cùng client |
| Stable deliveryId | **PASS**: row + header; legacy stamping giữ nguyên |
| At-least-once retry | **PASS**: retry PENDING/backoff/FAILED không đổi payload |
| Terminal times unchanged | **PASS**: `occurredAt = completed_at`; test replay 2 lần body bằng nhau |

## 7. Honest limits / open items

- **Live VFY-CB-01**: real PG + HTTPS receiver/token server, Portal review; chưa chạy (offline packet).
- **Production auth resolver**: `create-app.ts` chưa truyền `resolveCallbackSecret` → mọi policy credential-bearing hiện fail closed `WEBHOOK_AUTH_UNAVAILABLE` cho tới khi integrator nối Vault resolver (CB-03/CB-04/integrator).
- **Admission writer**: `operations.callback_policy` chưa được submission ghi (integrator/CB-04); absent = legacy nên không hồi quy.
- **At-rest encryption** của payload: thuộc SEC-ENC-04/ENC-META follow-up (docs/41), không tự thêm format crypto ngoài canonical freeze.
- **Artifact `expires_at`**: platform chưa set (SD-06 mở) → descriptor dùng TTL tham chiếu 24h; khi SD-06 có retention thật, `expires_at` sẽ thắng (đã test).
- **CB-05**: docs/OpenAPI (receiver schema, dedup, auth), docs/19/28/35 sync — chưa làm (ngoài lease).
- **Worktree khác lane đỏ**: 8 suite liệt kê §5 vẫn đỏ; không thuộc packet này.

## 8. Handoff

- **Integrator**: (1) submission ghi pin `ProfileCallbackPolicySnapshot` vào `operations.callback_policy`; (2) `create-app.ts` truyền `resolveCallbackSecret` (Vault) + `oauth2Options` cho `deliverWebhooks`.
- **CB-04**: delivery view đọc `mode`, `callback_policy`, `payload` (result envelope), `attempts/last_error/next_at`; manual resend replay snapshot (không gia hạn expiry).
- **CB-05**: tài liệu 2 receiver schema + HMAC + auth + dedup; regenerate OpenAPI.
- **VFY-CB-01**: chạy trên candidate thật; digest theo §2; không tick parent.
- Không commit/push; không tick.
