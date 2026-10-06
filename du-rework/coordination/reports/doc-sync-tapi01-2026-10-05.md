# DOC-SYNC-TAPI01 — openapi routed + comment line-ref — cc_2 — 2026-10-05

**Packet:** coordinator 01:04 (+07). **Mode:** offline; no commit; không tick. Comment-only trong submission.ts (1 dòng, đúng lease packet).
**Boundary:** 3 file (§1) + receipt; không chạm source khác.

---

## 0. TL;DR

1. `docs/21-openapi.json` — route profile detail hết "contract-frozen, not yet routed": description mô tả **ROUTED (closure 2026-10-05)** + schema `ProfileDetailRead` thêm property `apiKeyId` (uuid, write identity); entry tương ứng **bỏ khỏi `x-absent`** (10 → 9 entries — không còn đúng để nằm trong danh sách "absent"). JSON parse OK.
2. `submission.ts` — comment stale "`randomUUID` at :260" → "the first `randomUUID` (:314)" (comment-only; anchor thật của call site; W1 sẽ dịch dòng tiếp thì ref vẫn nêu đúng call site theo tên).
3. Rerun nhanh: `w1-sub02-snapshot-secret` + `p730-profile-snapshot` → **21/21, exit 0**.

## 1. File đã sửa (post-edit sha16)

| File | Việc | sha16 |
|---|---|---|
| `docs/21-openapi.json` | +`apiKeyId` property (:947-951); description routed (:953); bỏ entry x-absent cũ (nay `:2668` là profile-test-endpoint) | `A394C9AF998073EB` |
| `services/orchestrator/src/modules/operations/submission.ts` | comment `:242` — `:260` → `:314` (comment-only; behavior 0 đổi) | `BD8CA6A56986E64B` |

**Đối chiếu line-ref với packet:** packet ghi "submission.ts dòng 227 (comment ghi :260, thật :299-301)". Theo snapshot HIỆN TẠI: comment ở **:242** ("before `randomUUID` at :260"); các `randomUUID` đầu tiên ở **:314-316** (khối :299-301 là call `findSubmissionKey` — không phải anchor của câu comment). Đã sửa về đúng anchor hiện tại `:314` và ghi rõ trong receipt để khỏi lệch lần sau.

## 2. Gates literal

```
node JSON.parse(docs/21-openapi.json): OPENAPI_JSON_OK
x-absent entries: 10 → 9 (đếm bằng node/PS trên array)

Rerun 2 suite (0 behavior change):
  tests/w1-sub02-snapshot-secret.test.ts + tests/p730-profile-snapshot.test.ts
  → 2 suites / 21 tests passed — RERUN_EXIT=0
```

## 3. Notes

- Chuỗi cũ "contract frozen, not yet routed" grep toàn repo giờ chỉ còn trong **receipt lịch sử** `tapi01-closure-2026-10-04.md` (§Δ-DOC-1) — packet này **đóng Δ-DOC-1 đó**; không sửa receipt cũ (giữ nguyên lịch sử).
- `capabilities: []` vẫn là thực tế route (chưa có bảng capabilities) — description mới không claim khác đi; giữ nguyên description property như cũ.
- x-absent từ nay 9 entries; nếu có validator/plan pin con số này, cần cập nhật theo (grep hiện không thấy pin nào).
- Boundary: không commit/push/tick; submission.ts chỉ 1 dòng comment, không announce (không phải write logic).
