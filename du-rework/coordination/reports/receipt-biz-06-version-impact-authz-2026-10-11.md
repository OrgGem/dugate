# BIZ-06 - Tenant isolation & authz: `GET /api/v1/admin/businesses/{businessId}/versions` + version change impact preview

- **Packet:** BIZ-06 - **chi danh gia + proposal, khong sua code san pham.** 0 edit source/test/migration; khong `git add`/`commit`/`push`.
- **Ngay:** 2026-10-11. **Owner:** lane BIZ-06. **Trang thai:** PROPOSAL - chua IMPLEMENTED, chua co verdict lap doc lap.
- **Lease:** READ-ONLY tren `D:/Git/dugate/du-rework`.
- **Quan trong:** working tree `da doi trong luc bao cao nay duoc tao`. `src/http/routes/admin.ts` la **1171 dong** khi doc lan dau, **1286 dong** khi doc lan hai - mot lane khac (BIZ-10/BIZ-11) ghi vao giua chung. Moi `file:line` ben duoi la **hien hanh** (lan h2), khong phai lan dau. Xem header cua file.
- **Cong cu:** doc file + grep. **Khong chay test, khong boot app, khong chua DB/Redis/S3/Vault** (khong co cua so). Xem §7.

---

## 0. Ket luan 1 dong

**Hai surface trong packet co HAI tu thé authz nguoc nhau, va lech nam ngay giua chung:**

- **Impact preview** (`GET .../versions/{version}/impact-preview`) - da co fence tenant **hai lan** (principal scope + SQL ownership) va tra 404 **dong nhat** cho unassigned / foreign / missing. **Dung.**
- **Versions list** (`GET .../versions`) - **khong co** ownership join, doc thang `business_versions`, chi fence role (platform bearer), va co **200** cho business ma impact preview tu choi. **Khong dat yeu cau packet.**

Nen cau tra loi packet **khong the bang cach them fence vao route tai kiem** duoc: mo hinh ownership **da ton tai** (`business_catalog.owner_tenant_id`, migration 0043) nhung route tai kiem **khong goi no**. F1. Ket thuc o §3.

---

## 1. Bang chung E1-E21 (hien hanh)

| # | Nguon | Doc duoc |
|---|---|---|
| E1 | `migrations/0043_business_catalog.sql:3-11` | `business_catalog(business_id PK, owner_tenant_id uuid NULL, lifecycle_revision, created_at, updated_at)` + FK to `tenants` |
| E2 | `migrations/0043_business_catalog.sql:1` | comment: existing business rows remain unassigned until an authoritative tenant map is reviewed |
| E3 | `migrations/0043_business_catalog.sql:17-22` | seed INSERT chi dat `business_id`, `created_at`, `updated_at` - **`owner_tenant_id` de NULL** cho MOI business hien co |
| E4 | grep `business_catalog` trong `src/` | **chi co SELECT** (6 vi tri). **Khong co INSERT/UPDATE nao** dat `owner_tenant_id`. Khong co code path nao assign owner |
| E5 | `migrations/0001_platform_v1.sql:24-35` | `business_versions` khong co `tenant_id` - PK `(business_id, version)` |
| E6 | `src/http/routes/admin.ts:635-666` | route versions list: `assertAdminAuth` `:637`, `decodeURIComponent(m[1]!)` thuan `:638`, `listBusinessVersionPage` `:640` |
| E7 | `src/modules/admin-read/business-list.ts:88` | `clauses: ['business_id = $1']` - **khong join `business_catalog`** |
| E8 | `src/http/routes/admin.ts:113-147` | **BIZ-11** impact-preview: `resolveAdminPrincipal` + `authorizeAuditTenantRead`, query allowlist chi `tenantId`+`action`, 422 khi platform thieu `tenantId`, dung `decodeBusinessPathSegment` |
| E9 | `src/modules/admin-read/business-impact-preview.ts:119-121` | query muc tieu join `business_catalog bc ... WHERE bc.owner_tenant_id=$1 AND bc.business_id=$2 AND bv.version=$3` |
| E10 | `src/modules/admin-read/business-impact-preview.ts:96-98`, `:134-171` | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`; **ca 4** query phu thuoc deu lap lai `bc.owner_tenant_id=$1` |
| E11 | `src/modules/admin-read/business-impact-preview.ts:207-209` | 404 mot cau: `business version was not found for this tenant` - khong phan biet unassigned / foreign / missing |
| E12 | `src/http/routes/admin.ts:474-517` | **BIZ-10** tenant catalog: tenantId tu path, UUID-validate, `authorizeAuditTenantRead` |
| E13 | `src/modules/admin-read/tenant-business-catalog.ts:171`, `:181`, `:210` | fence `c.owner_tenant_id = $1::uuid` ap dung cho **ca** page va count |
| E14 | `src/app/admin/bff/operations.ts:111-130` | BFF fence: `businesses` / `business-versions` / `business-action` / `worker-instances` deu yeu cau `ctx.role === admin` + `principal.kind === platform`, nguoc lai 403 `ADMIN_CREDENTIAL_REQUIRED` **truoc** khi tao upstream URL |
| E15 | `src/app/admin/bff/operations.ts:282-287` | nhanh `business-versions` **khong forward** query param nao |
| E16 | `src/app/admin/bff/upstream.ts:71-85`; `:71-85` | `decodePathSegment` bound 128, chan `/` `\` `.` `..`, catch decode loi |
| E17 | `src/http/routes/admin.ts:70-81` | `assertAdminAuth` so sanh `auth !== ` + `Bearer ${adminToken}` - **chuoi thuan** |
| E18 | `src/http/routes/admin.ts:97-107` | `decodeBusinessPathSegment` **da ton tai** (bound 256, chan control char, 422 khi malformed) - dung boi BIZ-11, **khong** dung boi versions list |
| E19 | `tools/openapi/gen_openapi.py:744`, `validate_openapi.py:30-32` | chi 3 path **PUT** duoc publish. **Ca** versions list va impact-preview deu khong co trong OpenAPI |
| E20 | `tests/biz-11-version-impact-preview.test.ts` | 6 test offline (stub db): pin 403 foreign tenant (upstream khong bi goi), 404 dong nhat, 422 query dong, redaction secret, repeatable-read |
| E21 | `tests/business-catalog-contract-conformance.test.ts:331-335` | pin `c.owner_tenant_id = $1::uuid` trong ca page va count |

Go them: grep `impact` + `business_catalog` trong `src/app/admin/bff` va `apps/admin-web/src` -> **0 ket qua**. **BIZ-10 va BIZ-11 khong co BFF route, khong co admin-web client.** Chi goi truc tiep `:3002` bang bearer.

---

## 2. Findings

### F1 - Versions list **khong** join `business_catalog`, song song voi impact preview **co** (High)

Cung mot prefix duong dan `businesses/{id}/versions`, hai route, hai tu thac khac nhau:

| | versions list (`admin.ts:635-666`) | impact preview (`admin.ts:113-147`) |
|---|---|---|
| auth | `assertAdminAuth` - platform bearer | `resolveAdminPrincipal` + `authorizeAuditTenantRead` |
| SQL | `clauses: ['business_id = $1']` (E7) | `bc.owner_tenant_id=$1` (E9) |
| khong co owner | **200** + data | **404** (E11) |
| disclosure | phan ky businessId (F5) | 404 dong nhat |
| admin-web co tiep can | **co** (E14) | **khong** |

Lech nay la lo hong that, khong phai hieu ung phu: **`tenantId` ma impact preview choi la businessId ma versions list phuc vu day du**. Them fence vao impact preview la **trang tri** neu route con cua chinh no khong scoping.

Chon 2 duong, khong co duong thu 3:

- **W-a**: versions list gan `business_catalog` (JOIN hoac subquery) de **cuong business unassigned -> 404**, dong nhat impact preview. Can F2 truoc.
- **W-b**: chot la versions list **la platform registry doc lam** (nhu 3 route PUT lan truoc), viet hoa dieu do vao contract, va xoa FENCE co gia tu impact preview. Can owner chot.

### F2 - **Khong code nao ghi `owner_tenant_id`** (High, bi mo hinh du lieu chan)

E3 seed NULL cho ca bo. E4: grep toan `src/` khong co INSERT/UPDATE nao vao `business_catalog`. `tenant-business-catalog.ts:171` va `business-impact-preview.ts:121` deu loc `owner_tenant_id=$1`.

=> **BIZ-10 tra rong va BIZ-11 tra 404 cho MOI business hien co**, cho toi khi owner duoc assign thu cong, va **khong co ngu nao assign**. Migration 0043 comment cung viet vay: coi nhu **quyet dinh policy con hang**, chua phai nguon du lieu.

Day la blocker cua ca F1: fence dung nhung surface toi. Can: (a) bang assign map cua admin, (b) suy ra tu `operations.tenant_id`, (c) accept rang BIZ-10/BIZ-11 la tool quan tri, chua pham vi tenant operator.

### F3 - `assertAdminAuth` khong constant-time (High, sua ngay)

E17. Route tai kiem la `:637`, 19 call site. `constantTimeEquals` da co tai `src/modules/admin-actions/rbac.ts:434-439` va `rbac.ts:38-46` giai thich ro vi sao phai dung. Fix 1 cho, khong doi wire, khong doi status.

### F4 - Route tai kiem khong dung `decodeBusinessPathSegment` (Medium, sua ngay)

E18: helper da san sang, 90 dong tren trong cung file, dung boi BIZ-11. Route tai kiem van goi `decodeURIComponent(m[1]!)` thuan (`:638`). `%zz` -> `URIError` -> khong phai `HttpError` -> generic 500, trong khi BIZ-11 tra 422. `%2F` giai ma thanh `/` roi vao message 404. Route `workflows` cung file cung bound businessId 256 (`:591-593` vung) - day la **ngoai le**.

### F5 - Hai tu thac disclosure nguoc nhau (Medium)

- versions list `:641`: `business '${businessId}' is not registered` - phan ky nguyen tu caller, khong gioi han.
- impact preview `:207`: 404 dong nhat (E11).

BFF `upstreamProblem` (`bff/envelope.ts:66-73`) thay message bang text hang dong, nen **qua BFF ca hieu ung deu khong lo**. Chi lo ra voi goi truc tiep `:3002`.

### F6 - Khong co audit row tren ca hai route (Low-Medium)

3 route PUT ghi `tenantId: null` + comment giai thich (`admin.ts:105-108`, `:132-135`, `:159-162`). **Ca 2 route doc deu khong ghi**. Neu F2 duoc quyet dinh, day la noi them doc-audit.

### F7 - Hai route doc deu khong co trong OpenAPI (Low)

E19. `apps/admin-web/src/features/docs/docs-screen.tsx:84` lai hien `Businesses/versions` trong danh sach doc. Doc khong khop contract.

### F8 - BFF drop pagination tren versions list, khong co cho impact preview (Low-Medium)

E15 + §1 cuoi cung. `BUSINESS_PARAM_ALLOWLIST` duoc forward o route `/businesses` (`:260-268`) nhung khong o `business-versions`. Va **khong co BFF route cho BIZ-10/BIZ-11** nen frontend khong bao gio tiep can duoc surface tenant-fenced.

---

## 3. Tra loi truc tiep cau hoi cua packet

**Dam bao chi tra version thuoc business do tenant so huu?**

- **Tai kiem (versions list): KHONG, va khong the bang them fence vao route.** Can join `business_catalog` (F1 W-a) **sau** khi F2 quyet dinh nguon owner. Khong co thu tu nao khac hop le.
- **Impact preview: CO, da dat.** Principal scope + SQL fence + 404 dong nhat + khong secret field. Hien **toi** vi `owner_tenant_id` chua bao gio duoc ghi (F2).

**Khong de ro sang tenant khac?** Ca hai surface deu khong ro - ly do khac nhau: impact preview vi **SQL fence**; versions list vi **khong co du lieu tenant nao trong ket qua** (E5). Nhung F1 cho thay **khong co nghia la an toan**: mo hinh tenant scoping da ton tai ma mot trong hai route cung prefix khong goi no.

---

## 4. Cac phat hien lan can (goi y, khong phai pham vi packet)

### A1 - `cursorSecret` fallback chain lam cho 503 khong the cham (Medium)

`admin.ts:496-500`: `ctx.config.adminShellCookieSecret || ctx.config.adminToken || tenantTokenSeed`. `tenant-business-catalog.ts:162` neu `!cursorSecret` -> 503, nhung route **cam** cho truoc bang fallback, nen 503 la code chay khong toi. Deployment khong cookie secret + khong admin token co the ky cursor bang **chuoi la `{}`** (khong co tenant token nao). Day la secret material - khong nen sinh tu credential table.

### A2 - BIZ-10 404 phan biet tenant khong ton tai voi catalog rong (Low)

`tenant-business-catalog.ts:166-169` tra 404 `tenant not found` cho tenant khong co trong bang `tenants`, trong khi catalog rong la 200 empty. BIZ-11 (E11) lam dung hon: 404 dong nhat. Hai route cung mo hinh ownership, hai tu thac disclosure.

### A3 - Form enable/drain/retire cua legacy shell post vao shell path (Low)

`business-section-renderer.ts:151` -> `POST /admin/businesses/:id/versions/:action` -> `matchShellRoute` khop `section:businesses` -> 405 text hang dong (`shell-router.ts:285-297`). Khong bao loi; mutation that di qua BFF PUT. Chi ghi de khong ai lai bao authz hole.

---

## 5. De xuat

| # | Hanh dong | Chu | Phu thuoc |
|---|---|---|---|
| W1 | Assign owner: bang quyet dinh cua admin **hoac** suy ra tu `operations.tenant_id` | **owner** | - |
| W2 | `assertAdminAuth` -> `resolveAdminPrincipal` + `role === platform` | orchestrator | - |
| W3 | `decodeURIComponent` `:638` -> `decodeBusinessPathSegment` (da co) | orchestrator | - |
| W4 | 404 dong nhat tren versions list (khong phan ky businessId) | orchestrator | - |
| W5 | Forward `BUSINESS_PARAM_ALLOWLIST` o `business-versions` | bff | - |
| W6 | Publish ca 2 route vao OpenAPI | orchestrator + docs | - |
| W7 | `cursorSecret` boc tach: neu khong co cookie secret -> 503, khong fallback toi credential | orchestrator | - |
| W8 | **Sau W1**: versions list join `business_catalog` (hoac chot W-b platform-registry) | orchestrator | W1 |
| W9 | Them cho audit cho 2 route doc | orchestrator | W1 |
| W10 | Pin offline: 404 uniform, `%zz` -> 4xx khong phai 500, 401 tenant-operator | test | - |

W1-W7 va W10 doc lap, khong can migration, khong doi wire contract. W8 can W1. **Khong chay bat ky thu nao truoc khi W1 co dap an**.

---

## 6. Can owner chot truoc khi lane nao bat dau

1. **F2 - nguon `owner_tenant_id`?** Bang admin-map, suy ra `operations.tenant_id`, hay accept la platform-global va chi dung cho quan tri? **Quyet dinh nay chan W8, W9, va chinh y nghia cua BIZ-10/BIZ-11.**
2. **F1 - W-a hay W-b?** Them fence vao versions list, hay chot la platform registry va bo fence impact preview?
3. **A1 co sua ngay khong?** De day la bo nho.

---

## 7. Gioi han cua bao cao nay - doc truoc khi dung

- **Khong chay test nao.** Claim ve BIZ-11 la **tuoc vi doc source** (6 test, `tests/biz-11-version-impact-preview.test.ts`), chua xac nhan **pass**. `biz-10` contract conformance pin `c.owner_tenant_id = $1::uuid` (`business-catalog-contract-conformance.test.ts:331-335`).
- **Khong co live window.** Hai suite duy nhat goi route tai kiem qua HTTP - `admin-base-routes.test.ts`, `runtime-admin-auth.test.ts` - deu `DU_LIVE_INFRA` gated. **Khong co bang chung runtime offline** cho route tai kiem.
- **Working tree da doi giua bao cao** (xem header). Moi line cite la lan h2. Neu ai do vua doc receipt cu (truoc khi file duoc ghi lai), **no da sai**.
- **F3 chua do duoc tren wire.** Goi la *opportunity*, khong phai *da khai thac*.
- **Khong kiem tra deployment**: khong ro co deployment nao khong dat `tenantAdminTokens`. Neu rong, `tenant_operator` khong ton tai.
- **Chua check `dist/`**: `@du/contracts` resolve ve `dist/`, gitignored.

**Khong dung file nay de tick gate.** Day la PROPOSAL doc-only; can reviewer lap doc lap moi ACCEPT.
