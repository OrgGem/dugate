# Connector capability / task-name enforcement — options memo (READ-ONLY)

- **Receipt**: `codex-connector-enforcement-options-2026-10-02.md`
- **Dispatch**: 2026-10-02T11:12:23+07:00, coordinator `command-code`
- **Input**: `qwen-connector-bindings-inventory-2026-10-02.md` (cùng lane) — F1, F2, F5
- **Phạm vi**: memo lựa chọn. **Không implement, không sửa code/config, không tick gate, không commit, không in giá trị secret nào.**
- **Quy ước effort**: S / M / L = số bề mặt file phải chạm (S ≤ 3 file, M 4–8, L > 8 hoặc đổi schema/migration). Không ước lượng thời gian.

## §0 TL;DR — khuyến nghị

| Gap | Khuyến nghị | Effort | Vì sao |
|---|---|---|---|
| 1. `acceptedCapabilities` | **1b-nhẹ rồi 1a sau** — bỏ ràng buộc bắt buộc, ghi advisory; đổi `AdapterConfig.capability` thành mảng và enforce ở `grants.ts` | S rồi M | Hook đã có sẵn và đang im lặng; 4 mặt khai báo capability đang treo |
| 2. Task name | **2c ngay, 2a chỉ khi có bằng chứng** — giữ passthrough, tách 4xx khỏi `INVALID_PROVIDER_RESPONSE` | **S** | Rẻ, tự đóng, cải thiện chẩn đoán mà không đụng provider |
| 3. Seed 9 slot P9 | **Không phải code** — checklist nhập liệu; gate fail-closed đã có sẵn ở `grants.ts:200-202` | S | Thiếu seed sẽ tự lộ ra lần chạy đầu, không tạo hành vi sai âm thầm |

Điểm chung: **cả 3 gap đều không cần chạm provider.**

## §1 Bằng chứng mới — có **4** hook capability đang treo, không phải 1

Receipt inventory chỉ nói `acceptedCapabilities` không được enforce. Khi soi sâu để viết memo này, tôi thấy **ba hook nữa cùng bệnh**: đã khai báo trong type/schema nhưng không có nơi nào đọc hoặc sinh dữ liệu.

| # | Hook | Khai báo | Đọc/sinh ở đâu | Tình trạng |
|---|---|---|---|---|
| H1 | `ConnectorSlotManifest.acceptedCapabilities` | `packages/contracts/src/manifest.ts:17` | Không nơi nào trong production | Chỉ validate shape |
| H2 | `AdapterConfig.capability?: string` | `services/connector/src/types.ts:126` | **Không nơi nào** | Cờ treo, kiểu **số ít** |
| H3 | `ConnectorRevisionRow.capabilities: string[]` | `services/orchestrator/src/app/admin/types.ts:315` | Sinh từ `server.ts:2588` | Có type + có UI đọc, **producer trả `[]`** |
| H4 | `ConnectorCapabilityOption` | `services/orchestrator/src/app/admin/types.ts:139-143` | `profile-view-models.ts:173,310` | Hợp lệ, luôn rỗng |

Điểm đáng chú ý nhất là **H3: UI đã sẵn sàng nhận dữ liệu mà không có dữ liệu**:

- `connector-view-models.ts:241` copy `input.revision.capabilities` vào view model.
- `connector-section-renderer.ts:277` render `<dt>Capabilities</dt>` liệt kê các tag.
- Nhưng producer duy nhất là `server.ts:2588` — literal `capabilities: []`, trong envelope mà comment ngay trên (`:2583-2586`) tự gọi là honest envelope: adapter `unknown`, empty capabilities.
- Cùng kiểu, `server.ts:2547` trả `capabilities: []` cho profile form; `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:19` (mục `ACUI-M02`) đã ghi nhận đúng hiện tượng này.

Nghĩa là nếu H2 được nối vào, **UI không cần sửa gì** để hiện được capability. Đây là lý do tôi không đề xuất phương án build UI mới.

### 1.1 Bốn từ vựng capability đang tồn tại song song

| Từ vựng | Giá trị | Nguồn | Ngữ nghĩa |
|---|---|---|---|
| Manifest slot | `chat-completion`, `structured-output`, `ocr`, `pdf-text`, `vision`, `handwriting`, `document-layout` | `document-core.manifest.ts:150-419`, `lc-checker/manifest.ts:176-195` | Năng lực nghiệp vụ |
| Adapter mode | `json`, `multipart` | `adapters/registry.ts:20-27` từ `http.ts:29,88` | Kiểu transport |
| Vault policy | `read`, `write`, `metadata-read` | `packages/contracts/src/vault-policies.ts:122,129,136` | Quyền trên path Vault |
| (trống) Admin catalog | rỗng | `server.ts:2547,2588` | Dự kiến là năng lực connector |

**Không từ vựng nào giao với từ vựng nào.** Đây là lý do F1 trong receipt inventory không phải một dòng code: phải chọn một từ vựng chuẩn trước, rồi mới enforce được.

### 1.2 Mẫu có thể tái dùng cho enforcement

`evaluateVaultAccess` (`packages/contracts/src/vault-policies.ts:90-104`) là mẫu gần như tạm ý cho phần enforce: hàm thuần, thứ tự kiểm là hợp đồng, trả `code` cụ thể chứ không phải boolean, và có 62 test offline khóa hành vi (`packages/contracts/tests/vault-policies.test.ts`, số liệu theo `docs/28-test-inventory.md:645`).

Thứ tự trong hàm: kiểm identity → hết hạn → **capability** (`:98-100`, trả `CAPABILITY_DENIED`) → prefix. Đây là cách làm capability check mà không cần DB và không cần provider.

Không tái dụng được **từ vựng** của Vault cho connector slot — nghĩa là chỉ mượn **khuôn**, không mượn **từ điển**.

## §2 Gap 1 — `acceptedCapabilities`

### Phương án 1a — Enforce tại `grants.ts` khi resolve slot

**Cách làm hợp lý, theo thứ tự bắt buộc:**

1. **Chốt từ vựng manifest là chuẩn** (`chat-completion`, `structured-output`, `ocr`, `vision`, …). Không dùng `adapter.mode` — nó là transport, không phải năng lực nghiệp vụ; dùng nó sẽ biến mọi check thành tautology vì cả hai adapter đều không thuộc tập manifest.
2. **Đổi `AdapterConfig.capability?: string` (`types.ts:126`) thành `capabilities?: string[]`.** Phần này gần như miễn phí: field đã tồn tại, đã nằm trong `revision.config` JSONB, đã đi qua `applyCredentialSlot` (`services.ts:134`) một lần. Về mặt storage **không cần migration**.
3. **Đổi `server.ts:2588` từ `capabilities: []` sang copy từ revision thật** → UI tự hiện (xem §1, H3).
4. **Thêm một bước vào `grants.ts`**, ngay sau `grants.ts:193-197` (đã biết slot có khai hay không): lấy `acceptedCapabilities` của slot, so với `capabilities` của revision được pin, thiếu thì `throw conflict('BINDING_DENIED', …)`.

**Vì sao bước 4 đặt ở `grants.ts` chứ không ở connector:** connector không biết slot là gì — nó chỉ nhận `connectorRevision` trong grant (`services.ts:76`). Chỉ orchestrator mới vừa có manifest action vừa có pin (`:190-204`). Và đặt ở đây thì lỗi ra `BINDING_DENIED` **trước khi** tốn bất kỳ token provider nào.

**Compat notes:**

- Đây là **breaking change cho profile cũ**. Mọi profile hiện có không khai `capabilities` cho revision → mọi slot sẽ fail. Cần chế độ chuyển tiếp: coi `capabilities` thiếu là *chưa khai báo* thay vì *không có năng lực nào*.
- Nếu map quá chặt sẽ chặn nhầm cấu hình hợp lệ: disbursement khai `structured-output` cho 3 slot, còn provider text-only thường **có** structured output qua JSON mode. Vì vậy khuyến nghị là **deny khi revision khai một capability không nằm trong tập slot**, chứ không đòi revision phải khai đủ mọi capability mà slot chấp nhận. Chiều ngược lại thì không chặn.

**Blast radius:** `packages/contracts`, `services/connector`, `services/orchestrator`, và **toàn bộ profile binding đang tồn tại**. Đây là lý do tôi không khuyến nghị làm một mình.

**Effort:** M.

### Phương án 1b — Bỏ field khỏi manifest (honesty)

Xóa `acceptedCapabilities` khỏi `ConnectorSlotManifestSchema` (`contracts/src/manifest.ts:17`) và khỏi mọi business manifest.

**Chi phí thật, không nên bỏ qua:**

- `acceptedCapabilities` có `.min(1)` (`:17`) — **bắt buộc**, nên xóa là thay đổi schema công khai của registry contract, có versioning (`WIRE_CONTRACT_VERSION`).
- 9 khai báo trong `document-core.manifest.ts` (`:150,155,188,222,258,293,326,416-419`), 4 trong `lc-checker/manifest.ts` (`:176,185,190,195`), 1 trong `example-review/manifest.ts:84`.
- **Test khẳng định giá trị này sẽ đỏ**: `lc-checker/tests/worker-manifest.test.ts:49`, `example-review/tests/manifest.test.ts:48-49`, `document-core/tests/traceability.test.ts:68` — ít nhất 5 assertion.
- Tài liệu mô tả nó là hợp đồng: `docs/05-business-registry.md:20` mô tả business dùng tên logical như `ocr`, `reasoning`, deployment profile ánh xạ sang connector revision thật.

**Cái thực sự thắng:** nếu chọn 1b, phải sửa luôn `docs/05-business-registry.md` và `docs/16-extension-developer-guide.md:172` — nơi nó được hứa là điều khoản cho người viết business mới. Bỏ field mà không sửa tài liệu là **tệ hơn giữ nó làm decorative**: hiện tại ít nhất người đọc vẫn tưởng nó có tác dụng.

**Effort:** S về code, nhưng kèm nghĩa vụ tài liệu và 5 test.

### Phương án 1c — Giữ nguyên, ghi rõ advisory only

Thêm doc comment vào `ConnectorSlotManifestSchema.acceptedCapabilities` (`contracts/src/manifest.ts:15-19`) rằng nó không được enforce, và sửa dòng mô tả trong `docs/05-business-registry.md:20`.

**Đánh giá thẳng:** phương án này **chỉ đúng** nếu 1a được ghi nhận là chưa làm được vì lý do kỹ thuật cụ thể. Nếu không có lý do đó, 1c là cách giữ một lời hứa sai với người viết business và làm giảm độ tin cậy của contract.

**Effort:** S.

### Khuyến nghị Gap 1

**1b-nhẹ rồi 1a, không phải 1a rồi 1b** — ngược với trực giác, vì lý do là thứ tự đọc của người khác:

1. Bắt đầu bằng **1b một cách hẹp** — đổi `acceptedCapabilities` từ *bắt buộc* (`.min(1)`) sang *tuỳ chọn*, và ghi doc rõ nó advisory. Đây là thay đổi **không phá gì**: không xóa field, không đụng test, không phải sửa 14 khai báo. Nhưng nó **dừng ngay việc hệ thống nói dối**.
2. Sau đó 1a khi đã có câu trả lời cho câu hỏi từ vựng.

Việc này tốn ít hơn 1b-đầy-đủ rất nhiều và vẫn thu được phần lớn giá trị. **Đây là khuyến nghị của tôi.**

Nếu architect muốn giữ `acceptedCapabilities` như hợp đồng cứng ngay bây giờ, thì **1a phải làm trọn cả 4 bước** — làm riêng bước 2 mà chưa có bước 4 là tạo thêm một cờ treo nữa, tức là tăng F1 chứ không giảm.

## §3 Gap 2 — Task name

### 3.1 Chế độ lỗi hiện tại, đo được

Không có registry, `task` là passthrough (`adapters/http.ts:39,49,93`). Chuỗi sai đi thẳng ra provider và quay lại qua đường này:

| Bước | Hành vi | File:line |
|---|---|---|
| 1 | Provider từ chối, ví dụ 400 | — |
| 2 | `classifyFailure`: chỉ 429 → `PROVIDER_RATE_LIMITED`, >=500 → `PROVIDER_UNAVAILABLE`, **mọi thứ còn lại → `INVALID_PROVIDER_RESPONSE`** | `adapters/http.ts:76-82` |
| 3 | `ledger.fail(...)` — **terminal**, không redeliver | `invoke.ts:426` |
| 4 | Ném `ConnectorError(code, 'Provider request failed.', { safeToRetry: chỉ RATE_LIMITED hoặc UNAVAILABLE })` | `invoke.ts:428-431` |

### 3.2 Ví dụ cụ thể

Đổi một ký tự trong `document-core/src/worker.ts:900` — `disbursement_classify` thành `disbursement_classfy`.

Chuỗi này không bị chặn ở bất kỳ tầng nào (`grants.ts` chỉ kiểm **tên slot**, không kiểm task). Nó tới provider. Giả sử provider trả 400 vì không biết task này. Kết quả quan sát được:

| Operator thấy | Thực tế |
|---|---|
| `INVALID_PROVIDER_RESPONSE` | Provider **không** trả response hỏng; nó **từ chối yêu cầu** |
| Message `Provider request failed.` | Chuỗi cố định, **không kèm HTTP status, không kèm task name** (`invoke.ts:428`) |
| Không retry | `safeToRetry` chỉ true cho 2 mã trên; 400 không thuộc danh sách (`invoke.ts:430`) |
| Operation chết vĩnh viễn | `ledger.fail` là terminal (`invoke.ts:426`) |

Tức là một **lỗi cấu hình tĩnh, biết trước ngay lần chạy đầu**, biểu diễn thành lỗi runtime không retry trông như **sự cố provider**. Đây là loại nhầm lẫn tốn thời gian nhất khi debug, vì dấu vết sẽ dẫn về phía provider thay vì về release đã deploy.

Tệ hơn: cùng cơ chế đó **giấu luôn** lỗi thật của provider. Provider trả 200 với body sai schema cũng ra `INVALID_PROVIDER_RESPONSE` (`adapters/http.ts:78-81`). Vậy hai nguyên nhân đối lập nhau — yêu cầu sai và response sai — **bị gộp về cùng một mã**, chỉ phân biệt được bằng cách đọc log provider.

### 3.3 Một điểm làm giảm nhẹ mức độ nghiêm trọng

`requestMapping` cho phép đổi tên field (`adapters/http.ts:32,36`, comment `:43-44`), nên một connector có thể **không** gửi `task` ra provider dưới tên `task` — nó có thể map sang tên khác, hoặc bỏ hẳn. Nghĩa là ngay cả khi có registry, **connector vẫn có quyền không dùng `task`**. Bất kỳ phương án nào khẳng định task phải được provider đăng ký đều giả định sai rằng mapping không đổi.

Đây cũng là lý do tôi không khuyến nghị hard-fail ở connector.

### Các phương án

| Phương án | Nội dung | Ưu | Nhược | Effort |
|---|---|---|---|---|
| **2a** Registry tại connector | Bảng task theo connector revision, connector validate trước khi gửi | Chặn lỗi sớm, thông báo rõ | Phải có nơi khai; **xung đột với `requestMapping`** (§3.3); connector không biết slot nào dùng task nào | L |
| **2b** Validate tại worker-sdk/grants | Danh sách task hợp lệ khai ở manifest hoặc profile, check khi xin grant | Chặn trước khi tốn token; có ngữ cảnh slot | Vẫn cần ai đó khai danh sách; body grant chỉ nhận `bindingSlot`, `stepKey`, `inputHash`, `artifactIds` (`architecture/05-internal-api.md:64`) nên phải mở rộng contract | M–L |
| **2c** Giữ passthrough, sửa chẩn đoán | Không validate; chỉ tách 4xx khỏi `INVALID_PROVIDER_RESPONSE`, đính kèm status + task vào message | Rẻ; **tự đóng** phần lớn chi phí gỡ rối; không đụng provider | Không chặn lỗi sớm — vẫn tới provider trước khi biết | **S** |

### Khuyến nghị Gap 2

**2c ngay, 2a chỉ khi có bằng chứng cần.** Lý do: 2a và 2b đều đòi thứ chưa tồn tại (danh sách task do ai khai?) trong khi 2c sửa đúng cái đang gây đau — **nhãn lỗi sai** — mà không cần ai khai gì cả.

2c còn có một đặc tính quan trọng: nó là **phương án duy nhất không thể sai**. Nếu sau này có registry, 2c vẫn đúng và vẫn hữu ích. 2a và 2b thì đều là quyết định khó đảo ngược nếu provider thực sự không phân biệt task.

**Lưu ý kỹ thuật cho 2c:** hiện `ConnectorErrorCode` không có mã nào cho *provider từ chối yêu cầu* (`types.ts:17-28`). Thêm mã là **thay đổi contract**, nên phương án rẻ hơn là giữ `INVALID_PROVIDER_RESPONSE` nhưng đổi message ở `invoke.ts:428` để **có** status và task, và log cả hai. Như vậy không đụng union type.

## §4 Gap 3 — Seed 9 slot P9 (quy trình, không phải code)

Đây là gap **duy nhất đóng được hoàn toàn trong repo**. Có một điểm thuận lợi: gate đã **fail-closed sẵn**.

`grants.ts:198-202` — nếu operation có pin mà pin thiếu một slot, lần gọi chết bằng `BINDING_DENIED`. Nghĩa là **thiếu seed sẽ lộ ra ngay lần chạy đầu tiên**, chứ không tạo ra hành vi sai âm thầm. Không cần viết probe để phát hiện.

### Checklist nhập liệu

| # | Bước | Kiểm tra bắt buộc | Nơi |
|---|---|---|---|
| 1 | Tạo connector revision ở trạng thái ACTIVE | adapter phải là `json-http` hoặc `multipart-http` — ngoài hai cái này `registry.get` ném `CAPABILITY_UNSUPPORTED` | `adapters/registry.ts:8-10,14-17`; quản lý revision qua `services.ts` `createRevision` |
| 2 | Cấu hình credential | `credentialSource` phải khớp binding; `legacy-db` trên revision tenant-bound bị từ chối có chủ đích | `services.ts:105-131` |
| 3 | Nếu chọn 1a: khai `capabilities` trong config | tập phủ nhu cầu slot, không chỉ khớp tên | `services/connector/src/types.ts:126` (đang là `string` số ít) |
| 4 | Ghim **đủ** các slot của action vào `profile_bindings` | format mỗi slot là `connectorId@revision` — parse bởi `parsePinnedBindings` | `profiles.ts:113`; `grants.ts:80-96` |
| 5 | Xác nhận số slot khớp manifest | disbursement 4, lc-checker 4, doc-compare 1 | `document-core.manifest.ts:415-419,461-463`; `lc-checker/manifest.ts:172-197` |
| 6 | Submit một operation thật, xác nhận grant cấp đủ slot | mọi slot `required` phải qua được bước `grants.ts:195-197` | đường `POST /tasks/{id}/invocation-grants` |

### Một quyết định vận hành phải trả lời trước bước 4

`grants.ts:203-204` — nếu operation **không** có pin (`connector_bindings IS NULL`), grant rơi về `opts.connectorId` / `opts.connectorRevision`. Nghĩa là **mọi slot dùng chung một connector**.

Hệ quả cụ thể: với disbursement, 4 task literal chạy trên **một** provider duy nhất. Với lc-checker, slot `ocr` (OCR thật) và slot `crosscheck` (chat) trỏ cùng một revision — mà lc-checker **không truyền task** (inventory receipt F3), nên provider nhận hai lời gọi rất khác nhau trên cùng endpoint và phải tự đoán từ prompt.

Đây là hai chế độ **khác hành vi**, không phải hai cách viết cùng một thứ. Chọn chế độ pin hay chế độ fallback là quyết định của coordinator và lane sở hữu deployment profile — **không phải** thứ tôi nên quyết trong memo này.

**Effort:** S, và **không cần code**.

## §5 Tóm tắt blast radius

| Phương án | File phải chạm | Có phá deployment cũ không | Cần DB window không |
|---|---|---|---|
| **1b-nhẹ (đề xuất)** | `contracts/src/manifest.ts` + 2 dòng docs | Không | Không |
| 1a-đầy đủ | `contracts`, `connector/types`, `connector/services`, `orchestrator/grants.ts`, `orchestrator/server.ts`, 5 test | **Có** — mọi profile binding hiện có | Có, để chạy lại bind + live leg |
| 1c | `contracts/src/manifest.ts` + `docs/05-business-registry.md:20` | Không | Không |
| 2a | `connector` (bảng mới + validate) + schema | Có | Có |
| 2b | `contracts` (mở rộng grant request) + `worker-sdk` + `grants.ts` | Có — contract wire | Có |
| **2c (đề xuất)** | `invoke.ts` (message), tuỳ chọn `http.ts` | **Không** | Không |
| **3 (đề xuất)** | Không có code | Không | Có — cần operation thật để xác nhận grant |

## §6 Câu hỏi mở — cần Product / architect quyết, tôi không tự quyết

| # | Câu hỏi | Vì sao tôi không trả lời được |
|---|---|---|
| Q1 | `acceptedCapabilities` còn giá trị như **hợp đồng nghiệp vụ** không, hay nó chỉ là giấy tờ của ý tưởng capability chưa ai xây? | Câu hỏi về ý định sản phẩm. Nếu còn giá trị thì 1a đáng làm; nếu không thì 1b-đầy-đủ mới đúng |
| Q2 | Ai khai `capabilities` cho một connector revision — admin thủ công, hay suy ra từ provider trong lúc `test()`? | Ảnh hưởng blast radius: thủ công = thêm UI; suy ra = cần gọi provider |
| Q3 | `doc_compare_structure` / `doc_compare_references` provider có thực sự phân biệt không? | **Không trả lời được trong repo này** (OPEN-B). Cần câu trả lời từ phía provider |
| Q4 | Ba business dùng ba chiến lược task khác nhau (4 literal / 0 literal / 2 default trên 1 slot) — chủ ý hay tiến hóa lịch sử? | Không có comment hay tài liệu nào giải thích. Nếu tiến hóa thì nên chuẩn hoá; nếu chủ ý thì giữ và **viết lại thành comment** |
| Q5 | Có chấp nhận vận hành disbursement với cả 4 slot trên một connector không (chế độ không pin)? | Quyết định vận hành, thuộc coordinator |
| Q6 | `requestMapping` được phép đổi tên `task` — vậy task registry còn ý nghĩa gì với connector đã remap? | Phụ thuộc Q3. Nếu provider dùng tên field riêng thì registry trở nên vô nghĩa với connector đó |

## §7 Giới hạn của memo này

- **Đọc code tĩnh, không implement, không đo hiệu năng.** Mọi effort là ước lượng theo **số bề mặt file**, không phải theo thời gian, và không có ai đã code bản mẫu để đo.
- Số dòng cho `services/connector`, `services/orchestrator`, `packages/contracts` đo trên working tree lúc đọc; các file này **không** có sửa đổi chưa commit tại thời điểm đó. Riêng `document-core` **đang** có sửa đổi chưa commit của lane khác — các trích dẫn `:900,936,966,1002` và `manifest.ts:415-419,461-463` ghim theo lúc đọc, không theo `HEAD`.
- Kết luận `acceptedCapabilities` không được enforce và `AdapterConfig.capability` không được đọc dựa trên **phạm vi grep toàn repo**, không phải đọc từng file. Nếu có enforcement sinh bằng reflection hay sinh code thì grep không thấy — tôi chưa kiểm đường đó.
- Phần về nguyên nhân provider trả 400 là **kịch bản giả định hợp lý**, không phải hành vi đã quan sát trên provider thật. Cái **đã đo** là: `classifyFailure` gộp mọi 4xx vào `INVALID_PROVIDER_RESPONSE` (`http.ts:76-82`), `ledger.fail` là terminal (`invoke.ts:426`), và `safeToRetry` không bao gồm nó (`invoke.ts:430`).
- Tôi **không** đánh giá provider nào nhận các task name này — đó là Q3 và nó nằm ngoài repo.
- Không chạy suite, không đụng `document-core/**` (chỉ đọc, đúng D3 lease của qwen_4), không claim DB window, không tick gate, không commit, không nhắm `nocobase-10`, không in giá trị secret nào.
