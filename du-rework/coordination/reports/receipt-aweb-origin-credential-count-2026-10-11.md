# Dispatch receipt: AWEB-POLICY-01 / AWEB-ORIGIN-CREDENTIAL-COUNT (read-only)

| Muc | Gia tri |
|---|---|
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Task | AWEB-ORIGIN-CREDENTIAL-COUNT — dem read-only so luong credential nguon |
| Owner | terminal `term_e97ba66f-1196-401d-8e69-5287bd788b9d` (Codex, D:\Git\dugate) |
| Dispatcher | Qwen-B (`term_bd1937f8-0134-4d02-b511-353625e8a3ae`) |
| Trang thai | DA DISPATCH — cho owner chay. CHUA CO KET QUA, CHUA ACCEPTED |

## 1. Bang chung dispatch (tu runtime that, khong phai ke hoach)

| Truong | Gia tri |
|---|---|
| Dispatch ID | `ctx_f1c7c0e52e3a` |
| Task ID | `task_a231ad97baca` |
| Run ID | `run_bd5609db31ae` |
| Runtime | `103b75ef-947d-4372-80bd-41010d8c6c7e`, app `1.4.219` |
| Dispatch status | `dispatched` (dispatched_at 2026-10-11 02:14:10) |
| Mutation request ID | `14ac881e-ef5e-406f-a083-9ca2a3ddfd22` (replayed: false) |
| Launch token hash | `4f278d1d...6778dec9` |

**Owner duoc chon theo inspect runtime, khong theo ledger cu.** Truoc khi chon, toi da `orca terminal list --json` toan bo 10 terminal: runtime `ready`, 5 terminal dang chay lenh (preview co spinner), 5 idle. Ung vien idle da doc tail tung cai de xac nhan prompt san, khong phai tu hien trang thai:

| Terminal | Agent | Ly do |
|---|---|---|
| `term_e97ba66f` | Codex | **Chon.** Idle thuc su (prompt san, vua xong BIZ-11), dung `D:\Git\dugate`, co ngu canh contract/tenant-scoping |
| `term_cd3c19e4` | Codex | Idle (vua xong BIZ-10), khong chon vi khong co ngu canh origin/allowlist |
| `term_25de3310` | Qwen | Idle nhung **dang cho mot quyet dinh** W1-W10 → chua san sang nhan task moi |
| `term_19edcad8` | Claude | Idle, nhung khong co ngu canh du-rework |

**Da thu truoc do va that bai — ghi lai de khong lap lai:** `task-create` khong co Run bi tu choi (`run_required`); `run-create` thieu `--objective`; `dispatch --type` khong phai flag hop le; `worker-start --task` bi tu choi vi task da `dispatched`. Do hinh thanh chuan: tao Run → task-create trong Run → dispatch toi terminal.

## 2. Receipt can nop

    du-rework/coordination/reports/receipt-aweb-origin-credential-count-2026-10-11.md

Dinh nghia win/lose cua task (trich tu packet):

- Q1: tong so row trong bang chua binding (che password trong DB URL).
- Q2: trong do bao nhieu row co credential nguon — **so then chot**. Neu khong doan tot duoc, phai noi ro vi sao va de xuat cach do thay vi bi so.
- Q3/Q4: phan con lai neu co.
- Phai xac nhan khong ghi, khong git add/commit/push, 0 nhay kep ASCII trong receipt.

## 3. Rang buoc ap cho owner

- **Chi doc.** Khong sua vao file nao, ke ca khi ket qua ra ve cach sua. Khong mo cua so neu chua duoc phep.
- **Khong `git add` / `commit` / `push`.**
- **Khong tick gate** va khong tu nhan da ACCEPTED.
- Ket thuc: `worker_done` ve run voi Nghiép Duc thay vi ket thuc bang hoi nguoc.

## 4. Trang thai hien tai

Dispatch da ghi; terminal owner **chua bat dau turn** (`injected: false`, `last_heartbeat_at: null`, tail chua doi). Theo quy tac, input da chap nhan **khong phai** bang chung turn da bat dau; khong gui lai lan hai. Chuoi tiếp theo la cho dispatch sang `completed`, roi receipt ket qua toi `receipt-aweb-origin-credential-count-2026-10-11.md`, cuoi cung verifier doc lap truoc khi ACCEPTED.

## 5. Pham gioi cua file nay

- 0 sua code san pham. 0 git add/commit/push.

