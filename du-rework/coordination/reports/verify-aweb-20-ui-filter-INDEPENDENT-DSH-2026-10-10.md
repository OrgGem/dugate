# Verify độc lập (DSH) — AWEB-20-UI Operations date filter — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), READ-ONLY lease.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa product code; **KHÔNG** tick gate; receipt **0 ký tự nháy kép** (đã tự quét).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3 · cwd `orchestrator/apps/admin-web`.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-20-ui-filter-2026-10-10/DSH/` (`mjs.log`, `SHA256SUMS.txt`).

## 1. Offline test trên admin-web

Lệnh: `node --test tests/*.test.mjs` (**11** file `.test.mjs`, PowerShell không tự mở glob nên tôi liệt kê rồi truyền danh sách).

| REAL_EXIT | Literal |
|---:|---|
| **0** | **`# tests 82`** · **`# suites 18`** · `# pass 82` · `# fail 0` |

⇒ **khớp đúng claim 82 tests / 18 suites, không FAIL**; không có dòng `not ok` nào.

## 2. Logic `from`/`to` ISO UTC — đọc mã

`src/features/operations/state.ts`:

```ts
// :134-141
export function operationsTimeWindow(
  fromDate: string,
  toDate: string,
): { from: string | null; to: string | null } {
  return {
    from: fromDate === '' ? null : `${fromDate}T00:00:00.000Z`,
    to:   toDate   === '' ? null : `${toDate}T23:59:59.999Z`,
  };
}

// :159 + :166
export function buildOperationsQuery(input: OperationsFilterInput): Record<string, string> {
  ...
  const window = operationsTimeWindow(input.fromDate, input.toDate);
```

- Ngày người dùng nhập được mở thành **biên ngày trọn vẹn theo UTC** (`T00:00:00.000Z` … `T23:59:59.999Z`) ⇒ server nhận mốc ISO UTC, không phải giờ địa phương.
- Ô để trống ⇒ **`null`** ⇒ tham số **không** được gửi (không gửi bound rỗng).
- `buildOperationsQuery` là nơi duy nhất chuyển `fromDate`/`toDate` thành tham số truy vấn, và nó gọi `operationsTimeWindow` ⇒ screen không tự nối chuỗi ngày.
- Screen truyền đúng các trường đó: `operations-screen.tsx:87-88` (`fromDate`, `toDate` trong input) · `:123-125` (deps của effect) · `:138` (dependencies array có `fromDate`, `toDate`).
- Header test `tests/operations-state.test.mjs:14-17` ghi rõ bối cảnh lỗi cũ: màn Operations **từng lọc ngày ở trình duyệt trên trang đang có**, nên một operation khớp ở trang 2 bị bỏ sót; nay lọc ở **server** (`modules/operations/list-query.ts` parse `from`/`to` thành predicate SQL).

## 3. Reset stale cursor — đọc mã

`src/features/operations/state.ts:207-212`:
```ts
export function operationsCursorIsStale(
  cursor: string | null,
  cursorPopulation: string | null,
  selectedPopulation: string,
): boolean {
  return cursor !== null && cursorPopulation !== selectedPopulation;
}
```
`src/features/operations/operations-screen.tsx`:
- `:21` import `operationsCursorIsStale`; `:48` `const [cursor, setCursor] = useState<string | null>(null);`.
- **Trước khi nạp:** `:96-108` — comment *BEFORE any state reset so the pane never parks on loading*; `:97` guard `if (operationsWindowInvalid(fromDate, toDate)) return;`; `:98-101` cảnh báo **đổi tenant toàn cục không có input handler nào xoá cursor**, nên `:101` kiểm `operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)` rồi `:108` **`setCursor(null)`**.
- **Khi áp cursor mới:** `:144-157` — comment nguyên văn *AWEB-20: a cursor only addresses one population. Most controls reset it in… cursor minted for tenant A kept paging tenant B and silently skipped rows*; `applyCursor` (`:148`) kiểm `operationsCursorIsStale` (`:149`) rồi `setCursor(null)` (`:153`) hoặc `setCursor(next)` (`:157`) ⇒ đúng lớp lỗi **cursor cũ trỏ sang tập dân số mới**.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite admin-web `.mjs` | **PASS** — `# tests 82` · `# suites 18` · `# fail 0`, exit 0 |
| `from`/`to` thành ISO UTC | **ĐẠT** — `state.ts:139-140` (`T00:00:00.000Z`, `T23:59:59.999Z`) |
| Ô trống ⇒ không gửi bound | **ĐẠT** — trả `null` (`:139-140`) |
| Một nguồn chuyển đổi duy nhất | **ĐẠT** — `buildOperationsQuery` gọi `operationsTimeWindow` (`:159`, `:166`) |
| Reset stale cursor | **ĐẠT** — `operationsCursorIsStale` (`state.ts:207-212`) dùng ở screen `:101` và `:149`, cả hai dẫn tới `setCursor(null)` |
| Guard khoảng ngày sai | **ĐẠT** — `operationsWindowInvalid` chặn trước khi nạp (`:97`) |

⇒ **AWEB-20-UI Operations date filter: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Chưa render thật:** suite `.mjs` chạy helper JS thuần (có đọc file `.ts` bằng `typescript` transpile) — **không** dựng React/React Router, không gọi API/DB thật ⇒ tôi xác nhận **logic**, không xác nhận hành vi UI khi bấm/nhập trên trình duyệt (ví dụ đổi ngày có reset cursor trên URL thật không).
2. **Chưa đọc hết** `operations-screen.tsx` (885 dòng theo lượt đo trước) và `state.ts`; các kết luận dựa trên vùng đã đọc + grep có trọng tâm.
3. **Chưa kiểm end-to-end với server:** `modules/operations/list-query.ts` parse `from`/`to` thành SQL predicate — tôi **không** chạy suite orchestrator cho phần đó trong lượt này (đã có các lượt riêng: `operations-list-contract-conformance` 19/19 xanh, nhưng suite `operations-list-contract` từng đỏ 6-vs-8 tham số — **vẫn là hạng mục mở**, xem receipt `verify-or10-01-allowlist-impl-INDEPENDENT-DSH-2026-10-10.md`).
4. **Build admin-web đang ĐỎ ở lane khác** (`features/profiles/api-keys-panel.tsx`, `profile-keys.ts` — 6 lỗi `TS2305/TS7006`) — không liên quan AWEB-20-UI và không ảnh hưởng `.mjs` chạy bằng node thuần.
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa product code; chỉ ghi receipt này + raw log (1 file log + SHA256SUMS).
- Receipt tự quét: **0 ký tự nháy kép** (đúng ràng buộc lượt này), **0 dòng trailing whitespace**.
