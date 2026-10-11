# SEC-01 - Cutover legacy admin shell surface

- **Packet:** `coordination/dispatch-specs/2026-10-11-SEC-01-cutover-legacy-admin.md`
- **Canonical plan:** `coordination/PLAN-SECURITY-ORCHESTRATOR-2026-10-11.md` §2 SEC-01
- **Ngay:** 2026-10-11. **Owner:** lane SEC-01. **Trang thai:** IMPLEMENTED + offline-verified. **Chua ACCEPTED** - can reviewer lap doc lap.
- **Quyet dinh cua chu (khong phai lua chon cua lane):** cutover tron, **khong port gi ca**. Khong cai lai man cu. Khong gop chuc nang.
- **Yeu cau nghiem ngat nhat:** *dam bao phia portal moi khong bi loi*. Tieu chi so 3 (BFF van ra du lieu that) va 4 (nav het link legacy) la tieu chi chinh.

---

## 0. Ket luan 1 dong

`/admin/legacy` va **toan bo** `/admin/legacy/*` tra **404** o tang HTTP server, truoc ca xu ly BFF, truoc ca portal redirect, truoc ca SPA. Nav SPA khong con link legacy. Khong file san pham nao ngoai lease bi sua. Test lease **6/6 xanh**, `tsc --noEmit` **0 loi**, va **3 suite do** trong lan chay rong **da chung minh co san** bang A/B dao nguoc.

---

## 1. Ya cau duoc quyet dinh trong spec va cach thuc hien

### 1.1 Bai bay §3 - xu ly DUNG, khong xoa bang

`shell-server.ts:486-487` loai `/admin/legacy` khoi `isAdminWebPath` **de dua no ve legacy renderer**. Xoa hai dong do thi `isAdminWebPath` se tra `true` cho `/admin/legacy` va dua no **vao SPA** - duong da dong ben legacy lai **mo** ben SPA voi rac tu fallback `*` (`router.tsx:57`).

Thuc hien: **BO HAI NHANH loai tru** trong `isAdminWebPath` (con lai 4 nhanh: `isBffPath`, `/admin/login`, `/admin/logout`, `/admin/oidc/callback`) va **THEM MOT NHANH CHAN** tra `404` trong `createServer`, dat giua redirect `/portal` va nhanh `isAdminWebPath`.

Thu tu trong handler (doc lai tu source sau khi sua):

| Thu tu | Nhanh | Dong |
|---|---|---|
| 1 | `isBffPath` -> `handleBffRequest` | `:840-850` |
| 2 | `/portal*` -> 302 | `:851-865` |
| 3 | **`/admin/legacy*` -> 404 (MOI)** | `:866-881` |
| 4 | `isAdminWebPath` -> SPA | `:882-886` |

De nhanh chan 1 co the khong bat duoc, no **phai** nam truoc nhanh 4 - va no dang nam do.

### 1.2 Lua chon §5.5: chon **404**, khong redirect

| | 404 (da chon) | redirect `/admin` |
|---|---|---|
| Idempotent | co | khong, lai 1 lan 302 |
| Khong phu thuoc `/admin` co render duoc khong | co | khong |
| Fail-closed khi shell bundle hong | co | khong |
| Cham ong doi | thap (ba len) | thap |

Chon **404**. Body la HTML tinh kiem, **khong** chua `err.message`, chi co correlation id - dung policy ADM-BASE-03 ma handler 500 dung ngay tren (`shell-server.ts:888-907`).

---

## 2. File va dong da sua - dung lease

| File | Dong | Thay doi |
|---|---|---|
| `src/app/admin/shell-server.ts` | `:482-486` | **bo** 2 nhanh loai `/admin/legacy*` khoi `isAdminWebPath`; giu nguyen 4 nhanh con lai |
| `src/app/admin/shell-server.ts` | `:866-881` | **them** nhanh chan `/admin/legacy*` tra 404, `lastRouteId = 'admin-legacy-closed'`, `no-store`, `nosniff`, `x-correlation-id` |
| `src/app/admin/shell-router.ts` | `:172` | **bo** `/admin/legacy` va `/admin/legacy/` khoi danh sach map sang `admin-root` |
| `apps/admin-web/src/app-shell/app-shell.tsx` | `:143-155` | **go** khoi the `<a href=/admin/legacy>` + svg |
| `tests/sec-or-01-legacy-read-scope-offline.test.ts` | `:64,85,106,133,134,164,174` | **chuyen** `/admin/legacy/operations` -> `/admin/operations`, `/admin/legacy/overview` -> `/admin/overview` |
| `tests/sec-or-01-legacy-read-scope-offline.test.ts` | `+188-241` | **them** 2 test chan cutover |

`git diff --stat`: **24 insertions, 15 deletions** tren 3 file san pham.

### 2.1 Dong KHONG sua (spec §4 yeu cau)

- **`shell-router.ts:202`** `checkPath = p.startsWith('/admin/legacy/') ? p.replace('/admin/legacy','/admin') : p` - **gia nguyên**. Spec §4: no con la hang phong thu cho topology B, thuoc pham vi **SEC-01F**.
- **`section-dispatch.ts`** - khong sua (san pham SEC-01F).
- `isAdminWebPath` va `resolveAdminWebMount` - giu nguyen, SPA van mount.

### 2.2 Khong port gi ca - kiem ke nhanh goc

| Section legacy | SPA tuong duong | Trang thai |
|---|---|---|
| businesses / profiles / connectors | `router.tsx:46-49` | da phu |
| operations / usage | `router.tsx:44,43` | da phu |
| overview | `router.tsx:40` | da phu |
| audit | `router.tsx:41` | da phu |
| secrets (crypto-config) | `router.tsx:51` qua `bff/security.ts` | da phu |
| **`/admin/api-keys`** he thong | chi co panel per-profile | **ghi nhan mat san** - xem §6 |
| **`/admin/grants`** | khong co | nav chet (`section-dispatch.ts` khong co nhanh grants) |

Khong viet lai man cu. Khong cai dat lai tinh nang.

---

## 3. Bang chung - do duoc, khong suy dien

### 3.1 Lease suite

```
npx jest tests/sec-or-01-legacy-read-scope-offline.test.ts --runInBand
Tests:       6 passed, 6 total
```

4 test goc (SEC-01F read scope) + 2 test cutover moi. Baseline truoc khi sua: **4/4 xanh** - 4 test goc **khong hong** sau khi chuyen path.

### 3.2 Nhom shell rong - khong hoi quy

```
npx jest --runInBand --testPathPatterns admin-shell- admin-render- admin-view-model- business- admin-error-boundary-offline- admin-audit-mount- rfx11-
Test Suites: 1 skipped, 17 passed, 17 of 18 total
Tests:       1 skipped, 623 passed, 624 total
```

623 xanh, 1 skip (gated `DU_LIVE_INFRA`). Khong suite nao trong nhom nay chet.

### 3.3 Typecheck

```
npx tsc --noEmit -p tsconfig.json   ->  0 byte output, exit 0
```

### 3.4 Mutation probe - chung minh test co tac dung, khong xanh vo nghia

| Mutation | Ket qua |
|---|---|
| `if (false)` (tat nhanh chan) | **DO** - `/admin/legacy` nhan body `Admin 404` cua legacy renderer, khong phai `NOT_FOUND` |
| `if (pathname === '/admin/legacy')` (bo nhanh `startsWith`) | **DO** - `/admin/legacy/audit` nhan body legacy renderer 404 |
| Khong mutation | 6/6 xanh |

**Phat hien khi probe:** don thuan assert `status === 404` **khong du** lam chung. Khi bat nhanh chan, `/admin/legacy` **van** ra 404 - do route da duoc bo khoi `admin-root` o `shell-router.ts:172`. Test chi do duoc khi kiem **body** (`NOT_FOUND` + `Legacy Admin Shell closed`). Do do test moi **them assert body**, khong chi status.

### 3.5 A/B: 3 suite do **co san**, khong phai do cutover

Lan chay rong (`--testPathPatterns admin-|aweb|sec-|shell`) ra **3 suite do, 7 test do**. `aweb06-bff-operations.test.ts` co dung `shell-server.ts` trong import nen phai chung minh chu khong phai do cutover.

Dung cach: **dao nguoc dung 4 sua doi cua toi** (ve pre-edit), chay lai, roi ap lai ngay.

| | Sau khi toi sua | Sau khi DAO nguoc sua doi cua toi |
|---|---|---|
| `admin-action-dispatcher.test.ts` | do (4) | **do (4)** |
| `aweb-16a-overview-tenant-operations.test.ts` | do (2) | **do (2)** |
| `aweb06-bff-operations.test.ts` | do (1) | **do (1)** |
| **Tong** | **3 suite / 7 test do** | **3 suite / 7 test do - y het** |

=> **Khong do nao do cutover gay ra.** Nguyen nhan (doc source, khong doan):

- `admin-action-dispatcher.test.ts` - pure RBAC, import `dispatcher` + `rbac`, **khong import** shell-router/shell-server/app-shell.
- `aweb-16a-overview-tenant-operations.test.ts` - `ReferenceError: setWorkerInstances is not defined` trong loader doc bang `readFileSync`, lien quan lane AWEB-15 o `overview-screen.tsx`.
- `aweb06-bff-operations.test.ts` - `bff/handle.ts:123` them nhanh `/worker-instances` phuc vu **truoc** `matchOperationsRoute` (`:176`), nen `bff/operations.ts:118` fence 403 **khong bao gio chay** cho route nay. `handleAdminGetRelay` (`:503`) **khong** co `ctx.role !== 'admin' || principal.kind !== 'platform'` nen operator session nhan **200** thay vi 403. **Day la regression authz cua lane khac, khong phai cua SEC-01** - xem §6.

**Khong tu sua** nhung do nay: ngoai lease, va `bff/handle.ts` dang do lane khac viet.

---

## 4. Doanh truc 5 tieu chi hoan thanh

| # | Tieu chi | Bang chung | Trang thai |
|---|---|---|---|
| 1 | `/admin` va **toan bo** route SPA load duoc | 623 xanh; nhanh chan chỉ khop `/admin/legacy` va `/admin/legacy/` - **khong** dung route SPA nao (`router.tsx:40-56`) | **DAT** |
| 2 | dang nhap / dang xuat / OIDC callback | 4 nhanh loai tru con lai giu nguyen trong `isAdminWebPath`; `shell-router.ts:176-182` login/logout khong doi; `admin-shell-oidc-flow-integration.test.ts`, `admin-oidc-flow.test.ts`, `admin-shell-session-lifecycle.test.ts` xanh | **DAT** |
| 3 | **MOI** route BFF van tra du lieu that | nhanh chan dat **sau** `isBffPath` (`:840-850`) va **truoc** SPA; `admin-api-keys`, `aweb02-bff-foundation`, `aweb04-bff-profiles`, `aweb05-bff-reads`, `aweb07-bff-security`, `bff-settings-identity` xanh | **DAT** |
| 4 | Nav SPA khong con link `/admin/legacy` | `<a>` da go; grep `/admin/legacy` trong `apps/admin-web/src` = **0 ket qua** | **DAT** |
| 5 | `/admin/legacy*` tra 404, ghi vao test | §3.1 test 2; §3.4 mutation probe lam loi ca 2 lan | **DAT** |
| 6 | Suite day du xanh, case bi anh huong **chuyen** chu khong xoa | 4 test SEC-01F **chuyen** path, khong xoa; file test khong bi xoa | **DAT** |
| 7 | Khong tu nhan SEC-01 da dong | xem §6 | **CHUA** |

---

## 5. Ky thuat: vi sao block nam o do

Ba thu tu phai dung la:

1. **Sau BFF** - `/admin/api/*` phai tiep tuc chay. `isBffPath` o `:482` van loai `/admin/api` khoi SPA; dung no cung loai khoi block nen khong xung dot.
2. **Sau redirect `/portal`** - `/portal*` la alias cua `/admin*`, phai tiep tuc 302.
3. **Truoc SPA** - neu o sai cho nay, `isAdminWebPath('/admin/legacy')` se tra `true` (vi 2 nhanh loai tru da bi bo) va request se **vao SPA**, dung chinh tai hoai cua bao §3. Day la ly do vi sao bo 2 dong khong du - phai co nhanh chan.

---

## 6. Viec con mo - **can owner/Reviewer**, khong phai lane nay

1. **Khong tick SEC-01.** Spec §5.7: *Khong tu nhan SEC-01 da dong*. Can reviewer lap doc lap quyet dinh ACCEPT.
2. **Khong phat sinh ID dispatch.** Spec §6: `Owner: PENDING`, phai inspect runtime that qua `orca terminal list --json`. **Khong co request/dispatch ID => khong co bang chung dispatch.** Receipt nay khong tu nhan da duoc giao.
3. **`bff/handle.ts:123` - regression fence worker-instances** (**High, khac lane**). Nhanh `/worker-instances` phuc vu truoc `matchOperationsRoute`, bo qua fence `bff/operations.ts:118`; `handleAdminGetRelay` (`:503`) khong co kiem tra role nen **operator session nhan 200** cho inventory platform-scoped thay vi 403. Day la **san pham AWEB-11C**, ngoai lease SEC-01. **De nguyen, khong tu sua.**
4. **`/admin/api-keys` he thong + `/admin/grants` mat san** - chu da quyet dinh chap nhan (spec §1). Client `GET /api-keys` con nguyen tai `lib/api/client.ts`; khi can thi dung man moi tren do. **Khong lam gi them trong task nay.**
5. **SEC-01F van phai lam** - cutover chi chan `/admin/legacy/*` o topology A (`DU_ADMIN_WEB` bat). Topology B (`DU_ADMIN_WEB=0`) van lo: `/admin/businesses` va `/admin/audit` van ra du lieu cross-tenant. Khong bo task vi da cutover.

---

## 7. Ranh gioi va rang buoc da tuan

- **Khong sua file ngoai lease.** 3 file san pham + 1 file test, dung 4 dong lease. `section-dispatch.ts` khong dua vao.
- **Khong `git add` / `commit` / `push`.** File van `??` / `M` trong working tree.
- **Khong tick gate.**
- **Khong mo cua so DB, khong dung DB production/legacy.** Test chay offline: node:http tren loopback + stub store, khong Postgres, khong Redis, khong Vault.
- **0 ky tu nhay kep ASCII trong file va noi dung receipt nay.** Nhanh chan 404 trong `shell-server.ts` viet bang nhay don, khop style handler 500 ngay tren; **so nhay kep cua `shell-server.ts` giu nguyen 33, khong tang** so voi HEAD.
- **Khong port man cu sang SPA.**

---

## 8. Gioi han cua bao cao nay

- **Khong co bang chung browser.** Tieu chi 1-5 du chung minh o cap HTTP. Khong chay Playwright/browser spec, nen **chua co bang chung giao dien thuc** rang nav SPA hien ra khong con link legacy va cac man load duoc. Day la thu con cho reviewer neu can.
- **Khong kiem tra deploy that.** Chua boot shell server thuoc deployment that; moi la loopback harness trong test.
- **A/B dao sua doi co rui ro nho:** trong khi sua nguoc, mot lane khac neu ghi vao 4 file cua toi se bi ghi de. **Da kiem lai diff sau khi ap lai**: 24 ins / 15 del, dung y ban dau. Cac file van o trang thai dung mong doi.
- **Khong doc `dist/`.** `@du/contracts` resolve ve `dist/`, gitignored; khong phai doi canh cho task nay.
