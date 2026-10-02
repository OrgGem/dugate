# Connector task-name / slot bindings inventory — 3 workflow P9 (READ-ONLY)

- **Receipt**: `qwen-connector-bindings-inventory-2026-10-02.md`
- **Dispatch**: 2026-10-02T10:42:51+07:00, coordinator `command-code`
- **Bối cảnh**: spec `codex-p9-workflow-integration-spec-2026-10-02.md` §3 + §5-Q5; D5 probe để OPEN `doc_compare_structure` / `doc_compare_references`
- **Phạm vi**: READ-ONLY. Chỉ tạo file receipt này. Không sửa source/test/config, không chạy infra, không tick gate, không commit, không nhắm `nocobase-10`.

## §0 Kết luận một trang

Câu hỏi của spec giả định có một **registry task phía connector**. Đọc code cho thấy **registry đó không tồn tại** — và đây là câu trả lời quan trọng nhất, vì nó đổi bản chất của việc đóng OPEN:

1. **Slot** là trục **có thật** và **được kiểm**: orchestrator kiểm slot có nằm trong `connectorSlots` của action không (`grants.ts:195-197`), rồi resolve `connectorId` + `revision` từ pin của operation (`:199-204`). Đóng được, nhưng là việc **nhập liệu dữ liệu**.
2. **Task name** là trục **không có registry**: nó là một chuỗi **thông suốt** đi thẳng ra body của provider HTTP (`adapters/http.ts:49,93`). Không nơi nào khai báo, kiểm tra hay ràng buộc nó.

Hai hệ quả cần nói thẳng trước khi đọc tiếp:

- Cột `acceptedCapabilities` trong manifest **không được enforce ở bất kỳ đâu** (F1). Nên câu hỏi "connector có task/slot nào đăng ký" không thể trả lời bằng `acceptedCapabilities`.
- Ngay cả khi muốn enforce, hai bộ từ vựng **không giao nhau**: connector tự báo `capabilities: [adapter.mode]` tức `json` hoặc `multipart` (`adapters/registry.ts:20-27`), còn manifest khai `chat-completion`, `structured-output`, `ocr`, `vision`… (F2). Không có giao điểm để so.

Không có seed nào cho 9 slot của 3 business P9. Toàn bộ dữ liệu binding tồn tại trong repo đều là **fixture test**, và chỉ dành cho `example-review` / slot `reasoning` (F5).

## §1 Mô hình binding — 4 tầng, đọc từ tầng dưới lên

| Tầng | Nơi | Việc | File:line |
|---|---|---|---|
| 1 | Business worker | Gọi `connector.invoke(slot, { task, prompt, ... })` | vd `document-core/src/worker.ts:881,1001` |
| 2 | worker-sdk | Đóng gói thành `bindingSlot: slot` khi xin grant | `packages/worker-sdk/src/task-context.ts:867,884` |
| 3 | Orchestrator grants | Kiểm slot khai báo → kiểm pin → resolve connector identity | `services/orchestrator/src/modules/grants/grants.ts:195-204` |
| 4 | Connector | Lấy `connectorRevision` **từ grant**, tải revision row, gửi `task` thẳng cho provider | `services/connector/src/services.ts:76-95`; `adapters/http.ts:49,93` |

Chi tiết tầng 3 (`grants.ts:187-204`) — đây là **chỗ duy nhất** quyết định slot có hợp lệ không:

```
190  const enabled = await registry.getEnabledVersion(t.business_id, t.business_version);
191  const action = enabled.manifest.actions.find((a) => a.name === t.action);
193  const declaredSlots = (action.connectorSlots ?? []).map((s) => s.name);
195  if (!declaredSlots.includes(req.bindingSlot)) {
196    throw conflict('BINDING_DENIED', `slot ${req.bindingSlot} not declared by action ${t.action}`);
197  }
198  const pin = t.connector_bindings == null ? null : parsePinnedBindings(t.connector_bindings);
199  const pinSlot = pin?.[req.bindingSlot];
200  if (pin && !pinSlot) {
201    throw conflict('BINDING_DENIED', `slot ${req.bindingSlot} is not pinned for this operation`);
202  }
203  const connectorId = pinSlot?.connectorId ?? opts.connectorId;
204  const connectorRevision = pinSlot?.revision ?? opts.connectorRevision;
```

Định dạng pin là chuỗi `connectorId@revision` mỗi slot, parse bởi `parsePinnedBindings` (`grants.ts:76-96`). Chữ `slot` trong comment `:187-189` nói rõ nguyên tắc: **action không khai slot thì không grant slot nào — fail closed**.

Tầng 4 không hề tra cứu slot: connector nhận `claims.connectorRevision` từ grant (`services.ts:76`), tách `connectorId:revision`, tải row, rồi `registry.get(revision.adapter)` (`:132`). Toàn bộ ý nghĩa của slot đã **được tiêu tốn hết ở tầng 3**.

## §2 disbursement — 4 task hard-code, 4 slot khai ở manifest

**Số dòng đo được, khác với số trong dispatch.** Dispatch và D5 probe ghi `:877, 913, 943, 979`; tôi đo trực tiếp thấy lệch. Tôi ghi số đo được và đã tự mở `:897-906` để xác nhận `disbursement_classify` nằm ở dòng **900**:

| Task name | Slot kèm theo | Dòng thật (đo) | Dòng trong dispatch |
|---|---|---|---|
| `disbursement_classify` | `classify` | `:900` | `:877` |
| `disbursement_extract` | `extract` | `:936` | `:913` |
| `disbursement_crosscheck` | `crosscheck` | `:966` | `:943` |
| `disbursement_report` | `report` | `:1002` | `:979` |

Cả 4 đều là **string literal hard-code** trong source, không nằm trong manifest, không nằm trong profile schema. Đi qua `invokeJson` (`worker.ts:869-887`) vốn bọc `invokeJson(slot, stepName, task, prompt, payload, outputSchema)` và gọi `internal.connector.invoke` (`:881`). Riêng `report` gọi thẳng không qua wrapper (`:1001-1002`).

Slot khai ở manifest — action disbursement, `document-core.manifest.ts:415-419`:

| Slot | required | acceptedCapabilities |
|---|---|---|
| `classify` | true | chat-completion, structured-output |
| `extract` | true | chat-completion, structured-output |
| `crosscheck` | true | chat-completion, structured-output |
| `report` | true | chat-completion |

**Khớp 4/4** giữa slot manifest và slot dùng lúc chạy. Đây là business duy nhất trong 3 cái có task name tường minh.

## §3 lc-checker — 4 slot khai và dùng khớp, nhưng **không truyền task nào**

Đây là phát hiện đáng chú ý nhất về mặt hành vi: **lc-checker không gửi `task` ở bất kỳ lần invoke nào.**

| Slot | Hằng số | Dòng gọi | Có `task`? |
|---|---|---|---|
| `ocr` | `worker.ts:58` | `:266` | **Không** — chỉ `{ prompt, artifacts }` |
| `vision` | `worker.ts:59` | `:304` | **Không** — chỉ `{ prompt, artifacts }` |
| `crosscheck` | `worker.ts:60` | `:335` (screen), `:357` (adjudicate) | **Không** — chỉ `{ prompt }` |
| `report` | `worker.ts:61` | `:374` | **Không** — chỉ `{ prompt }` |

Tôi đã đọc trực tiếp cả 4 khối (`:266-274`, `:304-312`, `:335-343`, `:357-365`, `:374-378`) để xác nhận: không có trường `task` nào trong object truyền vào `ctx.connector.invoke`.

Hệ quả đo được: với lc-checker, **provider phải tự suy ra việc cần làm từ nội dung prompt**. Cùng một slot `crosscheck` phục vụ **hai** công việc khác nhau — screen (`:335`) và adjudicate (`:357`) — và không có gì ở tầng connector phân biệt hai lần gọi đó ngoài nội dung prompt. Với disbursement thì ngược lại, 4 slot tách biệt và có tên task.

Manifest khai 4 slot tương ứng (`lc-checker/src/manifest.ts:172-197`), đủ 4 là `required: true`. Khớp 4/4 với phía dùng. `vision` có chú thích giải thích lý do tách khỏi `ocr` (`:177-181`): đọc chữ ký trên bản scan là năng lực khác đọc văn bản, gộp một provider sẽ âm thầm hạ chất lượng pass thị giác.

## §4 doc-compare — 1 slot, 2 task name, default trong code

`DEFAULT_DOC_COMPARE_BINDING` (`pipelines/workflows/doc-compare/runner.ts:51-55`):

```
51  export const DEFAULT_DOC_COMPARE_BINDING: DocCompareConnectorBinding = {
52    slot: 'reasoning',
53    structureTask: 'doc_compare_structure',
54    referenceTask: 'doc_compare_references',
55  };
```

- Kiểu `DocCompareConnectorBinding` khai `readonly slot: 'ocr' | 'reasoning' | 'vision'` (`runner.ts:44`) — **default chỉ dùng `reasoning`**, hai giá trị kia là dự phòng.
- Có thể override qua `options.binding` (`runner.ts:346`), nên đây là **config, không phải hằng số cứng** — khớp với điều D5 probe đã ghi.
- Manifest action `doc-compare` khai **đúng một slot** `reasoning`, `required: true` (`document-core.manifest.ts:461-463`), kèm chú thích `:459-460` giải thích: một slot, đổi task theo giai đoạn chứ không đổi slot.
- Worker truyền binding vào runner tại `document-core/src/worker.ts:1473`.

Khớp slot: `reasoning` khai ở manifest, `reasoning` dùng ở default. **Hai task name thì không có nơi nào đăng ký** — grep `doc_compare_structure` toàn repo chỉ ra `runner.ts` và test `p9-03-doc-compare-runner.test.ts` (`codex-d5-scope-probe-...:29` đã ghi nhận đúng, tôi xác nhận lại).

## §5 services/connector — không có task registry, bằng chứng cấu trúc

### 5.1 Bảng `connector_revisions` không có cột slot/task/capability

`services/connector/src/db/migrations/001_connector.sql:1-10`:

```
connector_id, revision, adapter, config, credential_ref, state, created_at
PRIMARY KEY (connector_id, revision)
```

Migration sau bổ sung `tenant_id`, `account_id`, `credential_source` — vẫn không có cột nào chứa slot hay task. Vậy **một connector revision là một endpoint + credential**, không phải một nhà cung cấp task.

### 5.2 `task` là passthrough thuần

`adapters/http.ts:39` khai mapping `task: 'input.task'`, `:49` ghi thẳng `body.task = request.input.task`, `:93` `form.set('task', request.input.task)`. Không validate, không tra bảng, không whitelist.

### 5.3 Registry chỉ chứa transport adapter

`adapters/registry.ts:8-10` — `AdapterRegistry` giữ `jsonHttpAdapter` và `multipartHttpAdapter` (`adapters/http.ts:28,88`, id `json-http` / `multipart-http`). `get(id)` ném `CAPABILITY_UNSUPPORTED` nếu không có (`:14-17`). Và `list()` (`:20-27`) báo capability là `[adapter.mode]` → chỉ `json` hoặc `multipart`.

## §6 Bảng tổng hợp — business → cần gì → connector có gì → verdict

| Business | Cần slot (manifest) | Task gửi lên | Slot khai đúng? | Task có registry? | Cần đăng ký ở đâu | Verdict |
|---|---|---|---|---|---|---|
| disbursement | `classify` | `disbursement_classify` | Có `:416` | **Không** | pin + revision row | OPEN-A + OPEN-B |
| disbursement | `extract` | `disbursement_extract` | Có `:417` | **Không** | pin + revision row | OPEN-A + OPEN-B |
| disbursement | `crosscheck` | `disbursement_crosscheck` | Có `:418` | **Không** | pin + revision row | OPEN-A + OPEN-B |
| disbursement | `report` | `disbursement_report` | Có `:419` | **Không** | pin + revision row | OPEN-A + OPEN-B |
| lc-checker | `ocr` | *(không gửi)* | Có `manifest.ts:173` | Không áp dụng | pin + revision row | OPEN-A |
| lc-checker | `vision` | *(không gửi)* | Có `manifest.ts:181` | Không áp dụng | pin + revision row | OPEN-A |
| lc-checker | `crosscheck` | *(không gửi)* | Có `manifest.ts:189` | Không áp dụng | pin + revision row | OPEN-A |
| lc-checker | `report` | *(không gửi)* | Có `manifest.ts:194` | Không áp dụng | pin + revision row | OPEN-A |
| doc-compare | `reasoning` | `doc_compare_structure` | Có `manifest.ts:462` | **Không** | pin + revision row | OPEN-A + OPEN-B |
| doc-compare | `reasoning` | `doc_compare_references` | Cùng slot | **Không** | pin + revision row | OPEN-A + OPEN-B |

Chú giải verdict:

- **OPEN-A** — lỗ hổng **dữ liệu**, đóng được trong repo. Cần một `connector_revisions` row ACTIVE + một `profile_bindings` row ghim đủ các slot.
- **OPEN-B** — lỗ hổng **ngữ nghĩa**, **không đóng được trong repo này**. Chỉ provider mới biết nó có nhận discriminator `disbursement_classify` hay không.

## §7 Phát hiện cần nêu kèm

### F1 — `acceptedCapabilities` không được enforce ở bất kỳ đâu

Grep toàn `du-rework` cho `acceptedCapabilities` ra 35 chỗ. Phân loại hết:

| Nhóm | Số chỗ | Có phải enforcement không |
|---|---|---|
| Định nghĩa schema | `packages/contracts/src/manifest.ts:17` | Không — chỉ validate shape |
| Khai báo trong business manifest | document-core 8 chỗ, lc-checker 4, example-review 1 | Không |
| Test khẳng định giá trị khai | `lc-checker/tests/worker-manifest.test.ts:49`, `document-core/tests/traceability.test.ts:68`, `example-review/tests/manifest.test.ts:48-49` | Không |
| Test ánh xạ capability → options | `example-review/tests/p7-04-profile-assignment.integration.test.ts:185` | Chỉ trong test |
| Tài liệu | `docs/05-business-registry.md:20`, `docs/16-extension-developer-guide.md:172` | Không |

**Không có dòng production nào trong orchestrator hay connector đọc danh sách này.** `grants.ts:193-197` chỉ so **tên slot** với `declaredSlots`; `:200-202` chỉ kiểm pin. Hệ quả: bind slot `vision` (yêu cầu `vision`, `handwriting`, `document-layout`) vào một connector chỉ làm text là **được**, và sẽ chỉ lộ ra ở chất lượng đầu ra chứ không lộ ra ở lỗi binding.

Hệ quả phụ liên quan: `required: true` cũng chỉ được kiểm ở **UI quản trị** (`app/admin/profile-view-models.ts:326-330`, điền trống → `Required slot is empty`), không có kiểm tương đương trên đường grant.

### F2 — Hai bộ từ vựng capability không giao nhau

| Nguồn | Tập giá trị | File:line |
|---|---|---|
| Manifest khai | chat-completion, structured-output, ocr, pdf-text, vision, handwriting, document-layout | `document-core.manifest.ts:150-419`, `lc-checker/manifest.ts:176-195` |
| Connector tự báo | json, multipart | `adapters/registry.ts:20-27` từ `http.ts:29,88` |

Không có phần tử chung. Nghĩa là kể cả khi ai đó muốn bật enforcement theo F1, **hiện chưa có dữ liệu phía connector để so** — phải mở rộng `connector_revisions` hoặc `AdapterRegistry` trước. Đây là lý do F1 không phải một dòng code.

### F3 — OPEN-B về bản chất, không phải thiếu cấu hình

Vì `task` là passthrough (`http.ts:49`), một provider có thể nhận bất kỳ chuỗi nào. Câu hỏi "connector có đăng ký `doc_compare_structure` không" **không có câu trả lời trong hệ thống này**, kể cả ở production đang chạy. Đó là giới hạn kiến trúc, không phải thiếu sót của riêng wave này.

Hệ quả thực tế: nếu provider **không** phân biệt task, `doc_compare_structure` và `doc_compare_references` sẽ cho cùng một kết quả — và runner **không có cách nào phát hiện** điều đó, vì nó chỉ kiểm shape đầu ra.

### F4 — Hai business dùng hai chiến lược task khác nhau, không có lý do đã ghi

| Business | Chiến lược | Hệ quả vận hành |
|---|---|---|
| disbursement | 4 slot + 4 task literal | Cần binding 4 dòng; đổi tên task là sửa source |
| lc-checker | 4 slot, **0 task** | Provider tự đoán từ prompt; slot `crosscheck` phục vụ 2 việc |
| doc-compare | 1 slot + 2 task default | Ít binding nhất, nhưng gắn cứng vào provider hiểu discriminator |

Không có tài liệu hay comment nào giải thích vì sao lc-checker không truyền task, trong khi disbursement thì có. Đây là **câu hỏi cần owner trả lời**, không phải lỗi tôi tự kết luận.

### F5 — Không có seed cho bất kỳ business P9 nào

Mọi `INSERT INTO profile_bindings ... connector_bindings` trong repo đều nằm trong **test**:

- `businesses/example-review/tests/p7-04-profile-assignment.integration.test.ts:134`
- `businesses/example-review/tests/p7-03-registry-live.integration.test.ts:128`
- `services/orchestrator/tests/admin-action-rbac-live.test.ts:160-161`

Cả ba đều bind **slot `reasoning` của `example-review`** tới `test-connector@1` (xác nhận từ mô tả P7-04 trong `tasks/P7-extension-proof.md:23`). Đường ghi production là `modules/profiles/profiles.ts:96-128`.

Vậy **9 slot của 3 business P9 chưa có một binding dữ liệu nào trong repo**. Đây là cơ sở để gắn nhãn OPEN-A cho cả 9 dòng.

## §8 Cần đăng ký ở đâu — không tự sửa

Đúng theo yêu cầu, tôi **không** tạo bất kỳ dữ liệu hay config nào. Hai bước, theo đúng thứ tự:

| Bước | Làm gì | Ở đâu |
|---|---|---|
| 1 | Tạo connector revision ACTIVE (adapter + config endpoint + credential) | `POST` quản lý revision của connector, ghi vào `connector_revisions` qua `services/connector/src/services.ts` (`createRevision`) |
| 2 | Ghim slot → `connectorId@revision` cho đúng (business, version, action) | Admin profile-bindings → `INSERT INTO profile_bindings` tại `profiles.ts:113` |

Ràng buộc khi làm bước 2 — suy ra trực tiếp từ code, không phải khuyến nghị chung:

- Nếu operation **có** pin, grant chỉ cấp cho slot đã ghim (`:200-202`). Pin thiếu một slot trong 4 slot `required` của disbursement hoặc lc-checker sẽ khiến lần gọi đó **chết bằng `BINDING_DENIED`**, không phải chạy được với fallback.
- Nếu operation **không** có pin (`connector_bindings IS NULL`), grant rơi về `opts.connectorId` / `opts.connectorRevision` (`:203-204`) — tức **mọi slot dùng chung một connector**. Với disbursement điều này làm 4 task chạy trên một provider duy nhất.

Đây là hai chế độ **khác hành vi**, không phải hai cách viết cùng một thứ. Ai quyết định dùng chế độ nào là việc của coordinator và lane sở hữu deployment profile.

## §9 Giới hạn của receipt này — đọc trước khi dùng

- **Đọc code và migration tĩnh. KHÔNG phải live registry state.** Tôi không truy vấn `connector_revisions`, không đọc `profile_bindings`, không gọi API quản trị. Bảng `§6` nói **cấu trúc có sẵn**, tuyệt đối không nói **trạng thái hiện tại của một deployment**.
- Số dòng disbursement trong dispatch (`:877,913,943,979`) lệch với số đo được (`:900,936,966,1002`). Tôi ghi số đo và tự mở file xác nhận một chỗ. Nếu ai đó đối chiếu với dispatch thì đây là chỗ lệch, không phải lỗi đọc file.
- **Cảnh báo trôi số dòng:** `document-core/src/worker.ts` và `document-core/src/manifest/document-core.manifest.ts` đang có **sửa đổi chưa commit của lane khác** (qwen_4 giữ D3 lease, đang làm P9-03 doc-compare) tại thời điểm tôi đọc. Mọi số dòng tôi trích trong hai file này **ghim theo working tree lúc đọc**, không phải theo `HEAD`. Khi lane đó commit, các số dòng có thể dịch. Các file tôi trích thuộc orchestrator / connector / lc-checker không có thay đổi chưa commit lúc đọc.
- `acceptedCapabilities` không được enforce: kết luận này dựa trên **phạm vi grep toàn repo** chứ không phải đọc hết mọi file. Nếu có enforcement sinh ra bằng reflection, cấu hình hay sinh code thì grep sẽ không thấy — tôi chưa kiểm đường đó.
- `task` passthrough: kết luận dựa trên `adapters/http.ts`. Chỉ có **hai adapter** trong repo (`registry.ts:8-10`) nên phủ hết, nhưng nếu sau này thêm adapter thì cần đọc lại.
- Tôi **không** đánh giá provider nào thực sự nhận các task name này. Đó chính là OPEN-B và nó nằm ngoài repo này.
- Không chạy suite, không đụng `document-core/**` (chỉ đọc, đúng D3 lease của qwen_4), không claim DB window, không tick gate, không commit.
