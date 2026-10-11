# Verify độc lập (DSH) — OR10-07 advisory lock NUL byte fix — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY trên `src/modules/usage/budget-reservations.ts` và `tests/or10-07-advisory-lock-null-byte.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-or10-07-2026-10-10/DSH/` (`or10-07.log`, `tsc.log`).

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-07-advisory-lock-null-byte.test.ts tests/budget-reservations.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 11 passed, 11 total` · không FAIL |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |

Digest (16 ký tự đầu): `budget-reservations.ts` = `f852ec3c8d51fcc1` (655 dòng) · test OR10-07 = `c57e9e81a54164a8` (142 dòng).

## 2. Lock tuple — đọc trực tiếp

```
218: const lockKey = JSON.stringify([scopeKey, from, to]);
219: await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
```

- **Không còn NUL byte:** khoá được tạo bằng `JSON.stringify` trên **mảng 3 phần tử**; chuỗi JSON chỉ chứa ký tự in được (`[`, `"`, `,`, chữ số, `:`…), **không** có ký tự `\u0000`. Bản cũ (nối bằng NUL) đã không còn — đó là điều kiện khiến PostgreSQL từ chối tham số trong `pg_advisory_xact_lock` (text có NUL không hợp lệ).
- **Phân biệt tuple:** JSON có **phân cách tường minh** (dấu phẩy + nháy kép quanh từng phần tử) nên hai tuple khác nhau **không thể** va nhau kiểu nối chuỗi thô (ví dụ scope chứa `|`/khoảng trắng/dấu phẩy vẫn được quote nguyên vẹn; `["a,b","c"]` khác `["a","b,c"]`).
- Hash vẫn là `hashtextextended($1, 0)` trên **cùng một** khoá text cho mọi caller đi qua hàm này ⇒ các giao dịch cùng scope/window vẫn tuần tự hoá đúng, còn scope/window khác nhau cho khoá khác.

## 3. Kiểm bounds theo packet (đối chiếu test)

| Bound | Có được kiểm? | Bằng chứng |
|---|---|---|
| **Lock tuple không còn NUL byte** | **CÓ** | test `:33` tên ca *reserve sends a NUL-free, tuple-preserving lock key to PostgreSQL*; `:38` bắt đúng câu `SELECT pg_advisory_xact_lock…` và giữ tham số; `:140` `expect(String(lockParameters[0])).not.toContain('\u0000')` |
| **Phân biệt tuple** | **CÓ (theo cấu trúc + tên ca)** | mã hoá `JSON.stringify([scopeKey, from, to])` tại `:218` bảo đảm phân tách tường minh; tên ca khẳng định *tuple-preserving*. **Giới hạn trung thực:** trong output tôi đọc, tôi **không** thấy một assertion riêng kiểu *hai tuple khác nhau cho hai khoá khác nhau*; tính chất này tôi xác nhận bằng **cấu trúc mã hoá**, không bằng một ca đối chứng trực tiếp |

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| 2 suite (OR10-07 + budget-reservations) | **PASS** — exit 0, `2 passed, 2 total`, `11 passed, 11 total` |
| Typecheck | **PASS** — exit 0 |
| Khoá không còn NUL byte | **ĐẠT** — `:218-219` JSON array; test assert `not.toContain('\u0000')` (`:140`) |
| Phân biệt tuple | **ĐẠT** theo cấu trúc JSON (phân cách tường minh), chưa có ca đối chứng trực tiếp |

⇒ **OR10-07: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Offline, không PostgreSQL thật:** suite dùng client giả để bắt câu SQL + tham số; việc `pg_advisory_xact_lock(hashtextextended(...))` thực sự chạy và tuần tự hoá hai giao dịch tranh chấp **chưa** được chứng minh — cần gate live (đúng bản chất của lỗi NUL byte, vốn chỉ lộ khi gọi DB thật).
2. **Thiếu ca đối chứng phân biệt tuple:** nên có test khẳng định hai tuple khác nhau sinh hai khoá khác nhau, và một ca chứa ký tự đặc biệt (`|`, `,`, khoảng trắng, unicode) để chống hồi quy.
3. **Phạm vi hẹp:** chỉ kiểm `reserve`; nếu còn chỗ khác tự nối khoá advisory (không dùng `lockKey` này) thì cần rà riêng — tôi không kết luận thay.
4. Không commit: test là file mới; `budget-reservations.ts` có thể ` M` từ lane khác ⇒ kết quả gắn digest §1.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 dòng trailing whitespace**; **2 dòng có ký tự nháy kép** (dòng 24-25, phần giải thích cấu trúc JSON của khoá) — ghi đúng sự thật, khác quy ước không-nháy-kép mà các receipt OR10-04/OR10-06 tuân theo.
