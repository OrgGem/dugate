# Coordination Requests — QWEN-3 (BUGFIX lane)

Lane: `QWEN-3 (BUGFIX)` — Qwen Code v0.24.4, qwen3.8-max, cwd `D:\Git\dugate`. Không phải phiên điều phối.
Báo cáo đầy đủ: [`reports/qwen3.md`](../reports/qwen3.md). File này chỉ chứa **những gì tôi cần từ người
khác** để đóng việc, mỗi dòng tự đủ để dispatch.

Ngày: 2026-09-24. Cập nhật ở W48-Q3-1 (vai trò Coder 6 — Multi-container & Infra integration): **mọi RUN
REQUEST trong file này đã tiêu thụ**; phần còn lại là **quyết định của coordinator**, không phải lượt chạy.

Cập nhật 2026-09-25 ở **W49-Q3-2 (packet R1-C — harness offline Network & Secret boundaries)**: lane đã nộp
kế hoạch (`reports/qwen3.md` → `## W49-Q3-2`) và **dừng ở mục 7 dưới đây**. Không có RUN REQUEST mới (harness
R1-C không cần DB window). Phần W48-Q3-1 giữ nguyên phía trên để đối chiếu.

---

## 0. Trạng thái để reconcile (tôi KHÔNG tự tick)

| Hàng | Trạng thái tôi báo | Vì sao chưa đóng |
|---|---|---|
| `R24-02` | **ĐỦ bằng chứng cấp suite**: `Tests: 13 passed, 13 total` + `ExitCode: 0`, 0 skipped, trên đúng byte mtime 17:50 (`antigravity-6.md:7314-7381`) | không còn gì để xin — **đóng hay không là quyền coordinator**. Lane đã báo 3 finding phụ (F1/F2/F3) và để ngỏ lựa chọn "reconcile trước" vs "vá rồi đóng": xem `reports/qwen3.md` → W48-Q3-1 mục 5 |
| `P5-10` | `[~]` giữ nguyên | điều kiện coordinator nêu (13/13 executed exit 0) **đã thoả mãn**; tôi vẫn không tự tick |
| `FIX-CR-13` | không đổi (đã CLOSED bởi owner file ở cycle 86) | tôi chỉ là lane kế thừa phần test còn sót |

Không sửa `docs/35`, `tasks/REVIEW-FIXES-2026-09-24.md`, `tasks/P*.md`, `dispatch-receipts.md`.

**Request mới của cycle W48-Q3-1** (không cần DB window): **OR-Q3-02** ở mục 6 dưới đây — tách đường chạy
offline/live cho `@du/document-core`, vì `pnpm test` hiện **tự động** mở suite live này.

---

## 1. RUN REQUEST → antigravity (`term_47a1d44b`, holder PG :5433 / Redis :6380) — **TOÀN BỘ ĐÃ TIÊU THỤ**

### 1A. REQ-1.1 .. REQ-1.4 — **ĐÃ TIÊU THỤ** (A6 chạy ở W42-A97 13:28:38→13:35:50 và re-run 13:58:35→13:59:15)

A6 báo: a1/a2/a3 focused pass (tương ứng `700 ms` / `1046 ms` / `640 ms`, mỗi lệnh `1 passed, 12 skipped`,
ExitCode 0) và **Lệnh 4 full suite = `Tests: 13 passed, 13 total`, 0 skipped, ExitCode 0** — hai lần liên
tiếp (`antigravity-6.md:6093-6153`, `:6330-6345`). Giữ các lệnh này ở đây để đối chiếu, **không yêu cầu
chạy lại**.

Cả 4 mã nguồn đã sửa xong + `test:typecheck`/`lint` ExitCode 0. Tôi không tự claim window, không tự chạy.
Chạy theo thứ tự, mỗi lệnh một lượt, **đơn tiến trình**, không chồng Live suite nào khác.

```
REQ-1.1  pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit -t "verifies business version pinning"
         mong đợi: Tests: 1 passed, 12 skipped, 13 total | ExitCode 0 | đóng: Fix 1 (enable vs activate)
```
```
REQ-1.2  pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit -t "verifies worker process crash and lease recovery"
         mong đợi: Tests: 1 passed, 12 skipped, 13 total | ExitCode 0 | đóng: Fix 2
         nếu fail: xin NGUYÊN VĂN dòng "[crash-recovery] expected root task leased by …" (test tự in inventory mọi task row)
```
```
REQ-1.3  pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit -t "12. Enforces deterministic connector revision pinning"
         mong đợi: Tests: 1 passed, 12 skipped, 13 total | ExitCode 0 | đóng: Fix 3 (chứng minh hết cascade khi chạy đơn độc)
```
```
REQ-1.4  pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit
         mong đợi: Tests: 13 passed, 13 total | ExitCode 0 | ĐÂY MỚI LÀ bằng chứng cấp suite cho R24-02/P5-10
```

Ghi chú: `skipped` ở REQ-1.1..1.3 là **chủ ý** do `-t`, không được báo là pass cấp suite. Yêu cầu gửi
`DB RELEASED` ngay khi jest dừng. Pre-flight build (`node scripts/build-dependencies.cjs`, 8 packages) đã
xong ở lượt #3 — **không cần** `test:integration:full`, dùng `exec jest` để bỏ một lớp fail.

### 1B. REQ-1.5 — đã tiêu thụ / bị thay (A6 báo 13/13 lúc 13:36, rồi RED 11/2 sau khi connector siết auth)

### 1C. REQ-1.6 — **ĐÃ TIÊU THỤ** (W48-Q3-1 ghi nhận receipt 18:04:30)

**Receipt**: W46-A6-7, 18:04:10→18:04:30, `npx jest tests/multi-container-e2e.integration.test.ts
--runInBand --forceExit` (cwd package dir) → **`Tests: 13 passed, 13 total`**, 0 skipped, **ExitCode 0**,
`DB RELEASED`. Nguồn gốc: `reports/antigravity-6.md:7314-7381`; `docs/35` row 20 đã ghi canonical.
**KHÔNG chạy lại REQ-1.6** — yêu cầu hiện tại của lane là quyết định (a)/(b) ở
[`reports/qwen3.md` → W48-Q3-1 mục 5](../reports/qwen3.md), không phải một lượt suite nữa.

Bản văn đầy đủ ở [`reports/qwen3.md` → mục "W46-Q3-3"](../reports/qwen3.md), giữ bên dưới để đối chiếu.

```
REQ-1.6  pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit
         cwd D:\Git\dugate
         mong doi: Tests: 13 passed, 13 total | ExitCode 0 | khong chap nhan bat ky chu "skipped" nao
         dong: R24-02 cap suite tren ma 17:52 + du dieu kien reconcile P5-10
         rang buoc: don tien trinh; KHONG qua tests/isolation/concurrent-runner.ps1; khong cho Live suite
         khac chong len; dist da rebuild 13:43/13:48 nen KHONG can build:deps; gui DB RELEASED ngay khi jest dung
         neu fail: xin nguyen van TUNG fail message
```

Phân loại tôi đã chuẩn bị: fail ở `authorizeInvocation` / `BINDING_DENIED` / `GRANT_INVALID` /
`x-invocation-grant` → **lỗi fixture của tôi, tôi sửa tiếp** (chính tôi đã để 2 GET không grant, khiến
connector trả 403 **đúng**). Fail trong `services/connector/src` hoặc `services/orchestrator/src` →
PLATFORM/OWNER REQUEST kèm literal, tôi không tự sửa src lane khác.

### 1B-cu. REQ-1.5 (luu tru): chạy lại Lệnh 4 trên mã có fix lease-sweeper race

Bản văn đầy đủ (lý do, điều kiện, cách phân loại fail) ở
[`reports/qwen3.md` → mục "REQ-1.5 — bản văn chính thức"](../reports/qwen3.md), soạn **17:26** ngày
2026-09-24. Bản dưới là bản rút gọn để thực thi.

Sau khi A6 báo 13/13, tôi vẫn tìm ra một race **thật** chưa ai sửa và đã vá trong `beforeAll`
(`leaseRecoveryIntervalMs: 0`, dòng 364 của file test): background lease sweeper chu kỳ 5 s của orchestrator
set `leased_by = NULL` cho task RUNNING có lease hết hạn
(`services/orchestrator/src/modules/runtime/runtime.ts:779-817`, armed ở `src/server.ts:159-161,291-294`
vì suite truyền `autoDispatch: true`), đúng lúc test 11 đang assert — tức nguyên nhân thật của chữ ký
`Expected "child-worker-crash-…", Received: null`. Test 11 lại **tự giả lập** công việc của sweeper
(`:1806-1816`) nên có hai actor cùng làm recovery. Đã kiểm knob có hiệu lực trong chính artifact mà jest
nạp: `services/orchestrator/dist/server.js:102,231`.

```
REQ-1.5  pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit
         cwd D:\Git\dugate
         mong đợi: Tests: 13 passed, 13 total | ExitCode 0 | KHÔNG chấp nhận bất kỳ chữ "skipped" nào
         đóng: R24-02 cấp suite + đủ điều kiện reconcile P5-10
         ràng buộc: đơn tiến trình; KHÔNG qua tests/isolation/concurrent-runner.ps1; không cho Live suite
         khác chồng lên (suite này không dùng createTestIsolationContext); dist đã rebuild 13:43/13:48 nên
         KHÔNG cần build:deps; gửi DB RELEASED ngay khi jest dừng
         nếu fail: xin nguyên văn TỪNG fail message, gồm cả dòng "[crash-recovery] expected root task
         leased by …" mà test tự in (chứa inventory mọi task row của operation)
```

---

## 2. OWNER REQUEST → antigravity: **PR-Q3-01** (đã ghi ở `reports/qwen3.md`)

`businesses/example-review/tests/example-review-continuation.integration.test.ts:32,43,44` còn đúng khối
global blob fetch rewrite + base64 fallback của R24-02. **Ngoài ranh giới tôi** nên tôi không sửa.
Hệ quả cần lưu ý khi đọc `docs/35`: suite đó vẫn `[PASS] 10/10` **nhờ shim che**, nên nó không phải bằng
chứng cho raw-wire của FIX-CR-13. Gỡ theo khuôn R24-02 rồi chạy lại; có thể mượn nguyên helper
`downloadArtifactBytes` (đối chứng `sha256` + `size_bytes`) tôi vừa đặt ở document-core.

---

## 3. QUYẾT ĐỊNH → coordinator: **REQ-2 (chứng minh suite hermetic)**

Bằng chứng nguồn tìm được khi sửa Fix 1: `is_active` default **false**
(`services/orchestrator/migrations/0006_active_version.sql:6-7`), submission chọn version theo
`is_active=true` (`src/modules/operations/submission.ts:236-240`), `/enable` **không** đụng `is_active`
(`src/server.ts:882-900`), chỉ `/activate` dịch con trỏ (`registry.ts:143-146`). `beforeAll` của suite
trước đây chỉ `/enable` ⇒ suite **xanh nhờ DB còn sót** active pointer; trên schema migrate trắng thì
mọi submission 404 và **cả 13 test chết**.

Tôi đã thêm `/activate` + assertion vào `beforeAll` (Fix 1b), **nhưng không thể chứng minh bằng lượt chạy
trên DB đang nóng** — chạy kiểu gì cũng pass. Cần một lượt trên schema migrate trắng.
Reset/drop `du_orchestrator_test` là hành động phá tài nguyên chung → **tôi không tự yêu cầu lane khác
làm**. Bạn quyết: cấp, hoặc chấp nhận Fix 1b ở nhãn "phòng vệ hợp lý theo nguồn, chưa có bằng chứng
thực nghiệm".

---

## 4. QUAN SÁT FLEET → coordinator: **REQ-3 (quy chế chạy multi-container)**

`tests/isolation/concurrent-runner.ps1:52` in `Zero Cross-Run Cleanup: True (strictly isolated per-run
sandboxes)`, và Live-mode inject `TEST_RUN_ID` (`:303`). Nhưng:
- `grep TEST_RUN_ID` trên `businesses/document-core/` → **0 hit** ⇒ suite này không tham gia isolation.
- Live-mode trỏ **cùng một** `du_orchestrator_test` cho cả procA/procB, chỉ khác `REDIS_DB_INDEX`
  (`:78,87`), trong khi header suite tự cấm chạy song song (`multi-container-e2e...:41-49`).

Đề nghị: (a) cấm chạy multi-container qua concurrent-runner, hoặc (b) bổ sung `createTestIsolationContext`
cho nó. Kèm cảnh báo: nếu 3 fail nền trong `docs/35` từng sinh ra dưới runner thì **chưa đủ tư cách** là
số liệu về mã nguồn.

---

## 5. ĐIỀU KIỆN tôi sẽ quay lại xin bạn sau (không phải request bây giờ)

Nếu REQ-1.2 vẫn fail với `leased_by=NULL` **trên đúng root task** đã xác định bằng `task_key='root'` ⇒
bằng chứng bug lease phía platform đã đủ, tôi sẽ mở PLATFORM/OWNER REQUEST → **Claude Code** (runtime
lease/sweeper), kèm literal fail. Tôi sẽ **không** sửa `services/orchestrator/src/**` và cũng không nới
assertion trong test cho xanh.

Tương tự nếu REQ-1.4 đỏ vì `expected '<hex>' to be null` ⇒ nghi vấn finalize gap (artifact READY mà thiếu
`sha256`) → cùng đường gửi Claude Code.

**KHÔNG kích hoạt** (ghi nhận W48-Q3-1): REQ-1.4 được trả lời `13 passed, 13 total` exit 0 ở 18:04:30 —
không còn `leased_by=NULL`, không còn `expected '<hex>' to be null`. Hai đường gửi Claude Code vì thế
**không mở**.

---

## 6. OWNER REQUEST → packaging `@du/document-core`: **OR-Q3-02** (W48-Q3-1, finding F4)

**Tự đủ để dispatch, không cần DB window.**

`businesses/document-core/package.json` có `"test": "jest --runInBand"`, còn `jest.config.cjs` đặt
`roots: ['<rootDir>/tests']` + `testMatch: ['**/*.test.ts']` và **không** có `testPathIgnorePatterns`,
**không** có `projects`. Tên suite live là `multi-container-e2e.integration.test.ts` → khớp `*.test.ts`,
nên **mọi** lệnh `pnpm --dir du-rework/businesses/document-core run test` đều mở suite cần
PostgreSQL :5433 + Redis :6380, kể cả khi người chạy không holder cửa sổ đó. Cùng vấn đề với
`tests/bullmq-smoke.test.ts` (cần Redis).

Hệ quả thật: `beforeAll` fail-closed (`validateTestDatabaseTarget` / `validateTestRedisTarget` +
kiểm `dist/worker.js`) nên nó **đỏ chứ không im lặng** — nhưng đỏ theo hai kiểu khác nhau và đều hại
điều phối: `ECONNREFUSED` trên máy không DB (noise, gợi sai rằng có bug), và **tranh chấp** trên máy
đang có window của lane khác (đúng lớp sự cố deadlock mà fleet đã trả giá).

Đề nghị, chọn một:
- **(A)** thêm `"test:unit": "jest --runInBand --testPathIgnorePatterns=integration --forceExit"` và
  `"test:live": "jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit"`; hoặc
- **(B)** đặt `testPathIgnorePatterns: ['\\.integration\\.test\\.ts$', 'bullmq-smoke']` vào
  `jest.config.cjs` và cho `test:integration` override lại bằng `--testPathIgnorePatterns=`.

Khuôn đã có sẵn trong repo: `businesses/example-review/package.json:12`
(`"test:unit": "jest --testPathIgnorePatterns=integration --runInBand"`).

Hai chỗ tài liệu đang mô tả sai cơ chế hiện hành, cần sửa kèm (tôi **không** tự sửa vì ngoài boundary):
`coordination/WAVE-17-PARSER-BUDGETS.md:11` (nói multi-container + bullmq-smoke đã bị loại "via
testPathIgnorePatterns") và `coordination/reports/qwen3.md` dòng mà cycle trước ghi fence thuộc "project
Document Core Offline" — chỗ thứ hai **tôi đã tự đính chính** trong report của mình ở W48-Q3-1.

**Ranh giới**: tôi không đụng `package.json` / `jest.config.cjs` của bất kỳ package nào. Đây là request,
không phải thông báo đã làm.

---

## 7. W49-Q3-2 (R1-C) — 1 quyết định ranh giới + 4 PLATFORM REQUEST. Không có RUN REQUEST.

Chi tiết khảo sát + toàn bộ case table: [`reports/qwen3.md` → `## W49-Q3-2`](../reports/qwen3.md). Mỗi dòng dưới
tự đủ để dispatch.

### 7.1 QUYẾT ĐỊNH → coordinator: **BR-Q3-01** (blocker duy nhất của lane)

Toàn bộ harness R1-C Tier 0/T1 phải nằm ở `services/orchestrator/tests/**`, `services/connector/tests/**`,
`packages/{connector-client,worker-sdk,observability,contracts}/tests/**` và kit mới
`du-rework/tests/harness/network-boundaries/` — **ngoài** ranh giới hiện tại của lane
(`businesses/document-core/tests/**` + `du-rework/tests/integration/multi-container*`). Chọn một:
- **(a)** cấp cho QWEN-3 quyền tạo file trong các thư mục `tests/` nêu trên (**chỉ test, không `src/`**) → tôi
  dựng kit + viết Tier 0 ngay, không cần DB window; hoặc
- **(b)** giao harness cho owner test-infrastructure khác và dùng `## W49-Q3-2` làm spec.

Không có trả lời, lane **dừng ở mức spec** — tôi không tự mở rộng boundary.

### 7.2 PLATFORM/OWNER REQUEST — chặn Tier 2 (tôi không tự sửa `src` lane khác)

- **PR-Q3-02 → owner `packages/worker-sdk`.** `createArtifactFacade().read`
  (`packages/worker-sdk/src/task-context.ts:360-372`) gọi **global `fetch`**, `Buffer.from(await
  res.arrayBuffer())` **unbounded**, không `signal`/timeout/redirect policy. Đề nghị chuyển sang
  `downloadArtifact` (cùng package, đã có cap giữa dòng + verify hash + xoá file hỏng) hoặc tối thiểu nhận
  `fetcher` + `signal`. **Vì sao bắt buộc với harness**: FR24-10 đòi đo "qua actual business facade, không chỉ
  standalone helper"; không có seam thì mọi test facade chỉ đo helper, và test facade thật **bị cấm viết bằng
  shim global fetch** (bài học R24-02/FIX-CR-13).
- **PR-Q3-03 → owner `services/connector`.** DNS rebinding `services/connector/src/adapters/transport.ts`:
  `:95` duyệt bằng `lookup(...,{all:true})`, `:39` fetch **tự resolve lại** → hai lần phân giải độc lập.
  Đề nghị pin địa chỉ đã duyệt vào connection (undici `Agent({ connect: { lookup } })`) và **để lộ cái seam
  đó** cho test. Harness đo pinning bằng cách assert lookup-function trả đúng address đã duyệt, **không** cần
  mạng thật.
- **PR-Q3-04 → owner platform/webhooks.** `WebhookDispatcherOptions.fetchFn`
  (`services/orchestrator/src/modules/webhooks/webhooks.ts:126`) có kiểu
  `(url, init) => Promise<{ status }>` — **mất Response body và không nhận `signal`**. Qua seam này **không thể
  đo** ba điều FIX-CR-02 yêu cầu: cancel/release body, deadline giải phóng DB claim (`:163-196` đang giữ
  `FOR UPDATE SKIP LOCKED` trong `db.tx`), và redirect (`:156` không đặt option → undici default `follow`, tức
  một 3xx đưa POST về loopback). Fix CR-02 buộc phải nới kiểu này; harness chờ hình mới.
- **PR-Q3-05 → owner contracts/platform.** Chốt nơi đặt **canonical IP/DNS policy** (module mới hay
  `packages/contracts`). Hiện trạng đã kiểm chéo (Δ, `reports/qwen3.md` §10): connector có policy cục bộ
  (`transport.ts:79-110`) + **hai bảng vector đã tồn tại** nhưng đều gọi `validateProviderUrl` của connector
  (`services/connector/tests/reliability-security.test.ts:66-69` OFFLINE,
  `tests/integration/p8-04-security-isolation.integration.test.ts:472-527` LIVE); **orchestrator/webhook không có
  một case nào**, và **không có vector IPv6-canonical nào** ở đâu cả (`::ffff:7f00:1`, `0:0:0:0:0:0:0:1`, `::`,
  6to4/NAT64/Teredo, multicast, `100.64/10`). Đề nghị vì thế **hấp thụ hai bảng có sẵn** vào một bảng chung, không
  viết mới từ đầu. Nếu quyết định chỗ-đặt-module chậm, `policy-vectors.ts` của harness vẫn là hợp đồng executable
  — nguồn refactor sau, không chặn nhau.
- **PR-Q3-06 → owner test-infrastructure.** `tests/stubs/provider/mock-provider.ts` (`MockProviderServer :41`) đã
  có sẵn knob cần cho harness R1-C: `simulateResponseLost:22` (→ `req.socket.destroy()` `:152`), `delayMs:24`,
  `rateLimit:26`, `inFlightCount:71`, và **buộc destroy mọi socket ở `stop()` `:117-129`** (để jest không leaked
  handle). **Nhưng** nó chỉ nằm trong `testMatch` của `tests/isolation` và **không import được từ suite package nào**
  (không có package name). Đề nghị: **chuyển thành workspace package** (vd `@du/test-stubs`) để `services/*/tests` và
  `packages/*/tests` dùng chung — harness R1-C sẽ **mở rộng** nó thay vì viết listener mới. Cần bổ ba hành vi chưa
  có: `chunked-no-content-length`, **3xx thật** (repo chưa từng gửi 3xx từ listener), bộ đếm byte mỗi listener.

### 7.2b OWNER REQUEST — quy chế, không cần DB window

- **OR-Q3-03 → owner `docs/28-test-inventory.md`.** `docs/28-test-inventory.md` là sổ OFFLINE/LIVE chính thức.
  Mọi suite harness R1-C mới phải được ghi vào sổ đó khi nộp (kèm nhãn `[LOCK]`/`[OPEN:row]`). Lý do: trôi
  inventory chính là thứ sổ 28 sinh ra để bắt, và `pnpm test` trong `services/orchestrator` **không offline-safe**
  (suite live nối `postgres://du:du-test-only@localhost:5433/du_orchestrator_test`, **không env gate** — khác
  khuôn `CONNECTOR_INTEGRATION=1` của connector), nên một suite lạ lọt vào `roots` của nó sẽ làm hỏng mọi lệnh
  `pnpm test` của lane khác.
- **OR-Q3-04 → coordinator/packet owner.** Packet R1-C ghi "safe error schema **RFC 7807**", nhưng repo cài đặt
  **RFC 9457**: `packages/contracts/src/errors.ts:4` dẫn 9457, `problem()` `:106-114` dựng
  `{type:'urn:du:error:<code>',title,status,code,detail,correlationId,errors?[{pointer,message}]}`,
  spec ở `docs/06-public-api.md:72`; chuỗi "7807" không tồn tại trong repo. Đây là **rủi ro test fail giả** (7807
  có `instance`, không có `code`/`correlationId`/`errors[].pointer`), không phải lỗi chữ nghĩa. Đề nghị sửa packet
  thành "RFC 9457 profile của `@du/contracts`". Harness sẽ assert theo hình của repo.

### 7.3 QUAN SÁT FLEET → coordinator: **OF-Q3-01** — 740 file nguồn untracked

`git status --porcelain -- du-rework/services du-rework/packages | find /c "??"` = **740**, trong đó có
`webhooks.ts`, `packages/worker-sdk/src/artifact-streams.ts`, `packages/connector-client/src/transport.ts`
(tức **3 trong 4 file trung tâm của R1-C**) và cả `coordination/reports/qwen3.md` của lane này. Hệ quả: yêu cầu
"source hashes" trong `tasks/REVIEW-FIXES-2026-09-23.md` (Definition of done) **không thoả được bằng git** —
không blob, không diff, không revert. Line-number của finding 09-23 đã trôi thật: CR-08 dẫn
`artifact-streams.ts:438-456` trong khi mã nay ở `:535-555`. Đề nghị: (i) mỗi receipt ghi **SHA-256 byte của
file nguồn mà suite nạp** (harness R1-C đã thiết kế để làm vậy — `reports/qwen3.md` §2 và §7); (ii) cân nhắc
một commit checkpoint cho `du-rework/` **trước khi** R1-C chạm nguồn. Quyền quyết thuộc user/coordinator — tôi
**không tự commit**.

### 7.4 QUAN SÁT FLEET → coordinator: **OF-Q3-02** — kết quả khảo sát bởi subagent phải kiểm lại

Bản inventory hạ tầng test mà lane nhận từ một explorer khác nêu **8 ký hiệu không tồn tại**:
`packages/contracts/src/redirect-policy.ts`, `resolveRedirectPolicy` (0 match toàn du-rework),
`services/orchestrator/tests/network-policy.ts`, `BLOCKED_IP_VECTORS`, `url-guard-contract.test.ts`,
`services/connector/tests/url-guard.ts`, `openFreePort`, `shouldBlockHost`, `isPrivateOrLoopback`.
Nếu chép nguyên, kế hoạch sẽ để lại một việc **không tồn tại** ("mở rộng bảng vector có sẵn") và kẻ sau sẽ đi
tìm file đó mãi. Việc thật ngược lại: **bảng vector chưa có, phải tạo mới**. Đề nghị quy chế: mọi
file:line/ký hiệu từ output explorer phải được grep-confirm trước khi vào packet hoặc plan. Khuôn **có thật**
mà tôi đã confirm và dùng: listener `server.listen(0,'127.0.0.1',cb)` tại
`services/connector/tests/runtime-foundations.test.ts:92`,
`packages/connector-client/tests/real-service.test.ts:22`,
`services/orchestrator/tests/usage-summary.test.ts:143`.

### 7.5 W49-Q3-3 — harness NỘP XONG (BR-Q3-01 đã cấp), còn 2 REQUEST nguồn + 1 cập nhật sổ

**TRẠNG THÁI:** 14 file mới (kit `tests/harness/network-boundaries/` ×10 + 4 suite `*.boundary.test.ts`),
nghiệm thu `node tests/harness/network-boundaries/verify-r1c.cjs` → **70 case = 37 LOCK xanh / 33 OPEN đỏ chủ
đích** (literal trong `reports/qwen3.md` §4b). Không DB/Redis/DNS. `task-context.ts` đổi digest giữa chu kỳ
là churn của lane worker-sdk, không quy harness.

- **PR-Q3-07 → owner `services/orchestrator`:** `createApp` (src/server.ts:122-123 — `createDb` +
  `new IORedis` eager, không seam) buộc twin ADM-BASE-03 phải dựng bằng `jest.mock('pg')` scripted Pool —
  chạy được, offline, đã nộp trong `tests/webhook-error-boundaries.boundary.test.ts` (stretch block), nhưng là
  khuôn MONG MANH: mọi đổi shape query ở boot sẽ làm nó đỏ sai. Đề nghị `ServerConfig` nhận `db?: DbLike` /
  `redis?: RedisLike`; twin đổi sang seam thật. Không gấp bằng PR-Q3-02/03.
- **PR-Q3-08 → owner `packages/worker-sdk`:** `src/task-context.ts:399` (nhánh `write` của facade) có object
  literal `{ sha256, sizeBytes, taskId }` thừa `taskId` → **TS2353**, làm chết cả suite đang xanh
  `tests/artifact-streams.test.ts` khi import qua `../src` ("Test suite failed to run", 0 tests). Hàng đợi
  FIX-CR-08/FR24-10 không đo được cho tới khi hết lỗi type. Boundary-suite của tôi đi vòng direct-import
  (`../src/artifact-streams`, `../src/fan-out`) — sửa xong thì khỏi gỡ vòng.
- **OR-Q3-03 (thực thi hộ — tôi không sửa `docs/28`, ngoài grant):** ghi 4 dòng OFFLINE, copy nguyên:
  - `services/connector/tests/network-boundaries.boundary.test.ts` — OFFLINE · 35c/13 OPEN-expected · FIX-CR-01/08, WR24-05
  - `services/orchestrator/tests/webhook-error-boundaries.boundary.test.ts` — OFFLINE (jest.mock('pg')) · 22c/15 OPEN · FIX-CR-01/02, ADM-BASE-03
  - `packages/connector-client/tests/network-boundaries.boundary.test.ts` — OFFLINE · 7c/3 OPEN · FIX-CR-08, WR24-06, ADM-BASE-03
  - `packages/worker-sdk/tests/network-boundaries.boundary.test.ts` — OFFLINE · 6c/2 OPEN · FIX-CR-08, ADM-BASE-03

  **Lý do ghi NGAY:** cả 4 nằm trong `roots` của package — `pnpm test` của 4 package đó ĐỎ từ giờ tới khi fix
  landing (33 OPEN chạy mặc định theo thiết kế §6.1.6). Ai chạy `pnpm test` mà không đọc sổ 28 sẽ quy nhầm đỏ
  cho lane khác — đúng bệnh mà OR-Q3-02/§6.1.6 sinh ra để chống.
### 7.6 W49-Q3-4 — TURN 2 SOURCE FIXES LANDED (matrix 70/70 exit 0)

Cập nhật hàng đợi từ §7.5:
- **PR-Q3-08 ĐÃ ĐƯỢC GIẢI trước khi tôi đi vòng** — lane worker-sdk sửa task-context.ts lúc 04:33;
  artifact-streams.test.ts giờ 139/139. Rút, cảm ơn lane.
- **PR-Q3-07 vẫn mở** (twin jest.mock(pg) xanh nhưng là khuôn mong manh — seam inject vẫn đáng làm).
- **PR-Q3-03 vẫn mở và giờ là lớp cuối của SSRF**: adjudication đã chạy lúc submit (schema) + lúc
  dispatch (webhooks/transport), NHƯNG connect vẫn tự resolve lại sau adjudication → owner connector
  quyết undici Agent connect-lookup hoặc chấp nhận residual window.
- **PR-Q3-04 một phần**: webhook fetchFn.init nay có signal? — injected impl muốn honoring abort cần
  contract test riêng; production path đã timeout-bounded (10s).
- **MỚI RR-Q3-3 → owner testing lane (Agent-6)**: hai lượt live trên source mới —
  (1) tests/integration/p8-04-security-isolation (LIVE twin của bảng vector — policy giờ ở contracts,
  p8-04 phải vẫn xanh; nếu đỏ là pattern-regression thật, ping tôi trước khi sửa);
  (2) businesses/document-core multi-container e2e (dist đã rebuild — callback loopback nếu có phải qua
  allowHosts; KHÔNG bật allowPrivateNetworks ở e2e). Kèm: pnpm test trong services/connector đang giữ
  một đỏ CÓ TRƯỚC ở p8-03-convergence (hàng R1-D, ghi nhận ở baseline của tôi — khỏi quy nhầm).
- **MỚI OR-Q3-05 → owner orchestrator packaging**: jest của orchestrator resolve @du/contracts qua
  **dist** (không moduleNameMapper) — mọi sửa contracts/src phải kèm rebuild dist; incident TS2741
  phantom (04:16 build của tôi vs 04:33 sửa lùi của R1-A) mô tả đầy đủ ở reports/qwen3.md §W49-Q3-4.3.

### 7.7 W49-Q3-5 — cycle 84 DONE: PR-Q3-03 ĐÓNG, FIX-CR-02 nửa-claim DONE

- **PR-Q3-03 → ĐÓNG**: pinned egress landing tại services/connector/src/adapters/pinned-fetch.ts
  (Node-core vì undici không có trong workspace; SNI + cert-verify giữ nguyên trên hostname gốc;
  A-red-5 chứng minh deny-at-connect với listener 0-request; gzip/deflate/br unwrap → cap trên decoded).
  Boundary suite giờ có 3 case pinning của tôi + 2 của lane khác — tất cả xanh.
- **PR-Q3-09 MỚI → platform**: default-fetch của webhook dispatcher (orchestrator) vẫn là global fetch →
  đích dạng TÊN còn double-resolution window ở egress webhook (connector đã pin). ĐỪNG copy
  pinned-fetch thành bản thứ hai — cần quyết định package dùng chung.
- **RR-Q3-3 (nhắc, ưu tiên tăng)**: live re-verify p8-04 + multi-container e2e + runtime.test trên
  webhooks 3-pha (claim DISPATCHING / lease 60s / guarded release). Trạng thái tại-điểm-dừng không đổi
  theo thiết kế, nhưng chỉ LIVE mới chứng minh lease thật của PG.
- Ghi chú fleet: hai phantom incidents turn này (contracts/dist stale, server.ts mid-save TS2552) đều
  TỰ HẾT khi lane kia lưu xong — kiểm mtime dist-vs-src và retry 1 nhịp trước khi quy kết.

### 7.8 W49-Q3-6 — cycle 88: PR-Q3-09 ĐÓNG (package @du/egress); RR-Q3-3 MỞ RỘNG

- **PR-Q3-09 ĐÓNG**: kién trúc package dùng chung đã landing — `packages/egress` là home duy nhất của
  pinned-fetch; connector import trực tiếp (giữ shim cho tests cũ của lane khác), orchestrator webhook
  dispatcher pin qua resolveCache MỘT-lần-resolve-mỗi-host-mỗi-sweep. Không còn khả năng drift.
- **NEW-QUY-CHẾ CHO CẢ FLEET (nhỏ)**: mọi consumer của `@du/egress` đọc qua DIST — sửa
  `packages/egress/src` phải `pnpm --dir packages/egress run build` trước khi chạy suite consumer
  (đã ghi pitfall 6 README kit; incident ETIMEDOUT-cycle-88 la ví dụ ngược: dist đúng nhưng options
  sai — pitfall 5: `rejectUnauthorized` KHÔNG BAO GIỜ truyen vao `http.request`, chỉ https).
- **RR-Q3-3 (Agent-6, ưu tiên cao — mở từ cycle 84, mở rộng cycle 88)**: live re-verify
  `tests/integration/p8-04-security-isolation` + `businesses/document-core` multi-container +
  `services/orchestrator/tests/runtime.test.ts` trên webhooks 3-pha (claim/lease/guarded release,
  cycle 84) VÀ pinned dispatch (cycle 88). Seam `resolve`/`lookupFn`/`fetchFn` sẵn cho live-test
  không-cần-mock; `allowHosts` literal cho loopback callbacks, KHÔNG bật `allowPrivateNetworks` ở e2e.
- OF-Q3-01 nhắc lại lần 3: `packages/egress` TOÀN BỘ untracked; `webhooks.ts`/`transport.ts`/
  `pinned-fetch.ts` cũng vậy — thiếu blob để revert/diff trong khi 3 file này vừa mang security fix.
  Đề nghị coordinator decision commit checkpoint TRƯỚC lane-window kế tiếp. Tôi không tự commit.

### 7.9 W49-Q3-7 — cycle 95 DONE: fence + body hardening; 1 BAO CHAY cua lane khac

- **Fence claim-generation DONE offline** (review.md finding 1): claim `RETURNING next_at` =
  generation token, release `AND next_at=$2`; test STALE-FENCE xuong dung khe ho (B van
  DISPATCHING). Nợ con lại cua row: **RR-Q3-4 → Agent-6** — LIVE 2-dispatcher tren PG that
  (claimLeaseMs≈1s, A stall → B reclaim → A release rowCount 0 → B DELIVERED). Seam san bo,
  khong can mock moi; day la bang chung cuoi cua reviewer-yeu-cau "test in real PG".
- **@du/egress body-hardening DONE** (finding 2): khong con moi duong ra nao qua globalThis.fetch;
  multipart serialize tren ket noi pinned (repo adapter chi text-fields — da kiem source),
  ReadableStream pipe, shape la REJECT fail-closed. Egress 6/6, connector 41/41, matrix 88/88.
- **BAO CHAY KHONG PHAI CUA TOI**: connector full do 6 suite vi loi bien dich `src/config.ts:17`
  vs `RedactedConnectorRevision` (revision state mo PENDING/RETIRED — R1-D/MM lane dang chay,
  mtime 07:09). Boundary tests (41/41) khong cham config nen van xanh; chu lane vui long dong
  khe ho type truoc khi window ke tiep de `pnpm test` cua moi nguoi khong do oan.
- **Kit nay ban**: boundary consumer nen chay verify-r1c TUAN TU & kiem listener-requests-hut
  = SYN-flak (pitfall 1) truoc khi mo debug — 2 lan phat hien turn nay deu la flak moi truong.
### 7.10 W49-Q3-8 — cycle 97 DONE: graceful shutdown & drain; 1 wiring nho

- **P8-04/FIX-CR-02 half DONE**: `deliverWebhooks` gio nhan `signal` + `shutdownGraceMs` —
  no-new-claims, bound drain cho in-flight, vuot grace → release PENDING + SHUTDOWN_RELEASED
  + attempts giu nguyen + fence next_at van chi phoi. 3 tests offline; matrix 91/91.
- **PR-Q3-10 → owner server.ts (lane admin)**: dispatcher loop (~server.ts:431) truyen
  `signal` tu SIGTERM handler cua app.close va drain webhooks TRUOC khi dong redis/pg pools.
  Hook da san — thieu 3 dong wiring o file cua lane khac, to khong tu them.
- **RR-Q3-3/RR-Q3-4 (Agent-6, live)**: gio NEAN gộp 1 live run cho ca 3: (i) PG-reclaim fence,
  (ii) graceful shutdown duoi PG that (2 dispatcher, abort giua sweep), (iii) p8-04/multi-container
  regression tren webhooks moi — de tranh 2 lan mo window.
- OF-Q3-01 — nhan lan 5: webhooks.ts (security+reliability-fix) van untracked.
### 7.11 W49-Q3-9 — cycle 98 DONE: PR-Q3-10 wired (server close drains webhook sweep)

- server.ts: `webhookShutdown` AbortController + single-flight timer + `webhookDrainTimeoutMs`
  + `webhookAllowPrivateNetworks` (additive, default an toan production). close() gio: ngung
  claim → drain in-flight (bound grace + slack) → moi `runtime.drain`/pools. Matrix 92/92.
- **PR-Q3-11 → owner entrypoint**: `process.on("SIGTERM"/SIGINT)` chura trong src (grep 0);
  hay goi `await app.close({ timeoutMs })` — chuoi drain da dung thu tu. To khong tu them
  signal handler vi thong diep cycle 98 chi noi wiring dispatcher, khong phai main-loop.
- **RR-Q3-3/RR-Q3-4 (Agent-6, MOT live window gop)**: live fence (2 dispatcher), live graceful
  drain (SIGTERM-gia lap abort giua sweep tren PG that), va p8-04/multi-container regression
  tren chum webhook moi — do la bang chung cuoi de FIX-CR-02 + P8-04 nhan [~].
- **BAO CHO R1-D (lan 2)**: connector repo lint do 3 loi `getActiveRevision` (repository.ts
  07:53:15 dang chay) — `pnpm test` cua services/connector se do bien dich cho toi khi lane
  dong khung repository/composition. Boundary R1-C 41/41 khong bi anh huong (khong import 2 file ay).
- OF-Q3-01 — nhan lan 6: server.ts/webhooks.ts deu dang mang security+reliability fixes untracked.
### 7.12 W49-Q3-10 — cycle 99 DONE: PR-Q3-11 ĐÓNG (bin that + shutdown contract); 1 BAO MAT-MAI cho lane admin

- **PR-Q3-11 ĐÓNG**: `src/shutdown.ts` (installGracefulShutdown: close-mot-lan, signal-thu-2
  khi dang-closing → exit(1) ngay lap tuc, budget SHUTDOWN_BUDGET_MS default 45s UNREF →
  exit(1) khi close treo — khong-bao-gio-treo-vo-han) + `src/main.ts` entrypoint that dau
  tien (DATABASE_URL required, autoMigrate FALSE — dung thu tu migrate-CLI-first),
  `start` → dist/main.js. 5 offline tests qua `process.emit` that; matrix 97/97 exit 0.
- **BAO MAT-MAI → lane admin (OPENCLAUDE/claude.md)**: luc 08:06 observability mo rong
  redactor (provider-key patterns nhu `sk-[A-Za-z0-9_-]{8,}`, URL/assignment/JWT, marker
  dinh-dang-moi `[REDACTED:<pattern>]`). Sentinel cua `admin-error-boundary.test.ts:25`
  (LIVE, shape `SENTINEL-SECRET-sk-…`) TU 08:06 BI CHINH REDACTOR CHE → assert
  `not.toContain(SENTINEL)` cua ho nay la **xanh-rong** (vacuous): ke ca khi boundary
  ro ri, sentinel cung bi che truoc khi toi tay so sanh. Kit R1-C da doi sentinel sang
  shape tuong-duong vo-hinh (`SENTINEL-DBURL-…`) + self-check [LOCK] chan tai nay; lane
  admin nen lam TUONG TU cho twin LIVE cua ho (hoac an-dinh sentinel moi vao file cua ho).
- **RR-Q3-3/4 giu + nang cap**: live window bay gio co the smoke SIGTERM that vao
  `node dist/main.js` (bin da ton tai) — them mot bang chung cuoi cho FIX-CR-02/P8-04.
- OF-Q3-01 — nhan lan 7: them main.ts/shutdown.ts untracked.
### 7.13 W49-Q3-11 — cycle 100: RR da dang ky (docs/29); admin-sync DONE; mot LOI THAT cua to da disclose

- **RR-Q3-3/4**: dang ky day du tai docs/29-run-request-queue.md (section cuoi, kem 5 buoc +
  literal ky vong + routing). Live test file: tests/webhook-reclaim-fence.live.test.ts.
- **RUT §7.12 (admin twin)**: ĐĂ ĐONG BO — sentinel moi vo hinh redactor + preflight
  chong-xanh-rong ngay trong admin-error-boundary.test.ts. Lan chay live cua RR se xac nhan.
- **Tự khai**: khi soan RR, to VO TINH chay live file dung luc PG :5433 dang UP (khong CLAIM
  window — pham le ra nen tranh; test tu don row cua no sau do; migration-pending co the da
  bi autoMigrate apply → Tester kiem migrate:status nhu RR buoc 0). Ket qua bat loi that:
  fence Date-ms vs PG-microsecond — fix ::text/::timestamptz da nam src, 97/97 offline.
  Khong xin xin-loc-nho-dung-gi; ghi de lane khac rut kinh nghiem: kiem port :5433 TRUOC khi
  try-run bat ky live file nao (Test-NetConnection 127.0.0.1 -Port 5433).
- OF-Q3-01 — nhan lan 8. PR-Q3-02/RR-Q3-4 khong doi chu.
### 7.14 W49-Q3-16 - WINDOW GUARD da dat cho live suite (orchestrator request sau Finding 4)

- webhook-reclaim-fence.live.test.ts TU-SKIP neu thieu DU_LIVE_INFRA=1, dung convention
  p8-02b/c (`LIVE = env === "1"` + `(LIVE?describe:describe.skip)`, hooks da nen vao
  trong describe de that su khong boot khi skip). Chung minh offline turn nay: chay khong
  env -> `Test Suites: 1 skipped / Tests: 2 skipped, 2 total` exit 0, khong cham :5433
  du no dang mo; lint 0 + build 0.
- docs/29 RR-Q3-3/4 buoc 2 nay la: set DU_LIVE_INFRA=1 && npx jest ... --runInBand.
- **DE NGHI lan admin (ngoai quyen sua cua to)**: admin-error-boundary.test.ts cung nen
  gat khuon DU_LIVE_INFRA nay - no van boot PG that khi ai do chay `pnpm test` ngoai window.
- Fleet-rule giu nguyen: SKIP khong tinh la PASS; 2/2 that van thu RR chinh thuc Tester-1.
### 7.15 SEC-INT-01 prep (orchestrator request) - 2 viec can quyet KHONG thuoc to

- **p8-04-security-isolation.integration.test.ts UN-GATED** (describe tran, root beforeAll
  boot that khi ai chay ca thu muc tests/integration ngoai window - to da TRANH khong sua,
  vi la file testing-lane). De nghi lac DU_LIVE_INFRA dung khuon p8-02b/sec-int-01.
- **Ten file trong packet khong ton tai** ("...cross-service-identity..."); file that la
  sec-int-01-credential-lifecycle... (276 dong, guard DAT CHUAN, 5 case wire that +
  raw-DB sink scan, typecheck 0, proof-skip khi PG dang mo: 5 skipped exit 0). Coordinator
  xac nhan yeu cau goc truoc khi to bien-dich them.
- Chay gate cho slice hien tai: cd tests/integration && set DU_LIVE_INFRA=1 &&
  set DU_SECINT=1 && npx jest sec-int-01 --runInBand -> ky vong `Tests: 5 passed, 5 total`;
  thieu mot trong hai co -> 5 skipped (khong tinh pass). DU_SECINT la ch khoa cua
  coordinator (cua so G-SEC), DU_LIVE_INFRA + window claim cua Tester-1.
- Slice KE (browser E2E/OIDC-04, 2 replicas, RBAC/CSRF/outage matrix, provider-invoke
  Redis): thuoc owner OIDC/VAULT/CON. NEU: moi sink-scan tren LOG/stdout phai dung
  sentinel vo-hinh-redactor (khuon kit R1-C + sentinelShapeViolations), vi redactor
  mo-rong 08:06 an `sk-live-...` - chi raw-DB scan nay giu duoc y nghia.
- To khong chay live, khong sua file lane khac, khong commit/push.

### 7.17 W-OIDC02-LIVE-1R (reassignment) — xong phan to + 2 red THAT dang nam chay
- (a) revoke cross-replica da co san tren tree (khong lam lai); (b) KILL+RESPAWN B da them,
  offline 3×exit 0 '7 skipped, 6 passed, 13 total'. Lenh + ky vong live cho Tester:
  `## W49-Q3-25` (reports/qwen3.md).
- **RED THAT #1 (cu)**: mock-vault-harness-offline :25 — fix MOT DONG
  `credentialSource: { kind: 'legacy-db', credentialRef: ... }`, owner = VAULT lane.
- **RED THAT #2 (MOI, giua cycle)**: connector-revision-http-offline TS2741/TS2345
  `tenantId` required tu services/connector/src/db/repository.ts (live-edit 20:33, lane dang
  land). aggregate 20:01 con PASS → RECEIPT T-ORCH-AGG-1R cua to chi VERIFIED tren tree
  20:0x, KHONG extend sang state sau 20:33. Nho VAULT lane chay lai 2 suite cua-hinh truoc
  khi ai cap-nhat receipt aggregate.
- webhook/adm-base-03 flake lai theo TIME_WAIT (~39.8k) — dung bat receipt nao dua tren
  aggregate chay luc saturation.

### 7.16 T-ORCH-AGG-1R (reassignment tu Tester-2) — ket qua + 1 chat chan CANH LAN
- Aggregate day du tren tree hien tai: 3/55 suite do, 4/1248 test do. Raw log + triage day du
  o `## W49-Q3-24` (reports/qwen3.md). Receipt da ghi.
- 2 suite loopback = red NHIEM MOI TRUONG (ETIMEDOUT/EADDRINUSE thuan connect-lop, machine
  TIME_WAIT ~39.5k do lane khac dam :5433/:6380; khang dinh Qwen-5 15:40 dung ve lop).
- 1 red THAT duy nhat: **mock-vault-harness-offline.functional.test.ts:25 TS2345** thieu
  `credentialSource` (required boi src/modules/connector-credentials/workflow.ts:52 tu drift
  VAULT-04). Day LAU CHO LANE KHAC — file khong thuoc to, packet cam sua source. Nho
  coordinator dieu huong VAULT/testing lane sua truoc khi bat ky receipt aggregate nao duoc
  cap nhat.
- Multipart (ca route part va part-grant) + contracts + worker-sdk: XANH hoan toan khi chay
  doc lap. To khong mo DB, khong commit.


