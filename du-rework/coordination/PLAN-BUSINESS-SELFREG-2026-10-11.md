# Plan: Business self-registration + business-level lifecycle (BIZ-SELFREG)

- Ngay: 2026-10-11 (Asia/Bangkok)
- Vai tro: Claude Code coordinator (theo `COORDINATOR-CONTRACT.md`)
- Repo scope: `du-rework`. Khong dung legacy root, khong mo DB production/legacy.
- Nguon yeu cau: nguoi dung 2026-10-11 (Q1 + Q2), bo sung cho review 7 yeu cau cung ngay.
- Ke thua: `PLAN-PORTAL-BUSINESS-PROFILE-2026-10-10.md` (AWEB-11C / AWEB-13 / AWEB-14 da duoc implement roi — xac nhan lai o §2).
- Trang thai: **SPECIFIED / chua dispatch.** Owner = PENDING; khong terminal nao dang rong (§7).
- Rang buoc: khong commit, khong git add, khong push, khong tick gate. File nay 0 ky tu nhay kep ASCII.

---

## 0. Hai quyet dinh cua nguoi dung (2026-10-11)

**Q1 — Worker duoc tu dang ky.** Gate dang ky phai kiem tra chinh xac business co da duoc dang ky chua, bang credential/token cua orchestrator. Can check version day du de biet business version moi the nao tren tung worker. Khi user chon mot business se thay cac business version; trong moi business version co cac worker tuong ung (mot business nhieu worker). **Enable chi nam o cap business hoac business version**; worker chi hien trang thai active/inactive (on/off). Luong api nay la **internal api, khong public ra ngoai**.

**Q2 — Trang thai business tuong ung Q1.** Suy ra tu Q1: phai co trang thai o cap business, khong chi o cap version.

### 0.1 Di gia coordinator doc lai va phien dich (de executor khong suy dien)

| Yeu cau | Doc lai chinh xac | Ke qua thiet ke |
|---|---|---|
| Check business da dang ky chua, bang credential cua orchestrator | Token worker **da** goc trong config `workerIdentityTokensByBusiness`, khoa 1-1 voi `business_id` | Business phai duoc cap token truoc khi tu dang ky. Khong can duong bootstrap moi — xem D-BIZ-1 |
| Check version day du | `registry.registerVersion` **da** lam dung: `SELECT ... FOR UPDATE` theo (businessId, version), digest khac → 409, digest giong → 200 replay | Khong viet lai. Xem D-BIZ-2 |
| Version moi the nao tren tung worker | `worker_instances.business_version` **da** duoc ghi boi heartbeat, va `listWorkerInstances` **da** tra `business_version` | Chi con nhom theo version o UI. Xem D-BIZ-6 |
| Enable o business hoac business version | Da co ca hai truc: `business_catalog` (moi, rong) va `business_versions.is_active` (da co, 2 cong chan) | Giu ca hai. Xem D-BIZ-4 |
| Worker on/off | `worker_instances.state IN (ONLINE, DRAINING, OFFLINE)` da co | Khong them gi. Xem D-BIZ-6 |
| Internal api | `server.ts:318-324` **da** chan worker token ra khoi `/api/runtime/v1/` | Da duoc bao dam san. Xem D-BIZ-7 |

---

## 1. Hien trang kiem chung tren source (doc truc tiep, khong dua vao report)

### 1.1 Cong dang ky — ton tai, chi bi chan

- Route: `src/http/routes/runtime.ts:348-355` — `PUT /api/runtime/v1/businesses/:businessId/versions/:version`, goi `ctx.registry.registerVersion(ctx.body)`.
- Chan hien tai: `assertPlatformRuntimeAuth` tai `runtime.ts:30-37`. Dong 33-34 tra **403** `worker credentials cannot register business versions` neu bearer resolve ra duoc mot business. Day la tu cho co chu dich, khong phai thieu code.
- `isAuthorizedRuntimeBearer` tai `worker-identity.ts:23-29` chap nhan **ca hai**: platform runtime token **va** worker token. `assertRuntimeAuth` tai `runtime.ts:22-28` dung chinh ham do va tra ve business id cua worker.

### 1.2 Co che danh tinh worker da manh hon y tuong

- `worker-identity.ts:41-51` — `resolveWorkerBusinessIdentity` tra `null` neu token khop **nhieu hon mot** business; chi tra business id khi khop **dung mot**. Token la ban khoa danh tinh, khong phai bearer chung.
- `worker-identity.ts:71-77` — `authorizeWorkerClaim` da co san dung y dung cho cong dang ky: reject khi body khai mot business khac voi business cua token.
- `worker-identity.ts:79-101` — `validateWorkerIdentityConfig` **tu choi boot** neu token worker trung voi token khac, hoac trung voi `runtimeToken` / `adminToken` / `usageToken` / tenant admin token.
- ⇒ Khong ton tai duong de worker A lenh danh dang business B. Day la nen cho D-BIZ-1.

### 1.3 Internal api — da fail-closed o tang server

`src/server.ts:318-324`:

```
const workerBusinessId = resolveWorkerBusinessIdentity(ctx.config, ctx.headers['authorization']);
if (workerBusinessId && (!pathname.startsWith('/api/runtime/v1/') || pathname === '/api/runtime/v1/usage-events')) {
  throw new HttpError(403, 'PERMISSION_DENIED', 'worker credentials cannot access this API surface');
}
```

- Worker token chi dung duoc o `/api/runtime/v1/`, tru route usage-events (dung usage token khac).
- `server.ts:374-379` thu runtime → public → admin theo thu tu, cac prefix lech nhau. Route dang ky nam trong runtime nen khong bao gio chui sang public.

### 1.4 Registry registration — da co san semantics day du

`src/modules/registry/registry.ts:59-99`, trong mot transaction:

1. `SELECT digest, status, manifest, created_at ... FOR UPDATE` theo (business_id, version) — dong 60-63.
2. Da co row va digest **khac** → **409** `MANIFEST_DIGEST_MISMATCH` — dong 71-77.
3. Da co row va digest **giong** → validate bang `RegistrationRecordSchema` roi tra replay idempotent — dong 78-91.
4. Chua co row → INSERT `status = REGISTERED_DISABLED` — dong 93-97.

Yeu cau *check chinh xac business da dang ky chua* + *check version day du* da duoc tho a **khong can sua logic nao**.

### 1.5 Registration khong tao hang ownership root

- `grep business_catalog` trong `src/modules/registry/registry.ts` = **0 hit**.
- `migrations/0043_business_catalog.sql:18-22` la **noi duy nhat** ghi `business_catalog`, mot lan seed mot.
- Hai duong doc business lech nhau:
  - Platform list (SPA dung): `http/routes/admin.ts:447` → `modules/admin-read/business-list.ts`, `DISTINCT ON (business_id)` tren `business_versions`.
  - Tenant list: `http/routes/admin.ts:499` → `modules/admin-read/tenant-business-catalog.ts`, loc `c.owner_tenant_id = $1::uuid` tai `tenant-business-catalog.ts:171`.
- ⇒ Business tu dang ky **co** xuat hien tren Business tab (platform list), **khong** xuat hien trong tenant catalog. Dieu nay dung theo thiet ke neu `owner_tenant_id` giu NULL.

### 1.6 Chua co trang thai cap business

- `migrations/0043_business_catalog.sql:3-11`: bang chi co `business_id, owner_tenant_id, lifecycle_revision, created_at, updated_at`. **Khong co cot status.**
- `lifecycle_revision` chi duoc doc: `modules/admin-read/business-impact-preview.ts:62,118,214`. **Khong co writer nao trong repo.**
- Hai cong chan hien tai deu o cap version:
  - `modules/operations/submission.ts:1348-1367` — `resolveEnabledVersion`, fail-closed, tra 404 `no active version for business ...` tai dong 1362.
  - `modules/workflow-schemas/workflow-schemas.ts:280,283` — tu choi workflow gan vao version chua dang ky hoac khong phai active.
- `business_versions.is_active`: migration `0006_active_version.sql:6-7` (cot) va `:23-25` (unique index `(business_id) WHERE is_active`), nghia la **dung mot version active cho moi business**.

### 1.7 Profile bind khong khoa trang thai — lo hong nhat quan

- `grep -c business_versions src/modules/profiles/profiles.ts` = **0**.
- `createRevision` (khoang dong 445) chi kiem tra `businessId` / `businessVersion` / `action` la chuoi non-empty (truoc do tra 422), resolve api key theo hash + `state=ACTIVE`, roi INSERT `profile_bindings`.
- `authorizeProfileApiKey` (khoang 402-419) loc `WHERE p.business_id=$2 AND p.business_version=$3 AND p.action=$4` — **khong co predicate `is_active`**.
- Dispatcher khong bat loi: `modules/admin-actions/dispatcher.ts:715-742` `profile_binding.bind` uoc tiep cho `createRevision`.
- ⇒ Profile co the bind vao version da drain hoac chua ton tai, dung khi workflow **tu choi** chinh truong hop do. Cung vao y cau *user active business de cho phep cac profile nhan business* thi day la cho xuyen.

---

## 2. Xac nhan phan da implement trong plan 2026-10-10

Khong mo ID moi cho nhung phan da xong (tranh lam trung):

| Han muc | Bang chung | Trang thai |
|---|---|---|
| AWEB-11C — worker inventory | `migrations/0042_worker_instances.sql`; `modules/runtime/worker-instances.ts:13-50` ghi that; `modules/admin-read/worker-instances.ts:79-102` doc; `http/routes/admin.ts:531-535` route | **XONG** |
| AWEB-13-UI — panel API key trong profile | `apps/admin-web/src/features/profiles/api-keys-panel.tsx:93` goi `apikey.issue` | **XONG** |
| AWEB-14 — workflow gan business | `migrations/0040_workflow_business_profile_bindings.sql`; `modules/admin-read/profile-workflows.ts:104-131`; `http/routes/admin.ts:868-910` | **XONG** |
| UI activate/deactivate version | `features/businesses/businessescreen.tsx` — dung `client.businessVersionAction(..., activate/deactivate/enable)` qua REST truc tiep, **khong** qua dispatcher `postAction` | **XONG** |
| `business_catalog` ownership root | `migrations/0043_business_catalog.sql` | **XONG** (seed mot) |

**Correction canh bao.** Trong review truoc toi da noi *khong co UI nao dispatch activate*. **Sai.** UI co va hoat dong, qua REST `PUT /businesses/:id/versions/:v/activate` (`http/routes/admin.ts:192`) chu khong qua tu khoa dispatcher `business.activate`. Neu tin bao do se lam trung viec da xong.

---

## 3. Kien truc chot (coordinator chot, ghi ro phuong an thay the)

### D-BIZ-1 — Cong dang ky: tai dung route, chi doi auth

Thay `assertPlatformRuntimeAuth` tai `runtime.ts:351` bang ham moi, **khong tao route moi**:

| Buoc | Hanh dong | Ket qua |
|---|---|---|
| 1 | `isAuthorizedRuntimeBearer(ctx.config, auth)` | false → **401** `UNAUTHENTICATED` |
| 2 | `resolveWorkerBusinessIdentity(ctx.config, auth)` | — |
| 3 | Neu tra business id (worker token) → `authorizeWorkerClaim(ctx.config, auth, businessIdTrongPath)` | business id trong path lech token → **403** |
| 4 | Neu khong tra (platform runtime token) → cho qua | giu nguyen hanh vi hien tai cho orchestrator |

- **Khong** tao co che xac thuc thu hai (tai doc §7 cua plan 2026-10-10 da chot phai dung lai `assertRuntimeAuth` + `authorizeWorkerBusiness`).
- **Khong** them duong bootstrap de business chua co token cung self-register duoc. Business phai duoc orchestrator cap token truoc — chinh la *check business da duoc dang ky chua bang credential cua orchestrator* ma nguoi dung yeu cau.
- Phuong an thay the da can nhac: them token vao manifest tu worker (worker tu cap credential cho chinh no) — **loai**, vi pha vai tro token la ban khoa danh tinh do `worker-identity.ts:79-101` bao ve.

### D-BIZ-2 — Khong sua logic registerVersion

Giữ nguyên `registry.ts:59-99`. Chi them mot INSERT vao cung transaction (D-BIZ-3). Test bat buoc phai khoa 4 nhanh 201 / 200 replay / 409 digest mismatch / 403 business mismatch.

### D-BIZ-3 — Registration tao hang ownership root

Trong cung transaction cua `registerVersion`, them:

```sql
INSERT INTO business_catalog (business_id, created_at, updated_at)
VALUES ($1, statement_timestamp(), statement_timestamp())
ON CONFLICT (business_id) DO NOTHING
```

- **Khong** set `owner_tenant_id` — giu NULL nghia la chua gan tenant, dung comment `0043:2` va dung hanh vi loc cua `tenant-business-catalog.ts`.
- Hieu qua: business tu dang ky van **khong** xuat hien trong tenant catalog (dung — chua co tenant), nhung **co** hang de mang trang thai cap business (D-BIZ-4) va khong con la mau chong ton tai.

### D-BIZ-4 — Trang thai cap business: cot moi tren `business_catalog`, giu `is_active` làm con tro version

Migration moi, additive, khong sua/xoa cot cu:

```sql
ALTER TABLE business_catalog
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'REGISTERED';
ALTER TABLE business_catalog
  DROP CONSTRAINT IF EXISTS business_catalog_status_check;
ALTER TABLE business_catalog
  ADD CONSTRAINT business_catalog_status_check
  CHECK (status IN ('REGISTERED','ACTIVE','DRAINED'));
CREATE INDEX IF NOT EXISTS business_catalog_status_idx
  ON business_catalog (status, business_id);
```

- `lifecycle_revision` **tang 1** moi lan chuyen trang thai. Day la writer dau tien cho cot nay (hien `business-impact-preview.ts` chi doc).
- **Hai truc, hai cau hoi khac nhau — khong phai hai nguon su that:**
  - `business_catalog.status` = business co duoc nhan vao nen tang hay khong (quyet dinh cua operator).
  - `business_versions.is_active` = version nao phuc vu submission moi (da co unique index, 2 cong chan).
- Phuong an thay the da can nhac: bo `is_active`, day len cap business — **loai**. `submission.ts:1348-1367` va `workflow-schemas.ts:280,283` deu doc `is_active`; doi ca hai la blast radius khong can cho yeu cau nay, va mat tinh nang rollback theo version dang co.
- **Rollout:** default `REGISTERED` se khong chan gi ca (chi cong dang ky), nhung D-BIZ-5 moi co hanh dong. Backfill bat buoc: `status = 'ACTIVE'` cho business nao **da co** version dang active. Business dang phuc vu traffic khong duoc bi chan ngoi.

### D-BIZ-5 — Profile bind phai khoa theo business ACTIVE (fix §1.7)

Trong `profiles.ts createRevision`, truoc khi INSERT, kiem tra business co hang trong `business_catalog` voi `status = 'ACTIVE'`; khong co hoac sai trang thai → **409** `BUSINESS_NOT_ACTIVE`. Cung ap cho `authorizeProfileApiKey`: them predicate `EXISTS (SELECT 1 FROM business_catalog c WHERE c.business_id=$2 AND c.status='ACTIVE')`.

- Hang dong nay sua lo hong mot chiieu cua §1.7: worker khong the lenh `profile_binding.bind` vao business chua duoc operator chap thuan.
- **Rui ro rollout — noi ro, khong giu im:** voi backfill D-BIZ-4, moi business co version active da la ACTIVE nen hanh vi hien tai duoc bao toan. Business chi duoc dang ky ma chua co version active se **bi chan** bind moi — **dung tinh**, vi do la tinh nghia user mo ta, nhung phai ghi ro trong receipt.
- `workflow-schemas.ts:268-285` da khoa dung cap version; khong sua, de nguyen.

### D-BIZ-6 — Worker chi co on/off, khong co enable

- `worker_instances.state IN ('ONLINE','DRAINING','OFFLINE')` la trang thai duy nhat. Khong them cot, khong them nut enable o tang worker.
- `listWorkerInstances` (`modules/admin-read/worker-instances.ts:92`) **da** tra `business_version`; nhom theo version trong UI la thuan presentational, khong can doi API.
- `recordWorkerHeartbeat` (`modules/runtime/worker-instances.ts:36`) da ghi `business_version = EXCLUDED.business_version`; worker doi version la dong qua het.

### D-BIZ-7 — Internal api: khong lam them gi

`server.ts:318-324` + `server.ts:374-379` da bao dam route `/api/runtime/v1/*` khong chui sang public/admin. Packet BIZ-02 **phai** co test chung minh bearer worker tren `/api/v1/...` van bi **403** sau khi doi auth cong dang ky — de dam bao viec mo rong nay khong lam lo con fence.

---

## 4. Han muc cong viec

Quy uoc: moi packet phai khai lease chinh xac, phu thuoc, acceptance, receipt. Verifier phai doc lap voi implementer.

| ID | Noi dung | Lease chinh | Phu thuoc | Acceptance |
|---|---|---|---|---|
| **BIZ-01** | Migration `0044` them `business_catalog.status`; backfill theo version active; `registerVersion` tao hang `business_catalog` | `migrations/0044_*.sql`, `src/db/migrations.ts`, `src/modules/registry/registry.ts` | — | Migration chay idempotent 2 lan; backflow co bang chung; `registerVersion` tra 201/200/409 nhu cu va co `business_catalog` row sau moi lan tao moi |
| **BIZ-02** | Cong dang ky cho worker token: ham `assertRegistrationAuth` moi trong `runtime.ts` | `src/http/routes/runtime.ts`, `src/modules/runtime/worker-identity.ts` (chi doc) | BIZ-01 | 6 test: 401 bearer sai; 403 token khai business khac; 403 body business lech path; 201 business moi; 200 replay cung digest; 409 digest khac. **Them 1 test** chung minh worker token tren `/api/v1/...` van 403 |
| **BIZ-03** | SDK worker tu goi dang ky khi khoi dong, truoc heartbeat | `packages/worker-sdk/src/runtime-client.ts`, `packages/worker-sdk/src/worker.ts` | BIZ-02 | Worker SDK bat len voi business+version chua dang ky → registry co row; restart lai → replay 200 khong loi; token sai → loi ro rang |
| **BIZ-04** | Trang thai cap business: route + dispatcher action + UI nut activate/drain o cap business; khoa `createRevision` va `authorizeProfileApiKey` theo ACTIVE | `src/http/routes/admin.ts`, `src/modules/admin-actions/dispatcher.ts`, `src/modules/admin-read/business-catalog-lifecycle.ts`, `src/modules/profiles/profiles.ts` | BIZ-01 | Business khong ACTIVE → profile bind tra 409; activate xong → bind duoc; fence tenant giu nguyen; audit ghi du `lifecycle_revision` tang |
| **BIZ-05** | UI: chon business → list business version → trong moi version list worker (state on/off) | `apps/admin-web/src/features/businesses/**` | BIZ-04 | Nhom worker theo version doc tu API that; khong sinh dong gia cho business khong co worker; trang thai worker lay tu `state` that, khong hard-code |

---

## 5. Thu tu va ràng buoc

1. **BIZ-01 → BIZ-02 → BIZ-03** la chuoi. Khong song song.
2. **BIZ-04** sau BIZ-01 (can migration + can D-BIZ-5). **BIZ-05** sau BIZ-04.
3. **Khong co second writer tren cung lease.** BIZ-04 dung `modules/profiles/profiles.ts` va `dispatcher.ts` — vung ma lane hien tai dang giu. Serialize, khong giao song song.
4. BIZ-01 dung `migrations/` → serialize voi moi lane migration khac. Khong gop voi task migration dang chay.
5. Verifier doc lap voi implementer.
6. Khong tu revert hunk cua lane khac. Khong commit, khong push, khong git add.

---

## 6. Rui ro va dieu chua dong

| # | Rủi ro | Mức | Xử lý |
|---|---|---|---|
| 1 | Mo `assertPlatformRuntimeAuth` cho worker token lam lo con fence `server.ts:318-324` | Cao | Bat buoc co test o BIZ-02 (muc 7) |
| 2 | Business khong co token trong config → khong self-register duoc | Trung binh | **Dung y nghia, khong phai bug** — xem D-BIZ-1. Can nghem thu cach cap token khi deploy business moi |
| 3 | Default `REGISTERED` + D-BIZ-5 chan bind neu backfill sai | Cao | Backfill la bat buoc, co bang chung dem so dong truoc/sau |
| 4 | `business_catalog` seed 0043 ton tai duoi DB da co → status default ap dung cho moi dong cu | Trung binh | Migration 0044 phai idempotent, va phai bao cao so dong bi doi doi voi tong so dong |
| 5 | `du-rework/orchestrator/**` hien **chua commit** (`??` trong git status) | Cao | Khong phai vi pham coordinator de giai quyet; can nguoi dung quyet dinh |

---

## 7. Trang thai dispatch (2026-10-11, kiem bang `orca terminal list --json`)

Ca **8/8 terminal dang connected**. Khong co terminal rong de giao.

| Handle | Agent | Idle luc kiem | Ghi chu |
|---|---|---|---|
| `term_19edcad8` | claude | 0s | Chinh phien coordinator nay |
| `term_4bca69af` | qwen-code | 0s | **Dang chay** (qwen_2) — cam giao |
| `term_c89675a0` | qwen-code | 0s | Dang chay |
| `term_25de3310` | qwen-code | 0s | Dang chay |
| `term_bd1937f8` | qwen-code | 0s | Dang chay |
| `term_16fef1c3` | qwen-code | 677s | Gan idle, chua kiem dung hinh |
| `term_be856c75` | antigravity | 535s | Vai tro dispatcher |
| `term_3f5e1a6b` | — | 594875s | Terminal PowerShell trong, khong dung lam owner |

**Owner = PENDING.** Khong tu gan owner, khong tu dispatch, khong tu ghi request id.
Ly do: `COORDINATOR-CONTRACT.md` — phai doc terminal that truoc khi chon owner, va `connected` khong du de giao; phai phan biet `connected` / `prompt-idle` / `executing`.

---

## 8. Gate

Khong tick gate. Khong gan ACCEPTED cho gi. Cac gate hien tai trong `coordination/gates/` khong doi trong plan nay.

---

## 9. Buoc tiep theo

1. Cho mot terminal rong → gan owner cho BIZ-01 (thu tu §5).
2. Ghi request id va dispatch id vao tung receipt khi phat sinh.
3. Sau BIZ-01 xong va migration 0044 da ap dung tren DB dich, moi chay phan DB cua BIZ-04 va co bang cheng dem so dong.
