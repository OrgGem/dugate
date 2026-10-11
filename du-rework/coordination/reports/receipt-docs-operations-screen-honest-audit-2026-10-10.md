# Receipt — docs: Operations screen honesty audit + fixes (2026-10-10)

> **RESUME POINT — IMPLEMENTED + verification sạch, CHƯA ACCEPTED.** Audit 4 luồng (bulk cancel, retry, pagination, offline fallback); 3 lỗ hổng trung thực đã sửa, 10 hành vi đã trung thực thì giữ nguyên và ghi lại. `tsc --noEmit` exit 0; full offline suite 50 test / 0 fail / exit 0. Không git add/commit/push, không tick gate.

- **Scope sửa:** `apps/admin-web/src/features/operations/` — `state.ts` + `operations-screen.tsx`
- **Tài liệu:** `docs-operations-screen-honest-audit-2026-10-10.md` + receipt này
- **Ràng buộc:** COORDINATOR-CONTRACT — không commit/push/stage; **zero double quotes** trong cả hai file

## 1. Kết quả audit (đọc lại source hôm nay)

| Luồng | Kết luận |
|---|---|
| Bulk cancel | 10 phần trung thực sẵn; **1 lỗ hổng**: id đã chọn nhưng không hủy được bị bỏ im lặng, thông bệp không nói |
| Retry | phân biệt `replayed` đúng; **1 lỗ hổng**: khi backend không trả `operationId` thì thông báo có dấu hai chấm rỗng và màn mở detail của operation **gốc** |
| Pagination | nút bám cursor, cursor thuộc tập cũ bị bỏ; **1 lỗ hổng**: nhãn đếm in `T total` từ giá trị parser **tự bịa** khi server không gửi `total` |
| Offline/transport | load lỗi thì sang trạng thái lỗi, không giữ bảng cũ như dữ liệu tươi; lỗi từng id trong bulk hiện kèm mã + HTTP status — **không phát hiện lỗ hổng** |

## 2. Ba sửa đã thực hiện

1. **G1** `skippedCount` (`:225`) + thông bệp *N skipped (already finished or not listed on this page)* (`:257-259`); id bị bỏ vẫn giữ trong selection (`:254`).
2. **G2** `retryOperationId` (`:200-204`) + thông bệp *Retry created, but the backend returned no operation id for it.* (`:209`) kèm chú thích rõ detail bên dưới vẫn là operation gốc (`:197-199`).
3. **G3** `ParsedOperationsPage.totalFromServer` (state.ts `:41-43`, `:53`) + nhãn đếm chỉ in tổng khi server thật sự gửi, ngược lại *total not reported by the server* (`:480`). Kiểu wire trong `lib/api` **không bị sửa**.

## 3. Verification

```
node <tsc 5.9.3> --noEmit -p tsconfig.json            REAL_EXIT: 0   (output rỗng)
node --test tests/audit-state.test.mjs tests/operations-state.test.mjs tests/profiles-row-key.test.mjs tests/profiles-state.test.mjs tests/trace-state.test.mjs
ℹ tests 50   ℹ suites 10   ℹ pass 50   ℹ fail 0          REAL_EXIT: 0
```

Fail-first ghi thẳng: vòng 1 tsc **exit 2** (`TS1005` tại `:260`, tôi bỏ sót `);` khi sửa G1); vòng 2 tsc **exit 2** (`TS2322`, TS không suy luận kiểu qua alias boolean, đổi sang biến `number | null`). Chỉ vòng 3 mới xanh.

| Kiểm tra | Kết quả |
|---|---|
| Zero double quotes trong báo cáo | 0 ký tự `[char]34` |
| Zero double quotes trong receipt này | 0 ký tự `[char]34` |
| SHA-256 `features/operations/state.ts` | `2605a2a9c57e22f60c0d5f3d885b4988649220dd97feaf1bac541adb60acc8de` |
| SHA-256 `features/operations/operations-screen.tsx` | `a7e02b2487e4eda3cec712568b4bd000ddfcbd489b9a1a50e032e45b3e694120` |
| Marker sửa còn trong cây | 10 hit `HONESTY-AUDIT-OPS` / `totalFromServer` / `skippedCount` / `Retry created, but` |

## 4. Phân định thay đổi (trung thực)

| File | Delta của TÔI | `git diff --numstat` so với HEAD |
|---|---|---|
| `state.ts` | 1 interface + cờ `totalFromServer` trong parser | `+115/-2` — phần lớn **không phải của tôi** |
| `operations-screen.tsx` | 6 chỉnh sửa (import kiểu, generic state, nhãn đếm, skipped, thông bệp retry) | `+171/-55` — phần lớn **không phải của tôi** |

Hai file đang được lane khác sửa song song, nên numstat không dùng để đánh giá thay đổi của tôi được.

## 5. Giới hạn đã ghi

- **Chưa kiểm bằng trình duyệt** cho ba sửa (cần ba tình huống: bulk cancel có id bị bỏ sót; retry không trả id; payload list thiếu `total`).
- **50 test không render màn Operations** (đều là test lớp state) ⇒ cổng hồi quy, không phải bằng chứng hiển thị.
- **Chưa có test khoá** cho ba hành vi mới; `parseOperationsPage` có thêm cờ nên một test tương lai nên pin `totalFromServer` theo cả hai nhánh có/không `total`.
- Ngoài phạm vi đã ghi trong báo cáo: không auto-refresh, không tải artifact, không lọc theo mã lỗi, không xuất kết quả hàng loạt.

## 6. Ranh giới đã giữ

- Sửa **chỉ trong `features/operations/`**; không backend, không contracts, không `lib/api`, không docs kỹ thuật khác.
- **Không** git add / commit / push; **không** tick gate; **không** viết VERIFIED/ACCEPTED.
- Zero double quotes trong cả hai file của packet.
- File tạo: báo cáo + receipt này.