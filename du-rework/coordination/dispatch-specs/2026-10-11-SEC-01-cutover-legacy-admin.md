# Dispatch Spec: SEC-01 — Cutover: dong het be mat legacy admin

| Muc | Gia tri |
|---|---|
| Task ID | SEC-01 |
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Repo scope | du-rework |
| Owner | PENDING — chon sau khi inspect runtime that (xem §6) |
| Lease | `services/orchestrator/src/app/admin/shell-server.ts`, `shell-router.ts`, `apps/admin-web/src/app-shell/app-shell.tsx`, `services/orchestrator/tests/sec-or-01-legacy-read-scope-offline.test.ts` |
| Canonical plan | `coordination/PLAN-SECURITY-ORCHESTRATOR-2026-10-11.md` §2 SEC-01 |
| Receipt | `coordination/reports/receipt-sec-01-cutover-2026-10-11.md` |

## 0. Quyet dinh cua chu (khong phai de xuat cua coordinator)

Nguoi dung 2026-10-11, hai lan:

1. *cutover phan admin legacy*
2. *khong chan viec go link, dong y cutover, neu can tinh nang thi tao lai sau, mien dam bao phia portal moi khong bi loi la duoc*

⇒ **Khong port gi ca.** Khong cai dat lai man cu. Khong hop nhat chuc nang.

**Yeu cau cung nghiem ngat nhat cua task: cutover khong duoc lam hong portal moi.** Tieu chi so 3 va 4 o §5 la tieu chi chinh.

## 1. Kiem ke chuc nang — da doi chieu, khong doan

| Section legacy | SPA tuong duong | Ket luan |
|---|---|---|
| `/admin/businesses` | `features/businesses/` (`router.tsx:48`) | Da phu |
| `/admin/operations` | `features/operations/` (`:47`) | Da phu, SPA giau hon |
| `/admin/overview` | `features/overview/` (`:42`) | Da phu |
| `/admin/profiles` | `features/profiles/` (`:46`) | Da phu |
| `/admin/connectors` | `features/connectors/` (`:45`) | Da phu |
| `/admin/audit` | `features/audit/` (`:43`) | Da phu |
| `/admin/crypto-config` | `features/secrets/` qua `bff/security.ts` (`:51`) | Da phu |
| `/admin/grants` | **khong co** | Nav chet — `section-dispatch.ts` co nhanh `businesses`/`profiles`/`connectors`/`api-keys`/`operations`/`overview` (`:176,189,203,217,231,245`) va **khong co nhanh `grants`** ⇒ nav `p6-01-shell-fixtures.ts:228` khong bao gio ra du lieu |
| `/admin/api-keys` | `features/profiles/api-keys-panel.tsx` | **Phu mot phan** — co issue, attach-existing, rotate, copy-once raw key (`:88,109,122,132`). Khong co danh sach key toan he thong, khong co bang grants |

**Khoang trong da duoc chu quyet dinh:** danh sach API key cap he thong + bang grants se bien mat cung legacy. Client `GET /api-keys` con nguyen tai `lib/api/client.ts:358,361` ⇒ khi can thi dung man moi tren do, khong phai viet lai API. **Khong lam gi them trong task nay.**

## 2. Phai GIU — phan quyet dinh portal moi co bi loi khong

- `/admin/login`, `/admin/logout`, `/admin/oidc/callback` — `shell-server.ts:483-485`. Cat nham ⇒ **khong ai dang nhap duoc**.
- Toan bo `/admin/api/*` cua BFF — `isBffPath` tai `:482`. Cat nham ⇒ SPA mat **het** duong goi du lieu, moi man trang.
- Chinh `isAdminWebPath` va `resolveAdminWebMount` — can con de SPA mount.

## 3. Bai bay ky thuat — KHONG duoc xoa bua hai dong

`shell-server.ts:486-487` dang loai `/admin/legacy` ra khoi SPA de dua no ve legacy renderer:

```
    pathname === '/admin/legacy' ||
    pathname.startsWith('/admin/legacy/')
```

Neu chi **xoa** hai dong do thi `/admin/legacy` se **duoc** `isAdminWebPath` tra `true` va bi dua vao SPA — tuc duong bi dong ben legacy lai **mo** ben SPA, voi noi dung rac tu fallback route `*` (`router.tsx:57`).

**Cach xu dung dung: THAY** hai nhanh loai tru bang mot nhanh chan tuong minh tra `404` (hoac redirect sang `/admin`) cho `/admin/legacy` va moi `/admin/legacy/*`, **dat truoc** phan xu ly admin-web. **Khong xoa dong nao.**

## 4. Vi tri can sua

| File | Dong | Sua gi |
|---|---|---|
| `services/orchestrator/src/app/admin/shell-server.ts` | `480-501` | Them nhanh chan `/admin/legacy*`, giu nguyen 4 nhanh loai tru con lai |
| `services/orchestrator/src/app/admin/shell-router.ts` | `172` | Bo `/admin/legacy` va `/admin/legacy/` khoi danh sach map sang `admin-root` |
| `services/orchestrator/src/app/admin/shell-router.ts` | `202` | **KHONG** bo dong `checkPath` trong task nay — no con la hang phong thu, thuoc pham vi SEC-01F |
| `apps/admin-web/src/app-shell/app-shell.tsx` | `145` | Go the link |
| `services/orchestrator/tests/sec-or-01-legacy-read-scope-offline.test.ts` | `64,106,133,134,164,174` | **Chuyen** `/admin/legacy/operations` va `/admin/legacy/overview` sang `/admin/operations` va `/admin/overview` de giu nguyen phan kiem chung scope cua SEC-01F. **Khong duoc xoa file test nay** |

## 5. Tieu chi hoan thanh

1. `/admin` va **toan bo** route SPA (`router.tsx:42-56`) load duoc, khong route nao rot vao `NotFound` do thay doi nay.
2. Dang nhap, dang xuat, OIDC callback hoat dong end-to-end.
3. **Moi** route BFF van tra du lieu that — **tieu chi chinh** cho yeu cau *dam bao portal moi khong bi loi*.
4. Nav SPA khong con link `/admin/legacy`.
5. `/admin/legacy` va `/admin/legacy/*` tra `404` hoac redirect `/admin` — **chon mot**, ghi vao test.
6. Test suite day du xanh sau khi sua, va cac case bi anh huong da duoc **chuyen** chu khong bi xoa.
7. **Khong** tu nhan SEC-01 da dong — xem SEC-01F.

## 6. Ràng buoc va bang chung dispatch

- **Khong `git add` / `commit` / `push`. Khong tick gate.**
- **Khong sua file ngoai lease.** Khong sua `section-dispatch.ts` — san pham cua SEC-01F.
- Khong mo cua so DB, khong dung DB production/legacy.
- **Khong dung ky tu nhay kep ASCII** trong file va prompt.
- **Owner: PENDING.** Phep giao bat buoc inspect runtime that qua `orca terminal list --json` + doc screen. `DISPATCH-LIVE-2026-10-10.md` la **ledger lich su, khong phai bang chung hien tai**. Khong co request/dispatch ID ⇒ khong co bang chung dispatch.
- **Ranh giới owner vs SEC-01F:** SEC-01 sua `tests/sec-or-01-legacy-read-scope-offline.test.ts` — cung la test cua SEC-01F. **Cung owner thi serialize**, tranh hai nguoi cung dung mot file test.

## 7. Hanh dung dung

Khong sua file san pham ngoai lease. Khong `git add`/`commit`/`push`. Khong tick gate.
Khong port man cu sang SPA — quyet dinh cua chu la cat trang, tao lai sau neu can.