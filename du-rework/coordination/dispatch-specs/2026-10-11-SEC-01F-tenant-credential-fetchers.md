# Dispatch Spec: SEC-01F — Va 5 fetcher con dung credential platform

| Muc | Gia tri |
|---|---|
| Task ID | SEC-01F |
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Repo scope | du-rework |
| Owner | PENDING — chon sau khi inspect runtime that (xem §6) |
| Lease | `services/orchestrator/src/app/admin/section-dispatch.ts` + test **rieng** cho task nay |
| Canonical plan | `coordination/PLAN-SECURITY-ORCHESTRATOR-2026-10-11.md` §2 SEC-01F |
| Receipt | `coordination/reports/receipt-sec-01f-tenant-credential-2026-10-11.md` |

## 0. Vi sao task nay ton tai du cutover da chot

Cutover (SEC-01) chan `/admin/legacy/*` o **topology A**. Nhung **topology B van lo** — `DU_ADMIN_WEB` mac dinh `0` (`.env.docker.example:32`, `compose/orchestrator.yml:45`), tuc khi do `/admin/businesses` va `/admin/audit` van ra du lieu cross-tenant.

Neu coi cutover la xong thi lo hong quay lai ngay khi ai do tat co. **Khong bo task nay vi da cutover.**

Day la **task nho**, khong phai sua lai ca shell: co che dung da co san, chi can dua 5 cho con lai ve dung no.

## 1. Trang thai that tren dia (coordinator doc, 2026-10-11)

Co che **da co san va da noi dung cho operations + overview**:

```
services/orchestrator/src/app/admin/section-dispatch.ts
  :82        import { credentialForTenant } from './bff/upstream';
  :88-100    legacyReadCredential(claims, config)
               :92-93   role admin      -> { kind: 'platform', token: config.adminToken }
               :95      role khac admin -> null
               :96-97   claims.tenantId phai la chuoi non rong
               :98-99   credentialForTenant(config.tenantAdminTokens, tenantId)
  :140-143   sectionHasProtectedRead — CHI chon operations va overview (:141-142)
  :471       operations  — adminToken: access.token   (da tenant-scoped)
  :543       overview    — adminToken: access.token   (da tenant-scoped)
```

**Claim cu cua coordinator da sai va da sua.** Ban goc ghi `section-dispatch.ts` co **7** cho `adminToken` va **0** tham chieu `credentialForTenant`. Doc lai: co dung **5** cho (`:285,324,370,411,637`) va **2** tham chieu (`:82` import, `:98` dung). Task duoi day sinh ra tu con so 5 nay, khong phai tu 7.

## 2. Viec can lam

| Dinh vi | Section | Role toi thieu | Token hien tai |
|---|---|---|---|
| `section-dispatch.ts:285` | businesses | **viewer** | `config.adminToken` |
| `section-dispatch.ts:324` | profiles | admin | `config.adminToken` |
| `section-dispatch.ts:370` | connectors | admin | `config.adminToken` |
| `section-dispatch.ts:411` | api-keys | admin | `config.adminToken` |
| `section-dispatch.ts:637` | audit | **operator** | `config.adminToken` |

- **Dua 5 cho tren ve dung credential da resolve** qua `legacyReadCredential` / `access.token` nhu operations va overview dang lam.
- **Mua vao cung guard `:140-143`:** `businesses` va `audit` **bat buoc** vao guard. Chi thay token thi khong du — can chan ca truong hop khong resolve duoc credential. Neu khong co guard, viewer/operator khong map duoc tenant van co the vao fetcher voi token rong.
- **Hanh vi o 3 cho profiles/connectors/api-keys khong doi** — yeu cau role `admin`, ma `legacyReadCredential` tra token platform cho admin (`:92-93`). Day chinh la ly do thay token o 3 cho do an toan: **chi thuc su doi hanh vi o `businesses` va `audit`.**

## 3. QUYET DINH KIEN TRUC — coordinator da chot, dung hoi lai

Neu implementer gap tinh huong o §4, day la cau tra loi. **Khong can hoi owner.**

### 3.1 `businesses` — dung endpoint co tenant scope, khong dung endpoint toan he thong

Hai endpoint ton tai, da verify tren dia:

| Route | File:line | Pham vi |
|---|---|---|
| `GET /api/v1/admin/businesses` | `services/orchestrator/src/http/routes/admin.ts:447` | **toan he thong** — chi co gia tri voi platform admin |
| `GET /api/v1/admin/tenants/:tenantId/businesses` | `admin.ts:478` | **co tenant scope** — dung cho operator |

⇒ **Quyet dinh:** voi `operator` co tenant map, fetcher `:285` phai goi route `:478` voi `tenantId` tu session, **khong** phai route `:447`. Role `admin` giu nguyen route `:447`. Khong phai chi gan lai token — **doi endpoint**, vi route `:447` khong co tham so tenant nao de loc.

### 3.2 `audit` — truyen `tenantId` xuong server, server da ho tro

`modules/admin-read/audit-list.ts:63-66` doc `tenantId` tu query va validate UUID; `:120` tra ve trong bo filter; `:132` bind vao SQL ⇒ **co tenant fence that san**. ⇒ Fetcher `:637` gui `tenantId` tu session, giong het cach operations/overview dang lam voi `tenantFilter`.

### 3.3 `viewer` — mat quyen legacy businesses, va day la huong fail-closed dung

`legacyReadCredential:95` tra `null` cho role khac `operator` va khac `admin`. `/admin/businesses` lai chi can role `viewer` (`p6-01-shell-fixtures.ts:223`). ⇒ Sau khi sua, **viewer khong xem duoc businesses o legacy shell**.

**Dong y.** Huong fail-closed la huong dung: duong hien tai dang tra cross-tenant cho viewer. Va sau cutover (SEC-01) legacy shell khong con duoc mount vao SPA, con SPA co man businesses rieng voi authz BFF day du — **khong phai mat chuc nang, chi mat bang legacy**. Tra `403` voi body chua `Access denied`, dong nhat voi convention san co. Ghi ro dieu nay vao receipt.

### 3.4 Ba cho `admin`-role — khong doi hanh vi

`profiles`, `connectors`, `api-keys` yeu cau role `admin` ⇒ `legacyReadCredential:92-93` tra token platform. Thay token o 3 cho do **khong doi hanh vi**, chi dong nhat cach. Khong sua them gi o 3 cho do.

## 4. Tieu chi hoan thanh

1. `businesses` cho operator co tenant map: fetcher **doi endpoint**, khong chi doi token — phai goi `GET /api/v1/admin/tenants/:tenantId/businesses` (`src/http/routes/admin.ts:478`, regex `^/api/v1/admin/tenants/([^/]+)/businesses$`), **khong** goi `/api/v1/admin/businesses` (`:447`, system-wide). Token lay theo tenant do.
2. `audit` cho operator co tenant map: cung nhat.
3. Viewer va operator **khong** co tenant map: `403`, **va fetcher khong chay** (khong phai fetcher chay roi tra 401).
4. Role `admin`: van nhan token platform, **khong doi hanh vi** so voi hien tai.
5. Profile/connector/api-keys: hanh vi **khong doi** (role admin).
6. Test moi phu **ca hai ve**: cross-tenant bi chan, va admin giu nguyen.

## 5. Ranh gi voi SEC-01

| | Lease |
|---|---|
| **SEC-01** | `shell-server.ts`, `shell-router.ts`, `app-shell.tsx`, `tests/sec-or-01-legacy-read-scope-offline.test.ts` |
| **SEC-01F** | `section-dispatch.ts` + **test rieng** |

**Khong sua `tests/sec-or-01-legacy-read-scope-offline.test.ts`** — do SEC-01 chuyen path trong file do. Viet test moi.

## 6. Rang buoc va bang chung dispatch

- **Khong `git add` / `commit` / `push`. Khong tick gate.**
- **Khong sua file ngoai lease.** Khong sua `shell-server.ts`/`shell-router.ts`/`app-shell.tsx`.
- Khong mo cua so DB, khong dung DB production/legacy.
- **Khong dung ky tu nhay kep ASCII** trong file va prompt.
- **Owner: PENDING.** Inspect runtime that qua `orca terminal list --json` + doc screen. Khong co request/dispatch ID ⇒ khong co bang chung dispatch.
- **Verifier phai doc lap voi implementer.**
- `SEC-01F` va `SEC-03` khong cung file ⇒ song parallel duoc neu owner khac. `SEC-02` va `SEC-03` cung cham `ingestion-consumer.ts` ⇒ tranh song parallel.

## 7. Hanh dung dung

Khong sua file san pham ngoai lease. Khong `git add`/`commit`/`push`. Khong tick gate.
Khong tu nhan SEC-01F da dong neu chua co verify doc lap.