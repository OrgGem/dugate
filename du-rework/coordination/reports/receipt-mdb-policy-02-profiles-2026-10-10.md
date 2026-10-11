# Receipt - MDB-POLICY-02: resolveProfileName + normalizeConnectionsOverride

| Truong | Gia tri |
|---|---|
| Task ID | MDB-POLICY-02 |
| Ngay | 2026-10-10 |
| Repo scope | du-rework (khong dung legacy root lam pham vi sua, khong dung live DB/Redis/S3) |
| Canonical plan | `coordination/PLAN-OPEN-2026-10-09.md` §9.2/§9.3 (hang 5) + `coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7 |
| Dispatch spec | `coordination/dispatch-specs/2026-10-10-MDB-POLICY-02-profiles.md` |
| Dispatch proof | `coordination/DISPATCH-LIVE-2026-10-10.md:26` (MDB-POLICY-02 -> Qwen-C `term_c89675a0-351a-47cc-8c4d-21fb29d5d41a`, RUNNING); packet dong thoi duoc giao truc tiep trong phien |
| Lease | `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (2 callback); `orchestrator/services/orchestrator/tests/mdb-policy-02-profiles.test.cjs` (moi); receipt nay |
| Owner lane | Qwen-C (implement) |
| Trang thai | **IMPLEMENTED + offline-verified [PASS] - CHUA ACCEPTED** (can independent verifier doc lap; lane khong tu accept) |
| Offline | Co - khong mo cua so DB/Redis/S3 nao |
| Git | Khong `git add`, khong commit, khong push; khong co gi staged |
| Ky tu nhay kep | **0** tren ca 2 file (kiem byte bang doc lai noi dung) |

---

## 1. Hop dong da doc (bang chung, khong suy dien)

Runner `scripts/ldba-03-backfill.cjs` - `mapProfile` (`:580-650`):
- `resolveBusiness` (`:333-350`) chay TRUOC va da bao dam `row.endpointSlug` la text non-empty (fail `REGISTRY_ADAPTER_REQUIRED` / `UNMAPPED_ENDPOINT` neu khong).
- `context.resolveProfileName(row)` (`:591-593`): khong tra string non-empty -> runner fail `INVALID_PROFILE_NAME`.
- `context.normalizeConnectionsOverride(overrideRaw)` (`:596-599`): khong tra Array -> runner fail `INVALID_CONNECTION_OVERRIDE`.
- `overrideRaw` la gia tri da `JSON.parse` (`parseJsonField`, `:228-241`): `null` | array | object; JSON hong da bi runner chan truoc do (`INVALID_JSON`).

Adapter `scripts/ldba-03-production-adapter.cjs`:
- `syncContext` (`:628-637`) **tu choi thenable** (`ASYNC_SYNC_CONTEXT`) => hai callback phai synchronous + pure.
- Registry `businessActions` key theo `action.name` cua `business_versions.manifest.actions` (`:463-478`) va tra cuu bang chinh slug (`:642-648`); nhanh provider `resolveBusinessAction` khong duoc `ldba-context-provider.cjs` export, nen duong dang chay la fallback nay.

Legacy (chi doc, khong sua):
- `lib/db/schema.ts:122-137` - `ProfileEndpoint` **khong co** cot name/business/action: chi `id, apiKeyId, endpointSlug, enabled, parameters, connectionsOverride, jobPriority, fileUrlAuthConfig, allowedFileExtensions, rateLimitPerMin, maxConcurrent, createdAt, updatedAt`.
- `lib/endpoints/profile-resolver.ts:118-141` - parser cu: `string[]` (format cu) hoac `ConnectionStep[]` (format moi).
- `app/profiles/page.tsx:801-841,1022` - writer duy nhat: ghi mang `ConnStep` hoac `null`; **khong** co writer nao ghi object wrapper.
- `interface ConnStep` (`app/profiles/page.tsx:795`) = `{ slug, stepId?, captureSession?, injectSession? }`.

Rework target (chi doc, khong sua):
- `migrations/0028_profile_name.sql:22-34` - `profile_names` co unique index `(tenant_id, api_key_id, business_id, business_version, action, profile_name)`.
- `packages/contracts/src/profile-policy.ts:209-216` - `ConnectionStepSchema` **strict**, dung 4 key; `ProfileConnectionsOverrideSchema = z.array(ConnectionStepSchema)` (`:225`).
- `services/orchestrator/src/modules/profiles/policy.ts:343-348` - `coerceConnectionsOverride` (duong doc runtime) chi giu entry co `slug` la string.
- `packages/contracts/src/profile-callback.ts:455` - `profileName: z.string().min(1).max(256)`.

---

## 2. Thay doi

### 2.1 `scripts/ldba-context-provider.cjs` (untracked; +105 dong)

sha256 **truoc** `25bd4e059963e1f080cfb98db4dc381c1672cff3a82942644ae47980f0136088`
sha256 **sau**  `aa2fe74d9d07e352af6a9ee09aa6573c722048543af0cff62aa325ca93d35d9b`

Thay 2 stub `requireApprovedPolicy(...)` bang implementation that: `resolveProfileName`, `normalizeConnectionsOverride`;
`module.exports` giu nguyen `Object.freeze` 8 callback. Than ham `prepareConnector` **khong bi sua**: edit chi cham vao khoi comment
cuoi file + 2 dong stub, va dong `  prepareConnector,` duoc phat lai y nguyen. File la untracked nen bang chung thay doi la cap sha256
o muc 2.1 (khong co `git diff`), va file `ldba-03-backfill.cjs` cua runner cung khong bi cham (muc 7).

### 2.2 `tests/mdb-policy-02-profiles.test.cjs` (moi, 239 dong)

sha256 `ae2ecdbb068a84a2b3b12303d530859be246cb9b8df8691a1d77e601a262847a`
19 test `node:test` + `node:assert/strict`, chia: happy path ten (5), negative control ten (1 khoi 10 input), happy path override (6),
negative/fallback override (3), regression guard (3: prepareConnector, 5 callback fail-closed, boot contract + sync).

### 2.3 Ve sinh

- 0 ky tu nhay kep, 0 dong co trailing whitespace, LF (khong CR), tren ca 2 file.
- `node --check scripts/ldba-context-provider.cjs` -> exit 0.

---

## 3. Quyet dinh thiet ke (va lua chon bi loai)

### 3.1 `resolveProfileName` - suy ten tu `endpointSlug`

Cong thuc: `Imported ` + token; token = chinh slug neu slug sach (`/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/`, <= 64 ky tu),
nguoc lai = sanitize (lowercase, gom moi run ky tu khong phai `[a-z0-9]` thanh `-`, cat 64, bo `-` dau/cuoi).
Khong dung duoc -> tra **chuoi rong** (runner bao `INVALID_PROFILE_NAME`).

Ba ly do suy tu slug chu KHONG tu business/action:
1. callback chi nhan `row`; mapping business/action nam o registry cua runner, module nay khong thay, va hang legacy khong co cot do.
2. registry duoc key theo `action.name` va tra bang slug, nen moi hang toi duoc callback da co `action === endpointSlug`
   => ten sinh ra **dung dang** `Imported <action>` ma spec yeu cau.
3. `profile_names` unique gom `profile_name` trong khi khoa legacy la `(apiKeyId, endpointSlug)`: ten suy tu slug van duy nhat
   neu sau nay registry map nhieu slug ve mot action, tinh huong ma ten suy tu action se va cham.

Lua chon bi loai: (a) dung `row.action` - khong ton tai tren hang legacy va co the va cham unique; (b) nem loi - adapter/runner se
abort ca run thay vi bao mot hang (`INVALID_PROFILE_NAME` moi la duong bao dung).

### 3.2 `normalizeConnectionsOverride` - luon tra array, khong bao gio emit step ngoai strict schema

Quy tac:
- `null`/`undefined`/scalar/string tho -> `[]`.
- Array -> chuan hoa tung entry, giu thu tu, bo entry null:
  - string non-empty (trim) -> `{ slug }` (format cu cua legacy);
  - object co `slug` string non-empty -> chi mang field schema-valid: `slug` (bat buoc), `stepId` (chi khi string non-empty),
    `captureSession`/`injectSession` (chi khi string hoac null).
  - entry khong co slug dung duoc (rong, so, null, object thieu slug) -> **bo entry**; field phu sai kieu -> **bo field, giu hop**.
- Object (wrapper) -> lay array **dau tien** gap trong cac value cua no; khong co -> `[]`.
- Luon tra **array moi** (khong tra lai chinh tham chieu cua caller).

Lua chon bi loai: (a) mang theo unknown key -> hang se vi pham `ConnectionStepSchema` strict (dung lop bay cua MDB-POLICY-01:
ghi jsonb truc tiep, khong re-validate); (b) tra non-array de runner fail hang -> trai voi yeu cau spec luon tra array.

---

## 4. Bang chung chay (literal + exit code)

Tat ca lenh chay trong `orchestrator/services/orchestrator`. Exit code lay tu chinh tool runner (khong dung `%ERRORLEVEL%`).

### 4.1 Baseline truoc khi sua

```
$ node --test tests/mdb-policy-01-connector.test.cjs
tests 20 | pass 20 | fail 0
Exit Code: 0

$ npx jest --runInBand --runTestsByPath tests/mdb-01-composition-provider.test.ts
Tests: 1 failed, 1 passed, 2 total        <- DO MDB-POLICY-01, da co truoc cycle nay
Exit Code: 1
```

### 4.2 RED (test viet truoc, implementation sau)

```
$ node --test tests/mdb-policy-02-profiles.test.cjs
pass 2 | fail 17 | tests 19
Exit Code: 1

ly do dung (khong phai loi compile/test sai):
  Error [ContextPolicyError]: approved LDBA03 context policy is not configured for resolveProfileName
  Error [ContextPolicyError]: approved LDBA03 context policy is not configured for normalizeConnectionsOverride
2 test xanh ngay tu RED: prepareConnector regression + 5 callback fail-closed.
```

### 4.3 GREEN x3 lien tiep

```
$ node --test tests/mdb-policy-02-profiles.test.cjs
tests 19 | pass 19 | fail 0 | duration_ms 70.7602     Exit Code: 0
tests 19 | pass 19 | fail 0 | duration_ms 96.1829     Exit Code: 0
tests 19 | pass 19 | fail 0 | duration_ms 71.6539     Exit Code: 0
```

### 4.4 Syntax + typecheck

```
$ node --check scripts/ldba-context-provider.cjs
(khong co output)   Exit Code: 0

$ npx tsc --noEmit -p tsconfig.json
(khong co output)   Exit Code: 0
```

---

## 5. Hau qua NGOAI lease (can coordinator adjudicate)

Land policy lam **guard fail-closed cu** cua packet truoc do do:

```
$ node --test tests/mdb-policy-01-connector.test.cjs        # sau khi land
pass 19 | fail 1 | tests 20
Exit Code: 1
  ✖ every other context callback stays fail-closed until its own policy lands  (tests/mdb-policy-01-connector.test.cjs:292)
  AssertionError [ERR_ASSERTION]: Missing expected exception.  (tai :297, entry dau tien = resolveProfileName)
```

- File do **nam ngoai lease** va **khong bi toi sua**: sha256 van `b51bccad...` - dung bang hash ma verifier DSH da ghi
  (`coordination/reports/verify-mdb-policy-01-INDEPENDENT-DSH-2026-10-10.md:14`).
- Day la **cung mot lop** voi phat hien DSH da ghi cho MDB-POLICY-01: `tests/mdb-01-composition-provider.test.ts:41`
  do vi `prepareConnector` khong con nem `CONTEXT_POLICY_REQUIRED`. Toi chay lai truoc/sau: **y het nhau** (1 failed / 1 passed,
  cung assertion `:39`, cung gia tri resolve) => pre-existing, khong phai do cycle nay.
- Spec MDB-POLICY-02 §1 noi ro chi **5 callback con lai** phai fail-closed, nen guard cu liet ke 6 (gom 2 callback da land)
  la **stale theo thiet ke**, khong phai regression hanh vi.
- **De nghi:** cap lease nho de cap nhat danh sach guard trong `tests/mdb-policy-01-connector.test.cjs` (bo `resolveProfileName` +
  `normalizeConnectionsOverride`), hoac giao cho owner MDB-POLICY-01. Toi khong tu sua ngoai lease.

---

## 6. Acceptance (doi chieu spec §2 va §3)

- [x] `resolveProfileName` la policy that (khong con `requireApprovedPolicy`).
- [x] `normalizeConnectionsOverride` la normalizer that, luon tra array, an toan null/undefined/malformed.
- [x] Happy path + negative control day du cho ca 2 callback.
- [x] Regression guard: `prepareConnector` con hoat dong; 5 callback con lai fail-closed; boot contract du 8 ham; 2 callback moi synchronous.
- [x] Test offline pass 3 lan lien tiep; `node --check` + `tsc --noEmit` pass.
- [x] Offline: khong mo cua so DB/Redis/S3 nao.
- [x] Khong `git add`, commit, push; khong dung ky tu nhay kep.
- [ ] Independent verifier doc lap moi tinh ACCEPTED - **thuoc coordinator/verifier**.

---

## 7. Lease / git

```
$ git status --porcelain -- orchestrator/services/orchestrator/scripts
                            orchestrator/services/orchestrator/tests/mdb-policy-01-connector.test.cjs
                            orchestrator/services/orchestrator/tests/mdb-policy-02-profiles.test.cjs
                            orchestrator/services/orchestrator/tests/mdb-01-composition-provider.test.ts
 M du-rework/orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs              (co san, khong phai cua toi)
 M du-rework/orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs    (co san, khong phai cua toi)
?? du-rework/orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs          (lease - toi sua)
?? du-rework/orchestrator/services/orchestrator/tests/mdb-01-composition-provider.test.ts  (co san)
?? du-rework/orchestrator/services/orchestrator/tests/mdb-policy-01-connector.test.cjs     (khong sua; hash khong doi)
?? du-rework/orchestrator/services/orchestrator/tests/mdb-policy-02-profiles.test.cjs      (lease - moi)

$ git diff --cached --name-only
(rong)
```

Hai file `ldba-03-*.cjs` da o trang thai modified **truoc** cycle nay (thay o baseline) va khong bi toi goi edit;
`ldba-context-provider.cjs` la file untracked nen bang chung thay doi la cap sha256 o muc 2.1 (khong co `git diff`).

---

## 8. DELTA

**Δ1 (ngoai lease, can adjudicate).** Guard fail-closed cu trong `tests/mdb-policy-01-connector.test.cjs:292-297` do 1 test sau khi land
(muc 5). Khong sua ngoai lease; da de nghi huong xu ly.

**Δ2 (mat du lieu o tang step la vo hinh).** Runner chi kiem `Array.isArray` va khong co kenh per-step, nen mot entry bi bo
(slug khong dung duoc) hay mot field phu bi bo khong xuat hien trong `report`. Day la he qua cua chinh hop dong runner, khong phai
bug cua lane; neu coordinator muon step-level integrity thi can packet rieng (vi du dem so step truoc/sau o harness).

**Δ3 (nhanh wrapper la phong thu, khong co bang chung legacy).** Khong writer nao cua legacy ghi object wrapper (`app/profiles/page.tsx:1022`);
toi van cai nhanh nay theo spec §1 nhung ghi ro no khong map mot format da biet, va test pin hanh vi (array dau tien / khong co -> `[]`).

**Δ4 (chua chung minh duong ghi that).** Khong co PG rehearsal trong lease nay, nen `profile_names` insert + unique index chua duoc chay
that. Bang chung hien co la hop dong doc tu migration/contracts + test offline; verify live thuoc gate khac (va A1 timezone van mo).

**Δ5 (quan sat, ngoai lease).** Registry cua adapter tra `businessActions` theo `action.name` bang chinh slug (`:463-478,642-648`), nen mot
`endpointSlug` kieu compound (vi du `extract:contract`) se `UNMAPPED_ENDPOINT` o `resolveBusiness` **truoc khi** toi `resolveProfileName`.
Doc tu code, chua chay; khong thuoc lease nay.

---

## 9. Trang thai 4 muc

1. **Implemented**: co - 2 callback that trong provider + 19 test moi.
2. **Offline-verified**: co - RED 17 fail/2 pass (exit 1) -> GREEN 19/19 x3 (exit 0); `node --check` exit 0; `tsc --noEmit` exit 0.
3. **Accepted**: KHONG - can independent verifier doc lap.
4. **Merged/deployed**: KHONG - chua commit/push; chua chay rehearsal PG.

**Rollout note:** khong doi hanh vi cua callback nao khac; `prepareConnector` giu nguyen. Sau khi land, profile rows di qua duoc
`resolveProfileName`/`normalizeConnectionsOverride`, nhung mot hang chi migrate duoc khi `resolveBusiness` resolve duoc slug (xem Δ5).

---

## 10. RESUME POINT

- Da xong: 2 callback + test + bang chung literal + receipt nay.
- Con lai (khong thuoc lane nay): (i) adjudicate Δ1 (cap lease cap nhat guard MDB-01 hoac giao owner P-01);
  (ii) independent verifier chay lai `node --test tests/mdb-policy-02-profiles.test.cjs` x3, doc lai sha256 provider;
  (iii) coordinator tick gate sau verify.
- Khong pending nao khac trong lease. Khong commit/push.
