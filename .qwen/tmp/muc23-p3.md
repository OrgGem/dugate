#### Verify (offline, literal exit code)

- `pnpm --filter @du/orchestrator exec tsc --noEmit` — log **rỗng**, Exit Code: **0**.
- Targeted (3 file `url-ingestion*`) ×3 lần liên tiếp:
  `Test Suites: 3 passed, 3 total` / `Tests: 42 passed, 42 total` — Exit Code: **0 / 0 / 0**
  (lần chạy thứ 4 sau khi restore cũng 0; con số 42 = 38 có sẵn + 2 mới + 2 collateral cùng
  họ đã có từ trước).
- Riêng consumer: **35/35** (33 có sẵn + 2 mới).
- **Mutation probe M1** (tắt guard, chạy consumer suite):
  `Tests: 1 failed, 34 passed` — đúng test `a PENDING_INGESTION task is refused and takes NO
  lease`. ⇒ test cắn đúng. Restore byte-exact: `runtime.ts` sha `902185d2`, 77510 B.

#### Full orchestrator suite — 3 đỏ, phân loại từng cái

`Test Suites: 3 failed, 1 skipped, 86 passed, 90 total` /
`Tests: 3 failed, 28 skipped, 1988 passed, 2019 total`.

| Test | Phân loại | Bằng chứng |
|---|---|---|
| `admin-operations-list-pagination` | **ngoại lai, đã biết từ cycle 1** | Admin shell reflow scroller; mtime file 2026-09-24, tồn tại trước mọi thay đổi của tôi |
| `admin-shell-session-lifecycle` | **ngoại lai** | grep `claimTask\|modules/runtime` trong file test → **No matches**. Dấu hiệu đỏ: `console.warn spy received 0 lines` |
| `adm-base-03-safe-error-offline` | **ngoại lai** | log text rỗng, cùng vùng admin-shell, không import `claimTask` |

Mtime làm tôi tin phần **nguyên nhân** chứ không chỉ phần **phân loại**:

```
src/app/admin/shell-router.ts    mtime=2026-09-27T22:19:32Z   <-- Admin/SEC lane
src/app/admin/shell-server.ts    mtime=2026-09-27T21:15:25Z   <-- Admin/SEC lane
src/modules/runtime/runtime.ts   mtime=2026-09-27T22:13:48Z   <-- của tôi (cycle này)
src/modules/operations/ingestion-consumer.ts  mtime=2026-09-26T10:03:05Z  (không chạm)
```

Không sửa 3 test này (đúng quy tắc lane: không đụng test file của lane khác trong checkout
dùng chung) và **không** đòi coordinator coi full suite xanh — tôi báo 3 đỏ này mở.

#### Δ-DEVIATION (chờ coordinator adjudicate)

- **Δ54 — write scope vượt packet.** Packet chỉ nêu 2 file test. Nhưng mệnh đề cần giữ
  ("non-runnable until READY") **không thể** được siết bằng test-only: dispatcher đã làm
  đúng phần routing, thiếu duy nhất là guard ở claim boundary trong
  `src/modules/runtime/runtime.ts`. Tôi sửa file src đó. Đây là Δ **cần thiết về mặt kỹ
  thuật**, không phải tự ý mở rộng — nhưng coordinator nên biết vì packet ghi sai phạm vi.
- **Δ55 — chưa có live evidence cho claim guard.** `PENDING_INGESTION` + lease phải chứng
  minh trên Postgres thật qua `FOR UPDATE OF t`. Tất cả bằng chứng ở Mục này là offline với
  fake router. Cùng loại với Δ53 (DATA-03 live multi-container) — gộp vào **DATA-INT-01**.
- **Δ56 — 3 đỏ admin-shell trong full suite.** Nguyên nhân ngoài phạm vi tôi, nhưng chúng
  làm full suite đỏ và tôi **không** tự hấp thụ. Cần lane Admin/SEC xác nhận hoặc dọn.

#### Tự phân loại 4 tầng

- **SPECIFIED**: rõ — 2 mệnh đề (202 tạo ingestion task; business task không chạy được trước
  khi source READY), và mệnh đề thứ hai là thuộc tính **claim boundary**.
- **IMPLEMENTED**: 1 file src (`runtime.ts` — 1 guard, 5 dòng) + 1 file test (2 test, 5 cột
  lease, 4 nhánh router).
- **VERIFIED (offline)**: tsc 0; targeted 42/42 ×3 + lần 4 (Exit 0); consumer 35/35; M1 đỏ
  đúng mục tiêu; restore byte-exact `902185d2`/77510 B.
- **ACCEPTED**: không thuộc quyền lane. Chưa có live-PG cho guard (Δ55), chưa có live
  multi-container DATA-03 (Δ53), 3 đỏ admin-shell còn mở (Δ56).
