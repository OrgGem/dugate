# WFA-DOCS independent review — 2026-10-08

- **Reviewer:** independent (read-only). Không sửa file lane, không commit, không push.
- **Scope:** dispatch spec [`2026-10-07-WFA-DOCS-oc.md`](../dispatch-specs/2026-10-07-WFA-DOCS-oc.md) + owner receipt [`wfa-docs-2026-10-07.md`](wfa-docs-2026-10-07.md).
- **Method:** re-run `gen_openapi.py` + `validate_openapi.py` trên Node v24.21.0 (PATH prepend `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64`), SHA-256 trước/sau, đọc docs vs code đối chiếu từng dòng, grep claims.
- **Disclosure:** việc verify regen tạm ghi lại `docs/21-openapi.json` (đúng quy ước: chỉ generator được chạm file này); đã backup trước và restore byte-for-byte sau — hash lại = `2bcab399…4e1c`. Không file nào khác bị thay đổi.

## 1. `docs/21-openapi.json` regen qua generator — **PASS** (provenance + hash) / ⚠ finding F2

- **SHA-256 khớp receipt:** tree file = `2bcab3997b76dfad28dcd4f986560f2f263c250f066fcf9a428c8b40530b4e1c` — đúng hash receipt §1 ghi. **PASS.**
- **Provenance (không phải hand-edit):** regen mới (exit 0, `path-count=60 dropped-paths=0 schemas=51`) khác tree file **duy nhất 4 dòng `x-source`** trỏ vào `admin.ts` (`:324→329`, `:543→583`, `:532→572`, `:570→610`); generator tự tính các con số này từ `admin.ts` (`tools/openapi/gen_openapi.py:806-827`, `admin_source()`). Không dấu vết sửa tay. **PASS.**
- **F2 (info, không phải lỗi lane):** regen hôm nay cho `d516e8d4…` ≠ `2bcab399…` — nguyên nhân `admin.ts` bị sửa **hôm nay 01:44** (mtime, ` M` vs HEAD) bởi lane khác; generator deterministic (2 lần chạy liên tiếp cùng hash). Claim "regen byte-identical" của receipt đúng **tại thời điểm chạy 2026-10-07** nhưng không còn reproduce được nguyên vẹn → route cho generator owner (COMP-11). HEAD version = `f12da01b` (lane không commit — nhất quán quy ước no-commit).
- `validate_openapi.py` exit 0: `routes=2`, `paths=60 x-absent=9`, toàn bộ schema check PASS. **PASS.**

## 2. 5 điểm sửa `docs/06` + `docs/39` — **PASS** (cả 5)

| Điểm | Doc (file:line) | Code đối chiếu (đã đọc trực tiếp) | Verdict |
|---|---|---|---|
| P1 services/billing/usage | `docs/06:29-30`; `docs/39:30-32`, `:18`, `:325` | `legacy-http-mount.ts:806-884` (billing), `:886-904` (services; `serviceCatalogue` chưa wire → 500, `:893`); `legacy-host-adapter.ts:428` (`billingFor`), `:620` (`loadLegacyBilling`); migration `0024_legacy_parity_columns.sql:82-83`; test pin `rv01-loopback-http-offline.test.ts:1628` | PASS |
| P2 `POST /docs/{action}` rút gọn | `docs/06:15` | `parseLegacyDocsPath` `:225-235`; action branch `:600-646`; `LEGACY_CORE_ACTIONS` `legacy-wire-decoders.ts:12`; 6 action path **không có** trong `docs/21` (grep 0 hit), chỉ 2 workflow path (`docs/21:3625,3794`) | PASS |
| P3 phạm vi `?sync`/`Idempotency-Key` | `docs/06:47` | `submitOptions` `:247-251`; `legacySubmitResponse` `:282` (200 khi `executeSync \|\| replayed`); workflow branch hardcode 202 (`:576-600`) | PASS |
| P4 vị trí mount (thay `grep server.ts`) | `docs/39:40` | `http/routes/public.ts:13` (import), `:299` (gọi); `server.ts` **0 hit** `compat/` | PASS |
| P5 evidence split, không tick ACCEPTED | `docs/06:66-79`; `docs/39:42` | khớp `wfa-verification-2026-10-07.md:77,105` (T01–03/T15–24/T25–28 open; "No full WFA-T01..38 acceptance claim") | PASS |

## 3. Ledger sync `docs/19`, `docs/28`, `docs/35` — **PASS**

- `docs/19:783-785`, `docs/28:2208-2210`, `docs/35:1574-1576` — cùng scope (docs-only), cùng lệnh/counts/SHA, cùng ghi "no gate / no acceptance change", cùng link receipt `wfa-docs-2026-10-07.md`. Nhất quán. Caveat: cả 3 lặp lại claim "byte-identical" thời-điểm (xem F2).

## 4. Claim thừa IMPLEMENTED/ACCEPTED — **PASS**

- `docs/06:79` T38 = **IMPLEMENTED (docs owner)** — chính xác (docs + generator đã làm); mọi nhóm WFA còn lại **OPEN**; `docs/39:42` ghi rõ "Không tick ACCEPTED".
- Các hit `ACCEPTED` trong `docs/06` đều là phủ định hoặc không liên quan (`:68` "không suy ra ACCEPTED", `:116` enum, `:167/169` "Chưa ACCEPTED", `:235` ENC-08). Receipt tự khai **IMPLEMENTED — not ACCEPTED**. Không claim thừa.
- **F1 (minor, traceability):** con trỏ evidence treo — `tests/workflow-api/logs/schema-worker-full-after-owner-patches-node24-2026-10-07.log` được trích tại `docs/06:81`, receipt `:40`, `wfa-integration-2026-10-07.md:68`, nhưng **không tồn tại** `logs/` trong toàn checkout (glob `**/logs/**` = 0). Claim 8/8 có bằng chứng chữ tại `wfa-integration:68` nhưng raw log không có trong cây → nên bổ sung log hoặc sửa con trỏ.

## Verdict

- 4/4 mục **PASS**; 2 findings: **F1** (minor — log 8/8 treo), **F2** (info — regen không còn byte-identical hôm nay do `admin.ts` drift, không phải lỗi lane).
- Nửa docs của WFA-T38: **IMPLEMENTED xác nhận**; quyết định close thuộc coordinator.