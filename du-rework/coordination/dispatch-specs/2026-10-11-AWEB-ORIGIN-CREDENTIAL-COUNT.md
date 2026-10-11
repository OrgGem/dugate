# Dispatch Spec: AWEB-ORIGIN-CREDENTIAL-COUNT — dem read-only so luong credential nguon

| Muc | Gia tri |
|---|---|
| Task ID | AWEB-ORIGIN-CREDENTIAL-COUNT |
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Repo scope | du-rework |
| Owner | terminal Codex `term_e97ba66f-1196-401d-8e69-5287bd788b9d` (xem §7) |
| Lease | READ-ONLY. Khong sua file nao |
| Receipt | du-rework/coordination/reports/receipt-aweb-origin-credential-count-2026-10-11.md |
| **Trang thai** | **DA BI THEO - xem §9. Khong dung lam nguon cho quyet dinh nua.** |

## 9. Da bi SEC-02-COUNT-readonly thay the (ghi 2026-10-11, coordinator)

Toc nay ghi *chua biet credential nguon nam o bang nao, phai do bang `information_schema` de chot*. **Premise do da duoc giai quyet bang doc code, khong can do DB:** bang la `profile_bindings`, cot la `file_url_auth_cipher` va `allowed_origins`, doc tai `modules/operations/acquisition-ref-resolver.ts:103-105`. Nghia la Q2 trong §3 da co dap an cau hinh, phan con lai la so dem.

⇒ Cong viec do **bi gop vao** `2026-10-11-SEC-02-COUNT-readonly.md`, goi tat ca yeu cau dem vao mot cho, va **do chinh xac hon** (co san SQL, co san quy tac read-only, co san phep doi chieu tong).

**Neu task nay da chay roi:** ket qua cua no **van giu lai** nhung khong dung lam dau vao quyet dinh. Hay gap voi phan do cua SEC-02-COUNT: chay lai mot lan tren co so duy nhat de tranh hai nguoi do tren hai DB khac nhau.

## 1. Vi sao co task nay

Proposal `du-rework/coordination/reports/receipt-aweb-origin-enforce-proposal-2026-10-11.md` de xuat doi mac dinh credential origin mode tu `warn` sang `enforce` sau khi backfill data. Task nay la **buoc 1** cua do: **do truoc, khong doi gi**.

Truoc khi doi mac dinh, can biet **co bao nhieu binding dang co credential nguon** — vi moi binding do la mot chu so huu deployment cu bi chan neu khong khai bao dung origin. Con khong co so lieu thi quyet dinh dua tren phong doan.

## 2. Read-only, tuyet doi

- **Khong sua code, khong sua migration, khong sua compose.** Kieu dem khong phai sua code.
- **Khong ghi vao DB.** Cau lenh chi doc.
- **Khong `git add` / `commit` / `push`.**
- **Khong tick gate.** Khong tu nhan AWEB-AUDIT-A2 da dong.
- Doc them `.env`, `.env.live`, file key/secret: **khong**. Khong ghi secret nao vao receipt.

## 3. Cau hoi can tra loi bang so

| # | Cau hoi |
|---|---|
| Q1 | Tong so row trong bang chua binding (khong loc) |
| Q2 | Trong do, **bao nhieu row co credential nguon** — so nay la so then chot |
| Q3 | Co the chia nho hon khong (theo binding active / theo loai credential)? |
| Q4 | Neu Q2 khong do duoc, ly do ky thuat la gi? |

**Ve Q2 — can la chan hanh nghia, khong duoc doan.** Chung ta khong co bang chung rang credential nguon duoc luu trong bang nao, hay co cach danh dau nao. Ve vi du khong phai mot quy uoc: `projects` (data_governance) va `admin_governance_proposals` deu la bang trong du-rework va cung mang chu legacy.

Neu can xac nhan, dung `information_schema` doc cot bang do co that trong DB dich truoc khi viet cau dem. **Khong tin tai lieu mo ta**.

## 4. Ranh gioi chua duoc vuot

- **Chi dem, khong sua gi** — ke ca khi ket qua ra ve cach dung sai. Task nay khong phai task sua code.
- **Khong mo cua so DB neu chua duoc yeu cau cua coordinator.** Neu can mot cua so DB de dem, **dung `asking` / `ask` de hoi**, khong tu mo.
- **Neu so dem phu thuoc vao cap hinh deploy (vi du chi doc data_governance), ghi ro phan nao doc duoc offline va phan nao can cau so DB.**

## 5. Dinh dang receipt

- File: `du-rework/coordination/reports/receipt-aweb-origin-credential-count-2026-10-11.md`
- Markdown, **0 ky tu nhay kep ASCII** (dung backtick hoac bo qua truong hop phai ngoac kep).
- Dau file: dong `Trang thai` = `DA DEM DUOC` hoac `CHUA DEM DUOC` (hon mot phan).
- Bang so lieu + file:line noi binding/credential dinh nghia + command chay kem exit code + xac nhan khong ghi.

## 6. Tieu chi hoan thanh

- [ ] Xac minh bang `information_schema` bang/nao thuc su chua binding va co cot credential khong.
- [ ] Q1 va Q2 tra loi bang so thuc te kem command + exit code.
- [ ] Neu Q2 khong chot duoc: ghi ro **vi sao khong chot duoc** va dieu kien gi de chot duoc (it nhat la bang do, hoac co co che danh dau credential nao dang ton tai o code khong).
- [ ] Receipt: 0 nhay kep ASCII, co exit code, co xac nhan khong ghi vao DB.
- [ ] Khong sua file nao. Khong `git add`/`commit`/`push`. Khong tick gate.

## 7. Owner: bang chung chon owner

Da inspect runtime that qua `orca terminal list --json`, khong dung ledger cu. Runtime `103b75ef-947d-4372-80bd-41010d8c6c7e`, app `1.4.219`, state `ready`. Co 10 terminal, trong do 5 dang chay lenh (preview dang co spinner). Cac terminal idle:

| Handle | Agent | Trang thai |
|---|---|---|
| `term_e97ba66f-1196-401d-8e69-5287bd788b9d` | Codex | **Idle**, vua xong BIZ-11, dung `D:\Git\dugate` |
| `term_cd3c19e4-9328-4f99-bc26-8b87f195a5e4` | Codex | Idle, vua xong BIZ-10 |
| `term_25de3310-c775-4703-86f1-5462afee63df` | Qwen | Idle, dang cho quyet dinh W1-W10 |
| `term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8` | Claude | Idle |

**Chon `term_e97ba66f`:** dang idle thuc su (read tail xac nhan prompt san, khong co lenh chay), va vua lam viec lien quan contract/tenant-scoping — khoi context du dung cho mot task read-only. `term_25de3310` dang **cho mot quyet dinh** nen chua san sang nhan task moi.

## 8. Hanh vi dung

- **Khong sua file san pham** (chi ghi 1 file receipt trong §5).
- **Khong `git add` / `commit` / `push`.**
- **Khong tick gate** va khong tu nhan task nay da ACCEPTED.
- Khong mo cua so DB neu chua duoc yeu cau (xem §4).
- Khi ket thuc: bao ro so Q1/Q2, va neu Q2 chua chot duoc thi ro dieu kien can de chot.
