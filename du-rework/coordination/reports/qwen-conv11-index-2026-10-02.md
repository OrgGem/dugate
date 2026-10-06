# CONV-11 — Index/summary cho receipts & history (khong cat lich su)

## RESUME POINT — 2026-10-03

- **Ket luan 1 dong:** da tao **2 file index chi dan**, khong dung mot file receipt nao: `coordination/reports/INDEX.md` va `coordination/reports/INDEX-REVIEWS.md`.
- **Trang thai:** DONE — cau truc kiem tra 0 loi (Muc 5), 10/10 spot-check khop noi dung file goc.
- **Quyet dinh quan trong:** cot **Trang thai** lay **nguyen van** chu `Status:` trong receipt; receipt khong khai bao thi de `—`, **khong suy dien**.
- **Le giu:** khong tick gate, khong commit/push, khong sua receipt/review/anchor, khong cham `agent-watch-state.json` hay `docs/28`.
- **Buoc ke tiep:** Reviewer kiem tra Muc 6 (bao cao drift so file) va quyet dinh co nen luu generator vao `tools/` de sinh lai index khong (Muc 8).

## 1 — Do lai truoc khi lam (khong tin so lieu cua plan)

Plan `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` tu bao cao khao sat o `adec19e`. Do lai tren working tree tai luc bat dau:

| Thu muc | So file .md | Tong dong | File > 2.000 dong |
|---|---:|---:|---:|
| `coordination/reports/` | **181** | **83.301** | **9** |
| `coordination/reviews/` | **213** | **9.279** | **0** |

- Con so file **tang lien tuc** trong khi lane nay lam viec: luc bat dau **181 + 213**, luc sinh index cuoi **182 + 214** (review coordinator sinh moi ~10 file/10 phut). Index la **snapshot**, so muc phai re-run de moi.
- 9 file > 2.000 dong (receipt/history) — xem Muc 4; **khong cat**.

## 2 — File tao moi (dung 2 file trong lease)

| File | Noi dung | Dong |
|---|---|---:|
| `coordination/reports/INDEX.md` | Muc 0 quy tac doc; Muc 1 index theo Task ID; Muc 2 lane ledger; Muc 3 file > 2.000 dong; Muc 4 khoang trong du lieu; Muc 5 phan bo theo lane; Muc 6 truy xuat | **404** |
| `coordination/reports/INDEX-REVIEWS.md` | Cung bo cuc, ap dung cho `coordination/reviews/` (214 file) | **549** |

Ca hai bat dau bang:„Day la INDEX chi dan, khong phai ban goc. File receipt goc van nguyen ven, append-only: khong cat, khong viet lai, khong doi anchor/link nao.”

## 3 — Quy tac sinh index (deterministic, khong bia)

| Cot | Quy tac |
|---|---|
| Task ID | `**Task:**` trong 25 dong truoc → token ID-dang trong tieu de → token ID trong ten file → `—` |
| Chu de | tieu de cap 1–3 dau file; bo tien to ID **chi khi** ID nam o dau tieu de, neu ID lay tu giua tieu de thi giu nguyen tieu de |
| Receipt | link tuong doi; tu `reports/` den `reviews/` dung `../reviews/<ten>` |
| Trang thai | **chi doc** `**Status:**` / `Status:` trong 25 dong dau, cat 46 ky tu; **khong suy dien, khong gan nhan** |
| Ngay | `Date:` trong header → `-YYYY-MM-DD` trong ten file → ngay bat ky trong header → `—` |
| Dong | `split(/CRLF|LF/).length - 1` |

Token ID duoc nhan dang: co **it nhat 1 chu so**, viet HOA hoac kieu `^[A-Z]{1,4}\\d`, khong nam trong danh sach tu kho (STATUS/DATE/READ/ONLY/REPORT/…). Vi du bi loai dung: `Antigravity` (khong co so) → lay `W37-A6` tu cung tieu de.

## 4 — File > 2.000 dong: CHI LIET KE, KHONG CAT

| File | Dong |
|---|---:|
| `tester.md` | 12.419 |
| `antigravity-6.md` | 10.371 |
| `qwen-admin.md` | 6.614 |
| `coordinator-antigravity.md` | 5.856 |
| `qwen-platform.md` | 5.773 |
| `qwen-docs.md` | 4.733 |
| `openclaude.md` | 3.049 |
| `qwen3.md` | 2.902 |
| `command-code.md` | 2.207 |

- **Khong cat, khong tach, khong compact** file nao. Chung chi dan bang muc 3 cua INDEX.
- Ly do: receipt la bang chung hien trang; cat se pha lien ket muc, receipt ID va anchor dang tro. Muon giam dong thi phai tach bang **index/summary moi** (task rieng, owner rieng) — dung chinh CONV-11 nay.
- `agent-watch-state.json` (state machine, khong phai markdown) **khong** duoc INDEX hay compact o task nay: coordinator la owner, va chua xac nhan schema/consumer (theo plan CONV-11).

## 5 — Kiem tra truc tiep (de chay lai duoc)

Cwd: `D:\Git\dugate`. Command: `node .qwen-tmp/conv11-verify.js` (script tam, da xoa sau khi ghi receipt). **So file la snapshot tai luc sinh index**; chay lai se ra so file lon hon nhung cac bat bien (0 broken / 0 missing / 0 dup) phai giu nguyen.

| Kiem tra | INDEX.md (reports) | INDEX-REVIEWS.md (reviews) |
|---|---|---|
| File tren dia vs dong trong muc 1 | 182 vs 182 | 214 vs 214 |
| `missing_from_index` | **0** | **0** |
| `listed_but_absent` | **0** | **0** |
| `duplicate_rows` | **0** | **0** |
| `broken_links` (file dich khong ton tai) | **0** | **0** |
| `link_path_mismatch` | **0** | **0** |
| `rows_with_wrong_cell_count` | **0** | **0** |
| Spot-check 10 muc: tieu de index khop file goc | **10/10 OK** | — |

- `*_rows_in_section1` = so file + 1: dong `|---|...|` cua bang bi bo dem trong so lieu nay; khong phai row hong.
- **Spot-check 10 muc** lay deu moi `floor(n/10)`, doi `Chu de` trong index voi tieu de that cua file goc. 6/10 trung nguyen prefix; 4/10 (`qwen-comp01-g7-...`, `tester-conv12-verify-...`, `codex-opt-perf-01-request-path-...`, `qwen4r.md`) lech **chi vi ID da duoc bo khoi dau tieu de** theo Muc 3 — doi chieu tay khong thay sai.

## 6 — Khoang trong du lieu (khong bia gia tri cho phan thieu)

| Tieu chi | reports | reviews |
|---|---:|---:|
| Co Task ID | 100 | 149 |
| **Khong co Task ID** | **81** | **64** |
| Co `Status:` khai bao | **31** | **0** |
| **Khong co status** | **151** | **214** |
| Co ngay | 171 | 213 |
| **Khong co ngay** | **10** | **0** |

- Cot **Trang thai** viet `—` cho da so receipt vi chung **khong khai bao** status. Day la su that cua du lieu, khong phi loi cua index: `grep` `**Outcome:**`/`**Verdict:**`/`**Result:**` tren 25 dong dau = **0** file**.
- 81 file khong co Task ID duoc liet ke day ten trong Muc 4 cua INDEX de lane sau khong phai do lai.

## 7 — Le giu: khong sua file nao khac

`git status --porcelain du-rework/coordination/` cho thay trong `reports/` chi co **2 file moi** la cua task nay (`INDEX.md`, `INDEX-REVIEWS.md`) va **khong co file .md nao bi modify**.

- `agent-watch-state.json` va `coordinator-state.json` hien `M` — **da modified truoc khi lane nay bat dau** (co trong git snapshot luc dau phien) va thuoc coordinator; khong mo va khong ghi vao.
- Khong commit, khong push, khong tick gate, khong doi `docs/28-test-inventory.md` (`git status` cho `docs/28` = sach).
- Khong doi **mot** anchor/link nao trong file goc: file goc chi doc (script chi `readFileSync`).

## 8 — Han ch can biet

1. **Index la snapshot.** File sinh sau luc sinh index chua co trong do. Cach refresh: chay lai quy tac Muc 3 tren `reports/` + `reviews/` (script generator o `.qwen-tmp/conv11-gen.js` la file tam, **da xoa**; khong commit vi ngoai lease).
2. **Khong co generator trong repo** nen `tools/` khai bao lai tu dong — neu Reviewer muon index tu lam moi trong CI, day la task rieng (dung chung duong voi CONV-00 `tools/file-size-guard.cjs`), **khong ghep vao CONV-11**.
3. **So file tang nhanh** (~10 review/10 phut). Muon index dung luon thi can buoc regen dinh ky; nguoc lai no se lam nhe.
4. Reviewer nen kiem tra **noi dung** cac muc, khong chi `broken link = 0`: link chi chung minh file ton tai, khong chung minh cot Task ID/Trang thai dung.

## 9 — Acceptance

| Tieu chi | Ket luan | Bang chung |
|---|---|---|
| Toan bo receipt/task ID + link van truy xuat duoc | **MET** | `missing_from_index=0`, `broken_links=0`, `duplicate_rows=0`; 10/10 spot-check khop noi dung (Muc 5) |
| INDEX < 1.500 dong | **MET** | INDEX.md **404** dong, INDEX-REVIEWS.md **549** dong |
| Khong sua file nao khac | **MET** | `git status`: chi 2 file moi, khong co `M` nao trong `reports/` (Muc 7) |
| Ghi ro index chi dan chieu, ban goc khong doi | **MET** | Dong „Day la INDEX chi dan…” o ca hai file + muc 0 (Muc 2) |
| File > 2.000 chi liet ke, khong cat | **MET** | Muc 3, 9 file, **0** file bi cat (Muc 4) |
| Khong tick gate / khong commit | **MET** | Muc 7 |

## 10 — Ledger

- 1 — Do lai that te tren working tree (181 + 213 file), bo so lieu cua plan — Muc 1.
- 2 — Tao `reports/INDEX.md` + `reports/INDEX-REVIEWS.md` — Muc 2.
- 3 — Quy tac sinh index deterministic, status nguyen van khong suy dien — Muc 3.
- 4 — 9 file > 2.000 dong chi liet ke, khong cat; bo qua agent-watch-state.json — Muc 4.
- 5 — Kiem tra truc tiep: 0 missing / 0 broken / 0 dup, 10/10 spot-check — Muc 5.
- 6 — Khoang trong du lieu: 81 khong ID, 150+213 khong status, 10 khong ngay — Muc 6.
- 7 — Le giu: chi 2 file moi, khong commit, khong cham state JSON cua coordinator — Muc 7.
- 8 — Han ch: index la snapshot, chua co generator trong repo, khong tu dong regen — Muc 8.
- 9 — Acceptance map 6/6 MET — Muc 9.