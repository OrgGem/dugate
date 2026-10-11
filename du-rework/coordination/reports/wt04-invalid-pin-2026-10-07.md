# WT-04 — Independent verification (offline, read-only)

| Muc | Gia tri |
|---|---|
| Task | WT-04 (MEDIUM) — stored callback policy hong: admission 500 vs Portal im lang null |
| Vai tro | Independent Verifier (doc lap voi owner) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | du-rework |
| Canonical plan | tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md §2.2 (WT-04), §3 W2 |
| Doi tuong kiem | orchestrator/services/orchestrator/src/modules/admin-read/profile-detail.ts + tests/wt04-profile-invalid-callback-read.test.ts |
| HEAD | d0b2210 |
| Node | v24.21.0 |
| Verdict | **VERIFY DAT o pham vi offline** — xem §7. KHONG tick gate, KHONG tu nhan ACCEPTED |

## 0. Pham vi va gioi han cua luot verify nay

Toi chi DOC source va CHAY lenh. Khong sua mot dong code nao ngoai receipt nay; khong `git add`/`commit`/`push`. Vi vay toi **khong the mutation-prove** test bang cach pha code (verifier khong duoc phep), nen phan chong "test xanh nham ly do" duoc lam bang duong doc (§2, §3): tinh duy nhat cua throw site, tinh `.strict()` cua schema, va chi so cot trong INSERT.

## 1. Doi tuong kiem — provenance

Hai file **tracked va sach** so voi HEAD (khong co hunk chua commit):

    git status --porcelain -- <2 path>        -> rong
    git ls-files --error-unmatch <2 path>     -> ca hai tracked

| File | blob o HEAD |
|---|---|
| src/modules/admin-read/profile-detail.ts | 42e233fe74a108f2715af682758c96f7b209cf6f |
| tests/wt04-profile-invalid-callback-read.test.ts | f3b7f32b9fd9dcd199bbd17fc41f4fc759665779 |

`git log` cho thay test duoc dua vao snapshot `df3f955` (2026-10-07, "refactor(orchestrator): promote canonical workspace..."). Luu y: plan §2.2 ghi WT-04 la SPECIFIED tai thoi diem viet; ban kiem nay la tren cay da co code — khong doi chieu voi trang thai plan.

**Path drift so voi plan:** plan ghi `du-rework/services/orchestrator/...`, duong dan that la `du-rework/orchestrator/services/orchestrator/...` (them mot cap `orchestrator/`). Da glob truoc khi doc.

## 2. Doi chieu DTO marker `callbackPolicyInvalid`

### 2.1 Producer — `profileDetailPolicyRead`

    const storedCallback = row.callback_policy === null || row.callback_policy === undefined
      ? null : ProfileCallbackPolicySchema.safeParse(row.callback_policy);
    const callbackPolicy = storedCallback?.success ? storedCallback.data : null;
    const callbackPolicyInvalid = storedCallback !== null && !storedCallback.success;
    ...
    ...(callbackPolicyInvalid ? { callbackPolicyInvalid: true as const } : {}),

Ba nhanh, kiem bang doc:

| stored `callback_policy` | `callbackPolicy` | marker | Dung y do? |
|---|---|---|---|
| absent (null/undefined) | null | khong co | CO — khong lan absent voi invalid |
| hop le | gia tri da parse | khong co | CO |
| khong hop le | null | `true` | CO — khong bao gio lo noi dung raw |

Diem quan trong: gia tri tra ve luon la `callbackPolicy: null` **hoac** gia tri da validate, khong bao gio la JSON raw. Nhanh invalid dat `null` chu khong copy du lieu hong ra DTO.

### 2.2 Contracts — bat doi xung read/write

- `packages/contracts/src/profile-policy.ts:330` (read): `callbackPolicyInvalid: z.literal(true).optional()`. `z.literal(true)` nghia la chi `true` moi qua duoc; mot marker `false` se bi tu choi. Producer chi phat `true` hoac bo han key ⇒ khop.
- `ProfileEndpointPolicyReadSchema` (:317) va `ProfileEndpointPolicySchema` (:287) **deu `.strict()`**.
- Write schema **khong** khai bao `callbackPolicyInvalid` ⇒ key nay bi tu choi boi chinh `.strict()`, khong phai boi mot luat rieng.

Dieu nay lam cho assertion "write DTO tu choi marker" la CO Y NGHIA, khong phai pass tinh co: neu ai do bo `.strict()` khoi write schema, assertion se do. Test 4 cua suite khang dinh ca hai ve: `{callbackPolicy:null}` → success; `{callbackPolicy:null, callbackPolicyInvalid:true}` → false.

### 2.3 Doi chieu contracts-level

`packages/contracts/tests/profile-policy.test.ts:75-83` co mot case ten dung WT-04 kiem cung bat doi xung (read nhan marker / write tu choi). Day la doi chieu doc lap o tang contract, khong chi o tang orchestrator.

## 3. Doi chieu clear flow

### 3.1 Write path — `null` tuong minh khong bao gio parse lai pin hong

`src/modules/profiles/profiles.ts:270-275`:

    callbackPolicy:
      policy.callbackPolicy === null
        ? null                                                   // (1) clear tuong minh
        : has('callbackPolicy')
          ? parseWriteCallbackPolicy(policy.callbackPolicy)       // (2) gia tri client -> 422 neu sai
          : parseStoredCallbackPolicy(previous?.callback_policy),  // (3) absent -> ke thua

Nhanh (1) SHORT-CIRCUIT truoc (3). Day chinh la co che sua "pin hong khong the xoa": truoc day neu client bo key thi nhanh (3) chay `parseStoredCallbackPolicy` tren gia tri hong → `HttpError(500)`; con duong clear tuong minh khong bao gio cham vao gia tri cu.

### 3.2 Chi so cot 15 — kiem de assertion khong pass nham

`profiles.ts:440-443` liet ke cot INSERT: `(profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings, enabled, parameters, job_priority, allowed_file_extensions, file_url_auth_cipher, connections_override, request_redaction, callback_policy)` — dem tu 0: `callback_policy` = index **15**.

Mang params (`:444-462`) tuong ung 16 phan tu, phan tu cuoi (`:461`) la `policy.callbackPolicy === null ? null : JSON.stringify(...)` ⇒ `written[15]` dung la `callback_policy`. Placeholder `$1..$16` khop 16 cot, khong lech.

⇒ Test 6 assertion `expect(written?.[15]).toBeNull()` la assertion dung cho, khong phai trung index nao khac.

### 3.3 Admission van fail-closed

`resolveEffectiveProfile` (`profiles.ts:513`) → `decodePolicy(row)` → `profiles.ts:313` `callbackPolicy: parseStoredCallbackPolicy(row.callback_policy)` → `profiles.ts:178` throw `HttpError(500, 'INVALID_SCHEMA', 'stored profile callback policy does not satisfy its contract')`.

Toi kiem tinh duy nhat cua throw site: grep `HttpError.500` trong `profiles.ts` tra ve **dung 1** ket qua (`:178`). Vi vay assertion `{status:500, code:'INVALID_SCHEMA'}` cua test 5 tro dung cho nay, khong the la mot throw khac.

### 3.4 Portal — doi chieu doc (khong chay runtime)

| Cho | Y nghia |
|---|---|
| `apps/admin-web/src/lib/api/types.ts:233` | `callbackPolicyInvalid?: true` — Portal mirror dung kieu `true` |
| `features/profiles/state.ts:76` | truyen marker qua state |
| `features/profiles/profiles-screen.tsx:1200` | `callbackPolicyInvalid: detail.policy.callbackPolicyInvalid === true` |
| `features/profiles/profiles-screen.tsx:1199` | `callbackConfiguredOnServer` true khi marker ⇒ o clear van hien |
| `features/profiles/profiles-screen.tsx:923` | render canh bao invalid |
| `features/profiles/profiles-screen.tsx:949` | comment + duong save gui `callbackPolicy: null` |

**Gioi han:** day la doi chieu DOC + typecheck, khong phai chay UI. Toi khong chay test nao cua admin-web, nen phan "Portal gui duoc clear" cua acceptance duoc chung minh o muc contract + static, KHONG phai bang thuc thi UI.

## 4. Chay lai test suite

CWD: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.

    node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/wt04-profile-invalid-callback-read.test.ts

Exit code: **0**. Literal:

    PASS tests/wt04-profile-invalid-callback-read.test.ts
    Test Suites: 1 passed, 1 total
    Tests:       9 passed, 9 total
    Snapshots:   0 total

9 test gom: 3 case invalid (`{}`, chuoi `broken-json`, object sai shape co SENSITIVE_SENTINEL) · 2 case absent (null, undefined) · 1 case valid · 1 case read/write schema asymmetry · 1 case admission fail-closed · 1 case writer clear pin hong.

### Lap lai 3 lan (tien trinh rieng)

    for %i in (1 2 3) do @(... --runTestsByPath tests/wt04-profile-invalid-callback-read.test.ts ...)

    WT04_RUN1_EXIT=0
    WT04_RUN2_EXIT=0
    WT04_RUN3_EXIT=0

moi lan `Tests: 9 passed, 9 total`.

## 5. Typecheck va regression

| # | Lenh / cwd | Exit | Literal |
|---|---|---:|---|
| 1 | `tsc --noEmit -p tsconfig.json` · orchestrator | **0** | khong output |
| 2 | `tsc --noEmit -p tsconfig.json` · apps/admin-web (B5 cua plan) | **0** | khong output |
| 3 | `jest --runInBand --silent` · packages/contracts (B4 cua plan) | **0** | `Test Suites: 30 passed, 30 total` · `Tests: 568 passed, 568 total` |
| 4 | `jest --runInBand --runTestsByPath tests/tapi01-closure-offline.test.ts tests/cb02-admission-writer.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 14 passed, 14 total` |

Ghi chu ve con so 568: plan B4 (2026-10-07) ghi 567/567. Muc tang +1 la `packages/contracts/tests/profile-policy.test.ts:75-83` — case WT-04 o tang contract. Doi chieu bang grep `callbackPolicyInvalid` trong contracts/tests: dung 2 hit, ca hai trong case do. Day la tang co chu, khong phai drift.

## 6. Diem can luu y (khong tu nhan la da dong)

1. **Khong chay full orchestrator suite.** Plan §0 noi ro "khong lay focus suite xanh suy cho toan bo suite", va B1 ghi 9 suite do san (phan lon do `list-query.ts` + migration count, KHONG phai change set nay). Luot nay chi la focus suite + typecheck + regression lien quan.
2. **Chua co bang chung mutation red-truoc cho WT-04 trong luot nay.** Verifier khong duoc sua code nen toi khong the pha `.strict()` hay nhanh clear de chung minh test do. Toi bu bang 3 kiem tra doc: throw site duy nhat (§3.3), `.strict()` that (§2.2), chi so cot that (§3.2). Failing-first van can owner hoac mot lane duoc cap lease chung minh.
3. **Test 6 co mot assertion phu, khong phai assertion chinh.** `JSON.stringify(written)` khong chua `SENSITIVE_SENTINEL` la lop bao ve thu hai; neu code parse lai pin hong thi no se THROW truoc khi kip echo, nen assertion do mot minh no khong chung minh duoc gi. Hai assertion load-bearing la `written !== undefined` (khong throw) va `written[15] === null` (clear that su).
4. **Portal chi duoc kiem o muc doc + typecheck** (§3.4) — khong chay UI, khong chay test admin-web.
5. Khong tick gate nao; `T-API-01` va `CB-05` row van mo. ACCEPTED thuoc Reviewer/coordinator, khong phai verifier nay.

## 7. Verdict

| Hang muc | Ket qua |
|---|---|
| Test suite WT-04 (9 test) | **PASS** — 3/3 lan exit 0, `9 passed, 9 total` |
| Typecheck orchestrator | **PASS** — exit 0 |
| Typecheck admin-web (B5) | **PASS** — exit 0 |
| Contracts (B4) | **PASS** — 30 suite / 568 test, exit 0 |
| Regression consumer (tapi01 + cb02-admission-writer) | **PASS** — 14/14, exit 0 |
| Doi chieu DTO marker (read-only, khong raw leak, bat doi xung read/write) | **DAT** |
| Doi chieu clear flow (null tuong minh short-circuit; cot index 15 dung; admission fail-closed) | **DAT** |
| Portal clear | **DAT o muc doc + typecheck**; chua chung minh bang thuc thi UI |

⇒ **WT-04: VERIFY DOC LAP DAT o pham vi offline.** Ket luan nay khong tick gate, khong thay the Reviewer verdict, va khong thay the bang chung failing-first (muc 6.2).

## 8. Xac nhan pham vi

- Khong sua code, khong sua test, khong sua docs. Artifact duy nhat tao ra: receipt nay.
- Khong `git add`, khong `commit`, khong `push`. Khong mo cua so DB/Redis/S3 (moi thu chay offline).
- Khong tick gate, khong cap nhat task row/plan.
