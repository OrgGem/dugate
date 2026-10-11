# Verify độc lập (DSH2) — Contracts alignment FOLLOW-UP — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `packages/contracts/**` (đọc) và `services/orchestrator/tests/operations-list-contract-conformance.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck **offline**; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0.
**Raw:** `coordination/reports/raw/verify-contracts-followup-2026-10-10/DSH2/` — `01-conformance.log`, `02-repeat-and-ops.log`, `03-dsh2-probe.log`, `04-contracts-full-followup.log`, `05-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Nối tiếp:** `verify-contracts-alignment-INDEPENDENT-DSH2-2026-10-10.md` (lượt trước ghi nhận conformance **2 failed/19**). Receipt conformance riêng: `verify-orchestrator-operations-conformance-INDEPENDENT-DSH2-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| **Điểm đỏ conformance theo sau lượt trước** | **ĐÃ HẾT** — file `3d056544…` (mtime 22:57:02) cho `19 passed, 19 total` exit 0, 3 lần chạy; 2 test cũ (`the contract declares six parameters` → `eight parameters`; `every contract parameter is actually wired into the parser`) đều **√ pass** |
| Diff của bản sửa | `+8/−1`, không xoá/skip assertion; fixture `from`/`to` là **bắt buộc** bởi bất biến dẫn-xuất-từ-contract trong chính test |
| Drift sweep toàn workspace | **SẠCH** — 0 hit cho mảng 6 tham số cũ / `six parameters` (trừ `node_modules`/`dist`) |
| Suite contracts trên revision hiện tại | **30/30 suite · 570/570 test · 0 snapshot · exit 0** (30 dòng `PASS`, 0 `FAIL`) |
| **Kiểm độc lập các phần còn lại của contracts** | **15/15 probe PASS** trên 6 module: `ip-policy`, `errors`, `hashing`, `profile-callback`, `queue`, `version` + route parser |
| Batch ops liên quan | `or10-operations-time-filter` + `admin-operations-sql` + `operations-list-cursor-binding` = **101/101**, exit 0 |

**Một dòng cho coordinator:** follow-up **đạt** — điểm đỏ conformance đã được lane khác đóng đúng cách (không nới assertion), contracts vẫn 30/30 & 570/570, và phần còn lại của contracts chịu được probe độc lập 15/15; ba ghi chú thiết kế đáng biết: `STATUS_CODES` khoá theo **tên HTTP**, 4 mã **cố ý** nằm ở hai boundary, và hash có tiền tố `sha256:`.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `jest … --runTestsByPath tests/operations-list-contract-conformance.test.ts` × 2 (`services/orchestrator`) | **0/0** | `Test Suites: 1 passed` · `Tests: 19 passed, 19 total` |
| 2 | batch `or10-operations-time-filter` + `admin-operations-sql` + `operations-list-cursor-sort-binding` | **0** | `Test Suites: 3 passed` · `Tests: 101 passed, 101 total` |
| 3 | `node node_modules/jest/bin/jest.js --runInBand` (`packages/contracts`) | **0** | `Test Suites: 30 passed, 30 total` · `Tests: 570 passed, 570 total` · `Snapshots: 0 total` · 30 `PASS` / 0 `FAIL` |
| 4 | probe độc lập DSH2 (`05-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 15/15 checks passed` |

Artifact đã kiểm:

| File | sha256 (24 ký tự đầu) | mtime | lines | git |
|---|---|---|---|---|
| `services/orchestrator/tests/operations-list-contract-conformance.test.ts` | `3d056544e87bf9bd75e9794d` | 22:57:02 | 374 | ` M` |
| `services/orchestrator/src/modules/operations/list-query.ts` | `9aff3229df547d8e53cce1f0` | 21:06:10 | 654 | ` M` |
| `packages/contracts/tests/operations-list-contract.test.ts` | `74b9babe7e1fe234de5f906b` | 22:41:38 | 237 | ` M` |
| `packages/contracts/src/{errors,hashing,ip-policy,profile-callback,queue,version}.ts` | `1c0bc03e…` / `ae1b2413…` / `b5a78afb…` / `0373f3e8…` / `eb90c54b…` / `c89bd00a…` | 10-07 04:30:17 | 120/95/279/462/57/38 | **sạch** |

---

## 2. Điểm đỏ conformance: trước → sau

| | Trước (lượt verify trước, 22:54) | Sau (lượt này) |
|---|---|---|
| Revision | `7dfc97e6…` (mtime 10-07, sạch) | `3d056544…` (mtime 22:57:02, ` M`) |
| Kết quả | `2 failed, 17 passed, 19 total`, exit 1 | `19 passed, 19 total`, exit 0 (×3) |
| Test đỏ | `the contract declares six parameters`; `every contract parameter is actually wired into the parser` | cả hai **pass** (test đầu đã đổi tên thành `eight parameters`) |
| Thay đổi | — | `+8/−1`: đổi nhãn, thêm `'from','to'` vào tập kỳ vọng, thêm fixture `from=2026-10-10` / `to=2026-10-10` |

Kiểm 'không nới lỏng': `git diff --numstat` = `+8/−1` (dòng `−1` chính là câu nhãn); **0** `.skip/.only/xit/xdescribe/todo(`; 19 test trước và sau. Bất biến `Object.keys(rejecting).sort() === declared.filter(n => n !== 'limit').sort()` buộc mọi tham số đã khai phải có fixture từ chối ⇒ thêm `from`/`to` là **điều kiện để test xanh**, không phải trang trí.

**Drift sweep:** quét toàn `du-rework` (trừ `node_modules`, `dist`) cho `'limit','cursor','state','tenant','id','sort'` (mảng 6 cũ) và `six parameters`/`declares six`/`six supported parameters` → **0 hit**.

---

## 3. Kiểm độc lập phần còn lại của `packages/contracts` (probe 15/15)

Probe nạp **source TS** của contracts (không dùng `dist`, không dùng test của tác giả):

### 3.1 `ip-policy` (bảo mật destination)
- **M1**: 14 dạng bị chặn đều `isDestinationAddressAllowed === false` và `isPubliclyRoutableAddress === false` — `10/172.16/192.168/127/169.254.169.254/100.64/224/0.0.0.0/::1/fc00::1/fe80::1/::ffff:10.0.0.1` (v4-in-v6) `/2002:0a00:0001::1` (6to4) `/64:ff9b::a00:1` (NAT64).
- **M2**: 3 dạng công khai (`93.184.216.34`, `8.8.8.8`, một IPv6 công khai) vẫn **được phép** ⇒ chính sách không phải 'chặn tất'.
- **M3**: `ftp://` deny, `userinfo` deny, literal private deny, `[::ffff:127.0.0.1]` deny, literal public ALLOWED, hostname → `NEEDS_RESOLUTION`, chuỗi rác → DENIED.
- **M4**: opt-in **hẹp** — `allowHosts` mở đúng một literal; `allowPrivateNetworks` mở RFC1918 **nhưng vẫn chặn** metadata `169.254.169.254`, CGNAT `100.64.0.1`, multicast `224.0.0.1`.

### 3.2 `errors` (taxonomy)
- **M5**: `STATUS_CODES` được khoá theo **tên HTTP-status** (`NOT_AUTHENTICATED:401 … TIMEOUT:504`, 12 mục), **không** theo mã lỗi — `INVALID_SCHEMA`/`STATE_CONFLICT` **không có** entry, đúng thiết kế: map code→status nằm ở tầng service (`src/http/errors.ts`). *(Lượt đầu tôi kỳ vọng sai chỗ này.)*
- **M6**: mỗi danh sách **không trùng nội bộ**; 42 entry / 38 unique, **4 mã cố ý** nằm ở hai boundary: `INPUT_HASH_MISMATCH` (runtime+connector), `INVALID_SCHEMA` (public+runtime), `PROVIDER_UNAVAILABLE` (public+connector), `STATE_CONFLICT` (public+runtime).
- **M7**: `problem(status, code, title, detail?, opts?)` tạo `type: urn:du:error:<code lowercase>`, `ProblemSchema` validate cả bản đầy đủ và bản tối thiểu; `correlationId` quá ngắn bị từ chối (regex 8–128).

### 3.3 `hashing`
- **M8**: `contentHash` trả `sha256:<64 hex>`, ổn định, **không** phụ thuộc thứ tự key object, **có** phụ thuộc thứ tự phần tử mảng.
- **M9**: `hashInvocationInput` phủ **đúng 10 trường đã khai** (đổi từng trường đều đổi hash), **bỏ qua** trường không khai (thêm `action`/`businessId` không đổi hash — đúng thiết kế vì danh tính invocation nằm ở `stepKey`/`bindingSlot`), `options` mặc định `{}`; `normalizeRouteAction(businessId, action, alias?)` chỉ **fold alias**, không fold hoa/thường.

### 3.4 `profile-callback`
- **M10**: callback mang credential **bắt buộc** có origin đã duyệt chính xác; list rỗng → DENY; `http://` **không bao giờ** được mang credential; `allowedPathPrefixes` chặn path ngoài; destination private bị DENY **kể cả** khi `auth.method = 'none'`; hằng số `CALLBACK_REDIRECTS_ALLOWED = false`.
- **M11**: 15 header reserved, nhận diện **không phân biệt hoa/thường** (`HOST`, `content-length`, `x-du-signature`), header thường thì không.

### 3.5 `queue`
- **M12**: `businessQueueName('doc-core','1.2.0') = du-business-doc-core-1.2.0` khớp `QUEUE_NAME_REGEX`; tên sai (chữ hoa/gạch dưới, thiếu patch version) bị từ chối.
- **M13**: `jobIdForDelivery` tất định và **fold `:` → `-`** (`task:retry:2` → `du-task-retry-2`, vì BullMQ từ chối `:` trong jobId); `BusinessJobV1Schema` **strict**: nhận payload đủ trường, **từ chối** key lạ (`rawBytes`) và **từ chối** khi thiếu `kind`.

### 3.6 `version` + route parser
- **M14**: `WIRE_CONTRACT_VERSION = '1'`, `SUPPORTED_WIRE_MAJORS = [1]`, `JSON_SCHEMA_DIALECT` = draft 2020-12, 4 `SCHEMA_LIMITS` đều là số dương, 4 `RETENTION_DEFAULTS` là số.
- **M15**: route parser (`list-query.ts`) đọc **8/8** tham số đã khai — 7 fixture từ chối đều throw, bound hợp lệ round-trip, range đảo 422, tham số lạ bị bỏ qua; predicate SQL `created_at >= / <=` có thật ở `:410-411`.

**Ghi chú trung thực:** lượt probe đầu có **5 FAIL**, tất cả là **kỳ vọng sai của tôi** (khoá của `STATUS_CODES`; trùng mã liên-boundary là cố ý; chữ ký `problem()`; tiền tố `sha256:`; tập trường của `hashInvocationInput`) cộng 1 fixture `BusinessJobV1` thiếu trường. Đã sửa **probe** (không sửa sản phẩm) và chạy lại **15/15**.

---

## 4. GAP / open items

1. **Không có bằng chứng live/HTTP** trong lượt này (offline only) — route `from`/`to` đã được kiểm ở tầng parse/SQL và qua suite riêng, chưa qua HTTP thật với DB.
2. **Ba file đang ` M`** (`conformance.test.ts`, `list-query.ts`, `operations-list-contract.test.ts`) ⇒ kết luận gắn revision đã ghi; lane khác sửa tiếp thì phải chạy lại.
3. **`docs/28` / `docs/35`** có thể cần cập nhật trạng thái conformance 19/19 và contracts 570/570 — ngoài lease, chỉ ghi nhận.
4. **Độ phủ wiring `from`/`to`** ở tầng conformance hiện là 1 fixture date-only/tham số; muốn chắc hơn nên thêm case bound hợp lệ + range đảo (đã có ở suite route riêng `or10-operations-time-filter`).
5. **`dist/` của contracts là artifact ignored** — probe của tôi cố ý nạp `src` để tránh dist cũ; lượt trước đã xác nhận dist đồng bộ với src tại thời điểm đó.

---

## 5. Xác nhận

- Chỉ **đọc** + chạy jest/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-contracts-followup-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`); probe chạy trong `%TEMP%`, không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
