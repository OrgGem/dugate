# Dispatch Spec: SEC-02-COUNT — dem truoc bang chung cho viec doi mac dinh origin mode (read-only)

- Date: 2026-11 (ky thuc: 2026-10-11)
- Role: Dispatch (Qwen-B, theo y nguoi dung)
- Repo scope: du-rework
- Status: **DA GOP — thay cho `2026-10-11-AWEB-ORIGIN-CREDENTIAL-COUNT.md`, va da gui den dispatcher de gan owner. Xem §7**
- Van pham: chi file nay. KHONG sua code san pham.

---

## 1. Van de phai tra loi

Proposal `coordination/reports/receipt-sec-02-origin-enforce-proposal-2026-10-11.md` de xuat doi mac dinh `DU_SOURCE_CREDENTIAL_ORIGIN_MODE` tu `warn` sang `enforce`. Buoc 1 (do truoc, khong doi gi) toi **khong the lam vi toi khong co cua so DB**. Buoc do la dieu kien truoc moi thay doi, vi theo du kien §4 cua proposal, no quyet dinh co backfill truoc khi doi mac dinh hay khong.

Cong viec nay tra loi ba cau hoi: **bao nhieu row se that bai ngay** neu bat `enforce`, va chia theo loai.

## 2. Nguon du lieu dung (da verify, khong doan)

Bo resolve doc dung `profile_bindings`, chinh xac hai cot sau (`orchestrator/services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts:103-105`):

    SELECT tenant_id, file_url_auth_cipher, allowed_origins FROM profile_bindings WHERE profile_id=$1 AND revision=$2

Ket hop voi `:258-259`: `cipher` rong hoac null thi `AUTH_CONFIG_MISSING`. Va `:180-200` chi chay trong truong hop co credential.

⇒ `file_url_auth_cipher` **khong rong/null** = row se bi gate. `allowed_origins` = mang rong = se bi tu choi `ORIGIN_POLICY_MISSING`.

**Can nho:** cung la row **revision** (khong phai connector). Mot profile co nhieu revision, nen phai bao cao ca so **row** va so **profile_id** rieng biet, neu khong so se vuot qua.

## 3. Bieu do SQL (goi y, lane tu soan lai)

**Buoc 0, truoc moi cau dem** — kiem tra cot co that, khong tin vao migration file (trinh thuc trong `verifyMigrations` khong xem schema that, xem memory `migration-verify-trap-fix-state`):

    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'profile_bindings'
       AND column_name IN ('file_url_auth_cipher', 'allowed_origins');

Neu ket qua khong co `allowed_origins` ⇒ **dung lai**, ghi nhan vao receipt, va hoi. Co the DB do chua ap migration 0041, hoac day khong phai DB dich.

**Cau dem.** Van de bai toan: `NOT (predicate)` cho ket qua NULL khi cot thieu khoa, va NULL khong phai TRUE nen dong do **bi bot suot** - dang nguy hiem nhat do hieu qua la khong con gi de lam. Dung `COALESCE`.

    SELECT
      count(*) FILTER (WHERE cipher_present)                                          AS gated_rows,
      count(*) FILTER (WHERE cipher_present AND COALESCE(empty_allowlist, FALSE))      AS would_fail_no_policy,
      count(*) FILTER (WHERE cipher_present AND NOT COALESCE(empty_allowlist, FALSE) AND allow_len > 0) AS would_pass,
      count(*) FILTER (WHERE cipher_present AND allow_len IS NULL)                     AS allowlist_missing,
      count(DISTINCT profile_id) FILTER (WHERE cipher_present)                          AS gated_profiles,
      count(DISTINCT tenant_id) FILTER (WHERE cipher_present)                           AS gated_tenants
      ... de tong hop lai thanh mot bang, dung chi so tong

Trong do:

    cipher_present  = file_url_auth_cipher IS NOT NULL AND length(btrim(file_url_auth_cipher)) > 0
    allow_len       = jsonb_array_length(allowed_origins)   -- se NULL neu cot la NULL
    empty_allowlist = allow_len = 0

**Ket qua doi chieu bat buoc:** `gated_rows == would_fail_no_policy + would_pass + allowlist_missing`. Neu khong bang, co dau hieu cot khong nhu mong doi (khac NULL/khac kieu).

**Khong bao gio** in ra noi dung `file_url_auth_cipher` (hay ciphertext nao). Chi dem. Cau dem khong can key va khong phai giai ma - chi can biet khong rong.

## 4. Bao cao warning hien co (khong phai DB)

Canh bao **khong** duoc luu trong DB. No di ra structured logger (`orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:696-710`), voi:

    message   credential origin policy warning
    code      ORIGIN_POLICY_MISSING | ORIGIN_NOT_ALLOWLISTED
    event.kind credential.origin_denied

Vi tri doc: Elasticsearch collector neu deployment co bo do, khong thi log stdout (container `orchestrator`). **Neu khong truy cap duoc** hai do, ghi `no data` vo receipt - **khong duoc doan 0**. Quy dinh nay de tranh mot cua so quan sat trong suot cho mot quyet dinh ve mat dat.

**Khong luu tru** phan hien thi origin hay tenant tu log vao receipt. Chi so luong.

## 5. Lease va rang buoc

- **Read-only tuyet doi.** Chi doc, khong ghi, khong sua, khong them cot, khong them migration.
- **Khong sua** `scripts/`, `src/`, migration, Compose, hoac bat ky file nao. **Kieu chi** viec dem khong phai sua code.
- **Khong su dung DB production/legacy.** DB dich la DB du-rework da ap 0041 (xem `verifyMigrations` hoac `information_schema`). Neu khong co DB dich, dung **PG16 throwaway** (precedent: `backfill-leftover-counter-803` chay tren container `du-leftover-counter` cong `:54398`, va `backfill-counter-fixes-807` tren `du-counter-fix` `:54397`), khong dung du lieu that.
- **Chay cung `SET LOCAL transaction_read_only = on`** va doc lai `SHOW transaction_read_only` truoc khi dem. Khong dung `SET LOCAL default_transaction_read_only` - do chi tac dung len cac giao dich TOI, khong phai giao dich dang chay. Nhap nhay, khong doi lenh do.
- **Khong chay chinh scripts dem cung `migrate`**. Khong su dung `LDBA_ALLOW_UNVERIFIED_TIMEZONE` (A1 van NOT PROVEN).

## 6. Acceptance

- Buoc 0 information_schema chua ket qua (cot co, kieu, NULL, default).
- Ba so `gated_rows`, `would_fail_no_policy`, `would_pass` va doi chieu `gated_rows == would_fail_no_policy + would_pass + allowlist_missing`.
- `gated_profiles` va `gated_tenants` rieng biet (khong tinh trung voi row).
- `SHOW transaction_read_only` = `on`, va buoc dem co in ra `READONLY` truoc khi dem (khong phai chay tuong).
- Khong co ciphertext nao trong receipt va raw log.
- Co doan **khong xac dinh** (neu khong truy cap duoc warning) thay vi so 0.
- Raw output tai `coordination/reports/raw/sec-02-count-2026-10-11/`.
- Receipt tai `coordination/reports/receipt-sec-02-backfill-count-2026-10-11.md` (xem §7).

## 7. Owner va bang chung dispatch

**Owner: PENDING.** Toi khong the chon owner, vi `list_agents` trong phien nay tra ve **rong** (khong co agent thuong co san). Theo `COORDINATOR-CONTRACT.md` §2, truoc khi chon owner phai inspect runtime that (connected ≠ idle ≠ executing), va `DISPATCH-LIVE-2026-10-10.md` la **ledger lich su, khong phai bang chung hien tai**.

**Bang chung dispatch:** packet nay **khong phai bang chung**. Nguoi giao (Antigravity) phai: (1) inspect roster that, (2) giao qua runtime that, (3) ghi request/dispatch ID vao receipt. Neu khong co ID, khong co bang chung dispatch.

**Da gop voi packet cu:** `2026-10-11-AWEB-ORIGIN-CREDENTIAL-COUNT.md` da duoc danh dau **DA BI THEO** o §9 cua no, vi premise cua no (chua biet credential nguon nam o bang nao) da duoc giai quyet bang doc code. Neu packet cu do da chay roi, ket qua cua no van giu lai nhung **khong dung lam dau vao quyet dinh** — hay chay lai mot lan tren co so duy nhat de tranh hai nguoi do tren hai DB khac nhau.

**Verifier doc lap** voi implementer truoc khi dung ket qua nay cho quyet dinh.

## 8. Bang chung file:line (da verify)

    orchestrator/services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts
      :103-105   BINDING_CIPHER_SQL: profile_bindings, file_url_auth_cipher, allowed_origins
      :180-200   tinh code; ORIGIN_POLICY_MISSING khi list rong; chi enforce moi throw
      :258-259   cipher null/rong thi AUTH_CONFIG_MISSING

    orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:696-710
      logger.warn('credential origin policy warning', ...); event.kind = credential.origin_denied

    orchestrator/services/orchestrator/migrations/0041_profile_binding_allowed_origins.sql:4
      ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb  (khong backfill)

    orchestrator/services/orchestrator/src/modules/operations/ingestion-consumer.ts
      :176-183   mac dinh warn
      :319-334   PERMANENT_CODES (ca hai ma origin)
      :445       PERMANENT_CODES.has(failureCode(err))
