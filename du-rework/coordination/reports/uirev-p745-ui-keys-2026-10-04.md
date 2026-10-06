# UI Review Receipt: P745-UI-KEYS (Admin Web Profile Keys Wire & DTO Alignment)

- **Date:** 2026-10-04 23:15 +07
- **Reviewer:** Antigravity UI Lead (`term_ae2d7e42`)
- **Task Reference:** `P745-UI-KEYS` (`task_769a4f3d6ee1`) by `cc_2`
- **Receipt Reviewed:** `coordination/reports/p745-ui-keys-2026-10-04.md`
- **Reviewed Code & Test Artifacts:**
  - `apps/admin-web/src/lib/api/types.ts` (`ProfileDetail.apiKeyId`, `ApiKeyIdRef`, `PolicyUpsertBody`, `ProfilePublishBody`, `ProfileRollbackBody`)
  - `apps/admin-web/src/lib/api/client.ts` (`upsertProfile`, `publishProfile`, `rollbackProfile` forwarding verbatim)
  - `apps/admin-web/src/features/profiles/command-bodies.ts` (pure mapping leaf)
  - `apps/admin-web/src/features/profiles/state.ts` (`parseProfileDetail` carrying `apiKeyId`)
  - `apps/admin-web/src/features/profiles/profiles-screen.tsx` (`saveRow`, `publish`, `rollback` wiring)
  - `tests/browser/admin-web/p745-ui-keys.spec.ts` (8 real tests running under Playwright)
- **Governing Contract:** `docs/admin-ui-development-contract.md` (§1, §3, §4, §5)
- **Mode:** READ-ONLY on source/plans; write receipt only; no source edits; no commit/push.

---

## 1. Verdict & Scope Classification

### 🟢 Verdict: `UI_APPROVED` (SLICE DTO & COMMAND WIRING VERIFIED)
*Khuyến nghị phụ thuộc: Live browser button click journey giữ nguyên trạng thái GAP chờ live DB seed.*

Căn cứ theo **`docs/admin-ui-development-contract.md` §5**:
1. **Mục tiêu slice `P745-UI-KEYS`:** Đảm bảo toàn bộ 3 command `profile.upsert`, `profile.publish`, `profile.rollback` của Admin Web mang theo write identity (`apiKey: { apiKeyId }`) được bóc tách từ `GET /admin/api/profiles/:id` (T-API-01 closure), giải quyết dứt điểm điều kiện tiền đề cho W3 backend.
2. **Thực chứng độc lập:**
   - Playwright test runner thực thi trực tiếp trên `tests/browser/admin-web/p745-ui-keys.spec.ts`: **8/8 tests passed** (thời gian chạy: 506ms).
   - Typecheck package: `pnpm --filter @du/admin-web typecheck` $\rightarrow$ **Exit Code 0** (3 lần liên tiếp).
   - Production Build: `pnpm --filter @du/admin-web build` $\rightarrow$ **Exit Code 0** (2665 modules transformed, không có cảnh báo kiểu).
3. **Kết luận:** Slice DTO và command mapping của `cc_2` đạt chuẩn 100% theo các yêu cầu của UI Contract §5.

---

## 2. Đánh Giá Chi Tiết 4 Tiêu Chí Bắt Buộc Của UI Contract §5

### 2.1. DTO Shapes (Chuẩn hóa cấu trúc Wire)
* **Đối chiếu backend:** Backend tại W3 (`profile-actions.ts`) yêu cầu cấu trúc `ProfileCommandKeyShape`:
  ```typescript
  {
    apiKey?: {
      apiKeyId: string;
    }
  }
  ```
* **Triển khai tại `apps/admin-web/src/lib/api/types.ts`:**
  - `ProfileDetail` bổ sung `apiKeyId?: string` (phản ánh trung thực id khóa từ detail read).
  - Định nghĩa interface `ApiKeyIdRef { apiKeyId: string }`.
  - Cả 3 interface mutation body đều tuân thủ chính xác:
    - `PolicyUpsertBody`: `{ expectedRevision?: number; policy: Record<string, unknown>; apiKey?: ApiKeyIdRef }`
    - `ProfilePublishBody`: `{ expectedRevision: number; apiKey?: ApiKeyIdRef }`
    - `ProfileRollbackBody`: `{ targetRevision: number; expectedRevision?: number; apiKey?: ApiKeyIdRef }`
* **Đánh giá:** **ĐẠT (PASS)** — Cấu trúc dữ liệu ăn khớp hoàn toàn với schema backend mà không làm phá vỡ các trường tùy chọn khác.

---

### 2.2. Absence Fail-Closed (Trung thực và An toàn khi thiếu Key)
* **Logic tại `command-bodies.ts` (`apiKeyRefFromDetail`):**
  ```typescript
  export function apiKeyRefFromDetail(
    detail: Pick<ProfileDetail, 'apiKeyId'> | null | undefined
  ): ApiKeyIdRef | undefined {
    const id = detail?.apiKeyId;
    return typeof id === 'string' && id.length > 0 ? { apiKeyId: id } : undefined;
  }
  ```
* **Hành vi khi thiếu `apiKeyId`:**
  - Nếu `detail` không có `apiKeyId` (ví dụ: màn hình tạo mới `/new`, profile chưa lưu hoặc ID là chuỗi rỗng `""`), hàm trả về `undefined`.
  - Khi đó, các builder (`buildUpsertBody`, `buildPublishBody`, `buildRollbackBody`) **hoàn toàn không chèn trường `apiKey` vào JSON payload** gửi lên server.
  - Test case số 5 trong `p745-ui-keys.spec.ts` khẳng định: `'apiKey' in upsert === false`.
* **Hệ quả an toàn:** Backend dispatcher sẽ từ chối ngay lập tức với mã lỗi `422 INVALID_SCHEMA` thay vì tự suy đoán hoặc ghi đè nhầm vào một profile khác.
* **Đánh giá:** **XUẤT SẮC (EXCELLENT)** — Tuân thủ nguyên tắc fail-closed, không bao giờ ngụy tạo dữ liệu giả trong frontend.

---

### 2.3. Parity Rollback (`expectedRevision` Vô Điều Kiện)
* **Bối cảnh:** Trong các hệ thống phân tán, rollback cần bảo toàn tính đồng thời CAS (Compare-And-Swap) để ngăn chặn trường hợp hai người vận hành cùng rollback/publish đè lên nhau.
* **Triển khai tại `command-bodies.ts` (`buildRollbackBody`):**
  ```typescript
  export function buildRollbackBody(
    detail: ProfileDetail,
    targetRevision: number
  ): ProfileRollbackBody {
    const apiKey = apiKeyRefFromDetail(detail);
    return {
      targetRevision,
      expectedRevision: detail.revision,
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
  }
  ```
* **Kiểm tra parity:**
  - `expectedRevision` luôn được truyền với giá trị `detail.revision` hiện tại trên màn hình, kể cả khi `revision === 0` (chưa lưu).
  - Test case số 4 đã chứng minh trường hợp `revision: 0` vẫn gửi `expectedRevision: 0`.
  - Nếu dữ liệu trên view của operator bị cũ (stale), server sẽ ném lỗi `409 CONFLICT` thay vì âm thầm dịch chuyển pointer.
* **Đánh giá:** **ĐẠT (PASS)** — Giữ vững trọn vẹn cơ chế bảo vệ concurrency CAS.

---

### 2.4. Không Thay Đổi Giao Diện Trực Quan (Zero Visual Drift)
* **Rà soát mã nguồn `apps/admin-web/src/features/profiles/profiles-screen.tsx`:**
  - Các thay đổi chỉ tập trung vào việc thay thế inline payload bằng việc gọi các builder functions:
    - Line 171: `buildUpsertBody(detail, buildPolicy(row))`
    - Line 243: `buildPublishBody(detail)`
    - Line 266: `buildRollbackBody(detail, target)`
  - Không thay đổi bất kỳ thẻ JSX nào, không thêm/bớt CSS class, không đổi cấu trúc DOM, không đổi style/spacing hay tokens.
  - Toàn bộ trải nghiệm người dùng, bảng điều khiển, trạng thái nút bấm, thông báo toast vẫn giữ nguyên 100%.
* **Đánh giá:** **ĐẠT (PASS)** — Tách biệt hoàn hảo giữa logic nghiệp vụ (pure leaf) và presentation layer.

---

## 3. Rà Soát Thực Chứng & Tình Trạng GAP

### 3.1. Bằng chứng Đã Được Xác Minh (Verified Evidence)
1. **Kiểm thử Playwright CJS-safe:**
   `npx playwright test --config admin-web/playwright.config.ts admin-web/p745-ui-keys.spec.ts`
   - Test 1: `apiKeyRefFromDetail` bóc tách đúng ID và loại bỏ ID rỗng.
   - Test 2: `buildUpsertBody` tạo đúng CAS revision + policy + apiKey.
   - Test 3: `buildPublishBody` tạo đúng expectedRevision + apiKey.
   - Test 4: `buildRollbackBody` tạo đúng target + unconditional expectedRevision + apiKey.
   - Test 5: Honest absence không sinh ra trường `apiKey` khi thiếu `apiKeyId`.
   - Test 6: `parseProfileDetail` truyền `apiKeyId` trung thực từ wire API.
   - Test 7: Static guard đảm bảo `profiles-screen.tsx` gọi qua builder functions.
   - Test 8: Static guard đảm bảo `client.ts` forward body nguyên vẹn.
2. **Kiểm tra TypeScript strict:** Không có lỗi type, không dùng `any`, tuân thủ path alias `@/`.

### 3.2. Ranh giới GAP (Honest Boundary Disclosure)
- **Stub-browser Journey:** Kiểm thử tự động trên trình duyệt thật với tài khoản live (`AWEB01B_URL/TOKEN/STUB/VIEWER`) chưa thực hiện vì database môi trường test chưa có profile seed thật.
- **Ranh giới:** Khoảng trống này hoàn toàn minh bạch và thuộc phạm vi nghiệm thu Live End-to-End (`VFY-LOCAL / LIVE-READY`), không cản trở việc cấp verdict `UI_APPROVED` cho slice DTO & command wiring offline này.

---

## 4. Phát Hiện Phụ Cần Lưu Ý (Observation)

* `cc_2` đã phát hiện file `tests/browser/admin-web/p730-curl-import.spec.ts` của `qwen_5` sử dụng cú pháp `import.meta.url`, gây lỗi `SyntaxError: Cannot use 'import.meta' outside a module` khi chạy Playwright do config hiện tại transpile dạng CommonJS (CJS).
* `p745-ui-keys.spec.ts` đã khắc phục thành công bằng cách sử dụng `__dirname` và `join`.
* **Khuyến nghị cho Coordinator:** Yêu cầu `qwen_5` cập nhật `p730-curl-import.spec.ts` sang sử dụng `__dirname` tương tự để toàn bộ thư mục test Playwright của `admin-web` có thể chạy trơn tru cùng lúc mà không bị crash.

---

## 5. Kết Luận

Gói **`P745-UI-KEYS`** do `cc_2` triển khai đáp ứng xuất sắc các quy định tại UI Development Contract §5. Antigravity chính thức cấp verdict **`UI_APPROVED`** cho slice này, sẵn sàng phục vụ cho các luồng mutation Profile hoàn chỉnh của Admin Web.
