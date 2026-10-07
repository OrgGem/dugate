# Data ownership và state machines

Đây là đặc tả logic chuẩn. SQL hiện đã có cho minimal Orchestrator runtime và Connector durable stores, được kiểm chứng bởi `orchestrator/services/orchestrator/tests/runtime.test.ts` và các opt-in Connector durable suites; artifact/object-storage, fan-out/HITL và lifecycle đầy đủ vẫn chưa được materialize. UUID cho entity, UTC RFC3339 cho timestamp, integer cho token/bytes, decimal hoặc integer micro-USD cho tiền; không dùng floating point tích lũy billing.

## Platform schema — Orchestrator owner

| Entity | Fields chính | Constraints/index quan trọng |
|---|---|---|
| Tenant | id, name, state | Một default tenant v1 |
| ApiKey | id, tenantId, profileId, hash, prefix, status | Hash unique; không lưu raw key |
| BusinessVersion | businessId, version, contractVersion, manifest, digest, status, queue | Unique business+version; manifest immutable |
| WorkerInstance | identity, businessId/version, lastHeartbeat, capacity, imageDigest | Health không thay trạng thái registration |
| ProfileRevision | profileId, revision, tenantId, actionBindings, limits | Immutable revision; current pointer CAS |
| Operation | id, tenantId, profileRevision, business/version/action, state, stateVersion, rootTaskId, deadlineAt | Index tenant+createdAt, state+updatedAt |
| SubmissionKey | tenantId, apiKeyId, routeAction, key, requestHash, operationId, expiresAt | Unique scope+key; khác hash trả 409 |
| ExecutionSnapshot | operationId, schemaDigest, resolvedInputRef, parameter/prompt/binding revisions | Không chứa provider credentials |
| Task | id, operationId, parentId, taskKey, kind, payloadRef, state, attempt, leaseEpoch, leaseExpiresAt | Unique operation+taskKey; index dueAt/state |
| TaskDependency | parentId, childId, joinPolicy | Unique pair; same operation/business/version |
| StepCheckpoint | taskId, stepKey, generation, inputHash, outputRef, sessionRef, status | Unique task+stepKey+generation; immutable success |
| HumanWait | operationId, taskId, waitId, inputSchema, schemaDigest, status, responseRef | Unique waitId; one accepted response |
| Artifact | id, tenantId, operationId?, storageKey, mime, size, sha256, state, expiresAt | Scoped ownership; active references prevent GC |
| Outbox | id, aggregateId, type, payloadRef, dueAt, claimUntil, dispatchedAt | Index pending+dueAt; deterministic dispatch ID |
| UsageProjection | eventId, invocationId, operationId, units, cost, currency | eventId unique; corrections append-only |
| WebhookDelivery | deliveryId, operationId, terminalRevision, attempts, nextAt, status | Unique operation+terminalRevision+destination |
| AuditLog | actor, action, subject, before/after metadata, traceId | Redacted immutable audit |

Worker chỉ truy cập runtime API; dữ liệu checkpoint generic nằm ở platform. Business có thể thêm DB riêng trong tương lai khi cần domain records, không được ghi bảng platform.

## Connector schema — Connector owner

ConnectorRevision(connectorId, tenantId, revision, accountId, adapter, config, credentialRef, credentialSource, state); SecretVersion(id, encryptedValue, rotatedAt, revokedAt); Invocation(invocationId, tenantId, operationId, taskId, inputHash, bindingRevision, state, providerRequestId, resultRef, lease, usage); UsageOutbox(eventId, invocationId, payload, deliveredAt).

Connector revision primary key is `(connector_id, tenant_id, revision)`. Vault revisions store tenant and account binding independently from `credential_source`; source account and exact canonical path must match the row's tenant, connector, and account. The source version is pinned on the immutable revision. Pre-binding `legacy-db` rows remain explicitly unbound (`tenant_id = ''`, `account_id = NULL`) until their migration task.

Unique invocationId và inputHash collision check. Provider quota counter/lease dùng Redis với atomic operations; durable invocation/usage dùng PostgreSQL. Secret không xuất ra management GET, manifest, queue hoặc logs.

## Operation states

| Từ | Sang | Điều kiện |
|---|---|---|
| ACCEPTED | QUEUED | Dispatch đã được ghi nhận; worker có thể claim trực tiếp nếu dispatch ACK bị mất |
| ACCEPTED / QUEUED | RUNNING | Root/task claim hợp lệ |
| RUNNING | WAITING_CHILDREN | Parent persist dependency và nhường slot |
| RUNNING | WAITING_INPUT | Worker persist human wait schema |
| RUNNING | RETRY_PENDING | Lỗi retryable, còn budget/deadline |
| WAITING_CHILDREN | QUEUED | Join policy satisfied, continuation outbox commit |
| WAITING_INPUT | QUEUED | Resume validate và CAS thành công |
| RETRY_PENDING | QUEUED | Đến dueAt, continuation dispatch |
| Trạng thái chưa terminal | CANCEL_REQUESTED | Client có quyền yêu cầu cancel |
| CANCEL_REQUESTED | CANCELLED | Fenced task claims, xử lý active call best-effort; kết quả muộn không đổi terminal |
| Trạng thái chưa terminal | TIMED_OUT | Operation deadline hết, fence các task |
| RUNNING | SUCCEEDED | Root finalize, output hợp lệ, tất cả prerequisite hoàn tất |
| Trạng thái chưa terminal | FAILED | Lỗi permanent, hết retry hoặc join failure policy |

Terminal = SUCCEEDED, FAILED, CANCELLED, TIMED_OUT. Không resume terminal operation; muốn chạy lại tạo operation mới có `replayOf`. Trong workflow có child chạy, trạng thái operation biểu diễn root coordinator; per-task detail thể hiện nhánh đang chạy.

Task có READY, RUNNING, WAITING_CHILDREN, WAITING_INPUT, RETRY_PENDING, SUCCEEDED, FAILED, CANCELLED. Claim cấp leaseEpoch tăng dần; progress/checkpoint/complete phải mang epoch hiện hành. Stale worker trả 409 LEASE_LOST; không được gọi provider mới sau mất lease.

## Retry owner và checkpoint

- Platform runtime là nguồn chính cho business retry budget, attempt và dueAt. Business SDK report retryable failure; transaction tạo continuation outbox rồi kết thúc queue delivery hiện tại.
- BullMQ retry/stalled recovery chỉ xử lý lỗi vận chuyển/claim/runtime unavailable. Khi delivery lại, runtime quyết định còn task nào hợp lệ. Không nhân retry budget ở HTTP client, queue và workflow.
- `stepKey` ổn định theo business definition + branch/item ID; không dùng vị trí mảng dễ thay đổi hoặc random mỗi retry.
- OutputRef chứa full output, inputHash và session snapshot; preview chỉ phục vụ UI.
- Step result commit trước continuation. Task có thể chạy lại sau crash nhưng completed step chỉ đọc kết quả.
- Ghi state và outbox cùng transaction. CAS `stateVersion`/leaseEpoch để completion và cancel cạnh tranh có thứ tự rõ.

## Invocation states và unknown outcome

NEW → IN_FLIGHT → SUCCEEDED hoặc FAILED; mất khả năng xác định kết quả → UNKNOWN. Retry transport dùng cùng invocationId; một provider retry sau lỗi xác định chưa xử lý có attempt record riêng. Nếu provider hỗ trợ idempotency, adapter dùng cùng khóa; nếu không, UNKNOWN cần reconcile/manual policy trước khi tạo invocation mới có thể phát sinh phí.

Late usage vẫn ghi ledger dù operation đã cancelled; cancellation không có nghĩa provider chưa tính phí. Parent chỉ tổng hợp usage, không ghi debit lần nữa.

## Reconciliation bắt buộc

- Operation/task có outbox chưa dispatch: gửi lại với stable delivery ID.
- Job bị Redis mất nhưng task chưa terminal: `sweepQueueIntegrity` (docs/38) phát hiện orphan từ PG (outbox đã stamp `dispatched_at`, task READY/QUEUED leaseless), xác nhận mất qua BullMQ `getJob`, rồi re-arm CHÍNH hàng outbox gốc bằng CAS một lệnh (`WHERE id AND dispatched_at = <giá trị đã đọc> AND attempts < cap>`) — không bao giờ ghi đè stamp mới, không tạo delivery mới. Lease RUNNING mồ côi vẫn do `sweepExpiredLeases` lo; hai sweep độc lập.
- Task completion đã commit nhưng HTTP response mất: duplicate report trả snapshot hiện tại.
- Invocation success nhưng usage chưa đến platform: Connector replay usage outbox.
- Artifact object chưa finalized: expire staging; không xóa object đang được task/checkpoint giữ.

Retention cụ thể là config được chốt P0. Không xóa idempotency/checkpoint/ledger sớm hơn cửa sổ retry/replay được công bố.

## Artifact encryption at rest (ADR-18 baseline — CHƯA triển khai)

> **Trạng thái:** ADR-18 ghi baseline thiết kế; `ENC-00` vẫn `[~]` (partial). Không có code mã hóa nào tồn tại trong `orchestrator/services/orchestrator/src` hay `orchestrator/packages/contracts/src` tại thời điểm viết dòng này. Mục này đồng bộ tài liệu theo ADR đã duyệt, không mô tả hành vi đang chạy. Gate `G-ENC` mở cho đến khi ENC-01..ENC-09 + ENC-INT-01 triển khai, kiểm thử độc lập và Reviewer phê duyệt.

Mô hình envelope encryption (ADR-18 §Baseline kỹ thuật):

- Mỗi artifact/file dùng một **Data Encryption Key (DEK) 256-bit độc lập**. DEK được wrap/unwrap qua **Vault Transit engine**; không lưu master key hoặc plaintext DEK ở DB/S3/log.
- Payload mã hóa bằng **AES-256-GCM** (authenticated encryption). Cả S3 và PostgreSQL pilot đều dùng chung một định dạng envelope ciphertext thống nhất.
- File lớn (> 5 MB) mã hóa theo **chunk 4 MB** độc lập, kèm manifest chứa chunk hash + monotonic index chống truncate/reorder.
- Metadata DB (`operations.input_ref`, `tasks.payload_ref`, outbox, queue, log) không chứa inline plaintext nội dung tài liệu; chỉ chứa encrypted reference, hash và metadata không nhạy cảm.
- Public upload (single/multipart) phải qua **streaming gateway mã hóa trong app** trước khi ghi S3. Presigned PUT/part trực tiếp với plaintext không đạt yêu cầu.

Cả hai backend (S3 production theo ADR-10, PG pilot ≤ 10 MB) đều nhận ciphertext đã bọc envelope — storage compromise không lộ plaintext.

### ENC-META / ENC-09 — control-plane slots + backfill window (cập nhật 2026-10-05)

Metadata/control-plane encryption giờ có **8 slot** được seal (`METADATA_SLOTS`, `orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts`): `operations.input_ref`, `tasks.payload_ref`, `human_waits.response_ref`, `step_checkpoints.output_ref`, **`step_checkpoints.session_ref`**, `operations.prompt_overrides_ref` (carrier Δ-PC-1) và **`tasks.result_ref` + `operations.result_ref`** (ENCMETA-RESULTREF, Option A — hai slot vì cùng một chuỗi nằm ở HAI row; AAD bind `(tenant, slot, refId)` nên replay chéo row ⇒ `CONTEXT_MISMATCH`).

- **Cột TEXT:** `result_ref` là cột text (0001) — envelope được bọc dạng **JSON text** (cùng convention `input_ref`), không phải object thô; trong backfill window hiện tại, cả 4 call-site của `readStoredText` truyền `allowPlaintext=true`: reader mở được sealed envelope khi có seam phù hợp và đọc legacy plaintext verbatim (best-effort); legacy rows vẫn plaintext-readable. Fail-closed `NOT_SEALED` chỉ có hiệu lực sau window switch (A3/A2), chưa được enforce ở các call-site hiện tại (A8).

**BẢO VỆ KHÔNG ĐƯỢC SUY RA TỪ HÌNH DẠNG (REVIEW-809 / A11 / A17):**

- **Một envelope có hình dạng đúng KHÔNG phải bằng chứng đã được bảo vệ.** Hình dạng chỉ cho biết giá trị *trông* như envelope; nó không mã hóa và không mở được.
- **Hàng có hình dạng nhưng CHƯA được AEAD mở vẫn là hàng đang đọc được ở dạng plaintext.** Nó nằm trong cửa sổ backfill, không phải trong trạng thái đã bảo vệ.
- **Hàng sealed nhưng HỎNG là MẤT DỮ LIỆU cho xử lý** — không phải một khoảng trống trung tính. Phải có cảnh báo rõ ràng, không được im lặng.
- **TUYỆT ĐỐI không dùng `GATE PASSES` của shape counter làm bằng chứng flip.** Shape gate chỉ đọc hình dạng; nó không giải mã. Flip cần cả hai cổng bằng 0 (xem `live-window-runbook-803` §A10/A12).
- **ENC-09 backfill window:** trong cửa sổ migration, reader chạy `allowPlaintext=true` — row legacy plaintext đọc **verbatim, byte-identical**; đóng cửa sổ ⇒ plaintext không còn được nhận (`NOT_SEALED`, không auto-nhận plaintext). Quyết định đóng window thuộc owner migration.
- **Chưa chạy backfill thật:** receipt hiện có là offline (seal 2 slot 10×3 + regression 61; wire-boundary guards 10×3, 0 product diff) — chưa có PG thật/Vault thật; cập nhật mục ENC-09 của docs 28/35 khi window thật bắt đầu. Không gate nào đổi (`G-ENC` vẫn NO-GO theo baseline).

Bằng chứng: [encmeta-resultref-impl](../coordination/reports/encmeta-resultref-impl-2026-10-05.md), [encmeta-schema-impl](../coordination/reports/encmeta-schema-impl-2026-10-05.md).


## Artifact storage + ingestion wire (D-EVID-A29, offline VERIFIED)

> **Trang thai:** ca ba task duoi day da co **independent offline receipt** (Codex Tester Offline cho DATA-01/02) va **full-suite receipt** cho DATA-03. Khong task nao ACCEPTED — khong co live S3/PostgreSQL/Redis/Vault trong bat ky receipt nao.

| Task | Receipt | So lieu offline |
|---|---|---|
| **DATA-01** S3 storage adapter + metadata lifecycle | [T-CODEX-OFFLINE-DATA-01-INDEPENDENT](../coordination/reports/tester.md#L8350) (04:43:23) | 3 suites / **35/35** + tsc 0 — **independent** |
| **DATA-02** public upload lifecycle + submit guard | [T-CODEX-OFFLINE-DATA-02-INDEPENDENT](../coordination/reports/tester.md#L8385) (04:54:34) | 4 suites / **99/99** + tsc 0 — **independent** |
| **DATA-03** URL task chua READY thi khong chay duoc | [Qwen Platform Muc 22](../coordination/reports/qwen-platform.md#L2100) | document-core full **46 suites / 542 tests** + tsc 0; targeted 5/5 x3; worker-sdk regression 84/84 |

**DATA-01 + DATA-02 — hai muc van la storage/upload wire, khong phai evidence lifecycle that.** DATA-01 receipt tu ghi “No live S3-compatible service or PostgreSQL database was used”; DATA-02 ghi “No live PostgreSQL, S3, Redis, or Vault infrastructure was exercised”.

> **CẢNH BÁO SEED B (REVIEW-809):** trong `ingress-bounded.test.ts:244-261`, case oversize **không** chứng minh được blob auth như tài liệu cũ mô tả — nó fail vì **test-order contamination** (`before.rowCount = 0` do 2 PUT trước đã bị chặn, body-limit path chạy trước blob auth). Case đó **cần một seed blob ĐỘC LẬP** (Seed B) thì kết quả mới có nghĩa. Chi tiết: `docs/36-evidence-table-reconciliation.md:109`. Không đọc con số "3 blob PUT tests receive 403" như bằng chứng độc lập cho tới khi Seed B tồn tại.

**DATA-03 — lo hong thật da tim va sua (Muc 22).** `IngestAction.prepareSources` chi kiem pin khi `artifactInputs.length > 0`, nen task URL chua materialize co 0 artifact thi pin khong duoc kiem; neu con mang `input.text` thi parse nhanh text do va bao thanh cong du chua tai byte nao. Da viet test truoc, chay, va no **DO tren code cu**. Sua 1 file: kiem pin khi pin co, phan biet `SOURCE_PIN_MISMATCH` (co artifact sai) va `INGESTION_SOURCE_UNRESOLVED` (chua READY), va `inlineText: pin ? undefined : input.text` de task co pin khong duoc thoa bang text noi tuyen. 5 test moi trong `tests/data-03-url-acq.test.ts`.

**2 mutation probe DATA-03 — la probe DO, khong phai test xanh:** M1 dua gate ve dang cu (pin && artifactInputs.length > 0) — **2 test do** (case 1 + case 5); M2 bo `inlineText: pin ? undefined`— **dung 1 test do** (case 3). Restore byte-exact `ingest/index.ts` sha `f05634ea`, 13203 B.

**Ranh gioi chua phat sinh (Muc 22 tu ghi):** **D52** — sua la TIGHTENING, co the lam mot so task URL cang chay duoc bang inline text bat dau fail voi `INGESTION_SOURCE_UNRESOLVED`; dung spec nhung la **breaking change** cho edge case do, coordinator nen biet truoc production. **D53** — chua co live multi-container evidence (fetch that qua egress that, S3 that, READY gate that); live thuoc DATA-INT-01. **Nua orchestrator** (202 URL submission, READY gate, no-READY-on-failure o storage) co san tu Mục 9 nhung **khong verify lai** trong cycle nay vi ngoai scope.


## DATA lifecycle: public upload, worker streaming, storage migration (D-EVID-A30, offline VERIFIED)

> **Trang thai:** DATA-02 co **hai** receipt (implementation + **independent**), DATA-04 co **mot** receipt verify (khong co independent), DATA-05 co **hai** receipt (implementation + **independent**). Khong task nao ACCEPTED — khong co live PostgreSQL/S3/Redis/Vault trong bat ky receipt nao.

| Task | Receipt | So lieu offline | Loai |
|---|---|---|---|
| **DATA-02** public upload lifecycle + submit guard | [T-CODEX-OFFLINE-DATA-02-INDEPENDENT](../coordination/reports/tester.md#L8385) (04:54:34) | 4 suites / **99/99** + tsc 0 | **independent** |
| **DATA-04** worker artifact streaming + output/checkpoint | [T-CODEX-OFFLINE-DATA-04-INDEPENDENT](../coordination/reports/tester.md#L8438) (05:09:55) | worker-sdk **18 suites / 311 tests**; document-core **46 suites / 542 tests**; 3 lenh lint/typecheck 0 | **independent** (nang cap tu implementation-only) |
| **DATA-05** PostgreSQL blob migration + rollback window | [T-CODEX-OFFLINE-DATA-05-INDEPENDENT](../coordination/reports/tester.md#L8461) (05:04:12) | 2 suites / **20/20** (7 storage-migration + 13 artifact-storage) + tsc 0 | **independent** |

**DATA-04 — doi chieu bang chuoi ca hai package, va mot lenh co chu doi thuoc ve offline.** `REDIS_SMOKE='0'` giu run document-core offline; receipt ghi ro **khong** co live BullMQ/Redis nao duoc verify. No cung ghi: worker-sdk artifact transfer dung **bounded stream** + validate size/SHA-256 + timeout/abort toan request + finalize gan task/lease-epoch; document-core business facade chuyen read/write/checkpoint qua duong SDK; **checkpoint artifact van “intermediate” va khong duoc loi ra lam public result**; completion chi nhan output ref da commit, **tu choi** reference thieu / STAGING / foreign / intermediate.

**DATA-05 — fail-closed tai ca migration completion va fallback.** Migration chi hoan tat khi **khong con** reference PostgreSQL chua resolve, orphan row, S3 READY row chua pin, hay bat ky integrity check nao fail. Backfill verify size/SHA-256 nguon, truyen artifact/tenant/reference sang S3 import, verify S3 size/SHA-256/version **tra ve**, **chi pin sau khi validate**, giu backup bytea trong PostgreSQL, va **idempotent khi retry**. PostgreSQL fallback bay gio **bat buoc** co `migrationWindow: true`; window chua mo hoac da dong — doc chi S3, nhung artifact grant moi van S3-backed. Co regression cho tenant mismatch, remote size/hash drift, inventory reconciliation, retry va fail-closed fallback.

**Khong cong so:** 99 (4 suite orchestrator) + 311 (18 suite worker-sdk) + 542 (46 suite document-core) + 20 (2 suite orchestrator) — **hai package, bon tap suite**; cong vao nhau ra so vo nghia. 20 = 7 + 13 cua DATA-05, khong cong them vao 99.


## DATA-04 independent + ENC-08 CSRF renderer (D-EVID-A31, 2026-09-28)

> **Muc nay nang cap DATA-04 tu implementation-only len INDEPENDENT** va them receipt CSRF renderer cua ENC-08. Khong task nao ACCEPTED.

| Muc | Receipt | So lieu offline | Loai |
|---|---|---|---|
| **DATA-04** worker artifact streaming + output/checkpoint | [T-CODEX-OFFLINE-DATA-04-INDEPENDENT](../coordination/reports/tester.md#L8438) (05:09:55) | worker-sdk **18 suites / 311 tests**; document-core **46 suites / 542 tests**; 3 lenh lint/typecheck 0 | **independent** |
| **ENC-08** CSRF renderer trong crypto-config pane | [Qwen Admin Muc 27](../coordination/reports/qwen-admin.md#L3280) (task_1be90638634c) | `admin-crypto-config-shell` + `admin-crypto-config` = **47/47**; 4 suite ENC **79/79 x3**; tsc 0 | verify receipt |

**DATA-04 — receipt independent co cung so voi receipt implementation, va day la chay lai doc lap chu khong phai them test.** 311/542 o ca hai lan; **khong bao gio cong chung** vao mot aggregate. Live object storage, Redis va distributed finalize race van khong duoc exercise.

**Mot deviation nho can ghi o receipt nay — receipt independent khong co dong HEAD** (khac moi receipt independent khac trong cung file deu co). No van tu khai “Independent read-only verification; changed no source or test file”, nen muc do doc lap duoc chap nhan, nhung quy tac cua chinh lane (chi gan independent khi receipt **tu noi** minh la independent **va** co HEAD) **chi dat mot phan** — ghi ro de khong co ai dua lam chuan tuy yet. D-A38-2.

**ENC-08 CSRF — token la binding, khong phai credential.** `deriveCsrfToken(cookieSecret, sessionCookie)` = HMAC cua secret voi cookie: no la **mot phan** cua secret, cross-site page khong doc duoc (SameSite=Strict) va khong tu tinh duoc (khong co secret), nen render vao DOM la chuan CSRF hop le. Token gan voi **chinh session cookie do**; test chung minh token cua session A khong xuat hien khi render cho session B.

**Gate POST la rao duy nhat truoc khi ghi:** form gui `csrf`; handler verify lai bang **constant-time compare**; sai hoac thieu — **403** va applier **khong bao gio chay** (test assert store + audit rong). Save dung **POST-redirect-GET** (302 + `Location`) nen reload khong re-submit. Test goc nhat la **end-to-end**: lay token RA khoi HTML da render, POST lai dung nhu trinh duyet, store cap nhat + 302 — chung minh token trong DOM **la** token ma POST gate chap nhan.

**Phan CSRF — khong chung minh (Muc 27.7):** D112 **DONG o muc code + offline**; khong co HTTP qua socket that, khong browser, khong cookie do trinh duyet mint (test dung cookie ky that qua `signCookie` + derive that nen duong kiem la duong that, nhung chua di qua listener). **D110** van mo (webhook dispatcher chua theo policy). **D113** van mo (cong CSRF hien kiem session cookie + secret; voi OIDC session store phai noi `verifySessionCsrf`).


## Portal execution timing

Execution timestamps are lifecycle facts independent of artifact/cache maintenance. Retry creates a linked new operation instead of reopening a terminal one. See [Portal request management](portal-request-management.md).
