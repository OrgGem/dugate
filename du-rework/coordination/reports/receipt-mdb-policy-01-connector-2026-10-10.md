# MDB-POLICY-01 - prepareConnector policy cho ExternalApiConnection

| Muc | Gia tri |
|---|---|
| Task | MDB-POLICY-01 (rank 5, PLAN-OPEN §9.3) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | du-rework |
| Canonical plan | coordination/dispatch-specs/2026-10-10-MDB-POLICY-01-connector.md; PLAN-OPEN-2026-10-09.md §9.2/§9.3 hang 5; PLAN-LEGACY-DB-ADAPTER-2026-10-09.md §4.5, §7 |
| Lease | services/orchestrator/scripts/ldba-context-provider.cjs; services/orchestrator/tests/mdb-policy-01-connector.test.cjs (moi) |
| Trang thai | IMPLEMENTED + offline-verified [PASS]. CHUA ACCEPTED. **Co 2 delta chan, doc muc 6** |
| Receipt | coordination/reports/receipt-mdb-policy-01-connector-2026-10-10.md |

## 0. CANH BAO PHU THUOC - doc ky truoc khi doc tiep

**A1 = NOT PROVEN.** `coordination/reports/receipt-a1-tz-evidence-2026-10-10.md` §6 ket luan: A1 chi DONE ve dieu tra, **con NOT PROVEN ve ket luan**, va ghi ro: *Khong tick gate, **khong mo MDB-POLICY-01..05 tren nen A1 chua chot***. PLAN-OPEN §9.3 hang 5 cung ghi MDB-POLICY-01..05 *chi mo sau khi A1-TZ co ket luan, vi backfill that can ca hai*, va *phai khai truoc, khong doan*.

Toi van thuc hien vi user (dispatcher) giao truc tiep, va vi cong viec nay **offline, khong ghi DB, khong chay backfill**, nen no khong lam sai lech du lieu nao. Nhung day la thu tu dung chu quyet dinh scope: **chi user moi chot nhanh A/B** (A1-TZ receipt §6). Toi khong tu quyet nhanh nay va khong tick gate.

Lien quan trong cho reviewer: ket qua nay **khong** cho phep chay backfill that. Runner van tra `BLOCKED_TIMEZONE_UNVERIFIED` (§5.2 do).

## 1. Loi canh giu nguyen

`ldba-context-provider.cjs` la module fail-closed, phai dung nguyen trong ca ba dieu kien sau, va ca ba deu duoc test pin:

1. **Boot contract (MDB-01 + CR10-01):** `registerLdb03ContextProvider` (`create-app.ts:151-176`) nap module o `dist/main.js` va tu choi boot neu thieu callback bat buoc. Module nay duoc CR10-01 ship vao image. Test *the boot contract still holds* kiem ca 8 callback la function.
2. **6 callback con lai fail-closed** voi `CONTEXT_POLICY_REQUIRED` - MDB-POLICY-02..05 chua mo, khong duoc lam mat fail-closed.
3. **`prepareAdminLocalUser`** van `PASSWORD_RESET_REQUIRED` (khong the hash bcrypt -> scrypt khi chua co plaintext).

Test *every other context callback stays fail-closed* kiem ca hai, va no xanh o **ca hai trang thai** (pre-fix va post-fix) - no la regression guard, khong phai bang chong fix.

## 2. Hop dong dau ra (doc tu backfill, khong doan)

`ldba-03-backfill.cjs:479-540` kiem 14 dieu kien tren output. Toi danh sach de receipt dung lai:

| # | Dieu kien | Dong |
|---|---|---|
| 1 | `prepared.skipped === true` thi `reason` phai la chuoi non-empty | 487-497 |
| 2 | phai co `revision` va `secret` deu la plain object | 498-501 |
| 3 | `connector_id` khop, `revision === 1`, `state` khop, `tenant_id`/`credential_ref` la chuoi, `config`/`credential_source` la object | 503-514 |
| 4 | `JSON.stringify(config)` **khong chua** `authSecret` | 515-517 |
| 5 | `secret.id` non-empty, `secret.credential_ref === revision.credential_ref`, `encrypted_value` la Buffer/Uint8Array length > 0 | 519-527 |
| 6 | `encrypted_value` **khong bang** plaintext bytes | 528-531 |
| 7 | `tenant_id === ''` | 532-534 |
| 8 | `credential_source.kind === 'legacy-db'`, `credentialRef` khop, `account_id` null/undefined | 535-541 |

Input la `prepareConnector(row, { connectorId, revisionNumber, state, config, createdAt })` (`:479-485`). `state` da duoc `mapValue` san bang `CONNECTOR_STATE` (`ENABLED->ACTIVE`, `DISABLED->RETIRED`, `:50-53`).

## 3. Ba phat hien dac biet lam thay trien khai

### 3.1 Cipher phai khop byte-for-byte voi ben giai ma

`encrypted_value` sau nay duoc doc boi `AesCredentialCipher` (`services/connector/src/services.ts:29-52`):

- AES-256-GCM, key 32 byte;
- layout `iv(12) || authTag(16) || ciphertext`;
- `decrypt` tu choi khi `bytes.length < 28`.

Vi provider la file `.cjs` **khong duoc require dependency nao** (CR10-01 ship dung mot file nay vao image), toi khong import `AesCredentialCipher` ma dung `node:crypto` va **tu sinh dung layout tren**. Test *ciphertext decrypts with the connector credential cipher* tai lap `createDecipheriv` + `setAuthTag` **y het** `AesCredentialCipher.decrypt` va kiem ket qua bang `AUTH_SECRET`. Neu envelope lech mot byte, cac row nay se khong doc duoc va khong co gi o noi khac bat loi.

### 3.2 Key lay tu `CONNECTOR_ENCRYPTION_KEY` (base64, 32 byte)

Cung key ma `services/connector/src/entrypoint.ts:22` truyen cho `AesCredentialCipher`. Khong co key hop le thi tra skip - **khong** bao gio ghi secret chua ma hoa. Test: xoa key, key sai do dai.

### 3.3 Config phai nam trong schema strict (LECH SAN - canh bao)

`connector_revisions.config` duoc validate bang `ConnectorRevisionConfigSchema.parse` tai `services/connector/src/db/repository.ts:725`, parse fail thi `INVALID_INPUT`. Schema nay **`.strict()`** va chi cho 9 key: `baseUrl, path, headers, requestMapping, responseMapping, timeoutMs, capability, credentialSlot, asyncPollingMode` (`packages/contracts/src/vault.ts:267-305`).

LDBA-05 (`legacy-connector-adapter.ts`) tra config gom runtime fields **+ 16 field hien thi** (`name, slug, description, endpointUrl, httpMethod, authType, authKeyHeader, promptFieldName, fileFieldName, fileUrlFieldName, defaultPrompt, staticFormFields, extraHeaders, responseContentPath, sessionIdResponsePath, sessionIdFieldName, timeoutSec`). Config do **khong bao gio qua `.strict()`** - neu backfill ghi nguyen, connector se tu choi revision do khi doc lai.

Vi vay policy nay chi emit **8 key runtime**. Test *config stays inside the strict revision schema` kiem key duoc phep va key hien thi bi lo.

## 4. Cac quyet dinh thiet ke

**Refuse = tra skip, khong throw.** Backfill co duong skip co chu dung (`prepared.skipped` + `reason` non-empty, `:487-497` va `skip()` nem `RowSkip` de runner ghi nhan va di tiep). Mot throw la khong ro duong di chang the nao, va se lam roi mot dong khong the xoa duoc - dung chinh thu ben can tranh. Moi nhanh refuse deu **tra `skipped` + `code` + `reason`**; `reason` la chuoi tinh san, khong bao gio echo secret (test kiem `JSON.stringify(prepared)` khong chua secret).

**Che khop header co so credential tai ranh giac.** `ConnectorRevisionConfigSchema.superRefine` tu choi header co ten nhu credential. Provider so voi `SECRET_HEADER_NAMES` tai day (mirror `vault.ts:221-243`) va **skip dong** thay vi ghi mot config ma connector se tu choi o lan doc sau. Day la fail-closed co chu dich: loi bao o backfill noi de nhan thay vi lai lon o repository.

**Mapping lay theo LDBA-05:** `input.prompt` / `input.artifacts` / `sessionRef`, `adapter = multipart-http` khi co `fileFieldName`, `credentialRef = legacy-db:connector:<id>`, `secret.id = legacy-db:secret:<id>:1`, `credentialSlot = header:<authKeyHeader>`, `timeoutMs = timeoutSec * 1000`, `baseUrl/path` tach tu `endpointUrl` (chan userinfo/fragment, giong LDBA-05). Co kiem tra mau va `UNSAFE_FIELD_MAPPING` khi mot field name map vao hai source path.

## 5. Bang chung chay

CWD `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`. Node v24.21.0. File test la `.cjs` nen chay bang `node --test` (da xac nhan runner nay chay `tests/ldba-03-backfill-offline.test.cjs` PASS truoc khi toi sua).

### 5.1 RED - mutation

Tra `prepareConnector` ve stub fail-closed, chay lai **chinh file test cuoi cung**:

    node --test tests/mdb-policy-01-connector.test.cjs    -> MUT=FAIL

    tests 20 / pass 2 / fail 18

18 test do mang trieu chung dung cua trang thai truoc fix:

    Error [ContextPolicyError]: approved LDBA03 context policy is not configured for prepareConnector
        at Object.contextPolicyRequired [as prepareConnector] (scripts/ldba-context-provider.cjs:16:11)
      code: 'CONTEXT_POLICY_REQUIRED',

Hai test xanh la *the boot contract still holds* va *every other context callback stays fail-closed* - dung hai regression guard phai xanh o ca hai trang thai. Khoi phuc lai: 20 pass.

### 5.2 GREEN - 3 lan lien tiep

    for %i in (1 2 3) do @(node --test tests/mdb-policy-01-connector.test.cjs ...)

    RUN1_EXIT=0 / RUN2_EXIT=0 / RUN3_EXIT=0

    RUN 1 -> tests 20 | pass 20 | fail 0
    RUN 2 -> tests 20 | pass 20 | fail 0
    RUN 3 -> tests 20 | pass 20 | fail 0

### 5.3 Typecheck

    node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json    -> TSC=PASS (exit 0, khong output)

Luu y: `tsconfig.json` chi `include: [src/**/*.ts]`, nen `.cjs` khong duoc typecheck boi lenh nay. Loi cua provider se **chi** loi runtime qua test.

### 5.4 A/B chung minh suite LDBA-03 do pre-existing, khong phai do toi

Ba suite tai lenh provider: `ldba-03-backfill-offline.test.cjs`, `ldba-03-production-adapter.test.cjs`, `ldba-03-runner-skip.test.cjs`.

| Trang thai provider | Exit | Literal |
|---|---|---|
| stub (pre-fix) | FAIL | `tests 43 / pass 29 / fail 14` |
| implementation nay | FAIL | `tests 43 / pass 29 / fail 14` |

**Bang nhat tuyet doi.** 14 red do lenh duoi, khong lien quan den prepareConnector:

    actual: 'BLOCKED_TIMEZONE_UNVERIFIED', expected: 'BLOCKED_SKIPPED_ROWS'
    actual: 'BLOCKED_TIMEZONE_UNVERIFIED', expected: 'APPLIED'

Day chinh la gate A1 (A1 = NOT PROVEN, muc 0). Hai file `.cjs` nay dang ` M` cua lane khac; toi khong sua va khong re-blame.

## 6. HAI DELTA CAN COORDINATOR/OWNER XU LY

**DELTA 1 - MOT test cua lane khac bi RED do thay doi hanh vi cua toi.**

`tests/mdb-01-composition-provider.test.ts:39-42` (file cua MDB-01, **ngoai lease nay**) assert:

    await expect(adapter.context.prepareConnector({}, {})).rejects.toMatchObject({ name: 'ContextPolicyError', code: 'CONTEXT_POLICY_REQUIRED' });

A/B chung minh day la do thay doi cua toi, khong phai do pre-existing:

| Trang thai provider | `mdb-01-composition-provider.test.ts` |
|---|---|
| stub | **PASS** (`2 passed`) |
| implementation nay | **FAIL** (`1 failed, 1 passed`) |

Gia tri nhan duoc lai khi goi `prepareConnector({}, {})`:

    { skipped: true, code: 'INVALID_SOURCE', reason: 'connector preparation needs a source row and a normalized config' }

Dieu nay la **dung nhu yeu cau cua packet** (thay stub bang policy that), nen toi KHONG sua file do - no ngoai lease. Can MDB-01 owner (hoac coordinator cap lease) doi assertion nay sang *contract moi*: prepareConnector tra `skipped` cho input hong, va con fail-closed cho 6 callback khac. **Trong luc do, suite orchestrator co 1 test do.** Doc lap voi patch nay, noi ky: giua MDB-01 va MDB-POLICY-01 dang co mot xung dot contract chua duoc chot bang van ban.

**DELTA 2 - mat thong tin `staticFormFields` (va 15 field hien thi khac).**

`ConnectorRevisionConfigSchema` khong co cho 16 field hien thi cua LDBA-05. Policy nay khong ghi chung, nghiep do **`staticFormFields` cua connector legacy bi mat khi migrate** - cac form field tinh mao ma legacy gui di se khong duoc tao lai. Day khong phi quyet dinh ky thuat cua toi: hoac schema can bo sung truong, hoac can bang ghi rieng, hoac can ghi nhan chap nhan mat. Can product owner quyet.

## 7. Phan gioi

File da doi:

    scripts/ldba-context-provider.cjs        267 dong (file nay da la `??` untracked truoc do - toan bo provider chua commit)
    tests/mdb-policy-01-connector.test.cjs   307 dong (moi)

    scripts/ldba-context-provider.cjs   sha256 25bd4e059963e1f080cfb98db4dc381c1672cff3a82942644ae47980f0136088
    tests/mdb-policy-01-connector.test.cjs sha256 b51bccaddfce2476a493b823b9cc44cdea12630f70f7d48495829da91104d45d

- KHONG `git add` / `commit` / push. Khong mo cua so DB/Redis/S3; khong chay backfill that.
- Khong sua `ldba-03-backfill.cjs`, `ldba-03-production-adapter.cjs`, `mdb-01-composition-provider.test.ts` hay file nao khac ngoai lease.
- Khong tick gate, khong cap nhat task row/plan, khong tu nhan ACCEPTED.

## 8. Verdict

| Hang muc | Ket qua |
|---|---|
| Test suite moi (20 test) | **PASS** x3 lan lien tiep, exit 0 |
| RED mutation tren ban test cuoi | **18/20 do** voi dung trieu chung pre-fix |
| Typecheck orchestrator | **PASS** |
| Hop dong boot MDB-01 + 6 callback fail-closed | **DAT** (2 regression guard xanh o ca hai trang thai) |
| Cipher tu giai ma bang thuat toan cua connector | **DAT** |
| Config nam trong strict schema | **DAT** |
| Suite LDBA-03 | **14 red pre-existing** - A/B chung minh delta = 0 |
| Suite `mdb-01-composition-provider` | **1 RED do thay doi nay** - ngoai lease, xem DELTA 1 |

⇒ **MDB-POLICY-01: IMPLEMENTED, offline [PASS], chua ACCEPTED.** Blocked boi DELTA 1 (contract conflict voi MDB-01) va DELTA 2 (quyet dinh san pham ve `staticFormFields`); A1 van NOT PROVEN nen backfill that van bi chan dung.
