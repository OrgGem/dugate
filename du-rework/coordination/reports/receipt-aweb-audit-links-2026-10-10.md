# AWEB-AUDIT-RESOURCE-LINKS - duong thoat tu mot ban ghi audit

| Muc | Gia tri |
|---|---|
| Task | AWEB-AUDIT-RESOURCE-LINKS-2026-10-10 |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | du-rework |
| Plan | coordination/reports/survey-workflows-connectors-2026-10-10.md §5.2 va W-C |
| Lease | **dung mot file**: orchestrator/apps/admin-web/src/features/audit/audit-screen.tsx |
| Trang thai | IMPLEMENTED + offline-verified [PASS]. CHUA ACCEPTED |
| Receipt | coordination/reports/receipt-aweb-audit-links-2026-10-10.md |

## 1. Viec dau tien phai lam: doi chieu lai thuc te

Truoc khi sua toi doc lai file va thay **no da bi lane khac sua trong luc toi phan tich**: 338 dong khi toi doc dau tien, **453 dong** khi toi bat dau sua, va dong 3 da co `import { useSearchParams } from 'react-router'`.

Toi doc lai thay lane do **da lam xong nua inbound** - `auditFiltersFromQuery` (`:93-120`) doc `severity`, `operationId`, `resource`, `from`, `to`, `sort`, `limit`, `action`, `actor` tu URL, kem kiem tra tenant tu link (`:139-148`, `:171-177`) va mot canh bao correlation id (`:387`). Do la phan Audit cua AWEB-21.

⇒ **Toi khong viet lai phan do.** Delta cua toi chi la nua **outbound**, va do dung la phan con thieu: truoc khi sua, `grep Link` trong file = **0 hit**, va o Resource van la `{event.resourceId || '—'}` - chu thuong, khong di duoc dau.

## 2. Thiet ke: chi phat link ma dich den THUC SU doc tham so

Day la diem toi can noi ro vi no lech khoi vi du trong de bai. De bai goi y `/operations?id=...`; toi **khong phat link do**. Ly do do duoc:

    grep useSearchParams tren apps/admin-web/src  ->  4 hit:
        features/trace/trace-screen.tsx:3, :83
        features/audit/audit-screen.tsx:3, :128

Operations **khong** co trinh doc query. Neu toi phat `/operations?id=`, nguoi dung se thay URL dung, man mo ra dung, nhung **danh sach khong duoc loc** - dung loai loi toi vua ghi o §5.2 cua bao cao khao sat. Them mot link nua-chet nua la lam nang dung cai van de ma task nay sinh ra de sua.

Hai dich den duoc chon vi chung doc tham so **hom nay**:

| Link phat ra | Dich den doc o dau |
|---|---|
| `/audit?resource=<resourceId>` | `auditFiltersFromQuery` ngay trong file nay (`:99`) |
| `/trace?operationId=<id>` | Trace: `useSearchParams` (`trace-screen.tsx:83`) + danh sach lookup kind (`:67`) |

Nhu vay moi dong audit deu co duong thoat **song that**, va duong `/trace?operationId=` giu dung y **doi xung voi man Trace** - chieu nguoc lai cua link ma Trace da phat (`trace/state.ts:366-373`).

## 3. Sua gi

### 3.1 `auditEventLinks` (ham moi, cung file)

    function auditEventLinks(resourceId: string): { audit: string | null; trace: string | null }

- `resourceId` qua `safeQueryValue` (sanitizer da co o `:78`) truoc khi vao URL - nen gia tri co ky tu dieu khien hoac qua dai bi tu choi thay vi nhet vao href.
- Resource rong/khong hop le -> ca hai link la `null`, o do render chu nhu cu.
- `/^operation:(.+)$/i` nhan dang resource cua operation; khong phai operation thi **khong** co link Trace (Trace tra cuu operation, khong tra cuu business).

### 3.2 O Resource trong bang

- `map` chuyen tu bieu thuc sang block de tinh `links` mot lan cho moi dong.
- Khi co link: resource thanh `<Link>` (focused view cua chinh ban ghi do), kem link thu hai **Open incident** khi resource la operation.
- Khi khong co link: giu nguyen hanh vi cu (`{event.resourceId || '—'}`).

## 4. Bang chung chay

CWD `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`. Node v24.21.0. Runner `node --test` (admin-web khong co script test).

Vi mot lane khac dang sua dung file nay, toi chay trong mot script in sha256 **truoc** va **sau** moi lenh:

    DIGEST_BEFORE 54ce19a63a331ce4252f48681e77ad52410006370773379bd7f8181d3b72afb5
    TEST=0
    TSC=0
    DIGEST_AFTER  54ce19a63a331ce4252f48681e77ad52410006370773379bd7f8181d3b72afb5

Digest khong doi ⇒ ket qua duoi day gan voi **dung mot ban byte**:

    tests 34 / pass 34 / fail 0     (audit-state + trace-state + operations-state)
    tsc --noEmit -p tsconfig.json   exit 0, khong output

`tsconfig.json` bat `noUnusedLocals` + `noUnusedParameters`, nen `Link` duoc import ma khong dung se **khong build duoc** - typecheck la bang chung cho viec noi day.

## 5. Gioi han - noi that

1. **Khong co unit test cho `auditEventLinks`.** Lease la **mot file `.tsx`**, ma `node --test` khong parse duoc JSX, nen khong the import ham nay tu `tests/*.test.mjs`. Va `features/audit/state.ts` (noi test hien import) **ngoai lease**. Day la ly do chinh dang de xin **mo lease** sang `features/audit/state.ts` cho mot follow-up co test that. Hien tai bang chung la typecheck + doc code, khong phai assertion.
2. **Khong chay UI/browser.** Khong chung minh bang thuc thi rang bam link ra dung man da loc; do la suy ra tu viec **doc** tham so cua dich den (co bang chung file:line o §2).
3. **Nguong 128 ky tu:** resource dai hon `safeQueryValue` se **khong** co link (van hien chu). Day la bao ve co chu, khong phai loi - nhung can biet la co nguong.
4. `features/audit/` **untracked trong git**, nen provenance la sha256 chu khong phai `git diff`.
5. File nay dang co **writer khac**. Neu ho sua tiep sau ban `54ce19a6...`, ket qua §4 het hieu luc.

## 6. Dinh chinh mot Delta cu (tu receipt AWEB-20)

Trong receipt AWEB-20 toi ghi mot hien tuong khong giai thich duoc: mot lan chay `operationsPopulation` tra ve **chuoi JSON** thay vi chuoi join bang `|`. Nay toi da thay manh moi: `audit-screen.tsx:65` co `cursorScopeKey` = `JSON.stringify([tenantId, filters])` - **cung ho** voi fingerprint dang JSON. Nhieu kha nang lane kia dang dong bo Operations theo kieu cua Audit. Toi **khong khang dinh** day la nguyen nhan, chi ghi lai de lan sau ai doc Delta do khong phai do lai tu dau.

## 7. Phan gioi

- Chi sua `orchestrator/apps/admin-web/src/features/audit/audit-screen.tsx` (489 dong, sha256 `54ce19a63a331ce4252f48681e77ad52410006370773379bd7f8181d3b72afb5`). Khong dung file nao khac.
- KHONG `git add` / `commit` / push. Khong tick gate, khong tu nhan ACCEPTED.
- **0 ky tu nhay kep trong receipt nay** (rang buoc cua de bai).
- Khong revert hay ghi de phan inbound cua lane khac - toi doc no, giu nguyen, va xay tiep len tren.

## 8. Verdict

| Hang muc | Ket qua |
|---|---|
| Audit co duong thoat tu mot ban ghi | **DA CO** - moi dong co link (khi resource hop le) |
| Doi xung voi Trace | **DAT** - `/trace?operationId=` la chieu nguoc cua link Trace da phat |
| Link phat ra deu doc tham so that | **DAT** - co bang chung file:line o §2 |
| `/operations?id=` (vi du trong de bai) | **KHONG phat** - dich den chua doc tham so; xem §2 |
| Test + typecheck admin-web | **34/34 PASS**, tsc exit 0, digest on dinh |
| Unit test cho logic moi | **KHONG CO** - can mo lease; xem §5.1 |

⇒ **AWEB-AUDIT-RESOURCE-LINKS: IMPLEMENTED, offline [PASS], chua ACCEPTED.** Can mot luot integration/browser de dong, va nen mo lease sang `features/audit/state.ts` de co test that.
