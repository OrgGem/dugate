# Receipt — AWEB-WORKFLOW-SIMULATION-HONESTY (2026-10-10)

> **RESUME POINT — IMPLEMENTED + verification chạy sạch, CHƯA ACCEPTED.** Một điểm chèn duy nhất trong đúng file lease; admin-web `tsc --noEmit` exit 0; full offline suite 48 test / 0 fail / exit 0. Cần lưu ý mạnh: **không test nào chạm tới màn Workflows** (suite chỉ test lớp state), nên đây là cổng hồi quy, không phải bằng chứng hành vi mới — xem §4.

- **Lease (1 file duy nhất, không chạm file nào khác):** `du-rework/orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx`
- **Không** git add / commit / push. **Không** sửa backend, contracts, test, docs.
- **Zero double quotes** trong receipt này (yêu cầu của packet): dùng single quote và backtick.

## 1. Điều tra — vì sao danh sách rỗng gây hiểu nhầm

| # | Sự kiện | Bằng chứng |
|---|---|---|
| 1 | Nhánh **simulation** đóng gói `simulatedStages` bằng `selectedWorkflow.stages ?? []` | `:435` |
| 2 | Message của lần chạy chỉ nói đã mô phỏng cục bộ, **không** nói gì về việc không có stage nào | `:433` |
| 3 | Nhánh **backend** chỉ gắn `stagesCompleted` khi mảng hợp lệ; thiếu thì khoá khỏi kết quả | `:449-459` |
| 4 | Panel kết quả chỉ in status + message + errorCode rồi **đổ thẳng JSON thô** | `:1156-1184` (trước khi chèn) |
| 5 | Hệ quả với operator: `simulatedStages: []` nằm trong khối JSON, không lời giải thích nào ⇒ một lần chạy **trông như thành công** dù không stage nào tồn tại | suy ra trực tiếp từ 1-4 |

Đối chiếu: màn **chi tiết** workflow đã có sẵn câu trung thực khi schema không có node (`:909-911`), nên chỗ thiếu là **luồng simulation / test**, không phải màn chi tiết.

## 2. Thay đổi — một điểm chèn, display-only

Chèn tại `:1176-1197`, ngay dưới dòng message của panel kết quả. Ba nhánh, dùng đúng bảng màu sẵn có của file (không thêm màu mới, không thêm Badge variant mới):

1. **simulation + có stage** → in số stage đã đi qua và tên các stage đó (`:1181-1184`), để bằng chứng không chỉ nằm trong JSON.
2. **simulation + `simulatedStages` rỗng hoặc thiếu** → câu **No stages defined for this workflow** kèm nghĩa: không stage nào chạy, kết quả rỗng là **lỗ hổng cấu hình chứ không phải lượt chạy đạt** (`:1186-1190`).
3. **backend + không có `stagesCompleted` (hoặc mảng rỗng)** → câu **No stage list returned for this run**: backend đã nhận lệnh nhưng không trả danh sách stage nên không hiển thị được kết quả theo stage (`:1193-1197`).

Không thay đổi: logic tạo kết quả (`:429-459`), endpoint gọi, kiểu dữ liệu, request nào đi ra. Đây thuần là **diễn đạt trung thực của dữ liệu đã có**.

## 3. Verification (cwd `orchestrator/apps/admin-web`, Node v24.21.0)

```
node <tsc 5.9.3> --noEmit -p tsconfig.json
REAL_EXIT: 0        (output rỗng, 0 diagnostic)

node --test tests/audit-state.test.mjs tests/operations-state.test.mjs tests/profiles-row-key.test.mjs tests/profiles-state.test.mjs tests/trace-state.test.mjs
ℹ tests 48   ℹ suites 9   ℹ pass 48   ℹ fail 0
REAL_EXIT: 0
```

Đều chạy sạch. **Lưu ý về ý nghĩa của con số 48:** toàn bộ test của admin-web là test lớp **state** (`state.ts` của audit, operations, profiles, trace) — **không test nào render màn Workflows**, nên 48/48 chứng minh *không hỏng gì*, không chứng minh *nhánh mới hiển thị đúng*. Tôi không tính nó là bằng chứng hành vi.

## 4. Phân định thay đổi + khoảng trống còn mở

| Mục | Delta của TÔI | Ghi chú |
|---|---|---|
| `workflows-screen.tsx` | **1 lần chèn, 22 dòng** (`:1176-1197`) | không sửa dòng nào khác |

`git diff --numstat` của file này so với HEAD là `+179/-23` — **không phải của tôi**: màn Workflows đã được lane khác viết lại trước đó (provision/test/slot mapping), nên con số đó gồm việc của họ. Tôi chỉ ghi delta 1 chèn.

**Khoảng trống còn mở (không tự che):**

- **Chưa kiểm bằng trình duyệt.** Cần mở modal Test, chọn *Local simulation*, chạy một workflow không có stage để thấy câu *No stages defined* hiện ra (và workflow có stage thì hiện số + tên stage). Việc này thuộc lane browser; tôi không chạy Playwright.
- **Chưa có test cho nhánh này**, vì lease chỉ cho phép sửa đúng một file màn hình, không thêm file test. Nếu muốn khoá hành vi thì cần packet riêng.
- **Điểm liên quan chưa đụng tới:** cột số stage ở danh sách dùng fallback `?? 1` (`:755`) — nghĩa là workflow **không có** stage vẫn hiện *1 stages*. Đó là cùng loại trung thực-thiếu nhưng **nằm ngoài luồng simulation** nên tôi không sửa; ghi ra để coordinator quyết có mở packet riêng hay không.

## 5. Bằng chứng định danh

| File | SHA-256 (sau thay đổi) |
|---|---|
| `src/features/workflows/workflows-screen.tsx` | `52e2f00822cb0b126f5395f4f5f818bc5d0e9a8a429d0c2e908590c0494778f0` |

## 6. Ranh giới đã giữ

- Chỉ 1 file trong lease được sửa; không file test, docs, backend, contracts nào bị chạm.
- Không git add / commit / push.
- Không tick gate, không viết VERIFIED/ACCEPTED — coordinator/Reviewer chốt.
- Offline hoàn toàn: typecheck + node test runner, không mở trình duyệt, không gọi API.
- File duy nhất tạo ngoài thay đổi trên: receipt này.
- `file:line` trong receipt là survey ngày 2026-10-10 trên cây dùng chung; cần đối chiếu lại nếu đọc sau khi lane khác sửa file.