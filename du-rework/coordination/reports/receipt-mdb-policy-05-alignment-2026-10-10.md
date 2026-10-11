# MDB-POLICY-05 - can chua guard fail-closed sang contract moi

| Muc | Gia tri |
|---|---|
| Task | MDB-POLICY-05 |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | du-rework |
| Canonical plan | coordination/dispatch-specs/2026-10-10-MDB-POLICY-05-alignment.md; PLAN-OPEN-2026-10-09.md §9.2/§9.3 hang 5 |
| Lease | 4 test file (mdb-policy-01/02/03 + mdb-01-composition-provider) + receipt nay |
| Trang thai | ALIGNED + offline-verified [PASS] 100% xanh 5/5 suite. CHUA ACCEPTED |
| Receipt | coordination/reports/receipt-mdb-policy-05-alignment-2026-10-10.md |

## 1. Van de can sua - va vi sao no khong phai vie lam cho kho

Moi domain policy land mot lan thi guard cua chinh no - dong assert con cac callback **chua** land nem `CONTEXT_POLICY_REQUIRED` - mat nghia ngay lap. Day khong phai test hong, ma la **guard stale** theo dung ke hoach cua packet. Chuoi do bi do lai:

| guard | file:line (truoc sua) | bi lam do trong |
|---|---|---|
| MDB-01 composition | tests/mdb-01-composition-provider.test.ts:39-42 | MDB-POLICY-01 (DELTA 1 da ghi trong receipt P-01) |
| P-01 suite | tests/mdb-policy-01-connector.test.cjs:292 | MDB-POLICY-02 |
| P-02 suite | tests/mdb-policy-02-profiles.test.cjs:216 | MDB-POLICY-03 |
| P-03 suite | tests/mdb-policy-03-workflow-schema.test.cjs:420 | MDB-POLICY-04 |

## 2. Baseline do truoc khi sua (khong doan)

CWD `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`. Node v24.21.0.

| Suite | Exit | Literal truoc sua |
|---|---|---|
| mdb-policy-01-connector | FAIL | `tests 20 / pass 19 / fail 1` |
| mdb-policy-02-profiles | FAIL | `tests 19 / pass 18 / fail 1` |
| mdb-policy-03-workflow-schema | FAIL | `tests 17 / pass 16 / fail 1` |
| mdb-policy-04-filecache | **0** | `tests 16 / pass 16 / fail 0` |
| mdb-01-composition-provider (jest) | FAIL | `Tests: 1 failed, 1 passed, 2 total` |

Dung **1 test do tren moi suite** - khop voi bang o §1: moi packet chi goc dung 1 guard. Suite 04 da san dung contract moi (dong 190 ghi ro *Not CONTEXT_POLICY_REQUIRED: the landed policy must own its own refusals*), nen no la mau chuan cho 3 sua doi con lai.

## 3. HANH VI THAT - do bang probe truoc khi viet assertion

Toi KHONG dua ma loi vao test tu su doan. Probe goi tung callback voi `({}, {})` tren provider hien tai:

| Callback | Hanh vi do duoc |
|---|---|
| prepareConnector | tra `{skipped:true, code:'INVALID_SOURCE', ...}` (sync) |
| resolveProfileName | tra `''` (sync, KHONG nem) |
| normalizeConnectionsOverride | tra `[]` (sync, KHONG nem) |
| prepareWorkflowSchema | nem `INVALID_SOURCE` / `WorkflowSchemaPolicyError` |
| readFileCacheBytes | nem `INVALID_ARTIFACT_BYTES` / `FileCachePolicyError` |
| artifactTokenFor | nem `INVALID_ARTIFACT_TOKEN` / `FileCachePolicyError` |
| artifactPurposeFor | nem `INVALID_ARTIFACT_PURPOSE` / `FileCachePolicyError` |
| prepareAdminLocalUser | nem `PASSWORD_RESET_REQUIRED` / `ContextPolicyError` |

Hai diem can chu y khi sua assertion:

1. **`resolveProfileName` va `normalizeConnectionsOverride` KHONG nem** - chung tra gia tri rong cho input rong. Assertion cu `assert.throws` cho hai callback nay se do, nen guard moi phai **ghi nhan gia tri tra ve**, khong phai nem.
2. **Ma loi KHAC NHAU theo tung policy**, khong phai mot ma chung. Guard moi gan tung callback voi ma do duoc.

## 4. Sua gi

Tinh chi **1 guard tren moi file**, khong dung lai logic:

- **mdb-01-composition-provider.test.ts:38-44** - `.rejects.toMatchObject({ContextPolicyError, CONTEXT_POLICY_REQUIRED})` -> `.resolves.toMatchObject({skipped: true, code: 'INVALID_SOURCE'})`, kem comment giai thich: policy da land nen **tu choi DONG** qua kenh skip, khong con tu choi **co cau hinh**.
- **mdb-policy-01-connector.test.cjs** - guard 6 callback -> gan 4 callback nem bang ma rieng + `assert.notEqual(code, 'CONTEXT_POLICY_REQUIRED')`, ghi nhan 2 callback lenient, giu `prepareAdminLocalUser`.
- **mdb-policy-02-profiles.test.cjs** - tuong tu (4 callback). Tieu de cu cung sua: no ghi *five* nhung chi loop 4 - drift ten.
- **mdb-policy-03-workflow-schema.test.cjs** - tuong tu (3 callback).

Khong sua logic san pham, khong them test moi, khong doi con so test tren moi suite.

## 5. Bang chung chay

### 5.1 GREEN - 5/5 suite, so lieu khop spec

| Suite | Exit | Literal |
|---|---|---|
| mdb-policy-01-connector | **0** | `tests 20 / pass 20 / fail 0` |
| mdb-policy-02-profiles | **0** | `tests 19 / pass 19 / fail 0` |
| mdb-policy-03-workflow-schema | **0** | `tests 17 / pass 17 / fail 0` |
| mdb-policy-04-filecache | **0** | `tests 16 / pass 16 / fail 0` |
| mdb-01-composition-provider (jest) | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 2 passed, 2 total` |
| `tsc --noEmit -p tsconfig.json` | **0** | khong output |

Khop dung con so spec §2 cua dispatch: 20/19/17/16/2.

### 5.2 Lap lai 3 lan lien tiep

    for %i in (1 2 3) do @(node --test tests\mdb-policy-01-connector.test.cjs tests\mdb-policy-02-profiles.test.cjs tests\mdb-policy-03-workflow-schema.test.cjs tests\mdb-policy-04-filecache.test.cjs ...)

    RUN1_EXIT=0
    RUN2_EXIT=0
    RUN3_EXIT=0

### 5.3 Guard co that khong - do, khong doan

Lease cam sua provider, nen toi khong the mutation truc tiep. Thay the bang probe **tren ban sao** trong `%TEMP%`: mot provider gia lap trong do `readFileCacheBytes` quay lai stub, chay **nguyen khoi assertion moi**:

    GUARD_RED_ON_REVERTED_STUB=true
    reason=readFileCacheBytes must own its refusal code
    GUARD_FAILED=true

Ket luan: neu mot policy bi revert ve stub, guard moi **do**. Chay ban sao khong nao cham file trong lease.

## 6. Phan gioi

File da sua (4, dung lease):

    tests/mdb-policy-01-connector.test.cjs        8bce0558c39f36fb83235b4dc07194bd66aacb078c75a74d5cb6d30b086db6f5
    tests/mdb-policy-02-profiles.test.cjs          5a692a11b5e1b7c49b5b2c1e9eaa5d4f07842e3256e84418afd02fdd7542ba0d
    tests/mdb-policy-03-workflow-schema.test.cjs   d732ee07fc63567c379d44d8509032ed45868bedd5617a8549af88d7a4f9773b
    tests/mdb-01-composition-provider.test.ts      f46b2cc4ecfe1284b6dafcee09fb1d23d0f954d373935e0ad0480982f40ba09c

`scripts/ldba-context-provider.cjs` **khong sua** - giu nguyen sha256 `89c6ec07f6cf83dd28aabbf060d1ab88f9704f226b42b37fa901fbda429cff57` (1038 dong), dung ban MDB-POLICY-04. Toi xac nhan bang sha chu khong phai bang cam nhan: file nay untracked nen `git diff` khong noi gi.

- KHONG `git add` / `commit` / push. Khong mo cua so DB/Redis/S3. Khong sua file ngoai lease.
- Khong tick gate, khong cap nhat task row/plan, khong tu nhan ACCEPTED.
- Tat ca 5 file va receipt nay deu **0 ky tu nhay kep** (kiem bang dem byte), dung rang buoc §3 cua dispatch spec.

## 7. Verdict + phan gioi con mo

| Hang muc | Ket qua |
|---|---|
| 5/5 suite xanh sach | **DAT** - 20/20, 19/19, 17/17, 16/16, 2/2 |
| Typecheck | **DAT** exit 0 |
| Lap 3 lan | **DAT** 3/3 exit 0 |
| Guard bat duoc policy bi revert | **DAT** (do tren ban sao) |
| Provider khong bi sua | **DAT** sha giu nguyen |
| DELTA 1 cua MDB-POLICY-01 | **DA GIAI QUYET** - xem muc 1 |

⇒ **MDB-POLICY-05: ALIGNED, offline [PASS], chua ACCEPTED.**

### Con mo (khong thuoc lease nay)

- **A1 = NOT PROVEN** van chan backfill that: runner tra `BLOCKED_TIMEZONE_UNVERIFIED`. Task nay chi sua test contract, **khong** mo duong chay backfill.
- **DELTA 2 cua MDB-POLICY-01** chua quyet: `staticFormFields` khong co cho trong `ConnectorRevisionConfigSchema` strict nen bi mat khi migrate. Can product owner.
- **Chuoi guard se lap lai.** Land policy moi se lam do guard cua policy do lai lan nua. Kinh nghiem dung: **dong guard nen la ket qua do duoc tu policy da land, khong phai la danh sach callback chua land**.
