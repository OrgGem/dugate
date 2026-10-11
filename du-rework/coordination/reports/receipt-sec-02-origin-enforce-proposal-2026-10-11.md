# Proposal - SEC-OR-20261011-02: mac dinh warn van gui credential nguon den origin ngoai allowlist

| Muc | Gia tri |
|---|---|
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Finding | SEC-OR-20261011-02 (High), report `orchestrator-security-review-2026-10-11.md` dong 67-98 |
| Repo scope | du-rework |
| Van pham | proposal, **khong sua code** |
| Trang thai | DE XUAT - cho owner quyet dinh |

## 0. Ket luan ngan

**Finding dung, toi da kiem chung lai tung vi tri.** Nhung cach sua de bai neu (doi mac dinh thanh `enforce` trong code va Compose) **khong the lam ngay duoc**, vi no khong phai mot thay doi cau hinh - no la mot **thay doi du lieu**.

Hai du kien quyet dinh:

1. Migration `0041` them cot allowlist voi `DEFAULT '[]'` va **khong backfill** ⇒ moi row binding co san deu dang co allowlist **rong**.
2. `ORIGIN_POLICY_MISSING` va `ORIGIN_NOT_ALLOWLISTED` nam trong `PERMANENT_CODES` ⇒ khi enforce, chung la **loi vinh vien, khong retry**.

⇒ Doi mac dinh sang `enforce` ma khong backfill se lam **moi lan ingestion dung credential nguon cua du lieu cu that bai vinh vien**. Do la ly do chinh cua de xuat o §5.

## 1. Kiem chung doc lap tung claim

Toi khong tin report; toi doc lai tung dong.

| Claim cua report | Verdict | Bang chung |
|---|---|---|
| `ingestion-consumer.ts:180` mac dinh `warn` | **DUNG** | `:176-183` `sourceCredentialOriginModeFromEnv`: `undefined` hoac chuoi rong tra `warn`; gia tri khac `warn`/`enforce` thi **throw** |
| `acquisition-ref-resolver.ts:191` chi `enforce` moi tu choi | **DUNG** | `:180-200`: tinh `code` roi `if (mode === 'enforce') throw denial(422, code, ...)`; nguoc lai `return { code, origin }` - mot **warning**, khong chan |
| `acquisition-ref-resolver.ts:352` warn van gan credential | **DUNG** | `:337-360` `withSourceAuth`: check cho origin dau, roi `headers.set('authorization', Bearer ...)` hoac header credential khi `origin === originalOrigin` |
| `compose/orchestrator.yml:63` Compose mac dinh `warn` | **DUNG** | `${DU_SOURCE_CREDENTIAL_ORIGIN_MODE:-warn}` |
| Redirect cross-origin da bi redact | **DUNG** | `:355-357`: `origin !== originalOrigin` thi goi fetcher **khong** header; comment noi ro day la hanh vi co y |

## 2. Tra loi cau hoi fail-closed khi allowlist RONG

Day la cau hoi thu hai cua de bai. Cau tra loi ngan: **khong fail-closed o `warn`, co fail-closed o `enforce`.** Nhung truong hop rong la truong hop **xau nhat**, khong phai nhe nhat.

| Allowlist | `code` | `warn` | `enforce` |
|---|---|---|---|
| Rong hoac khong doc duoc | `ORIGIN_POLICY_MISSING` | **van gan credential** | tu choi 422 |
| Co entry, origin khong khop | `ORIGIN_NOT_ALLOWLISTED` | **van gan credential** | tu choi 422 |
| Co entry, origin khop | khong co | gan credential | gan credential |

Ba diem can nho ve truong hop rong:

1. **Rong nghia la khong co chinh sach, khong phai chinh sach cho phep.** Nhung o `warn` hai dieu do **hanh xu giong nhau**: deu gui credential. Nghia la mot deployment chua tung khai approved origin nao van ship secret ra ngoai.
2. **Khong doc duoc allowlist thi am tham thanh rong.** `acquisition-ref-resolver.ts:181-182` dung `safeParse(auth.allowedOrigins ?? [])` roi lay `[]` khi parse that bai. Mot gia tri allowlist hong (sai scheme, qua 16 entry, trung sau canonical hoa) **khong** gay loi boot hay loi doc - no lang le tro thanh rong. O `enforce` ket qua la tu choi (an toan), nhung ma loi la `ORIGIN_POLICY_MISSING` chu khong phai ly do that.
3. **Row cu luon rong.** Xem §4.

## 3. Phuong an 1 - doi mac dinh trong code va Compose

**Noi dung:** `sourceCredentialOriginModeFromEnv` tra `enforce` khi bien chua duoc dat; `compose/orchestrator.yml:63` doi `:-warn` thanh `:-enforce`.

**Danh gia: dung ve huong, nhung thieu dieu kien tien quyet.**

| Mat | Nhan xet |
|---|---|
| Hieu qua | Day la cach duy nhat de **mac dinh an toan** - khong phu thuoc nguoi van hanh nho dat bien |
| Khop thiet ke cu | `proposal-or10-01-origin-allowlist-2026-10-10.md` §4.4 da thiet ke `warn` nhu mot **ram chuyen tiep**, va §3 buoc 3 ghi ro viec doi warn->enforce thuoc ve env docs + deployment config |
| Tai lieu dang noi nguoc | `docs/12b-deployment-guide.md:108` dang ghi `warn` by default, chi dat `enforce` **sau khi** da ra soat allowlist va warning da sach. Doi mac dinh ma khong sua dong nay se de lai tai lieu sai |
| Rui ro | Xem §4 - khong phai rui ro nho |

**Ket luan ve phuong an 1:** chap nhan duoc, nhung **phai di kem backfill du lieu** va mot cua so quan sat. Khong nen dispatch nhu mot thay doi mot dong.

## 4. Ban kinh that cua viec doi mac dinh

### 4.1 Loi nay khong retry

`ingestion-consumer.ts:319-334` dinh nghia `PERMANENT_CODES`, va `:445` dung `PERMANENT_CODES.has(failureCode(err))`. Comment tai `:315-319` noi ro: non-retryable, redelivery khong doi duoc ket qua, nen escalate ngay thay vi dot retry budget.

Ca `ORIGIN_NOT_ALLOWLISTED` (`:332`) lan `ORIGIN_POLICY_MISSING` (`:333`) nam trong tap nay. Nghia la khi `enforce`:

- khong co retry;
- task/operation chuyen sang terminal ngay;
- va no xay ra **truoc moi I/O mang** (`:602-604` nam truoc buoc transfer), nen khong ton chi phi mang - nhung cung nghia la **khong co duong tu phuc hoi tu dong**.

### 4.2 Moi row cu deu co allowlist rong

`migrations/0041_profile_binding_allowed_origins.sql:4`:

    ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb;

Khong co cau `UPDATE` nao. Vay moi binding duoc tao truoc 0041 co `allowed_origins = '[]'`. Ket hop voi §4.1: **bat enforce ma khong backfill = moi ingestion dung credential nguon cua du lieu cu that bai vinh vien.**

### 4.3 Mot test dang pin mac dinh cu

`tests/p730-acquire-consumer-auth.test.ts:32-35`:

    it('defaults to warn and accepts the explicit enforce rollout value', () => {
      expect(sourceCredentialOriginModeFromEnv({})).toBe('warn');

⇒ Doi mac dinh se lam do test nay. Day la **thay doi co chu y**, phai sua cung luc va doi ten test cho dung nghia - khong duoc trinh bay nhu mot test hong duoc va.

## 5. De xuat: lam theo thu tu, khong nhay

| Buoc | Viec | Dieu kien hoan thanh |
|---|---|---|
| 1 | **Do truoc, khong doi gi.** Dem so binding co credential nguon va co `allowed_origins` rong; dem warning `credential.origin_denied` hien co | Co so that: bao nhieu row se fail neu bat enforce hom nay |
| 2 | **Backfill allowlist** cho cac row that su dung credential nguon, dua tren origin that cua chung | 0 row dung credential nguon con allowlist rong |
| 3 | **Doi mac dinh** trong `ingestion-consumer.ts` + `compose/orchestrator.yml`, sua `docs/12b-deployment-guide.md:108` va `.env.docker.example:63`, cap nhat test o §4.3 | Test moi: khong dat bien ⇒ `enforce`; gia tri la van throw |
| 4 | **Giu duong lui co pham vi**: cho phep dat tuong minh `warn` trong mot cua so co thoi han, ghi ly do | Khong co cua so mo vo thoi han |

**Neu owner muon giam rui ro ngay ma chua backfill duoc:** dat `DU_SOURCE_CREDENTIAL_ORIGIN_MODE=enforce` o **tang deployment** cho cac moi truong da khai du allowlist (report §Hướng sửa da neu), va **khong** doi mac dinh trong code. Cach nay giam rui ro ngay cho moi truong da san sang ma khong bien mot thay doi du lieu thanh dieu kien bat buoc.

**Phuong an thay the dang can nhac:** them trang thai thu ba (vi du `warn-start`) khong giup gi o day - van de khong phai so luong che do, ma la **du lieu chua san sang**. Vi vay toi khong de xuat no.

## 6. Bai hoc lien quan can sua cung dot (nho, doc lap)

`safeParse` roi `[]` (§2 diem 2) khien mot allowlist hong bi coi la rong. Nen co mot kenh chan doan rieng: khi `allowedOrigins` **co gia tri** nhung parse that bai, bao mot ma rieng (vi du `ORIGIN_POLICY_INVALID`) thay vi dung chung `ORIGIN_POLICY_MISSING`. Day la cai thien kha nang chan doan, khong phai sua lo hong - va no khong thay doi hanh vi cho/khong cho.

## 7. Quyet dinh can owner

1. Co backfill allowlist cho du lieu cu truoc khi doi mac dinh khong, va ai lam? (day la quyet dinh du lieu, khong phai quyet dinh code)
2. Neu chua backfill: co chap nhan cach giam rui ro o tang deployment thay vi doi mac dinh khong?
3. Cua so cho phep `warn` tuong minh keo dai bao lau, va ai theo doi warning truoc khi dong?

**Rui ro lease khi trien khai:** `git status` tai 2026-10-11 cho thay chinh cac file ma phuong an 1 phai sua **dang ` M` boi lane khac**: `compose/orchestrator.yml`, `.env.docker.example`, `ingestion-consumer.ts`, `acquisition-ref-resolver.ts`. Nguoi trien khai phai lay lease va giu nguyen hunk cua nguoi khac; khong nen dispatch ngay neu chua thong bao chu soat, va phai doc lai `file:line` tai thoi diem do vi cac dong co the da lech.

## 8. Gioi han va pham vi

- **Read-only.** Toi khong sua code, khong chay test, khong mo cua so DB. Moi dieu trong tai lieu nay den tu doc `file:line` tai 2026-10-11.
- Toi **khong do** so row co allowlist rong - do la buoc 1 cua §5 va can mot cua so DB, khong thuoc pham vi proposal nay.
- Da co san va khong can lam lai: `proposal-or10-01-origin-allowlist-2026-10-10.md` (thiet ke goc, ke ca ram warn->enforce) va `verify-orchestrator-security-INDEPENDENT-DSH2-2026-10-11.md` (da kiem chung SEC-02 doc lap, gom ca truong hop allowlist rong). De xuat nay **bo sung** bang chung ve ban kinh di tru, khong thay the hai tai lieu do.

**Tu kiem chung trich dan:** toi chay 18 kiem tra doc dong (moi kiem tra: dong do co chua chuoi mong doi khong). Ket qua **18/18 dung**. Bon lan bao lech dau tien la **loi cua bo kiem**, khong phai loi tai lieu: kim don dong roi vao giua mot doan comment hoac mot khai bao nhieu dong, trong khi trich dan trong tai lieu nay von da neu dung pham vi (vi du :315-319, :337-360, :32-35). Toi doc chinh doan truoc khi ket luan.

## 9. Bang chung file:line

    services/orchestrator/src/modules/operations/ingestion-consumer.ts
      :176-183  sourceCredentialOriginModeFromEnv (mac dinh warn)
      :315-319  comment non-retryable
      :319-334  PERMANENT_CODES (co ca hai ma origin)
      :445      PERMANENT_CODES.has(failureCode(err))
      :600-604  pre-check trong openGate, truoc moi I/O

    services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts
      :180-200  tinh code, chi enforce moi throw
      :337-360  withSourceAuth: gan credential cho origin dau

    services/orchestrator/migrations/0041_profile_binding_allowed_origins.sql:4
      ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb  (khong backfill)

    compose/orchestrator.yml:63          DU_SOURCE_CREDENTIAL_ORIGIN_MODE:-warn
    .env.docker.example:63               DU_SOURCE_CREDENTIAL_ORIGIN_MODE=warn
    docs/12b-deployment-guide.md:108     tai lieu dang mo ta mac dinh warn
    services/orchestrator/tests/p730-acquire-consumer-auth.test.ts:32-35  pin mac dinh warn
