# Receipt — P2 ADMIN CONTROL PLANE & PROFILES UI (Rate Limit & Concurrency)

## 0. Final confirmation (chốt gói — 2026-10-07T01:48+07:00)

- **Deliverables đủ 4/4 mục packet:** (1) route GET enrich + POST admin validate 2 field; (2) page state + reset + 2 input number + payload; (3) typecheck; (4) receipt này.
- **Typecheck lại lần cuối:** `npx tsc --noEmit` (cwd `D:\Git\dugate`) → **exit 0**, không có output lỗi; raw kèm timestamp: `coordination/reports/raw/p2-admin-ui-typecheck-2026-10-06.txt` (file tồn tại, 130 bytes, có dòng `exit=0`).
- **Hashes tại thời điểm chốt:** `app/api/internal/profile-endpoints/route.ts` = `7D76CC87842B3B42`, `app/profiles/page.tsx` = `0EEFA471021F94F7` (khớp §5).
- **Working tree:** chỉ 2 file lease ở trạng thái `M` (thay đổi của receipt này); `lib/config.ts`/`lib/db/schema.ts`/`drizzle/*` là dirty có sẵn của lane rate/fair-share, không bị chạm.
- **HEAD:** `4308cc5` — **không commit, không push**; không tick task row.
- **Trạng thái gói:** owner delivery IMPLEMENTED; runtime HTTP/UI verification vẫn là bước độc lập (ma trận ở §3) — typecheck **không** được dùng thay functional verification.

- **Task:** P2 — Admin Control Plane & Profiles UI (rate limit per endpoint + max concurrent slots).
- **Owner:** OpenCode 4 (`oc_4` / `term_f1c5a1d1`), worker lane.
- **Ngày ghi:** 2026-10-07 (theo yêu cầu packet) / filename `receipt-p2-admin-ui-rate-limit-2026-10-06.md`.
- **Repo:** `D:\Git\dugate` (legacy Next.js app). **HEAD:** `4308cc5`.
- **Lease ghi duy nhất:** `app/api/internal/profile-endpoints/route.ts`, `app/profiles/page.tsx`.
- **Tham chiếu:** plan `C:\Users\Gem\.claude\plans\elegant-snacking-feather.md` (§A.3 Admin), `lib/config.ts`.
- **Trạng thái:** IMPLEMENTED (owner delivery) — `npx tsc --noEmit` exit 0; **chưa** chạy runtime/HTTP/UI test, **chưa** independent verification. Không commit, không push.

## 1. Thay đổi

### 1.1 `app/api/internal/profile-endpoints/route.ts` (+47 / -1)

| Vị trí | Thay đổi |
|---|---|
| imports | `import { MAX_ENDPOINT_RATE_LIMIT_PER_MIN, MAX_ENDPOINT_CONCURRENT } from '@/lib/config';` |
| helper mới | `validateEndpointLimit(value, max, label)` — `undefined`/`null` → `{ok:true, value:null}` (reset default, lưu NULL); chỉ nhận `number` + `Number.isInteger` + `>= 0`, ngược lại `{ok:false, error}`; `> max` → `{ok:false, error}`. |
| GET enrich | Thêm `rateLimitPerMin: dbRecord?.rateLimitPerMin ?? null` và `maxConcurrent: dbRecord?.maxConcurrent ?? null` vào object endpoint (cạnh `jobPriority`), đọc thẳng từ `dbRecord` — không thêm query. |
| POST parse | Destructure thêm `rateLimitPerMin, maxConcurrent` từ body. |
| POST admin validate | Trước khi dựng `payload`: validate rate với max `MAX_ENDPOINT_RATE_LIMIT_PER_MIN` (10000) và concurrent với `MAX_ENDPOINT_CONCURRENT` (20); lỗi trả `400 { error }`. |
| POST payload | `rateLimitPerMin: rateLimitValidation.value`, `maxConcurrent: concurrentValidation.value` — upsert như các field admin khác. |
| Nhánh non-admin | **Giữ nguyên** (không nhận 2 field; nhất quán `jobPriority`) đúng plan §A.3. |

### 1.2 `app/profiles/page.tsx` (+68)

| Vị trí | Thay đổi |
|---|---|
| imports | Thêm `DEFAULT_ENDPOINT_RATE_LIMIT_PER_MIN`, `MAX_CONCURRENT_PER_PROFILE_ENDPOINT`, `MAX_ENDPOINT_RATE_LIMIT_PER_MIN`, `MAX_ENDPOINT_CONCURRENT` từ `@/lib/config`. |
| `ProfileEndpointCard` state | Thêm `rateLimitPerMin`, `maxConcurrent` kiểu `string`, seed từ `endpoint.rateLimitPerMin/maxConcurrent` (`null`/`undefined` → `''` = default). |
| Reset khi đổi profile | Effect deps `[apiKeyId, endpoint.slug]` reset cả 2 state từ endpoint prop (cùng chỗ reset `jobPriority`/`fileUrlAuthConfig`). |
| `saveSettings` | Payload POST thêm `rateLimitPerMin`/`maxConcurrent`: `''` → `null` (reset default); ngược lại `Number(raw)` (route là nơi validate 400). |
| UI admin-only | Thêm 2 input `type="number"` (Rate Limit; Max Concurrent Slots) ngay dưới Job Priority: `min=0`, `max` = hằng số cấu hình, `step=1`, placeholder `Mặc định (100)` / `Mặc định (2)`, helper text giải thích “trống/0 = mặc định”, vượt hạn → 429 không xếp hàng. Id field ổn định, sanitize slug (slug có `service:subcase`). |

## 2. Bằng chứng

| # | Lệnh / kiểm tra | Kết quả | Raw |
|---|---|---|---|
| 1 | `npx tsc --noEmit` (cwd `D:\Git\dugate`) | **exit 0**, 0 dòng output | `coordination/reports/raw/p2-admin-ui-typecheck-2026-10-06.txt` |
| 2 | `git diff --stat` 2 file lease | route +47/-1; page +68; tổng 114 insertions, 1 deletion — chỉ 2 file lease | (transcript) |
| 3 | Static cross-check (đọc source, không chỉ exit code) | Schema có cột `rateLimitPerMin`/`maxConcurrent` (`lib/db/schema.ts:134-135`); hằng số đúng ngưỡng (`lib/config.ts:39-40`, defaults `:31,:34`); runner đọc `rateLimitPerMin` (`lib/endpoints/runner.ts:200`); migration `drizzle/0001_add-profile-endpoint-limits.sql` tồn tại (lane rate/fair-share) | — |
| 4 | Structural typecheck | Payload `db.insert(...).values({rateLimitPerMin, maxConcurrent})` compile được ⇒ field tồn tại trong Drizzle schema type; GET/POST field names khớp tên cột | — |

SHA256 (16 đầu):

| File | SHA256 |
|---|---|
| `app/api/internal/profile-endpoints/route.ts` | `7D76CC87842B3B42` |
| `app/profiles/page.tsx` | `0EEFA471021F94F7` |

Diff summary: `app/api/internal/profile-endpoints/route.ts` +47/-1, `app/profiles/page.tsx` +68 (+114/-1 tổng).

## 3. Không chạy / giới hạn (không suy functional success từ exit code)

- Chưa chạy dev server/DB để test HTTP/UI: cần `DATABASE_URL` + session admin + profile thật. Typecheck chỉ chứng minh compile + shape, **không** chứng minh hành vi.
- Đề xuất verifier độc lập chạy (ngoài lease này):
  1. **POST admin 400 matrix:** `rateLimitPerMin` = `-1`, `1.5`, `'5'`, `10001`; `maxConcurrent` = `-1`, `2.5`, `'2'`, `21` → tất cả 400; `0`, `null`, `undefined`, `10000`, `20` → 200 và cột lưu đúng (`null` cho reset).
  2. **GET enrich:** row có `rateLimitPerMin=500, maxConcurrent=3` → response endpoint tương ứng chứa đúng 2 giá trị; row NULL → `null`.
  3. **Non-admin:** gửi 2 field này → bị ignore (không ghi cột), giữ nguyên hành vi cũ.
  4. **UI:** mở profile → input hiển thị giá trị đã lưu hoặc rỗng với placeholder mặc định; sửa → Save → payload có số; xoá trống → payload `null`; đổi apiKey/profile → state reset.
- Phụ thuộc đã có sẵn từ lane khác (không thuộc lease này, không sửa): cột DB + migration 0001, hằng số `lib/config.ts`, phần rate-limit check/fair-share worker.
- Không commit/push. Hai file `lib/config.ts`, `lib/db/schema.ts`, `drizzle/*` đang là thay đổi của lane rate/fair-share — receipt này chỉ chạm 2 file lease.
