# qwen-docs — lane docs/evidence (Qwen-Docs) — receipt log

- **Identity**: Qwen lane `docs/evidence`, tên roster **Qwen-Docs**, handle `term_8ba9a7d5`. Phiên này đã nhận `[PACKET D-EVID-A7]` (RequestId `ebebd173`) và `[PACKET D-EVID-A10]`.
- **Điều phối viên**: Antigravity coordinator (theo `du-rework/AGENTS.md`: chỉ một Antigravity giữ vai trò điều phối; handoff ghi ở `coordination/reports/coordinator-antigravity.md`).
- **Vai trò**: chỉ cập nhật hồ sơ evidence trong `du-rework/docs` từ receipt của owner/Tester. Không code, không chạy test, không mở DB/Redis/S3 window, không adjudicate, không tick task row, không commit/push.
- **Repo state khi làm việc**: branch `codex/fix-workflow-builder`, HEAD `7811298`, mọi thứ ở working tree (KHÔNG commit/push). `docs/28-test-inventory.md` và `docs/35-acceptance-baseline.md` là file **untracked** (`git status --porcelain` → `??`) nên bằng chứng bản vá là nội dung file + số dòng/byte/mtime, **không** phải `git diff`.
> [!IMPORTANT]
> **RESUME POINT — cycle 20 (packet D-EVID-A27, lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 19 (A26) giu nguyen ben duoi lam lich su.
> 1. **Cycle 20 sua 7 file + report nay, khong gi khac.** `tasks/README.md` (1 dong), `docs/06-public-api.md` (165→**168**), `docs/20-openapi-descriptions.md` (128→**129**), `docs/admin-ops-monitoring-cost.md` (81, chi 1 dong), `docs/28` muc **8.22** (699→**711**), `docs/35` muc **12.25** (860→**872**), `coordination/reports/qwen-docs.md` (file nay).
> 2. **Objective 1 xong: con tro audit hien hanh troi Turn 180.** `tasks/README.md:3` troi **Turn 160** → **Turn 180** (`review.md#L888` → `#L948`). Banner noi Turn 180 phu de Turn 170, giu **52 dong chua accepted**, ghi T140-A1 la IMPLEMENTED + offline VERIFIED / **live acceptance OPEN**, va liet ke 4 finding moi. **Chi 1 dong doi, 100 dong con lai byte-identical.**
> 3. **52 duoc dem lai ca 5 canh, khong sua mot don vi nao:** 14 P0–P8 (3 `[~]` + 11 `[ ]` cua 71 dong) + 16 SEC + 8 Admin UX + 10 DATA/LOG/DEP + 4 COST = **52**.
> 4. **BAY DEM SO: canh 10 (DATA/LOG/DEP) dem KHAC 4 canh kia.** Bang do **khong co cot trang thai nao ca** — `DATA-00..05`, `LOG-01/02`, `DEP-01`, `DATA-INT-01` — nen regex tick tra **0**, va 10 dong do unaccepted theo chinh dong mo ta cua plan (*Trạng thái: plan, chưa triển khai*). Dem bang regex tick se **thieu 10**.
> 5. **Objective 2 xong: hop dong wire doc thang tu source, khong chep tu packet.** Cursor 4-slot `base64url(<ISO>\|<uuid>\|<field>:<direction>[\|p])`; `decodeOperationsListCursor` tach \|, pop \|p\| rieng, phan con lai qua `parseOperationsListSort`; **6** gia tri sort; `parseOperationsListQuery` nem **422 `INVALID_SCHEMA`** khi lech thu tu.
> 6. **Token 2 slot cu van decode, doc thanh `created_at:desc`.** Do la thu tu duy nhat chung co the tung mang, nen moi deep link cu phan trang y het — va day la ly do A22 va A25 deu goi la hanh vi cu.
> 7. **`bindOperationsCursor` KHONG doi.** No van so `(sortKeySql, id)` voi `($N::timestamptz, $M::uuid)`. Cai doi la route **chan cursor lech thu tu truoc khi bind**. Ghi ro de khong ai tu gan predicate row-value la thu sua.
> 8. **3 vi tri prose da sua, dung 3 dong Reviewer chi dinh:** `docs/06-public-api.md` (L80 payload + L90–94 MISMATCH + them 1 bullet L87), `docs/20-openapi-descriptions.md` (L38 + L42–43), `docs/admin-ops-monitoring-cost.md` (L21). **Lich su finding duoc GIU trong ca hai block MISMATCH, khong xoa va khong viet lai thanh acceptance.**
> 9. **BAY DEM SO 2: pipe chua escape lam VO BANG markdown.** Vi tri thu 3 la mot **o trong bang**, ba ky tu \| cua payload notation + ca \|\| trong dieu kien JS se tach mot dong thanh **7 o** (va **10 o** trong bang cua docs/28) ma khong bao loi nao. Da escape \|; parser phan biet pipe escaped xac nhan row van la **2 o**.
> 10. **Quy uoc escape lay tu chinh file day:** `docs/06-public-api.md` da dung \| o dong `state` va `ORDER BY`. Toi dung chung quy uoc, va `row()` **tu escape** thay vi tay sua.
> 11. **Reviewer yeu cau giu lich su dung scope, nen TOI KHONG xoa cau cu.** Turn 170: *"Preserve historical A15/Δ23 statements as exact-scope history; do not rewrite them as acceptance for newer behavior."* Hai block MISMATCH cu ghi lai trang thai truoc `W-ADMUX02-SORT-CURSOR-BIND-1`.
> 12. **Muc do bang chung giu nguyen, khong nang len.** T140-A1 van la IMPLEMENTED / offline VERIFIED, **live acceptance OPEN**: chua co receipt live nao cho cross-sort 422, legacy token, six-sort walk hay query plan sort moi. Doc policy tu source khong nang gate — giong het cach A26 ghi deactivation.
> 13. **BAY DEM SO 3: 55 la dem KHAI BAO, khong phai so test chay.** 3 suite offline: `operations-list-cursor-sort-binding` (16+4, **5 \|.each\|**), `admin-operations-sort-wiring` (27, **3 \|.each\|**), `admin-keyset-explain` (6+2). Tong khai bao = **55**, trong do **8** nam trong bang \|.each\| nen so chay cao hon.
> 14. **Con so 190/190 la cua Reviewer (T-32), TOI KHONG tu dem va KHONG phai la do luong cua toi.** Chi 55 tai lap duoc tu cay. `admin-keyset-explain` tu skip offline bang co (`const liveDescribe = LIVE ? describe : describe.skip`) — la **gate, khong phai loi**.
> 15. **4 finding moi cua Turn 180: ghi, KHONG adjudicate.** HIGH **T180-D1** (ingestion claim khong co post-lease ownership fence), MEDIUM **T180-D2** (artifact consistency khong kiem), MEDIUM **T180-A1** (route order `deadline_at` qua `COALESCE` ma 0018 index cot tran), MEDIUM **T180-D3** (URL source doi PostgreSQL bi bo loi). Khong cai gi, khong sua source.
> 16. **Link check: S0 881/564 BROKEN=0 ℹ S1 890/573 BROKEN=0 ℹ A27 (moi) 872/521 BROKEN=0 ℹ S2 1600/671 BROKEN=2** (2 break cu antigravity, ton tai tu truoc, khong phai cua lane nay) + `tester3.md` non-UTF-8.
> 17. **Loi hien trang: `docs/admin-ops-monitoring-cost.md` khong nam trong S0, S1, hay A26.** A19 gap chinh la `tasks/README.md`; A26 them no vao, va bay file nay lai roi ra. **Scope theo cycle la phu, khong phai bao phu** — nen mo rong S0/S1 thay vi them tung scope moi.
> 18. **Khong gate nao doi, khong tick dong nao, khong commit/push.** Con lai vai tro khac: T140-A1 (can live keyset multi-tenant roi Reviewer quyet), T180-A1 (EXPLAIN live), 4 finding DATA, COST-01..04, adm-ux, `/compress` (bay cycle lien tiep).
> [!IMPORTANT]
> **RESUME POINT — 15:2x +07 (packet D-EVID-A26, cycle 19 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 18 (A25) giu nguyen ben duoi lam lich su.
> 1. **Cycle 19 sua 3 file + report nay, khong gi khac.** `tasks/README.md` (1 dong), `docs/28` (muc **8.21**, 684 → **699**), `docs/35` (muc **12.24**, 844 → **860**), `qwen-docs.md` (nay). Ca hai file docs bump `1.31.0` → `1.32.0`.
> 2. **Objective 1 xong:** con tro audit hien hanh `tasks/README.md:3` troi **Turn 110** → **Turn 160** (`review.md#L786` → `review.md#L888`). Con so **52** giu nguyen, va toi **tu dem lai tu source** thay vi copy tu review.
> 3. **52 duoc tai lap ca 5 canh, khong sua mot don vi nao:** 14 = 3 `[~]` + 11 `[ ]` cua 71 dong P0–P8 (71 ID khac nhau, 0 trung, 0 dong bi bo qua) + 16 SEC + 8 Admin UX + 10 DATA/LOG/DEP + 4 COST. Dung chinh con so ma `review.md:909` ghi.
> 4. **BAY DEM SO, bay den o lan dau: dong task la O TRONG BANG, khong phai muc list.** Regex dau cua toi (`^\s*[-*]\s+\[`) tra ve **0** dong o ca 9 file P0–P8. Va dem `[x]` o bat ky cho nao trong dong thi dem thua, vi cot ghi chu co chu `fully closed [x]`. Chi **o 2** cua dong moi la mau.
> 5. **Objective 2a xong va 122 duoc chung minh tu source, khong chep tu chuoi ly do.** 5 suite, khong suite nao dung `it.each`/`test.each`, nen dem tho lit la chinh xac: `usage-metrics` 23 + `pricing` 24 + `usage-reconciliation` 26 + `usage-budget` 30 = **103** trong `@du/contracts`, + `usage-contracts-integration-offline` 19 trong `@du/orchestrator` = **122**.
> 6. **Hai so cheo khop doc lap, ca hai tinh khong can doc receipt:** **17** file test trong `packages/contracts/tests/` (bang 17 suite lane bao) va `usage.ts` **460** dong / **20.960** byte (bang dung phép do 191→460 / 20.960 B cua lane).
> 7. **BAY DEM SO 2: glob `*usage*` ra 131, khong phai 122.** No quet them `usage-summary.test.ts` — **9** test thuoc W39-C, khong phai suite COST, va 9 test do **tu skip** offline sau co `DU_LIVE_INFRA`. Chinh lane ghi no la Δ-D30: skip khong phai pass.
> 8. **BAY DEM SO 3: 85 vs 86 suite la hai trang thai cay, khong phai mau thuan.** Lane bao 85 (68 pass / 17 skip) tren chinh run cua lane; cay hien co **86** file test, vi suite sort-binding 54 test cua cycle 17 den sau. Hai so nay la cung mot package o hai moc thoi gian — **khong bao gio cong**.
> 9. **Objective 2b xong: viec tat `qwen_cost` chi duoc ghi o `coordinator-state.json`.** `deactivated_at` = **2026-09-26T15:06:23+07:00**, handle `term_4ed1695f`, chuoi ly do ghi nguyen: *Completed 100% of COST-01..05 offline backlog (122 tests across contracts and orchestrator pass). Live verification handled by Tester.* Bon agent khac cung tat luc `14:29:46+07:00`.
> 10. **CHU Turn 167 trong packet khong co muc markdown nao.** `coordinator-antigravity.md` tat o muc **Turn 166** (dong 2264), trong khi chinh file state do da la `turn` 168, `last_tick` `15:10:07`. Toi **bao cao, khong sua** — do la report lane khac.
> 11. **COST-05 KHONG phai dong release thu 5.** Bang spec chi co **4** dong COST-01–04. Dem 5 se lam mau so **53** va dinh ra mot dong task khong ton tai; `COST-01..05` trong chuoi ly do **khong rut duoc** 52 xuong.
> 12. **Reviewer da phan xu san ve loai claim 100% offline backlog nay.** `review.md:905`: day la *packet-capacity statement, **not** acceptance of their plan rows*. Toi **trich dan**, khong paraphrase, va do la ly do co the ghi mot lan *tát agent* ma khong gate nao nhung.
> 13. **Cau COST cua Turn 160 bay gi nuaa chay.** Chua packet 5, cau do noi *khong co Orchestrator persistence* — **phan nay da cu** (tang tong hop/chiieu da co, 19 test). Con **4** phan van dung: publish/CAS, reservation persistence, alert dispatch, va operator UI, cung producer wiring cua COST-01 (Δ-D26). Toi **khong sua cau do** — sua cau stale la adjudication.
> 14. **LOI 1 CUA TOI: verifier cua `docs/28` so sanh voi danh sach da bi toi sua truoc.** `apply28.py` doi `old_lines[2]` truoc khi goi `difflib`, nen swap version khong bao gio hien thanh opcode va `assert len(ops)==2` no **sau khi file da duoc ghi**. File dung, verifier sai. Toi kiem lai bang cach dung lai ban goc tu file hien tai va doi chieu **223.853 byte / 683 CRLF** — **trung het**.
> 15. **LOI 2 CUA TOI, cung loai voi A25: ca hai script sinh fragment chet luc parse** vi dau nhay chua escape, nen Python thay day la dong ket xau. Sua bang `Q = chr(34)`. **Khong gi duoc ghi** — loi xay ra truoc dong lenh ghi file.
> 16. **LOI 3 CUA TOI, bat boi chinh checker cua toi truoc khi dung fragment: ca 6 dong cua `docs/35` viet 4 o trong khi header chi co 3 cot** (5 dau `|` so voi 4). Toi sua bang cach them mot pass gop o **generator**, khong sua tay artifact.
> 17. **Link check: S0 859/542 BROKEN=0 ƃ S1 868/551 BROKEN=0 ƃ A26 (moi, 850/500 BROKEN=0) ƃ S2 1577/665 BROKEN=2** (dung 2 cai co san cua lane Antigravity). **S0/S1 khong chua `tasks/README.md`** — file ma toi sua manh nhat lai nam ngoai ca hai pham vi, nen toi them pham vi **A26**.
> 18. **Con tre / thuoc vai tro khac:** T140-A1 (can live keyset) ƃ van xuoi cursor o `docs/06`/`docs/19`/`docs/20` (dieu kien tren T140-A1 verified) ƃ DATA-03 chain ƃ Vault fixture ƃ ADM-UX-02 ƃ **COST-01→04 chua duoc ACCEPTED + 4 tang van thieu** ƃ `tester3.md` encoding ƃ 2 link gang lane Antigravity ƃ cot lech co san o `docs/35` ƃ **`/compress` cua cycle 14 (A21) — lan thu sau**. **Khong commit/push** (`git log -1` van `7811298`).
> [!IMPORTANT]
> **RESUME POINT — 15:2x +07 (packet D-EVID-A25, cycle 18 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 17 (A24) giu nguyen ben duoi lam lich su.
> 1. **Cycle 18 VO quy tac "khong sua test" cua lane sau 17 cycle — va no duoc ghi ro, khong lam lặng.** Co can cu: packet coordinator chi danh 2 dong; Reviewer Turn 160 tu gan owner cho finding la *"contracts/OpenAPI test owner"* (`review.md:904`); va `probe_cases.js` la **fixture du lieu mau**, khong phai assertion — no chi `safeParse` mot payload. Sua no la sua du lieu mau cho khop contract, khong lam yeu phep kiem tra nao.
> 2. **`probe_cases.js`: 2 dong, 36 dong khong doi.** Baseline that truoc khi sua: **exit 1, 21 PASS / 2 FAIL**. Sau khi sua: **exit 0, 23 PASS / 0 FAIL**, `OPENAPI-EXAMPLES-VALIDATED`. Nguon: `runtime.ts:212` (`ArtifactFinalizeRequestSchema` = `LeaseBoundRequestSchema.extend`, va `LeaseBoundRequestSchema` `:90-92` chi co `leaseEpoch`) + `:213` (`taskId` uuid); `runtime.ts:32-37` (`ClaimTaskRequestSchema` yeu cau `businessId`).
> 3. **Gia dinh cua toi ve `taskId` cua packet LA SAI, va toi da kiem chung thay vong suy doan.** Toi dinh viet rang `'00000000-0000-0000-0000-000000000001'` se khong qua `z.string().uuid()` vi nibble version la `0`. **No qua** (zod 3.25.76, regex uuid mem hon toi nho). Nen toi giu **dung gia tri packet chi dinh** (Δ71).
> 4. **5 negative control, tat ca RED** (ban sao scratch; file that kiem lai byte sau khi chay): bo `businessId` · `taskId: "not-a-uuid"` · `leaseEpoch: 0` · `businessId: ""` · `businessId: 7`. **M2 la quan trong nhat** — no bien "23/23 xanh" tu con so tran thanh **bang chung rang probe dang kiem that**. Mot fixture pass vo nghia trong y het mot cai duoc sua dung.
> 5. **Grammar cursor lay tu ENCODER THAT, khong tu toi viet:** `server.ts:2201` la `` base64url(`${ts}|${id}|${formatOperationsListSort(sort)}${dir}`) ``, docstring `:2206` ghi `<canonical ISO>|<uuid>|<field>:<direction>[|p]`; decoder `:2230-2265` xac nhan 2–4 part, thieu slot → `created_at:desc`; `:2339-2344` nem 422 khi lech sort **truoc khi** query. Mo ta moi cung ghi *"omitting `?sort` is not a way around it"* — dung vi `parseOperationsListSortParam` `:2364-2369` resolve rong → default.
> 6. **LOI THU HAI, TOI TIM RA KHI DECODE, KHONG AI NHAC:** vi du `nextCursor` cua A23 **khong phai token hop le**. `"MjAyNi0wOS0yNlQwMDowMDowLjAwMHw8dXVpZD4"` (39 ky tu) decode ra `2026-09-26T00:00:0.000|<uuid>` — **bi cat cut**, `<uuid>` la chuoi placeholder chu nghia, va `00:00:0.000` la **ISO sai**. Mot lap trinh vien copy vi du nay se **nhan 422** tu chinh contract do file nay sinh ra.
> 7. **Khong go tay nua — them `mint_cursor()` dung cong thuc route.** Day la bai hoc A23 ap lai. Token moi **103** ky tu, duoi bound 128, decode ra `2026-09-26T00:00:00.000Z|1f2e3d4c-5b6a-4798-8899-aabbccddeeff|created_at:desc`. **Doi chieu tinh co khong can:** truong hop xau nhat tu cong thuc encoder la **107** — khop dung con so Muc 15.1 cua Qwen-Admin, du toi khong doc con so do khi tinh.
> 8. **2 assert moi, CA HAI DA BUN.** G1 payload khai sort na, duc token theo sort khac → `AssertionError: example cursor decodes to '…|created_at:desc', not the payload it claims`. G2 duc token 212 ky tu → `AssertionError: example cursor exceeds the bound the page schema, route and shell share: 212`. Ca 5 assert cua A23 kiem lai con nguyen, khong cai nao bi noi.
> 9. **Tai sinh byte-idempotent THAT:** 2 lan chay, **ca hai exit 0**, `sha256` bang nhau (`19f2cd96…`), 33.169 → **33.488** byte, 1.276 dong giu nguyen, `crlf=1275 bareLF=0 CRCRLF=0`.
> 10. **SUY NGH SUYET BAO CAO SAI — bay la lon nhat cua cycle nay.** `regen2.py` dau tien chay 2 lan, **ca hai exit 1** vi toi viet assert nhieu dong sai thut dau dong, nhung script van in `BYTE-IDENTICAL ACROSS RUNS: True` — vi no so sanh sha cua artifact **chua bao gio duoc ghi**. Da them dieu kien `if not (ok0 and ok1)`, va no bat dung truong hop do. **Mot phep so sanh byte chi co nghia khi ca hai ben deu thuc su duoc sinh ra.**
> 11. **Loi thu hai cua toi:** khoi phuc artifact sau mutant, doc bang text mode (`io.open().read()`) roi ghi `newline=''` → universal newlines doi CRLF thanh LF, artifact thanh **1275 dong LF thuan**, sha lech. Phat hien ngay vi in sha sau moi buoc. Sua bang cach **tai sinh lai bang generator that** → sha ve dung. **Bai hoc cycle 17 lap lai dung mot nghia: doc file nhi phan bang text mode la tu tao ra mot file khac.**
> 12. **Diff artifact: DUNG HAI CHUOI, MOT PATH.** 1.276 → 1.276 dong, 2 opcode. (a) `description` cua tham so `cursor`; (b) `nextCursor` trong vi du. Kiem tra cau truc: tap path giong, **thu tu path giong**, khoa cap cao nhat giong, thu tu 6 tham so giong, tap ma loi giong, `x-absent` giong (7). **Chi `/api/v1/operations` khac noi dung.**
> 13. **Link check:** **S0** 834/519/**BROKEN=0** · **S1** 843/528/**BROKEN=0** · **S2** 1551/641/**BROKEN=2** (hai cai co san cua A22–A24, lane Antigravity). **Giong het A24** dù JSON da doi 2 chuoi — dung nhu mong doi, vi JSON khong chua markdown link.
> 14. **Khong cai gi o day dong duoc T140-D1.** MEDIUM 3 co **ba** ve; toi moi lam **mot**. **Da lam:** grammar cursor trong generator + artifact, va hai probe. **Chua lam va toi khong tu y lam:** `docs/06:80,90-94`, `docs/19:155,411`, `docs/20:38,42`, `docs/admin-ops-monitoring-cost.md:21` van noi cursor khong mang sort identity, va `tasks/README.md:3` van troi Turn 110. Reviewer dieu kien hoa viec sua cau cursor tren *"T140-A1 verified"*, va T140-A1 theo Turn 160 van **IMPLEMENTED + offline VERIFIED, awaiting live acceptance**.
> 15. **Luu y cho coordinator ve mot diem co the bi hieu nham:** toi **co** sua `docs/21-openapi.json` noi ve T140-A1 (dong mo ta kem trang thai *"IMPLEMENTED and offline VERIFIED, not live-verified or accepted"*). Do khong mau thuan viec khong sua `docs/06`: artifact la **output cua generator trong pham vi packet nay**, con `docs/06`/`docs/20` la **van xuoi duoc dieu kien**. Thong nhat hai cach dien dat la quyet dinh can noi ra, khong phai suy ra.
> 16. **Khong sua code san pham · khong sua test suite** (chi sua fixture probe theo packet) · **khong chay test san pham** (chi `validate_openapi.py` + `gen_openapi.py`, ca hai la script tai lieu offline) · khong DB/Redis/S3/Vault · khong tick task row · khong nang muc acceptance · khong tu phan xu T140-A1 · khong sua report lane khac · khong commit/push (`git log -1` van `7811298`).
> 17. **Con tre:** T140-A1 (can **live keyset** cho token moi tren ca sau sort + diff on dinh) · nua con lai T140-D1 (van xuoi cursor + `tasks/README.md:3`) · 2 finding HIGH/MEDIUM con lai cua Turn 160 (DATA-03 chain, Vault fixture) · ADM-UX-02 · COST-01→04 · `tester3.md` encoding · 2 link gang lane Antigravity · **`/compress` cua cycle 14 (A21) — lan thu nam**.
> [!IMPORTANT]
> **RESUME POINT — 14:4x +07 (packet D-EVID-A24, cycle 17 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 16 (A23) giu nguyen ben duoi lam lich su.
> 1. **Cycle 17 sua 3 file docs, khong sua gi.** `docs/28` §8.20 (666→684), `docs/35` §12.23 (830→844), `docs/19` mục Turn 150–154 (430→453). Ca hai file kho bump **`1.30.0` → `1.31.0`**; `docs/19` **khong** co truong version va **khong** duoc them.
> 2. **Moi thu append + swap cung do dai ⇒ khong so dong nao bi dich.** `docs/28`: dung 2 opcode (`difflib`) — L3 va 18 dong cuoi, L4–L666 nguyen ven. `docs/35`: L3 + 14 dong cuoi, L4–L830 nguyen ven. `docs/19`: **430 dong dau byte-identical**. Quet toan tree: **18** anchor ngoai tro vao 3 file nay, max `#L674`, `fails=0`.
> 3. **BA moc cua packet thuoc BA MUC KHAC NHAU — day la ly do cycle nay ton tai.** T130-A1 **CLOSED** (Reviewer da dong o `review.md:873`+`:886`, pham vi **chi audit suite**). T-CODEX-TEST-31 **7/7 live** co that, co raw log, co window — nhung **khong** keo `ADM-UX-02` len `[x]`. 54 test sort-binding co that, nhung **offline**: chinh chu so huong ghi muc cua minh la `IMPLEMENTED + VERIFIED-OFFLINE` (Muc 15.8). **Khong cai nao la mot release gate; bon gate van NO-GO.**
> 4. **`ADM-UX-02` van `[~]`, va ly do duoc ghi day.** Ba list con lai chua co sort allowlist · `updated_at`/`deadline_at` chua co index (0017 chi phu `created_at`, va 0017 da apply nen sua tai cho se bi `migrate()` bo qua im lang) · audit chua co filter thoi gian/actor/resource · `label`/`last-used` **khong co cot** trong schema · C1–C5 browser chua chay.
> 5. **`docs/28` BI HONG MOT LAN va da khoi phuc.** `replace(NL, CRLF)` tren noi dung **da co san `\r`** ⇒ moi dong nhan hai `\r`, sinh `\r\r\n` tren 683 dong. `difflib` lo ngay. Khoi phuc tu backup, lam lai bang cach chuan hoa ve LF truoc roi quy doi CRLF **mot lan o cuoi**. Ket qua: `CRCRLF=0`, `bareLF=0`. **Backup truoc khi ghi la bat buoc, khong phai phong xa.**
> 6. **Tu dem lai moi con so, khong nhan tu receipt.** **54** = 6+6+5 (bang sort) + 7 (`combos`) + 14 (`malformed`) + 16 `it(` thuong. **162** = 54+19+83+6. **7/11/12** = so `it(` thuong, khong co `it.each` nao. Tat ca **khop**.
> 7. **Ba bay dem so (ghi vao `docs/28` §8.20 de khong tro lai).** (a) `it.each([...SORT_VALUES])` la **mot dong** nhung no **6 dong** ⇒ dem theo dong ra 21 thay vì 54. (b) Hai bang la hang dat ten, va quet `{ label:` dem **ca dong khai bao** vi type `const combos: { label: string; ... }[]` cung chua `{ label:` ⇒ ra **8 va 15**, tong **56** (-toi da ra 56 o lan dau). (c) Suite co **6** `describe`, **khong phai 5** — Muc 15.4 ghi "5 describe"; khoi thu sau la companion-finding o dong 368. **Khong sua receipt lane khac.**
> 8. **`30/30` la tong cua ba receipt trong HAI window, khong phai mot lan chay 30 test.** Audit 11 + RBAC 12 trong window T-30 (13:50:57→13:52:59), base-routes 7 trong window T-31 (14:11:07→14:11:56). **Khong co lenh nao trong tree chay ca ba cung luc.** So thi an toan de trich; *phien* ma cau "bo ba" goi y thi khong ton tai.
> 9. **Cross-sort negative CO, nhung no chay tren FAKE DB.** Bang 6×6: chi nhan duong cheo, 30 o con lai 422 voi `calls` rong. Bang chung keyset live (T-CODEX-TEST-20) la cua **hinh thai token CU**. 422 offline khong phai 422 tren trang keyset that. **T140-A1 van OPEN.**
> 10. **Hai cau da thanh SAI so voi source, ghi chu sua.** `docs/06:90-94` van noi token **khong mang dinh danh sort**; `docs/admin-ops-monitoring-cost.md:21` van noi list khong co cursor/filter/sort. Wire da gan ordering, route da nhan du 6 tham so. **Khong sua** — `docs/06` la nua con lai cua T140-D1 ma Reviewer **dieu kien hoa** tren "T140-A1 verified", va file kia thuoc work item khac.
> 11. **`T140-D1`: khoang trong tai sinh DA DONG, finding CHUA.** Generator suy ra tu contract, tu cho khong ghi artifact mat path, tai sinh byte-identical, 42 path + 6 param. `contracts-v1.md` da co symbol sort. **Phan con lai la dieu kien va dieu kien chua thoa.**
> 12. **Link check.** **S0** 834/519/**BROKEN=0** · **S1** 843/528/**BROKEN=0** · **S2** 1551/641/**BROKEN=2** — dung **hai** cai co san cua A22/A23 thuoc lane Antigravity. **Khong** claim `BROKEN=0` toan cuc.
> 13. **Checker S2 cua toi bao 262 lan dau va CON SO DO SAI — toi khong bao no.** Hai loi cung mot ho: khong bo qua URL ngoi (22 link tai lieu ngoi bi dem la gang) va toi validate `#L` theo **so dong file tham chieu** thay vi **file dich** (240 `BAD-ANCHOR` la he qua). Da sua ca hai. **Mot checker bao sai thi te hon khong co checker.**
> 14. **Khong sua code san pham, khong sua test, khong chay test, khong DB/Redis/S3/Vault, khong tick task row, khong nang muc acceptance, khong sua report lane nao khac, khong commit/push** (`git log -1` van `7811298`).
> 15. **Con tre:** T140-A1 (can diff on dinh + **live keyset** cho token moi, roi Reviewer phan quyet) · nua con lai T140-D1 (cau cursor `docs/06`/`docs/20`) · ADM-UX-02 · COST-01→04 · tom tat receipt T-25 sua so 401 · `tester3.md` encoding · 2 link gang lane Antigravity · **`/compress` cua cycle 14 (A21) — lan thu tu**.
> [!IMPORTANT]
> **RESUME POINT — 14:18 +07 (packet D-EVID-A23, cycle 16 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 15 (A22) giu nguyen ben duoi lam lich su.
> 1. **Cycle 16 sua 3 file, va KHONG sua file prose nao.** `tools/openapi/gen_openapi.py` (viet lai route operations + khoi contract-source), `docs/21-openapi.json` (**sinh lai bang chinh generator do**), `coordination/gates/contracts-v1.md` (dung 1 dong 43 + them 2 dong cuoi). Khong dong vao `docs/06`, `docs/19`, `docs/20`, `docs/28`, `docs/35`.
> 2. **Generator nay SUY RA tu `packages/contracts/src/public-api.ts`, khong con chep tay.** Doc 6 ten query, 3 sort field, 2 direction, token pattern, limit default/max. Lý do: T140-D1 **la loi troi do chep tay**, nen chep tay 6 gia tri lan nua chi tao mot ban chep tay khac.
> 3. **`OPERATIONS_LIST_SORT_VALUES` trong contract KHONG phai mang literal — no la `flatMap`.** Generator tai tao dung phep tinh do. **Doi chieu doc: dung sua regex doc 6 chuoi tu mang literal, se khong khop.** Nguon: `public-api.ts:201-205`.
> 4. **Enum `state` la 4 gia tri, KHONG phai 5.** Contract co `ALL`, nhung route **loc `ALL` khoi thong diep 422** (`server.ts:2312`), nen tren day chi co `RUNNING/COMPLETED/FAILED/TIMED_OUT`. **Toi suyt sua thanh 5; da kiem `server.ts` va giu 4.** Day la diem de sai nhat cua cycle nay.
> 5. **Hai chot chan trong generator, va CA HAI da duoc thu de chung minh no ban.** (a) Contract them tham so thu 7 → `AssertionError`. (b) Regenerate lam mat mot path da co trong artifact → `AssertionError`. Cai (b) chinh la loi Reviewer chi ra; bay gio no khong the bi lai im lang.
> 6. **Regenerate byte-idempotent:** chay 2 lan roi `fc /b` → *"no differences encountered"*. Day la thu cach **tat khoang cach tai tao** cua T140-D1, va la bang chung co the lai lap ngay.
> 7. **T140-A1 DA duoc cai trong wire, nhung CHUA VERIFIED.** `server.ts` giờ **3.188 dong** (cuoi A22 la 3.101); `parseAllowListedOperationsListQuery` da so `decoded.sort.field/direction` voi sort cua request va **nem 422** khi lech. Nhung `qwen-admin.md` **khong co** muc nao cho `W-ADMUX02-SORT-CURSOR-BIND-1`, va `tester.md` **khong co** receipt live keyset/sort. => **IMPLEMENTED, khong VERIFIED, khong ACCEPTED.**
> 8. **Vi (7), cau chu trong `docs/06:90-94` bay GI SAI so voi source** ("Token cursor khong mang dinh danh sort"). **Toi KHONG sua** — ca packet lan Reviewer deu dat dieu kien *"once T140-A1's final wire policy is verified"*, va no chua verified. Vien nay **can coordinator quyet**, da ghi o §16.9. Trong artifact `docs/21` thi toi **co sua dung mot chuoi do**, vi machine-readable contract khong nen mang menh de da biet sai.
> 9. **`validate_openapi.py` DO, exit 1 — co san, KHONG phai do cycle nay, va KHONG sua.** `ArtifactFinalizeRequestSchema` thieu `leaseEpoch`/`taskId`, `ClaimTaskRequestSchema` thieu `businessId`. Bang chong doc lap: `probe_cases.js` la mang literal, chi `require` `contracts/dist/index.js` va **khong bao gio mo `docs/21-openapi.json`**; chay no **dung rieng** van 21 PASS / 2 FAIL, exit 1. Nguon chuan: `runtime.ts:32-36` va `runtime.ts:212`. Khong sua vi la **test fixture**, ngoai rang *"chi sua tai lieu va generator script"*.
> 10. **Tang o S0/S1/S2 (807/493, 816/502, 1430/570) va bang chung S0 khac A22 (809/491) la do CHECKER MOI, khong phai tai lieu doi.** Chung minh: mtime chi 3 file tren bi ghi luc 14:12–14:14, 5 file docs con lai van 13:47–13:56 (dung gio A22), va `docs/21` la JSON khong co markdown link nao. **Khong doi so de cho khop.**
> 11. **Link checker viet lai bang Python, va no tung bao sai 114 loi.** Phan lon la URL `file:///D:/...` bi coi nhu duong dan tuong doi. `file://` phai resolve ve duong dan that; sau khi sua: **112 target `file://`, 0 thieu**. Bo qua chung thi bao `BROKEN=0` cho pham vi chua quet — cung la bang chung bia. Giu nguyen bao hoc A22: regex code span phai **gioi han trong mot dong**.
> 12. **S2 `BROKEN=2` la DUNG HAI cai A22 da bao** (`antigravity-6.md:8952`, `coordination/requests/antigravity.md:10`) — lane khac, ngoai pham vi ghi. **Khong claim `BROKEN=0` toan cuc.**
> 13. **`coordination/reports/tester3.md` KHONG phai UTF-8.** Bao cao, khong sua (file lane khac).
> 14. **`contracts-v1.md`: chi doi 1 dong, them o cuoi ⇒ khong so dong nao bi dich.** Verdict `# Gate: contracts-v1 — **READY**`, dong `Owner: Claude (platform lane)`, `WIRE_CONTRACT_VERSION`, `## Conventions frozen at v1`, `## Change policy after READY`, `## Module map`, `### Change log` — **deu khong doi** (dem de 7/7). Da them impact note vi chinh change policy cua file doi hoi.
> 15. **Generator doi xuat LF → CRLF co chu dich**, de `gen` → `diff` sach va khop phan con lai cua `docs/`. La thay doi hanh vi, ghi ra de khong bi doc nham la vo y nghiem.
> 16. **Con tre:** cau chu cursor/song trong `docs/06`/`docs/20` (§16.9) · `probe_cases.js` · T140-A1 · T130-A1 (Reviewer) · 2 suite API-key-list do trong window T-29 · lech cot co san cua `docs/35` · 2 link gãy cua lane Antigravity · encoding `tester3.md` · **`/compress` cua cycle 14 (A21) — lai lan thu ba**.
> 17. **Khong lam:** khong sua code san pham · khong sua test · khong chay test san pham · khong DB/Redis/S3/Vault · khong tick task row · khong nang muc acceptance · khong tu phan xu T140-A1 · khong sua report lane khac · khong commit/push (`git log -1` van `7811298`).
> [!IMPORTANT]
> **RESUME POINT — 13:52 +07 (packet D-EVID-A22, cycle 15 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 14 (A21) giu nguyen ben duoi lam lich su.
> 1. **Tren ca 6 file docs, khong con append-only thuan tuyet.** Cycle 14 chi them o cuoi. Cycle 15 ** sua tai cho giua file** (`docs/06`, `docs/20`, `docs/21`) **va sua 1 dong** trong `docs/19` §4. Ly do: chinh Reviewer T140-D1 chi dinh danh `docs/06-public-api.md:16,44-76`, `docs/19:155-157`, `docs/20:34` — sua o cuoi khong bao gio cham duoc choi do.
> 2. **Doi voi `docs/19`, sua giua file bat buoc phai trung tinh ve so dong.** `codex4.md` pin anchor `#L32` (§2 BR-11) va `#L239` (§9 live execution evidence) vao file nay. Link checker **chi** kiem `1 <= n <= so dong`, nen mot dong chèn lai se **repoint anchor ma van bao `BROKEN=0`**. Toi chon: viet lai **dung 1 dong** tai L155 (gia nguyen), chen moi chi o **duoi duoi** pivot thap nhat. Guard so sanh **cua so 43 dong L221–263** truoc/sau → bang nhau.
> 3. **`docs/19` mat newline cuoi roi khai phuc.** Ghi bang `join(CRLF)` bo newline cuoi, trong khi ban goc **co**. Da them lai CRLF cho `docs/06`, `docs/20`, `docs/19`. `docs/28`/`docs/35`/`docs/21` ban goc **khong** co nen giu nguyen khong newline. **Bai hoc A22: `DocWrite` phai co tham so "trai newline cuoi hay khong", va phai doc trang thai ban goc truoc khi ghi.**
> 4. **Ba ten file trong packet khong ton tai.** Packet goi `docs/06-operations-api.md`, `docs/19-audit-log-reference.md`, `docs/20-openapi-spec.md`. Cay that la `docs/06-public-api.md`, `docs/19-traceability-audit-matrix.md`, `docs/20-openapi-descriptions.md` + **`docs/21-openapi.json`**. Da ghi quyet dinh mapping nay vao §15.1, khong doan.
> 5. **Khong co file "audit log reference" nao ton tai.** Packet yeu cau cap nhat envelope 5 truong trong file do. `grep nextCursor` toan `docs/` chi ra 06, 19, 20, 25, 28, 31, 35 — **khong co tai lieu audit log rieng**. Route `GET /api/v1/admin/audit` co that, nhung `docs/20` §2 dang **xep no vao danh sach ABSENT**. Toi da ghi route + envelope 5 vao `docs/20` §2 va them path vao `docs/21-openapi.json`, va goi ro do la **nhom bien dich dien hinh**, khong phai cap nhat mot file co san.
> 6. **Xac minh `T-CODEX-TEST-29` co that, va dung nhu packet noi — nhung chua tron ven.** `tester.md#L7435`: `admin-audit.test.ts` **11 passed, exit 0**, live, CLAIM 13:21:20 → RELEASE 13:23:20 +07. **Cung window do** co 2 suite **do**: `admin-base-routes` exit 1 (6/1) va `admin-action-rbac-live` exit 1 (11/1), ca vi doc `body.rows` trong khi route tra `items`. Xanh va do cung mot receipt.
> 7. **Khong dung "xanh" de tach T130-A1.** `AGENTS.md` quy tac 4: chi Reviewer dong finding cua Reviewer. Them nua, `review.md` sua luc **13:21:57**, T-29 ghi luc **13:23:20** — Reviewer viet Turn 140 **truoc khi** T-29 ton tai, nen cau "chua co Tester rerun nao supersede" **dung luc viet va bay gio da bi vuot**. Do la **cu**, khong phai sai, va can Reviewer xem lai. Da ghi vao `docs/28` §8.19 va `docs/35` §12.22, khong tu phan xu.
> 8. **Thu tu cong viec co that, va la ly do lon nhat cua cycle nay.** Reviewer T140-D1 gan owner la "Docs + contracts/OpenAPI owner **after the cursor policy is settled**", va gate decision viet "Documentation sync **follows** the sort/cursor decision". Qwen-Admin nhan `W-ADMUX02-SORT-CURSOR-BIND-1` **cung luc**. Toi chi ghi tham so `sort` (da IMPLEMENTED, offline VERIFIED) va **khong** ghi gi ve phan cursor/sort nhu da chot; ca `docs/06` va `docs/20` deu co doan chan do noi ro phai doi chieu lai wire behavior sau khi packet do dap.
> 9. **`server.ts` doi trong luc toi lam viec: 3.086 → 3.101 dong.** Doc lai giua cycle. Vi vay **khong con trich so dong** cho file do: `docs/19` bo cum attribution `1173-1211` va `2068..2300` (da cu), `docs/20` chuyen cot Source cua hang operations sang **symbol**. Dinh nguy tac lay tu chinh `docs/06`: "mo ta theo symbol, khong neo vao so dong".
> 10. **`docs/21-openapi.json` con thieu hon ca 2 tham so, khong chi thieu `sort`.** Path `/api/v1/operations` chi khai bao `limit` va `cursor` — thieu `state`, `tenant`, `id` truoc ca khi T140-D1 ton tai. Da bo sung ca 6 + schema response 5 truong + 401/403/422 + path `/api/v1/admin/audit`, va **JSON validate bang `node` va PowerShell** sau khi ghi.
> 11. **Hai lien ket mau trong du an xuat hien o chinh file docs/21.** `x-absent` ghi `.../audit/usage/replay` (sai, route co that) va header `docs/20` khai "There is NO machine-readable openapi.yaml/json under du-rework" (sai, `docs/21-openapi.json` dang ton tai). Ca hai da sua, kem mot cau chu dinh danh file nao la chuan.
> 12. **`contracts-v1.md`: BAO CAO, KHONG SUA.** No la mot phan cua T140-D1 ma file tu khai `Owner: Claude (platform lane)` va mang verdict gate — ngoai pham vi ghi cua lane docs. Toi ghi no o `docs/19`, `docs/28`, `docs/35` de coordinator dinh tuyen, thay vi sua lam diem mo. **Day la phan duy nhat cua T140-D1 cycle nay khong cham.**
> 13. **Mot loi co san trong bang tham so cua `docs/06` — da sua, dong trung tinh.** L45 goc la `` `RUNNING`|`COMPLETED`|`FAILED`|`TIMED_OUT` ``, dau `|` tho **ngoai** code span lam vo 4 cot. Da escape thanh `\|`. Day la hang **da co san**, khong phai do cycle nay, nhung no nam trong chinh bang allow-list ma T140-D1 yeu cau sua nen de lai thi bang van vo. 165 → 165.
> 14. **Nhieu loi cot `docs/35` co san — BAO CAO, KHONG SUA.** Bang escape-aware quet ra L196, L285, L339 (hang separator `:---:`) va L684, L718–726. Khong nam trong phan cycle nay viet va sua chung nhieu dong lich su cua nguoi khac la **regression risk khong can bang**. Ghi o §15.9 de cycle sau xu ly.
> 15. **Hai bug tu lam bat san, sua truoc khi bao cao — va mot cai suy cho ra mot cai.** (a) `docs/21`: thu tu phep thay the **sai** — ap `x-absent` (index 1053) *sau* hai thay doi o index nho hon nen ghi sai choi → **JSON hong**, khoi phuc tu backup va lam lai theo thu tu giam dan. (b) Fragment `x-absent` thieu **dau phay** → van hong. (c) Hai object `schema` trong fragment thieu **dau phay truoc `example`**. Ca ba deu do `node JSON.parse` bat, khong phai do mat mat.
> 16. **Hai loi PowerShell lam mat thoi gian nhung la mau kinh nghiem dung.** (a) **`rd` la alias san co cua PowerShell cho `Remove-Item`, va alias duoc tra cuu TRUOC function** — ham `Rd` cua toi bi bo qua, script "goi" `Remove-Item` va bao loi duong dan sai. (b) **`cat` la alias cho `Get-Content`** — ham `Cat` bi bo qua theo cach y het. Voi (c) backtick la escape char trong chuoi **kep** cua PowerShell nen `` "| `cursor` |" `` thanh `| cursor |`. Rule: **dat ten ham khong trung alias**, va **dung `[char]96` / `$Q` cho moi ky tu dac biet**.
> 17. **Da thay 3 tu trong phan nguon, dung cach doc truc tiep, khong chep loi Reviewer.** `OPERATIONS_LIST_QUERY_PARAMS` co **6** ten; `OPERATIONS_LIST_SORT_FIELDS` x `OPERATIONS_LIST_SORT_DIRECTIONS` ra **dung 6** gia tri; default `created_at:desc`; tach tren **dau hai cham cuoi**; 422 `INVALID_SCHEMA`; `deadline_at` la cot nullable duy nhat va duoc COALESCE ve sentinel de predicate row-value khong bao gio FALSE vi NULL. Route goi `parseOperationsListSort` cua contract, khong viet lai. `OPERATIONS_LIST_QUERY_PARAMS` la **allow-list that** qua seam `AllowListedQuery`: doc ten ngoai mang la **loi bien dich**.
> 18. **Khong sua code san pham, khong sua test, khong chay test, khong mo DB/Redis/S3/Vault, khong tick task row, khong nang muc acceptance, khong commit/push.** Khong sua report cua lane nao khac. Khong tu phan xu policy cursor/sort. Khong tick T130-A1.
> 19. **Khoi phuc neu can:** ban sao 6 file o `%TEMP%\...\bak22\` (ngoai repo), ghi truoc moi phan ghi lau. `docs/21` da bi khoi phuc va ghi lai mot lan trong chinh cycle nay.
> 20. **Con tre.** `/compress` cua cycle 14 (A21) van chua chay — cycle 15 dua no sang cuoi va noi ro hon.Va T140-A1/T140-D1 van OPEN, gap 21 test MM-10 va loi 1480-vs-1481 cua A21 van chua ai tra loi.
> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~13:1x +07 (packet D-EVID-A21, cycle 14 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 13 (A20) giu nguyen ben duoi lam lich su.
> 1. **Van 3 file, van append-only, van bump 1.28.0 → 1.29.0.** `docs/19` **363 → 400** (them muc moi o L364–400, **khong** bump version — file nay khong co truong `**Document Version:**`); `docs/28` **639 → 650** (them `### 8.18` o L640–650); `docs/35` **801 → 816** (them `### 12.21` o L802–816). Ca hai file kia bump o L3.
> 2. **Invariant byte chung minh, khong phai tin.** `docs/19`: tien to **dung byte-for-byte**. `docs/28`/`docs/35`: phan truoc **va** phan sau dong version **dung byte-for-byte**, con duy nhat la doi `1.28.0` → `1.29.0` **cung 6 ky tu** nen khong duoi dong. Khong co `#L` nao cua lane khac bi doi chieu.
> 3. **Khong sua code san pham, khong sua test, khong chay test, khong mo DB/Redis/S3/Vault, khong commit/push.** Chi ghi 3 file docs + file receipt nay.
> 4. **Reviewer Turn 130 doc o L809 — dung nhu packet noi.** Doc ca muc (L809–832), khong tin phan tom tat cua coordinator. Ke luat: `Δ36` + `Δ23` giu **CLOSED**, T-CODEX-TEST-22 chi synthetic, **4 gate NO-GO**, va **mot phat hien moi T130-A1**.
> 5. **T130-A1: phat hien cua Reviewer, KHONG phai receipt xanh — va ta khong dung no nhu xanh.** Route `server.ts` L1950 tra envelope 5 field; test `admin-audit.test.ts` **da duoc sua tren dia 12:54:57** (khai `AuditEnvelope` o L137–140) **nhung khong co receipt, khong exit code, khong chay live**. Ghi la **OPEN**. Chi Reviewer moi dong duoc finding cua Reviewer.
> 6. **Ba nua cua T130-A1 deu con mo.** (a) owner da sua file; (b) **thieu receipt** cho `W-ADMIN-AUDIT-TEST-ALIGN-1`; (c) raw log danh dau **401 unknown-bearer la PASS** trong khi tom tat receipt nem no vao loi — chi Tester moi sua duoc tom tat do. T-CODEX-TEST-27 chay 94/94 offline nhung **thieu file test thu 3** nen khong tra loi duoc.
> 7. **MM-10 Δ4: DA sua o source, nhung con 2 gioi han phai ghi cung.** `runtime.ts` L242 project `o.cancel_requested AS op_cancel_requested, o.state AS op_state`; L1445–1446 `buildClaimResult` goi `hasCancelSignal` thay cho hard-code `false` → Δ4 IMPLEMENTED + offline VERIFIED. **Nhung** (a) **cau hinh hien tai chua quan sat duoc** co la claim: cancel set `tasks.state=CANCELLED` trong cung mot tx nen terminal guard tra **410 truoc khi tao snapshot**; gia tri that cua co chi la op state mem `CANCEL_REQUESTED`, chua co writer. (b) Tong **86 khong khop** (diem 8).
> 8. **Gap 21 test lap lai Y NGUYEN — day la phat hien lon nhat cua cycle.** Receipt tach `86 = 9 + 10 + 11 + 56`. Dem tay 6 file: 9 + 10 + 11 + **12 + 5 + 18 = 35**, tong **65**. Cycle truoc tach `76 = 9 + 11 + 56` va cung 3 file do cung ra **35**. **Thung 21 la y het va ca hai lan**, va suite moi +10 dung bang so no cong them — hieu gap **khong lon theo thay doi, va khong do thay doi gay ra**. Phai do Tester chay lai va trich per-suite moi ket duoc; lane khong tu di chinh so.
> 9. **Dem test phai tay, va con 2 bay nua.** (a) `it.each` lam dem literal duoi report — da bi 2 lan; lan nay 5 bang cua `vault-policies.test.ts` (3,3,7,8,2) cong don **39 + 23 = 62** khop receipt. (b) Dem **cho phep khoang trang** truoc `(` sinh **false positive tu comment** — "carries it (conditional mirror)", "contract under test (runtime.ts ...)" — gap dung 2 dong comment do lam `mm10-heartbeat` ra 10 thay vi 9. Bo dem khoang trang, giu dem chat. (c) `RegExp.prototype.test(sql)` van sinh 25 phantom nhu da ghi o A20.
> 10. **VAULT-02: doc dung, va co mot cho de doc sai.** `orchestrator-writer.hcl` = data `["create","update"]` + metadata `["read","list"]` — **khong path data nao co `read`**. `connector-reader.hcl` = ca 2 block chi `["read"]`. `worker-browser.hcl` = **comment-only, zero path block**. **Tom tat Turn 131 cua coordinator viet "writer: create, update, read, list metadata"** — nen ghi ro: `create`/`update` la capability **data**, `read`/`list` la capability **metadata**; doc HCL deploy, khong doc tom tat. `src/vault-policies.ts` **khong doi** (production diff 0), chi test 45 → 62.
> 11. **COST-03: chi tang contract, va "group" duoc phuc vu bang identity.** `usage-reconciliation.ts` moi 255 dong; 26 test (dem `test(` — **khong co** `it(`, khong bang, nen khong can sua). `UsageSummarySchema` `.strict()` **dung 5 field**, co invariant BigInt `totalTokens = input + output`; tong BigInt, vuot `MAX_SAFE_INTEGER` thi `RangeError` mang `USAGE_AGGREGATE_OVERFLOW`. 307 + 26 = **333 khop**. **Phia service + COST-04 chua co gi**; COST-01..04 **deu chua tick**.
> 12. **ADM-UX-03: fix that, van `[ ]`.** `operation-section-renderer.ts` L485 doi `opsPageHref({ limit: OPERATION_LIST_DEFAULT_LIMIT })` — **dem chuoi: xuat hien 1 lan, `f.limit` 0 lan** (la cach kiem la duy nhat vi file `??`, `git diff` khong phan xu). Mutation probe la bang chung manh nhat: revert 1 dong → **3 do trong 78**, ca 3 cung mot dong `limit=5` vs `limit=20`. Chip co tu Muc 2 (Δ42) — cycle nay them **bang chung**, khong phai UI moi.
> 13. **Mot file duoi receipt da bi lane khac sua LUON trong khi ta ghi.** `admin-operations-list-pagination.test.ts` mtime **12:54:49** (sau receipt 12:18): hien **83 dong `it(` thuan + 1 `it.each` tren danh sach sort value**. Receipt ghi 78 — dung **cho thoi diem cua receipt**, va ta **khong** trich so hien tai nhu cung mot phep do. Day la bai hoc chung: **tong test cua receipt la mo ta ve mot moc thoi gian**.
> 14. **Sai so dong thu 2, cung ho so voi A20.** Receipt khoi phuc `runtime.ts` va ghi **1481** dong; do duoc **1480**. A20 da gap `admin-shell-session-lifecycle.test.ts` 560/553/561. Ca hai lan **so test deu dung**, nen khong co bang chung nao sai — nhung trong mau lap lai, no tro toi thoi diem chup **truoc/sau khi sua** o dau chuoi. Tien doc cach chung nhanh hon la lap tung file.
> 15. **Sau receipt, 6 packet con bay tren ledger, ta KHONG ghi.** `W-COST04-BUDGET-ALERT-1`, `W-VAULT06-ROTATION-LIFECYCLE-1`, `W-ADMUX02-SORT-ALLOWLIST-1`, `W-DATA03-INGESTION-WIRING-1`, `W-SEC-AUDIT-TAXONOMY-1`, `W-ADMIN-AUDIT-TEST-ALIGN-1` — **khong receipt nao het**. Co packet da thay hien duoi dang sua source, va do la **dung dieu kien de row bi sai**: ghi vao se bien source dang chay thanh bang chung.
> 16. **Khong tao row trung cho receipt da co.** `W-VAULT-CONNECTOR-ISOLATION-1` (Muc 3 qwen-vault, 45 test) **da duoc ghi o §8.17 tu A20**; so khong doi. Cycle nay chi ghi chieu **nguon trich** trong bang provenance, khong lap lai so.
> 17. **13 anchor cua toi, kiem theo NOI DUNG — `MINE_ANCHOR_FAILS=0`.** Dung `[IO.File]::ReadAllLines`, khong tin `LineNumber` cua grep (A20 da gap mot lan: no doc cao hon 1). `qwen-vault.md` 169 → **203** dong va `coordinator-antigravity.md` 1945 → **1958** trong khi ta lam viec, va **khong anchor nao cua ta trượt** — vi append o cuoi, turn moi cung chi them o cuoi.
> 18. **Link check: `S0` 875/505/BROKEN=0 · `S1` 918/547/BROKEN=0 · `S2` 1418/558/BROKEN=2.** Hai break cua `S2` la **pre-existing**, nam trong `antigravity-6.md` va `coordination/requests/antigravity.md` — **khong phai cua ta**, va ta **khong** claim `BROKEN=0` toan cuc. Delta `S1` **+39 target / +26 anchor**, dem tay 3 muc moi ra **39/26** → **bang nhau, khong ton 1 link nao lan ngoai**.
> 19. **Loi cua chinh toi, cycle nay: 1 link BROKEN do TA tao ra, va da bat.** `docs/28` tro `](../infra/vault/policies)` — **mot thu muc**, checker chi nhan file → `BROKEN=1` o `S0`/`S1`. Bat ngay khi chay lai, sua bang guard `occurrences == 1` thanh **3 file HCL cu the**. Ghi lai vi `BROKEN=0` o cac cycle truoc **khong bao gio la bang chung rang buoc neu ta khong chay lai sau khi sua**.
> 20. **Khong doi soat gi, khong tick task row, khong nang ACCEPTED.** `G-ADMIN-OPS`/`G-SEC`/`G-DATA`/`G6` giu **NO-GO**; `Δ21` giu **OPEN**; `ADM-UX-02` `[~]`, `ADM-UX-03` `[ ]`; `COST-01..04`, `VAULT-02`, `VAULT-05` deu chua accepted. Aggregate 350/333 cua `@du/contracts` la **cay chung nhieu lane** — ghi mot lan, khong cong voi aggregate cycle truoc.
> 21. **Khong commit, khong push.** Branch `codex/fix-workflow-builder`, HEAD van `7811298`. Ket thuc bang `/compress`.

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~12:4x +07 (packet D-EVID-A20, cycle 13 cua lane Qwen-Docs).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 12 (A19) giu nguyen ben duoi lam lich su.
> 1. **Lan nay sua CA 3 file, khac A19.** `docs/19` (append, **khong** bump version — file nay khong co truong `**Document Version:**` bao gio) + **`docs/28` §8.17** + **`docs/35` §12.20**, hai file sau **bump 1.27.0 → 1.28.0**. Khong co file nao bi *insert* giua: ca 3 section moi deu append o cuoi.
> 2. **Invariant byte da chung minh, khong phai tin.** Prefix cua ca 3 file hash SHA-256 **dung bang** truoc append (`docs/19` `C392A3BC…8917A`; `docs/28` `4E357EDC…151A5`; `docs/35` `1D6D384D…0DBE269`, hai file sau tinh lai sau khi revert dong version trong bo nho). `docs/19` 322→363, `docs/28` 627→639, `docs/35` 783→801.
> 3. **Vi sao append chu khong insert.** `codex4.md` gan **19 anchor `#L`** vao 3 file nay (`docs/28#L498/509/517`, `docs/35#L656/666/674`, `docs/19#L32`…). Insert giua se lam lech them 1 con so. Append o duoi khai bao tat ca anchor cu.
> 4. **Mot anchor cua chinh toi da lech va da repoint.** `qwen-cost.md#L90` kiem tra ra **dong trong** — heading `## 2 — CYCLE 2: W-COST02-PRICING-MODEL-1` that su **o L91**. Da repoint `docs/19` + `docs/28`, kem guard `occurrences == 1` **nem truoc khi ghi**. `MINE_ANCHOR_FAILS=0` sau khi repoint. Kiem lai **8/8 anchor** theo *noi dung*, khong theo so dong.
> 5. **Chi 1 trong 5 receipt co raw log.** Qwen-SEC ship **22 log** o `coordination/evidence/qwen-sec/`; doc lai **tat ca 18 dong `*_EXIT`**, ca 2 tong test, so skip, va 2 negative control — **khop receipt 100%**. Bon lane con lai (platform/cost/vault/data) **khong co log nao**; figure cua ho chi doc tu receipt va duoc danh dau nhu vay.
> 6. **Da doc source, khong tin receipt.** MM-10: `runtime.ts` co `hasCancelSignal` (:176), read-time SELECT (:309), write-fence `AND NOT o.cancel_requested AND o.state <> 'CANCEL_REQUESTED'` (:348), diagnostic SELECT (:354) — ca 3 tang dung nhu mo ta. COST-02: `pricing.ts` **314 dong** va **12 export** khop het. VAULT-05: `matchesVaultRevisionBinding` (**`:106`**) nam **truoc** `secretResolver.resolve` (**`:116`**) trong `services.ts` — thu tu binding-truoc-doc la that. SEC: `cookiePolicy` (`shell-router.ts:211`), `legacyCookiePosture` (`:975`, goi o `:908` mint va `:995` logout), 503 (`:915`), parse 1 lan o mount (`shell-server.ts:332`). DATA-04: guard `if (!output.readableEnded) scope.abort();` (`artifact-streams.ts:612`), default 64 KiB (`:569`), cap 1 MiB (`:903-904`), `RequestScope.abort` (`:891`).
> 7. **Dem test: dung het 6 file.** mm10 **9**, pricing **24**, admin-shell **36**, artifact-stream-bounds **27** (11 thang + 3 bang `it.each` 5/6/5), vault-account-isolation **13** (7 + 6), secret-resolver **23** (18 + 5). Khong file nao lech.
> 8. **BAI HOC `it.each` — nho la, vi no da lam sai 2 lan.** Dem literal `it(`/`test(` **duoi report**: `artifact-stream-bounds.test.ts` co 11 test ma ra **27**. Ngược lại quét naively thi **sinh false positive**: `RegExp.prototype.test(sql)` trong fake DB khop moi chuoi `test(` — rieng `runtime-lease-fencing-offline.test.ts` có **25 hit ma**. Phai dem tay tung dong `it.each`.
> 9. **PHAT HIEN CHANH — tong 76 cua MM-10 khong khop.** Receipt tach `76 = 9 + 11 + 56`, nhung 3 file ten trong do chi co 12 + 5 + 18 = **35**, ca 5 file = **55** so voi jest 76. Khong co log de doc lai, va lane nay **khong chay test**, nen **ghi la khong doi soat duoc** chu khong sua so cho khop. Chi can mot Tester re-run bao per-suite moi chot.
> 10. **Phat hien chanh 2 — 3 so dong cho mot lan sua.** `admin-shell-session-lifecycle.test.ts`: **560** (receipt) vs **553** (Turn 123/125 cua coordinator) vs **561** (do o day). So **test thi giong het: 36** — bang chung khong anh huong; toi nghi coordinator tom tat tu snapshot giua chung.
> 11. **Khong doi soat giỀ, khong tick task row, khong nang ACCEPTED.** `G-DATA`/`G-SEC`/`G-ADMIN-OPS`/release van **NO-GO**. Khong cell `Uncovered BR criterion(s)` nao dong. Dong `delta 27` o A19 (ghi no con mo nua) **khong bi sua lai** — cycle nay bo sung nua con lai, khong viet lai lich su.
> 12. **Mot phat hien moi, chua dong.** Δ27/Δ34: boot bay **tu choi** khi production + origin http + trust off, ma `docs/runbooks/vault-oidc-operations.md` **chua co** `DU_ADMIN_TRUST_PROXY_PROTOCOL`, `DU_ADMIN_COOKIE_SECURE`, hay 503. Qwen-SEC nhac 2 lan; cycle nay ghi nhu gap, khong dong.
> 13. **Link check.** `S0` 844 target / 487 anchor / **BROKEN=0**; `S1` 879/521 / **BROKEN=0**; `S2` toan bo 178 file: 1379/532 / **BROKEN=2** — ca 2 deu **pre-existing**, nguyen trong `antigravity-6.md` va `coordination/requests/antigravity.md`, thieu mot cap `../`, **khong phai cua cycle nay** va ngoai pham vi ghi. Khong doi soat `BROKEN=0` toan cuc mot cach khong trung thuc.
> 14. **Da doi soat chenh lech cua checker bang chinh so link cua toi.** `S0` 814→844 = **+30 target / +21 anchor**, va dem tay section moi cua `docs/28` + `docs/35` = **+30 / +21** — **bang nhau**. `docs/19` moi = **+10 / +10**; phan co san cua no = 25/24, **dung bang baseline A19**. Khong co link nao cua lane khac bi dong vao.
> 15. **Loi cua chinh toi, ghi lai de khong lap:** (a) JS string literal an backslash, regex `[^\s]` thanh `[^)s]` — lam link bi cat cung tai `report|s`, lan dem delta dau tieu **rac**. (b) `$var=` long trong `cmd -Command "..."` → phai viet `.ps1` ASCII roi goi bang duong dan tuyet doi. (c) `read_file` offset **0-based**. (d) `grep_search` LineNumber doc lenh tren 1 so voi `[IO.File]::ReadAllLines` — da gay anchor `#L90` sai, bat duoc o (4).
> 16. **Khong commit, khong push, khong mo DB/Redis/S3/Vault, khong sua source/test, khong chay test.** Chi ghi 3 file markdown + file ledger nay.

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~12:0x +07 (packet D-EVID-A19, cycle 12 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 11 (A18) giữ nguyên bên dưới làm lịch sử.
> 1. **Packet này ghi vào `docs/19`, không phải docs/28/35 — và không bump version.** `docs/19` **chưa bao giờ có** trường `Document Version`; thêm một dòng header ở đầu sẽ **đẩy lệch cả hai anchor** mà `codex4.md:490` trỏ vào `docs/19` (`#L32` và `#L239`). Vì vậy cycle này **append-only**: không dòng nào trong 279 dòng đầu bị đụng, có sàn so sánh byte.
> 2. **Anchor invariant kiểm được, không chỉ tin.** Sau append `docs/19` 279 → **322** dòng. `L32` vẫn là row `BR-11 — Traceability`; `L244` vẫn là header `## 9. Cycle 138`; `L275` vẫn là `## VAULT-01 trusted connector revision binding`. Sàn so sánh 279 dòng đầu: **0 mismatch**.
> 3. **Phát hiện thật, không sửa: anchor `#L239` của `codex4.md` trỏ vào dòng TRỐNG.** `codex4.md:490` gắn nhãn cho nó là *§9 live execution evidence*, nhưng `docs/19` L239 **rỗng**; §9 nằm ở **L244**. Checker **cấu trúc không bắt được** loại này vì nó chỉ kiểm `1 <= n <= số dòng đích`. Không sửa vì `codex4.md` là ledger của lane khác → báo coordinator + Codex-4. Anchor anh em `#L32` thì đúng.
> 4. **Có receipt MỚI hơn cả Turn 118: `T-CODEX-TEST-28`** (Tester, 11:46:10 → 11:46:30 +07) chạy lại **độc lập** đúng 2 suite Vault + 2 suite MM-05: Vault **3 suite / 52 passed** exit 0 (4.809 s), MM-05 **2 suite / 15 passed** exit 0 (4.787 s), với `DU_LIVE_INFRA`/`DATABASE_URL`/`REDIS_URL` unset. Đây là bằng chứng mạnh nhất của cycle: **không phải lane tự verify bản vá của chính mình**, và hai con số khớp **đúng** receipt của lane thực thi.
> 5. **Nối đúng với row T-CODEX-TEST-26 tôi ghi ở A18.** Row đó nói 7 fail `BINDING_DENIED`, trong đó **2 là masking** — che mất `VAULT_POLICY_DENIED` và `TEMPORARY_UNAVAILABLE`, tức *unverified chứ không phải proven broken*. `W-VAULT-BINDING-FIX-1` **đúng là** cái vá gỡ đúng lớp masking đó, và T-28 xác nhận 52/52 không còn `BINDING_DENIED`. Vẫn **chưa** live, nên không đóng gì.
> 6. **Log của Qwen-SEC nằm ở thư mục khác, không phải `reports/`.** 20 file `proxy-*.log` ở `coordination/evidence/qwen-sec/`. Tôi **tự đọc lại**: `proxy-wide-r1`/`r2` = `7 skipped + 139 passed / 146 total`, `WIDE_R1/R2_EXIT=0`; `proxy-packet-f1` = `2 suite / 37 passed`, `PACKET_F1_EXIT=0`. Nên 139/146 của OIDC-04 là **verify từ log thật**. **7 skipped là `DU_LIVE_INFRA` ⇒ SKIP ≠ PASS.**
> 7. **Bẫy đếm số mới (lần 2 trong 2 cycle): `it.each`.** Đếm literal `it(`/`test(` **under-report** mọi file dùng `it.each`: `ingestion-receipt.test.ts` đếm 10 nhưng thật **20** (9 thường + bảng 11 dòng); `ingest-source-pin.test.ts` đếm 10 nhưng thật **14** (9 + 5). **Cả hai receipt ĐÚNG — chính heuristic của tôi sai.** 6 file còn lại khớp tuyệt đối (23 / 13 / 22 / 11 / 4 / 13). Đã ghi vào `docs/19` để cycle sau không đọc sai.
> 8. **Hai lane không có raw log — ghi thẳng, không vay bằng.** Qwen-Cost §1 và Qwen-DATA §7 đều nói rõ **không để lại file log**; số liệu của họ **không reread được từ log**, chỉ kiểm được tính nhất quán nội bộ (237 + 23 = 260 khớp tuyệt đối). Qwen-Vault/Qwen-Platform cũng inline, nhưng T-28 chạy lại đúng bộ suite nên có xác nhận bên thứ ba.
> 9. **Tôi tự làm hỏng tool rồi sửa — ghi lại vì nó là bài học.** Bản checker A19 đầu **rơi mất dòng** `if ($path -match '^file:///(.+)$')` mà checker A18 có ⇒ **115 link `file:///` biến thành `UNRESOLVABLE`**. Sửa xong chạy lại: scope 6 file cho **đúng `814/466`** — tức **tái lập chính xác** số A18, chứng minh tool còn nguyên và 6 file kia không trượt. Chính số tái lập ấy, chứ không phải lần chạy đầu, mới là bằng chứng.
> 10. **Link check — phải nói đúng cả hai scope, không gộp.** **S1 (7 file = 6 file lane + `docs/19`): `FILES=7 TARGETS=839 ANCHORS=490 BROKEN=0`.** `docs/19` đóng góp 25 target / 24 anchor, trong đó **12 target / 12 anchor là của cycle này**; 13/12 còn lại có sẵn từ trước và **chưa bao giờ nằm trong scope** của checker. **S2 (toàn bộ 178 file tài liệu): `BROKEN=2`** ⇒ **không thể nói `BROKEN=0` toàn cục, và tôi không nói**.
> 11. **Hai broken đó là lỗi có thật, có sẵn, không phải của cycle này**: `antigravity-6.md -> ../tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` và `requests/antigravity.md -> ./WAVE-22-LIVE-INTEGRATION-READINESS.md`. Cùng một lớp lỗi: **mất đúng một `../`** khi viết link từ thư mục khác. File đích **đều tồn tại** (đã `Test-Path` xác nhận), chỉ là link sai cấp thư mục. Cả hai file thuộc lane Antigravity, mtime 09-25, tôi không đụng. **Báo, không sửa**.
> 12. **Hai việc docs khác đang chờ, packet này không phủ — ghi ra để không bị quên**: (a) **Δ2 của Qwen-Platform** yêu cầu docs-lane đồng bộ `docs/38` §3 + §5, vì CAS re-arm nay mang write-guard mà sketch `docs/38` không thể hiện; (b) **Δ32 của Qwen-SEC** — tôi đã kiểm `docs/runbooks/vault-oidc-operations.md` (334 dòng): nó **không nhắc** `DU_ADMIN_COOKIE_SECURE` lẫn `DU_ADMIN_TRUST_PROXY_PROTOCOL`, trong khi production + origin http + trust tắt **giờ refuse boot** ⇒ breaking change lên deployment mà runbook chưa có bước nào.
> 13. **Ranh giới bốn mức giữ nguyên**: MM-05 **chưa** live (`p8-02c` rearm-1..4 còn mở) · VAULT-01 **`[ ]`** · COST-01 **mới tầng schema**, chưa migration/persist/producer, COST-02..04 chưa làm · DATA-01 đóng **Δ14 ở tầng envelope** nhưng **Δ17 mới** vì `processIngestionTask` còn **0 caller** nên DATA-03 vẫn `[~]` · OIDC-04 **vẫn `[ ]`** (handler-level, không cookie-jar/TLS thật) và **Δ27 mới đóng nửa** nên `du_admin` vẫn mint cookie **không** `Secure`. **Không tick `[x]`, không nâng ACCEPTED, không adjudicate Δ nào.**
> 14. **Không làm**: không sửa source/test, không chạy test, không mở DB/Redis/S3/Vault window, không migration, không tick row, không commit/push. `docs/19` là file **untracked** (`??`) như docs/28/35. HEAD vẫn `7811298`.
> 15. **Anchor trượt ngay TRONG cycle này — của chính tôi, và checker không thấy.** Lúc verify đầu, `qwen-vault.md` còn 50 dòng nên tôi neo `#L9/#L32/#L36`. Trong lúc tôi làm, lane Vault **prepend** RESUME POINT mới (11:52:43) → file thành 90 dòng, mọi anchor lệch **+1** và rơi vào **dòng trống**; rồi `qwen-platform.md` 86→87 và `qwen-cost.md` 89→**156** cũng +1. **Suốt thời gian đó link check vẫn `BROKEN=0`** vì 9/32/36/13/69/71 đều ≤ số dòng mới. Chỉ **verify theo nội dung dòng đích** mới bắt được. Đã repoint **7 anchor** (`qwen-vault`→`#L10/#L33/#L37`, `qwen-platform`→`#L14/#L70`, `qwen-cost`→`#L14/#L72`) và verify lại: **`MINE_ANCHOR_FAILS=0`**. Bài học: `BROKEN=0` **không** chứng minh anchor đúng, và lượt repoint báo **0** phải coi là đáng ngờ chứ không phải kết quả tốt.

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~11:0x +07 (packet D-EVID-A18, cycle 11 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 10 (A17) giữ nguyên bên dưới làm lịch sử.
> 1. **Cycle này đồng bộ SÁU receipt, không phải năm.** Packet A18 liệt kê T-24 / T-25 / T-26 + Qwen-SEC §8 + Qwen-Admin §12, nhưng `tester.md` còn có **T-CODEX-TEST-27** (L7417, **10:56:11 +07**) là receipt **mới nhất** trong cửa sổ, **~75 phút sau** đỏ live audit. Tôi ghi luôn T-27 thay vì để nó rơi sót sang cycle sau.
> 2. **Mọi số liệu đều tự đọc raw log**, không chép receipt: `T-CODEX-TEST-24-admin-lists.log` (21 dòng), `-25-live-audit.log` (197), `-26-vault-offline.log` (222), `-27-admin-conformance.log` (mới).
> 3. **Packet mô tả sai T-CODEX-TEST-25 — đã sửa theo log.** Packet nói 6 fail là "401 unknown-bearer contract". Log cho thấy `unknown bearer → 401` và `tenant-operator bearer is NOT platform admin → 401` nằm ở nhóm **PASS**. Sáu fail thật là: 2 × `EADDRINUSE 127.0.0.1:58537` (harness đụng port), 1 × `full.events` undefined, 3 × `body.tenantId` undefined.
> 4. **Tôi KHÔNG adjudicate nguyên nhân** — chỉ ghi *chữ ký* lỗi. `tests/admin-audit.test.ts:137-139` khai `AuditEnvelope { tenantId; events }` và đọc hai field đó ở `:192-250`, `:350-376`, trong khi W-ADMUX02-EXT-1 đã đổi route sang envelope 5 field. Test lỗi thời, route hồi quy, hay cả hai → **việc của Admin owner + Tester + Reviewer**, không phải lane docs. Task row không đổi.
> 5. **T-CODEX-TEST-26: phân biệt "che" và "đỏ".** Cả 7 fail cùng gốc `BINDING_DENIED` tại `src/modules/connector-credentials/workflow.ts:166`, nhưng **2 trong số đó che mất đúng thứ cần kiểm**: test đợi `VAULT_POLICY_DENIED` và test đợi `TEMPORARY_UNAVAILABLE` (503) đều nhận `BINDING_DENIED` (403) ⇒ các đường đó **chưa được kiểm chứng**, không phải "đã thấy hỏng". Sửa binding xong **phải chạy lại suite** trước khi ai nói là cover. Connector 3 suite vault của chính nó **xanh 38/38** ⇒ nằm ở **orchestrator**, không ở connector.
> 6. **BẪY ĐẾM SỐ mới, đã ghi vào row**: lệnh của T-27 nêu **ba** file test nhưng Jest chỉ tìm thấy **hai** — `tests/admin-actions-dispatch-offline.test.ts` **không tồn tại** (tôi Test-Path xác nhận). Nên **94/94 chỉ là conformance + pagination**; một suite bị gọi tên mà không đóng góp gì, wrapper vẫn exit 0.
> 7. **T-27 chỉ đóng được nửa "transient" của đỏ T-25.** `tsc` sạch khớp với việc `hasPageAbove` đã hết, nên `TS2304` thôi là một finding. Nhưng **`admin-audit.test.ts` KHÔNG được chạy lại**, và conformance suite test envelope **mới** chứ không phải file test contract cũ ⇒ **6 fail audit vẫn mở và chưa hề được kiểm lại**. `tsc` sạch không nói gì về một assertion runtime đỏ.
> 8. **T-CODEX-TEST-24 là inventory, không phải endpoint coverage.** `admin-audit.test.ts` là live-only nên bị **SKIP 11 test** ⇒ SKIP ≠ PASS, receipt này **không** kiểm chứng envelope/limit audit live. Phát hiện "không có suite offline HTTP nào cho API-key/business GET list" chính là lý do conformance suite của W-ADMUX02-EXT-1 trở nên **bắt buộc** thay vì tuỳ chọn.
> 9. **Qwen-SEC §8 trả về 0 production diff** vì cả 4 yêu cầu đã implemented đúng; lane đo và thêm test, **không nhận công** cho 2a (PKCE, đã verify từ trước). **Δ29 tự giới hạn**: bằng chứng ở tầng handler/router, **không phải browser driver** ⇒ **OIDC-04 vẫn `[ ]`, `G-SEC` vẫn NO-GO, không ACCEPTED gì cả**. Δ26/Δ27 là việc **cấu hình triển khai** (SEC-00/SEC-INT-02 + Admin lane), không phải lỗi code.
> 10. **Qwen-Admin §12 là bằng chứng Admin mạnh nhất từ trước đến nay** — có **mutation-check hai chiều** (MA đỏ 4 test, MB đỏ 2 test, restore 23/23), tenant fence **nằm trong SQL**, 403 **trước khi chạy query nào** (`calls.length === 0`), hex đặc ≥32 bị 422, `hash` không lộ trong SQL lẫn body, `strpos` chứ không `LIKE`. Vẫn **ADM-UX-02 `[~]`** vì 5 lý do có tên, trong đó `label`/`last-used` **không có cột** trong `api_keys` ⇒ **không thể đóng bằng query**, cần **migration + DB window**.
> 11. **Anchor KHÔNG trượt**: `review.md` vẫn **807** dòng, không prepend. Sáu anchor mới đều **verify theo nội dung dòng đích** (`tester.md#L7388/7397/7407/7417`, `qwen-sec.md#L337`, `qwen-admin.md#L1330`) — tất cả `ok=True`. Anchor cũ của T-23 (`tester.md#L7379`) cũng kiểm lại, vẫn trỏ đúng header receipt.
> 12. **Kết quả**: `docs/28` 609 → **627**, `docs/35` 763 → **783**, cả hai **v1.27.0**, header `A5 → A18`, `Still open after A18`. Anchor `#L517`/`#L674` **giữ nguyên**, CRLF thuần 627/0 và 783/0, 0 BOM, 0 marker lạ.
> 13. **Link check**: `FILES=6 TARGETS=814 ANCHORS=466 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0` (A17 794/454 ⇒ **+20 target, +12 anchor**, khớp đúng 6 row × 2 link × 2 file và 12 anchor `#L`).
> 14. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không tự adjudicate T-25, không đóng Δ21, không sửa source/test, không chạy test, không mở DB window, không commit/push.
> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~09:4x +07 (packet D-EVID-A17, cycle 10 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 9 (A16) giữ nguyên bên dưới làm lịch sử.
> 1. **Cycle này có 2 phần**: (1) `tasks/README.md` trỏ canonical sang **Turn 110**; (2) `docs/28`/`docs/35` đồng bộ adjudication Turn 110. `docs/28` 595 → **609**, `docs/35` 748 → **763**, cả hai **v1.26.0**, header `A5 → A17`, `Still open after A17`. Anchor L517/L674 giữ nguyên, CRLF thuần cả ba file.
> 2. **Packet nêu "line 3" và ĐÚNG** — blockquote đầu tiên của `tasks/README.md` nằm ở dòng 3 (dòng 1 là heading, dòng 2 trống). Đã thay 1186 → **725** ký tự. **13 blockquote còn lại giữ nguyên làm historical snapshot.**
> 3. **Em dash trong packet bị hỏng (mojibake `â€¥`)** — tôi dùng em dash thật `—`. Nếu chép nguyên văn packet thì README sẽ hiện ký tự hỏng.
> 4. **Xử lý một mâu thuẫn thật thay vì chép máy móc**: packet yêu cầu viết **"52 unaccepted task rows"** vào README, nhưng Turn 110 (L797) lại nói README nên trỏ adjudication **"without duplicating a mutable headline count"** (đúng cái blockquote cũ đầy số liệu thay đổi được). Tôi **giữ đúng 52 như packet yêu cầu** và **gắn nó cho Turn 110** kèm qualifier *"task-row count, not 52 code changes and not a readiness percentage — the adjudication is the source of truth"*. Cả hai bên đều được thoả: có con số packet yêu cầu, nhưng README không trở thành nguồn số thứ hai.
> 5. **Δ36 CLOSED (documentation scope) + D-EVID-A15 ACCEPTED cho scope đó.** Đã **thu hẹp** row A15 ở cả hai file (trước đó ghi "submitted for confirmation"). Turn 110 nói rõ A15 *"closes the documentation follow-up from T70-C1, not a runtime or release gate"*.
> 6. **Δ23 CLOSED** như sự thiếu live execution của keyset EXPLAIN suite. Đã thu hẹp row A16.
> 7. **Turn 110 SỬA cách tôi diễn đạt ở A16**: node `Sort` ở trang backward **được suite cho phép có chủ ý** (chỉ reject full-table `Seq Scan`; quan sát 63 dòng / 46 kB) ⇒ **không phải lỗi**, và câu "backward đã pass no-`Sort`" là **receipt-description error**. Đã ghi rõ, không tự phân xử ai sai.
> 8. **Δ21 VẪN MỞ — nhưng lý do đổi, và nặng hơn**: suite seed 1.240 dòng dưới **một** tenant mới, và query tenant-scoped **vẫn chọn index cross-tenant** `operations_created_id_idx` rồi filter ⇒ **không chứng minh** planner chọn `operations_tenant_created_id_idx` trên tập nhiều tenant phân tán. Index prefix cũ vẫn chưa quyết; **mọi thay đổi index sau 0017 đã apply phải qua migration mới**.
> 9. **Mẫu số release trước đây SAI, nay đã sửa**: **52** unaccepted rows = 14 P0–P8 + 16 SEC + 8 Admin UX + 10 DATA/LOG/DEP + **4 COST-01..04** (con số 48 trước đó **bỏ sót 4 dòng COST**). Là **task-row count**, không phải 52 code change, không phải phần trăm sẵn sàng. 5 dòng P9 vẫn ngoài initial release.
> 10. **COST-01..04 nay là một track thứ hai của `G-ADMIN-OPS`** (file `docs/admin-ops-monitoring-cost.md`, Test-Path=True) — browser receipt **không** accept row nào. Nên gate này chờ **hai** track.
> 11. **Anchor KHÔNG trượt lần này** — Turn 110 được **ghi nối cuối** `review.md` (L786/807) chứ không chèn đầu, nên 98 anchor cũ giữ nguyên; vẫn **verify lại theo nội dung dòng đích** (12 điểm spot-check, tất cả `ok=True`).
> 12. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không tự đóng Δ21, không sửa source/test, không chạy test, không mở window, không commit/push.
> 13. **Link check**: `FILES=6 TARGETS=794 ANCHORS=454 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A16 775/434). Lượt này **có** validate `tasks/README.md` vì file đó nằm trong danh sách scan.

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~09:2x +07 (packet D-EVID-A16, cycle 9 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 8 (A15) giữ nguyên bên dưới làm lịch sử.
> 1. **A16 ĐÃ LAND**: `docs/28` 583 → **595** (3 row mới), `docs/35` 735 → **748** (3 row mới), cả hai **v1.25.0**, header `A5 → A16`, **Still open after A16**. Anchor `#L517`/`#L674` giữ nguyên, CRLF thuần 595/0 và 748/0.
> 2. **Packet tên file ĐÚNG** (lần thứ 2 liên tiếp) và đủ 3 tài liệu trong danh sách đều tồn tại. Đã Test-Path trước khi vá.
> 3. **Ba receipt, đều đã tự đọc raw log chứ không chép receipt**: T-CODEX-TEST-21 (live PG+MinIO, **5/5 ×2**, window 08:21:26.354 → 08:24:31.085, **17/17** migration) · T-CODEX-TEST-22 (**offline** Playwright, 3 lần chạy cùng aggregate **82**, **158 axe cumulative**, 0 critical/0 serious/12 moderate, **không có DB window**) · T-CODEX-TEST-23 (live keyset, **6/6**, window 09:01:21.677 → 09:01:26.728, `Index Scan using operations_created_id_idx`, walk đủ **1.240** dòng).
> 4. **Δ23 ĐÃ ĐƯỢC VÔ HIỆU**: "đã viết nhưng chưa chạy" → **đã chạy live thật**. Đây là bằng chứng mà Δ23 chờ. **Đã thu hẹp câu cũ trong cả hai file.**
> 5. **Δ21 VẪN MỞ — nhưng lý do đã đổi**: không còn là "thiếu EXPLAIN" mà là (a) **trang backward vẫn có node `Sort`** (log T-CODEX-TEST-23: quicksort `Sort Key: created_at, id` trên `Bitmap Heap Scan` + `Bitmap Index Scan on operations_created_id_idx`) vì 2 assertion no-`Sort` **chỉ phủ 2 query forward**; (b) quyết định về index prefix cũ `operations_tenant_created` vẫn chưa ghi.
> 6. **ADM-UX-07 VẪN MỞ**: T-CODEX-TEST-22 là **synthetic in-process**, receipt **tuyên bố không claim C4/C5** (HTTP authorization role/action/tenant, CSRF negative, DB immutability, audit side effect; live seeded + timestamp + screenshot từng journey). Cần seed PG/Redis thật.
> 7. **DATA-02/04 + G-DATA VẪN MỞ**: T-CODEX-TEST-21 chạy `data-02-04-live-s3.test.ts` — nhánh **runtime/lease**, **không có** lời gọi `/api/v1/uploads`, nên vòng đời **public binary** chưa được kiểm chứng. Sàn 1–64 MiB và Δ5 vẫn nguyên.
> 8. **BA BẪY ĐẾM SỐ — đã ghi ngay trong row để không ai lặp lại**: (a) **T-CODEX-TEST-21 CÙNG scope với T-DATA-LIVE-4** (cùng file suite, cùng 5/5 ×2) → là **rerun độc lập, KHÔNG phải 10 pass**; (b) **82 là MỘT aggregate chạy 3 lần, KHÔNG phải 246**, và **158 axe là tổng tích luỹ qua 3 lần, KHÔNG phải 158/lần**; (c) suite keyset đã chạy **đỏ 4/6** (TEST-18) → **xanh 6/6** (TEST-20) → **xanh 6/6** (TEST-23) trên 3 snapshot khác nhau, **không cộng**, giữ luôn bản đỏ.
> 9. **Hai chỗ TRÔNG NHƯ MÂU THUẪN, đã giải bằng log chứ không bỏ qua**: log T-CODEX-TEST-22 in `88 axe scans` ở lần ghi đầu, receipt nói 158 → thực tế **bộ đếm tích luỹ 88 → 102 → 116 → 130 → 144 → 158**, và `artifacts-summary.json` cuối cùng khớp đúng **158 / 0 critical / 0 serious / 12 moderate**. Và T-CODEX-TEST-20 viết backward "passed no-Sort assertions" trong khi log TEST-23 **có** `Sort` → **ghi ra, không tự phân xử**.
> 10. **Lần đầu trong 4 packet, `review.md` KHÔNG đổi** (vẫn **784** dòng, mtime 08:53:03) nên **98 anchor không trượt**; vẫn **verify lại bằng nội dung dòng đích** (0 suspect) và xác nhận 3 anchor `tester.md` mới rơi đúng vào header receipt.
> 11. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không tự đóng Δ21/Δ23/ADM-UX-07, không sửa source/test, không chạy test, không mở window, không commit/push.
> 12. **Link check**: `FILES=6 TARGETS=775 ANCHORS=434 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A15 761/428).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~09:0x +07 (packet D-EVID-A15, cycle 8 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 7 (A14) giữ nguyên bên dưới làm lịch sử.
> 1. **Lần đầu trong 3 packet, TÊN FILE TRONG PACKET ĐÚNG HẾT.** `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `docs/19-traceability-audit-matrix.md`, `docs/20-openapi-descriptions.md`, `docs/22-p0-06-capacity-targets.md` — tất cả tồn tại, và **cả 3 số dòng packet nêu (19:157, 20:34, 22:27) đều đúng**. Vẫn `Test-Path` trước mỗi lần vá.
> 2. **A15 ĐÃ LAND**: `docs/28` 577 → **583** (5 row mới), `docs/35` 731 → **735** (4 row mới), cả hai **v1.24.0**, header `A5 → A15`, anchor `#L517`/`#L674` giữ nguyên. Ba tài liệu ngoài ledger cũng đã vá: `docs/19` 279, `docs/20` 115, `docs/22` 68 dòng.
> 3. **Δ36 đã trả lời (theo nghĩa tài liệu), nhưng KHÔNG tự tick.** `docs/20:34`: khối MISMATCH → khối closure, nêu đúng symbol; các câu sai "cursor cap 512", "3 tham số", "pageOf trả 2 field" **đã biến mất**. `docs/19:157`: đoạn attribution viết lại. `docs/22:27`: dòng capacity giờ trích `OPERATIONS_LIST_LIMIT_DEFAULT / _MAX` + ghi rõ `PageQuerySchema` là generic base. **Turn 100 vẫn ghi Δ36 OPEN** chờ `BROKEN=0`, nên đây là **nộp để Reviewer xác nhận**, không phải tự tuyên bố.
> 4. **T70-C2 đã khắc phục**: **13 path `Test-Path`, 0 thiếu**, và mọi path viện dẫn đều Test-Path=True. Từ nay packet template nên `Test-Path` tên file canonical trước khi dispatch (Reviewer đã yêu cầu ở Turn 70 mục 5).
> 5. **A14 snapshot đã ghi theo yêu cầu Turn 70 mục 5**: **6 câu** + link check **722 target / 420 anchor / 0 broken**. Bản cũ **5 câu / 713/411** giữ làm lịch sử, **không gộp, không trung bình, không đối chiếu** — chính chỗ lệch đó là dữ liệu.
> 6. **Phát hiện lớn nhất cycle: `review.md` ĐỔI 3 LẦN TRONG LÚC ĐANG LÀM** — 602 dòng (đầu cycle) → 763 (giữa) → **784** (cuối), vì turn mới được chèn ở đầu và một turn nở thêm thân bài. Mọi anchor phải dò **theo nội dung**, không cộng/trừ số. Đã repoint **41 anchor** (`docs/28`) + **57** (`docs/35`) và **verify lại từng cái bằng cách đọc dòng đích**.
> 7. **Ba lỗi tự làm, đều do PowerShell — ghi lại vì chắc chắn lặp lại**: (a) **array literal trộn `+` với dấu phẩy** (`@('a'+$b+'c','d')`) nuốt dấu phẩy ⇒ phần tử bị dính liền, **0 thay thế** và **không báo lỗi**; dính ở `$fam`, `$fix`, `AddFix`. (b) **thay thế chuỗi có chồng lấn** (`L214)→L235)` rồi `L235)→L256)`) làm anchor sai nội dung — phải verify và sửa lại. (c) **label có ký tự non-ASCII** (en dash, Δ) trong `.ps1` không BOM bị PowerShell đọc thành ANSI. Cách né cả ba: **rule dạng pipe-delimited thuần ASCII + `Test-Path`/`MatchEvaluator`**, và **luôn có sàn số lượng thay thế** để fail loud.
> 8. **Bài học về quy trình**: suýt ghi "đã xong" vì `anchors_repointed=0` mà không ném lỗi. Thêm sàn `if (hits -lt expect) { throw }` **cứu một lần** (docs/35 không bị ghi nửa vì). **Không bao giờ tin báo cáo 0 thay thế mà không kiểm.**
> 9. **Turn 70/80/90/100**: T70-C1 **đóng ở code** bởi W-CONTRACT-ALIGN-1 (Turn 80), **Δ36 (docs) là follow-up duy nhất** và thuộc lane này; Turn 90 có dòng `| **D-EVID-A14** |` ghi **"corrected five"** — mâu thuẫn với ledger 6 câu của chính lane, **giữ nguyên mâu thuẫn, không tự sửa số của Reviewer**. Turn 100: API-key blocker **đã resolved** (không còn là blocker đang chạy), **T-CODEX-TEST-21** hợp lệ ở phạm vi pilot (17/17 migration, 2 lần chạy **1 suite / 5 passed, exit 0**), Δ36 open, **4 gate NO-GO**.
> 10. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không tự tick Δ36, không adjudicate Δ32–Δ35, không sửa source (kể cả schema contracts), không chạy test, không mở window, không commit/push.
> 11. **Link check**: `FILES=6 TARGETS=761 ANCHORS=428 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A14 722/420).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~05:0x +07 (packet D-EVID-A14, cycle 7 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 6 (D-DOCS-CONTRACT-SYNC-1) giữ nguyên bên dưới làm lịch sử.
> 1. **Packet sai tên file LẦN THỨ HAI liên tiếp.** Packet ghi `docs/28-threat-model.md` và `docs/35-operational-runbooks.md` — **cả hai đều không tồn tại** (`Test-Path` = False). File thật: `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`. Kèm cycle 6 (packet ghi `docs/19-traceability-matrix.md`, thật là `19-traceability-audit-matrix.md`) ⇒ **2 packet liên tiếp sai tên file**. Đã báo coordinator cả hai lần; đề nghị sửa template `tasks/AGENT-TASK-TEMPLATE.md`.
> 2. **A14 ĐÃ LAND**: cả hai file → header `A5 → A14`, Document Version `1.22.0 → 1.23.0`. `docs/28` 564 → **577** (7 row mới), `docs/35` 720 → **731** (5 row mới). Anchor `#L517` và `#L674` **giữ nguyên**.
> 3. **Đã sửa 6 câu, không phải 5.** Năm câu packet nêu (sentinel, Δ13/Δ22 index, Δ14 renderer, DATA-03 server, ADR/claim-shape) **+ 1 câu do chính cycle trước của tôi làm cũ**: `docs/28:552`/`docs/35:713` vẫn nói `docs/20` + traceability còn contract cũ, nhưng D-DOCS-CONTRACT-SYNC-1 đã sửa xong. Sửa luôn và kèm pointer tới **MISMATCH thứ 3** ở `packages/contracts/src/public-api.ts`.
> 4. **Bẫy đơn vị đo lớn nhất cycle**: T-CODEX-TEST-11 là **3 suite / 23 test** (sentinel + br05 + uc07), **23 KHÔNG phải số case của riêng sentinel matrix**. Đã tự đọc raw log (PASS sentinel 5.226 s, br05 5.021 s, uc07 5.036 s) và ghi rõ trong cả hai file để không ai đọc nhầm thành "sentinel 23 case".
> 5. **Hai khoảng trống phải ghi, không được đọc là pass**: (a) **Δ23** — `tests/admin-keyset-explain.test.ts` **đã viết nhưng CHƯA CHẠY** (6 test, seed 1.240 dòng, gate `DU_LIVE_INFRA=1`) → cần Tester DB window; (b) **Δ24** — migration 0017 **đã bị sửa tại chỗ**, an toàn chỉ vì chưa apply ở đâu; sửa lần sau phải ra file mới (0018). Thêm: **Δ10** — cô lập runner chưa áp cho orchestrator/connector.
> 6. **Không tự reconcile 506 vs 507**: T-CODEX-TEST-13 (có suite live) báo 42 suite/**507** pass; runner offline sau W-DOC-ISOLATE-1 báo 42 suite/**506**. Lệch 1 test, receipt đọc được không giải thích được ⇒ **ghi là chưa đối chiếu**, không tự chọn một số.
> 7. **Anchor trượt lần thứ 2, đều đặn +36** (Turn 50 chèn ở đầu). **Đã repoint 28 anchor trong `docs/28` + 14 trong `docs/35`**. **`tester.md` cũng trượt ngay trong lúc làm** (7416 → 7426 dòng) — may là phần mới thêm ở cuối nên L7309/L7313/L7354/L7358 của T-CODEX-TEST-11/14 không đổi; đã verify lại **ngay trước khi ghi**.
> 8. **Quyết định kỹ thuật đáng nói: chọn repoint +36, KHÔNG đổi sang heading anchor.** Lý do: chỉ **3/28** link `review.md` trong `docs/28` trỏ tới heading của turn; **25 link còn lại trỏ từng dòng bảng**, không có heading để neo. Đổi sang heading anchor chỉ sửa được thiểu số, còn phần còn lại sẽ **rơi ra khỏi tầm checker** ⇒ tệ hơn. Sửa bền phải do **Reviewer/coordinator**: không chèn thêm turn ở đầu `review.md`, hoặc cho mỗi dòng audit một ID ổn định.
> 9. **Sai lệch của chính lane ở cycle này — 4 lỗi, đã tự bắt và sửa**: (a) chèn đoạn kết làm **6 dòng LF lọt vào file CRLF**; (b) thêm **1 dòng trống thừa** cạnh dòng trống sẵn có → 2 dòng trống giữa bảng; (c) quên tách `###END###` khi áp edit → **marker lọt vào cả hai file** cùng 1 LF; (d) script đếm LF bằng vòng byte lại cho kết quả sai. Tất cả đều bị bắt bởi **verify line-ending + anchor sau mỗi lần vá**, không phải bởi checker.
> 10. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không sửa source (kể cả schema contracts lỗi thời và migration 0017), không chạy test, không mở window DB/Redis/S3/Vault, không commit/push.
> 11. **Link check**: `FILES=6 TARGETS=722 ANCHORS=420 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A13 662/363).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~03:3x +07 (packet D-DOCS-CONTRACT-SYNC-1, cycle 6 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 5 (A13) giữ nguyên bên dưới làm lịch sử.
> 1. **Cycle này KHÔNG đụng docs/28 và docs/35** — Reviewer Turn 50 finding 1 (L28) ghi rõ *"Update docs/19 and docs/20; **retain docs/28/35 A13 as current evidence**"*. Nên **không** có version bump, **không** có row mới, header vẫn `A5 → A13`, `docs/28` 564 dòng / `docs/35` 720 dòng / `docs/06` 136 dòng — y nguyên.
> 2. **Cảnh báo tên file trong packet**: packet ghi `docs/19-traceability-matrix.md` — **file đó không tồn tại**. Tên thật là `docs/19-traceability-audit-matrix.md`. Lane nào làm packet này sau mà tin packet sẽ tạo nhầm file hoặc báo "không thấy".
> 3. **Đã sửa `docs/20-openapi-descriptions.md`** (111 → 115 dòng): dòng `GET /api/v1/operations?limit&cursor` → `?limit&cursor&state&tenant&id`, envelope thành 5 field, lỗi thành `401; 403; 422`, bỏ citation schema sai, thêm `Source` đúng `server.ts 1173-1211` + 8 dòng helper.
> 4. **Phát hiện MỚI, chưa ai nêu: schema zod của contracts đã lỗi thời VÀ là code chết.** `packages/contracts/src/public-api.ts` (mtime **09-21**, chưa ai sửa) khai `PageQuerySchema` (L12) + `ListOperationsQuerySchema` (L22) + `pageOf()` (L18). Route **không import** chúng — nó tự parse bằng `parseOperationsListQuery`. Grep toàn repo: **0 tham chiếu nào khác**. Vẫn được `packages/contracts/src/index.ts:18` (`export * from './public-api'`) re-export ⇒ **nằm trên mặt API của package cho consumer**. Lệch 3 điểm: 3 tham số vs 5; `state` kiểu máy `OperationStateSchema` vs enum UI (UI map ra 7 wire state); cursor max **512** vs route cap **128**. Owner: contracts/platform. **Đây là MISMATCH thứ 3** (ngoài docs/20 và docs/19) mà Turn 50 chưa nêu.
> 5. **Đã sửa `docs/19-traceability-audit-matrix.md`** (275 → 279 dòng): thêm 2 đoạn ở **§4 Endpoint interpretation and known route corrections** (L155, L157) — mô tả contract list + **đính chính** attribution schema, theo đúng quy ước `Test-Path=True` của file. Cả 4 path đã chạy `Test-Path` → đều `True`.
> 6. **Anchor review.md TRƯỢT LẦN THỨ HAI, đều đặn +36.** Turn 50 chèn ở đầu (L3–L37) → Turn 40 L3→L39, Turn 30 L38→L74, Turn 20 L74→L110. **Cả 25 anchor** mình repoint ở A13 giờ lệch **đúng +36**. Đã đo lại toàn bộ bản đồ (Turn 40 rows L51–L60, findings L64–L68, release L72; Turn 30 T20-V1 L86, closeout A L100, release L108; Turn 20 T20-V1 L118, T20-E1 L124, gate decision L146→para L148).
> 7. **Cố ý KHÔNG repoint trong cycle này** vì Turn 50 bảo giữ nguyên docs/28/35. Đây là **nợ kỹ thuật có hạn**: mỗi turn Reviewer mới làm hỏng anchor một lần nữa. Đề xuất sửa bền: chuyển sang **heading anchor** thay vì `#L<n>` (checker hiện chỉ validate `^L([0-9]+)$`, nên heading anchor không bị kiểm → nhưng bền hơn nhiều trong viewer).
> 8. **Vài câu trong docs/28/35 A13 đã thành câu SAI, chờ packet**: (a) A13 ghi *"the standalone sentinel test was not run in the cited packet"* — Turn 50 L22 nói **T-CODEX-TEST-11 đã chạy sentinel matrix 23/23** và gọi câu đó là **stale**; (b) A13 ghi Δ13 index mở — Turn 50 L16: migration `0017_operations_keyset_index.sql` đã có, còn **Δ21** query-plan; (c) A13 ghi Δ14 renderer mở — Turn 50 L15: **đã đóng**; (d) A13 ghi DATA-03 server slice "SPECIFIED, chưa implement" — Turn 50 L19: **đã IMPLEMENTED offline**; (e) A13 ghi claim-shape cần ADR — Turn 50 L23: **đã IMPLEMENTED**. **Không tự sửa** vì ngoài scope packet.
> 9. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không sửa source (kể cả schema contracts lỗi thời), không chạy test, không mở window, không commit/push.
> 10. **Link check**: `FILES=6 TARGETS=662 ANCHORS=363 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 — **không đổi** so với A13 vì hai file sửa **không nằm trong danh sách scan** của checker và tôi **không thêm markdown link nào** (docs/20 có 0 link, docs/19 có 13 link tất cả đã có sẵn ở L251–279, ngoài vùng chèn L155–158).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~02:5x +07 (packet D-EVID-A13, cycle 5 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7) → Mục 4 (A12) giữ nguyên bên dưới làm lịch sử.
> 1. **A13 ĐÃ LAND, và lần này có 3 file**: `docs/06-public-api.md` (78 → 136 dòng), `docs/28` §8.16 (554 → 564), `docs/35` §12.19 (713 → 720). Hai file evidence: header `A5 → A13`, Document Version `1.21.0 → 1.22.0`, **9 row mới** trong `docs/28` và **7 row mới** trong `docs/35`. Anchor `#L517` và `#L674` **giữ nguyên**.
> 2. **Packet 1 (docs/06) khác mọi packet trước**: đây là lần đầu lane này sửa **tài liệu hợp đồng**, không chỉ ledger bằng chứng. Không chép lời Reviewer — tôi **đọc thẳng source** `services/orchestrator/src/server.ts` rồi mô tả đúng những gì code làm.
> 3. **Sai khác docs/06 cũ vs code (đã sửa)**: dòng catalog ghi `cursor,limit,state` → `200 cursor page` → `400,401`. Code thật là **5 tham số** (`cursor, limit, state, tenant, id`), envelope **`{items,nextCursor,prevCursor,total,limit}`**, lỗi **401,403,422**. `new HttpError(400` **không có match nào** trong cả `server.ts` → cột `400` là cái sai, không phải thiếu.
> 4. **Chi tiết đáng ghi vì rất dễ đọc sai**: `state` trên wire **không nhận `ALL`** (điều kiện là `candidate in OPERATIONS_STATE_FILTER_STATES`, vắng `state` mới là không lọc); `limit` là tham số **duy nhất clamp thay vì 422**; `tenant`/`id` sai là **422 chứ không bị bỏ qua**; `id` dùng `strpos` **cố ý không dùng `LIKE`** (vì charset cho phép `_` là wildcard); token cứng ≥32 hex bị từ chối vì là **API-key material**, không phải id.
> 5. **Turn 40 đã gỡ đỏ mà A12 ghi**: `prevCursor` **resolved at the reviewed code boundary (offline VERIFIED)**. Owner receipt là Qwen-Admin W-ADMUX02-SRV-1-FIX (`qwen-admin.md:490`) — sửa 2 lỗi `prevCursor`, thêm test roundtrip 1→2→1 với fake DB có trạng thái, 70/70 ×3, tsc ×3, 530/530 ×3. **Nhưng ADM-UX-07 + G-ADMIN-OPS vẫn mở** (browser, EXPLAIN/seeded live, insert chen giữa trang, tenant isolation trên service đã deploy).
> 6. **Bẫy số lớn của cycle**: 70 (targeted) / 530 (ten-suite) / 656 (targeted khác) / 1342 (aggregate) là **bốn scope khác nhau**, và 1342 chính là T-CODEX-TEST-2 đã có sẵn trong section → **không cộng vào nhau, không cộng vào aggregate**.
> 7. **Phát hiện về chính docs của lane (bug thật, đã sửa)**: Turn 40 được chèn ở **ĐẦU** `review.md`, nên **mọi anchor `review.md#L…` tôi viết ở A11/A12 đã trượt sang dòng khác**. Link check **không bắt được** vì nó chỉ kiểm anchor có nằm trong file hay không, không kiểm nội dung dòng. Đã **repoint 11 anchor trong `docs/28` + 14 anchor trong `docs/35`**; **không** đụng anchor cũ của lane khác (Cycle 114–137) vì không xác định được audit nào.
> 8. **Đỏ cũ giữ nguyên, không xoá**: 2/5 của T-DATA-LIVE-3R và Δ5/T20-D2 vẫn mở. Reviewer Turn 40 nói rõ *"Preserve the failed 2/5 receipt as history; it is not superseded by offline green suites."*
> 9. **Mâu thuẫn snapshot `dispatcher.ts` `String(err)` được THU HẸP, chưa đóng**: Turn 30 nói còn control-flow `String(err)` "không bị emit"; Turn 40 nói raw coercion **đã xoá**, đồng thời xác nhận **standalone sentinel test KHÔNG chạy** trong packet được viện dẫn. Ghi đúng việc, **không adjudicate** — việc đó của Reviewer.
> 10. **Hai nguồn OIDC-02 xung đột, docs phải trích đúng nguồn**: `qwen-sec.md:12` vẫn nói OIDC-02 đang chờ live legs (**stale**), còn receipt Tester T-OIDC02-LIVE-1R (`tester.md:7264`) là 13/13 gồm **7 case Redis thật**. Cả hai receipt **đã có sẵn trong section từ A6** → **không thêm row trùng**, chỉ ghi rõ receipt nào là nguồn được trích.
> 11. **MISMATCH docs/06 chỉ gỡ được một phần** — 3 chỗ còn contract cũ, **không nằm trong packet**: (a) `docs/20-openapi-descriptions.md:24` vẫn ghi `?limit&cursor` → `{items: OperationView[], nextCursor: null}`; (b) traceability **không có dòng nào** cho contract list này — đây là **thiếu phủ**, khác với "câu sai"; (c) Δ14 câu chữ cũ trong `operation-section-renderer.ts` — **là source, lane này không được sửa**.
> 12. **Sai lệch của chính lane ở cycle này (đã sửa)**: lần chạy applier đầu tiên, PowerShell nuốt `+` như **argument riêng** nên header §8.16 bị ghi thành `+→ A12 …` thay vì `### 8.16 D-EVID-A5 → A13 …`. Guard bắt được qua kiểm tra `L517`; đã sửa, và **mọi biểu thức nối chuỗi từ đó đều bọc ngoặc**.
> 13. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không adjudicate Δ/T20 nào, không sửa report lane khác, không sửa source/test, không chạy test, không mở DB/Redis/S3/Vault window, không commit/push.
> 14. **Link check**: `FILES=6 TARGETS=661 ANCHORS=362 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A12 là 617/318).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~02:0x +07 (packet D-EVID-A12, cycle 4 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục. Mục 1 (A7), Mục 2 (A10) và Mục 3 (A11) giữ nguyên bên dưới làm lịch sử.
> 1. **A12 ĐÃ LAND**: `docs/28` §8.16 + `docs/35` §12.19 → header `A5 → A12`, Document Version `1.20.0 → 1.21.0`, **8 row mới mỗi file**. Anchor `#L517` / `#L674` kiểm lại sau mọi lần vá, vẫn đúng. `docs/28` 554 dòng / 34 data row; `docs/35` 713 dòng / 36 data row; cả hai bảng liên tục.
> 2. **KHÔNG có va chạm lần này** — hai file vẫn nguyên số liệu A10 lúc bắt đầu cycle (546 dòng / 102420 B; 705 dòng / 137099 B), tức không ai sửa sau A11.
> 3. **Tin quan trọng nhất của cycle: T20-V1 ĐÃ ĐƯỢC REVIEWER GIẢI QUYẾT.** Turn 30 (`review.md:3`) kết luận **T20-V1 resolved at the reviewed code boundary, offline VERIFIED** và **T20-S1 resolved** cho live matrix. Đây chính là next-owner #2 mà A11 đã nêu. HOLD mà A11 ghi **được Reviewer gỡ**, không phải do lane tự gỡ — cả hai docs đều ghi rõ nguồn công.
> 4. **Nhưng Turn 30 cũng MỞ một đỏ mới**: `listOperationsPage` tính `prevCursor` bằng `(created_at,id) < firstRow` trong khi điều hướng descending dùng `< cursor` → Previous ở trang 2 có thể nhảy sang trang sau. **Đỏ này mới hơn aggregate xanh T-CODEX-TEST-2** → theo `AGENTS.md`, gate phải giữ mở. Đã thêm 1 dòng *Open gate* cho ADM-UX-02/03 + G-ADMIN-OPS.
> 5. **Hai receipt live mà Turn 30 viện dẫn không nằm trong scope packet** (`admin-action-rbac-live.test.ts` 12/12 và `admin-error-boundary.test.ts` 1/1). Lane đã **tự tìm và đọc** trong `tester.md` (dòng 3059–3130) để không ghi citation không kiểm chứng. Cảnh báo đã ghi: **1/1 nằm trong window mà webhook fence đỏ 2/2, `runtime.test.ts` lỗi compile, p8-04 17/26** — Reviewer gọi là "a slice only".
> 6. **Bẫy con số lớn nhất của cycle — cùng một bộ test chạy lại ở nhiều packet.** 39 (cặp orchestrator) xuất hiện ở ORCH-BIND-1, TRUST-ORIGIN-1, VAULT06-LIFECYCLE-1, VAULT04-CONF-1; 49 (4 suite connector) ở VAULT05-INTEG-1, VAULT04-CONF-1, W-SEC-SINK-1; 22 (observability) ở T-CODEX-TEST-8 và W-SEC-SINK-1. **Tổng 88 của W-VAULT04-CONF-1 = 49 + 39 của chính packet đó, KHÔNG phải grand total.** T3 (109 / 40) nằm trong T7 (203) và 39-pair. Không cộng ở bất kỳ đâu.
> 7. **Đỏ giữ nguyên làm lịch sử**: T-CODEX-TEST-8 egress lần đầu `EADDRINUSE` **2 failed, 32 passed**, chạy lại xanh 34/34, log giữ lại là lần xanh — cả hai đều ghi trong docs, không xoá lần đỏ.
> 8. **Khoảng trống phải ghi, không giấu**: `tests/unit/sentinel-sink-matrix.test.ts` **không chạy được** (workspace root không có Jest binary) → W-SEC-SINK-1 ghi là khoảng trống phủ, không phải pass.
> 9. **Sai lệch thời gian chưa ai adjudicate**: Qwen-SEC Δ5 nói `dispatcher.ts` còn `String(err)`; Codex-6 W-SEC-SINK-1 nói **đã xoá** (`qwen-sec.md` mtime 01:37:50 < `codex6.md` 01:42:19). Nhưng Reviewer Turn 30 vẫn mô tả coercion đó là **đang có** → 2 snapshot khác nhau. Ghi "appears addressed, cần Reviewer xác nhận", **không tự adjudicate**.
> 10. **Sai lệch của chính lane ở cycle này**: A12 neo vào dòng gate VAULT-01 (vì phải thu hẹp nó) → block A12 lọt **phía trên** block A11 trong `docs/28`, phá vỡ quy tắc append-at-end của chính lane. Đã **ghi rõ trong docs** rằng section không append-ordered và bằng chứng mới nhất nằm ở trên, thay vì sửa bằng cách xoá/ghi lại row (rủi ro mất việc lane khác). `docs/35` chèn trước `Acceptance boundary` nên **đúng thứ tự append**.
> 11. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không adjudicate Δ/T20 nào, không sửa report lane khác, không sửa source/test, không chạy test, không mở DB window, không commit/push.
> 12. **Link check**: `FILES=6 TARGETS=617 ANCHORS=318 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A11 là 516/269).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~01:3x +07 (packet D-EVID-A11, cycle 3 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục, không cần đọc lại transcript. Mục 1 (A7) và Mục 2 (A10) giữ nguyên bên dưới làm lịch sử.
> 1. **A11 ĐÃ LAND**: `docs/28` §8.16 + `docs/35` §12.19 → header `A5 → A11`, Document Version `1.19.0 → 1.20.0`, **4 row mới mỗi file**. Anchor `#L517` / `#L674` của `codex4.md` đã kiểm lại sau mọi lần vá, vẫn đúng. `docs/28` 546 dòng / 26 data row liên tục; `docs/35` 705 dòng / 28 data row liên tục.
> 2. **Không có va chạm lần này.** Hai file vẫn đúng nguyên số liệu A10 lúc bắt đầu cycle (542 dòng / 95798 B; 701 dòng / 129510 B). **Nhưng** `codex6.md` đã **tăng 141 → 208 dòng**, thêm `W-VAULT01-ORCH-BIND-1` (dòng 142), `W-VAULT01-TRUST-ORIGIN-1` (164), `W-VAULT02-POL-1` (188).
> 3. **Điểm nhạy cảm nhất của cycle — T20-V1 vs Codex-6, NGƯỢC thứ tự thời gian.** Reviewer kết luận lúc **01:15**: writer path không lấy được origin tenant/account từ principal → `MISMATCH`, VAULT-01 / VAULT-03 / G-SEC **HOLD**. `codex6.md:164` viết lúc **01:20**, **sau** audit, tuyên bố đã xử lý đúng finding đó. Hai raw log `codex6-orchestrator-offline-tests.log` và `codex6-W-VAULT01-TRUST-ORIGIN-offline-tests.log` đều `2 passed, 2 total / 39 passed, 39 total` → **cùng 39 test chạy lại 2 lần, không phải 78**.
> 4. **Quyết định của lane (cần coordinator xác nhận)**: ghi receipt Codex-6 vào docs theo dạng **"đã ghi nhận, chưa chấp nhận"**. Bỏ qua thì docs sai theo hướng khác (T20-E1 vừa phê bình đúng lỗi đó); ghi như kết quả thì tự ý nâng gate. Cả hai row đều ghi rõ: **markdown không đóng được gate nào**.
> 5. **Sửa cải lỗi Reviewer chỉ ra (T20-E1)**: dòng `Acceptance boundary` trước này nói đỏ package Cycle 139 "vẫn chưa đóng" — nay sửa thành **superseded ở phạm vi offline full-package** nhờ T-ANTIG-2, nhưng 2 suite `CONNECTOR_INTEGRATION` vẫn là **skip chứ không phải pass**. Và row gate VAULT-01 được **thu hẹp** chứ không phải đảo ngược: writer đã gửi field, nhưng **origin** chưa được tin.
> 6. **Tự kiểm số liệu từ raw log** (không số nào chép từ trí nhớ): T-CODEX-TEST-2 orchestrator `1 skipped, 57 passed, 57 of 58 total` / `15 skipped, 1342 passed, 1357 total`; contracts `1 passed, 1 total / 59 passed, 59 total`; T-ANTIG-2 `2 skipped, 19 passed, 19 of 21 total` / `7 skipped, 219 passed, 226 total` / `Snapshots: 0 total` / `Time: 8.781 s`.
> 7. **Bẫy cũ vẫn phải nhớ**: (a) `*.log` bị gitignore → **không dùng `glob` để chứng minh một file KHÔNG tồn tại**, dùng `Get-ChildItem` / `Test-Path`; (b) **không chèn dòng trống khi append row bảng markdown**; (c) raw log T-ANTIG-2 nằm ở `%TEMP%` **ngoài repo** → ghi bằng text thuần không link để không sinh link gãy; (d) **đọc lại cả hai file ngay trước mỗi lần vá**.
> 8. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không adjudicate T20-V1 hay Δ nào, không sửa report lane khác, không sửa source/test, không chạy test, không mở DB window, không commit/push.
> 9. **Link check**: `FILES=6 TARGETS=516 ANCHORS=269 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 (A10 là 492/249).

> [!IMPORTANT]
> **RESUME POINT — 2026-09-26 ~01:1x +07 (packet D-EVID-A10, cycle 2 của lane Qwen-Docs).**
> Đọc khối này là đủ để tiếp tục, không cần đọc lại transcript. Mục 1 (A7) giữ nguyên bên dưới làm lịch sử.
> 1. **A10 ĐÃ LAND**: `docs/28` §8.16 + `docs/35` §12.19 → header `A5 → A10`, Document Version `1.18.0 → 1.19.0`, **4 row mới mỗi file** (T-CODEX-TEST-1, W-DATA02-PUB-2, và 2 dòng *Open gate*), trỏ Δ5 vào row `W-DATA02-PUB-1`, viết lại dòng `Acceptance boundary`. Anchor `#L517`/`#L674` của `codex4.md` **đã kiểm lại sau mọi lần vá, vẫn đúng**.
> 2. **PHÁT HIỆN QUAN TRỌNG — HAI FILE NÀY CÓ NGƯỜI VIẾT KHÁC.** Lúc **00:45:36**, *sau khi* A7 chốt, lane Codex-Security đã tự thêm row `W-VAULT01-BIND-1` vào `docs/35` (dòng 684) và sửa một row ở `docs/28` (dòng 348). Lane **không** đụng row của họ, chỉ append sau. **Quy tắc bắt buộc: đọc lại hai file ngay trước mỗi lần vá** — nếu không sẽ ghi đè việc của lane khác.
> 3. **Bug của chính lane ở cycle này**: khi chèn row mới bằng cách neo vào đoạn kết, tôi thêm cả một dòng trống dẫn trước → **cắt đứt bảng markdown**. Đã phát hiện ngay và sửa. **Khi append row vào bảng, tuyệt đối không chèn dòng trống.**
> 4. **Tự kiểm số liệu**: T-CODEX-TEST-1 đã đọc lại từ **3 raw log** → `2 passed, 2 total` / `28 passed, 28 total` / 9.323 s, build + typecheck là log `tsc` không output. **W-DATA02-PUB-2 thì KHÔNG có raw log** (chỉ trích output nội tuyến trong receipt) → đã ghi rõ là thiếu bằng chứng thô.
> 5. **Ba con số multipart là ba scope khác nhau, không bao giờ cộng**: **82** (PUB-2: routes 30 + service 52) là tập con của **104** (T-ANTIG-1: 52+30+16+6), và cả hai khác **102** (W49-Q5R-1: 4 suite).
> 6. **T-CODEX-TEST-1 KHÔNG đóng được đỏ package `@du/connector`**: nó chỉ chạy lại 2 suite mục tiêu, không chạy lệnh full-package của Cycle 139 (2 suite / 3 test đỏ). `T-ANTIG-2` (`tester-antigravity.md` dòng 133) mới là receipt full-package nhưng **vẫn không nằm trong nguồn của A10** nên tiếp tục không chép.
> 7. **Hai gate đã đánh dấu OPEN**: DATA-02 public live (không receipt nào gọi `/api/v1/uploads`) và VAULT-01 binding (chỉ offline). **Δ5** mới từ PUB-2 được thêm vào danh sách Δ chưa adjudicate.
> 8. **Không làm**: không tick `[x]`, không nâng ACCEPTED, không sửa report của lane khác, không sửa source/test, không adjudicate Δ nào.

> **Còn hiệu lực từ A7**: hai lane docs tồn tại song song (`qwen-new.md` vs `qwen-docs.md`); `*.log` bị gitignore nên **không dùng `glob` để chứng minh file vắng**; hai aggregate (1248 vs 1301 test) là lệnh khác trên 2 trạng thái cây nên không gộp.
>
> **— A7 (cycle trước), giữ để đối chiếu —**
> **RESUME POINT — 2026-09-26 ~00:2x +07 (packet D-EVID-A7).**
> Đọc khối này là đủ để tiếp tục, không cần đọc lại transcript.
> 1. **Hai lane docs đang tồn tại song song, và chúng KHÁC NHAU.** Lane cũ `QwenNew` (`term_def1af97`, coordinator Qwen cũ) đã xong D-EVID-A6 và ghi vào `coordination/reports/qwen-new.md`. Phiên này là `Qwen-Docs` của coordinator Antigravity, dispatch ghi rõ `coordination/reports/qwen-docs.md` (`coordination/scripts/dispatch-turn1.ps1:42`). **Lane này không ghi vào `qwen-new.md`** — đó là report của lane khác. Coordinator cần quyết định có retire/merge lane cũ hay không.
> 2. **A7 đã LAND vào `docs/28` §8.16 và `docs/35` §12.19.** Header đổi `A5 → A6` thành `A5 → A7`, Document Version bump `1.17.0 → 1.18.0`, placeholder "in flight" của W-VAULT04-FIX1 chuyển thành receipt thật + thêm row D-LINT-ORCH-1. Anchor `#L517`/`#L674` mà `codex4.md` dùng **đã kiểm lại sau mọi lần vá, vẫn đúng**.
> 3. **Mục packet T-DATA-LIVE-4 là no-op**: nó đã được A6 chép đúng vào cả hai docs; lane đã đối chiếu từng trường với `tester-antigravity.md#L98` và khớp, nên **không** thêm row trùng.
> 4. **Bằng chứng mạnh nhất của cycle này không phải số liệu chép tay mà là một lần tự đính chính**: lane đã viết vào docs rằng raw log của Cycle 140 "vắng mặt khỏi working tree" dựa trên `glob`, rồi phát hiện `du-rework/.gitignore` có `*.log` nên `glob` **ẩn** file gitignored. `Get-ChildItem -Filter *.log` cho `LOG_COUNT=49`. Câu sai đã bị sửa, và 10 link raw log thật đã được thêm vào docs. **Bài học dùng lại được: không dùng `glob` để chứng minh một file KHÔNG tồn tại.**
> 5. **Hai aggregate không được gộp**: Qwen-3 T-ORCH-AGG-1R (1235+4+9 = **1248** test) và Codex-6 Cycle 140 (1286+15 = **1301** test) là lệnh khác nhau trên hai trạng thái cây khác nhau. Cả hai đều được giữ, không cộng, không trung bình.
> 6. **Không làm**: không tick `[x]`, không nâng mức ACCEPTED, không sửa report của Reviewer/Tester/owner, không sửa source/test, không adjudicate Δ nào.

## Ledger của lane

- 1 — D-EVID-A7: đồng bộ §8.16 + §12.19 với receipt W-VAULT04-FIX1 (Cycle 140) và D-LINT-ORCH-1; xác minh T-DATA-LIVE-4 đã có sẵn; link/anchor check offline — Mục 1.
- 2 — D-EVID-A10: đồng bộ §8.16 + §12.19 với T-CODEX-TEST-1 và W-DATA02-PUB-2; đánh dấu 2 gate còn mở (DATA-02 public live, VAULT-01 binding) + Δ5; phát hiện lane khác sửa cùng 2 file; link/anchor check offline — Mục 2.
- 3 — D-EVID-A11: đồng bộ §8.16 + §12.19 với T-ANTIG-2 (full Connector offline) và T-CODEX-TEST-2 (Orchestrator aggregate + Contracts vault-ref); ghi nhận qualification Reviewer Turn 20 T20-V1 (MISMATCH, VAULT-01/03 + G-SEC HOLD) và T20-E1; sửa cải lỗi 2 điểm T20-E1 nêu; link/anchor check offline — Mục 3.
- 4 — D-EVID-A12: đồng bộ §8.16 + §12.19 với 4 receipt Codex-6 (W-VAULT06-LIFECYCLE-1, W-VAULT05-INTEG-1, W-VAULT04-CONF-1, W-SEC-SINK-1), 6 receipt Tester (T-CODEX-TEST-3..8) và Qwen-SEC (W-ADMBASE03-ERR-1 137/137); ghi nhận Reviewer Turn 30 — **T20-V1 + T20-S1 resolved** (gỡ HOLD của A11) và **đỏ mới** ADM-UX `prevCursor`; link/anchor check offline — Mục 4.

- 5 — D-EVID-A13: **packet 2 phần** — (1) đồng bộ `docs/06-public-api.md` với contract `GET /operations` đọc thẳng từ `services/orchestrator/src/server.ts` (envelope 5 field, 5 tham số allow-list, cursor `base64url(ISO|uuid[|p])`, lỗi 401/403/422); (2) đồng bộ §8.16 + §12.19 với **Reviewer Turn 40** (T40-A1 `prevCursor` resolved offline, release **NO-GO** cho G-DATA/G-SEC/G-ADMIN-OPS/G6) + receipt Qwen-Admin W-ADMUX02-SRV-1-FIX; ghi 3 MISMATCH docs còn mở (docs/20, traceability thiếu dòng, Δ14 renderer) và **repoint 25 anchor `review.md` bị trượt** do Turn 40 chèn ở đầu file; link/anchor check offline — Mục 5.
- 6 — D-DOCS-CONTRACT-SYNC-1: đồng bộ **docs/20-openapi-descriptions.md** (111→115) và **docs/19-traceability-audit-matrix.md** (275→279) với contract `GET /api/v1/operations`; phát hiện **MISMATCH thứ 3** chưa ai nêu: `packages/contracts/src/public-api.ts` khai schema lỗi thời, **không route nào dùng**, nhưng vẫn re-export qua `index.ts:18`; đo lại bản đồ anchor `review.md` (Turn 50 làm trượt **+36** lần thứ hai) và ghi 5 câu đã thành stale trong docs/28/35 A13; **không** đụng docs/28/35 theo yêu cầu giữ A13 của Turn 50 — Mục 6.
- 7 — D-EVID-A14: sửa **6 câu stale** trong §8.16 + §12.19 theo Turn 50 (sentinel T-CODEX-TEST-11 3 suite/23; Δ14 renderer đóng; migration 0017 2 index → Δ13 thu hẹp còn **Δ21**; DATA-03 server IMPLEMENTED; claim-shape + ADR-17; **+ câu thứ 6 do chính cycle trước làm cũ** về docs/20 + traceability); thêm 7 row/5 row có receipt; **repoint 42 anchor** `review.md` (lần thứ 2, +36); ghi rõ **23 = tổng 3 suite chứ không phải case của riêng sentinel**; link check `722/420 BROKEN=0` — Mục 7.
- 8 — D-EVID-A15: đồng bộ **docs/19:157, docs/20:34, docs/22:27** theo contract `@du/contracts` sau W-CONTRACT-ALIGN-1 (xoá MISMATCH, nêu symbol thật, `PageQuerySchema` ghi rõ là generic base) → **trả lời Δ36, nộp để Reviewer xác nhận**; khắc phục **T70-C2** bằng **13 `Test-Path`, 0 thiếu**; ghi **A14 snapshot = 6 câu / 722-420**, giữ bản cũ 5 / 713-411 làm lịch sử; bump **v1.24.0**; repoint **98 anchor** (`review.md` dài 602→763→784 **trong lúc đang làm**) và verify từng anchor theo nội dung; link check `761/428 BROKEN=0` — Mục 8.
- 9 — D-EVID-A16: thêm 3 receipt Tester (**T-CODEX-TEST-21** live PG+MinIO 5/5 ×2 · **-22** Playwright offline 82×3 + 158 axe cumulative 0 critical/0 serious, synthetic · **-23** live keyset 6/6, `Index Scan operations_created_id_idx`, walk 1.240 dòng), đều **tự đọc raw log**; **Δ23 superseded** (đã chạy live), **Δ21 vẫn mở** vì trang backward còn node `Sort` + quyết định index prefix cũ; **ADM-UX-07 vẫn mở** (-22 synthetic, không claim C4/C5); **DATA-02/04 + G-DATA vẫn mở** (-21 không gọi `/api/v1/uploads`); ghi 3 bẫy đếm số (5/5×2 trùng scope T-DATA-LIVE-4; 82 = 1 aggregate × 3 ≠ 246; 158 axe tích luỹ ≠ /lần; keyset 4/6+6/6+6/6 không cộng); bump **v1.25.0**, header `A5 → A16`; `review.md` **không đổi** (784) nên 98 anchor verify sạch; link check `775/434 BROKEN=0` — Mục 9.
- 10 — D-EVID-A17: (1) `tasks/README.md` blockquote đầu (L3) trỏ canonical sang **Turn 110** `review.md#L786`, 1186 → 725 ký tự, **13 blockquote cũ giữ làm historical**; sửa em dash mojibake trong packet; giữ con số 52 **có gắn nguồn** để không trở thành headline thứ hai; (2) `docs/28` 595→**609**, `docs/35` 748→**763**, **v1.26.0**, header `A5 → A17` — **Δ36 CLOSED + D-EVID-A15 ACCEPTED** (thu hẹp row A15), **Δ23 CLOSED** (thu hẹp row A16), **sửa framing A16**: backward `Sort` **được cho phép** (63 dòng/46 kB) chứ không phải lỗi, no-`Sort` prose là receipt-description error; **Δ21 vẫn mở** vì seed 1 tenant và query tenant-scoped vẫn chọn index cross-tenant ⇒ không có bằng chứng planner nhiều tenant; **52 rows** (48 cũ bỏ sót 4 COST); **COST-01..04** thành track thứ hai của G-ADMIN-OPS; `review.md` **ghi nối cuối** nên anchor không trượt, verify 98 anchor theo nội dung; link check `794/454 BROKEN=0` — Mục 10.
- 11 — D-EVID-A18: đồng bộ §8.16 + §12.19 với **sáu** receipt (packet nêu 5, thêm **T-CODEX-TEST-27** vì đó là receipt mới nhất, 10:56:11 +07); **sửa sai lệch packet↔log**: T-25 không đỏ vì "401 unknown-bearer contract" mà vì 2 × `EADDRINUSE` + 1 × `events` undefined + 3 × `tenantId` undefined — chữ ký của test còn ghim envelope `{tenantId, events}` đã bị W-ADMUX02-EXT-1 thay, **không adjudicate nguyên nhân**; T-26: 2/7 fail **che** mất `VAULT_POLICY_DENIED` và `TEMPORARY_UNAVAILABLE` ⇒ **unverified chứ không phải proven broken**; T-27 bẫy đếm số (lệnh gọi 3 file, Jest thấy 2 vì `admin-actions-dispatch-offline.test.ts` **không tồn tại** ⇒ 94/94 chỉ là conformance+pagination) và **không chạy lại `admin-audit.test.ts`** nên đỏ audit vẫn mở; Qwen-SEC §8 **0 production diff** + Δ29 (handler/router, không phải browser) ⇒ OIDC-04 `[ ]`; Qwen-Admin §12 mutation-lock hai chiều nhưng **ADM-UX-02 `[~]`** vì `label`/`last-used` không có cột; bump **v1.27.0**, header `A5 → A18`; 6 anchor mới verify theo nội dung; link check `814/466 BROKEN=0` — Mục 11.
- 12 — D-EVID-A19: ghi mục *Turn 118 closure traceability* vào `docs/19` (279→**322**, **append-only** vì `codex4.md` neo `#L32`+`#L239`; sàn 0 mismatch trên 279 dòng đầu) với **5 row** MM-05 / VAULT-01 / COST-01 / DATA-01 / OIDC-04, **28 `Test-Path` (0 thiếu)** và mọi symbol đọc thật từ file; phát hiện **anchor `#L239` của `codex4.md` trỏ dòng trống** (§9 thật ở L244) mà checker **cấu trúc không bắt**; thêm **T-CODEX-TEST-28** — Tester verify **độc lập** Vault 52/52 + MM-05 15/15, tức không phải lane tự verify bản vá của mình; log Qwen-SEC nằm ở `coordination/evidence/qwen-sec/` nên **139/146 tự đọc lại từ log thật** (7 skipped là `DU_LIVE_INFRA`, SKIP ≠ PASS); bẫy `it.each` (10→20, 10→14 — receipt đúng, heuristic của tôi sai) ghi vào docs; COST-01 **237+23=260** khớp, hai số là tree state tuần tự không phải mâu thuẫn; **không nói `BROKEN=0` toàn cục** — scope 7 file `839/490 BROKEN=0`, scope 178 file `BROKEN=2` (hai link mất một `../`, có sẵn, file lane Antigravity, **báo không sửa**); Δ2 (`docs/38`) + Δ32 (runbook thiếu cả 2 env var, đã kiểm) ghi ra vì ngoài scope — Mục 12.
- 13 — D-EVID-A20: đồng bộ `docs/19` + **`docs/28` §8.17** + **`docs/35` §12.20** với 5 closure Turn 123/125 (MM-10 76, COST-02 307, VAULT-05 45, SEC cookie đóng Δ27/33 36, DATA-04 27); append-only, bump 1.27.0→1.28.0 ở 2 file kho; prefix SHA-256 đúng byte; repoint 1 anchor lệch (`qwen-cost.md#L90`→`#L91`); `MINE_ANCHOR_FAILS=0`; link check S0/S1 **BROKEN=0**, S2 **BROKEN=2** pre-existing; 1/5 receipt có raw log (SEC 22 log, đọc lại 18 exit khớp 100%); ghi 2 phát hiện không đối soát được (76 vs 55; 560/553/561) — Mục 13.
- 14 — D-EVID-A21: ghi **Reviewer Turn 130** vao 3 file docs (T130-A1 la **MISMATCH con mo**, `Δ36`+`Δ23` giu CLOSED, 4 gate NO-GO) + **4 receipt Turn 130–133**. `docs/19` 363→**400** (append L364, **khong** bump — khong co truong version), `docs/28` **639→650** (`### 8.18` L640), `docs/35` **801→816** (`### 12.21` L802), ca hai bump **1.28.0 → 1.29.0** o L3. Append-only **chung minh bang byte** (prefix `docs/19` dung byte; `28`/`35` dung byte truoc+sau dong version, doi cung do dai 6 ky tu). Da doc source khong tin receipt: `runtime.ts` L242+L1445–1446 (Δ4 da sua, nhung claim-time co **chua quan sat duoc** qua `cancelOperation` → 410 terminal truoc), 3 file HCL (writer **data `create/update` + metadata `read/list`, khong data `read`**; reader chi `read`; worker/browser zero block), `usage-reconciliation.ts` 255 dong BigInt + `.strict()` 5 field, `operation-section-renderer.ts` L485 (dem chuoi 1/0). **2 so dem duoc lap lai doc lap**: `vault-policies` **39 + 5 bang (3,3,7,8,2) = 62** khop, `usage-reconciliation` **26** khop, `307+26=333` khop. **Gap 21 test lap lai y nguyen**: MM-10 receipt 86 = `9+10+11+56`, dem tay 6 file = `9+10+11+12+5+18` = **65**; cycle truoc 76 cung cho **35** o 3 file do → thung 21 **khong lon theo suite moi +10**. Mot **sai so dong thu 2** (`runtime.ts` 1480 vs receipt 1481, cung ho so voi 560/553/561 cua A20). `admin-operations-list-pagination.test.ts` **da bi sua 12:54:49 sau receipt 12:18** (83 `it(` + sort `it.each`) → so 78 giu nguyen la so cua receipt, khong trich so hien tai. **T130-A1 ghi OPEN**: route `server.ts` L1950 tra 5 field, test **da sua tren dia 12:54:57 nhung khong receipt/khong live**; them 2 nua con mo (thieu receipt; raw log danh 401 la **PASS** ma tom tat receipt nem vao loi) → chi Reviewer moi dong. **Khong ghi row trung**: `W-VAULT-CONNECTOR-ISOLATION-1` da co o §8.17 tu A20. **Khong ghi 6 packet chua receipt** (COST04, VAULT06, ADMUX02-SORT, DATA03, SEC-AUDIT-TAXONOMY, ADMIN-AUDIT-ALIGN). 13 anchor kiem theo noi dung → `MINE_ANCHOR_FAILS=0`. Link check `S0` 875/505/**BROKEN=0** · `S1` 918/547/**BROKEN=0** · `S2` 1418/558/**BROKEN=2** (2 cai pre-existing trong `antigravity-6.md` + `coordination/requests/antigravity.md`, khong phai cua ta — khong claim `BROKEN=0` toan cuc); delta `S1` +39/+26 **bang** dem tay. **Loi cua chinh toi**: da tao 1 link BROKEN (tro toi thu muc `](../infra/vault/policies)`), bat ngay va sua thanh 3 file HCL co ten. **Khong** sua source/test, **khong** chay test, **khong** DB/Redis/S3/Vault, **khong** tick task row, **khong** nang ACCEPTED, **khong** commit/push — Muc 14.
- 15 — D-EVID-A22: giai quyet **Reviewer T140-D1** tren **6** file docs (packet goi 3 ten file **khong ton tai**; mapping thiet la `06-public-api` + `19-traceability-audit-matrix` + `20-openapi-descriptions` + **`21-openapi.json`**). Them tham so `sort` 6 gia tri allowlist (`created_at`/`updated_at`/`deadline_at` x `asc`/`desc`, default `created_at:desc`, 422 `INVALID_SCHEMA`, sentinel NULL cho `deadline_at`) vao contract prose; them path `GET /api/v1/admin/audit` + envelope 5 truong vao `docs/20` §2 va `docs/21` (no do **khong ton tai** file audit-log-reference nao). Bo attribution so dong cu, chuyen sang symbol vi `server.ts` dang bi sua (3.086→3.101). **Khong** ghi phan cursor/sort nhu da chot: T140-A1 con OPEN va Reviewer noi docs sync **sau** quyet dinh cursor. Ghi `T-CODEX-TEST-29` (audit **11/11 live exit 0**, 2 suite do cung window) vao `docs/28` §8.19 + `docs/35` §12.22, bump **1.29.0 → 1.30.0**. **Khong** dong finding nao, **khong** nang gate nao.
- 16 — D-EVID-A23: dong **nua con lai cua T140-D1** ma A22 co y tu bao cao — **generator + gate contract map**. Do truoc khi sua bang cach chay generator cu vao file scratch (khong ghi de file that): generator cu sinh **41** path, artifact co **42**; route `/api/v1/operations` chi **2** param truoc khi co ca T140-D1 (thieu `state`/`tenant`/`id`), thieu schema 5 truong + 401/403/422; `/api/v1/admin/audit` **khong** sinh ra; `x-absent` van liet ke `audit` là absent. Mot lan chay tren may sach se **xoa 1 route + 4 param + envelope + 3 ma loi + khoi phuc 1 muc x-absent sai**. Sua: generator **suy ra tu `packages/contracts/src/public-api.ts`** (6 ten query, `SORT_FIELDS` × `SORT_DIRECTIONS` tai tao dung phep `flatMap` cua contract, default, token pattern, limit) + **2 chot chan** da **thu chung minh no ban** (contract them param thu 7 → `AssertionError`; regenerate mat path → `AssertionError`) + doc lai file vua ghi de verify. **Tái sinh byte-idempotent** (chay 2 lan, `fc /b` khong khac). Xuat LF → **CRLF** co chu dich de `gen`→`diff` sach. `contracts-v1.md`: doi **dung 1 dong** 43 + them **2 dong cuoi** ⇒ **khong so dong nao dich**; 7 bat bien (verdict READY, `Owner: Claude (platform lane)`, wire version, conventions, change policy, module map, change log) **deu khong doi**; them impact note theo chinh change policy cua file. **T140-A1 da cai trong wire** (`server.ts` 3.101 → **3.188** dong, cursor da gan sort, lech → 422) nhung **khong** co receipt `qwen-admin.md`, **khong** co Tester live ⇒ **IMPLEMENTED, chua VERIFIED** ⇒ **khong sua `docs/06`/`docs/20`** (dieu kien "once verified" chua thoa) va bao cao lai chu chu da lech. `validate_openapi.py` **do exit 1** (2 fixture `probe_cases.js` cu so voi `runtime.ts:32-36,212`) — **khong sua**, chung minh doc lap: probe khong bao gio doc spec, chay dung rieng van 21/2. Link check bang checker Python moi: **S0 807/493 BROKEN=0** · **S1 816/502 BROKEN=0** · **S2 1430/570 BROKEN=2** (dung 2 cai co san cua A22); checker **dau bao sai 114 loi** vi URL `file:///`, sua xong 112 target 0 thieu — **khong bao con so 114**. **Khong** sua code san pham, **khong** sua test, **khong** tick task row, **khong** nang ACCEPTED, **khong** commit/push — Muc 16.
- 17 — D-EVID-A24: dong bo **Turn 150–154** vao `docs/28` §8.20 (666→**684**), `docs/35` §12.23 (830→**844**), `docs/19` muc moi (430→**453**); bump **`1.30.0` → `1.31.0`** (cung do dai 6 ky tu). **Ba moc cua packet thuoc ba muc khac nhau va duoc ghi tach, khong gop:** T130-A1 **CLOSED** (Reviewer `review.md:873`+`:886`, pham vi **chi audit suite** — thay the "advanced, not adjudicated" cua A22) · T-CODEX-TEST-31 **7/7 live** co raw log + window, **thay** 6/7 cua T-30 cho suite nay (6/7 giu lam lich su) · 54 test sort-binding co that nhung **offline** (`IMPLEMENTED + VERIFIED-OFFLINE`, muc chu so huong tu ghi o Muc 15.8). **Khong cai nao la release gate; `ADM-UX-02` van `[~]` va bon gate van NO-GO.** Tu dem lai moi so tu source: **54** (6+6+5 bang sort + 7 `combos` + 14 `malformed` + 16 `it(`), **162** (54+19+83+6), **7/11/12** `it(` thuong — **tat ca khop**; va ghi **3 bay dem so** vao `docs/28` de lan sau khong tro lai, gom ca viec suite co **6** `describe` chu khong phai 5 nhu Muc 15.4 ghi. **Phat hien framing:** `30/30` la tong cua **ba receipt trong hai window**, khong phai mot lan chay 30 test (khong co lenh nao chay ca ba cung luc). **T140-A1 van OPEN** vi cross-sort 422 chi chay tren fake db va chung minh keyset live thuoc hinh thai token cu. **T140-D1**: khoang trong tai sinh da dong, finding chua — phan con lai dieu kien tren T140-A1 verified. **Khong sua 2 cau da thanh sai** (`docs/06:90-94`, `docs/admin-ops-monitoring-cost.md:21`) vi dieu kien cua Reviewer chua thoa. **Loi cua chinh toi:** `docs/28` **bi hong mot lan** — `replace(NL, CRLF)` tren noi dung da co `\r` sinh `\r\r\n` tren 683 dong, `difflib` lo ngay, khoi phuc backup va lam lai; **va checker S2 bao 262 lan dau — con do SAI** (khong bo qua URL ngoi + validate `#L` theo file tham chieu thay vi file dich), da sua, khong bao con so sai do. Link check **S0** 834/519/**BROKEN=0** · **S1** 843/528/**BROKEN=0** · **S2** 1551/641/**BROKEN=2** (hai cai co san cua A22/A23, lane Antigravity). Moi thu append + swap cung do dai ⇒ **khong so dong nao dich**, 18 anchor ngoai `fails=0`. **Khong** sua code san pham/test, **khong** chay test, **khong** DB window, **khong** tick task row, **khong** nang ACCEPTED, **khong** commit/push — Muc 17.
- 18 — D-EVID-A25: dong bo **hai finding MEDIUM cua Reviewer Turn 160** (da xuat ban tai `review.md:888-916`). **(1) Probe fixture:** `probe_cases.js` sua **dung 2 dong** (36 dong khong doi) — baseline that **exit 1, 21 PASS / 2 FAIL** → sau khi sua **exit 0, 23 PASS / 0 FAIL**, `OPENAPI-EXAMPLES-VALIDATED`; them `leaseEpoch` + `taskId` cho `ArtifactFinalizeRequestSchema` (vi `runtime.ts:212` la `LeaseBoundRequestSchema.extend`, `:90-92` chi co `leaseEpoch`) va `businessId` cho `ClaimTaskRequestSchema` (`:32-37`). **5 negative control tat ca RED**, trong do M2 (`taskId: "not-a-uuid"` → do) chung minh kiem tra uuid la that, nen 23/23 khong phai pass vo nghia. **Gia dinh cua toi ve uuid cua packet sai** — da kiem chung, no hop le voi zod 3.25.76, nen giu dung gia tri packet (Δ71). **(2) Grammar cursor:** lay tu **encoder that** `server.ts:2201` + docstring `:2206` + decoder `:2230-2265`, sua mau thuan tu noi trong file (grammar `<ISO>|<uuid>[|p]` cho mot slot sort) → `<ISO>|<uuid>|<field>:<direction>[|p]`. **Phat hien them ma Reviewer khong ne:** vi du `nextCursor` cua A23 decode ra `2026-09-26T00:00:0.000|<uuid>` — cat cut, `<uuid>` la placeholder, ISO sai ⇒ copy vi du se **nhan 422**. Sua bang cach them `mint_cursor()` theo cong thuc route thay vi go tay (bai hoc A23 ap lai); token moi 103 ky tu, duoi bound 128, va truong hop xau nhat 107 tu cong thuc **khop dung Muc 15.1** cua Qwen-Admin. **2 assert moi va ca hai da bun** (G1 round-trip, G2 bound 128); ca 5 assert cua A23 con nguyen. **Tai sinh byte-idempotent THAT:** 2 lan chay **ca hai exit 0**, sha bang nhau, 33.169 → 33.488 byte, 1.276 dong giu nguyen. **Diff: dung 2 chuoi, 1 path** — chi `/api/v1/operations`; tap path, thu tu path, thu tu 6 tham so, tap ma loi, `x-absent` deu giong. **Hai loi cua chinh toi, ca hai tu bat ngay:** (a) `regen2.py` in ra `BYTE-IDENTICAL: True` cho **hai lan chay ca hai exit 1** — so sanh sha cua artifact chua bao gio duoc ghi, da them dieu kien va no bat dung truong hop do; (b) khoi phuc artifact doc bang text mode lam CRLF → LF, sua lai bang cach tai sinh bang generator that. Link check **S0** 834/519/**BROKEN=0** · **S1** 843/528/**BROKEN=0** · **S2** 1551/641/**BROKEN=2** (hai cai co san, lane Antigravity). **Khong cai gi dong duoc T140-D1** — MEDIUM 3 co ba ve, toi lam mot; `docs/06`/`docs/19`/`docs/20`/`docs/admin-ops-monitoring-cost.md`/`tasks/README.md` **khong sua** vi Reviewer dieu kien tren *"T140-A1 verified"*. **VO quy tac "khong sua test" cua lane sau 17 cycle** va ghi ro Δ72 kem can cu (packet + Reviewer gan owner + fixture khong phai assertion). **Khong** sua code san pham, **khong** chay test san pham, **khong** DB window, **khong** tick task row, **khong** nang ACCEPTED, **khong** commit/push — Muc 18.
- 19 — D-EVID-A26: dong bo **hai objective** cua Turn 168. (1) **Con tro audit hien hanh**: `tasks/README.md:3` troi **Turn 110** → **Turn 160** (`review.md#L786` → `review.md#L888`), giu con so **52** va **tu dem lai ca 5 canh tu source** (14 + 16 + 8 + 10 + 4, khop `review.md:909`; P0–P8 = 57/3/11 = 71 voi 71 ID khac nhau, 0 trung, 0 dong bo qua). **Chi 1 dong doi**, 100 dong con lai byte-identical, 101 CRLF/0 bare LF truoc va sau. **Bay dem so**: dong task la **o trong bang** (regex muc list tra 0 dong o ca 9 file), va `[x]` trong cot ghi chu lam dem thua. (2) **COST-01..05 offline 100% + tat `qwen_cost`** vao `docs/28` muc **8.21** (684→**699**) va `docs/35` muc **12.24** (844→**860**); bump **1.31.0 → 1.32.0**. **122** chung minh tu source (23+24+26+30 = 103 trong contracts + 19 trong orchestrator, **khong suite nao dung `it.each`** nen dem lit la chinh xac), khong chep tu chuoi ly do cua roster. Hai so cheo khop doc lap: **17** file test contracts = 17 suite lane bao; `usage.ts` **460** dong / **20.960** B = phép do cua lane. **BAY DEM SO 2**: glob `*usage*` ra **131** (them `usage-summary.test.ts`, 9 test W39-C, tu skip sau `DU_LIVE_INFRA`, Δ-D30). **BAY DEM SO 3**: orchestrator 85 (run cua lane) vs **86** file test hien nay la **hai trang thai cay**, vi suite 54 test cycle 17 den sau — **khong cong**. **Viec tat chi co o `coordinator-state.json`** (`15:06:23+07:00`); **chu Turn 167 trong packet khong co muc markdown nao** — ledger dung o Turn 166 (dong 2264) — **bao cao, khong sua**. **COST-05 khong phai dong release thu 5** (bang spec co 4 COST), nen 52 khong rut xuong. **Trich dan `review.md:905`**: claim *100% offline backlog* la *packet-capacity statement, not acceptance* — nen ghi mot lan tat agent ma khong gate nao nhung. **Ba loi cua chinh toi, ca ba deu bat truoc khi toi dung artifact**: (a) verifier `docs/28` so sanh voi danh sach da bi sua truoc nen opcode version khong hien, `assert` no **sau khi file da ghi** — file dung, verifier sai, kiem lai bang cach dung lai ban goc va doi chieu **223.853 B / 683 CRLF trung het**; (b) ca hai script sinh fragment chet luc parse vi escape nhay bi gom, sua bang `Q = chr(34)`, khong gi duoc ghi; (c) ca 6 dong `docs/35` viet 4 o cho header 3 cot, checker bat truoc khi dung, sua bang pass gop trong generator. Link check **S0** 859/542/**BROKEN=0** ƃ **S1** 868/551/**BROKEN=0** ƃ **A26 (moi)** 850/500/**BROKEN=0** ƃ **S2** 1577/665/**BROKEN=2**; **S0/S1 khong chua `tasks/README.md`** nen them pham vi A26. **Khong** sua code san pham/test, **khong** chay test, **khong** DB window, **khong** tick task row, **khong** nang ACCEPTED, **khong** commit/push — Muc 19.
- 20 — D-EVID-A27: dong bo **hai objective** cua Turn 180. (1) **Con tro audit hien hanh**: `tasks/README.md:3` troi **Turn 160** → **Turn 180** (`review.md#L948`; Turn 180 phu de Turn 170), 1372 → **1820** ky tu, 52 dong re-derive lai ca 5 canh, ghi T140-A1 live acceptance OPEN + 4 finding moi; chi 1 dong doi, 100 dong con lai byte-identical. (2) **3 vi tri prose stale** cua Reviewer — `docs/06-public-api.md:80,90-94` (165→**168**), `docs/20-openapi-descriptions.md:38,42` (128→**129**), `docs/admin-ops-monitoring-cost.md:21` (81, chi 1 dong) → doi **cursor 2-slot** + **MISMATCH T140-A1 OPEN** + "không có cursor/filter/sort server-side" bang **cursor 4-slot / 6 sort / 422 INVALID_SCHEMA khi lech sort**, doc thang tu `server.ts` + `public-api.ts`; **lich su giu nguyen trong ca 2 block MISMATCH**. (3) `docs/28` **8.22** (699→**711**) + `docs/35` **12.25** (860→**872**), bump `1.32.0→1.33.0`. (4) Link check **S0 881/564, S1 890/573, A27 (moi) 872/521, BROKEN=0**; S2 1600/671 BROKEN=2 (ton tai, khong phai cua lane nay). (5) Loi cua toi: **8 assert fail truoc khi ghi + 2 script chet luc parse + 2 loi noi dung that bat boi chinh guard cua toi + 1 verifier bug sau khi ghi** — xem 20.9/20.10.
- 21 — D-EVID-A28: sua **hai finding LOW** cua Reviewer Turn 190 (`review.md:977`). (1) **T190-E1**: dang sai `$$n::timestamptz, $$n::uuid` o **4** cho (docs/06:95, docs/20:42, qwen-docs:16, qwen-docs:2162) → `($N::timestamptz, $M::uuid)`; dem lai toan cay: **11** lan `$$n`, trong do **4** lan trong `review.md` la Reviewer trich dan nen khong sua. **Packet yeu cau doi thanh `\::timestamptz` — KHONG phai dang Postgres hop le, TOI KHONG LAM THEO**, doc `server.ts:2593` va `:2547`. (2) **T190-E2**: marker `—` con lai trong 2 tieu de moi (2 dong tieu de append truc tiep, khong qua `mk()`) → em-dash, byte delta 0. (3) Con tro `tasks/README.md:3` **Turn 180 → Turn 190** (`#L948` → `#L977`, kiem ca duoi tien la heading), 1820 → **1805** ky tu, chi 1 dong doi, 100 dong con lai byte-identical. (4) **Mo rong S0/S1** bang `tasks/README.md` + `docs/admin-ops-monitoring-cost.md` theo dung y cua Reviewer — het scope A2x. (5) **Tu sua regression cycle 19**: anchor `qwen-docs.md#L1660` tro vao **dong tach bang** thay vi Muc 16 (o 1642), lech 18 dong va link check khong bat — tro ve heading that. (6) **KHONG chen RESUME POINT o dau** de khong lam vong `coordinator-antigravity.md:136` (`#L120-L184`) trong report lane khac; chi ledger 21 + Muc 21 o cuoi. Loi cua toi xem 21.9.
- 22 — W-DOCS-SYNC-1 / D-EVID-A29 **post-landing audit** (dispatch ctx_73b2ce7c245d): A29 da landed via workflow agent cua coordinator (`coordinator-claude.md` Turn 215) ma **khong co receipt** — Muc 22 nay ghi tre va audit toan bo acceptance cua packet theo code + anchor tren dia (`submission.ts:113-122` do tung dong khop enum `errors.ts:41` docs/06:126/164 docs/28:705+8.23 docs/35:866 README#L1018 anchors 993/994/1045/963-966). **Sua 4 lop defect cua A29:** (1) **10** orphan two-backtick runs (lop `$$n`/`@E@` — chu ky template-escape thu ba lien tiep) → em-dash, docs/28 5 dong 713/715/716/718/723 (+10B, sha `a4d8cd3e0a0d1ba9`→`b7d9ffe0a2b2008e`); (2) docs/35 sua noi dung khong bump → **1.33.0→1.34.0** (0B); (3) tasks/README:3 "was **accepted** and repaired" → "was repaired ... Reviewer cross-check pending" (+38B, 1 dong); (4) chen ledger → repoint `qwen-docs.md#L1643→#L1644` trong docs/28:678 va docs/35:839 (assert theo noi dung heading Muc 16). **Phat hien khong-sua:** docs/28 bi A29 dao EOL **CRLF→LF full-file** (Δ-A30-2, khong revert). **Instrument:** tai-dung checker theo spec `qwen-docs:2291/2296` + rule chat §8.23 (chi bun khi link-text chua finding ID) + **3 nang cap**: code-span-aware gate (phan biet LA-loi voi ke-lai-loi — run `$$n` mo ta o :718 khong bi dem), **orphan-run gate**, exit 0 = BROKEN+MISMATCH+GATE=0. Baseline 11→10 hits (v1 so voi v2, deu truoc ghi); sau repair S0 927/571/0/0/0; S1 va TREE chay cuoi xem 22.5. **Loi cua chinh toi:** dem tay 9 vs tool 10; gate v1 gop ke-lai-loi; 1 batch abort vi probe shell exit 1 — xem 22.9. Khong mo window live, khong tick task row, khong nang muc, **KHONG ACCEPTED**, 4 gate NO-GO, 52 dong khong doi, khong commit/push — Muc 22.
- 23 — W-DOCS-REV-0019 (dispatch ctx_0132e53d9b05): khóa finding **REV-ORCH-0019-01** (MEDIUM blocking, Turn 201) — prose docs/06:74 + docs/20:39 từ "sentinel đã bind / bound sentinel" thành **inline literal Const** đúng hình `COALESCE(col, '<ISO>'::timestamptz)` của `bindOperationsListSortKey` (docstring nó rõ: 4 index biểu thức 0019 chỉ match đúng Const, bản `$n` Seq Scan + Sort, index chết — T-35/W-INGEST-0019-2); ghi đúng câu chữ Reviewer yêu cầu. **REV-0019-03** làm qua **generator** (không sửa tay JSON): gen_openapi.py +5 dòng, regen ×2 rc=0 đồng sha `3bc395fb4fb5fa0f` (33.488→33.790B), validate rc=0, cấu trúc diff = lệch đúng một `description`. **REV-0019-02** (anchor số dòng cũ trong header migration 0019) **report-only**, owner Platform (đã có từ Δ30 của qwen-platform Mục 13). Guard: occurrence==1, đúng dòng đổi [74]/[39]/[181-186], CRLF nguyên vẹn. Ledger chen → repoint #L1644→#L1645 (docs/28:678, docs/35:839) lần thứ hai liên tiếp — đề xuất chống thuế ở Δ-A31-3. Checker mở rộng ID cho loại finding REV-mới-của-Reviewer, 0 FP trước khi ghi; số cuối 23.3. Lỗi lane: 1 bản apply đầu chết đuổi escape (hủy trước ghi), 1 old_string checker sai (từ chối trước ghi) — cả hai trước ghi. Lane không tick, không commit; [x] ORCH-OPS-0019 là quyết định coordinator theo verdict review.md:1112 — Muc 23.
- 24 — W-DOCS-ENC-SYNC (dispatch ctx_e218e79e0c2d, task_4837df386fe6): đồng bộ ADR-18 encryption baseline vào 4 file docs (04-data-state, 06-public-api, 07-internal-api, 11-admin-ux). Không có code encryption nào tồn tại trong src/contracts — mọi section ghi rõ "CHƯA triển khai / ENC-00 [~] / G-ENC mở". Ghi chú: packet nói "Vault key allowlisting" nhưng ADR-18 không dùng thuật ngữ đó — ghi đúng ADR-18 (Vault Transit wrap DEK, deployment-level config), flag Δ-A32-1. Link check S0 BROKEN=0, S1 BROKEN=0, TREE BROKEN=2 (pre-existing Antigravity). Không sửa code/test, không tick task, không commit/push — Muc 24.
- 25 — ENC-04 dispatch (task_3601efe1cf77, ctx_7ef641aba1d4, Antigravity): **TỪ CHỐI, TRẢ VỀ COORDINATOR.** Lý do kép: (1) sai lane — Qwen-Docs là docs/evidence lane, không code, không test, không implement production crypto; (2) ENC-00 chưa freeze (4 quyết định mở), task plan ghi rõ "Không dispatch crypto wire implementation khi chưa freeze"; ENC-01 (contracts/envelope schema) cũng chưa triển khai → ENC-04 thiếu dependency. Không implement, không sửa file nào ngoài receipt. Không commit/push — Muc 25.
- 26 — D-EVID-A21 (task_681610f81431, ctx_c3c51b5ce088): đồng bộ 6 packet encryption (ENC-01/02/03/06/07 + ENC-META-01) vào docs/28 §8.24 + docs/35 §12.26, bump 1.34.0→1.35.0 (byte delta 0). **Số đọc từ receipt gốc, KHÔNG chép plan**: ENC-01 **38/38 + 18 suites/423** (plan ghi 46/46 + 20/412 — Δ-A33-1), ENC-02 9/9 (+collateral 149), ENC-03 10/10, ENC-06 8/8, ENC-07 22/22, ENC-META-01 23/23; tsc 0 cả sáu; HEAD chung 7811298. **3 anchor trượt** (qwen-platform L1555/1668→L1556/1669, qwen-admin L2760→L2777) + **1 inbound repoint lệch 2 dòng** (qwen-docs L1646→L1648) — tất cả bắt bằng content assertion, `MINE_ANCHOR_FAILS=0/16` cuối cùng. **Bốn lỗi của chính tôi:** (1) append CRLF vào docs/28 (file LF thuần) → 3 CRLF lẫn, tự phát hiện qua census, sửa về 0; (2) tin số của plan suýt chép vào inventory; (3) **sáu link trong receipt dùng `../coordination/reports/tester.md` trong khi file report nằm trong chính thư mục đó → BROKEN=7/9 exit 1 — phạm lại nguyên lỗi Mục 7 đã ghi từ 17 cycle trước**, sửa thành `tester.md` và giữ nguyên dòng lịch sử 754 byte-identical; (4) cả 3 lỗi ghi đều lộ ra **sau khi** đã ghi xuống đĩa, đúng thứ Mục 7 dặn phải kiểm trước khi ghi. Δ-A33-1 (plan lệch số), Δ-A33-2 (ENC-03/ENC-06 **không có owner receipt trên file**), Δ-A33-3 (anchor nên trỏ tên heading). Link check S0 949/589 BROKEN=0 MISMATCH=0 GATE=0, S1 965/604 BROKEN=0, TREE BROKEN=2 (pre-existing). **Cả 6 VERIFIED-OFFLINE, KHÔNG cái nào ACCEPTED**; G-ENC NO-GO, ENC-00 vẫn [~], 5 task ENC còn lại [ ]; không tick row, không commit — Muc 26.
- 27 — D-EVID-A22 (task_29082f28e469, ctx_2df82a8020aa): ENC-08 Admin crypto config (owner Muc 23 35/35 x3 + independent T-CODEX-OFFLINE-ENC-08-INDEPENDENT 35/35 tsc 0, HEAD 7811298) ghi vao docs/28 8.25 + docs/35 12.27, bump 1.35.0 -> 1.36.0 (byte delta 0). **Khong tick**: task row giu [ ] vi acceptance la browser E2E chua co, va owner viet thang ENC-08 khong the ACCEPTED cho toi khi route that ton tai (D97); them D98 store chua co bang, D99 chua noi ENC-07. Packet chi 8.24/12.26 nhung ca hai muc da bi cycle 26 chiem (D-A34-1). Link check x3 ExitCode 0: S0 951/591 BROKEN=0 MISMATCH=0 GATE=0, S1 978/617 BROKEN=0, TREE BROKEN=2 (pre-existing); MINE_ANCHOR_FAILS=0/2 va verify muc 16 sau repoint (qwen-docs.md#L1649 dung tro heading). **Loi cua toi: 2 link trong fragment docs/28 thieu tien to ../coordination/reports/ -> BROKEN=2/4 exit 1, sua xanh; lan thu hai trong ba cycle lien tiep (Muc 26 gap 7 link), Muc 7 da ghi lop nay tu 17 cycle truoc.** G-ENC NO-GO, G6 NO-GO, ENC-00 van [~], khong tick row, khong commit — Muc 27.
- 28 — D-EVID-A23 (task_f208b8940569, ctx_504fad240671): ADM-UX-03 79/79 + ADM-UX-04 142/142 (ca hai independent receipt cua Codex Tester Offline, tsc exit 0, HEAD 7811298) ghi vao docs/28 8.26 + docs/35 12.28, bump 1.36.0 -> 1.37.0 (byte delta 0). **Khong tick row nao**: ca hai giu [~], ca hai tro ve cung mot noi - ADM-UX-07; ADM-UX-03 con browser C1-C5 + live data, ADM-UX-04 con aggregate connector-health endpoint that + browser E2E. 79 + 142 = 221 KHONG phai mot aggregate (hai suite hai packet khac). Fragment viet duong dan day du tu dau + apply script resolve ngay tung link moi -> 0 link BROKEN ngay tu dong (Muc 26 gap 7 link, Muc 27 gap 2 link, Muc 28 khong lap lai). Khong loi ghi artifact trong cycle nay. G-ADMIN-OPS NO-GO, G6 NO-GO, 52 dong khong doi, khong tick row, khong commit — Muc 28.
- 29 — D-EVID-A24 (task_251d834a32c1, ctx_e18b990733e8): ENC-08 wiring (owner Muc 24 56/56 x3 + independent T-CODEX-OFFLINE-ENC-08-WIRING-INDEPENDENT 56/56 tsc 0, HEAD 7811298) ghi vao docs/28 8.27 + docs/35 12.29, bump 1.37.0 -> 1.38.0 (byte delta 0). **D97 DONG o muc code + offline** (route that GET/POST /api/v1/admin/crypto-config + shell pane that); **D98 van mo** (store in-memory, mat khi restart) va **D99 van mo** (bat toggle chua doi hanh vi giao that) nen task row ENC-08 giu [~], khong tick. Ghi lai lo hong chinh owner: route lay role tu header x-admin-role ma caller tu set, sua sang claims cookie da verify (D104), test khoa bang chung cu the. **Khong conflation:** 8.25 la 35/35 core config, cycle nay la 21 test wiring rieng - 56 khong phai 35+21 cong lai mot lan. Lien tiep 4 cycle khong con link hong ghi xuong dia (Muc 26 gap 7, Muc 27 gap 2, Muc 28 gap 0, Muc 29 gap 0) - resolve + content-assert chay trong chinh apply script truoc khi ghi. G-ENC NO-GO, G6 NO-GO, 52 dong khong doi, khong tick row, khong commit — Muc 29.
- 30 — D-EVID-A25 (task_3e5c1c4df2ee): ENC-05 upload gateway + ENC-04 worker seam ghi vao docs/28 8.28 + docs/35 12.30, bump 1.38.0 -> 1.39.0 (byte delta 0). **SO TRONG PACKET KHONG DUNG RECEIPT NAO:** packet gan 41/41 + tsc clean cho ID T-CODEX-OFFLINE-ENC-05-INDEPENDENT, nhung receipt mang ten do (tester.md:8084) ghi **8/8 va tsc FAIL**; 41/41 + tsc clean nam o receipt KHAC (tester.md:8102). Ba receipt ENC-05 luc doc (8048 / 8084 / 8102), khong phai mot. ENC-04 14/14 tai tester.md:8120, file suite that la crypto-seam.test.ts (khong phai crypto-storage-seam.test.ts nhu packet goi). Khong cong so: 41 + 14 = 55 hai package khac nhau. G-ENC NO-GO, G6 NO-GO, khong tick row, khong commit — Muc 30.
- 31 — D-EVID-A25 tiep tuc: nap receipt thu 4 T-CODEX-OFFLINE-ENC-05-REVAL (tester.md#L8157, 03:43:36) vao 8.28 + 12.30, bump 1.39.0 -> 1.40.0 (byte delta 0). Tsc cua ENC-05 chay 4 buoc, chi buoc cuoi xanh (03:23 FAIL TS2367, 03:35 FAIL TS7006, 03:37 PASS, 03:43 PASS) - hai lan FAIL deu do legacy-payload-migration.ts cua lane khac, ngoai pham vi ENC-05. **Van khong ton tai receipt independent 41/41.** Cap nhat section tai cho, head byte-identical; MINE_ANCHOR_FAILS=0/6. **Loi cua toi: 1 tail-EOL LF lap trong section 12.30 cua toi (sua CRLF; 18 bare LF con lai thuoc 12.26 cua cycle 26, bao cao khong sua) + 1 typo 41/65 lan hai trong fragment (bat bang grep truoc khi ghi) + ledger 29 bi ghi trung 2 lan o Muc 29 (da dedup, giu ban day du hon) + ledger 30 vua mat trong turn truoc.** 6 cycle lien tiep khong con link hong ghi xuong dia. G-ENC NO-GO, G6 NO-GO, khong tick row, khong commit — Muc 31.
- 32 — D-EVID-A26 (task_b3b366795994, ctx_9c35c2d0213d): ENC-08 composition/persistence/wire + ENC-09 ghi vao docs/28 8.29 + docs/35 12.31, bump 1.40.0 -> 1.41.0 (byte delta 0). **SAI LECH CUA PACKET (2):** (1) ten file docs/28-encryption-lifecycle.md va docs/35-operational-runbooks.md **khong ton tai** - ghi vao file that 28-test-inventory + 35-acceptance-baseline (runbooks la docs/17, so 17 chu khong phai 35), D-A36-1; (2) **so 87/87 khong ton tai o bat ky receipt nao** - independent thuc su cho ENC-08 wire la **71/71** (tester.md#L8228), D-A36-2. 77/77 (persistence) va 79/79 (wire) co that nhung la receipt verify/owner chu khong phai independent, D-A36-3. **77, 79, 71 la BA tap suite khac nhau khong phai chuoi tien** (79 = 77 + 2 case store-selection; 71 thay migrations-ledger-guard bang enc08-wire-enc07), D-A36-4. ENC-09 9/9 + tsc 0 khop packet (tester.md#L8193). D98/D106 lay trang thai nhung migration 0020 chua apply that, chua co restart PG that nao chay. MINE_ANCHOR_FAILS=0/5. Loi cua toi: 1 ky tu thieu trong chinh guard (docs/35 phai chay lai), 1 loi decode string, 1 thieu errors= khi tester.md co byte non-UTF8. 7 cycle lien tiep khong con link hong ghi xuong dia. G-ENC NO-GO, G6 NO-GO, ENC-08/ENC-09 van [ ], khong tick, khong commit — Muc 32.
- 33 — D-EVID-A27 (task_64d94a6d64d0, ctx_c7ae091a36c5): RESULT-WIRE-01 contract 200 da freeze (tester.md#L8245: contracts 19 suites/427 0, delivery-encryption 22/22 0, tsc 0 ca hai package) — **docs/06 con ghi 302 da sua**: catalog download 302 short-lived signed URL — 200 raw bytes (plain) / 200 JSON wrapper (encrypted); /result chot 200 strict v1 o ca hai mode; them muc 'Frozen result/download response contract'; ghi vao docs/28 8.30 + docs/35 12.32, bump 1.41.0 -> 1.42.0 (byte delta 0; docs/06 khong co header version). **Ten file packet lai sai** (28-encryption-lifecycle, 35-operational-runbooks khong ton tai) D-A36-1 lan hai. **CHUA CO INDEPENDENT RECEIPT** (D-A37-3): lan verify doc lap co chay 64/64 nhung khong append duoc vao tester.md (byte 0x97 non-UTF8), V-OFFLINE-RESULT-WIRE-01-REVAL re-dispatch nhung van khong co trong cay. **BAI TOAN CON SOT TU CYCLE 24 DONG O DAY** (D-A37-4): docs/06/07/11 con section trung lap, da xoa ban thu hai (06 199->195, 07 103->94, 11 63->49). EOL: 11 bare LF lot vao docs/06 khi ghi, bat bang script kiem EOL ngay sau, chuan hoa ve 195 crlf / 0 bare LF content byte-identical. G-ENC NO-GO, G6 NO-GO, RESULT-WIRE-01 van [~], khong tick, khong commit — Muc 33.
- 34 — D-EVID-A28 (task_3746a80a486f, ctx_2514fde5600c): LOG-01 (tester.md#L8265: observability 23/23 + admin-error-boundary 21/21 + tsc 0, khong claim live deployment) + INGEST-WIRE-01 (qwen-platform.md#L2016 Muc 21: document-core full 45 suites/537 Exit 0, targeted 88, tsc 0) ghi vao docs/19 muc moi + docs/28 8.31 + docs/35 12.33. **Ten file packet lai sai** (28-encryption-lifecycle, 35-operational-runbooks khong ton tai) D-A36-1 lan ba. **Con so '2 mutation tests pass' doc dung la 2 probe DO** (M1 hasBuffer->2 do, M2 bo artifacts->1 do) chung minh range bi pin that, restore byte-exact 8b43ce2c - neu doc nham la 2 test xanh se mat y nghia cua mutation. 4 delta chua phat sinh: D48 connector fetch chua chung minh, D49 live multi-container chua co, D50 3 file test traceability da sua (can Reviewer), D51 hasBuffer con trong COMMENT ingest/index.ts:206. Version bump 1.42.0->1.43.0 (28+35, byte delta 0); docs/19 khong co header version (dung convention cua chinh no). G-ENC NO-GO, G6 NO-GO, LOG-01/INGEST-WIRE-01 van [~], khong tick, khong commit — Muc 34.
- 35 — D-EVID-A29 (task_2fc38f7a9a87, ctx_02c4d6aeece5): DATA-01/02/03 vao docs/04 + docs/19 + docs/28 8.32 + docs/35 12.34. **Ten file packet DUNG** (khac cycle 32/33/34). Bang chung doc truc tiep: DATA-01 [tester.md#L8350] 3 suites 35/35 + tsc 0 **independent**; DATA-02 [tester.md#L8367] 4 suites 99/99 + tsc 0 **independent**; DATA-03 [qwen-platform.md#L2100 Muc 22] document-core full 46 suites 542/542 + targeted 5/5 x3 + worker-sdk 84/84 + tsc 0. DATA-03 sua gap that: prepareSources chi kiem pin khi co artifact, task URL chua READY co 0 artifact thi pin khong kiem va van parse inline text bao thanh cong; test viet truoc chay DO tren code cu. 2 mutation probe la probe DO (M1 2 do, M2 1 do), restore byte-exact f05634ea - ghi ro o ca 4 file. D52 fix la TIGHTENING/breaking cho task inline text, can coordinator biet truoc production; D53 chua co live multi-container (DATA-INT-01). Khong cong so: 35+99+542 la hai package, ba tap suite; 35+99=134 khong phai mot con so. Version bump 1.43.0->1.44.0 (28+35, byte delta 0); docs/04 va docs/19 khong co header version (dung convention cua chinh ho). G-DATA NO-GO, G6 NO-GO, ca ba van [~], khong tick, khong commit — Muc 35.
- 36 — D-EVID-A30 (task_c5ddb47d7b16, ctx_bdbade44a0e6): DATA-02/04/05 vao docs/04 + docs/19 + docs/28 8.33 + docs/35 12.35. **SUA LOI ATTRIBUTION CUA CHINH TOI (D-A38-1):** cycle 35 gan independent cho DATA-02 tro toi tester.md#L8367, nhung 8367 la receipt IMPLEMENTATION; receipt independent la T-CODEX-OFFLINE-DATA-02-INDEPENDENT (L8385, 04:54:34). So 99/99 dung o ca hai - sai o attribution khong sai o so. Da sua 4 file. Day la lan thu hai trong ba cycle gan independent cho receipt khong doc lap (cycle 32 gap voi ENC-08 77/79); quy tac chot: chi gan independent khi receipt TU NOI minh la independent va co HEAD. DATA-02 [L8385] 4 suites 99/99 + tsc 0 INDEPENDENT. DATA-04 [L8419] worker-sdk 18 suites 311 + document-core 46 suites 542 (REDIS_SMOKE=0) + 3 lenh lint/typecheck 0 - **KHONG CO INDEPENDENT RECEIPT**, muc do thap hon; live object storage/Redis/finalize race khong exercise. DATA-05 [L8438] 2 suites 20/20 (7+13) + tsc 0 INDEPENDENT; khong co live migration/backup/restore. Khong cong so: 99+311+542+20 la hai package, bon tap suite; 20 khong cong vao 99. Version bump 1.44.0->1.45.0 (28+35). G-DATA NO-GO, G6 NO-GO, ca ba van [~], khong tick, khong commit — Muc 36.
- 37 — D-EVID-A31 (task_4993dee19c6a): DATA-04 NANG CAP tu implementation-only len INDEPENDENT [tester.md#L8438] (05:09:55: worker-sdk 18 suites 311 + document-core 46 suites 542 + 3 lenh lint/typecheck 0) va ENC-08 CSRF renderer Dong D112 [qwen-admin.md#L3280] Muc 27 (47/47 + 4 suite ENC 79/79 x3 + tsc 0) ghi vao docs/04 + docs/19 + docs/28 8.34 + docs/35 12.36, bump 1.45.0->1.46.0. **DATA-04 la CHAY LAI DOC LAP cua cung bo lenh, khong phai them so test; KHONG cong hai receipt vao aggregate.** **D-A38-2:** receipt independent cua DATA-04 **khong co dong HEAD** (khac moi receipt independent khac trong cung file) — van tu khai independent nen chap nhan, nhung quy tac 'chi gan independent khi receipt tu noi VA co HEAD' chi dat MOT PHAN, ghi ro de khong dua thanh chuan tuy yet. **D-A38-3: ANCHOR CUA CHINH TOI DA TRUNG, DA SUA 4 file** — tro DATA-05 independent toi tester.md#L8438 trong khi lane khac append them receipt lam dong do day xuong L8461; van trong range nen BROKEN=0 khong bat duoc, chi content assertion moi thay. Bang chung thu hai cho duyet D-A31-3 (tro ten heading chu khong so dong). ENC-08: token CSRF la binding khong phai credential, gate POST la rao duy nhat truoc khi ghi (sai/thieu = 403, applier khong chay), save POST-redirect-GET; D112 DONG o code + offline, D110 (webhook dispatcher) va D113 (noi verifySessionCsrf voi OIDC session store) van mo. Delta lane khac ghi lai: D115 (Muc 26 viet assertion coi token la secret = sai theo thiet ke, da sua, thay doi Y NGHIA test), D116 (nhanh read-only la guard phong thu), D117 (full sweep 5 do, 2 do moi khong phai cua lane do, khong suite crypto nao trong danh sach do). G-DATA NO-GO, G-ENC NO-GO, G6 NO-GO, DATA-04 + ENC-08 van [~], khong tick, khong commit — Muc 37.
- 38 — ARCH-DOC-01 (task_fd229da69ae7): duong du lieu da hien thuc vao docs/02-architecture.md + TAO MOI docs/09-system-architecture.md (6 muc: submit/artifact durable, ingest, ranh gioi luu tru, duong ma hoa, response wire da freeze, bang target/current/verified). **HAI TEN FILE TRONG PACKET KHONG TON TAI** (D-A39-1): 02-architecture-overview.md thay vi 02-architecture.md; 09-system-architecture.md khong co, so 09 da thuoc 09-queue-sdk.md - backlog ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:9 cung ghi sai, nguon packet can sua (ngoai docs/**). Bon chu de packet deu co nguon doc truc tiep. **Moi dong verified deu ghi ro OFFLINE** - khong live S3/PG/Redis/Vault/browser. **AnchOR DRIFT 8 cho, da repoint:** qwen-platform Muc 21/22 dich 2017->2018, 2100->2101 (Muc 23 moi chen giua luc toi viet); BROKEN=0 khong thay loai nay vi van trong range. **Bang chung Muc 23 vua land duoc phan anh:** claimTask tu choi PENDING_INGESTION bang STATE_CONFLICT truoc khi cap lease - cuong co lap luan routing khong phai boundary; khong sua source. VERIFY: link check x3 exit 0, S0 1004/644 BROKEN=0 MISMATCH=0 GATE=0, S1 1081/720 BROKEN=0, TREE 190 file / 1750 target / 845 anchor / BROKEN=2 (2 pre-existing); file moi DA nam trong TREE walk; content assertion 49/49 anchor. Loi cua toi: 1 script kiem tra bao 10 FAIL gia (ky vong 'ENC-02' trong khi heading that la 'ENC02' khong dau gach - loi ky vong khong phai loi anchor); 3 SyntaxError (chr(0394), chr(1B0), backtick tho) deu fail truoc khi ghi; 1 lan suyt chay lai fix3 da duoc vuot qua (se chen trung) - da kiem trang thai file truoc nen khong chay lai; 2 typo do toi sinh (Worker gui thieu dau sac, 'Muc 23' thieu dau) da sua. G-DATA/G-ENC/G6 NO-GO, khong tick, khong commit — Muc 38.
- 39 — D-EVID-A32 (task_55387f221cf2, ctx_fd4024878e5f): LOG-02 (tester.md#L8563, 36/36 observability + 3/3 orchestrator, independent), COST-01 (tester.md#L8526, 19 suites/428, independent), COST-02 (owner tester.md#L8509 432 + independent tester.md#L8584 435 - HAI LAN CHAY CUA CUNG MOT SUITE, KHONG PHAI 432+435), ENC-08-CSRF-OIDC (qwen-admin.md#L3366, Muc 28, 6 test, verifySessionCsrf primitive that, DONG D113), DATA-03-ORCH-VERIFY (qwen-platform.md#L2185, Muc 23, claimTask chan PENDING_INGESTION truoc khi cap lease), ARCH-DOC-01 (qwen-docs Muc 38) ghi vao docs/28 8.37 + docs/35 12.37, bump 1.46.0->1.47.0. **PACKET CHI DINH tools/docs-link-linter.py - SCRIPT KHONG TON TAI** (du-rework/tools chi co openapi/ + verify-test-counts.ps1) D-A40-1; link validation chay bang checker cua lane. ENC-08-CSRF-OIDC ghi 'verify receipt' KHONG ghi 'independent' - ap dung nguyen tac cycle 36/37. **CAY CHUYEN DONG MANH:** lane COST append COST-03 vao docs/28+35 luc 05:52 lam sha doi so voi census ban dau; guard drift ABORT lan ghi dau, re-derive anchor theo noi dung (COST-02-INDEP 8587->8584, qwen-platform Muc 23 2184->2185), KHONG ghi de noi dung lane khac. VERIFY: link check x3 exit 0, S0 1015/650 BROKEN=0 MISMATCH=0 GATE=0, S1 1092/726 BROKEN=0, TREE 190 file/1761 target/851 anchor/BROKEN=2 (2 pre-existing); anchor content assertion 6/6. Loi cua toi: (1) guard link chan 1 fragment sai duong dan (sibling thay vi tuong doi) truoc khi ghi; (2) 2 anchor drift da repoint; (3) guard drift chon 1 lan ghi de chan, census lai roi moi ghi. G-DATA/G-ENC/G-ADMIN-OPS/G6 NO-GO, 52 dong khong doi, KHONG tick task row, khong commit — Muc 39.
- 40 — D-DOCS-06-RESULT (task_caea3b5ceed6, ctx_5f4e332234e0): TAO MOI docs/06-result-envelope.md theo contract RESULT-WIRE-01 (file packet chi dinh khong ton tai; catalog that la docs/06-public-api.md) - D-A41-2. Toan bo mo ta doc truc tiep tu schema that packages/contracts/src/operations.ts + encryption.ts: GET /operations/{id}/result plain = ResultEnvelope v1 strict 5 field, encrypted = 3 field {schemaVersion, encrypted:true, delivery} (giai ma delivery ra dung ResultEnvelope); GET /artifacts/{id}/download plain = RAW BYTES + Content-Type = MIME artifact (body Uint8Array hoac async byte stream), encrypted = JSON wrapper strict {schemaVersion, encrypted:true, delivery, artifactId UUID, mimeType 1..255} voi content type application/json. **PHAT HIEN D-A41-1: hop dong da dong bang CHUA CO TRONG OPENAPI** - grep docs/21-openapi.json: encrypted/delivery/schemaVersion deu 0 hit; grep tools/openapi/gen_openapi.py: cung 0 hit; ca client sinh tu OpenAPI se KHONG thay bien the encrypted. Sua can cham gen_openapi.py + regenerate, NGOAI pham vi docs/ (tools khong thuoc docs/**). Verify: link check x3 exit 0, S0 1020/650 BROKEN=0 MISMATCH=0 GREE=0, S1 1104/732 BROKEN=0, TREE 191 file (file moi da vao pham vi) 1779 target BROKEN=2 (2 pre-existing Antigravity); Delta-A41-1 verify bang grep TRUOC khi tao file. Khong loi ghi trong cycle nay - fragment viet thang bang write_file, script chi doc file va thao tac byte. G-ENC/G6 NO-GO, RESULT-WIRE-01 van [~], khong tick, khong commit — Muc 40.
- 41 — D-OPENAPI-ENC-RESULT (task_a78de4c6e5c6, ctx_ddd407434cb4): gen_openapi.py them 8 schema delivery va publish path GET /api/v1/artifacts/{id}/download (truoc x-absent no route nay la vang mat); 21-openapi.json 42->43 path, sha16=c9aae1963f0b0d61, gen exit 0 x2 byte-identical, validate 23/23 exit 0; sua docs/06-result-envelope.md + docs/20-openapi-descriptions.md; Δ-A42-1..5
- 42 — D-DOCS-COST-ADM-SYNC (task_a81acbf3134a, ctx_6f465683bd05): dong bo GET /api/v1/usage/events (keyset cursor + filter allow-list 13 ten) va hop dong durable reservation vao docs/20 (them 1 dong route + §6) va docs/admin-ops-monitoring-cost.md (viet lai 1 o + 1 muc moi); khong tick row COST-01..04; link check S0/S1 BROKEN=0 x3; Δ-A43-1..5
- 43 — D-DOCS-OPENAPI-EVENTS-SYNC (task_f2434eeee16a, ctx_f0ea55c4bda1): dong Δ-A43-1 bang cach sua GENERATOR (khong sua artifact) - publish GET /api/v1/usage/events voi 13 tham so DAN XUAT tu packages/contracts/src + 6 schema; 21-openapi.json 43->44 path, 8->14 schema, version 1.1.0->1.2.0, sha16=37c609208de55bd0 byte-identical x2, DANGLING-REFS=0, validate 23/23 exit 0, S0/S1 BROKEN=0 x3; sua 2 dong prose trong docs/20; Δ-A44-1..5
- 44 — CR28 sync (D-DOCS-CR28-SYNC): them CR28-04 + CR28-05 vao docs/28 + docs/35, bo sung receipt doc lap cua CR28-06; version 1.47.0 -> 1.48.0 ca hai file; khong tick row, khong doi verdict gate; S0/S1 BROKEN=0 x3; Δ-A45-1..6
- 45 — D-DOCS-CR28-TRACEABILITY-SYNC (task_754289181e16, ctx_12ff8ef27c46): ma tran truy vet CR28-02..06 vao docs/19 (5 dong, 8 cot, tach evidence state vs orchestration state); sua 2 claim da sat o docs/28 + docs/35 vi receipt doc lap CR28-04 den 13:07:22; docs/19 khong co dong Document Version nen khong chhe; S0/S1 BROKEN=0 x3; Δ-A46-1..5
- 46 — D-DOCS-CR28-01-BASELINE-SYNC (task_5ef844b5f918, ctx_7b66f45b5631): dong Δ-A46-4, them CR28-01 vao docs/28 + docs/35 va doi ten ma tran docs/19 thanh CR28-01..06 (6 dong, deu 10 o); dem lai 14/14 tu test file (14 it/test, 0 it.each) chu khong chep receipt; S0/S1 BROKEN=0 x3; Δ-A47-1..5
- 47 — D-DOCS-CR28-COMPLETE-SYNC (task_1cf9f0ac9021, ctx_1958294b0537): doi chieu 6 finding CR28 voi tester receipts trong tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md (va sua dong header) + docs/35 (1.48.0 -> 1.49.0); CR28-03 da co receipt owner, CR28-08 xuat hien ngoai sheet; repoint 2 anchor qwen-platform troi (2597->2600, 2766->2767); S0/S1 BROKEN=0 x3; Δ-A48-1..6
- 48 — D-DOCS-CR28-FINAL-CONSOLIDATION (task_749fc5614c1a, ctx_e02388577208): gom 5 nhom bang chung moi vao docs/28 (+5 muc) + docs/35 (+1 muc, 1.49.0 -> 1.50.0) + docs/19 (thay 2 dong ma tran + 1 muc); dem lai 23 chunked tu test file (23 it/test, 0 it.each) chu khong chep receipt; S0/S1 BROKEN=0 x3; Δ-A49-1..6
- 49 — D-DOCS-EVID-SYNC-322 (task_0548e8e9c75b, ctx_1eb258383302): W-INGEST-WIRE-02-DEADLINE-ABORT (31/31 x3 + recheck + doc lap), V-OFFLINE-CR28-02-SERVICE-AUTH (CR28-02 DA co receipt doc lap) va W-ADM-UX-03-AUDIT-QUERY (11/11 x3) vao docs/28 + 35 (1.50.0 -> 1.51.0) + 19; dem lai 31/28/11 tu test file; S0/S1 BROKEN=0 x3; Δ-A50-1..6
- 50 — D-DOCS-EVID-SYNC (task_b01e83b04ea9, ctx_2d3647676d28): T-CODEX-OFFLINE-ADMIN-AUDIT-QUERY-MOUNT-INDEPENDENT (17 x3, run dau fail ETIMEDOUT), W-DOC-CORE-INGEST-SCAN-FIXTURES (4 x3) va T-CODEX-OFFLINE-DOC-CORE-INGEST-SCAN-TAMPER-INDEPENDENT (4 x3) vao docs/28 + docs/35 (1.51.0 -> 1.52.0) + docs/19; dem lai 23/4/4 tu test file; S0/S1 BROKEN=0 x3; Δ-A51-1..6
- 51 — D-DOCS-EVID-SYNC-5 (task_dd80c81503af, ctx_2af053da6b87): 5 receipt moi vao docs/28 (5 muc) + docs/35 (1 muc, 1.52.0 -> 1.53.0) + docs/19 (thay dong CR28-01 + 1 muc); hai ten receipt trong packet khong ton tai (0 hit) - ghi theo ten that; dem lai 23/70/1/14 tu test file; S0/S1 BROKEN=0 x3; Δ-A52-1..6
- 52 — D-DOCS-EVID-SYNC-4 (task_5592f61949ac, ctx_7daa617f1825): W-WORKER-SDK-NETWORK-BOUNDARIES-STABILIZE (full worker-sdk 19/20 -> 21/21 338/338 exit 0, SUPERSESSION), W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE (13 x3), W-CR28-01-OPENMETADATA-WINDOW (qwen-platform Muc 35, D72 GAP dong, 47 x3), W-ADM-UX-10-UNIFY-EMPTY-BANNER-OPERATIONS (qwen-admin Muc 39, khong dat ExitCode 0 va Muc 40 dong D92) vao docs/28 + docs/35 (1.53.0 -> 1.54.0) + docs/19; hai ten receipt trong packet khong ton tai - ghi theo ten that; S0/S1 BROKEN=0 x3; Δ-A53-1..6
- 53 — Turn 329 (task_8d0c2253ce8c, ctx_40b0184dca61): 5 receipt negative-test vao docs/28 (+4 muc) + docs/35 (1 muc, 1.54.0 -> 1.55.0); KHONG dung docs/19 vi packet khong noi file do; ba ten receipt trong packet khong ton tai (0 hit) - ghi theo ten that, so lieu van khop; dem lai 7/6/11/18/26 tu test file (artifact-stat 6 khai bao + 1 it.each = 7 chay); S0/S1 BROKEN=0 x3; Δ-A54-1..5
- 54 — Turn 330 (task_818c5f22ec14, ctx_7d6c0796908c): 4 receipt negative-test moi vao docs/28 (+4 muc) + docs/35 (1 muc, 1.55.0 -> 1.56.0); KHONG dung docs/19 vi packet khong noi file do; muc thu 5 cua packet la receipt DA dong bo o cycle 53, khong doi mot byte, KHONG viet ban sao; hai ten receipt khong ton tai va mot ten gan nham parent CR28 (CR28-04 -> CR28-01, ADM-UX-04 -> ADM-BASE) - ghi theo ten that; dem lai 10/12/55/27 tu test file (ingest-source-pin 12 khai bao + 1 it.each = 18 chay); D76 MOI; S0/S1 BROKEN=0 x3; Δ-A55-1..6
- 55 — Turn 332 (task_9cb53198ebae, ctx_9cb53198ebae): 5 receipt negative-test vao docs/28 (+4 muc, giu version 1.48.0) + docs/35 (1 muc, 1.56.0 -> 1.57.0); hai ten receipt trong packet khong ton tai (0 hit) - ghi theo ten that; ghi them 1 muc nganh cho W-WORKER-SDK-SERVICE-AUTH-NEGATIVE ngoai packet; dem lai 6/4 tu test file (ingest-timeout-recovery 4 khai bao + 1 it.each = 5 chay); lan do port loopback THU BA; S0/S1 BROKEN=0 x3; Δ-A56-1..5
- 56 — D-DOCS-EVID-SYNC-334 (Turn 333 + 334): 6 receipt negative-test vao docs/28 (+4 muc) + docs/35 (1 muc, 1.57.0 -> 1.58.0); LAN DAU TIEN sau nhieu cycle: MOI ten trong packet deu ton tai, khong co gi de sua; docs/28 giu nguyen version 1.48.0; D77 MOI (sha256 ghep truc truc khong xac thuc noi dung) + D78 MOI (purpose khong phai allow-list); lane tu bat 2 gia dinh sai cua chinh minh va viet lai theo hanh vi that; 3/5 suite co khai bao khac so chay (9->17, 8->25, 14->25); S0/S1 BROKEN=0 x3; Δ-A57-1..6
- 57 — D-DOCS-EVID-SYNC-335 (Turn 334 + 335): 5 receipt vao docs/28 (+4 muc) + docs/35 (1 muc, 1.58.0 -> 1.59.0); MOI ten trong packet deu ton tai; W-PLAT-CR28-02-ARTIFACT-GRANT-FENCING-NEGATIVE la [SKIP-QUALIFIED] CHU KHONG PHAI PASS (0 test thuc thi, chi co compile sach + cong giu) - Δ79; W-ADM-UX-05-PORT-ISOLATION-HARDENING DONG NO flake EADDRINUSE, cach port 0 hoa ra la HOI QUY do chinh lane gay ra; S0/S1 BROKEN=0 x3; Δ-A58-1..5
- 58 — D-DOCS-EVID-SYNC-336 (task_a7491cf0e42b, ctx_a7491cf0e42b): W-WORKER-SDK-ARTIFACT-READ-METADATA-NEGATIVE (18 x3) + W-DOC-CORE-INGEST-SOURCE-PIN-NEGATIVE (23 x3) + receipt doc lap moi T-CODEX-OFFLINE-READ-METADATA-AND-SOURCE-PIN-INDEPENDENT vao docs/28 + docs/35 (1.59.0 -> 1.60.0); mot receipt trong packet DA GHI o cycle 57 va KHONG DOI - khong viet ban sao, chi ghi muc ngan; dem lai 14+3=18 va 15+1=23; S0/S1 BROKEN=0 x3; Δ-A59-1..4
- 59 — D-DOCS-EVID-SYNC-337 (task_b46c820f1e8a, ctx_b46c820f1e8a): 5 receipt Turn 337 vao docs/28 (+4 muc, giu version 1.48.0) + docs/35 (1 muc, 1.60.0 -> 1.61.0); MOI ten trong packet deu ton tai (ky luc 3 cycle lien); so 14 tests cua W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE thuoc muc phu Turn 337 supplemental, KHONG phai receipt goc Turn 329 (7 test, da sync Muc 53) — Δ-A60-1; W-PLAT-CR28-02-ARTIFACT-SUBMIT-GUARDS-NEGATIVE la [PASS] THAT (unit offline, khong liveSuites, mutation chung minh duoc: 24/24 x3, M1 -> 1 failed 23 passed) doi lap voi [SKIP-QUALIFIED] — Δ-A60-2; Δ81 (file 0 byte KHONG bi tu choi) + Δ82 (submit KHONG co assertTenantId) MOI va chua ai dong; W-ADM-UX-05-MOUNT-PORT-ISOLATION-HARDENING 8/8 song song 0 va cham port; MOT receipt da ghi Muc 58 va khong doi; link check x3 S0 1063/S1 1147 BROKEN=0, TREE BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 60 — D-DOCS-EVID-SYNC-338 (task_c81f034d92a1, ctx_c81f034d92a1): 5 receipt Turn 338 vao docs/28 (5 muc, giu version 1.48.0) + docs/35 (1 muc, 1.61.0 -> 1.62.0); MOI ten trong packet deu ton tai (ky luc 4 cycle lien 56-59); Δ-A61-1 hai ten admin gan het nhau da kiem de khong ghi nham (PLATFORM-MOUNT Muc 47 la file khac voi MOUNT Muc 46 da ghi Muc 59, ca hai deu dung); Δ-A61-2 7 finding moi Δ83-Δ89 tu Muc 43, nghiem trong nhat Δ83: artifactId khong validate uuid nen loi 22P02 ra 500 chu khong phai 404 va test double Map.get dang che - tac gia KHONG chung minh live, khong tu dong; Δ-A61-3 packet tro tester 10033 nhung header that o 10003; Δ-A61-4 bay dem so: checkpoint 8=8 la file duy nhat khai bao bang chay, 42 la tong ba lan; Δ-A61-5 tester.md troi 10092 -> 10123 dong giua chung, bat bang doc lai theo noi dung; W-PLAT-CR28-03 90/90 x3 voi M1 that (3 failed 87 passed, tu choi bien the if(false &&) vi dead code); platform-mount 4/4 song song 0 va cham port, 447/447 batch 9 suite; link check x3 S0 1063/S1 1147 BROKEN=0, TREE BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 61 — D-DOCS-EVID-SYNC-339 (Turn 342, KHONG co task id/dispatch id trong packet): 5 muc trong packet chi ra 4 receipt MOI + 1 ban chep nguyen van cua receipt da ghi Muc 60 (W-WORKER-SDK-TEMP-SWEEP-NEGATIVE trung task_4e81561a73bc, trung moc 05:18:26, trung 14/42) - Δ-A62-1, la lan thu hai mot receipt co hai header trong tester.md; 4 receipt moi: T-CODEX-OFFLINE-SERVICE-AUTH-AND-OUTPUT-VALIDATION-INDEPENDENT (19 x3 + 32 x3, doc lap read-only), W-WORKER-SDK-ARTIFACT-MULTIPART-NEGATIVE (27 x3), W-PLAT-CR28-04-RUNTIME-ENCRYPTION-METADATA-NEGATIVE (Muc 44, +50 test 55 -> 105, 0 dong production, HAI mutation that: M1a bo refId khoi AAD 5 failed 100 passed, M1b siet lo hong null 5 failed 100 passed va ca 5 deu la test MOI), W-ADM-UX-02-IDEMPOTENCY-NEGATIVE (Muc 48, +18 test 27 -> 45, PROBE hanh vi that truoc khi viet test, 45/45 x3 + hoi quy 7 suite 277/277); 6 finding moi Δ90-Δ95, nghiem trong nhat Δ90 seal khong co tran kich thuoc va Δ93 envelope khong co truong thoi gian nao nen khong do duoc tuoi row; Δ-A62-2 toi QUET SAI mot lan bo sot muc 5 (qwen-admin dung dinh dang header khac) va kiem cheo bang settlement coordinator truoc khi ghi; docs/28 giu version 1.48.0, docs/35 1.62.0 -> 1.63.0; link check x3 S0 1063/S1 1147 BROKEN=0, TREE BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 62 — D-DOCS-EVID-SYNC-340 (Turn 344, KHONG co task id trong packet): 5 receipt moi vao docs/28 (5 muc, giu version 1.48.0) + docs/35 (1 muc, 1.63.0 -> 1.64.0); PHAT HIEN CHINH CUA CYCLE - 4 khoi Δtest.failing o 2 file ma KHONG receipt nao noi toi: ingest-scan-tamper 3 (L322 PDF-as-PNG, L334 TIFF cat, L344 JPEG SOI hong) + parser-budget-band 1 (L182 page count am chua bi tu choi) - Δ-A63-1, nghia la N passed khong dong nghia N assertion dung y; 2 header lap lai lan thu BA trong tester.md (Δ-A63-2); W-DOC-CORE-PARSER-BUDGET-BAND da co san trong docs/28 tu L1180 voi 13 test nen toi ghi muc DELTA 13 -> 22 chu nhan ban (Δ-A63-3, guard chan dung); 2 receipt xac minh doc lap tach thanh muc rieng de khong gop voi mutation evidence cua tac gia goc (Δ-A63-4); W-ADM-UX-02-PAGINATION-NEGATIVE (Muc 49, 89 -> 103, 103/103 x3 + hoi quy 7 suite 233/233, PROBE truoc khi viet test, va tac gia BAO TRUNG THUC rang khong co task Turn 341 trong run); dem lai: 34+7=90 · 45 · 27 · 99+1=103 · 21+1 failing=22 · 13+3 failing=16; link check x3 S0 1063/S1 1147 BROKEN=0, TREE FILES=204 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 63 — D-DOCS-EVID-SYNC-341 (task_5e3a91b40c4e, ctx_5e3a91b40c4e, LAN DAU TIEN co task id that): 3 receipt moi vao docs/28 (3 muc, giu version 1.48.0) + docs/35 (1 muc, 1.64.0 -> 1.65.0); ZERO PRODUCTION CODE EDITS nhu packet yeu cau; HAI MUTATION DEU DO O TEST MOI - muc toi thay tu truoc toi: M1a bo purpose khoi contextAad 2 failed 99 passed (truoc cycle nay bo purpose di KHONG lam do test nao), M1b doi decodeBase64 tu invalidManifest sang invalidInput 4 failed 97 passed, ca 4 deu la test moi va chung minh Δ97 la TRANG THAI THAT chu khong phai doan; W-PLAT-CR28-05-CRYTO-STORAGE-FACADE (Muc 45, +74 test 27 -> 101, 0 dong production, crypto-storage-facade.ts dcd7e3db khop dung Muc 36/37, test 29206e36 49096 B CRLF 976/bareLF 0, packet lay tu INBOX msg_84676fec5d9d seq 283 khong co file tren dia); MOT GIA THUYET SAI BI LOAI BO TRUOC KHI VIET TEST: nghi manifestMac la truong trang tric, doc tiep thay MAC verify that bang HMAC + timingSafeEqual truoc khi giai ma chunk nao, va ong viet test PHU DINH chinh gia thuyet do (Δ-A64-3); 5 finding moi Δ96-Δ100, Δ98 cung mot lop nham lam phan loai su co da gap o Δ92 cycle truoc nen la LAI o seam thu hai; ban chep NGUYEN VAN lan thu TU cua W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE (Δ-A64-1); dem lai: 34 it + 12 it.each + 10 test = 101 · 14 it + 4 it.each = 26 · 13 it + 3 test.failing = 16; link check x3 S0 1063/S1 1147 BROKEN=0, TREE FILES=205 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 64 — D-DOCS-EVID-SYNC-342 (task_6e3a91b40c5f, ctx_6e3a91b40c5f): 4 receipt moi + 1 muc already-on-record vao docs/28 (5 muc, giu version 1.48.0) + docs/35 (1 muc, 1.65.0 -> 1.66.0); ZERO PRODUCTION CODE EDITS nhu packet yeu cau; Δ-A65-1 PHAT HIEN CHINH: test.failing da lan ra 3 file, tong 10 khoi (ingest-scan-tamper 3 + ingest-scan-fixtures 5 + ingest-source-pin 2), va 5 khoi trong ingest-scan-fixtures ma receipt XAC MINH DOC LAP **KHONG** nhac - 5 trong 19 passed la xanh VI san pham chua tu choi; Δ-A65-2 CA NGHIEM TRONG NHAT: ingest-source-pin L210 la test.failing vi noi dung binding mot storage pin cua TENANT-B vao operation cua TENANT-A - pin la input PHAY QUYEN chu khong phai hygiene nhu truong hop storage key toan khoang trang o L84; Δ-A65-3 ban chep nguyen van LAN THU NAM cua W-DOC-CORE-INGEST-SCAN-TAMPER (tester L10362), da bao o 3 cycle lien tiep ma van tiep dien; Δ-A65-4 qwen-admin dai them 68 dong nhung KHONG co Muc moi - do la ledger chen lon thu tu (dong 30-38 xen giua 1-29), toi khong ghi muc va khong sua ledger lane khac; dem lai: 14+9+1=42 · 14+5 failing=19 · 34+5=44 · 15+1+2 failing=28; connector-session.test.ts da co EOL HON TAP trong cay (707 CRLF/151 bareLF) nen nguoi sua phai doc truoc; link check x3 S0 1063/S1 1147 BROKEN=0, TREE FILES=206 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 65 — D-DOCS-EVID-SYNC-343 (task_7e3a91b40c6a, ctx_7e3a91b40c6a): 6 receipt moi + 2 muc delta + 1 muc already-on-record vao docs/28 (8 muc, giu version 1.48.0) + docs/35 (1 muc, 1.66.0 -> 1.67.0); ZERO PRODUCTION CODE EDITS; Δ-A66-1 DIEM DANH NHAT - HAI LANE, HAI FILE, CUNG MOT Y TUONG: Muc 46 giai thich bo dem wrapCalls() chinh la thu CHAN TEST CHAY RONG (neu code chi wrap mot lan thi provider fail-o-2 khong bao gio no va test xanh ma khong chung minh gi), va Muc 53 o LANE KHAC viet MOT CONTROL TEST de cac dong state hong khong the xanh vo nghia - ca hai deu chu dong bao ve test khoi xanh-vi-nham-ly-do; bo dem cua Muc 46 con TU BAT TRUNG mutation lam no mat y nghia; Δ-A66-2 ban chep nguyen van LAN THU SAU va LAN DAU khong bi gioi han o MOT receipt (W-WORKER-SDK-CONNECTOR-SESSION-NEGATIVE tester L10459) nen nhieu kha nang la loi QUY TRINH CHUNG - tong 6 lan tren 5 receipt; Δ-A66-3 test.failing thu BA khong duoc receipt nao noi (ingest-wire L394 multipart boundary lech encoded body boundary), tong 11 khoi o 4 file, va mau nay dang LẶP; Δ-A66-6 Δ101 bat doi xung giua duong ghi va duong doc: seal KHONG kiem hinh dang wrapped DEK provider tra ve trong khi validateWrappedResult CO ton tai o duong doc - provider lech chuan lam submit THANH CONG va ghi envelope VINH VIEN khong mo duoc; Δ-A66-4 4 defect that trong admin Muc 53, nguy hiem nhat la status lai hien thanh HEALTHY vi ham suc khoe mac dinh phan con lai la ENABLED, tac gia noi day la trang thai NGUY HIEM HON BAO DO; dem lai: 19+7=42 · 71 test()=95 (describe long nhau) · 16 · 16+3=20 · 16+3=27 · 18+1 failing=19 · 21+3=35; link check x3 S0 1063/S1 1147 BROKEN=0, TREE FILES=207 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 66 — D-DOCS-EVID-SYNC-344 (task_8e3a91b40c7b, ctx_8e3a91b40c7b): 6 receipt moi + 1 muc already-on-record vao docs/28 (7 muc, giu version 1.48.0) + docs/35 (1 muc, 1.67.0 -> 1.68.0); ZERO PRODUCTION CODE EDITS; Δ-A67-1 PHAT HIEN CO GIA TRI NHAT VA NO LA DOING TICH CUC SO VOI BA CYCLE TRUOC: W-DOC-CORE-MANIFEST-NEGATIVE NO THANG khoi test.failing cua chinh no, o TUNG DONG KET QUA chay va o DONG KET LUAN - ba cycle truoc moi cycle toi deu tim ra mot khoi ma receipt IM LANG, nay co bang chung rang viec noi ra LAM DUOC trong cung dinh dang, nen im lang o cac receipt kia la KHOANG TRONG cua chinh chung khong phai gioi han ky thuat; Δ-A67-2 ban chep nguyen van thu BAY va LAN DAU LAN sang receipt thu SAU (W-WORKER-SDK-ARTIFACT-DIRECT-BAND-NEGATIVE tester L10562) nen gia thuyet mot lan append hong da yeu han - tong 7 lan tren 6 receipt; Δ-A67-3 MOT FILE KHONG DUY NHAT: cay nay co BA file manifest.test.ts va chi cai document-core la receipt nay (contracts co 20 it, example-review co 4) - grep ten se ra SAI file va moi con so trong muc do se sai ma troi rat hop ly; Δ-A67-5 MOT LANE TU CHOI BIA khai niem packet yeu cau: packet doi corrupt THROUGHPUT nhung module co 10 export va KHONG ham nao tinh rate hay throughput, tac gia dem export roi ghi ra thay vi bia; Δ-A67-4 ky luat chong test-xanh-vi-nham-ly-do xuat hien LAN THU BA o file thu ba (Muc 45 giai thich bo dem, Muc 53 control test, Muc 55 gan control); Δ-A67-6 ha cap tham lang (buildAuditEventView khong doc row.severity ma suy tu kind nen hang khai error ra warning va gia tri goc bien mat khoi view) + tenant scoping sup thanh no-op vi undefined === undefined la TRUE; dem lai: 41 · 39+2=53 · 9+1 failing=10 · 71 test()=108 chay (vong lap L550) · 16+3=20; bay file EOL hon tap da ton tai trong cay; link check x3 S0 1063/S1 1147 BROKEN=0, TREE FILES=208 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 67 — D-DOCS-EVID-SYNC-345 (task_9e3a91b40c7c, ctx_9e3a91b40c7c): 5 receipt moi vao docs/28 (8 muc, giu version 1.48.0) + docs/35 (1 muc, 1.68.0 -> 1.69.0); ZERO PRODUCTION CODE EDITS; Δ-A68-2 PHAN DANG GIA NHAT: hai test leak CO SAN trong suite xanh vi ly do YEU hon ve ngoai - mot cai cam sentinel vao publicKeyPem chu khong phai fingerprint nen xanh ca khi fingerprint mang dung sentinel do, mot cai chi khang dinh TOAN BO chuoi vang mat trong khi do thuc te 12 ky tu dau CO MAT; tac gia GIU ca hai test va them test do DUNG ky tu nao toi dau ra kem positive control, va noi thang day la dang test-pass-vi-ly-do-sai ma KHONG BAO GIO CANH BAO; Δ-A68-3 MOT GIOI HAN DUOC NOI THANG: packet doi CSRF timing nhung unit test offline KHONG chung minh duoc tinh constant-time, tac gia KHONG viet test gia ma ghim phan QUAN SAT DUOC (ranh gioi 64 la dai hop le duy nhat, 63/65/128/129 deu 403, va so do dai buffer chay TRUOC so sanh thoi gian hang) va noi ro can live sentinel o tang route thuoc Tester lane; Δ-A68-1 DOTE DAU TIEN KHONG CO ban chep nguyen van sau 7 lan lien tiep tren 6 receipt - toi van ghi ca su vang mat vi im lang se khien nguoi doc tuong hien tuong da dung vinh vien; Δ-A68-4 M1b kem CHI TIET GAN NGUYEN NHAN: bien the chuoi rong van xanh vi bieu thuc mutation van doi >=1 ky tu, va tac gia chu dong giai thich no co lap DUNG TINH bi noi chu khong phai moi id hong; Δ-A68-6 Δ106 ba bien duoc TUYEN BO rong hon code that: esc() chi escape 5 ky tu, moi ky tu dieu khien di thang qua, va tac gia phan biet rui ro that la parser differential chu KHONG phai XSS truc tiep; Δ-A68-7 dem lai: 9=9 · 49=84 · 28=53 · 50+5=55 -> 83 · 10=10; Δ-A68-8 KHONG co test.failing nao trong dot nay (do du o ca 5 file) - dot dau tien sau ba cycle lien tiep; giu nguyen gate NO-GO; khong tick task row
- 68 — D-DOCS-EVID-SYNC-346 (task_1e3a91b40c8d, ctx_1e3a91b40c8d): 5 receipt moi + 1 muc already-on-record vao docs/28 (6 muc, giu version 1.48.0) + docs/35 (1 muc, 1.69.0 -> 1.70.0); ZERO PRODUCTION CODE EDITS; Δ-A69-3 HAI MUC PACKET KHONG CO DOI TUONG TRONG MODULE: packet doi corrupt public key PEM nhung module KHONG HE parse PEM (no luu key REF da allowlist + version, PEM thuoc recipient-key-registry), va packet doi revoked key lookup fence nhung store KHONG THE BIET version nao bi thuoi vi constructor chi nhan db + allowlist khong co registry access; ca hai lan tac gia GHIM DIEU THAT thay vi dung test cho khop, va muc thu ba malformed JSON duoc CHUYEN HUONG sang nham lan hinh dang o tang hang vi bang khong co cot JSON; Δ-A69-4 TACGIA TU CHOI NANG BANG CHUNG M1: 3 test do (2 moi) nhung cac test DUONG DOC VAN XANH vi decodeRow co guard RIENG khong bi mutate, nen mutation nay chi chung minh DUONG GHI con dung, duong doc can mot probe rieng; Δ-A69-1 dot thu hai lien tiep KHONG co test.failing nao o ca 5 file (phep do, khong phai xu huong); Δ-A69-2 ban chep nguyen van QUAY LAI sau MOT dot sach, tong 8 lan tren 7 receipt - toi ghi con so tich lu chu ve duong xu huong tu hai diem; Δ-A69-5 Δ109 nhon Δ108: neu writer khac xoa hang giua luc ghi va doc lai thi set() tra ve cau hinh RONG cho dung tenant no vua duoc yeu cau cau hinh; dem lai: 9=9 · 4=4 · 10+2=12 -> 13 chay · 18=18 · 27+8=35 -> 59 chay; ba file EOL hon tap da ton tai trong cay; link check x3 S0 1063/S1 1147 BROKEN=0, TREE FILES=209 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 69 — D-DOCS-EVID-SYNC-347 (task_1e3a91b40c8e, ctx_1e3a91b40c8e): 4 owner receipt moi + 3 receipt xac minh doc lap + 2 muc already-on-record vao docs/28 (8 muc, giu version 1.48.0) + docs/35 (1 muc, 1.70.0 -> 1.71.0); ZERO PRODUCTION CODE EDITS; INBOX RONG VOI DOT NAY va duoc ghi ro: orca orchestration check tra 50 message nhung cai moi nhat la 2026-09-27T20:48Z, ton doc HAI NGAY cua lane khac, khong co gi ve Turn 347; toi khong dung packet gia va chuyen sang doc truc tiep report cua lane; cung tinh huong, Muc 58 cua admin cung bao cao inbox khong co packet cho task cua ho; Δ-A70-3 MOT LANE BAO KET QUA TICH CUC: Muc 58 la lan dau trong dot receipt nay ma tac gia ghi module cua ong CHAN RAT TOT, va noi thang ly do - de khong ai doc nham rang sau Muc 51-57 chung minh moi view model deu ho; gan nhu moi nguong deu fail closed kem thong diep phan biet, va total 0 duoc giu la available chu khong bi nham voi thieu so; Δ-A70-4 tac gia noi ro LOP XSS NAO THAT SU GIU: voi queueIntegrity.state thi allowlist chan truoc khi noi suy nen payload khong bao gio toi renderer, va ong noi thang lop giu la ALLOWLIST khong phai escaper - ghi cong cho mot escaper khong bao gio chiu tai la cung loai loi voi ghi cong cho mot test chung minh it hon ve ngoai cua no; Δ-A70-5 BAI HOC TU BAI TOAN DEM SO: overview-triage co 36 dong khai bao nhung chay 57; regex dau tien cho 42 vi no gop hau to .each va coi 6 khoi test.each thanh 6 test thuong; dem lai 2 it + 34 test, trong do 6 la khoi bang va cac khoi cap 21 dong, 36 + 21 = 57 khop receipt; nguy hiem that khong nam o chem THIEU ma o che regex LOAI hau to se dem NHIEU HON that ma van trong hop ly; Δ-A70-6 HAI BAN CHEP cung luc, van khong ve xu huong: tong 10 lan tren 8 receipt, chuoi ba cycle 0 roi 1 roi 2; ba diem do trong rat giong xu huong tang va do chinh la ly do toi khong viet no nhu xu huong, vi voi ba diem lien tiep tang va ngau nhien khong phan biet duoc; Δ-A70-7 TARGETS DOI va toi TRUY NGUON thay vi ghi khong doi nhu moi cycle truoc: S0 1063 roi 1065, S1 1147 roi 1149, TREE 1870 roi 1877; quet vung moi toi vua them o ca hai file docs ra 0 markdown link, nen phan tang khong do toi ma do lane khac sua file trong cung bo docs; dem lai: 14+2=18 · 10=10 · 13=13 · 12+1(4 dong)=16 · 36+6(21 dong)=57; ba file EOL hon tap da ton tai trong cay; dot thu BA lien tiep khong co test.failing nao (phep do, khong phai xu huong); link check x3 S0 1065/S1 1149 BROKEN=0, TREE FILES=210 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 70 — D-DOCS-EVID-SYNC-348 (task_1e3a91b40c8f, ctx_1e3a91b40c8f): 4 owner receipt moi + 1 xac minh doc lap + 1 muc already-on-record vao docs/28 (6 muc, giu version 1.48.0) + docs/35 (1 muc, 1.71.0 -> 1.72.0); ZERO PRODUCTION CODE EDITS; Δ-A71-1 CHUOI BA DOT KHONG CO test.failing KET THUC: output-validation tu 32 test / 0 failing thanh 25 test + 13 failing = 38, va toi TU THU HOI phat bieu cua Muc 68/69 thay vi de no dung mot minh; Δ-A71-2 TOI CAI THIEN CONG CU THEO LOI HUA VA VAN KHONG DU: hai phuong phap cua toi cho cung mot bang ra 5 va 2 dong, tuc bo dem khong dang tin voi bang co moi dong la object chua dau phay va URL; Δ-A71-3 TOI GHI 4/6 SO TEST LA CHUA DOI CHIEU DUOC thay vi dan so cua receipt: config 24 vs 25, worker-service-auth 23 vs 26, va toi ghi ca hai so canh nhau; Δ-A71-4 Muc 49 mutation do CHI o test MOI (2/69) va tac gia noi thang mot cau toi muon lam chuan cho moi receipt: test da DO VI LY DO KHAC va PHAI SUA, khong phai xanh vi toi muon; Δ-A71-5 hai muc packet lai khong quan sat duoc qua harness va tac gia goi DUNG TEN gioi han la thuoc ve BAN CHAT in-process cua harness chu khong phai thieu sot cua san pham; 13 khoi failing moi co hai cai co HINH DANG BAO MAT va duoc NEU TEN trong receipt; dot nay mang BA NGAY 29/30/10-01; dem lai: output-validation 25+13=38 khop · bootstrap 13=13 khop · config 24 vs 25 · svc-auth 23 vs 26 · invoker 18+5 khối · wiring 46+5 khối vs 71; link check x3 S0 1065/S1 1149 BROKEN=0, TREE FILES=210 BROKEN=2 pre-existing; giu nguyen gate NO-GO; khong tick task row
- 71 — D-DOCS-EVID-SYNC-349 (task_1e3a91b40c90, ctx_1e3a91b40c90): 5 receipt moi + 3 xac minh doc lap + 4 muc already-on-record vao docs/28 (8 muc, giu version 1.48.0) + docs/35 (1 muc, 1.72.0 -> 1.73.0); KHONG sua production source; Δ-A72-1 TOI SUA LOI CON SO CUA CHINH MINH: Muc 70 toi viet 25 khoi o 6 file, con so do SUY RA BANG PHEP CONG chu khong do; do lai toan cay: **30 khoi o 9 file**, sai ca so khoi lan so file, va sai DUNG CHO noi toi da viet ba cycle rang phai do chu dung suy luan; Δ-A72-2 MOT RECEIPT TRUNG TEN NHUNG LA CONG VIEC MOI: T-CODEX-OFFLINE-SERVICE-AUTH-AND-OUTPUT-VALIDATION-INDEPENDENT co hai ban, ban cu tai L10245 mang task_2e8a104c91bf luc 2026-09-29T05:47:34, ban o L11175 mang task_1a1a8e94f0e9 luc 2026-10-01T00:25:01 - khac task khac moc, nen la mot lan xac minh MOI chu phai ban chep; toi phan loai theo task id va moc chu khong theo ten; Δ-A72-3 BAT VA CHAM TEN FILE LAN THU HAI: cay co HAI file package-boundary.test.ts va BA file manifest.test.ts; toi phan giai receipt theo duong dan test va thu muc lam viec, khong lay hit grep dau tien; Δ-A72-4 ca hai khoi expected-failing moi deu DUOC NEU TEN trong receipt - mau giu expected-failing khong tai dien o dot nay, nhung toi van dem tu file vi do la bai hoc re nhat; dem lai: package-boundary 6+2 failing=8 khop · bounded-input 47 khai bao bang chay khop · analyze 12+1 bang+1 failing vs receipt 19 (ghi ca hai) · manifest 10+1 bang+2 failing vs 15 (ghi ca hai); 4 ban chep nguyen van, tong 15 lan tren 11 receipt; link check x3 S0/S1 BROKEN=0; giu nguyen gate NO-GO; khong tick task row
- 72 — D-DOCS-EVID-SYNC-350 (task_1e3a91b40c91, ctx_1e3a91b40c91): 2 owner receipt moi (W-DOC-CORE-EXTRACT-NEGATIVE task_7a1b92c40edc luc 01:23, W-DOC-CORE-TRANSFORM-NEGATIVE task_7a1b92c40edd luc 01:37) + 3 receipt xac minh doc lap + 2 ban chep nguyen van vao docs/28 (5 muc moi, giu version 1.48.0) + docs/35 (1 muc, 1.73.0 -> 1.74.0); ZERO PRODUCTION CODE EDITS; HAI MODULE CUNG MOT KHANG DINH VE TIMEOUT: extract va transform deu assert provider timeout TRUYEN LEN, KHONG fallback, KHONG synth output, KHONG retry — manh hon viec chi phat hien timeout, vi mot timeout nuot im lang se bien mot loi trich xuat thanh mot tai lieu trong hop ly; Δ-A73-1 do lai toan cay: **40 khoi o 14 file** (Muc 70 viet 25/6 bang phep cong chu khong do; cycle 71 do 30/9); Δ-A73-2 PHAM VI PACKET KHONG BANG PHAM VI CAY: 5 file co test.failing nhung packet nay khong co receipt nao (generate 3, compare 2, ingest 2, parser-budget-band 1, ingest-wire 1) — toi ghi ra chu tu gop; Δ-A73-3 NHAN D MANG SO 73 CHU PHAI 72: quy uoc tien to = so muc + 1 (Muc 70 -> Δ-A71, Muc 71 -> Δ-A72); ban thao Δ-A72 da bi phat hien khi dem nhan toan file va doi truoc khi ghi; Δ-A73-4 dem tu source co 2 noi KHONG khop receipt: extract 15 it + 1 test + 1 bang + 2 failing vs 21; analyze 12 it + 1 bang + 1 failing vs 19; transform 12+1=13 khop chinh xac — toi ghi ca hai so thay vi ep khop; dem lai 7 file moi, khong file nao trung ten; 3 file EOL hon tap (extract 324/72, transform 180/65, analyze 234/66); link check x3 S0/S1 BROKEN=0; giu nguyen gate NO-GO; khong tick task row
- 73 — D-DOCS-EVID-SYNC-371: 6 receipt moi vao docs/28 (6 muc moi, giu version 1.48.0) + docs/35 (1 muc, 1.74.0 -> 1.75.0); ZERO PRODUCTION CODE EDITS; — 0 ban chep lai: 6/6 task id tra 0 hit o ca docs/28, docs/35 va qwen-docs, so day la wave sac dau tien trong nhieu cycle; — NHAN D PREFIX 74: cycle 72 dung A73 nen cycle 73 dung A74, A74 co 0 lan truoc khi ghi; — KHUANG DINH NO-FALLBACK DA LAN RA 4 MODULE: cycle 72 co extract + transform, wave nay them compare + generate; bon module KHONG chung code, khac tac gia, khac lane; — MOT MUTATION XANH VI CHUA VO HIEU HOA GI: version + 0 la phep cong vo nghia nen dieu kien y het, 49/49 van xanh, chi lan 2 moi do 1 failed 48 passed; — DEM TAY KHONG TIN BO DEM: admin 78 khai bao + 25 dong inline + 19 dong hang (badDelivery 3, badKeyRef 5, badPin 7, junkBodies 4) = 122; recipient-key-registry 21 + 28 = 49; compare 10 + 2 failing + 10 dong = 22; generate 15 + 3 failing = 18; ingest 15 + 2 failing = 17; read-metadata 15 + 22 dong = 37; 6/6 khop receipt; — BA LOI BAO MAT DUOC GHI VA KHONG SUA o crypto-config wiring: bearer VIEWER ghi duoc khi khong gui cookie; cookie khong xac minh duoc coi la khong co cookie nen tat CSRF; phien khong bao gio vo hieu hoa; body khong phai object la no-op 200; — test.failing 40/14 KHONG DOI, nhung khoang trong E8 cua cycle 72 hep tu 5 file xuong 2 file (parser-budget-band, ingest-wire); 296 file test, khong trung ten; — so 1.74.0 co hai lan trong docs/35 va toi chi bump mot lan: dong version L3, dong con lai la tham chieu lich su trong Wave 10/11; — link check x3; giu nguyen gate NO-GO; khong tick task row

---

## 1 — CYCLE 1: D-EVID-A7 (docs-only ledger sync cho W-VAULT04-FIX1 + D-LINT-ORCH-1)

- **Packet**: `D-EVID-A7` — đồng bộ `docs/28-test-inventory.md` và `docs/35-acceptance-baseline.md` với (a) `codex6.md` Cycle 140 (W-VAULT04-FIX1), (b) `codex-lint-probe.md` (D-LINT-ORCH-1), (c) `tester-antigravity.md` (T-DATA-LIVE-4); chạy offline local markdown link/anchor check; không sửa source sản phẩm, không chạy test, không đụng DB.
- **Nguồn đã đọc để chép số**: `codex6.md` (Cycle 138/139/140), `codex-lint-probe.md`, `tester-antigravity.md` (T-ANTIG-1/1B, T-DATA-LIVE-4, T-ANTIG-2), `coordinator-antigravity.md`, `coordinator-qwen.md`, `coordination/scripts/dispatch-turn1.ps1`, `du-rework/AGENTS.md`, 5 raw log của Cycle 140.
- **Thời điểm**: 2026-09-26 ~00:15–00:27 +07.

### Ba mục packet — kết quả

| # | Mục packet | Kết quả | Ghi chú |
|---|---|---|---|
| 1 | `codex6.md` Cycle 140 (W-VAULT04-FIX1) | **ĐÃ LAND** | Placeholder "in flight" của A6 chuyển thành receipt thật. Số liệu **tự kiểm lại từ raw log**, không chỉ chép receipt: 3 aggregate liên tiếp đều `1 skipped, 55 passed, 55 of 56 total` / `15 skipped, 1286 passed, 1301 total`, lần lượt 36.185 s / 34.337 s / 35.397 s; regression 189/189; targeted 12/12. |
| 2 | `codex-lint-probe.md` (D-LINT-ORCH-1) | **ĐÃ LAND** | Row mới. Xanh mới hơn trên cùng lệnh **supersede** đỏ lint của Cycle 139 (exit 2, hai lỗi type `s3-storage-facade`) mà nhiều dòng khác trong docs vẫn đang trích. **Không adjudicate** nguyên nhân: lane chép nguyên văn chẩn đoán "stale source snapshot" của probe và ghi **Δ mở** về việc ai đổi cursor sang `string` / có chủ ý không. |
| 3 | `tester-antigravity.md` (T-DATA-LIVE-4) | **NO-OP — đã có sẵn từ A6** | Đối chiếu từng trường với `tester-antigravity.md#L98`: lệnh, 5/5 exit 0 ×2, thời gian 35.782/35.809 s, CLAIM 23:05:00.000 → RELEASE 23:06:15.000, MinIO :9003 bucket `du-artifacts-live2`, và **scope limit** (suite không gọi `/api/v1/uploads`) đều khớp. Không thêm row trùng. |

### Câu chữ đã sửa (giữ lịch sử, không xoá dòng nào)

Áp dụng cùng một bộ cho cả `docs/28` và `docs/35`:

- **Document Version** `1.17.0` → `1.18.0` (quy ước bump theo cycle, xem `codex4.md` 1.12.0→1.17.0).
- **Header section**: `### 8.16 D-EVID-A5 → A6` → `### 8.16 D-EVID-A5 → A7`; `### 12.19 D-EVID-A5 → A6` → `### 12.19 D-EVID-A5 → A7`.
- **Row aggregate Qwen-3 T-ORCH-AGG-1R**: thêm câu trỏ tới row Cycle 140, kèm qualifier rằng đó là **lệnh khác trên trạng thái cây khác** nên hai số không gộp.
- **Row Codex-6 W-VAULT04-FIX1**: đổi nhãn thành *"— in flight at A6 (superseded)"*, giữ nguyên làm lịch sử.
- **Thêm 2 row mới** sau nó: `Codex-6 Cycle 140 — W-VAULT04-FIX1` (kèm 5 link raw log) và `CodexNew D-LINT-ORCH-1 — Orchestrator lint re-probe`.
- **Row `Acceptance boundary` (chỉ `docs/35`)**: tách rõ **Closed in A7** (mock-Vault `TS2345`, Orchestrator lint red) khỏi **Still open**, thêm Δ mới về provenance của cursor, và thêm scope caveat về package `@du/connector`.
- **Đoạn kết mỗi file**: nêu hai aggregate là lệnh riêng, không gộp; giữ câu "delta này không chạy test, không mở DB/Redis/S3, không apply migration, không sửa source/test".

### Bằng chứng lệnh đã chạy (instrument + ExitCode nguyên văn)

Tất cả là lệnh **đọc**; không lệnh nào là test. Cwd mặc định `D:\Git\dugate`.

| # | Lệnh | Kết quả đo được | Exit Code nguyên văn |
|---|---|---|---|
| V1 | Đếm dòng/byte/mtime 7 file ledger + receipt trước khi vá | `28-test-inventory.md` 536 dòng / 86577 B / 23:20:27; `35-acceptance-baseline.md` 694 / 120661 B / 23:19:58; `qwen-new.md` 102 / 15683 B; `codex6.md` 141 / 16855 B; `codex-lint-probe.md` 35 / 2476 B; `tester-antigravity.md` 160 / 13212 B; `codex4.md` 544 / 83437 B | `Exit Code: 0` |
| V2 | `grep D-EVID` toàn `du-rework` | 26 hit; `coordination/scripts/dispatch-turn1.ps1:34` đúng là text packet A7 này; `coordinator-antigravity.md:67` xác nhận `Qwen-Docs` (`term_8ba9a7d5`) nhận D-EVID-A7, RequestId `ebebd173`, trạng thái WORKING | `Exit Code: 0` |
| V3 | `grep qwen-docs` toàn `du-rework` | 6 hit: `dispatch-turn1.ps1:32,34,42,44`, `antigravity-coordinator-tick.ps1:28`, `coordinator-antigravity.md:67`. Dòng 42 là `Báo cáo vào coordination/reports/qwen-docs.md` → cơ sở chọn đường dẫn report, không phải memory của lane trước | `Exit Code: 0` |
| V4 | `grep '^## '` trong `codex6.md` | 7 header; **Cycle 140 ở dòng 109**, Cycle 139 ở dòng 70 → neo `#L109` dùng trong docs là số thật, không phải số ước lượng | `Exit Code: 0` |
| V5 | `grep '28-test-inventory.md#L\d+\|35-acceptance-baseline.md#L\d+'` toàn repo | 10 hit. Mọi neo bên ngoài đều ≤ **517** (docs/28) và ≤ **674** (docs/35) → chèn ở cuối file không làm dịch neo nào | `Exit Code: 0` |
| V6 | `grep 'v1\.\d+\.\d+'` trong hai docs | Cả hai đều `**Document Version:** 1.17.0` → bump lên 1.18.0 | `Exit Code: 0` |
| V7 | `Get-ChildItem -Filter *.log` trong `coordination/reports` | **`LOG_COUNT=49`**; đủ 5 log Cycle 140 (aggregate-1/2/3, regression-final, targeted) kèm size + mtime. **Đính chính một kết luận sai của chính lane** (xem mục Instrument caveat) | `Exit Code: 0` |
| V8 | `Select-String 'Test Suites:\|Tests:\|Time:'` trên 5 raw log Cycle 140 | aggregate-1/2/3: `1 skipped, 55 passed, 55 of 56 total` + `15 skipped, 1286 passed, 1301 total`, 36.185 s / 34.337 s / 35.397 s; regression-final: 8/8 suite, 189/189 test; targeted: 1/1 suite, 12/12 test → **khớp receipt** | `Exit Code: 0` |
| V9 | Đếm dòng/byte/mtime + đọc lại dòng 517/674 sau mọi lần vá | `docs/28` 538 dòng / 90260 B, `L517 = ### 8.16 D-EVID-A5 → A7 …`; `docs/35` 696 dòng / 124445 B, `L674 = ### 12.19 D-EVID-A5 → A7 …` → **anchor `codex4.md` còn đúng** | `Exit Code: 0` |
| V10 | `git status --porcelain du-rework/docs` | Cả hai ledger ở `??` (untracked) → bằng chứng bản vá là nội dung file, không phải `git diff`. 9 file ` M` khác là thay đổi có từ trước của lane khác, lane **không** đụng | `Exit Code: 0` |
| L1 | `C:\Users\Gem\AppData\Local\Temp\qwendocs-link-check.cmd` (pass 1, sau khi vá docs, chưa có report) | `REPORT_PRESENT=False`, `FILES=5 TARGETS=452 ANCHORS=237 BROKEN=0 EXTERNAL_SKIPPED=0`, marker `PSCAPE_EXIT=0` | `Exit Code: 0` (khớp marker) |
| L2 | Chạy lại lệnh trên (pass 2, sau khi thêm 10 link raw log) | `REPORT_PRESENT=False`, `FILES=5 TARGETS=462 ANCHORS=237 BROKEN=0 EXTERNAL_SKIPPED=0`, marker `PSCAPE_EXIT=0`. `TARGETS` +10 đúng bằng số link log vừa thêm, `ANCHORS` không đổi → mọi target mới resolve | `Exit Code: 0` (khớp marker) |
| L3 | Chạy lại lệnh trên sau khi ghi báo cáo này (pass 3, report đã có trong phạm vi) | `REPORT_PRESENT=True`, `FILES=6 TARGETS=462 ANCHORS=237 BROKEN=0 EXTERNAL_SKIPPED=0`, marker `PSCAPE_EXIT=0`. `FILES` 5→6 còn `TARGETS` **không đổi** so với L2 → bản thân báo cáo này không sinh thêm link/anchor sai | `Exit Code: 0` (khớp marker) |

### Instrument caveat (để coordinator/Reviewer không đọc sai số của lane)

- **Bẫy `glob` + `gitignore` — quan trọng nhất của cycle này.** Lane ban đầu dùng `glob` để kiểm `du-rework/coordination/reports/*.log` và nhận `0 file`, rồi **viết vào cả hai docs** rằng raw log của Cycle 140 "vắng mặt khỏi working tree" và chỉ trích được receipt. Câu đó **sai**: `du-rework/.gitignore` chứa `*.log`, và `glob` bỏ qua file gitignored. `Get-ChildItem -Filter *.log` cho `LOG_COUNT=49`. Câu sai đã bị sửa ở cả hai docs và thay bằng 10 link raw log thật. **Quy tắc: muốn chứng minh một file không tồn tại thì dùng `Test-Path`/`Get-ChildItem`, tuyệt đối không dùng `glob`.** Vì `*.log` bị gitignore, mọi link tới raw log trong docs là **bằng chứng local**: nó resolve được trên máy này nhưng sẽ treo sau khi commit/push ở máy khác — đã ghi rõ qualifier này trong row Cycle 140 của cả hai docs.
- **Bug của chính checker ở lần chạy đầu (L0, không dùng làm bằng chứng).** Bản đầu dựng mảng đường dẫn bằng `$root + '…', $root + '…'`. PowerShell parse đó thành **một** biểu thức `+` có mảng ở vế phải, nên 5 đường dẫn bị stringify và nối bằng dấu cách. Kết quả `FILES=0 TARGETS=0 ANCHORS=0 BROKEN=1`, marker `PSCAPE_EXIT=1`, `Exit Code: 1`. Sửa bằng đường dẫn literal tuyệt đối như bản gốc. Số ở L1–L3 đều đo từ bản đã sửa.
- **ExitCode phải đo qua wrapper `.cmd`.** `run_shell_command` có thể báo `Exit Code: 0` dù lời gọi `powershell` trực tiếp in lỗi, nên checker vẫn được gọi qua `.cmd` có `exit /b %errorlevel%` và in marker `PSCAPE_EXIT=` để hai số phải khớp nhau. Ở cả L1/L2 chúng khớp.
- **Checker chỉ resolve target tương đối + `file:///` và chỉ validate anchor dạng số `#L<n>`** (đếm dòng bằng `[IO.File]::ReadAllLines`). Anchor slug (`#heading`) và URL ngoài bị bỏ qua. Vì vậy `BROKEN=0` nghĩa là *không có target/line-anchor sai*, **không** phải "mọi link đúng mọi mặt". Phải nói đúng nghĩa này khi báo cáo.
- **Phạm vi check (5 file)**: `docs/28`, `docs/35`, `tasks/P8-release-readiness.md`, `tasks/README.md`, `coordination/reports/codex4.md`, cộng `qwen-docs.md` khi file này tồn tại. **Không** quét `qwen-new.md` vì đó là report của lane khác. Checker nằm ở `C:\Users\Gem\AppData\Local\Temp\qwendocs-link-check.ps1` + `.cmd`, ngoài repo.

### Trạng thái thật (4 mức, không tự nâng)

| Hạng mục | Mức sau bản vá này |
|---|---|
| Hồ sơ evidence `docs/28` §8.16, `docs/35` §12.19 | Đã cập nhật + tự kiểm link/anchor offline. Không phải bằng chứng test. |
| VAULT-04 / W-VAULT04-FIX1 | **VERIFIED-offline** theo receipt của owner (aggregate xanh ×3, số đã tự đọc lại từ raw log). **Chưa ACCEPTED**: không có live Vault/S3/DB, 1 suite + 15 test là skip theo gate `DU_LIVE_INFRA`, task row chưa tick. |
| Orchestrator lint (`@du/orchestrator`) | **Xanh theo probe mới nhất** (exit 0). Đỏ của Cycle 139 bị supersede nhưng **nguyên nhân chưa được adjudicate** — xem Δ dưới. |
| T-DATA-LIVE-4 (DATA-02 runtime) | Không đổi so với A6: VERIFIED-live trên pilot, **chưa ACCEPTED**; nhánh public vẫn không có live evidence. |
| Package `@du/connector` aggregate đỏ của Cycle 139 | **VẪN ĐỎ theo hồ sơ.** Bằng chứng A7 không đủ để đóng — xem mục dưới. |

### Việc còn / next owner

1. **Coordinator — cần quyết định (không tự ý làm trong lane này):**
   a. **Hai lane docs cùng sống**: `QwenNew` (`qwen-new.md`, đã xong A6) và `Qwen-Docs` (`qwen-docs.md`, phiên này). Cần nói rõ lane nào còn hoạt động để tránh hai lane sửa cùng một section.
   b. **Roster của coordinator đang ghi packet kế tiếp là `D-EVID-A10`** (`coordinator-antigravity.md:55`: đồng bộ `docs/19`, `docs/28`, `docs/35`), trong khi packet tôi nhận là A7. Nếu A10 là packet kế thì nó có thể nuốt phần việc còn mở dưới đây.
   c. **Chọn chế độ đi kèm raw log**: vì `*.log` bị gitignore, link tới raw log trong docs sẽ treo sau commit. Nếu muốn bằng chứng đi theo commit thì cần quyết định: bỏ link log khỏi docs, un-ignore `*.log`, hoặc chuyển log sang thư mục được track.
2. **DATA-lane owner (theo đúng đề nghị trong probe, lane không tự làm):** xác nhận việc đổi cursor của `s3-storage-facade.ts` sang `string` **có chủ ý không**, rồi refresh receipt lint trên cùng source snapshot đó và hòa giải ghi chú Cycle 139 với kết quả mới. Cho tới lúc đó, `docs/28`/`docs/35` chỉ ghi "lệnh xanh trên cây hiện tại", không ghi "đã giải thích nguyên nhân".
3. **Package `@du/connector` — gate đỏ CHƯA đóng, cần packet riêng:** đỏ của Cycle 139 (2 suite / 3 test, `EADDRINUSE`/`ETIMEDOUT`) thuộc **package khác** với aggregate Cycle 140 (chạy trong `services/orchestrator`), nên A7 không đóng được. Lưu ý: `tester-antigravity.md` dòng 133 đã có receipt `T-ANTIG-2` (Connector exit 0, 19 pass / 2 skip, 219 passed / 7 skipped, 0 flake) có thể phủ đỏ này — nhưng **packet A7 không liệt kê nguồn đó** nên lane cố ý **không** chép vào docs. Cần coordinator giao packet nếu muốn ghi.
4. **Reviewer:** câu hỏi còn mở về provenance cursor (mục 2) là việc thẩm định độc lập, không phải việc của lane docs.


---

## 2 — CYCLE 2: D-EVID-A10 (docs-only ledger sync cho T-CODEX-TEST-1 + W-DATA02-PUB-2 + đánh dấu gate)

- **Packet**: `D-EVID-A10` — đồng bộ `docs/28-test-inventory.md` và `docs/35-acceptance-baseline.md` với (1) receipt Tester `T-CODEX-TEST-1`, (2) receipt Qwen-DATA `W-DATA02-PUB-2`, (3) đánh dấu các ranh giới gate còn mở; chạy offline local link check; không sửa source sản phẩm, không chạy test, không đụng DB.
- **Nguồn đã đọc**: `tester.md` (T-CODEX-TEST-1, dòng 7275–7282) + 3 raw log của nó, `qwen-data.md` (mục 1 + Δ-DEVIATION), `du-rework/AGENTS.md` (đọc lại, không đổi), `docs/28`/`docs/35` toàn văn trước khi vá.
- **Thời điểm**: 2026-09-26 ~00:50–01:1x +07.

### Phát hiện trước khi vá — hai file này CÓ người viết khác

Đếm mtime ngay trước A10 cho thấy `docs/28` và `docs/35` đã bị sửa lúc **00:45:36**, tức là **sau khi A7 của chính lane này chốt lúc 00:26:33**. Grep xác định chính xác thay đổi đó: một row `Codex-Security W-VAULT01-BIND-1` mới được chèn vào `docs/35` dòng 684 (Contracts 59/59; Connector 4 suites / 66), và một row ở `docs/28` dòng 348 được cập nhật theo cùng nội dung. Đây **không phải** việc của lane này.

Xử lý: lane **không sửa, không xoá, không viết lại** row của lane khác; chỉ append row mới **sau** chúng, và chỉnh các câu của chính section do lane phụ trách. Đếm lại `L517`/`L674` sau thay đổi của lane khác → **vẫn đúng**, vì họ chèn ở dòng 684 (sau 674) và sửa tại chỗ dòng 348 của `docs/28`.

### Ba mục packet — kết quả

| # | Mục packet | Kết quả | Ghi chú |
|---|---|---|---|
| 1 | Tester `T-CODEX-TEST-1` | **ĐÃ LAND** | Contracts build exit 0, Connector typecheck exit 0, `vault-account-isolation` + `secret-resolver` **2 suite / 28 passed, 0 failed, 0 skipped**, 9.323 s, exit 0. **Tự đọc lại từ cả 3 raw log.** |
| 2 | Qwen-DATA `W-DATA02-PUB-2` | **ĐÃ LAND** | Review-only, 0 diff source. 2 suite `82/82` **exit 0 ×3** (routes 30 + service 52), guard-pin 5/5 exit 0, lint exit 0. **Không có raw log** — số liệu chỉ trích nội tuyến. |
| 3 | Đánh dấu ranh giới gate còn mở | **ĐÃ LAND** | Thêm 2 dòng *Open gate* vào **mỗi** file: DATA-02 public live, VAULT-01 binding. Viết lại dòng `Acceptance boundary` của `docs/35` và thêm Δ5 vào danh sách Δ chưa adjudicate. |

### Ranh giới quan trọng đã ghi rõ (không nâng mức)

- **82 / 102 / 104 là ba scope khác nhau, không cộng.** 82 (PUB-2: `routes 30 + service 52`) là **tập con** của 104 (T-ANTIG-1/1B: 52+30+16+6), và cả hai khác 102 (W49-Q5R-1: 4 suite). Đã ghi ở cả hai docs.
- **T-CODEX-TEST-1 không đóng được đỏ package `@du/connector`.** Nó chỉ chạy lại 2 suite mục tiêu; lệnh full-package của Cycle 139 (2 suite / 3 test đỏ, `EADDRINUSE`/`ETIMEDOUT`) không được chạy lại. Receipt full-package `T-ANTIG-2` (`tester-antigravity.md` dòng 133) vẫn **không nằm trong nguồn của A10** nên lane tiếp tục không chép — cần packet riêng.
- **`pnpm.ps1` `NativeCommandError` là artifact wrapper**, không phải lỗi test: log in ra dòng đó ngay cạnh `PASS`, và process ExitCode là 0. Đã ghi để không ai đọc nhầm là đỏ.
- **Không có receipt nào gọi `POST /api/v1/uploads`.** Đây là lý do gate DATA-02 public live vẫn OPEN, dù có một suite live xanh 5/5 ×2.

### Bug của chính lane (đã tự phát hiện và sửa)

Khi chèn 4 row mới vào `docs/28` bằng cách neo vào **đoạn kết** nằm ngay sau bảng, lần đầu tôi thêm cả một dòng trống dẫn trước → **dòng trống cắt đứt bảng markdown**, 4 row mới rơi thành một bảng riêng không có header. Phát hiện ngay khi đọc lại kết quả edit, đã sửa bằng cách gộp lại liền mạch và kiểm bằng link check. **Quy tắc: khi append row vào bảng bằng `edit`, không được chèn dòng trống.**

### Bằng chứng lệnh đã chạy (đọc; không lệnh nào là test)

| # | Lệnh | Kết quả đo được | Exit Code |
|---|---|---|---|
| V11 | Đếm dòng/byte/mtime 2 docs + report ngay trước A10 | `docs/28` 538 dòng / 91124 B / **00:45:36**; `docs/35` 697 / 125448 B / **00:45:36**; `qwen-docs.md` 98 / 16755 B / 00:28:15 → phát hiện 2 docs đã bị lane khác sửa sau A7 | `0` |
| V12 | `grep 'W-VAULT01-BIND-1\|BIND-1R\|T-ANTIG-2'` trong 2 docs | 5 hit; xác định row lạ của lane khác: `docs/35` dòng **684**, `docs/28` dòng **348** | `0` |
| V13 | Đọc lại `L517`/`L674` sau thay đổi của lane khác | `docs/28 L517 = ### 8.16 …`; `docs/35 L674 = ### 12.19 …` → anchor `codex4.md` chưa bị dịch | `0` |
| V14 | `Get-ChildItem -Filter *.log`, lọc `T-CODEX-TEST-1` | 3 log kèm size/mtime (1686 / 228 / 202 B) | `0` |
| V15 | `Get-Content` cả 3 raw log T-CODEX-TEST-1 | `Test Suites: 2 passed, 2 total` / `Tests: 28 passed, 28 total` / `Time: 9.323 s`; hai log build+typecheck chỉ có dòng lệnh `tsc`, không output | `0` |
| V16 | `Get-ChildItem -Filter *.log`, lọc `PUB-2\|pub2\|qwen-data` | **0 file** → receipt W-DATA02-PUB-2 không có raw log nào; đã ghi vào docs là thiếu bằng chứng thô | `0` |
| V17 | Đếm section `qwen-data.md` | `TOTAL=64`; `## 1 — PACKET W-DATA02-PUB-2` ở dòng **12**, `## Δ-DEVIATION` ở dòng **52** → neo `#L12`/`#L52` dùng trong docs là số thật | `0` |
| V18 | Đếm dòng/byte/mtime + `L517`/`L674` sau khi vá A10 | `docs/28` 542 dòng / 95798 B / 01:07:01; `docs/35` 701 / 129510 B / 01:07:29; **L517 và L674 vẫn đúng** | `0` |
| L4 | `C:\Users\Gem\AppData\Local\Temp\qwendocs-link-check.cmd` (sau A10) | `REPORT_PRESENT=True`, `FILES=6 TARGETS=492 ANCHORS=249 BROKEN=0 EXTERNAL_SKIPPED=0`, marker `PSCAPE_EXIT=0` | `0` (khớp marker) |

### Instrument caveat

- Checker vẫn chỉ resolve path tương đối + `file:///` và chỉ validate anchor `#L<n>`; `BROKEN=0` nghĩa là *không có target/line-anchor sai*, không phải "mọi link đúng mọi mặt". Anchor slug và URL ngoài vẫn bị bỏ qua.
- `TARGETS` 462 → 492 giữa hai lần chạy **không chỉ** do row của A10: nó còn tính cả link raw log mà lane Codex-Security thêm lúc 00:45:36. Lane chỉ ghi số đo, không quy kết từng link cho từng lane.
- Vẫn dùng `Get-ChildItem`, **không** dùng `glob`, để kiểm file log (bài học từ A7 — `*.log` bị gitignore nên `glob` ẩn mất chúng).
- Các raw log mới trích trong docs đều là file `*.log` bị gitignore → resolve được local nhưng sẽ treo sau commit; qualifier này đã nằm ở row Cycle 140 và được áp dụng nhất quán cho row mới.

### Trạng thái thật sau A10 (không tự nâng)

| Hạng mục | Mức |
|---|---|
| VAULT-01 / T-CODEX-TEST-1 | VERIFIED-offline cho 2 suite mục tiêu (28/28) — **không** phải acceptance; gate binding vẫn `[ ]` |
| DATA-02 public branch | IMPLEMENTED + VERIFIED-OFFLINE, vẫn `[~]`; **public live vẫn chưa có** bằng chứng |
| Δ | Δ1–Δ3 (cũ) + **Δ5** (mới, ledger retention) + Δ provenance cursor: **đều chưa adjudicate** |
| Hồ sơ evidence | Đã cập nhật + link check sạch. Không phải bằng chứng test. |

### Việc còn / next owner

1. **Coordinator**: (a) xác nhận phân quyền khi **nhiều lane cùng ghi `docs/28`/`docs/35`** — lần này đã có va chạm thật; (b) quyết định có giao packet ghi `T-ANTIG-2` vào docs hay không, vì đó là thứ duy nhất phủ được đỏ package `@du/connector`; (c) xử lý chính sách `*.log` bị gitignore.
2. **Tester**: packet live DATA-02 public (fixture >64 MiB, gọi thật `init → part → complete → submit` trên `/api/v1/uploads`, CLAIM/RELEASE) là điều kiện duy nhất đóng gate public.
3. **Owner + Reviewer**: migration 008 trên PostgreSQL thật + Vault policy thật cho VAULT-01; adjudicate Δ1–Δ3, Δ5, Δ cursor.

---

## 3 — CYCLE 3: D-EVID-A11 (docs-only ledger sync cho T-ANTIG-2 + T-CODEX-TEST-2 + qualification Reviewer Turn 20)

**Packet.** Antigravity coordinator `term_8ba9a7d5`, `[PACKET D-EVID-A11]`. Nguồn được packet chỉ định: `coordination/reports/tester-antigravity.md` (T-ANTIG-2), `coordination/reports/tester.md` (T-CODEX-TEST-2), `coordination/reports/review.md` (Turn 20 / T20-V1). Ràng buộc: chỉ sửa `docs/28` + `docs/35`, không commit/push.

### Trước khi vá — đọc lại state của hai file

| File | lines | bytes | mtime | kết luận |
|---|---|---|---|---|
| `docs/28-test-inventory.md` | 542 | 95798 | 2026-09-26 01:07:01 | khớp đúng số liệu A10 → **không ai sửa sau A10** |
| `docs/35-acceptance-baseline.md` | 701 | 129510 | 2026-09-26 01:07:29 | khớp đúng số liệu A10 → **không ai sửa sau A10** |

Khác với A10, lần này **không có va chạm nhiều người ghi**. Nhưng `codex6.md` đã dài 141 → 208 dòng, nên lane đọc thêm 3 receipt mới (`W-VAULT01-ORCH-BIND-1` dòng 142, `W-VAULT01-TRUST-ORIGIN-1` dòng 164, `W-VAULT02-POL-1` dòng 188) để không ghi sai câu chữ về writer path.

### Ba mục packet — kết quả

| # | Mục packet | Kết quả |
|---|---|---|
| 1 | Cập nhật T-ANTIG-2 | Row mới ở cả 2 file. `19 suites passed / 2 live-gated skipped; 219 tests passed / 7 skipped; ExitCode 0`, cộng `Snapshots: 0 total` và `Time: 8.781 s`. Ghi rõ 2 suite skip là `tests/durable-integration.test.ts` + `tests/black-box-durable.test.ts` (gate live `CONNECTOR_INTEGRATION`) → **`SKIP ≠ PASS`** |
| 2 | Cập nhật T-CODEX-TEST-2 | Row mới ở cả 2 file. Orchestrator aggregate `1 skipped, 57 passed, 57 of 58 total` / `15 skipped, 1342 passed, 1357 total`, ExitCode 0; Contracts `tests/vault-ref.test.ts` `1 passed, 59 passed, 59 total`, ExitCode 0 |
| 3 | Ghi nhận qualification Reviewer Turn 20 (T20-V1) | Row mới ở cả 2 file, ghi đúng verdict của Reviewer: `MISMATCH; VAULT-01, VAULT-03 and G-SEC HOLD`, và nêu rõ **không markdown nào đóng được gate này** |

### Điểm phải xử lý cẩn thận — T20-V1 (01:15) và Codex-6 (01:20) trái chiều thời gian

Reviewer audit lúc **01:15** kết luận writer path lấy `tenantId`/`accountId` từ chính `source.path`/`source.account` của caller → là *một field riêng*, **không phải nguồn tin cậy độc lập**. `codex6.md:164` (`W-VAULT01-TRUST-ORIGIN-1`) viết lúc **01:20**, **sau** audit, tuyên bố đã sửa đúng điểm đó.

Lane đọc cả hai raw log để phân giải:

| Raw log | Jest summary |
|---|---|
| `codex6-orchestrator-offline-tests.log` (ORCH-BIND-1) | `Test Suites: 2 passed, 2 total` / `Tests: 39 passed, 39 total` |
| `codex6-W-VAULT01-TRUST-ORIGIN-offline-tests.log` (TRUST-ORIGIN-1) | `Test Suites: 2 passed, 2 total` / `Tests: 39 passed, 39 total` |

→ **Cùng 39 test, chạy lại 2 lần. Không phải 78.** Cả hai đều là owner-reported, offline, chưa Reviewer thẩm định. Vì vậy cả hai docs ghi nó theo dạng *đã ghi nhận, chưa chấp nhận*, và giữ `VAULT-01 / VAULT-03 / G-SEC` ở **HOLD / `[ ]`**.

### Sửa cải lỗi 2 điểm Reviewer nêu trong T20-E1

1. **Row gate VAULT-01 bị thu hẹp, không bị đảo ngược.** Cả hai file vẫn nói writer "chưa gửi field". Nay thêm câu: writer **đã** gửi `tenantId`/`accountId`, khoảng trống không còn là *thiếu field* mà là *origin chưa tin* — gate vẫn **OPEN**.
2. **Đỏ package Cycle 139 không còn là trạng thái offline mới nhất.** `Acceptance boundary` trước này nói "vẫn chưa đóng". Nay sửa thành **superseded ở phạm vi offline full-package** nhờ T-ANTIG-2, kèm câu rõ 2 suite `CONNECTOR_INTEGRATION` vẫn là skip. Không tick task row, không nâng ACCEPTED.

### Bằng chứng lệnh đã chạy (đọc; không lệnh nào là test)

| ID | Lệnh | Kết quả |
|---|---|---|
| V11 | `Get-ChildItem coordination/reports -Filter *.log` | `LOG_COUNT=66` — dùng để **chứng minh log tồn tại**, không dùng `glob` (bẫy gitignore) |
| V12 | đọc `T-CODEX-TEST-2-orchestrator.log` | `1 skipped, 57 passed, 57 of 58 total` / `15 skipped, 1342 passed, 1357 total` |
| V13 | đọc `T-CODEX-TEST-2-contracts.log` | `1 passed, 1 total` / `59 passed, 59 total` |
| V14 | đọc `%TEMP%\T-ANTIG-2-connector-jest-20260925.log` | `2 skipped, 19 passed, 19 of 21 total` / `7 skipped, 219 passed, 226 total` / `Snapshots: 0 total` / `Time: 8.781 s` |
| V15 | đọc `codex6.md` dòng 142/164/188 | 3 receipt mới; TRUST-ORIGIN-1 tuyên bố xử lý T20-V1 |
| V16 | đọc `review.md` dòng 3/11/17/24 | T20-V1 (HIGH), T20-E1 (MEDIUM), gate decision |
| V17 | đọc `codex6-orchestrator-offline-tests.log` | `2 passed, 2 total` / `39 passed, 39 total` |
| V18 | đọc `codex6-W-VAULT01-TRUST-ORIGIN-offline-tests.log` | `2 passed, 2 total` / `39 passed, 39 total` → **cùng 39 case** |
| V19 | `[IO.File]::ReadAllLines` trên cả 2 docs sau mọi lần vá | `docs/28` 546 dòng, L517 đúng header; `docs/35` 705 dòng, L674 đúng header |
| V20 | link/anchor check `qwendocs-link-check.cmd` | `FILES=6 TARGETS=516 ANCHORS=269 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 |

### Instrument caveat

- Raw log của T-ANTIG-2 nằm ở `%TEMP%`, **ngoài repo** → ghi bằng text thuần, **không link**, để không sinh link gãy. Nó cũng **không phải bằng chứng bền** (đúng điều T20-E1 nêu cho `*.log` gitignored).
- `NativeCommandError` trong log của T-CODEX-TEST-2 là `npx.ps1`/`pnpm.ps1` wrapper chuyển stderr của Jest, không phải Jest fail.
- `SKIP ≠ PASS`: 2 suite / 7 test của T-ANTIG-2 và 1 suite / 15 test của T-CODEX-TEST-2 là **chưa đo**, không phải xanh.
- **Ba aggregate Orchestrator** nay cùng tồn tại (1248 / 1301 / 1357) vì khác lệnh và khác tree state → **không gộp, không cộng**.

### Trạng thái thật sau A11 (không tự nâng)

| Mức | Nội dung |
|---|---|
| SPECIFIED | không đổi |
| IMPLEMENTED | không đổi — lane này không sửa source |
| VERIFIED | `T-ANTIG-2` = VERIFIED-offline **full package**; `T-CODEX-TEST-2` = VERIFIED-offline **full Orchestrator aggregate** + Contracts vault-ref. Cả hai đều offline |
| ACCEPTED | **không đổi, không có gì được nâng**. Reviewer: `NO-GO` cho G-SEC, G-DATA, G-ADMIN-OPS, G6 |

### Việc còn / next owner

1. **Coordinator** (cần quyết định): có chấp nhận cách lane ghi `W-VAULT01-TRUST-ORIGIN-1` là *đã ghi nhận, chưa chấp nhận* không; và ai là người **serialize** ghi `docs/28`/`docs/35` (T20-E1 yêu cầu một docs owner duy nhất, hiện chưa có cơ chế cưỡng chế).
2. **Reviewer**: T20-V1 cần một lần thẩm định lại sau receipt 01:20 của Codex-6 — hoặc xác nhận HOLD, hoặc yêu cầu bằng chứng thêm. Đây là đường duy nhất để `W-VAULT01-TRUST-ORIGIN-1` trở thành VERIFIED.
3. **Tester**: VAULT-01 vẫn cần migration 008 trên PostgreSQL thật + Vault policy thật; DATA-02 vẫn cần live public `init → part → complete → submit` trên `/api/v1/uploads`.
4. **Evidence owner**: chính sách `*.log` — hiện log receipt không đi theo commit, nên release evidence phải có nơi lưu bền.
5. **Ngoài phạm vi packet A11, đã có thêm receipt mới** (không tự ý chép, chờ packet): `codex6.md` dài 208 → **280** dòng, thêm `W-VAULT06-LIFECYCLE-1` (210), `W-VAULT05-INTEG-1` (233), `W-VAULT04-CONF-1` (258); `tester.md` dài 7298 → **7345** dòng, thêm `T-CODEX-TEST-3` (7292), `-4` (7300), `-5` (7309), `-7` (7318), `-8` (7327), `-6` (7338). Đây là 9 receipt hoàn toàn **ngoài** 3 nguồn packet A11 nêu — lane chỉ ghi nhận sự tồn tại của chúng trong mục này. **→ Cả 9 receipt này đã được ghi vào docs ở cycle A12 (Mục 4).**

---

## 4 — CYCLE 4: D-EVID-A12 (docs-only ledger sync cho Wave 2/3 receipts + Reviewer Turn 30)

**Packet.** Antigravity coordinator `term_8ba9a7d5`, `[PACKET D-EVID-A12]`. Scope: `codex6.md` (W-VAULT06-LIFECYCLE-1, W-VAULT05-INTEG-1, W-VAULT04-CONF-1, W-SEC-SINK-1), `tester.md` (T-CODEX-TEST-3..8), `qwen-sec.md` (W-ADMBASE03-ERR-1), và Reviewer Turn 30. Chỉ sửa `docs/28` + `docs/35`, không commit/push.

### Trước khi vá

| File | lines | bytes | mtime | kết luận |
|---|---|---|---|---|
| `docs/28-test-inventory.md` | 546 | 102420 | 01:40:10 | khớp A11 → không ai sửa sau A11 |
| `docs/35-acceptance-baseline.md` | 705 | 137099 | 01:40:55 | khớp A11 → không ai sửa sau A11 |

**Không có va chạm nhiều người ghi** ở cycle này (khác A10, đã có va chạm thật).

### Điểm lớn nhất — Turn 30 gỡ chính cái HOLD mà A11 đã ghi

A11 ghi `VAULT-01, VAULT-03 and G-SEC HOLD` theo Turn 20 và liệt kê *"Reviewer thẩm định lại sau receipt 01:20 của Codex-6"* là next-owner. **Turn 30 (`review.md:3`, Wave 2/3) đã làm đúng việc đó:**

- **T20-V1 resolved** at the reviewed code boundary, **offline VERIFIED** — `workflow.ts` load revision active trước, yêu cầu binding Migration 008, so sánh ref ứng viên với binding đã lưu, dựng canonical path từ binding, **chỉ** gọi `writeCas` sau đó; `dispatcher.ts` resolve connector ownership và fence tenant operator.
- **T20-S1 resolved** cho live matrix — `admin-action-rbac-live.test.ts` **12/12** (D1–D4, M1–M6, X1–X2), build ExitCode 0, window CLAIM **08:21:11.621** → RELEASE **08:21:30.101 +07** ngày 2026-09-25.
- **Release: NO-GO cho G-SEC, G-DATA, G-ADMIN-OPS, G6.**

Cả hai docs đều ghi công cho **Reviewer**, không tự nhận công. Dòng gate VAULT-01 được **thu hẹp lần thứ hai**: phần còn thiếu không còn là "writer chưa gửi field" hay "origin chưa tin" mà là **bằng chứng live** — migration 008 trên PostgreSQL thật + legacy round-trip, Vault writer/reader policy thật, zero-write với tenant/account nước ngoài, và writer Admin→Orchestrator→Connector trên identity đã deploy.

### Nhưng Turn 30 cũng MỞ đỏ mới — `prevCursor`

`listOperationsPage` tính `prevCursor` bằng `(created_at,id) < firstRow`, trong khi điều hướng descending dùng `< cursor` để đi tới. Trang 2 bấm Previous có thể **nhảy sang trang sau**. Đây là **source finding**, không phải test đỏ. Nó **mới hơn** aggregate xanh T-CODEX-TEST-2 → theo `du-rework/AGENTS.md` ("receipt đỏ mới hơn giữ gate mở dù có receipt xanh lịch sử"), gate giữ mở. Đã thêm dòng *Open gate* riêng cho ADM-UX-02/03 + G-ADMIN-OPS.

### Bẫy con số — cùng một bộ test, nhiều packet

| Bộ test | Xuất hiện ở | Số lần |
|---|---|---|
| 2 suite / **39** (connector-credentials + admin-actions-vault04) | ORCH-BIND-1, TRUST-ORIGIN-1, W-VAULT06-LIFECYCLE-1, W-VAULT04-CONF-1 | 4 |
| 4 suite / **49** (vault-account-isolation + vault-machine-policies + secret-resolver + token-renewal) | W-VAULT05-INTEG-1, W-VAULT04-CONF-1, W-SEC-SINK-1 | 3 |
| 1 suite / **22** (`@du/observability`) | T-CODEX-TEST-8, W-SEC-SINK-1 | 2 |

Tất cả là **cùng case chạy lại ở các source state khác nhau**. `88` trong W-VAULT04-CONF-1 = 49 + 39 **của chính packet đó**, không phải grand total. T3 (109 + 40) chồng lên T7 (203) và lên cặp 39. **Không cộng ở bất kỳ chỗ nào trong 2 file.**

### Bằng chứng lệnh đã chạy (đọc; không lệnh nào là test)

| ID | Lệnh | Kết quả |
|---|---|---|
| V21 | đếm lines/bytes/mtime `docs/28` + `docs/35` | 546/102420 và 705/137099 → **không va chạm** |
| V22 | đọc `codex6.md` 210–305 | 4 receipt mới: LIFECYCLE (210), INTEG (233), CONF (258), SEC-SINK (282) |
| V23 | đọc 8 raw log `T-CODEX-TEST-3..8` | 109/40, 56, 105, 152, 203 (134.116 s), 22, 34 — **khớp receipt 100%** |
| V24 | đọc 8 raw log Codex-6 mới | 39, 25, 49, 49, 39, 43, 49, 22 — **khớp receipt 100%** |
| V25 | `Get-ChildItem codex6-W-SEC-SINK*` | tên file thật là `-orchestrator-security-tests.log` và `-connector-security-tests.log`, **không** phải `-tests.log` như trong bảng receipt |
| V26 | đọc `qwen-sec.md` 96–139 | W-ADMBASE03-ERR-1: 137/137 ×3, suite mới 21/21, lint 0, Δ5/Δ6/Δ7 |
| V27 | đọc `review.md` 1–38 | Turn 30: T20-V1 resolved, T20-S1 resolved, T20-A1 regression, T20-D1/D2 open, NO-GO |
| V28 | `Select-String` **toàn bộ** `coordination/reports/*.md` tìm 2 receipt live Turn 30 viện dẫn | tìm thấy ở `tester.md:3059–3130`, **không** ở `tester-antigravity.md`; đã đọc để xác minh |
| V29 | `[IO.File]::ReadAllLines` sau mọi lần vá | `docs/28` 554 dòng L517 đúng; `docs/35` 713 dòng L674 đúng; 34 / 36 data row liên tục |
| V30 | `qwendocs-link-check.cmd` | `FILES=6 TARGETS=617 ANCHORS=318 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0` |

### Điều phải nói thẳng với coordinator

1. **Hai receipt live mà Turn 30 viện dẫn không nằm trong scope packet A12.** Lane tự truy ra `tester.md:3059–3130` để xác minh thay vì ghi citation mù. Cảnh báo quan trọng: `admin-error-boundary.test.ts` **1/1** nằm trong window RR-Q3-3/RR-Q3-4 mà **webhook fence đỏ 2/2**, `runtime.test.ts` **lỗi compile**, p8-04 **17/26**. 1/1 xanh **không** được đọc thành ADM-BASE-03 xanh.
2. **Mâu thuẫn snapshot chưa ai adjudicate**: Qwen-SEC Δ5 nói `dispatcher.ts` còn `String(err)`; Codex-6 W-SEC-SINK-1 nói đã xoá; **Reviewer Turn 30 vẫn mô tả nó là đang có**. Hai docs ghi "appears addressed, cần Reviewer xác nhận" — lane không tự kết luận.
3. **Sai lệch của chính lane**: block A12 trong `docs/28` nằm **trên** block A11 vì neo vào dòng gate. Đã ghi rõ trong docs thay vì xoá/ghi lại row (nguy cơ mất việc lane khác). `docs/35` đúng thứ tự append.
4. **Turn 30 yêu cầu serialize lần docs kế tiếp sau closeout packet A–D** và **không chép aggregate total vào task status** — cả hai đã tuân thủ trong cycle này.

### Instrument caveat

- `NativeCommandError` trong log T-CODEX-TEST-3..8 là wrapper `pnpm`/`npx` PowerShell, không phải Jest fail.
- `SKIP ≠ PASS`: các receipt này **không có** skipped nào, nhưng cũng **không có** test live nào — 0 skip không phải bằng chứng phủ live.
- `tests/unit/sentinel-sink-matrix.test.ts` **không chạy** (không có Jest binary ở workspace root) → ghi là khoảng trống phủ.
- T-CODEX-TEST-8 egress: lần đầu đỏ `EADDRINUSE` 2 failed/32 passed, lần chạy lại xanh 34/34; **giữ cả hai** trong docs.
- 12/12 của `admin-action-rbac-live` là receipt **ngày 2026-09-25**, không phải run Wave 2/3; nó supersede nhiều lần FAIL trước đó của cùng suite, những lần FAIL giữ làm lịch sử.

### Trạng thái thật sau A12 (không tự nâng)

| Mức | Nội dung |
|---|---|
| SPECIFIED | không đổi |
| IMPLEMENTED | không đổi — lane này không sửa source |
| VERIFIED | 4 packet Codex-6 + 6 receipt Tester + W-ADMBASE03-ERR-1 đều **VERIFIED-offline**. **T20-V1 resolved offline** và **T20-S1 resolved (live, exact scope)** theo Reviewer |
| ACCEPTED | **không đổi, không gì được nâng**. Reviewer: **NO-GO** G-SEC, G-DATA, G-ADMIN-OPS, G6 |

### Việc còn / next owner

1. **Reviewer**: xác nhận hoặc phủ nhận mâu thuẫn snapshot `dispatcher.ts` `String(err)` (mục 2 ở trên), và tách riêng `sentinel-sink-matrix.test.ts` chưa chạy.
2. **Tester**: closeout packet C — migration 008 trên PG thật + Vault writer/reader policy thật + zero-write tenant/account nước ngoài. Đây là đường duy nhất đóng được phần live của VAULT-01/03.
3. **Platform/Admin owner**: closeout packet A — sửa `prevCursor` hoặc chứng minh ngược lại, rồi có test biên 1→2→1.
4. **Tester + DATA owner**: closeout packet B — public `/api/v1/uploads` trên PG/S3 thật với credential đúng, và URL→ingestion→READY cho DATA-03.
5. **Coordinator**: xem xét đường lưu bền cho raw log (`*.log` vẫn bị gitignore → **không phải release evidence di động**).
6. **Một receipt mới lọt vào giữa cycle, NGOÀI scope A12 — cần packet mới**: `T-CODEX-TEST-9` (2026-09-26 02:06:23 +07, `tester.md:7338`) ghi vào **sau** lúc lane đã đọc `tester.md` và **sau** lúc đã vá xong docs. Nội dung: Connector `tests/revision-binding.schema.test.ts` **9/9** exit 0; Contracts `tests/vault-ref.test.ts` **59/59** exit 0; contracts build + connector typecheck exit 0; offline, không claim window. **Lưu ý khi đọc lần sau:** 59/59 này là **lần thứ ba** của cùng suite `vault-ref.test.ts` (đã có ở T-CODEX-TEST-2 và `W-VAULT01-BIND-1`) → corroboration, **không cộng**. `codex6.md` cũng dài 280 → 305 nhưng **không** có packet `W-` mới.

## 5 — CYCLE 5: D-EVID-A13 (Reviewer Packet 1 & 5: docs/06 contract sync + Turn 40 verdict)

**Packet.** Antigravity coordinator `term_8ba9a7d5`, `[PACKET D-EVID-A13]`. Ba deliverable: (1) cập nhật `docs/06-public-api.md` cho contract `GET /api/v1/operations` hiện hành — envelope `{items, nextCursor, prevCursor, total, limit}`, tham số `state/tenant/id/cursor/limit`, cursor mang hướng `ISO|uuid[|p]`; (2) ghi verdict Reviewer Turn 40 vào `docs/28` + `docs/35`; (3) chạy `qwendocs-link-check.cmd` với đích `BROKEN=0`. Rules: docs only, no commit, no push. Ràng buộc lane vẫn áp dụng: không source, không test, không chạy test, không window DB/Redis/S3/Vault, không tick row, không nâng ACCEPTED, không adjudicate Δ.

### Trước khi vá

| File | lines | bytes | mtime | kết luận |
|---|---|---|---|---|
| `docs/06-public-api.md` | 78 | 5401 | 2026-09-21 00:11:56 | **chưa ai đụng từ 21/09** — còn contract cũ |
| `docs/28-test-inventory.md` | 554 | 116694 | 2026-09-26 01:59:28 | khớp A12 → không ai sửa sau A12 |
| `docs/35-acceptance-baseline.md` | 713 | 151331 | 2026-09-26 02:00:18 | khớp A12 → không ai sửa sau A12 |
| `coordination/reports/review.md` | 566 | 193287 | 2026-09-26 02:36:45 | **Turn 40 đã land ở ĐẦU file** (L3–L36) |
| `coordination/reports/tester.md` | 7364 | 376558 | 2026-09-26 02:11:47 | 7355 → 7364, có receipt mới |
| `coordination/reports/qwen-sec.md` | 199 | — | 2026-09-26 02:19:28 | 139 → 199, đã có OIDC-04 cycle |

### Deliverable 1 — `docs/06-public-api.md`

Không chép lời Reviewer. Đọc thẳng `services/orchestrator/src/server.ts`:

| Nơi | Nội dung |
|---|---|
| route L1180–1208 | 2 auth path dùng **chung một** contract; api-key path fence bằng key, `tenant` lệch → **403** |
| `parseOperationsListQuery` L2182 | allow-list `limit, state, tenant, id, cursor`; `limit` clamp, 4 tham số còn lại **422** |
| `OPERATIONS_LIST_*` L2065–2068 | default 20, max 100, cursor ≤128 ký tự |
| `OPERATIONS_STATE_FILTER_STATES` L2089 | `ALL` **không** nằm trong bản đồ ⇒ wire không nhận `ALL` |
| `sanitizeOperationsListToken` L2219 | charset `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`, chặn hex ≥32 |
| `bindOperationsCursor` L2267 | `prev` → `>`, `next` → `<` trên `(created_at, id)` |
| `listOperationsPage` L2297 | probe `limit+1`, reverse slice, `count(*)` trên tập đã lọc, envelope 5 field |
| `toOperationView` `facade.ts:32` | item shape = OperationView, dùng chung với `GET /operations/{id}` |

Sửa: dòng catalog + mục mới `## GET /operations — filter, keyset cursor, envelope`. **Không thêm markdown link nào** (file này vốn link-free, và không nằm trong phạm vi link check), mọi tham chiếu source để dạng `path:line` trong backtick.

### Deliverable 2 — hai inventory

- `docs/28` §8.16: header `A5 → A13`, v1.22.0, **9 row mới** neo ngay dưới dòng gate `prevCursor` mà chúng thu hẹp (Turn 40 verdict · T40-A1 resolved · Qwen-Admin W-ADMUX02-SRV-1-FIX · filter wire + docs/06 sync · DATA-02 · DATA-03 · OIDC scope · redaction + claim-shape · evidence hygiene).
- `docs/35` §12.19: header `A5 → A13`, v1.22.0, **7 row mới** chèn trước dòng `Acceptance boundary`, cùng nội dung ở dạng disposition.
- Dòng gate `prevCursor` ở **cả hai file** được ghi thêm mệnh đề thu hẹp trỏ tới row Turn 40, thay vì xoá — giữ lịch sử đúng quy ước receipt.
- `Acceptance boundary`: `Still open after A12` → `after A13`, câu về `prevCursor` viết lại theo Turn 40, thêm câu "Added in A13", thêm `[Turn 40 verdict]` vào danh sách nguồn.

### Sai lệch phát hiện được — anchor tụt

Turn 40 chèn ở **đầu** `review.md`, đẩy mọi thứ xuống ~35 dòng. **25 anchor `review.md#L…` mà lane này viết ở A11/A12 đã trỏ sai dòng** (ví dụ `[T20-V1 row](#L15)` giờ rơi vào bảng của Turn 40 thay vì hàng T20-V1 của Turn 30). Link check **không phát hiện** vì `qwendocs-link-check.ps1` chỉ kiểm `1 ≤ n ≤ số dòng`, không kiểm nội dung dòng. Đã đo lại toàn bộ bản đồ anchor và repoint **11 anchor trong `docs/28`, 14 anchor trong `docs/35`.** Anchor `review.md` cũ của lane khác (Cycle 114–137) **để nguyên** — không xác định được audit nào nên không đoán.

### Sai lệch của chính lane

1. **PowerShell argument-mode trap.** `Replace-One $text 'a' + $b + 'c'` truyền `+` thành **argument thứ ba**, nên header §8.16 bị ghi thành `+→ A12 …`. Bắt được nhờ kiểm `L517` sau khi chạy; đã sửa, và từ đó **bọc ngoặc mọi biểu thức nối chuỗi**.
2. **Guard `Replace-One` cứu một lần nữa:** `| Acceptance boundary |` xuất hiện **2 lần** trong `docs/35`; script `throw` trước khi ghi ⇒ file không bị hỏng. Đổi sang anchor dài hơn (`| Acceptance boundary | [Qwen-3 aggregate]`).
3. **Hai receipt OIDC không thêm row trùng.** T-OIDC02-LIVE-1R và T-DATA-LIVE-3R đã có trong section từ A6; Turn 40 chỉ viện dẫn lại. Thêm row mới cho chúng sẽ nhân bản số.


### Lỗi thứ 5 — checker BẮT được (khác 4 lỗi trên)

Lần đầu chạy link check sau khi ghi Mục 7: **BROKEN=9, exit 1**. Nguyên nhân: `qwen-docs.md` **nằm trong** `coordination/reports/`, nên link `](../coordination/reports/tester.md#L7309)` resolve thành `du-rework/coordination/coordination/reports/tester.md` — **thư mục lặp lại**, không tồn tại. Sửa thành link anh em `](tester.md#L7309)`; 9/9 link đã sửa, resolve cả 4 file đích về `True`, chạy lại `BROKEN=0`.

**Đáng ghi vì nó đối lập với anchor drift**: đây là loại lỗi mà checker **bắt được** (target không tồn tại), trong khi anchor trượt +36 thì checker **không thấy** (nó chỉ kiểm `1 <= n <= số dòng`). Cùng một công cụ, hai mức năng lực rất khác nhau — nên **không được suy ra "link check xanh ⇒ link đúng"**, chỉ là "không có target chết".
### Sau khi vá

| Kiểm tra | Kết quả |
|---|---|
| `docs/06` | 136 dòng, 136 CRLF / 0 bare LF, section header ở L24 |
| `docs/28` | 564 dòng, 564 CRLF / 0 bare LF, **L517 = header `A5 → A13`** |
| `docs/35` | 720 dòng, 720 CRLF / 0 bare LF, **L674 = header `A5 → A13`** |
| link check | `FILES=6 TARGETS=661 ANCHORS=362 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 |

### Cây chuyển động NGAY TRONG LÚC lane đang làm (phát hiện lúc 03:0x)

Không phải lỗi của lane, nhưng phải ghi vì nó ảnh hưởng độ tin cậy của bất kỳ docs update nào:

| mtime | File | Ý nghĩa |
|---|---|---|
| 02:48:00 | `app/admin/operation-section-renderer.ts` | có thể là Δ14 (reword câu cũ) — **chưa có receipt** |
| 02:50:22 | `app/admin/shell-server.ts` | sửa tiếp sau W-ADMBASE03-ERR-1 |
| 02:56:54 + 02:57:01 | `packages/contracts/src/oidc-claim-shapes.ts` + test | **mới đúng cái claim-shape item** Turn 40 vừa mở (Δ của Turn 40) |
| 02:57:34 / 02:57:49 | `qwen-admin.md` / `qwen-data.md` | receipt mới |
| **03:00:17** | **`services/orchestrator/src/server.ts`** (2526 → **2529** dòng) | **đúng file mà packet 1 dùng làm nguồn** |
| 03:01:18 / 03:01:38 | `codex6.md` / `tester.md` | receipt mới (có log T-CODEX-TEST-11/12/13) |
| 03:03:14 | `migrations/0017_operations_keyset_index.sql` | **trùng đúng Δ13** (composite keyset index) |

**Đã kiểm tra lại sau khi cây dịch chuyển**: mọi khẳng định đã viết vào `docs/06` vẫn đúng — `OPERATIONS_LIST_DEFAULT_LIMIT = 20`, `MAX = 100`, `CURSOR_MAX_LEN = 128`, toán tử `direction === 'prev' ? '>' : '<'`, và envelope đúng 5 field `{items, nextCursor, prevCursor, total, limit}`. **Chỉ số dòng dịch +3**, và `docs/06` **cố ý không neo số dòng** nên không bị cũ. Đó là lý do phần contract trong docs này nên viết theo symbol/hành vi, không theo `path:line`.

**Không chase các thay đổi đó.** Chúng chưa có receipt, chưa được Reviewer thẩm định, và ngoài scope packet. Ghi vào danh sách dưới để packet sau xác minh lại từ đầu.


### Việc còn mở, không phải của lane này

1. **Docs/contract owner** — `docs/20-openapi-descriptions.md:24` vẫn ghi contract cũ; traceability matrix (docs/19) **chưa có dòng nào** cho contract list này. Cần packet riêng; lane này không sửa vì ngoài scope packet.
2. **Admin owner** — Δ14: reword câu cũ trong `operation-section-renderer.ts` và sửa assertion đi kèm (source, không phải docs).
3. **Platform/Admin owner + Tester** — Δ13: quyết định index composite `(tenant_id, created_at DESC, id DESC)` + receipt `EXPLAIN`/seeded live; và boundary test 1→2→1 trên dữ liệu thật. ADM-UX-07 và G-ADMIN-OPS chỉ đóng khi có phần này.
4. **Reviewer** — adjudicate chênh lệch `dispatcher.ts` `String(err)` (Turn 30 vs Turn 40) và tách riêng sentinel test không chạy được.
5. **Tester + DATA owner** — closeout packet B: public `/api/v1/uploads` trên PG/S3 thật, adjudicate sàn 1 MiB vs 64 MiB+1, quyết Δ5 về ledger retention.
6. **DATA owner** — packet server slice của DATA-03 tại biên Orchestrator ingestion.
7. **Coordinator** — raw `*.log` vẫn bị gitignore ⇒ **không phải release evidence di động**; cần artifact store bền. Và `T-CODEX-TEST-9` (`tester.md:7338), 59/59 vault-ref lần thứ 3) vẫn **chưa có packet** để ghi vào docs.
8. **Reviewer Turn 40 finding 1** — serialize lần docs update kế tiếp **sau** closeout packet 1–4, và không bao giờ chép aggregate total vào task status.

## 6 — CYCLE 6: D-DOCS-CONTRACT-SYNC-1 (docs/19 + docs/20 theo Reviewer Turn 50 finding 1)

**Packet.** `[PACKET D-DOCS-CONTRACT-SYNC-1]`, phát ra từ **Reviewer Turn 50** — bảng audit `review.md:17` và **finding 1 tại `review.md:28`**: *"Update docs/19 and docs/20; retain docs/28/35 A13 as current evidence."* Rules: docs only, no commit, no push.

### Sai tên file trong packet — cần coordinator sửa

Packet ghi `docs/19-traceability-matrix.md`. **File đó không tồn tại.** Tên thật:

`du-rework/docs/19-traceability-audit-matrix.md` (275 dòng, 47511 B, mtime 2026-09-26 00:45:36 — tức **chưa ai sửa kể từ A10**).

Nếu lane sau làm theo packet nguyên văn, sẽ tạo nhầm file hoặc báo "không thấy".

### Trước khi vá

| File | lines | bytes | mtime | kết luận |
|---|---|---|---|---|
| `docs/19-traceability-audit-matrix.md` | 275 | 47511 | 09-26 00:45:36 | contract list **chưa có dòng nào** (Turn 50: *"still lack the new operations-list contract"*) |
| `docs/20-openapi-descriptions.md` | 111 | 9447 | 09-25 00:31:15 | §1 còn ghi `?limit&cursor` → `{items, nextCursor: null}`, source `server.ts 591-598` |
| `coordination/reports/review.md` | 602 | 201660 | 09-26 03:21:27 | **Turn 50 đã land ở L3–L37** |
| `docs/28` / `docs/35` / `docs/06` | 564 / 720 / 136 | — | A13 | **không đụng** (Turn 50 yêu cầu giữ A13) |

### Deliverable — docs/20 (111 → 115)

Dòng `GET /api/v1/operations` viết lại: `?limit&cursor&state&tenant&id`; envelope 5 field; lỗi `401; 403; 422`; `Source` = `server.ts 1173-1211` + helper ở 2068, 2092, 2137, 2160, 2185, 2222, 2271, 2300. Thêm 2 đoạn note ngay sau bảng §1, nêu 3 điểm dễ đọc sai (`state` chỉ nhận enum UI; `total` là COUNT(*) của tập đã lọc; cursor mang hướng trong token) + **khối MISMATCH contracts**.

### Deliverable — docs/19 (275 → 279)

Hai đoạn mới ở **§4 Endpoint interpretation and known route corrections** (L155, L157) — đúng chỗ của file này, theo đúng quy ước `Test-Path=True` và phong cách English sẵn có:

1. **Mô tả contract list** như một "known route correction": vị trí route + helper, admin bearer là alternate auth trên **cùng** contract, 5 tham số allow-list, cursor `base64url(<ISO>|<uuid>[|p])`, 422 vs bỏ qua filter, 403 vs nới scope, item shape = `toOperationView`.
2. **Đính chính attribution schema** — cùng nội dung MISMATCH, kèm câu "not a BR gap, no BR-13..BR-30 identifier is introduced, and this audit does not edit source".

Cả 4 path được viện dẫn đã chạy `Test-Path`: `server.ts`, `modules/operations/facade.ts`, `packages/contracts/src/public-api.ts`, `packages/contracts/src/index.ts` → **đều True**.

### Phát hiện của lane — MISMATCH thứ 3, chưa ai nêu

Turn 50 nói `docs/19` và `docs/20` "lack the new contract". Khi sửa, phát hiện thêm một tầng nữa:

- `packages/contracts/src/public-api.ts` (mtime **2026-09-21**, chưa ai sửa) khai `PageQuerySchema` (L12), `pageOf()` (L18), `ListOperationsQuerySchema` (L22).
- **Route không dùng chúng**: `parseOperationsListQuery` tự parse allow-list.
- **Grep toàn repo: 0 tham chiếu khác** — trỏ `PageQuerySchema|pageOf(|ListOperationsQuerySchema`, chỉ khớp chính 4 dòng định nghĩa.
- **Nhưng `packages/contracts/src/index.ts:18` có `export * from './public-api'`** ⇒ vẫn nằm trên **public API của package**, tức consumer/SDK nhìn thấy một contract **đã bị route vượt qua**.
- Lệch 3 điểm cụ thể: **3 tham số vs 5** (`tenant`/`id` không có); **`state` kiểu máy `OperationStateSchema` vs enum UI** `RUNNING|COMPLETED|FAILED|TIMED_OUT` (UI map ra 7 wire state; `QUEUED` là 422); **cursor max 512 vs route cap 128**. `pageOf` vẫn trả 2 field.

Ghi vào cả hai file dạng **MISMATCH, owner contracts/platform, không tự sửa** (packet là docs-only).

### Nợ kỹ thuật: anchor `review.md` trượt lần thứ hai, đều đặn +36

Turn 50 chèn ở đầu → mọi turn cũ dịch **+36**: Turn 40 L3→**L39**, Turn 30 L38→**L74**, Turn 20 L74→**L110**. **Cả 25 anchor** đã repoint ở A13 giờ lệch đúng +36. Link checker **không thấy** (nó chỉ kiểm `1 ≤ n ≤ số dòng`).

Bản đồ đo lại (để packet sau dùng, khỏi đo lại):

| Anchor | A13 ghi | Hiện tại |
|---|---|---|
| Turn 40 header | L3 | **L39** |
| Turn 40 ADM-UX row | L15 | **L51** |
| Turn 40 filter wire | L16 | **L52** |
| Turn 40 scale / renderer | L17 / L18 | **L53 / L54** |
| Turn 40 DATA-02 / metadata | L19 / L20 | **L55 / L56** |
| Turn 40 DATA-03 / OIDC | L21 / L22 | **L57 / L58** |
| Turn 40 redaction / claim-shape | L23 / L24 | **L59 / L60** |
| Turn 40 findings 1–5 | L28–L32 | **L64–L68** |
| Turn 40 release decision | L36 | **L72** |
| Turn 30 header | L38 | **L74** |
| Turn 30 T20-V1 | L50 | **L86** |
| Turn 30 T-CODEX-TEST-1..8 | L54 | **L90** |
| Turn 30 T20-A1 | L57 | **L93** |
| Turn 30 T20-S1 | L60 | **L96** |
| Turn 30 closeout packet A | L64 | **L100** |
| Turn 30 release decision | L72 | **L108** |
| Turn 20 header | L74 | **L110** |
| Turn 20 T20-V1 | L82 | **L118** |
| Turn 20 T20-E1 | L88 | **L124** |
| Turn 20 gate decision (para) | L112 | **L148** |

**Đề xuất sửa bền cho coordinator**: chuyển sang **heading anchor** thay vì `#L<n>`. Checker hiện chỉ validate `^L([0-9]+)$`, nên heading anchor sẽ không bị checker đụng tới, nhưng **bền vô hạn** vì heading của Reviewer không đổi khi thêm turn mới. Hiện trạng là mỗi turn mới = một đợt sửa anchor toàn bộ.

### Câu đã thành SAI trong docs/28 + docs/35 (A13) — chờ packet, không tự sửa

| Câu ở A13 | Turn 50 nói gì |
|---|---|
| *"The standalone sentinel test was not run in the cited packet"* | L22: **T-CODEX-TEST-11 đã chạy sentinel matrix 23/23**, và gọi câu của docs là **stale** — cần sửa (finding 5, L32) |
| Δ13 index còn mở | L16: migration `0017_operations_keyset_index.sql` đã có; còn mở là **Δ21 query-plan** |
| Δ14 renderer copy còn mở | L15: **W-ADMUX02-CLEAN/COPY đã xoá** câu cũ → **đóng** |
| DATA-03 server slice "SPECIFIED, chưa implement" | L19: **đã IMPLEMENTED / offline VERIFIED** (Codex-6 `sourceUrl`, `PENDING_INGESTION`, `markIngestionReady`) |
| claim-shape cần ADR/contract assertion | L23: **W-SEC-CLAIM-ASSERT đã implement**, Contracts 14 ×3 + orchestrator 167/167 ×3 |

Turn 50 finding 1 yêu cầu **giữ nguyên docs/28/35 A13**, nên lane **không** tự vá. Cần packet riêng cho `docs/28` + `docs/35`.

### Sau khi vá

| Kiểm tra | Kết quả |
|---|---|
| `docs/20` | 115 dòng, 115 CRLF / 0 bare LF, 0 markdown link |
| `docs/19` | 279 dòng, 279 CRLF / 0 bare LF; 13 link **đều có sẵn** ở L251–279, **0 link trong vùng chèn** L155–158 |
| `docs/28` / `docs/35` / `docs/06` | **không đổi** (564 / 720 / 136) |
| link check | `FILES=6 TARGETS=662 ANCHORS=363 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 |

Link check **không đổi số** so với A13 là đúng: checker chỉ scan `docs/28`, `docs/35`, `tasks/P8-release-readiness.md`, `tasks/README.md`, `codex4.md`, `qwen-docs.md` — **không có `docs/19` hay `docs/20`**. Vì vậy tôi tự kiểm riêng: hai file vừa sửa có **0** link mới.

### Sai lệch của chính lane

1. **Đo line-ending sai lần đầu.** Đếm `CRLF` bằng vòng byte offset → kết luận nhầm `docs/19` là "mixed line ending". Sửa bằng cách dò **terminator ngay sau anchor** (`13,10` = CRLF) trước khi vá. Bài học: **đừng đếm byte thủ công, hãy dò terminator cục bộ** — cùng lớp lỗi với "đừng tin con số từ trí nhớ".
2. **Tên file trong packet sai** (`19-traceability-matrix.md`). Đã dùng `Test-Path` để chốt tên thật trước khi sửa, và báo ngược lại coordinator.

### Việc còn mở, không phải của lane này

1. **Contracts/platform owner** — MISMATCH `public-api.ts`: 3 param vs 5, `state` enum máy vs enum UI, cursor 512 vs 128, `pageOf` 2 field; và `PageQuerySchema`/`ListOperationsQuerySchema`/`pageOf` đang là **dead export** trên public API của package. Hoặc sửa schema theo route, hoặc xoá export và ghi chú.
2. **Coordinator** — packet này sai tên file `docs/19`; nên sửa template packet.
3. **Coordinator/Reviewer** — chốt cơ chế anchor bền (heading anchor thay `#L<n>`), vì hiện mỗi turn Reviewer làm hỏng 25 anchor.
4. **Docs/evidence (packet sau)** — 5 câu stale trong `docs/28`/`docs/35` ở bảng trên, cần packet riêng cho hai inventory.
5. **Tester (Turn 50 finding 1)** — apply migration 0017, seeded tenant/platform query, `EXPLAIN`, insert-between-pages, browser pagination/filter journey. **G-ADMIN-OPS chỉ đóng ở đây.**
6. **Turn 50 finding 6** — `T-CODEX-TEST-11/12/14/15` và Codex-6 targeted **chồng lấn** các packet trước: không cộng, không tick; giữ receipt aggregate đỏ của `T-CODEX-TEST-13` (42 suite/507 pass, **1 suite/12 test fail, exit 1**).

## 7 — CYCLE 7: D-EVID-A14 (sửa 6 câu stale theo Reviewer Turn 50)

**Packet.** `[PACKET D-EVID-A14]`, từ **Reviewer Turn 50** (bảng audit `review.md:15-24`, findings `review.md:28-33`). Rules: docs-only, không sửa code, không commit/push.

### Sai tên file — lần thứ hai liên tiếp

| Packet nói | Thực tế |
|---|---|
| `docs/28-threat-model.md` | **không tồn tại** → thật là `docs/28-test-inventory.md` |
| `docs/35-operational-runbooks.md` | **không tồn tại** → thật là `docs/35-acceptance-baseline.md` |

Cycle 6 vừa bắt gặp `docs/19-traceability-matrix.md` (thật là `19-traceability-audit-matrix.md`). **Hai packet liên tiếp sai tên file** ⇒ không còn là sự cố riêng. Đề nghị coordinator sửa template packet; lane tiếp tục `Test-Path` tên file trước mọi lần vá.

### Trước khi vá

| File | lines | bytes | mtime |
|---|---|---|---|
| `docs/28-test-inventory.md` | 564 | 127522 | 09-26 02:49:01 (A13, không ai đụng) |
| `docs/35-acceptance-baseline.md` | 720 | 161682 | 09-26 02:51:06 (A13, không ai đụng) |
| `coordination/reports/review.md` | 602 | — | 09-26 03:21:27 (**Turn 50 ở L3–L37**) |
| `coordination/reports/tester.md` | 7416 → **7426** | — | **dài thêm ngay trong lúc lane đang làm** |

### Sáu câu đã sửa

| # | Câu cũ (do chính A13 viết) | Câu mới | Receipt |
|---|---|---|---|
| 1 | sentinel test "was not run in the cited packet" | **đã chạy**, 3 suite / 23 test, exit 0 | [T-CODEX-TEST-11](tester.md#L7309) + raw log |
| 2 | "no index decision … Δ13 stays open" | 0017 có **2 index**; còn mở là **Δ21** | [IDX-1](qwen-admin.md#L698) / [IDX-2](qwen-admin.md#L793) |
| 3 | renderer copy là **Δ14** ngoài scope | **Δ14 đã đóng** | [CLEAN](qwen-admin.md#L492) / [COPY](qwen-admin.md#L590) |
| 4 | DATA-03 server "SPECIFIED, chưa implement" | **IMPLEMENTED / offline VERIFIED** | [W-DATA03-SRV-1](codex6.md#L348) + [T-CODEX-TEST-14](tester.md#L7354) |
| 5 | claim-shape "cần ADR/contract assertion" | **đã có** cả assertion lẫn ADR-17 | [W-SEC-CLAIM-ASSERT-1](qwen-sec.md#L201) + [W-SEC-ADR-SYNC-1](codex6.md#L329) |
| 6 | `docs/20` + traceability "còn contract cũ" | **đã sửa** ở D-DOCS-CONTRACT-SYNC-1 | chính cycle 6 của lane |

Câu 6 không nằm trong packet, nhưng nó **do chính cycle trước của lane làm thành sai** và có bằng chứng ngay trong repo, nên sửa luôn thay vì để docs tự mâu thuẫn với nhau. Kèm pointer tới **MISMATCH thứ 3** (`packages/contracts/src/public-api.ts` khai schema cũ, route không import, `index.ts:18` vẫn re-export).

### Bẫy đơn vị đo — 23 KHÔNG phải case của sentinel

Turn 50 và packet đều dễ đọc thành "sentinel matrix 23/23". Tự mở raw log `T-CODEX-TEST-11-root-unit.log` (18 dòng), nội dung đúng là:

    PASS ../../tests/unit/br05-artifact-ttl-quota.functional.test.ts (5.021 s)
    PASS ../../tests/unit/uc07-version-drain.functional.test.ts (5.036 s)
    PASS ../../tests/unit/sentinel-sink-matrix.test.ts (5.226 s)
    Test Suites: 3 passed, 3 total
    Tests:       23 passed, 23 total

**23 là tổng của lệnh 3 suite**, sentinel chỉ là một trong ba. Ghi rõ trong cả hai file. Thêm: lệnh truyền **một pattern** chứ không phải ba file rời, nên Jest khớp ra 3 suite — cờ **--listTests** của Jest là cách rẻ nhất để biết thật sự chạy suite nào, không cần bật dịch vụ.

### Khoảng trống ghi ra, không đóng

- **Δ23** — `tests/admin-keyset-explain.test.ts` **đã viết, chưa chạy**: 6 test, seed 1.240 dòng (có nhóm 40 dòng chung `created_at` để bắt thiếu tiebreak `id`), gate `DU_LIVE_INFRA=1`. Cần Tester DB window. **Test đã viết không phải bằng chứng.**
- **Δ24** — migration 0017 **đã bị sửa tại chỗ**; an toàn chỉ vì chưa apply ở đâu. Mọi chỉnh sửa 0017 sau này phải ra file mới (0018).
- **Δ10** — cô lập runner của document-core chưa áp cho orchestrator/connector.
- **Δ21** — cần `EXPLAIN (ANALYZE)` thật trên dữ liệu seed + quyết định giữ hay xoá index prefix cũ.
- **Không tự reconcile 506 vs 507**: T-CODEX-TEST-13 (kèm suite live) báo 42 suite/507 pass; runner offline sau cô lập báo 42 suite/506. Lệch 1 test, receipt đọc được không giải thích ⇒ ghi **chưa đối chiếu**.

### Anchor: repoint +36, cố ý KHÔNG dùng heading anchor

Turn 50 chèn ở đầu `review.md` ⇒ mọi turn cũ dịch **đúng +36**. Đã repoint **28 anchor** trong `docs/28` và **14** trong `docs/35`, dùng bản đồ đo lại từng dòng.

**Quyết định kỹ thuật, nêu rõ vì sao không chọn heading anchor** (packet cho phép cả hai): trong `docs/28` chỉ **3/28** link `review.md` trỏ tới heading của turn; **25 link còn lại trỏ từng dòng bảng audit**, không có heading để neo. Đổi sang heading anchor chỉ sửa được thiểu số, còn 25 link kia sẽ **không còn được checker soi** — tức là *che* lỗi thay vì sửa. Sửa bền phải do Reviewer/coordinator: **ngừng chèn thêm turn ở đầu `review.md`**, hoặc cho mỗi dòng audit một **ID ổn định** để link theo ID.

Thêm một lần trượt nữa: **`tester.md` dài thêm 10 dòng ngay trong lúc lane đang làm** (7416 → 7426). May là phần mới nằm cuối file nên L7309/L7313/L7354/L7358 không đổi, nhưng **đã verify lại ngay trước khi ghi** chứ không tin số đo ở đầu session. Khuyến nghị chung: **cite theo nội dung, không cite theo số dòng**.

### Sai lệch của chính lane — 4 lỗi, tự bắt

1. Chèn đoạn kết từ fragment (viết LF) → **6 dòng LF lọt vào file thuần CRLF**. Bắt bằng đếm `CRLF` vs `bareLF`.
2. Thêm **1 dòng trống thừa** cạnh dòng trống sẵn có → **2 dòng trống giữa bảng** markdown. Bắt bằng mắt thường khi xem cấu trúc.
3. Quên tách marker `###END###` khi áp edit → **marker lọt vào cả hai file** kèm 1 LF. Bắt bằng grep marker sau khi vá.
4. Đếm LF bằng vòng byte offset lại cho số sai (đã dính lần ở cycle 6).

Cả 4 lỗi đều **không** bị link checker bắt — chúng bị bắt bởi bước verify thủ công (line-ending + anchor + cấu trúc) sau mỗi lần vá. Đây là lý do bước verify đó không được bỏ.

### Sau khi vá

| Kiểm tra | Kết quả |
|---|---|
| `docs/28` | **577** dòng, CRLF **577** / bareLF **0**, không còn marker; `L517 = ### 8.16 D-EVID-A5 → A14`; **v1.23.0** |
| `docs/35` | **731** dòng, CRLF **731** / bareLF **0**, không còn marker; `L674 = ### 12.19 D-EVID-A5 → A14`; **v1.23.0** |
| 5 câu packet + 1 câu tự phát hiện | xác minh bằng grep: **toàn bộ câu cũ đã biến mất**, câu mới có mặt ở cả hai file |
| link check | `FILES=6 TARGETS=722 ANCHORS=420 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 |

### Sau A14 vẫn mở (không đổi)

`ADM-UX-07`, `G-ADMIN-OPS`, `DATA-02`, `DATA-03`, `DATA-04`, `DATA-INT-01`, `OIDC-02/03/04`, `SEC-00`, `G-SEC`, và release **NO-GO G-DATA/G-SEC/G-ADMIN-OPS/G6**. Không mục nào được nâng ACCEPTED; tất cả receipt mới trong cycle này đều **offline**.

### Việc còn mở, không phải của lane

1. **Coordinator** — sửa template packet: **2 packet liên tiếp sai tên file**. Và chốt cơ chế anchor bền (Reviewer-side), vì hiện mỗi turn mới = một đợt repoint toàn bộ.
2. **Contracts/platform owner** — `packages/contracts/src/public-api.ts`: 3 param vs 5, `state` enum máy vs enum UI, cursor 512 vs 128, `pageOf` 2 field; và 3 symbol đó là **dead export** trên public API của package.
3. **Tester** — packet của Turn 50 finding 1: apply 0017, seeded tenant/platform query, `EXPLAIN`, insert-between-pages, browser journey. **G-ADMIN-OPS chỉ đóng ở đây.**
4. **Tester/Owner** — chạy `tests/admin-keyset-explain.test.ts` (Δ23) trong DB window; **Δ24**: 0017 đã sửa tại chỗ, sửa sau phải ra 0018.
5. **Owner** — `T-CODEX-TEST-13` 12 lỗi live của `multi-container-e2e` **không** được cô lập runner giải quyết; `Δ10` mở.
6. **Reviewer** — xác nhận 506 vs 507, và xem có cần tách bảng audit thành file riêng để hết phụ thuộc số dòng hay không.

## 8 — CYCLE 8: D-EVID-A15 (Δ36 documentation sync + T70-C2 remedy)

**Packet.** `[PACKET D-EVID-A15]`, answering Reviewer **Turn 100 finding 1 / priority 1** and **Turn 70** T70-C1, T70-C2 and finding 5. Rules: docs-only, no source edit, no commit/push.

### Tên file trong packet — lần này ĐÚNG

Sau hai packet liên tiếp sai tên, packet này chỉ đúng từng đường dẫn, và **cả ba số dòng nó nêu cũng đúng**: `docs/19:157`, `docs/20:34`, `docs/22:27`. Vẫn chạy `Test-Path` trước mỗi lần vá — thói quen này đã cứu cycle trước và vẫn giữ.

### Ba tài liệu ngoài ledger

| File | Dòng | Sửa gì |
|---|---|---|
| `docs/20-openapi-descriptions.md` | 115 | `:34` khối **MISMATCH** → khối **closure** nêu symbol thật; các câu sai "cursor cap 512", "ba tham số", "`pageOf` trả hai field" đã bị xoá (grep xác nhận còn 0) |
| `docs/19-traceability-audit-matrix.md` | 279 | `:157` đoạn attribution viết lại theo đúng giọng `Test-Path` của file, giữ nguyên ranh giới "not a BR gap" |
| `docs/22-p0-06-capacity-targets.md` | 68 | `:27` dòng capacity giờ trích `OPERATIONS_LIST_LIMIT_DEFAULT / OPERATIONS_LIST_LIMIT_MAX`, kèm ghi chú `PageQuerySchema` là generic base chứ không phải schema này |

Điểm mà Qwen-Admin nêu ở Δ36 và **đã tự thừa nhận là overclaim trước đây**: sau cycle này **substance** của câu docs/22 đã đúng (bound 1..100/default 20 nằm trong contracts và route import nó) nhưng **tên symbol** vẫn sai. Giờ cả hai đúng.

### Kiểm chứng bằng source, không chép lời packet

`packages/contracts/src/public-api.ts` (258 dòng) và `server.ts` đều Test-Path=True và đã đọc trực tiếp:

- contracts export `OPERATIONS_LIST_QUERY_PARAMS` (5 tên), `OPERATIONS_LIST_LIMIT_DEFAULT/_MAX`, `LIST_CURSOR_MAX_LEN` = **128**, `OPERATIONS_STATE_FILTER_VALUES`, `OPERATIONS_STATE_FILTER_WIRE_STATES`, `OPERATIONS_LIST_TOKEN_PATTERN`, `isOperationsListFilterToken()`, strict `ListOperationsQuerySchema`, strict `OperationsListPageSchema`, builder `operationsListPage()`.
- `server.ts` import chính các giá trị đó (L66–74), alias chúng (L2089–2092), và emit `operationsListPage({...}) satisfies OperationsListPage` (L2382–2388).
- `pageOf()` **đã bị xoá**; `PageQuerySchema` còn lại nhưng comment ghi rõ *"Not the operations-list request schema"*; `tools/openapi/probe_cases.js` tồn tại (36 dòng) nên giữ tên `ListOperationsQuerySchema` là có chủ ý (Δ34).

### T70-C2 — khắc phục

**13 path `Test-Path`, 0 thiếu**, gồm cả `du-rework/AGENTS.md`, hai inventory, ba tài liệu bị vá, `server.ts`, `public-api.ts`, `index.ts`, `tools/openapi/probe_cases.js`, `review.md`, `qwen-admin.md`. Từ nay packet template nên `Test-Path` tên canonical trước khi dispatch.

### A14 snapshot (Turn 70 mục 5)

Ghi **6 câu** + **722 target / 420 anchor / 0 broken**; giữ bản **5 câu / 713/411** bên cạnh làm snapshot bị thay thế. **Không gộp, không trung bình, không đối chiếu.** Lưu ý: `review.md:167` (Turn 90) vẫn ghi *"corrected five"* — **mâu thuẫn đó giữ nguyên**, vì nó là số của Reviewer và tự sửa số của người khác là vi phạm ranh giới vai trò.

### Phát hiện lớn nhất: `review.md` đổi 3 lần trong lúc đang làm

| Thời điểm | Số dòng | Mày thay đổi |
|---|---|---|
| Đầu cycle | **602** | Turn 50 ở đầu |
| Giữa cycle | **763** | Turn 60/70/80/90/100 được chèn lên đầu |
| Cuối cycle | **784** | thêm một turn nữa ở trên cùng |

Hệ quả: **mọi phép cộng/trừ số dòng đều vô hiệu**. Đã dò lại toàn bộ 98 anchor (`docs/28`: 41, `docs/35`: 57) **theo nội dung dòng đích**, rồi **verify lại từng cái** bằng cách đọc dòng mà anchor trỏ tới và so với label. Ba lần repoint trong cùng một cycle đều bị vô hiệu giữa chừng — đây là lần thứ tư trong ba packet mà anchor trượt.

### Ba lỗi PowerShell tự làm (chắc chắn lặp lại nếu không ghi)

1. **Array literal trộn `+` với dấu phẩy.** `@('a' + $b + 'c', 'd')` bị parser nuốt dấu phẩy: phần tử thành **một chuỗi dính liền**, `$arr[0][1]` rỗng, và vòng lặp **thay thế 0 lần mà không báo lỗi**. Dính ở `$fam`, `$fix`, rồi `AddFix`.
2. **Thay thế chuỗi có chồng lấn.** `L214)→L235)` chạy trước `L235)→L256)` ⇒ các giá trị **vừa tạo ra lại bị dịch tiếp**, sinh anchor trỏ nhầm dòng (ví dụ `[Turn 40 audit]` rơi vào dòng claim-shape). Phải verify và sửa lại từ đầu.
3. **Label non-ASCII trong `.ps1` không BOM.** En dash và Δ bị PowerShell đọc thành ANSI (`â€“`, `Î”`) nên không khớp.

Cách né cả ba, đã dùng cho lượt cuối: **rule dạng pipe-delimited thuần ASCII** (`docLine|target1,target2`, áp theo thứ tự link trên dòng) + `MatchEvaluator`, và **sàn số lượng thay thế** `if (hits -lt expect) { throw }`.

### Bài học về quy trình

Có một lượt báo `anchors_repointed=0` mà **không ném lỗi** — suýt báo xong với 0 anchor được sửa. Sàn số lượng đã **cứu một lần**: `docs/35` bị throw **trước khi ghi**, nên không có trạng thái nửa vời. Quy tắc: **báo cáo 0 thay thế thì phải kiểm, không được tin**.

### Sau khi vá

| Kiểm tra | Kết quả |
|---|---|
| `docs/28` | **583** dòng, CRLF **583** / bareLF **0**, `L517 = A5 → A15`, **v1.24.0** |
| `docs/35` | **735** dòng, CRLF **735** / bareLF **0**, `L674 = A5 → A15`, **v1.24.0** |
| `docs/19` / `docs/20` / `docs/22` | 279 / 115 / 68 dòng, CRLF thuần; `MISMATCH` cũ và câu "512" đã hết |
| anchor | 98 anchor verify theo nội dung; mọi cái trỏ đúng dòng |
| link check | `FILES=6 TARGETS=761 ANCHORS=428 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 |

### Việc còn mở, không phải của lane

1. **Reviewer** — xác nhận **Δ36** đóng về mặt tài liệu (Reviewer yêu cầu `BROKEN=0` + canonical reference **trước khi** đổi trạng thái documentation; cả hai đã có trong receipt này).
2. **Reviewer/coordinator** — sửa template packet để `Test-Path` tên file canonical **trước khi dispatch**; và cho dòng audit **ID ổn định** để hết phụ thuộc số dòng, vì `review.md` đã đổi 3 lần trong một packet.
3. **Reviewer** — phân giải mâu thuẫn 5 (Turn 90) với 6 (ledger lane) về D-EVID-A14; lane giữ nguyên cả hai, không tự chọn.
4. **Tester/Owner** — packet Turn 100 priority 2/3: browser C0–C5 cho Admin, Migration 008 writer/reader Vault, DATA-03 live worker→S3→READY. **Ba gate còn lại đều chờ đây.**
5. **Owner** — `Δ32` (quyền sửa `packages/contracts/` khi gate ghi owner khác) và việc cập nhật dòng inventory trong `coordination/gates/contracts-v1.md` vì `pageOf()` bị xoá.

## 9 — CYCLE 9: D-EVID-A16 (Tester T-CODEX-TEST-21 / 22 / 23)

**Packet.** Antigravity coordinator, `[PACKET D-EVID-A16]`. Scope: three newest Tester receipts into `docs/28` §8.16 and `docs/35` §12.19, version bump to **1.25.0**, header `A5 → A16`, line-ending and anchor check, link check, receipt here. Docs-only, no source/test edit, no tick, no commit/push.

Packet nêu đúng tên file (**lần thứ hai liên tiếp**) và cả ba tài liệu trong danh sách đều tồn tại. Vẫn `Test-Path` trước mỗi lần vá.

### Ba receipt — đều đọc lại từ raw log

| Receipt | Nguồn | Kết quả | Raw log đã tự đọc |
|---|---|---|---|
| **T-CODEX-TEST-21** | `tester.md` L7400 | live PG + S3/MinIO, **1 suite / 5 passed ×2**, exit 0 ×2; window **08:21:26.354 → 08:24:31.085** +07; **17/17** migration | `T-CODEX-TEST-21-live-s3.log`: PASS 37.917 s rồi 35.956 s, `Tests: 5 passed, 5 total` ×2, `LIVE_SUITE_RUN_1/2_LITERAL_EXITCODE=0`, `ttlSweep scanned=1 aborted=1 purged=1 failed=0 orphanUploadCleared=true` |
| **T-CODEX-TEST-22** | `tester.md` L7388 | **offline** Playwright, 3 lần chạy cùng aggregate **82**, exit 0; **158 axe cumulative**, 0 critical / 0 serious / 12 moderate; **không có DB window** | `T-CODEX-TEST-22-admin-browser.log`: 3× `Running 82 tests`, `82 passed (1.2m)/(1.2m)/(1.1m)`; `artifacts-summary.json` khớp 158/0/0/12 |
| **T-CODEX-TEST-23** | `tester.md` L7379 | live keyset query-plan, **1 suite / 6 passed**, exit 0; window **09:01:21.677 → 09:01:26.728** +07; **1.240** dòng | `T-CODEX-TEST-23-keyset-explain-live.log`: 2× `Index Scan using operations_created_id_idx`, không `Seq Scan`/`Sort`; backward có `Sort` quicksort |

### Δ23 superseded, Δ21 đổi lý do nhưng **vẫn mở**

Δ23 là "EXPLAIN test **đã viết nhưng chưa chạy**". T-CODEX-TEST-23 **đã chạy nó live** với window claim/release đàng hoàng ⇒ Δ23 được việc nó cần. **Đã thu hẹp câu cũ trong cả hai file.**

Nhưng **không có gì thêm đóng theo**. Trong log TEST-23, trang **backward** vẫn có node `Sort` (quicksort, `Sort Key: created_at, id`) đứng trên `Bitmap Heap Scan` + `Bitmap Index Scan on operations_created_id_idx`. Lý do suite vẫn 6/6 là **hai assertion no-`Sort` chỉ phủ hai query forward**. Nên **Δ21 chuyển từ "thiếu EXPLAIN" sang "trang backward còn Sort" + "quyết định về index prefix `operations_tenant_created` cũ chưa ghi"** — vẫn **mở**, và tôi ghi rõ như vậy thay vì đóng theo số xanh.

### ADM-UX-07 không đóng

T-CODEX-TEST-22 là bằng chứng **synthetic in-process**: Playwright Chromium offline, `createAdminShellServer` trên loopback OS-assigned port, **stub trong bộ nhớ**, không PostgreSQL/Redis/S3/platform HTTP và **không claim DB window**. Receipt **tuyên bố rõ không claim C4/C5** (HTTP authorization role/action/tenant, CSRF negative, DB state immutability, audit side effect; live seeded + timestamp/window + screenshot từng journey) — tất cả cần seed PG/Redis thật. **ADM-UX-07 và `G-ADMIN-OPS` giữ nguyên trạng thái mở.**

### DATA-02 / DATA-04 / G-DATA không đóng

T-CODEX-TEST-21 là receipt live mạnh nhất từng có ở DATA, nhưng nó chạy `data-02-04-live-s3.test.ts`, tức nhánh **runtime/lease**, và **không có lời gọi `/api/v1/uploads`**. Vòng đời **public binary** mà DATA-02 cần vẫn chưa kiểm chứng; sàn 1–64 MiB và Δ5 ledger retention không đổi.

### Ba bẫy đếm số — ghi vào row để không ai lặp lại

1. **T-CODEX-TEST-21 CÙNG scope với T-DATA-LIVE-4**: cùng một file suite, cùng con số **5/5 ×2** đã có trong section từ A6. Đây là **rerun độc lập của Tester**, không phải thêm 10 pass. Hai receipt **không cộng**.
2. **T-CODEX-TEST-22**: **82 là MỘT aggregate 82-test chạy 3 lần, không phải 246**; và **158 axe là tổng tích luỹ qua 3 lần, không phải 158 mỗi lần**.
3. **Suite keyset** đã chạy **đỏ 4/6** (T-CODEX-TEST-18, 05:04) → **xanh 6/6** (T-CODEX-TEST-20, 05:16) → **xanh 6/6** (T-CODEX-TEST-23, 09:01) trên ba snapshot khác nhau. **Không cộng**, và bản đỏ giữ nguyên trong record.

### Hai chỗ trông như mâu thuẫn — đã giải bằng log, không bỏ qua

- Log TEST-22 in `88 axe scans` ở lần ghi `artifacts-summary.json` **đầu tiên**, receipt nói **158**. Không phải mâu thuẫn: bộ đếm **tích luỹ** đi 88 → 102 → 116 → 130 → 144 → **158**, và file cuối khớp đúng receipt. Đã ghi rõ để người sau không tưởng là receipt sai.
- **T-CODEX-TEST-20** viết backward plans "passed no-`Sort` assertions", nhưng log TEST-23 **có** node `Sort`. Ghi nhận sự khác biệt giữa hai receipt, **không tự phân xử** ai đúng.

### Anchor — lần đầu trong 4 packet không trượt

`review.md` **không đổi**: vẫn **784** dòng, mtime 08:53:03, từ đầu tới cuối cycle. Nên **98 anchor** (docs/28: 41, docs/35: 57) không cần dịch, nhưng tôi **vẫn verify lại bằng nội dung dòng đích** (0 suspect) thay vì tin số đo, và xác nhận ba anchor `tester.md` mới rơi đúng vào header `## T-CODEX-TEST-21/22/23`.

### Sau khi vá

| Kiểm tra | Kết quả |
|---|---|
| `docs/28` | **595** dòng, CRLF **595** / bareLF **0**, `L517 = A5 → A16`, **v1.25.0** |
| `docs/35` | **748** dòng, CRLF **748** / bareLF **0**, `L674 = A5 → A16`, **v1.25.0**, `Still open after A16` |
| `review.md` anchors | 98 verify theo nội dung, **0 suspect**; `review.md` không đổi trong cycle |
| link check | `FILES=6 TARGETS=775 ANCHORS=434 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 |

### Sai lệch của chính lane

1. **Lần đầu tiên sau A13/A14 mắc lại bẫy array literal `+` + dấu phẩy** khi đếm key Δ: `@([char]0x0394 + '23', ...)` gộp thành một chuỗi, khiến vòng đếm trả về một dòng hỗn tạp. Đã sửa bằng **tách key ra biến trước** — đúng cách đã ghi ở A15. Ghi nhắc vì bẫy này vẫn còn.
2. **Hai lần `grep_search` với glob `docs/{28,35}-*.md` và `docs/2[02]-*.md` trả về 0 match** vì glob không áp dụng; phải chuyển sang `Select-String`. Không phải file vắng — chỉ là glob sai.

### Việc còn mở, không phải của lane

1. **Tester/Owner** — packet của Turn 100 priority 2: browser journey **live seed** cho C4/C5 (đóng ADM-UX-07), và public `/api/v1/uploads` init → part → complete → submit trên PG/S3 thật (đóng phần public của DATA-02).
2. **Owner/DBA** — quyết định về index prefix `operations_tenant_created` cũ; và có nên coi node `Sort` ở trang backward là chấp nhận được cho keyset query hay cần tối ưu thêm. **Reviewer adjudicate** vì T-CODEX-TEST-20 và T-CODEX-TEST-23 mô tả khác nhau.
3. **Coordinator** — sửa template packet tiếp tục dùng `Test-Path`; và cho dòng audit **ID ổn định** để hết phụ thuộc số dòng (4 packet/9 cycle thì drift đã xảy ra 3 lần).
4. **Reviewer** — phân giải mâu thuẫn mô tả no-`Sort` giữa T-CODEX-TEST-20 và T-CODEX-TEST-23.
5. **Gate không đổi**: `ADM-UX-07`, `G-ADMIN-OPS`, `DATA-02`, `DATA-03`, `DATA-04`, `DATA-INT-01`, `OIDC-02/03/04`, `SEC-00`, `G-SEC`, release **NO-GO G-DATA/G-SEC/G-ADMIN-OPS/G6**.

## 10 — CYCLE 10: D-EVID-A17 (Turn 110 adjudication + tasks/README header)

**Packet.** Antigravity coordinator, `[PACKET D-EVID-A17]`, two deliverables: point `tasks/README.md`'s leading blockquote at the Turn 110 adjudication, and synchronize `docs/28`/`docs/35` with the Turn 110 decisions. Docs-only, no commit/push.

**Turn 110 read in full** (`review.md` L786–807, 6 adjudication items + 4-item work order + decision). It is a read-only audit: no test/build, no window, no source or task-row edit, no commit/push.

### TASK 1 — `tasks/README.md`

Blockquote đầu nằm ở **dòng 3** (dòng 1 là heading, dòng 2 trống) — **packet nói "line 3" và đúng**. Đã thay **1186 → 725** ký tự, trỏ `../coordination/reports/review.md#L786`, và **giữ nguyên 13 blockquote còn lại** làm historical snapshot.

**Hai điều chỉnh đáng ghi khi làm đúng packet:**

1. **Em dash trong packet bị hỏng.** Packet viết `Current review â€” Turn 110` — đó là UTF-8 bị đọc thành Latin-1. Chép nguyên văn sẽ in ký tự hỏng vào README. Tôi dùng em dash thật.
2. **Packet và Turn 110 hơi mâu thuẫn, và cả hai đều đúng theo vai trò.** Packet yêu cầu đặt **"52 unaccepted task rows"** vào README; nhưng Turn 110 (L797) lại nói README nên trỏ adjudication **"without duplicating a mutable headline count"** — và đúng blockquote cũ tôi thay là một mẫu snapshot Cycle 126–131 đầy số liệu thay đổi được (57 `[x]`/3 `[~]`/11 `[ ]`, 80.3% ticked, 1.130 tests, 1.359 executions…). Xử lý: **giữ đúng con số 52 packet yêu cầu**, nhưng **gắn nó cho Turn 110** kèm qualifier *"a task-row count per Turn 110 … not 52 code changes and not a readiness percentage — the adjudication is the source of truth for that number"*. README vẫn trả lời đúng câu hỏi của packet mà không trở thành nguồn số thứ hai.

### TASK 2 — `docs/28` + `docs/35`

Version **1.25.0 → 1.26.0**, header `A5 → A16` → `A5 → A17`, `Still open after A16` → `after A17`. 3 row mới mỗi file + 4 mệnh đề thu hẹp.

**Đóng đúng ở scope của nó — và tôi sửa lại chính lời tôi đã viết ở A16:**

- **Δ36 CLOSED** ở documentation scope, **D-EVID-A15 ACCEPTED** cho scope đó. Row A15 trước đó ghi "submitted for confirmation" ⇒ **đã thu hẹp**. Turn 110 nói rõ A15 *"closes the documentation follow-up from T70-C1, **not a runtime or release gate**"*, và các câu OPEN của Turn 80/90/100 trước đó là **historical snapshot**.
- **Δ23 CLOSED** như sự thiếu live execution của keyset EXPLAIN suite. Row A16 tương ứng đã thu hẹp.
- **Sửa framing của A16 về node `Sort`**: Turn 110 xác nhận **cả hai** raw log (T-CODEX-TEST-20 và -23) đều có backward `Sort` sau `Bitmap Index Scan` + `Bitmap Heap Scan`; **chỉ hai test forward assert no-`Sort`**; test backward **cố ý cho phép sort có giới hạn và chỉ reject full-table `Seq Scan`**, quan sát **63 dòng / 46 kB**. ⇒ câu "backward đã pass no-`Sort`" là **receipt-description error, không phải test đỏ mới**. Tôi đã ghi đúng như vậy thay vì giữ cách diễn đạt cũ.

**Δ21 vẫn MỞ — nhưng lý do đổi và nặng hơn trước.** Turn 110 nêu một khoảng trống bằng chứng mà A16 chưa biết: suite seed 1.240 dòng dưới **một** tenant mới, và query **tenant-scoped vẫn chọn index cross-tenant** `operations_created_id_idx` rồi mới filter theo tenant. Nghĩa là **không có bằng chứng planner chọn `operations_tenant_created_id_idx` trên tập nhiều tenant phân tán**. Cộng thêm index prefix `operations_tenant_created` cũ vẫn chưa quyết, và **mọi thay đổi index sau migration 0017 đã apply phải qua migration mới** (0017 không được sửa lần nữa).

### Mẫu số release trước đây sai — Turn 110 sửa

**52 unaccepted rows** = 14 P0–P8 + 16 SEC + 8 Admin UX + 10 DATA/LOG/DEP + **4 COST-01..04**. Con số **48** trước đó **bỏ sót đúng 4 dòng COST** mà `G-ADMIN-OPS` yêu cầu. Turn 110 nhấn mạnh đây là **task-row count, không phải 52 code change và không phải phần trăm sẵn sàng**; 5 dòng P9 tuỳ chọn vẫn ngoài initial release. Tôi kiểm lại phép cộng: 14+16+8+10+4 = **52** ✓.

**`G-ADMIN-OPS` nay chờ HAI track**: browser journey (C1–C5 trên current build, seed PG/Redis, hai tenant, ≥1.000 operations, bốn operator journey, HTTP/CSRF/audit assertion, screenshot, CLAIM/RELEASE) **và** COST-01..04 trong `docs/admin-ops-monitoring-cost.md` (Test-Path=True) — **không receipt nào accept row COST nào**. `ADM-UX-00/01/03–07` giữ nguyên.

### Anchor — lần này KHÔNG trượt

Turn 110 được **ghi nối cuối** `review.md` (L786 trên 807 dòng) chứ **không** chèn ở đầu, nên 98 anchor cũ của `docs/28`/`docs/35` không dịch. Vẫn **verify lại bằng nội dung dòng đích** thay vì tin số đo: 12 điểm spot-check (Turn 20/30/40/50/70/80/90/100 header, và các dòng row) đều `ok=True`. Đây là lần thứ hai trong năm packet mà không trượt, sau khi drift 3 lần ở A13/A14/A15.

### Sau khi vá

| Kiểm tra | Kết quả |
|---|---|
| `tasks/README.md` | 101 dòng, CRLF **101** / bareLF **0**; blockquote L3 mới; **13** blockquote cũ giữ nguyên |
| `docs/28` | **609** dòng, CRLF **609** / bareLF **0**, `L517 = A5 → A17`, **v1.26.0** |
| `docs/35` | **763** dòng, CRLF **763** / bareLF **0**, `L674 = A5 → A17`, **v1.26.0` |
| link check | `FILES=6 TARGETS=794 ANCHORS=454 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, Exit Code 0 — lượt này **có** validate `tasks/README.md` vì file nằm trong danh sách scan |

### Gate sau A17 (không đổi)

`ADM-UX-00/01/03–07`, `G-ADMIN-OPS`, `DATA-02`, `DATA-03`, `DATA-04`, `DATA-INT-01`, `OIDC-02/03/04`, `SEC-00`, `G-SEC`, và release **NO-GO cho `G-ADMIN-OPS`, `G-SEC`, `G-DATA`, `G6`**. Không task row nào được tick; `Δ21` không tự đóng.

### Việc còn mở, không phải của lane

1. **DBA/Admin owner** — quyết tiêu chí hiệu năng cho backward bounded sort, quyết định index prefix legacy, và chạy EXPLAIN nhiều tenant để chứng minh planner chọn index tenant-leading; sửa **prose** của T-CODEX-TEST-20 mà **không** sửa raw result.
2. **Admin owner + Tester** — C1–C5 trên current build có seed; và tách các contract list API-key/audit/business cùng COST-01→04 thành packet testable riêng.
3. **Security owner + Tester** — SEC-00 deployment sign-off, OIDC-04 browser, Migration 008 writer/reader/prefix/rotation/revoke/reconcile + negative ngoại lai.
4. **DATA owner + Tester/infra** — public upload lifecycle, DATA-03 URL→private S3→READY/worker, rồi DATA-05, LOG-02, DEP-01, DATA-INT-01.
5. **Coordinator** — `tasks/README.md` giờ trỏ Turn 110; nên review lại các blockquote lịch sử còn lại định kỳ để chúng không bị đọc nhầm là trạng thái hiện tại. Và vẫn chưa có ID ổn định cho dòng audit.

## 11 — CYCLE 11: D-EVID-A18 (sáu receipt: T-24/25/26/27 + Qwen-SEC §8 + Qwen-Admin §12)

### 11.1 Kiểm tra đầu vào — Test-Path mọi tên trong packet
10 đường dẫn (`AGENTS.md`, `docs/28`, `docs/35`, `review.md`, `tester.md`, `qwen-sec.md`, `qwen-admin.md`, `qwen-docs.md`, 2 script link-check) — **tất cả tồn tại**, `docs/28`/`docs/35` untracked. Packet nêu đúng tên file lần thứ **3 liên tiếp** (trước đây 2/5 packet tên file sai).

### 11.2 Sáu receipt, không phải năm
Packet yêu cầu 5 receipt; **T-CODEX-TEST-27 đã có trong `tester.md` (L7417) từ 10:56:11 +07** — receipt mới nhất trong cycle, 75 phút sau đỏ live audit. Ghi nhận tại chỗ thay vì để rơi sót.

### 11.3 T-CODEX-TEST-25 — packet mô tả sai, log báo đúng
| Packet | Log (raw) |
|---|---|
| "6 failed on 401 unknown-bearer contract" | `unknown bearer → 401` **PASS**; `tenant-operator bearer is NOT platform admin → 401` **PASS** |
| | 2 × `EADDRINUSE 127.0.0.1:58537` (harness port collision) |
| | 1 × `Cannot read properties of undefined (reading length)` tại `full.events.length` |
| | 3 × `expect(body.tenantId).toBe(...)` nhận `undefined` |

**Chữ ký lỗi khớp envelope cũ**: `tests/admin-audit.test.ts:137-139` khai `interface AuditEnvelope { tenantId: string; events: AuditWireEvent[] }`; đọc `tenantId`/`events` ở `:192-250` và `:350-376`. W-ADMUX02-EXT-1 đổi route sang 5-field list envelope → hai field đó mất. **Không adjudicate** — test lỗi thời hay route hồi quy là việc của Admin owner, Tester, Reviewer. Task row không đổi.

### 11.4 T-CODEX-TEST-26 — 7 fail, nhưng 2 là "che" chứ không "đỏ"
Tất cả 7 fail ném `BINDING_DENIED` tại `src/modules/connector-credentials/workflow.ts:166`.
- Test kỳ vọng `VAULT_POLICY_DENIED` → nhận `BINDING_DENIED`
- Test kỳ vọng `TEMPORARY_UNAVAILABLE` (503) → nhận `BINDING_DENIED` (403)

Hai case này bị **dừng ở cổng binding trước khi chạm hành vi** ⇒ đường `VAULT_POLICY_DENIED` và retryable-503/no-half-effect là **unverified**, không phải observed broken. Connector 3 suite vault của riêng nó **xanh 38/38** ⇒ gap nằm **orchestrator-side**.

### 11.5 T-CODEX-TEST-27 — chỉ đóng nửa transient, cộng bẫy đếm số
- `tsc` sạch ⇒ `hasPageAbove` (TS2304) đã khắc phục. Nhưng **`admin-audit.test.ts` KHÔNG chạy lại**; conformance suite test envelope **mới** ⇒ **6 fail audit vẫn mở**.
- Lệnh nêu **3 file**, Jest thấy **2** — `tests/admin-actions-dispatch-offline.test.ts` **không tồn tại** (Test-Path xác nhận) ⇒ **94/94 = conformance + pagination only**, suite bị gọi tên đóng góp 0.

### 11.6 Hai receipt owner — gate không chuyển
- **Qwen-SEC §8**: **0 production diff** (4 yêu cầu đã implement đúng); lane đo + thêm test, **không nhận công 2a**. **Δ29**: handler/router tier, **không phải browser driver** ⇒ **OIDC-04 `[ ]`, `G-SEC` NO-GO**. Δ26/Δ27 là SEC-00/SEC-INT-02 + Admin lane.
- **Qwen-Admin §12**: **mutation-check hai chiều** (MA 4 đỏ, MB 2 đỏ, restore 23/23), tenant fence **SQL**, 403 **pre-query**, hex ≥32 → 422, `hash` absent SQL/body. **ADM-UX-02 `[~]`** vì 5 lý do; `label`/`last-used` **không có cột** ⇒ cần **migration + DB window**.

### 11.7 Link check, version, anchor
- `docs/28`: 609 → **627** (+18); `docs/35`: 763 → **783** (+20)
- Cả hai **v1.27.0**, header `A5 → A18`, `Still open after A18`
- Anchor `L517`/`L674` **giữ nguyên**, CRLF thuần, 0 BOM, 0 stray marker
- **Link check**: `FILES=6 TARGETS=814 ANCHORS=466 BROKEN=0` (A17: 794/454 ⇒ **+20 target, +12 anchor**, đúng 6 row × 2 link × 2 file + 12 anchor `#L`)
- 6 anchor mới verify theo nội dung dòng đích: `tester.md#L7388/7397/7407/7417`, `qwen-sec.md#L337`, `qwen-admin.md#L1330` — tất cả `ok=True`

### 11.8 Việc còn mở — next owners
1. **Admin owner + Tester** — `admin-audit.test.ts` migration về envelope mới (hoặc route revert) + C1–C5 trên seed thật + tách COST-01..04 thành packet testable riêng.
2. **DBA/Admin owner** — backward bounded sort criterion, legacy prefix index, multi-tenant EXPLAIN chứng minh `operations_tenant_created_id_idx` planner choice.
3. **Security owner + Tester** — SEC-00 deploy sign-off, OIDC-04 browser, Migration 008 writer/reader/prefix/rotation/revoke/reconcile + negative foreign-account.
4. **DATA owner + Tester/infra** — public `/api/v1/uploads` lifecycle, DATA-03 URL→private S3→READY/worker, DATA-05/LOG-02/DEP-01/DATA-INT-01.
5. **Coordinator** — định kỳ review blockquote lịch sử trong `tasks/README.md` để không bị đọc nhầm là trạng thái hiện tại; xem xét ID ổn định cho dòng audit.

## 12 — CYCLE 12: D-EVID-A19 (Traceability Matrix Sync cho 5 closure của Turn 118)

**Packet.** Antigravity coordinator `term_8ba9a7d5`, `[PACKET D-EVID-A19]`. Ba deliverable: (1) thêm traceability entry cho MM-05 / VAULT-01 / COST-01 / DATA-01 / OIDC-04 trong `docs/19-traceability-audit-matrix.md`; (2) link check toàn bộ tài liệu với `BROKEN=0`; (3) receipt tại đây. Docs-only, không source/test, không tick, không commit/push. Ràng buộc lane giữ nguyên: không chạy test, không window DB/Redis/S3/Vault, không adjudicate Δ, không nâng ACCEPTED.

### 12.1 Vì sao append-only, và vì sao không bump version

`codex4.md:490` trỏ vào `docs/19` bằng **hai** anchor: `#L32` (row BR-11) và `#L239` (ghi là §9). Chèn mục ở giữa sẽ đẩy lệch cả hai. Nên section mới nối vào **cuối file** và tôi đặt sàn so sánh byte cho 279 dòng đầu trước khi ghi:

| Kiểm | Kết quả |
|---|---|
| `docs/19` trước | 279 dòng, CRLF thuần 279/0, không BOM, kết thúc bằng newline, mtime 2026-09-26 08:50:15 |
| `docs/19` sau | **322** dòng, CRLF thuần 322/0, không BOM |
| Sàn 279 dòng đầu | `PREFIX_LINES_UNCHANGED=True`, **mismatches=0** |
| `L32` | vẫn là `| BR-11 — Traceability |` ✔ |
| `L244` | vẫn là `## 9. Cycle 138 live traceability execution` ✔ |
| `L275` | vẫn là `## VAULT-01 trusted connector revision binding` ✔ |

`docs/19` **chưa bao giờ có** trường `Document Version` (chỉ `docs/28`, `docs/30`, `docs/35`, `docs/38` có). Thêm header ở đầu là thêm một dòng vào **trước** L32 ⇒ đẩy lệch anchor của lane khác. **Không bump, và ghi rõ lý do** thay vì im lặng.

### 12.2 Năm traceability row — bảng tóm tắt

| Work item | Receipt | Kết quả ghi nhận | Ranh giới |
|---|---|---|---|
| **MM-05** | Qwen-Platform §1 | tsc exit 0 ×3; 2 suite / **15** exit 0 ×3 (11 sweep = 8 cũ + 3 mới, + 4 dispatcher-probe) | Đóng ở **tầng SQL**; `p8-02c` rearm-1..4 còn mở, cần DB window |
| **VAULT-01** | Qwen-Vault §1 | contracts build exit 0; harness 13/13; 3 suite / **52** exit 0 ×3 | **Chỉ sửa file test, production diff = 0**; 51→52 vì tách test 3 làm hai, **không phải thêm coverage**; migration 008 + Vault thật vẫn thiếu |
| **COST-01** | Qwen-Cost §1 | contracts build exit 0 ×3; **14 suite / 260** exit 0 ×3 (baseline 13/237); observability 22 ×3; lint 0 | **Mới tầng schema/view**; chưa migration, chưa persist, chưa producer, COST-02..04 chưa làm |
| **DATA-01** (Δ14) | Qwen-DATA §7 | contracts 13/237 ×3; worker-sdk targeted 3/62 ×3; pin 14/14 ×3; doc-core 43 suite / **520** ×2; url-ingestion 3/3 ×3; lint 0 ×3 | Đóng **Δ14 ở tầng envelope**; **Δ17 mới** — `processIngestionTask` còn **0 caller**; DATA-03 vẫn `[~]` |
| **OIDC-04** (Δ26) | Qwen-SEC §9 | 11 suite = **7 skipped + 139 passed / 146 total**, `WIDE_R1/R2/R3_EXIT=0`; packet 2/37 `PACKET_F1/F2/F3_EXIT=0`; NC-A `EXIT=1` (6 đỏ/29), NC-B `EXIT=1` (5 đỏ/30) | Handler-level, **không cookie-jar thật, không TLS thật**; OIDC-04 `[ ]`, `G-SEC` NO-GO; **Δ27 mới đóng nửa** |

### 12.3 T-CODEX-TEST-28 — receipt mới hơn chính Turn 118, và vì sao quan trọng

Turn 118 chốt lúc **11:40**. `T-CODEX-TEST-28` chạy lúc **11:46:10 → 11:46:30 +07**, tức **sau** mốc đó, và là packet Turn 119. Nó là bằng chứng mạnh nhất của cycle vì **không ai tự verify bản vá của chính mình**:

| Bước | Marker literal trong log | Số liệu jest |
|---|---|---|
| `pnpm --filter @du/contracts build` | `CONTRACTS_BUILD_EXITCODE=0` | — |
| 3 suite Vault | `VAULT_TESTS_EXITCODE=0` | `3 passed, 3 total` / **52 passed, 52 total**, 4.809 s |
| 2 suite MM-05 | `MM05_TESTS_EXITCODE=0` | `2 passed, 2 total` / **15 passed, 15 total**, 4.787 s |

Log khai `MODE=offline; DU_LIVE_INFRA/DATABASE_URL/REDIS_URL unset` — **không** có DB window nào bị mở. Cả hai con số **khớp đúng** receipt của lane thực thi (52 và 15), nên đây là **xác nhận độc lập, không phải số liệu mới và không cộng**. Lưu ý khi đọc log: stderr có artefact quen thuộc `pnpm.ps1` / `NativeCommandError`; **marker `*_EXITCODE=0` mới là kết quả**, tiếng nhiễu wrapper không phải lỗi.

**Nối với row của chính lane này ở A18.** Row `T-CODEX-TEST-26` tôi ghi ở A18 nói rõ 7 fail `BINDING_DENIED` trong đó **2 là masking** — test đợi `VAULT_POLICY_DENIED` và test đợi `TEMPORARY_UNAVAILABLE` (503) đều bị chặn ở binding gate **trước** hành vi chúng sinh ra để kiểm, nên *unverified chứ không phải proven broken*. `W-VAULT-BINDING-FIX-1` **chính là** cái vá gỡ lớp masking đó, và T-28 xác nhận 52/52 không còn `BINDING_DENIED`. **Nhưng vẫn không live**, nên hai path đó mới chỉ *proven offline* chứ chưa *proven ở deployment*.

### 12.4 Raw-evidence provenance — ai có log, ai không

| Receipt | Log trên đĩa | Mức reread của lane này |
|---|---|---|
| Qwen-SEC §9 | 20 file `proxy-*.log` trong `coordination/evidence/qwen-sec/` | **Đầy đủ** — đã đọc từng marker `WIDE_R*_EXIT`, `PACKET_F*_EXIT` và dòng `Test Suites:`/`Tests:` |
| Tester T-CODEX-TEST-28 | `coordination/reports/T-CODEX-TEST-28-vault-mm05-verify.log` | **Đầy đủ** |
| Qwen-Vault §1, Qwen-Platform §1 | **không có** (lane chạy foreground, không để lại log) | **Gián tiếp** — T-28 chạy lại đúng bộ suite, xác nhận bên thứ ba |
| Qwen-Cost §1, Qwen-DATA §7 | **không có** (cả hai receipt nói rõ) | **Không có gì** — số liệu **chép từ receipt**, chỉ kiểm được tính nhất quán nội bộ |

Hai điều đáng ghi: (a) log của Qwen-SEC nằm ở `coordination/evidence/`, **không** ở `coordination/reports/` như phần lớn log khác — tìm nhầm chỗ sẽ kết luận sai là *không có log*; (b) **mọi** file `.log` bị khớp bởi `*.log` tại `du-rework/.gitignore` dòng 9, nên không link nào đi được cùng một commit.

### 12.5 Bẫy đếm số: `it.each` làm đếm literal under-report

Tôi đếm `it(` / `test(` trong 8 file test để đối chiếu số mà receipt nêu. Sáu file khớp tuyệt đối, hai file thì **thấp hơn receipt**:

| File | Đếm literal | Bảng `it.each` | Thật | Receipt nói | Kết luận |
|---|---|---|---|---|---|
| `usage-metrics.test.ts` | 23 | 0 | **23** | 23 | khớp |
| `ingestion-receipt.test.ts` | 10 | 11 dòng | **20** | 20 | **heuristic sai, receipt đúng** |
| `ingest-source-pin.test.ts` | 10 | 5 dòng | **14** | 14 | **heuristic sai, receipt đúng** |
| `oidc-cookie-secure-proxy-offline.test.ts` | 13 | 0 | **13** | 13 | khớp |
| `oidc-boot.test.ts` | 22 | 0 | 22 (+6 mới) | +6 | khớp |
| `mm05-queue-integrity-sweep.test.ts` | 11 | 0 | **11** | 11 (8+3) | khớp |
| `mm05-queue-integrity-offline.functional.test.ts` | 4 | 0 | **4** | 4 | khớp |
| `mock-vault-harness-offline.functional.test.ts` | 13 | 0 | **13** | 13 | khớp |

Hai lệch **không phải** receipt sai. Đã ghi vào `docs/19` để cycle sau không đọc nhầm. Cùng lớp bẫy với bẫy "94/94 chỉ là 2 suite" của A18: **con số phải gắn với đúng câu lệnh đã chạy**.

### 12.6 Link check — hai scope, tách bạch, không gộp

Checker A19 là **bản mở rộng** của checker A18 (thêm `docs/19` vào danh sách scan), file cũ `qwendocs-link-check.ps1` **giữ nguyên** để số A18 còn tái lập được.

| Scope | Phạm vi | Kết quả |
|---|---|---|
| **S0** | 6 file lane, **không** `docs/19` | `FILES=6 TARGETS=814 ANCHORS=466 BROKEN=0` — **tái lập chính xác** số A18 đã ghi |
| **S1** | 6 file lane **+ `docs/19`** | `FILES=7 TARGETS=839 ANCHORS=490 **BROKEN=0**` |
| **S2** | **toàn bộ 178 file** tài liệu (`docs/`, `tasks/`, `coordination/`) | `FILES=178 TARGETS=1338 ANCHORS=501 **BROKEN=2**`, `EXT_SKIPPED=15` |

**S0 là bằng chứng quan trọng nhất của bảng này**: nó cho `814/466` y hệt số A18, nên chứng minh (a) tool không đổi hành vi và (b) 6 file kia không trượt link trong lúc tôi làm. Phần chênh `839 − 814 = 25` là **toàn bộ** link của `docs/19` — gồm 13 target / 12 anchor có sẵn từ trước mà checker A18 **chưa bao giờ quét**, cộng **12 / 12 của cycle này**.

**Về yêu cầu `BROKEN=0` toàn cục: tôi không thể nói, và không nói.** S2 cho `BROKEN=2`, cả hai đều là lỗi có thật và có sẵn:

| Link hỏng | File chứa | File đích | Chẩn đoán |
|---|---|---|---|
| `../tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` | `coordination/reports/antigravity-6.md` | **tồn tại** ở `du-rework/tasks/` | mất **đúng một `../`** — file nằm ở `reports/`, cần `../../tasks/` |
| `./WAVE-22-LIVE-INTEGRATION-READINESS.md` | `coordination/requests/antigravity.md` | **tồn tại** ở `du-rework/coordination/` | mất **đúng một `../`** — file nằm ở `requests/`, cần `../` |

Cùng một lớp lỗi, cùng một nguyên nhân: link được viết từ thư mục khác với thư mục file nằm trong. Cả hai file thuộc lane Antigravity, mtime **09-25**, **tôi không đụng**. Sửa chúng là việc ngoài write scope của packet này và ngoài vai trò lane docs ⇒ **báo coordinator, không tự vá, và không thu hẹp scope để ra một số xanh đẹp**.

**Công cụ tôi tự làm hỏng, đã sửa.** Bản A19 đầu **quên dòng** `if ($path -match '^file:///(.+)$')` mà bản A18 có, làm **115 link `file:///`** thành `UNRESOLVABLE` và làm hỏng luôn việc chạy scope rộng. Sửa rồi chạy lại, và chính S0 tái lập `814/466` là bằng chứng cho thấy bản sửa đúng. Ghi lại vì lần chạy đầu **không dùng làm bằng chứng được**.

### 12.7 Phát hiện báo coordinator — không adjudicate ở đây

1. **Anchor `#L239` của `codex4.md` trỏ vào dòng trống.** Nhãn là *§9 live execution evidence*; thật là dòng rỗng, §9 nằm ở `docs/19` **L244**. Checker **cấu trúc không thể bắt** (nó chỉ kiểm `1 <= n <= số dòng`), nên báo xanh. `codex4.md` là ledger của lane khác ⇒ không sửa, báo Codex-4 + coordinator. Anchor `#L32` thì đúng.
2. **Δ2 của Qwen-Platform là việc của docs-lane, packet này không phủ.** CAS re-arm nay mang write-guard eligibility mà sketch `docs/38` §3 không thể hiện, và dòng §5 `Không revive task/op terminal` nay đúng cho **cả** read predicate lẫn write CAS. `docs/38` hiện 135 dòng. Chưa đồng bộ.
3. **Δ32 của Qwen-SEC xác nhận là có thật.** `docs/runbooks/vault-oidc-operations.md` tồn tại, 334 dòng, và **không nhắc** `DU_ADMIN_COOKIE_SECURE` lẫn `DU_ADMIN_TRUST_PROXY_PROTOCOL` (0 lần mỗi cái). Vì production + origin http + trust tắt **giờ refuse boot**, đây là breaking change lên deployment mà runbook chưa có bước nào. Cần packet riêng cho runbook.
4. **Số `237` và `260` của `@du/contracts` không mâu thuẫn — chúng là hai tree state tuần tự.** Qwen-DATA ghi 13 suite / 237; Qwen-Cost ghi baseline 13 / 237 rồi 14 / 260 sau khi thêm suite `usage-metrics`. `237 + 23 = 260` khớp tuyệt đối. **Không cộng, không trung bình, không gọi là regression.**
5. **Rủi ro công cụ, lặp lại:** đếm case bằng regex literal sẽ đọc sai mọi file dùng `it.each`. Đã ghi vào `docs/19` và ở §12.5.

### 12.8 Việc còn mở — next owners

1. **Coordinator + Codex-4** — anchor `codex4.md -> docs/19#L239`; và quyết định có thu `docs/19` vào scope checker vĩnh viễn hay không (A19 mới chỉ thêm vào bản A19).
2. **Coordinator + Antigravity lane** — hai link mất một `../` ở `antigravity-6.md` và `requests/antigravity.md` (S2 `BROKEN=2`).
3. **Platform owner + Tester** — `p8-02c` rearm-1..4, đặc biệt rearm-3 terminal fence; và packet docs đồng bộ `docs/38` §3/§5 theo Δ2.
4. **Vault/SEC owner + Tester** — migration 008 trên PostgreSQL thật + legacy round-trip, Vault writer/reader policy thật, writer gửi binding field; browser OIDC-04; và packet runbook cho `DU_ADMIN_COOKIE_SECURE` / `DU_ADMIN_TRUST_PROXY_PROTOCOL` theo Δ32.
5. **Cost owner + observability owner** — COST-02..04 cùng migration/persist/producer, và **Δ-D3**: `SENSITIVE_KEY_PATTERN` thiếu exact-match/allowlist nên mọi key chứa substring `token` bị `[REDACTED]`.
6. **DATA owner + Tester/infra** — **Δ17**: `processIngestionTask` còn 0 caller, cần acquire + vật chất hóa pinned version thành artifacts READY; cùng Δ18, Δ6, và DATA-03 live.
### 12.9 Anchor drift xảy ra ngay trong cycle này, và hai anchor có sẵn sai trong §9

Đây là phần quan trọng nhất của cycle về mặt kỹ thuật, vì nó biến một nhận định cũ thành **bằng chứng quan sát được ngay trong lúc đang làm việc**.

Khi verify lần đầu, ba file receipt của các lane đang viết **còn đúng số dòng tôi đo được**, nên `BROKEN=0` lúc đó là xanh thật. Trong lúc tôi viết `docs/19` và ledger, các lane khác đã ghi tiếp:

| File | Tôi đo lúc đầu | Khi verify lại | Nguyên nhân | Anchor đã repoint |
|---|---|---|---|---|
| `qwen-vault.md` | 50 dòng, `## 1` ở L9 | **90** dòng, `## 1` ở **L10** | lane Vault **prepend** RESUME POINT cho packet Turn 119 (11:52:43) | `#L9→#L10`, `#L32→#L33`, `#L36→#L37` |
| `qwen-platform.md` | 86 dòng, `## 1` ở L13 | **87** dòng, `## 1` ở **L14** | lane Platform prepend RESUME POINT cycle 2 | `#L13→#L14`, `#L69→#L70` |
| `qwen-cost.md` | 89 dòng, `## 1` ở L13 | **156** dòng, `## 1` ở **L14** | lane Cost thêm CYCLE 2 (W-COST02-PRICING-MODEL-1) | `#L13→#L14`, `#L71→#L72` |

Cả 7 anchor trượt đều **rơi vào dòng trống**, và **link check vẫn báo `BROKEN=0` suốt thời gian đó** — vì checker chỉ kiểm `1 <= n <= số dòng đích`, mà 9, 32, 36, 13, 69, 71 đều nhỏ hơn số dòng mới. Chỉ bước **đọc nội dung dòng đích rồi so chuỗi** mới bắt được. Sau khi repoint, verify lại toàn bộ: **`MINE_ANCHOR_FAILS=0`**, 12/12 anchor của cycle này khớp nội dung.

**Hệ quả để cycle sau dùng.** Trong một cây nhiều lane ghi song song như checkout này, `BROKEN=0` **không** chứng minh anchor đúng, và một lượt repoint báo **0 anchor** phải được coi là **đáng ngờ chứ không phải kết quả tốt** — đúng cái sàn đã cứu một lần ở A15. Thứ tự đúng là **đo → viết → verify lại ngay trước lúc chốt**, vì số dòng của file đích có thể đổi *trong chính lúc bạn đang làm*. Ba lần trượt trong cycle này (`codex4.md#L239` có sẵn, rồi 7 anchor của tôi) đều là cùng một cơ chế, chỉ khác thời điểm.

**Hai anchor có sẵn sai trong §9, không phải của cycle này, tôi không sửa:**

| Anchor | Nhãn ghi trong docs/19 | Dòng đích thật trỏ vào | Đánh giá |
|---|---|---|---|
| `tester.md#L6781` | *Tester-1 receipt* | `## P8-01 live traceability barrier/teardown rerun — 2026-09-25` | không phải header receipt được gọi tới |
| `review.md#L13` | *Cycle 132-137 Reviewer audit* | dòng đầu điểm 5 (*DATA and SEC plan headers are historical*) | không phải turn/audit header |

Cùng lớp lỗi, cùng cơ chế: **trượt nội dung mà checker không thấy**. Tôi **không repoint** vì muốn repoint đúng thì phải quyết định tác giả §9 đang nói đến audit nào của Cycle 132-138 — đó là việc của Reviewer, không phải suy đoán của lane docs. Gộp chung với finding `codex4.md#L239` ở §12.7 để coordinator xử một lượt.

## 13 — CYCLE 13: D-EVID-A20 (đồng bộ bằng chứng Turn 123–125 vào docs/19 + docs/28 §8.17 + docs/35 §12.20)

**Packet**: `D-EVID-A20` — owner `qwen_docs`. Đồng bộ toàn diện bằng chứng và receipt Turn 123–125 vào hệ thống tài liệu. **Không commit, không push, không mở DB/Redis/S3/Vault window (offline thuần).**

### 13.1 Phạm vi và phân loại

Các packet trước của lane chỉ ghi `docs/19`. Lần này **là lần đầu** sửa cả 3 file, vì `docs/28` (test inventory) và `docs/35` (acceptance baseline) **chưa đăng ký** 6 suite mới/sửa trong Turn 123/125 — điều biết rõ ngay trong chính `qwen-sec.md` L24 (viết nguyên văn: `docs/28-test-inventory.md` cùng contract mới chưa được đăng ký trong inventory). Tách ra 3 nhóm: `docs/19` = **traceability** (liên kết work item → receipt → file), `docs/28` = **suite inventory** (các file test mới + số test), `docs/35` = **acceptance** (mức chấp nhận).

| File | Thay đổi | Dòng | Version |
|---|---|---|---|
| `docs/19-traceability-audit-matrix.md` | append `## Turn 123–125 closure traceability (2026-09-26)` | 322 → **363** | **không bump** (không có trường version) |
| `docs/28-test-inventory.md` | append `### 8.17 D-EVID-A19 → A20` | 627 → **639** | 1.27.0 → **1.28.0** |
| `docs/35-acceptance-baseline.md` | append `### 12.20 D-EVID-A19 → A20` | 783 → **801** | 1.27.0 → **1.28.0** |

### 13.2 Invariant: append, không insert, và prefix byte-identical

`codex4.md` gắn **19 anchor `#L`** vào 3 file này. Chỉ cần một `insert` ở giữa là lệch mọi anchor đang đúng. Vì vậy **cả 3 section mới đều append ở cuối file**, dưới mọi anchor đang gắn.

Không tin bằng lời — đo **SHA-256 của prefix** trước/sau:

| File | Prefix | SHA-256 | Kết quả |
|---|---|---|---|
| `docs/19` | 322 dòng | `C392A3BC…8917A` | **khớp** |
| `docs/28` | 627 dòng (revert dòng version trong bộ nhớ) | `4E357EDC…151A5` | **khớp** |
| `docs/35` | 783 dòng (revert dòng version trong bộ nhớ) | `1D6D384D…0DBE269` | **khớp** |

Cả 3 file: CRLF thuần, `bareLF=0`, BOM `False`, `endsNL=True`, strict UTF-8 `PASS`, **U+00E2 trong section mới = 0** (toàn bộ đều nằm tiếng Việt trong phần cũ). Bump version là sửa **cùng dòng** (1.27.0 → 1.28.0), không làm lệch dòng.

### 13.3 Nội dung được ghi vào 3 file

- **`docs/19`**: 5 dòng traceability (`Work item | receipt | Verified source and test paths | Result as recorded, and acceptance boundary`) + bảng **raw-evidence provenance** (biết receipt nào có log đọc lại được) + phần **không đổi** + **5 findings**. Không đăng ký BR nào, không đóng `Uncovered BR criterion(s)` nào.
- **`docs/28` §8.17**: đăng ký **6 suite** (3 file test mới + 3 file test sửa) theo đúng 4 cột của §8.16, kèm một đoạn **đếm test đúng đặt**.
- **`docs/35` §12.20**: 5 dòng theo đúng 3 cột của §12.19 + 4 đoạn kết luận **không cổ gate nào đóng**.

Mối giữa trạng: **MM-10 = VERIFIED-OFFLINE, không ACCEPTED**; **COST-02 = VERIFIED-OFFLINE ở tầng schema + engine**, service side chưa có; **VAULT-05 = VERIFIED-OFFLINE, production diff 0**, test thuần; **`du_admin` cookie = đóng nửa còn lại Δ27/Δ33** nhưng OIDC-04 vẫn `[ ]`, G-SEC NO-GO; **DATA-04 = VERIFIED-OFFLINE**, DATA-04 vẫn `[~]`.

### 13.4 Xác minh từ source, không tin receipt

| Receipt | Kiểm tra từ source | Kết quả |
|---|---|---|
| `W-PLAT-MM10-CANCEL-1` | `runtime.ts` `hasCancelSignal` :176, read-time SELECT :309, write-fence :348, diagnostic SELECT :354 | **3 tầng đúng** |
| `W-COST02-PRICING-MODEL-1` | `pricing.ts` **314 dòng** (khớp Turn 123), **12 export** khớp hết danh sách | **khớp** |
| `W-VAULT-CONNECTOR-ISOLATION-1` | `services.ts:106` `matchesVaultRevisionBinding` **trước** `:116` `secretResolver.resolve` | **thứ tự binding-trước-đọc đúng** |
| `W-SEC-COOKIE-CONFIG-1` | `shell-router.ts:211/908/915/975/995`, `shell-server.ts:332`, `oidc-flow.ts:139` | **khớp** |
| `W-DATA04-STREAM-BOUNDS-1` | `artifact-streams.ts:612` guard, `:569` 64 KiB, `:891` `abort`, `:903-904` cap 1 MiB | **khớp** |

**Đếm test — 6/6 file khớp:** mm10 **9**, pricing **24**, admin-shell **36**, artifact-stream-bounds **27** (11 + 5/6/5), vault-account-isolation **13** (7+6), secret-resolver **23** (18+5).

### 13.5 Raw evidence: 1/5 có log

Chỉ **Qwen-SEC** ship log — **22 file** ở `coordination/evidence/qwen-sec/`. Đọc lại từ log: `BASELINE_EXIT=0` 24/24 · `FIRST_RUN_EXIT=0` 36/36 · `PACKET_F1/F2/F3_EXIT=0` ×3 · `WIDE_R1/R2/R3_EXIT=0` và `FINAL_R1/R2/R3_EXIT=0`, mỗi lần **7 skipped + 151 passed / 158** · `NEGA_EXIT=1` 4/32 · `NEGB2_EXIT=1` 1/35 · `LINT1/LINT_FINAL/TSC1/TSC_FINAL_EXIT=0`. **18/18 khớp receipt.** Đây là cycle **duy nhất** có bằng chứng đọc lại được độc lập. **7 skipped là skip `DU_LIVE_INFRA`, không phải pass.**

### 13.6 Link check — và đối soát chênh lệch

| Scope | Files | Targets | Anchors | BROKEN |
|---|---|---|---|---|
| `S0` (6 file A18) | 6 | 844 | 487 | **0** |
| `S1` (+ `docs/19`) | 7 | 879 | 521 | **0** |
| `S2` (toàn bộ tài liệu) | 178 | 1379 | 532 | **2** |

`BROKEN=2` của `S2` là **pre-existing**, y hệt A19, không phải cycle này: `antigravity-6.md → ../tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` và `coordination/requests/antigravity.md → ./WAVE-22-LIVE-INTEGRATION-READINESS.md` — **cả hai đều thiếu một cấp `../`**, nằm trong file lane khác, ngoài phạm vi ghi. **Không dề `BROKEN=0` toàn cục một cách không trung thực.**

**Đối soát delta để chứng minh không có gãy phá:** `S0` đi 814→844 = **+30 target / +21 anchor**; đếm tay section mới trong `docs/28` + `docs/35` = **+30 / +21** — **bằng nhau**. `docs/19` mới = **+10 / +10**; phần cũ = 25/24, **khớp baseline A19**.

### 13.7 Anchor được kiểm theo *nội dung*, không theo *số dòng*

Checker chỉ xét `1 <= n <= số dòng của file đích` — **nó không phát hiện** anchor còn trúng đích hay không. 8 anchor của chính mình kiểm `OK` lần 1: `qwen-platform#89`, `qwen-cost#91`, `qwen-vault#87`, `qwen-sec#459`, `qwen-data#592`, `coordinator#1668` (Turn 123), `coordinator#1707` (Turn 125), `docs/19#324`. **`MINE_ANCHOR_FAILS=0`.**

`#L90` của `qwen-cost.md` **ban đầu sai** (ra dòng trống) — heading ở L91 — **đã repoint** có guard `occurrences == 1` **ném trước khi ghi**. 7 anchor có sẵn của `codex4.md` trong 3 file vẫn đúng (`#L498/509/517`, `#L656/666/674`, `docs/19#L32`).

### 13.8 3 phát hiện nây lên coordinator

1. **Tổng 76 của MM-10 không đối soát được.** Receipt tách `76 = 9 + 11 + 56`; 3 file tên trong đó chỉ có 12 + 5 + 18 = **35**, cả 5 = **55** so với jest 76. Không log, không chạy test → **ghi không đối soát được**, không bẻ cho khớp. Cần Tester re-run báo per-suite.
2. **3 số dòng cho 1 lần sửa.** `admin-shell-session-lifecycle.test.ts`: **560** (receipt) / **553** (coordinator) / **561** (đo ở đây). Số test **36** giống hệt — không động; nghi coordinator tóm tắt từ snapshot giữa chừng.
3. **Δ27/Δ34 chưa có tài liệu cho operator.** Boot đã **từ chối** khi production + origin http + trust off, mà `docs/runbooks/vault-oidc-operations.md` **chưa có** `DU_ADMIN_TRUST_PROXY_PROTOCOL`, `DU_ADMIN_COOKIE_SECURE`, hay 503 `Secure connection required`. Qwen-SEC nhắc 2 lần; ghi đúng gap, không đóng.

Ngoài ra, hai defect **có sẵn** trong `codex4.md` vẫn nguyên (ngoài phạm vi ghi): `docs/28#L435`/§8.8 đúng ở 444 · `docs/28#L472`/§8.12 đúng ở 478 · `docs/35#L598`/§12.11 đúng ở 603 · `docs/35#L634`/§12.15 đúng ở 636 · `docs/35#L642`/§12.16 đúng ở 643 · `docs/19#L239` rỗng dòng trống, §9 bắt đầu 244. Và pin `qwen-docs.md#L120-L184` của coordinator là **dạng `#L<n>-#L<m>`** — không khớp `^L([0-9]+)$` nên checker **không bao giờ validate**, và prepend block này làm nó lệch thêm.

### 13.9 Không làm gì

Không chạy test · không mở DB/Redis/S3/Vault · không áp migration · không sửa source hay test · không tick task row · không nâng ACCEPTED · không sửa report lane khác · không commit/push. `docs/19` không bump version; `docs/28`/`docs/35` bump **1.27.0 → 1.28.0**. HEAD `7811298`.

### 13.10 Hai lỗi của chính mình, đã bắt và đã sửa sau khi ghi

Ghi lại vì cả hai đều **lọt qua nếu không kiểm tra**, và đều là loại lỗi mà một receipt sạch sẽ che mất:

1. **`WriteAllLines` âm thầm đổi encoding cả file.** `qwen-docs.md` là **LF thuần** từ trước. `WriteAllLines` ghi bằng **newline mặc định của Windows = CRLF**, biến **toàn bộ 1305 dòng** sang CRLF — một thay đổi encoding 1305 dòng mà tôi không hề định làm, và không liên quan gì tới nội dung. Bắt được nhờ đo `crlf`/`bareLF` sau khi ghi: `crlf=1305`. Đã sửa bằng cách đọc toàn bộ, thay `CRLF → LF`, ghi lại bằng `WriteAllText`; kết quả `crlf=0, bareLF=1305`, **giữ nguyên 1305 dòng**, BOM `False`, strict UTF-8 `PASS`. 3 file `docs/*` **không** dính — chúng dùng `WriteAllText` với chuỗi tự dựng nên giữ nguyên CRLF sẵn có (đúng).
2. **Ledger entry 13 chèn sai chỗ.** Hàm insert của tôi chèn **trước** phần tử tại chỉ, nên guard khớp `L206` (`- 12 —`) lại khiến entry **13 nằm trước entry 12**; thứ tự đọc ra là `11, 13, 12`. Bắt được khi quét lại cấu trúc. Đã hoán đổi L226/L227 có guard (`- 13 ` / `- 12 ` **ném trước khi ghi**), nay là `11, 12, 13`.

Cả hai đều là lỗi **công cụ**, không phải lỗi nội dung: sau khi sửa, tiền tố của 3 file `docs/*` vẫn hash **khớp từng byte**, và link check cho ra **đúng y như trước khi sửa** (`S0 844/487`, `S1 879/521`, `S2 1379/532`). Bài họt chung: **`docs` lane phải đo `crlf`/`bareLF`/`bom` sau *mọi* lần ghi**, không chỉ lần đầu — vì hàm ghi khác nhau cho ra ending khác nhau.

## 14 — CYCLE 14: D-EVID-A21 (Turn 130 audit + 4 receipt Turn 130–133 vao docs/19 + docs/28 §8.18 + docs/35 §12.21)

### 14.1 Doc nguon truoc khi va, va hai chuyen keo duoc nhau

Packet ghi `review.md` Turn 130 o L809 — **dung**. Tinh den muc, tim thay **11** turn (100, 90, 80, 70, 60, 50, 40, 30, 20, 110, 130), va Turn 130 nam o **cuoi file** (L809–832), khong chen o dau. Hau qua truc tiep: **khong co anchor `review.md#L…` nao cua lane nao trượt** trong cycle nay, khac voi A13/A14/A15 khi turn moi chen o dau lam moi turn cu doi deu mot hang chuc dong. Tinh den luc ghi, `review.md` van 832 dong, mtime 12:37:42 — **khong doi trong suot cycle**.

Do la lan dau trong nhieu cycle ma Reviewer **khong chen turn moi**, va la lan thu 5 trong 6 ma `grep_search` va `[IO.File]::ReadAllLines` cho **so dong khac nhau**. `grep_search` doc `LineNumber` **cao hon 1**; A20 da gap mot lan. Cycle nay chi dung `ReadAllLines` va kiem **noi dung** dong dich, khong dung so.

### 14.2 Turn 130 that su thay doi gi

Doc ca muc, khong phai phan tom tat cua coordinator. Ke luat (L832): `Δ36` va `Δ23` giu **CLOSED** o pham vi Turn 110; T-CODEX-TEST-22 van chi synthetic; **T130-A1 la MISMATCH moi**; **khong gate nao duoc nang**. Turn 130 cung sua mot chi tiet trong chinh receipt cua Tester: raw log danh **401 unknown-bearer la PASS** trong khi tom tat receipt nem no vao loi. Chi tiet nho nhung rat quan trong — mot receipt tom tat sai hon receipt dung.

### 14.3 T130-A1: ghi la finding, khong ghi la xanh

Day la dong dau tien trong §8.18 ma **khong phai** mot receipt xanh, va no duoc ghi nhu vay. Tinh trang thuc te khi ta ghi:

- Route: `server.ts` comment L1944 noi ro viec bo `{ tenantId, events }`; handler L1950 tra `listPage({ items, nextCursor, prevCursor, total, limit })` o L1968. **Dung nhu Reviewer mo ta.**
- Test: Reviewer thay `admin-audit.test.ts` con khai/assert envelope cu. **Nhung file da doi tren dia luc ta ghi** (mtime 12:54:57): `AuditEnvelope` o L137–140 gom `items`/`nextCursor`/`prevCursor`, va L195 con ghi ro rang `{ tenantId, events }` da khong con.

=> **Khong co receipt, khong co exit code, khong co lan chay live nao.** Mot owner sua file **khong phai** finding da duoc giai quyet. Quy tac 4 muc ap dung ngay: **IMPLEMENTED (source) / chua VERIFIED / chua ACCEPTED**, va **chi Reviewer moi dong duoc finding cua Reviewer**.

Ba nua con mo, va no thuoc ba vai tro khac nhau: (a) owner da sua file — can receipt; (b) **thieu receipt** cho `W-ADMIN-AUDIT-TEST-ALIGN-1` ma coordinator Turn 132 giao; (c) **Tester phai sua tom tat** cua chinh minh ve 401. Them mot mau: T-CODEX-TEST-27 chay 94/94 offline nhung **file test thu ba khong ton tai va bi ignore**, nen no **khong tra loi duoc** finding nay. `G-ADMIN-OPS` giu NO-GO voi day lam blocker dau tien, dung nhu Reviewer chi dinh.

### 14.4 MM-10 Δ4: da dong, nhung hai gioi han phai di cung

Sau khi doc source, **Δ4 thật sự đã đóng ở tầng code**: `buildClaimResult` het hard-code `cancelRequested: false`. Claim `SELECT` (L242) project them `o.cancel_requested AS op_cancel_requested, o.state AS op_state`; `buildClaimResult` (L1445–1446) goi `hasCancelSignal`, va bay gio **mot dinh nghia cancel duy nhat** phuc vu ca ba be mat: heartbeat read-refuse (L332), heartbeat diagnostic (L364), claim snapshot (L1445).

Hai gioi han, ca hai deu phai ghi cung chu khong de mat:

1. **Tong test khong khop — va gap lap lai y nguyen.** Receipt tach `86 = 9 + 10 + 11 + 56`. Dem tay 6 file: `mm10-heartbeat` **9**, `mm10-claim` **10**, `mm05-sweep` **11**, `runtime-lease-fencing` **12** (8 + bang 4 dong), `br08` **5** (1 + 4), `br12` **18** (11 + 3 + 4) → **65**. Ba file cuoi cong **35, khong phai 56**. Cycle truoc (A20) tach `76 = 9 + 11 + 56` va **cung 3 file do cung ra 35**. Vay thung **21 test la y het o ca hai lan**, va suite moi cong them **dung 10** — hieu gap **khong lon theo thay doi va khong do thay doi nay gay ra**. Mot dem tinh khong luon lai tao duoc tong jest, nhung mot gap 21 **bat bien** khong co raw log de doc lai thi la **cau hoi kha nang lap lai**, va cach dung la Tester chay lai va trich per-suite — **khong phai lane tu chinh so**.
2. **Co that chua quan sat duoc qua `cancelOperation` tren writer hien tai.** Cancel dat `operations.cancel_requested=true`, `operations.state=CANCELLED` va `tasks.state=CANCELLED` trong **cung mot tx** → moi task cua op da bi chan o terminal guard tra **410 truoc khi toi `buildClaimResult`**. Gia tri that cua co chi la **op state mem `CANCEL_REQUESTED`** (hop le vi `operations.state` la text khong co CHECK constraint, admin da model, **chua co writer**), va moi writer tuong lai dat co ma khong cancel task row. **Khong bao gio viet "cancel da duoc quan sat luc claim".** Do la chinh xac ly do coordinator phai biet truoc khi tick. Live van `[OPEN]`: can DB window; `runtime.test.ts` la `DU_LIVE_INFRA`-gated, **skip khong phai pass**.

Hai negative control la **mot phan cua bang chung, khong phai nhieu**: M1 bo 2 alias du doan 5 do → that tai `5 failed, 5 passed`; M2 hard-code lai `false` du doan 4 do → `4 failed, 6 passed`. Fake DB mirror **projection semantics cua production SQL** nen xoa alias la do hanh vi, khong phai green-dummy — va **T3 (khong co cancel → phai `false`)** chan bien co thanh hang so.

## 15 — CYCLE 15: D-EVID-A22 (giai quyet Reviewer T140-D1, dong bo Audit Turn 140 vao Documentation + OpenAPI)

**Pham vi va ranh gioi.** Chi tai lieu. Khong sua code san pham, khong sua test, khong chay test, khong mo DB/Redis/S3/Vault, khong tick task row, khong nang muc acceptance, khong sua report cua lane nao khac, khong commit/push. Doc truc tiep source (`packages/contracts/src/public-api.ts`, `services/orchestrator/src/server.ts`) va cac receipt; **khong chep so lieu tu loi Reviewer** — moi so duoc tu doi chieu hoac tu source, hoac ghi ro la con mo.

### 15.1 Packet goi 3 ten file khong ton tai. Mapping thiet la:

| Ten trong packet | Trang thai | File da sua thay the |
|---|---|---|
| `docs/06-operations-api.md` | **khong ton tai** | `docs/06-public-api.md` |
| `docs/19-audit-log-reference.md` | **khong ton tai** | `docs/19-traceability-audit-matrix.md` (dong contract o §4) |
| `docs/20-openapi-spec.md` | **khong ton tai** | `docs/20-openapi-descriptions.md` **va** `docs/21-openapi.json` |

Va mot diem can noi ro hon ca do: **khong co tai lieu audit-log-reference nao trong cay**. Packet yeu cau cap nhat "audit log va envelope 5 truong" trong file do. `grep nextCursor` toan bo `docs/` chi ra `06`, `19`, `20`, `25`, `28`, `31`, `35` — khong file nao mo ta route audit. Route `GET /api/v1/admin/audit` co that (`server.ts`, doc biet bang `docs/28` §8.19), nhung `docs/20` §2 dang **xep no vao danh sach ABSENT** ("khong route"), va `docs/21-openapi.json` khong co path cho no. Toi da **bo sai do** va ghi route + envelope 5 truong vao ca hai. Do la sua mot lien ket doc-vs-doc co san, dung noi dung packet yeu cau, chu khong phai tu them noi dung.

### 15.2 Nguon: doc gi, va tai sao khong chep loi Reviewer

`packages/contracts/src/public-api.ts`:

- `OPERATIONS_LIST_QUERY_PARAMS` = **6** ten: `limit`, `cursor`, `state`, `tenant`, `id`, `sort`. Comment tai source noi ro mang y **allow-list, khong phai goi y** — route khong bao gio echo ten la.
- `OPERATIONS_LIST_SORT_FIELDS` = `created_at`, `updated_at`, `deadline_at`; `OPERATIONS_LIST_SORT_DIRECTIONS` = `asc`, `desc`; `OPERATIONS_LIST_SORT_VALUES` = **dung 6** gia tri theo thu tu field ngoai trong.
- Default: `OPERATIONS_LIST_SORT_DEFAULT_FIELD = created_at`, `_DIRECTION = desc` — thu tu route co **truoc khi** tham so nay ton tai, nen moi deep link cu giu nguyen hanh vi.
- `parseOperationsListSort(raw)`: `trim()` + `toLowerCase()`, tach tren **dau hai cham cuoi cung**; gia tri co dau hai cham thua bi **tu choi**, khong bi cat con chay. Mot ham, hai noi goi (schema `refine` va route) — comment tai source goi ro ly do: neu hai ben tu kiem, tai lieu co the cong bo mot sort ma route 422.
- `deadline_at` la cot **nullable duy nhat**. Comment source giai thich hien tuong: predicate row-value **khong bao gio TRUE voi NULL**, nen `ORDER BY deadline_at` se tra ve trang 1 dung roi **mat sach moi operation khong deadline tu trang 2 tro di**, im lang, voi HTTP 200 va mot trang trong rat hop ly.

`services/orchestrator/src/server.ts`:

- `OPERATIONS_LIST_SORT_COLUMN_SQL` la **bang tra cuu** theo field da validate, nen ten cot trong SQL chi co the la mot trong ba literal va **chuoi cua caller khong bao gio duoc noi suy vao SQL**.
- `OPERATIONS_LIST_NULLABLE_SORT_FIELDS` = `{deadline_at}`; `OPERATIONS_LIST_NULL_SORT_BOUND_SQL` = sentinel `0001-01-01T00:00:00.000Z` cho `desc`, `9999-12-31T23:59:59.999Z` cho `asc` — ca hai la ISO that tu doi chieu qua `toISOString()` (Postgres `+/-infinity` thi khong).
- `parseOperationsListSortParam`: rong hoac vang mat = default; ngoai allow-list = `HttpError(422, "INVALID_SCHEMA", "sort must be one of " + OPERATIONS_LIST_SORT_VALUES.join(", "))`. **Khong** lặng le roi ve default.
- `bindOperationsListQuery` doc qua seam `AllowListedQuery` co kieu la phan tu cua `OPERATIONS_LIST_QUERY_PARAMS`, nen `read("sort")` la **loi bien dich** — chung tao ban co the that bang mau thay vi im lang chap nhan.

### 15.3 Thu tu cong viec: finding nao duoc ghi, finding nao duoc de nguyen — va ly do

Day la quyet dinh quan trong nhat cua cycle nay, nen ghi ro.

Reviewer T140-D1 gan owner la *"Docs + contracts/OpenAPI owner **after the cursor policy is settled**"*, va gate decision cung Turn 140 viet *"Documentation sync **follows** the sort/cursor decision, so its new wording can be verified against the final wire behavior"*. Dong thoi, coordinator dispatch **ba packet cung luc** (Turn 143): Qwen-Platform `W-ADMIN-APIKEY-ALIGN-1`, Qwen-Admin `W-ADMUX02-SORT-CURSOR-BIND-1`, va packet nay. Qwen-Admin dang sua **chinh** wire behavior ma tai lieu dang mo ta.

Hai cach xu ly deu co ly do, va con lai quyet dinh cua lane:

- **Ghi `sort` day du.** Tham so nay **da** IMPLEMENTED va offline VERIFIED, ownership cua no khong thay doi gi giua cac cycle, va T140-D1 chinh yeu cau dung. Bo qua no se la bo mot phan cua finding.
- **Khong ghi phan cursor/sort nhu da chot.** T140-A1 con OPEN, va Reviewer viet ro phai chot policy truoc. Tai lieu neu mo ta mot hanh vi sap toi se bi doc nhu hop dong, va se **sai ngay khi** `W-ADMUX02-SORT-CURSOR-BIND-1` dap.

Toi chon tach hai thu, va ca hai file deu con mot doan chan **noi ro** phai doi chieu lai wire behavior sau khi packet do dap. Doc source xac nhan T140-A1 **van dung o tai thoi diem cycle nay**: token chi chua `<ISO>|<uuid>[|p]`, khong co truong sort, va `grep INVALID_CURSOR` tren route **khong tra ve gi**. Kieu do chung to T140-A1 la **con mo**, khong phai da duoc sua.

### 15.4 T130-A1: xanh live co that, va vi sao cycle nay khong dong no

Packet noi *"T-CODEX-TEST-29 (admin-audit pass 11/11 live)"*. **Premise dung.** `tester.md#L7435`:

- Receipt time `2026-09-26T13:23:20.2932970+07:00`, CWD `du-rework`, HEAD `7811298...`, khong sua source, khong commit/push.
- `CLAIM_DB_WINDOW` 13:21:20.185 → `RELEASE_DB_WINDOW` 13:23:20.293 +07, PostgreSQL `127.0.0.1:5433/du_orchestrator_test` + Redis `127.0.0.1:6380`.
- Preflight `migrate` exit 0, `migrate:verify` exit 0.
- `pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts` → **ExitCode 0, 1 suite passed, 11 tests passed, 0 failed/skipped**.

Day la lan xanh **live** dau tien cho route nay — dung thu ma text Turn 130 noi la chua co. Nhung **ba ly do rieng**, moi ly do du de dung, deu ngăn viec dong no:

- **Quy tac.** `AGENTS.md`: chi Reviewer dong finding cua Reviewer. Owner va Tester sua code, khong tu thay la closure.
- **Moi thoi gian.** `review.md` sua lan cuoi **13:21:57**; T-29 ghi luc **13:23:20**. Reviewer viet Turn 140 **truoc khi** T-29 ton tai, nen phan "khong co Tester rerun nao supersede T-CODEX-TEST-25" **dung luc viet** va **bay gio da bi vuot**. Do la **cu**, khong phai sai, va can Reviewer xem lai. Cycle nay chi ghi nhan, khong phan xu.
- **Pham vi.** Xanh chi o **suite audit**. Cung window do, `admin-base-routes.test.ts` **exit 1** (6 pass / 1 fail: thieu `body.rows`) va `admin-action-rbac-live.test.ts` **exit 1** (11 pass / 1 fail: M4 `list.body.rows` undefined). Day la **do moi hon** tren be mat Admin list, nen theo `AGENTS.md` quy tac 4 no giu gate do mo bat ke xanh ben canh.

Vay `G-ADMIN-OPS` van NO-GO, va hang Audit gia tri hon mot gio truoc, hang API-key list gia tri hon — ca hai su that nam trong **cung mot receipt**. `docs/28` §8.19 va `docs/35` §12.22 ghi dung hai mat do.

### 15.6 Ky byte va neo `#L`: lan nay khong con append-only thuan tuyet

Cycle 14 chi them o cuoi. Cycle nay **phai sua giua file**, va ly do la chinh Reviewer chi dinh danh so dong: `docs/06-public-api.md:16,44-76`, `docs/19-traceability-audit-matrix.md:155-157`, `docs/20-openapi-descriptions.md:34`. Sua o cuoi khong bao gio cham duoc choi do. Vay ky discipline phai doi theo:

- `docs/19`: sua §4 **dung mot dong** (L155 → 1 dong moi), va **noi them o duoi duoi**. `codex4.md` pin `#L32` va `#L239` vao file nay; guard so sanh **cua so 43 dong L221–263 truoc/sau** va bang nhau. Coi nhu chung minh append-only cho ca file, va nhin chung **moi** file van la append-only.
- `docs/28`, `docs/35`: chi doi **6 ky tu** tren dong version (`1.29.0` → `1.30.0`, cung do dai) + them muc o cuoi. Khong co dong nao doi vi tri.
- Kiem byte cap `CR/LF/bareLF/BOM` cho ca 6 file sau khi ghi: thuoc tinh dong hang file goc, `bareLF=0`, khong BOM. **Va phai kiem byte ngay sau MOI lan ghi, khong kiem het mot luc**: mot lan sua **tai cho** `docs/06` L45 chay **sau** buoc khoi phuc va lai goi `DocWrite`, **xoa newline cuoi lan nua** — phai them CRLF them mot lan nua. (`docs/28`, `docs/35`, `docs/21` ban goc **khong** co newline cuoi nen giu nguyen khong co.)

### 15.5 Da sua gi trong tung file

`docs/06-public-api.md` — **136 → 165**.

- Hang catalog `GET /operations`: them `sort` vao cot Input.
- Bang tham so: them hang `sort` ngay sau hang `cursor`, voi day du 6 gia tri, mac dinh, xu ly hoa thuong, 422.
- Muc moi `### Sort`: bang quy tac (tap gia tri, vang mat, hoa thuong, cach tach, sai thi, `ORDER BY`, cot nullable) — ke ca **vi sao** can sentinel cho `deadline_at`.
- `### Keyset cursor`: chuyen tu `(created_at, id)` co dinh sang `<sortKey>` la cot sort dang chon; ghi ro gia tri trong token la **gia tri bien cua sort key do** chu khong phai luon la `created_at`.
- **Doan chan T140-A1**, noi ro day la **hanh vi dang trien khai, khong phai hop dong da chap nhan**, va phai doi chieu lai sau `W-ADMUX02-SORT-CURSOR-BIND-1`.
- `### Tenant fence va loi`: them `sort` vao tap 422. Them dong ghi seam `AllowListedQuery` bien viec doc `sort` thanh loi bien dich.
- `### Trang thai bang chung`: sua mot **cau hien thuc sai** — no claim `docs/20` va dong traceability "van con contract cu" trong khi ca hai da duoc dong bo o D-DOCS-CONTRACT-SYNC-1. La cau hien thuc nen sua; khong phai lich su. Them muc rieng cho muc do cua `sort` (**IMPLEMENTED / offline VERIFIED**, chua live: chua receipt nao chay `updated_at` / `deadline_at` tren PostgreSQL that, migration 0017 chi index `created_at`) va tro toi **phan du cua T140-D1**.
- Them dong mo ta: **khong con trich so dong** cho `server.ts`, vi file dang bi lane khac sua.

`docs/20-openapi-descriptions.md` — **115 → 128**.

- Doan trang thai dau file: sua claim *"There is NO machine-readable openapi.yaml/json under du-rework"* — **sai**, `docs/21-openapi.json` dang ton tai. Thay bang con tro, va noi ro file nao la chuan khi hai file lech nhau.
- Hang `GET /api/v1/operations?...`: them `&sort`, doi "allow-listed" thanh **six names**, them `sort` vao tap 422, va chuyen cot Source sang **symbol** kem ly do ngay trong doan contract.
- Doan contract: them quy tac `sort` va thanh muc so **5** giai thich convention trich symbol.
- **Doan supersession moi** ngay sau doan A15: giu nguyen A15 **lam lich su da chap nhan** (Reviewer yeu cau *"Preserve A15 as accepted history"*), chi noi ro mang `OPERATIONS_LIST_QUERY_PARAMS` da tu 5 len 6 va A15 van dung cho pham vi da duoc xet. Khong viet lai doan A15.
- Doan T140-A1: ghi ro no **OPEN** va tai lieu **khong** mo ta cach giai quyet.
- §2: **bo `/audit` khoi danh sach ABSENT** va ghi route that voi envelope 5 truong, tap tham so cua no (`limit`, `cursor`, `tenant`, `severity`, `action` — **khong** co `sort`, `state` hay `id`), va quy tac tenant scope tu credential chu khong tu query.

`docs/21-openapi.json` — **1057 → 1276**. Path `/api/v1/operations` truoc day chi co `limit` va `cursor`, tuc **thieu 3 tham so** da ton tai truoc T140-D1. Bay gio: 6 tham so co schema, `sort` co `enum` dung 6 gia tri + `default`, response co schema 5 truong + example, them 401/403/422. Them path `/api/v1/admin/audit` cung schema 5 truong. Sua `x-absent` bo `audit` khoi danh sach. **JSON parse OK bang `node` va PowerShell** sau khi ghi.

`docs/19-traceability-audit-matrix.md` — **400 → 430**. §4 viet lai **1 dong** (trung tinh), them muc moi `## Turn 140–143 documentation traceability` o cuoi voi: bang 4 cot (T140-D1 / T140-A1 / T130-A1 / gate decision), danh sach 4 be mat da dong bo, **phan du** cua T140-D1, muc ky discipline neo `#L`, va muc "Not decided here".

`docs/28-test-inventory.md` — **650 → 666**. Version `1.29.0` → `1.30.0`. Them `### 8.19` (bang 4 cot, 5 hang) + 3 doan: ba so "xanh" khong thep san, gate decision khong doi, va reading note ve `server.ts` dang sua.

`docs/35-acceptance-baseline.md` — **816 → 830**. Version `1.29.0` → `1.30.0`. Them `### 12.22` (bang 3 cot, 5 hang) + 2 doan: khong muc acceptance nao len du duoc, va 4 gate giu nguyen NO-GO.

### 15.7 Link check S0 + S1

Chay offline, khong truy mang. Checker kiem **target file local** (tuong doi hoac `file:///`, resolve ve `du-rework/`) va anchor `#L<n>`; **target phai la FILE, khong phai thu muc** — mot lien ket den thu muc se bao `BROKEN_TARGET`; khoang `#L120-L184` khong bao kiem; kiem `1 <= n <= so dong cua file dich`.

**Ket qua cuoi cung.** `S0` = 6 file docs cua cycle nay: **FILES=6 TARGETS=809 ANCHORS=491 BROKEN=0**. `S1` = S0 **cong** `coordination/reports/qwen-docs.md`: **FILES=7 TARGETS=818 ANCHORS=500 BROKEN=0** — chenh **+9** target va **+9** anchor, dung bang 9 link that nam trong bang cua report lane. `S2` = **toan bo** 178 file `.md` duoi `docs/`, `coordination/`, `tasks/`: **FILES=178 TARGETS=1432 ANCHORS=568 BROKEN=2**, ca hai doan deu o `antigravity-6.md` va `coordination/requests/antigravity.md`, **co san** (A21 gap dung hai doan do), thuoc file lane khac. **Vi vay lane nay khong claim `BROKEN=0` toan repo** — no bao cao dung phan docs va phan report cua chinh lane, va noi ro hai doan hong con lai. So dem cua checker nay **khong so sanh duoc** voi so dem cac cycle truoc, vi lan nay checker bo qua code span con truoc thi khong bo.

### 15.8 Loi cua chinh cycle nay — ba loi, bat het truoc khi bao cao

Ghi lai vi ca ba deu la loai "cong vie co ve xong" ma khong co gi kiem:

- **`docs/21-openapi.json` hong JSON.** Ap phep thay the theo **thu tu tang dan** chu khong phai giam dan: muc `x-absent` (index 1053) duoc ap **sau** hai thay doi o index nho hon, nen no ghi sai choi va lam hong cau truc. Phat hien qua `ConvertFrom-Json`, **khoi phuc tu backup** va lam lai theo thu tu dung.
- **Thieu dau phay** trong fragment `x-absent` → van hong.
- **Thieu dau phay truoc `example`** trong ca hai fragment response → van hong. Dinh vi chinh xac lay bang `node JSON.parse` (bao cau `position` + `line` / `column`), khong phai do mat mat.

Hai loi PowerShell phai luu y cho cycle sau, vi ca hai deu **lam sai dieu ma khong bao loi ro rang**:

- **`rd` la alias san co cho `Remove-Item`, va alias duoc tra cuu TRUOC function.** Ham `Rd` cua toi bi bo qua; script "goi" `Remove-Item` va bao loi *Cannot find path D:\Git\dugate\docs\...*. Dau hieu nhan ra: duong dan loi **thieu `du-rework`** — tuc bien `$root` rong va no resolve theo thu muc hien hanh. May may la **khong co file nao bi ghi**, vi dung ngay o lan doc dau.
- **`cat` la alias cho `Get-Content`** — cung kieu, ham `Cat` bi bo qua theo cách y het.
- **Backtick la escape char trong chuoi kep cua PowerShell**, nen chuoi chua `` | `cursor` | `` bi thay bang `| cursor |`. Moi ky tu dac biet phai di qua `[char]96` hoac bien `$Q`.

- **Checker cua toi bao sai hai lan, va mot lan sai nguy hiem hon loi ghi.** (a) Self-anchor `(#L15)` duoc noi duong dan sai nen bao `BROKEN_FILE` gia. (b) Regex bo code span viet `` `[^`]*` `` **lan qua dong**; o `qwen-docs.md` (4.906 backtick) no lam lech cap backtick roi **nuot ca 9 link that** trong bang, nen `S1` bao `TARGETS=809` **bang dung** `S0` — mot con so bao chung rang no **khong kiem gi**. Phai gioi han code span **trong mot dong**. Day la false negative, nguy hiem hon false positive: no bao `BROKEN=0` cho mot pham vi thuc su rong. **Bai hoc A22: mot con so dem khong doi khi pham vi lon them la phai nghi ngay, chua phai la kiem chung.**

### 15.9 Phat hien khong sua — de lan sau xu ly

- **`coordination/gates/contracts-v1.md`** — phan con lai cua T140-D1. Module map van liet ke contract operations-list **khong co symbol `OPERATIONS_LIST_SORT_*` nao**, nen nguoi doc bang gate table thay contract 5 tham so. File tu khai `Owner: Claude (platform lane)` va mang verdict gate, nen ngoai pham vi ghi cua lane docs. **Da bao cao trong `docs/19`, `docs/28` §8.19, `docs/35` §12.22 de coordinator dinh tuyen, thay vi sua lam diem mo.** Day la phan duy nhat cua T140-D1 cycle nay khong cham.
- **Nhieu dong lech cot co san trong `docs/35`**: L196, L285, L339 (hang separator co dau canh `:---:`) va L684, L718 den L726. Khong trong phan cycle nay viet; sua chung nhieu dong lich su cua nguoi khac la regression risk khong can bang. Ghi lai, khong sua.
- **L45 cua `docs/06` (da sua, dong trung tinh)** — chuoi enum co dau `|` tho **ngoai** code span, lam vo bang thanh 8 cot. Day la loi **co san**, khong phai cua cycle nay, nhung no nam trong chinh bang allow-list ma T140-D1 yeu cau sua, nen de lai thi bang van vo. Da escape dau, 165 → 165.

### 15.10 Khong lam gi, va con gi la

**Khong:** sua code san pham · sua test · chay test · mo DB/Redis/S3/Vault · tick task row · nang muc acceptance · sua report cua lane khac · **tu phan xu policy cursor/sort** · tick T130-A1 hay T140-A1 · commit/push (`git log -1` van la `7811298`).

**Con mo, thuoc ve vai tro khac:**

- **T140-A1** — policy cursor/sort phai duoc chot va cai dat o route **va** shell, kem negative cross-sort + live keyset. Owner contracts/Platform/Admin UI, packet dang bay. **Phan tai lieu da dong bo trong cycle nay phai duoc doi chieu lai** khi no dap.
- **T140-D1** — con mot phan (`contracts-v1.md`); va du Reviewer moi dong duoc phan da lam.
- **T130-A1** — can Reviewer xem lai, vi xanh T-29 den **sau** luc Reviewer viet Turn 140; va Tester van can sua summary cua T-25 (raw log danh dau 401 unknown-bearer la **pass** trong khi receipt xep no vao so that bai).
- **API-key list `rows` vs `items`** — 2 suite do trong window T-29, da dispatch cho Qwen-Platform.
- **Tu cycle 14 chua ai tra loi:** gap 21 test MM-10 (receipt 86, dem tay 6 file ra 65, lap lai nguyen gap A20) va so dong `server.ts` lech voi receipt.
- **`/compress` cua cycle 14 (A21)** — van chua chay; cycle 15 dua no sang cuoi va noi ro hon.

## 16 — CYCLE 16: D-EVID-A23 (đồng bộ generator + gate contract map để đóng T140-D1)

- **Packet**: `D-EVID-A23` — sửa `tools/openapi/gen_openapi.py` để quảng bá đủ 6 query param của `GET /api/v1/operations`, chạy lại generator, cập nhật `coordination/gates/contracts-v1.md`, kiểm link S0/S1.
- **Nguồn đã đọc**: `du-rework/AGENTS.md`, `review.md` Turn 150 (L861–886, đặc biệt finding 4 ở L876 và T140-D1 ở L867), `tools/openapi/gen_openapi.py`, `tools/openapi/validate_openapi.py`, `tools/openapi/probe_cases.js`, `packages/contracts/src/public-api.ts` (L40–258), `services/orchestrator/src/server.ts` (L2283–2383), `coordination/reports/qwen-admin.md`, `coordination/reports/tester.md`.
- **Thời điểm**: 2026-09-26 ~14:05–14:20 +07. HEAD vẫn `7811298`, không commit/push.
- **Không cần mapping tên file lần này**: cả `tools/openapi/gen_openapi.py` và `coordination/gates/contracts-v1.md` đều tồn tại đúng như packet nói (khác A22, packet đó gọi 3 file không có).

### 16.1 Reviewer nói gì, và phần nào của nó tôi làm được ngay

Turn 150 finding 4 (L876) gói T140-D1 thành **bốn việc**: (1) sửa `gen_openapi.py`, (2) regenerate rồi so sánh artifact, (3) cập nhật `contracts-v1.md`, (4) **"revise docs/06/20 once T140-A1's final wire policy is verified"**. Việc (4) có điều kiện, và điều kiện đó **chưa thỏa** — xem §16.7. Tôi làm (1)(2)(3) và **không** làm (4), ghi lý do.

Đây cũng chính là mảng T140-D1 mà cycle 15 **cố ý không chạm** vì file tự ghi `Owner: Claude (platform lane)`. Lần này packet giao tường minh nên tôi sửa được, nhưng vẫn giữ nguyên verdict gate và dòng owner (§16.4).

### 16.2 Nguyên nhân gốc, đo trước khi sửa

Tôi chạy generator cũ vào một file scratch rồi so với artifact hiện tại, **không ghi đè file thật**. Kết quả:

| | generator cũ | artifact sau A22 |
|---|---|---|
| số path | 41 | **42** |
| param của `/api/v1/operations` | `limit`, `cursor` | **6 tham số** + schema/enum/default |
| response của path đó | `200` | `200`, `401`, `403`, `422`, schema 5 trường + example |
| `/api/v1/admin/audit` | **không có** | có (5 param) |
| `x-absent` | liệt kê `audit` là **absent** | đã gỡ `audit` ra |

Nghĩa là **một lần `python gen_openapi.py` trên máy sạch sẽ xóa 1 route, 4 query param, envelope 5 trường, 3 mã lỗi, và khôi phục lại một mục `x-absent` sai**. Đây đúng là "a fresh generation can erase the documented contract" — không phải rủi ro lý thuyết, tôi đo được.

### 16.3 Sửa generator: lấy allow-list từ contract thay vì chép tay

Packet bảo bổ sung 6 param. Tôi làm thêm một bước, vì nếu chỉ chép tay 6 giá trị thì đây chỉ là một bản chép tay khác — và T140-D1 là **lỗi trôi do chép tay**, nên chép tay lần nữa là không học được gì.

Generator nay **đọc `packages/contracts/src/public-api.ts`** và tự suy ra:

- `OPERATIONS_LIST_QUERY_PARAMS` → thứ tự 6 tham số.
- `OPERATIONS_LIST_SORT_FIELDS` × `OPERATIONS_LIST_SORT_DIRECTIONS` → `OPERATIONS_LIST_SORT_VALUES`. Lưu ý: trong contract `OPERATIONS_LIST_SORT_VALUES` **không phải mảng literal** mà là `flatMap`; generator tái tạo đúng phép tính đó, không gõ tay 6 chuỗi.
- `OPERATIONS_LIST_SORT_DEFAULT_FIELD`/`_DIRECTION` → `created_at:desc`.
- `OPERATIONS_STATE_FILTER_VALUES` **bỏ `ALL`**. Đây là điểm tôi suýt làm sai: enum trong contract có 5 giá trị, nhưng route **lọc `ALL` ra khỏi thông điệp 422** (`server.ts:2312`), nên trên dây chỉ có 4. Tôi đã kiểm `server.ts` và giữ **4** — khớp cả contract lẫn route, không "sửa" thành 5.
- `OPERATIONS_LIST_TOKEN_PATTERN` → `schema.pattern` của `tenant` và `id`.
- `OPERATIONS_LIST_LIMIT_DEFAULT`/`_MAX` → schema của `limit`.

**Hai chốt chặn, và tôi đã thử để chứng minh chúng bắn:**

1. `assert QUERY_PARAMS == [...]` — nếu contract thêm tham số thứ 7, generator **dừng** kèm lời nhắc thêm tham số đó. Tôi tiêm `owner` vào một bản sao contract và chạy: `AssertionError: OPERATIONS_LIST_QUERY_PARAMS changed to ['limit','owner','cursor','state','tenant','id','sort']`.
2. `assert not dropped` — đọc set path của artifact **trước** khi ghi, rồi chặn nếu lần regenerate làm mất path nào đó. Đây đúng là cái lỗi Reviewer chỉ ra. Tôi cấy một route giả `/api/v1/canary-fake-route` vào artifact rồi chạy: `AssertionError: regeneration dropped documented paths ['/api/v1/canary-fake-route']`.

Sau khi ghi, generator **đọc lại file vừa ghi** và kiểm: 6 param đúng thứ tự contract, enum `sort` đúng `SORT_VALUES`, response đủ `200/401/403/422`, và `/api/v1/admin/audit` còn mặt.

Một thay đổi phụ đáng nói: generator xuất **LF**, trong khi **mọi** file khác dưới `du-rework/docs` đều là CRLF. Tôi đổi sang CRLF cố định để `gen` → `diff` sạch thay vì xoay cả file. Đây là thay đổi hành vi có chủ đích, ghi ở đây để không bị đọc nhầm là vô tình.

### 16.4 `contracts-v1.md`: dòng 43 + impact note

Đổi **đúng một dòng** (dòng 43, hàng `public-api.ts` trong module map) và **thêm 2 dòng cuối file**. Vì mọi thứ thêm nằm dưới mọi dòng cũ, **không số dòng nào bị dịch** — kể cả `#L43` nếu có ai neo vào chính hàng đó.

Hàng nay nêu `OPERATIONS_LIST_SORT_FIELDS`, `OPERATIONS_LIST_SORT_DIRECTIONS`, `OPERATIONS_LIST_SORT_VALUES` (kèm 6 giá trị theo đúng thứ tự), `OPERATIONS_LIST_SORT_DEFAULT`, `parseOperationsListSort()`/`formatOperationsListSort()`, khoá `sort` trên `ListOperationsQuerySchema`, và `ListPageBaseSchema`.

File tự đòi `### Change policy after READY`: sửa sau READY cần **impact note trong chính file này**. Tôi thêm một mục change-log ghi rõ đây là **đồng bộ tồn kho tài liệu, không đổi wire, không đổi fixture consumer**, vì `public-api.ts` đã export tất cả những symbol đó từ trước.

Các bất biến tôi kiểm là **không đổi**: dòng verdict `# Gate: contracts-v1 — **READY**`, dòng `Owner: Claude (platform lane)`, `WIRE_CONTRACT_VERSION`, `## Conventions frozen at v1`, `## Change policy after READY`, `## Module map`, `### Change log`. Số dấu `|` trong hàng 43 giữ nguyên (3), nên bảng không vỡ cột.

### 16.5 Bằng chứng chạy

Tất cả lệnh chạy từ `D:\Git\dugate`, offline, **không** dùng DB/Redis/S3/Vault, **không** build, **không** chạy test sản phẩm.

| lệnh | exit | kết quả |
|---|---|---|
| `python du-rework/tools/openapi/gen_openapi.py` | **0** | `OPENAPI-JSON path-count=42 operations-params=6 sort-values=6 dropped-paths=0` |
| chạy lại lần 2 + `fc /b` | **0** | `no differences encountered` — **tái sinh byte-idempotent** |
| `node -e require('./du-rework/docs/21-openapi.json')` | 0 | `JSON OK paths=42 x-absent=7` |
| so artifact mới với backup A22 | — | **1276 → 1276 dòng**, khác **đúng 5 chuỗi**, tất cả đều có chủ đích |

5 chuỗi đổi: `(six names)`→`(6 names)` (bỏ chữ đếm tay); mô tả `cursor` (xem §16.7); mô tả `tenant` (bỏ regex viết lại trong prose, trỏ sang `schema.pattern`); mô tả `sort` (nội suy allow-list thật thay vì tự nói "these six values"); summary của `/api/v1/admin/audit` (bỏ mệnh đề `Added in D-EVID-A22;` — id packet không nên nằm trong hợp đồng sinh máy).

**Mọi route và mọi param đều còn.** Không có route nào bị mất.

### 16.6 `validate_openapi.py` đỏ — có sẵn, không phải do cycle này, và tôi KHÔNG sửa

`python du-rework/tools/openapi/validate_openapi.py` → **exit 1**, 21 PASS / 2 FAIL: `ArtifactFinalizeRequestSchema` (thiếu `leaseEpoch`, `taskId`) và `ClaimTaskRequestSchema` (thiếu `businessId`).

Chứng minh nó độc lập với việc tôi vừa làm, theo ba bước:

1. Các assert ở **tầng spec** trong chính file validator đó **đều pass**: `paths=42 x-absent=7`, đủ toàn bộ path trong danh sách `need`, `x-absent >= 5`. Tức **artifact hợp lệ**; đỏ nằm ở tầng probe.
2. `probe_cases.js` là **mảng literal** đóng cứng. Nó chỉ `require` `packages/contracts/dist/index.js` và **không bao giờ mở `docs/21-openapi.json`** (tôi grep: `21-openapi` xuất hiện 0 lần trong file). Chạy nó **đứng riêng**, không có validator, không có spec → **vẫn 21 PASS / 2 FAIL, exit 1**.
3. Nguồn chuẩn: `runtime.ts:32-36` khai `ClaimTaskRequestSchema` có `businessId`, và `runtime.ts:212` `ArtifactFinalizeRequestSchema` mở rộng `LeaseBoundRequestSchema` (`leaseEpoch`, `taskId`). Fixture trong `probe_cases.js` viết trước khi contract đó đổi.

**Không sửa.** `probe_cases.js` là **test fixture**, ngoài ràng `chỉ sửa tài liệu và generator script` của packet. Tôi báo cáo, không tự ý vá — và nhắc rõ nó **không** làm mất uy tín phần generator, vì phần generator có bằng chứng riêng, byte-idempotent.

### 16.7 T140-A1: mã nguồn đã đổi, nhưng tôi KHÔNG ghi nó thành hợp đồng đã chốt

Đây là phần dễ sai nhất của cycle này, nên tôi tách riêng.

`server.ts` giờ **3.188 dòng** (cuối A22 là 3.101). `parseAllowListedOperationsListQuery` **đã** so `decoded.sort.field/direction` với sort của request và **ném 422** khi lệch, kèm thông điệp nêu cách xử lý. Tức **wire code đã đóng T140-A1 ở mức IMPLEMENTED**.

Nhưng `AGENTS.md` quy tắc 4: IMPLEMENTED khác VERIFIED khác ACCEPTED. Tôi kiểm receipt:

- `qwen-admin.md` — **không có** mục nào cho `W-ADMUX02-SORT-CURSOR-BIND-1`. Owner chưa nộp receipt.
- `tester.md` — **không có** receipt live nào cho keyset/sort/cursor-binding.

Nên T140-A1 = **IMPLEMENTED, chưa VERIFIED, chưa ACCEPTED**. Hệ quả cụ thể: câu `docs/21` do A22 viết — *"See T140-A1: the token carries no sort identity"* — **nay sai thật** so với source.

Tôi sửa **đúng chuỗi đó** trong artifact, ghi lại hành vi đang quan sát được (token mang định danh sort, cursor lệch sort bị 422) kèm câu **"T140-A1 vẫn mở, đó là hành vi đã cài chứ không phải hợp đồng đã chốt"**. Tôi không để một machine-readable contract mang một mệnh đề đã biết là sai, nhất là khi tôi đang sửa đúng file đó.

**Còn `docs/06` và `docs/20` thì tôi KHÔNG đụng** — vì cả packet lẫn Reviewer đều ghi điều kiện *"once T140-A1's final wire policy is verified"*, và nó **chưa** verified. `docs/06:90-94` vẫn còn câu *"Token cursor không mang định danh sort"*, tức **câu chữ đó giờ lệch với source**. Tôi ghi kệ này ở §16.9 để coordinator quyết, thay vì tự tiên hoàn tài liệu theo mã của người khác đang sửa.

### 16.8 Link check S0 / S1 / S2

| scope | FILES | TARGETS | ANCHORS | BROKEN |
|---|---|---|---|---|
| **S0** — 6 file docs như A22 | 6 | 807 | 493 | **0** |
| **S1** — S0 + `contracts-v1.md` + `qwen-docs.md` | 8 | 816 | 502 | **0** |
| **S2** — toàn bộ `docs` + `coordination` + `tasks` | 178 | 1430 | 570 | **2** |

Hai link gãy ở S2: `coordination/reports/antigravity-6.md:8952` và `coordination/requests/antigravity.md:10` — **đúng hai cái A22 đã báo**, của lane Antigravity, ngoài phạm vi ghi của tôi. **Tôi không claim `BROKEN=0` toàn cục.**

**Vì sao S0 ra 807/491 thay vì 809/491 như A22:** đây là **một bộ checker mới**, không phải tài liệu đổi. Bằng chứng: mtime cho thấy chỉ `docs/21-openapi.json`, `gen_openapi.py` và `contracts-v1.md` bị ghi lúc 14:12–14:14; `docs/06`, `docs/19`, `docs/20`, `docs/28`, `docs/35` vẫn nguyên 13:47–13:56 (đúng giờ A22 ghi). Mà `docs/21` là JSON, không có markdown link nào. Nên chênh lệch nằm ở cách đếm, không phải nội dung — tôi ghi rõ thay vì cho nó khớp.

**Bẫy checker lần này — và nó cũng gần bằng 114 lỗi bịa:** lần đầu S2 báo `BROKEN=114`, gần như toàn bộ là URL `file:///D:/...`. Tôi **không** báo con số đó. `file://` phải được resolve thành đường dẫn thật; giờ 112 target `file://` đều resolve, **0 thiếu**. Bỏ qua chúng thì báo `BROKEN=0` cho phạm vi chưa quét — cũng là loại bằng chứng bịa. Cộng thêm bài học A22 về regex code-span: tôi giữ nó **trong một dòng**, vì bản lan dòng sẽ nuốt link thật và báo `BROKEN=0` cho phạm vi rỗng.

Ngoài ra: `coordination/reports/tester3.md` **không phải UTF-8** (decode phải thay thế). Báo cáo, không sửa — file của lane khác.

### 16.9 Phát hiện không sửa, và cái còn tre

**Không sửa vì ngoài phạm vi ghi:**

- **`probe_cases.js`** — 2 fixture lỗi thời so với contract (§16.6). Cần owner lane test, không phải lane tài liệu.
- **`docs/06:90-94` + `docs/20`** — câu chữ cursor/sort. **Cần coordinator quyết**, vì T140-A1 IMPLEMENTED nhưng chưa có owner receipt lẫn Tester live receipt; packet lẫn Reviewer đều đặt điều kiện "sau khi verified".
- **`docs/35` L196/285/339/684/718–726** — lệch cột có sẵn từ A21/A22, vẫn nguyên.
- **Hai link gãy ở S2** — của lane Antigravity.

**Trạng thái T140-D1 sau cycle này:** nửa generator **đóng** (offline, byte-idempotent, có 2 chốt chặn đã thử bắn); nửa gate contract map **đóng** (dòng 43 + impact note, verdict và owner giữ nguyên); nửa câu chữ cursor **còn mở**, chờ T140-A1 verified. **Reviewer mới là người đóng finding.**

**Còn tre, thuộc vai trò khác:** T140-A1 (cần owner receipt + Tester live keyset/sort, rồi mới đóng); T130-A1 (Reviewer xem lại); 2 suite API-key-list đỏ trong window T-29; `probe_cases.js`; `tester3.md` encoding; **và `/compress` của cycle 14 (A21) vẫn chưa chạy — tôi lại đưa nó xuống cuối lần thứ ba.**

**Không làm:** không sửa code sản phẩm · không sửa test · không tick task row · không nâng mức acceptance · không tự phán xử T140-A1 · không sửa report lane khác · không commit/push (`git log -1` vẫn `7811298`).

## 17 — CYCLE 17: D-EVID-A24 — đồng bộ Turn 150–154: ba live suite xanh, T130-A1 CLOSED, 54 test sort-binding

### 17.1 Phạm vi và ranh giới

Đọc `AGENTS.md`, `tester.md` (T-CODEX-TEST-29/30/31 + raw log T-31), `review.md` (Turn 130, 140, 150 đầy đủ), `qwen-admin.md` Mục 15, `qwen-platform.md` Mục 7, và coordinator Turn 151–160. **Đọc source, không tin receipt**: đếm lại từng con số test từ file thật (§17.3), đọc assertion `tests/admin-base-routes.test.ts:213-247` để xác nhận phần fail-closed, đọc `docs/06:90-94` và `docs/admin-ops-monitoring-cost.md:21` để xác nhận hai câu đã thành sai. Sửa **3 file docs** (`docs/28` §8.20, `docs/35` §12.23, `docs/19` mục Turn 150–154) + receipt này. **Không** sửa code sản phẩm, **không** sửa test, **không** chạy test, **không** mở DB/Redis/S3/Vault window, **không** tick task row, **không** nâng mức acceptance, **không** sửa report lane khác, **không** commit/push.

### 17.2 Điều packet nói, và điều source cho phép tôi viết

Packet giao ba mốc: T130-A1 CLOSED, T-CODEX-TEST-31 7/7 live, 54 unit test của sort-cursor binding. Cả ba **đều có thật** — nhưng chúng thuộc **ba mức khác nhau**, và gộp chung là cách một baseline sai được tạo ra. Tôi ghi tách:

- **T130-A1 CLOSED** — chỉ Reviewer đóng được, và Reviewer **đã** đóng ở `review.md:873` + `:886`. Ghi CLOSED, kèm đúng phạm vi: **chỉ audit suite**, không đụng gate. Đây là thay đổi thật so với A22, nơi tôi ghi "advanced, not adjudicated" — nay bị một Reviewer turn sau lất đi, đúng cách nó phải lật.
- **T-CODEX-TEST-31 7/7 live** — có thật, có raw log, có window claim/release. **Thay thế 6/7 của T-30 cho suite này**; 6/7 giữ nguyên làm lịch sử đỏ. Nhưng **không** kéo theo `ADM-UX-02` lên `[x]`: ba list còn lại chưa sort, `updated_at`/`deadline_at` chưa có index, audit chưa có filter thời gian/actor/resource, `label`/`last-used` **không có cột**, C1–C5 browser chưa chạy.
- **54 test sort-binding** — có thật, nhưng **offline**. Chính chủ sở hữu tự ghi mức của mình ở Mục 15.8: `IMPLEMENTED + VERIFIED-OFFLINE`, **không** VERIFIED, **không** ACCEPTED. Tôi ghi đúng mức đó. Cross-sort negative **có** (bảng 6×6, chỉ chấp nhận đường chéo, 30 ô còn lại 422 với `calls` rỗng) — nhưng nó chạy trên **fake db ghi âm**, và bằng chứng keyset live (T-CODEX-TEST-20) là của **hình thái token cũ**. 422 offline không phải 422 trên trang keyset thật.

**Không cái nào là một release gate.** Coordinator Turn 155–156 tự tóm tắt "tất cả phát hiện Turn 140/150 đã hoàn tất ở cấp độ kỹ thuật" — đúng ở cấp kỹ thuật, và **bốn gate vẫn NO-GO** theo chính quyết định Turn 150 của Reviewer. `docs/35` §12.23 nói thẳng: một số suite xanh không phải một mức nghiệm thu, ba số suite xanh cũng không phải ba lần một.

### 17.3 Tự kiểm chứng từng con số, không nhận từ receipt

Đây là phần load-bearing nhất của cycle. Mọi con số dưới đây tôi đếm lại từ file thật:

| Con số | Nguồn | Cách tôi đếm | Kết quả |
|---|---|---|---|
| **54** test sort-binding | `tests/operations-list-cursor-sort-binding.test.ts` (488 dòng) | giải nổ **5** bảng `it.each` + đếm `it(` thường, theo từng `describe` | **khớp 54** |
| **162** bộ ba operations-list | 3 file | 54 + 19 + 83 thường + 6 từ bảng sort của file pagination | **khớp 162** |
| **7** base-routes | `tests/admin-base-routes.test.ts` (292 dòng) | 7 `it(`, 0 `it.each` | **khớp 7** |
| **11** audit · **12** RBAC | file tương ứng | 11 và 12 `it(`, đều 0 `it.each` | **khớp** |

**Chi tiết 54, để người đếm sau không phải đoán:** `describe` L162 = 4 thường + 6 = 10 · L227 = 4 + 6 = 10 · L312 = 3 + 5 = 8 · L368 = 0 + 7 (`combos`) = 7 · L413 = 2 + 14 (`malformed`) = 16 · L456 = 3 + 0 = 3. **Tổng 54.**

**Ba cái bẫy tôi trúng, ghi vào `docs/28` §8.20 để lần sau không phải trúng lại:**

1. `it.each([...OPERATIONS_LIST_SORT_VALUES])` là **một dòng** nhưng nở ra **6** dòng. Đếm theo dòng ra 21 thay vì 54.
2. Hai bảng là hằng đặt tên — `combos` (7 dòng) và `malformed` (14 dòng) — và quét `{ label:` sẽ đếm **cả dòng khai báo**, vì type `const combos: { label: string; … }[]` cũng chứa `{ label:`. Đếm hớt ra **8 và 15**, tổng **56**. Tôi đã ra đúng 56 ở lần đầu rồi sửa.
3. Suite có **6** `describe`, không phải 5. Mục 15.4 ghi "54 test / **5** describe"; khối thứ sáu là khối companion-finding ở dòng 368, thêm cho lỗi `WHERE`-fold. **Số test không đổi** — chỉ số describe trong prose của receipt thấp hơn một. Ghi vào docs, **không** sửa receipt của lane khác.

### 17.4 Cái bẫy framing: 30/30 là tổng của ba receipt trong hai window, không phải một lần chạy 30 test

Coordinator Turn 153 ghi "TỔNG: 30/30 TESTS LIVE PASS". Phép cộng **đúng** — 11 + 12 + 7. Nhưng audit và RBAC chạy trong window T-30 (13:50:57 → 13:52:59 +07), còn base-routes chạy ở window T-31 (14:11:07 → 14:11:56 +07). **Không có lệnh nào trong tree này chạy cả ba cùng lúc.** Tôi ghi rõ điều này ở cả ba file docs: các con số thì an toàn để trích, còn *phiên* mà câu "bộ ba" gợi ý thì không tồn tại. Đây là loại chi tiết mà một baseline đọc lại năm năm sẽ hiểu sai.

### 17.5 Anchor: mọi thứ append, không dòng nào trượt

- `docs/28`: 666 → **684**. Đúng **2** opcode khác `equal`: thay L3 (`1.30.0` → `1.31.0`, **cùng 6 ký tự**) + chèn 18 dòng cuối. L1–L2 và **L4–L666 nguyên vẹn** (kiểm bằng `difflib`, không phải bằng mắt).
- `docs/35`: 830 → **844**. Đúng **2** opcode: thay L3 + chèn 14 dòng cuối. **L4–L830 nguyên vẹn**.
- `docs/19`: 430 → **453**, **append thuần túy**, **430 dòng đầu byte-identical**. **Không** thêm trường `Document Version` — file này vốn không có, và `docs/19:313` đã ghi rõ chuyện đó là chủ ý.
- Quét toàn tree: **18** anchor ngoài trỏ vào ba file này, max `#L674` (trong `docs/35` dài 844), **không cái nào rơi vào khoảng đã append**. `in-range anchor fails = 0`.

### 17.6 Link check S0 / S1 / S2

- **S0** (6 file docs) `FILES=6 TARGETS=834 ANCHORS=519 BROKEN=0`.
- **S1** (9 file, thêm `qwen-docs.md` + `contracts-v1.md` + `qwen-admin.md`) `TARGETS=843 ANCHORS=528 BROKEN=0`.
- **S2** (223 file toàn repo) `TARGETS=1551 ANCHORS=641 BROKEN=2` — đúng **hai** link gãy có sẵn của A22/A23, thuộc lane Antigravity (`antigravity-6.md:8952`, `requests/antigravity.md:10`). **Không** sửa, **không** claim `BROKEN=0` toàn cục.

**Checker của tôi báo 262 lần đầu và con số đó là sai** — tôi không báo nó. Hai lỗi, cùng một họ: (1) không bỏ qua URL ngoài (`https:`/`mailto:`) nên 22 link tài liệu ngoài bị đếm là gãy; (2) tôi validate `#L` theo **số dòng của file tham chiếu** thay vì **file đích** — 240 `BAD-ANCHOR` là hệ quả. Đã sửa cả hai, chạy lại, và chỉ báo con số sau khi nó đúng. Một checker báo sai thì tệ hơn không có checker.

### 17.7 Hai câu đã thành sai so với source, ghi ra chứ không sửa

`docs/06-public-api.md:90-94` vẫn nói token cursor **không mang định danh sort**; `docs/admin-ops-monitoring-cost.md:21` vẫn nói list không có cursor/filter/sort phía server. Cả hai đúng khi viết, và **giờ sai**: wire đã gán ordering, route đã nhận đủ 6 tham số. **Không sửa file nào.** Lý do không phải ngại ngạn: `docs/06` là nửa còn lại của T140-D1 mà Reviewer **điều kiện hoá** — "revise docs/06/20 once T140-A1's final wire policy is verified" — và T140-A1 chưa verified. `docs/admin-ops-monitoring-cost.md` thuộc work item khác. Ghi vào `docs/19` mục Turn 150–154 để người đọc thấy câu nào đã lỗi thời và vì sao nó vẫn còn đó.

### 17.8 Lỗi của chính tôi trong cycle này

**`docs/28` bị hỏng một lần và đã khôi phục.** Lần ghi đầu, tôi `replace(NL, CRLF)` trên nội dung **đã có sẵn `\r`** — mỗi dòng nhận hai `\r`, sinh `\r\r\n` trên 683 dòng. `difflib` lộ ra ngay (hàng trăm `insert` rác). Tôi khôi phục từ backup rồi làm lại bằng cách chuẩn hoá về LF trước, quy đổi CRLF **một lần ở cuối**. Kết quả lần hai: `CRCRLF=0`, `bareLF=0`, đúng 2 opcode. **Backup trước khi ghi là bắt buộc, không phải phòng xa** — lần này nó là thứ duy nhất giữ được file.

Hai lần đếm sai trước khi đúng (56 thay vì 54; `describe` 5 thay vì 6) đều do đếm bằng regex thay vì bằng cấu trúc, và đều bị bắt trước khi ghi vào repo — vì tôi kiểm fragment tách riêng trước khi ghép. Ba lần chạy `python -c` với `\n` trong chuỗi lẫn dấu `+` thừa từ patch dòng: đều là lỗi escape ở tầng `exec`, hết bằng cách chuyển sang file `.py` như quy tắc đã chốt.

### 17.9 Không làm

Không sửa code sản phẩm · không sửa test · không chạy test · không mở DB/Redis/S3/Vault window · không tick task row · không nâng mức acceptance · không tự phán xử T140-A1 · không sửa report lane khác (kể cả số `describe` lệch trong Mục 15.4) · không sửa hai câu sai ở `docs/06`/`docs/admin-ops-monitoring-cost.md` · không sửa hai link gãy của lane Antigravity · không commit/push (`git log -1` vẫn `7811298`).

**Còn tre, thuộc vai trò khác:** T140-A1 (cần diff ổn định + **live keyset** cho token mới, rồi Reviewer phán quyết) · nửa còn lại của T140-D1 (câu cursor ở `docs/06`/`docs/20`, chờ T140-A1 verified) · ADM-UX-02 (3 list còn lại, index 0018, C1–C5 browser) · COST-01→04 · tóm tắt receipt T-25 sửa số 401 · `tester3.md` encoding · 2 link gãy lane Antigravity · **`/compress` của cycle 14 (A21) — lần thứ tư**.

## 18 — CYCLE 18: D-EVID-A25 — hai finding MEDIUM của Turn 160: probe fixture đỏ, và grammar cursor tự mâu thuẫn

### 18.1 Phạm vi, và một lần tôi phải nói rõ vì nó lệch quy tắc lane

Đọc `AGENTS.md`, `review.md` Turn 160 (đã xuất bản, `review.md:888-916`), `runtime.ts`, `validate_openapi.py`, `probe_cases.js`, `gen_openapi.py`, `server.ts:2193-2380`, và **raw output** của validator. Sửa `tools/openapi/probe_cases.js`, `tools/openapi/gen_openapi.py`, và regenerate `docs/21-openapi.json`.

**Điểm cần ghi trước mọi thứ khác:** suốt 17 cycle, lane này giữ một quy tắc cứng — **không sửa test**. Ở A23 tôi đã gặp đúng `probe_cases.js` và **cố ý không sửa**, ghi lại là "test fixture, ngoài phạm vi packet". Cycle này vỡ quy tắc đó, và vỡ nó **có căn cứ**: (1) packet của coordinator giao rõ hai dòng cụ thể cần sửa; (2) Reviewer Turn 160 tự gán owner cho finding này là *"contracts/OpenAPI test owner"* (`review.md:904`); (3) `probe_cases.js` là **fixture dữ liệu mẫu**, không phải assertion — nó không kiểm tra gì cả, nó chỉ `safeParse` một payload mẫu. Sửa nó là **sửa dữ liệu mẫu cho khớp contract**, không phải làm yếu bất kỳ phép kiểm tra nào. Tôi vẫn ghi lại việc vỡ quy tắc này thay vì coi nó là chuyện thường, vì 17 cycle đáng giá bằng một dòng cảnh báo nếu lần sau có ai đọc.

### 18.2 Objective 1 — hai fixture đỏ, và bằng chứng chúng là kiểm thử sống

Baseline chạy thật trước khi sửa: `python du-rework/tools/openapi/validate_openapi.py` → **exit 1**, `paths=42 x-absent=7`, **21 PASS / 2 FAIL**. Hai fail đúng là hai dòng packet nêu:

- `ArtifactFinalizeRequestSchema` thiếu `leaseEpoch` và `taskId`. Nguồn: `runtime.ts:212` là `LeaseBoundRequestSchema.extend({...})`, mà `LeaseBoundRequestSchema` (`runtime.ts:90-92`) định nghĩa **chỉ** `leaseEpoch: z.number().int().min(1)`. `taskId` là `z.string().uuid()` tại `:213`.
- `ClaimTaskRequestSchema` thiếu `businessId`. Nguồn: `runtime.ts:32-37`, `businessId: z.string().min(1)`.

Sau khi sửa: **exit 0**, `OPENAPI-EXAMPLES-VALIDATED`, **23 PASS / 0 FAIL** — đủ 23 case như packet yêu cầu.

**Một giả định của tôi ở đây là sai, và tôi đã kiểm chứng thay vì suy đoán.** Tôi định viết rằng `taskId: '00000000-0000-0000-0000-000000000001'` do packet đưa sẽ **không** qua `z.string().uuid()`, vì nibble version là `0` chứ không phải `1-5`. Tôi chạy thử trước khi ghi: ** nó qua** (zod 3.25.76 tại `packages/contracts/node_modules/zod`, regex uuid mềm hơn tôi nhớ). Nên tôi giữ **đúng giá trị packet chỉ định**. Đáng ghi vì một cycle trước tôi đã từng bịa ra một bẫy tương tự về `state` enum.

**Năm negative control, tất cả đều RED** (chạy trên bản sao scratch, file thật không bị chạm — đã kiểm lại bằng so sánh byte sau khi chạy):

| Kiểm soát | Kết quả | Điều nó chứng minh |
|---|---|---|
| M1 bỏ `businessId` (đảo ngược fix) | exit 1, FAIL `ClaimTaskRequestSchema` | fix là load-bearing, không phải trang trí |
| M2 `taskId: "not-a-uuid"` | exit 1, FAIL `ArtifactFinalizeRequestSchema` | **kiểm tra uuid là thật** — nên giá trị packet đạt là có ý nghĩa, không phải do schema lỏng |
| M3 `leaseEpoch: 0` | exit 1, FAIL | biên `min(1)` của `LeaseBoundRequestSchema` đang có hiệu lực |
| M4 `businessId: ""` | exit 1, FAIL | biên `min(1)` của `runtime.ts:36` đang có hiệu lực |
| M5 `businessId: 7` (số, không phải chuỗi) | exit 1, FAIL | kiểm tra kiểu dữ liệu, không chỉ kiểm tra mặt định |

M2 là cái quan trọng nhất: nó biến "23/23 xanh" từ một con số trần thành **bằng chứng rằng probe đang kiểm tra thật**. Một fixture pass vô nghĩa trông giống hệt một cái được sửa đúng.

### 18.3 Objective 2 — grammar cursor, và một lỗi thứ hai Reviewer không nêu

Finding MEDIUM 3 nói đúng một điều: `gen_openapi.py:120-127` **tự mâu thuẫn**. Câu đầu quảng bá grammar `<ISO>|<uuid>[|p]` — **không còn chỗ** cho định danh sort — rồi câu sau bảo token *có* mang sort identity. Máy đọc được cả hai và không được cái nào.

Grammar đúng, lấy từ **encoder thật** chứ không tôi tự viết: `server.ts:2201` là `` base64url(`${ts}|${id}|${formatOperationsListSort(sort)}${dir}`) ``, và docstring `server.ts:2206` ghi thẳng `<canonical ISO>|<uuid>|<field>:<direction>[|p]`. Decoder `:2230-2265` xác nhận nốt: 2–4 part, không có slot thì đọc là `created_at:desc`, quá một slot thì `null`; và `server.ts:2339-2344` ném 422 khi lệch sort, **trước khi** query. Mô tả mới trong generator viết đúng những điều đó, kèm câu *"omitting `?sort` is not a way around it"* — đúng vì `parseOperationsListSortParam` (`:2364-2369`) resolve `null`/rỗng về default.

**Lỗi thứ hai, tôi tìm ra khi decode chứ không ai nhắc:** ví dụ `nextCursor` trong response **không phải một token hợp lệ**. Nó là `"MjAyNi0wOS0yNlQwMDowMDowLjAwMHw8dXVpZD4"`, 39 ký tự, và decode ra:

```
2026-09-26T00:00:0.000|<uuid>
```

Ba lỗi trong một chuỗi: **bị cắt cụt** (chỉ 39 ký tự, token thật dài 103), `<uuid>` là **chuỗi placeholder chữ nghĩa** chứ không phải uuid, và `00:00:0.000` là **ISO sai** (thiếu một chữ số). Nghĩa là: một lập trình viên đọc spec này, copy ví dụ, gửi đi, và **nhận 422** — từ chính contract do chính file này sinh ra. Đây đúng là lớp lỗi mà A23 sinh ra khi ai đó gõ tay thay vì suy ra.

**Cách sửa: không gõ tay nữa.** Tôi thêm `mint_cursor()` dùng **đúng công thức của route**, và `EXAMPLE_CURSOR` được đúc từ nó, với `SORT_DEFAULT` vẫn đến từ contract. Đây là bài học A23 áp lại: một chuỗi ví dụ gõ tay là nguồn sự thật thứ hai, và nó đã trôi lệch một lần thì sẽ trôi lệch tiếp. Token mới dài **103** ký tự, dưới bound 128, decode ra `2026-09-26T00:00:00.000Z|1f2e3d4c-5b6a-4798-8899-aabbccddeeff|created_at:desc`.

**Một đối chiếu tình cờ đáng giá:** tôi suy ra trường hợp xấu nhất từ công thức encoder là **107** ký tự — khớp đúng con số Mục 15.1 của Qwen-Admin, dù tôi không đọc con số đó khi tính. Hai lane, hai cách, một kết luận.

### 18.4 Hai assert mới, và chứng minh chúng bắn

Tôi thêm hai assert vào generator theo đúng kỷ luật A23 (**một assert chưa từng bắn là lời hứa, không phải bằng chứng**): token ví dụ phải round-trip về đúng payload nó quảng bá, và phải nằm trong bound 128 mà page schema, route và admin shell cùng dùng.

| Đột biến | Kết quả |
|---|---|
| G1 payload khai một sort, đúc token theo sort khác | **exit 1** — `AssertionError: example cursor decodes to '…\|created_at:desc', not the payload it claims` |
| G2 đúc token dài 212 | **exit 1** — `AssertionError: example cursor exceeds the bound the page schema, route and shell share: 212` |

Cả 5 assert của A23 cũng được kiểm lại là còn nguyên (assert 6 tham số query, assert không mất path, và 3 guard sau khi ghi: thứ tự tham số, enum sort, tập mã lỗi, path audit). Không cái nào bị nới trong cycle này.

### 18.5 Tái sinh byte-idempotent — và một lần tôi suýt báo cáo sai

Hai lần chạy `python du-rework/tools/openapi/gen_openapi.py`, **cả hai exit 0**:

```
OPENAPI-JSON path-count=42 operations-params=6 sort-values=6 dropped-paths=0
OPENAPI-JSON path-count=42 operations-params=6 sort-values=6 dropped-paths=0
```

`sha256` của hai lần **bằng nhau** (`19f2cd96…`), nên đây là so sánh byte thật. Artifact: 33.169 → **33.488 byte**, 1.276 dòng (không đổi), `crlf=1275 bareLF=0 CRCRLF=0`, không BOM.

**Suy nghĩ lớn nhất của cycle này là một lần suýt báo cáo sai.** Bản `regen2.py` đầu tiên của tôi chạy hai lần, cả hai **exit 1** vì tôi viết assert nhiều dòng sai thứ tự thụt đầu dòng. Script vẫn in ra `BYTE-IDENTICAL ACROSS RUNS: True` — vì nó so sánh sha của một artifact **không hề được ghi lần nào**. Nếu tôi chỉ nhìn dòng đó, tôi sẽ báo cáo "byte-idempotent" cho một generator chưa bao giờ chạy được. Tôi đã thêm điều kiện `if not (ok0 and ok1): print('IDEMPOTENCY: NOT DEMONSTRATED')`, và nó bắt đúng trường hợp đó ở lần chạy kế. **Một phép so sánh byte chỉ có nghĩa khi cả hai bên đều thực sự được sinh ra.**

**Lỗi thứ hai của tôi:** khi khôi phục artifact sau các mutant, tôi đọc file bằng text mode (`io.open(...).read()`) rồi ghi lại bằng `newline=''`. Universal newlines đã đổi CRLF thành LF, nên artifact bị đổi thành **1275 dòng LF thuần** và sha lệch. Phát hiện ngay vì tôi in sha sau mỗi bước. Sửa bằng cách **tái sinh lại bằng generator thật** — sha về đúng `19f2cd96…`, `crlf=1275 bareLF=0`. Đây là bài học cycle 17 lặp lại đúng một nghĩa: *đọc file nhị phân bằng text mode là tự tạo ra một file khác*.

### 18.6 Diff artifact — đúng hai chuỗi, một path

So với artifact A23 (backup byte-exact, sha `8064d8ee…` xác nhận khớp trước khi tôi bắt đầu): **1.276 → 1.276 dòng**, đúng **2 opcode** khác `equal`:

1. `description` của tham số `cursor` — grammar cũ → grammar mới.
2. `nextCursor` trong ví dụ response — chuỗi placeholder 39 ký tự → token thật 103 ký tự.

Kiểm tra cấu trúc: tập path giống nhau (42), **thứ tự path giống nhau**, tập khóa cấp cao nhất giống nhau, thứ tự 6 tham số operations giống nhau, tập mã lỗi giống nhau, `x-absent` giống nhau (7). **Chỉ `/api/v1/operations` khác nội dung.** Không route nào bị mất, không tham số nào bị rơi.

### 18.7 Link check

**S0** (6 file docs) `FILES=6 TARGETS=834 ANCHORS=519 BROKEN=0` · **S1** (9 file) `TARGETS=843 ANCHORS=528 BROKEN=0` · **S2** (223 file toàn repo) `TARGETS=1551 ANCHORS=641 BROKEN=2` — **đúng hai** link gãy có sẵn của A22/A23/A24, thuộc lane Antigravity. **Không** claim `BROKEN=0` toàn cục. Số liệu S0/S1/S2 **giống hệt** A24, dù artifact JSON đã đổi 2 chuỗi — đúng như mong đợi, vì JSON không chứa markdown link.

### 18.8 Phạm vi Reviewer, và phần T140-D1 còn lại

**Không cái gì ở đây đóng được T140-D1**, và tôi không nâng mức nào. Finding MEDIUM 3 của Turn 160 có **ba** vế; tôi mới làm **một**:

- **Đã làm:** grammar cursor trong generator + artifact, và hai probe.
- **Chưa làm, và tôi không tự ý làm:** `docs/06-public-api.md:80,90-94`, `docs/19:155,411`, `docs/20-openapi-descriptions.md:38,42`, `docs/admin-ops-monitoring-cost.md:21` vẫn nói cursor không mang sort identity, và `tasks/README.md:3` vẫn trỏ Turn 110 làm audit hiện hành. **Lý do không sửa `docs/06`/`docs/20` vẫn y như A23/A24**: Reviewer điều kiện hoá việc sửa câu cursor trên *"T140-A1's final wire policy is verified"*, và T140-A1 theo Turn 160 vẫn là **IMPLEMENTED + offline VERIFIED, awaiting live acceptance** — chưa có Tester live receipt nào chạy token/SQL mới trên cả sáu sort.
- **Lưu ý cho coordinator:** lần này tôi **có** sửa `docs/21-openapi.json` nói về T140-A1 (dòng mở tả kèm trạng thái *"IMPLEMENTED and offline VERIFIED, not live-verified or accepted"*). Đó không mâu thuẫn với việc không sửa `docs/06`: artifact là **output của generator trong phạm vi packet này**, còn `docs/06`/`docs/20` là **văn xuôi được điều kiện**. Nếu coordinator muốn thống nhất hai cách diễn đạt, đó là một quyết định cần nói ra, không phải suy ra.

**T140-A1 vẫn OPEN.** Cái packet này làm cho wire và artifact **nói cùng một điều**, chưa làm cho chúng **được kiểm chứng live**. Cross-sort 422 vẫn mới chỉ có bằng chứng offline trên fake db.

### 18.9 Δ-DEVIATION

- **Δ70 — packet viết `?` không, nhưng tôi sửa **nhiều hơn** một dòng trong generator, có chủ ý.** Packet chỉ yêu cầu sửa description. Tôi sửa thêm `nextCursor` trong ví dụ **vì decode nó ra một payload sai** (mục 18.3). Đây là mở rộng phạm vi, nên tôi ghi ra thay vì làm lặng: nếu coordinator muốn giữ nguyên ví dụ cũ, hãy revert đúng một dòng đó — hai assert mới vẫn xanh vì chúng kiểm token được đúc, không kiểm ví dụ cũ.
- **Δ71 — tôi giữ nguyên giá trị `taskId` của packet, không dùng helper `U(n)` sẵn có trong file.** Packet đưa `'00000000-0000-0000-0000-000000000001'`; tôi đã kiểm chứng nó **hợp lệ** với zod 3.25.76 nên không có lý do kỹ thuật để đổi. Ghi lại vì file giờ có **hai** dạng uuid cho cùng một trường `taskId`: 5 case dùng `U(2)` (dạng RFC-4122 v4), 1 case dùng dạng packet. Cả hai đều hợp lệ và probe không quan tâm, nhưng người bảo trì sau sẽ thấy lệch. Nếu coordinator muốn thống nhất, `U(2)` là lựa chọn đẹp hơn — tôi không tự đổi vì giá trị packet chỉ định là chỉ định.
- **Δ72 — tôi vỡ quy tắc "không sửa test" của lane sau 17 cycle.** Lý do ở mục 18.1, và tôi ghi ra đây để không trở thành tiền lệ im lặng.

### 18.10 Không làm

Không sửa code sản phẩm · không sửa **test suite** (chỉ sửa fixture probe theo packet, mục 18.1) · **không chạy test sản phẩm** (chỉ chạy `validate_openapi.py` và `gen_openapi.py`, cả hai là script tài liệu offline) · không mở DB/Redis/S3/Vault window · không tick task row · không nâng mức acceptance · không tự phán xử T140-A1 · không sửa report lane khác · không sửa `docs/06`/`docs/20`/`docs/admin-ops-monitoring-cost.md`/`tasks/README.md` · không sửa hai link gãy của lane Antigravity · không commit/push (`git log -1` vẫn `7811298`).

**Còn tre, thuộc vai trò khác:** T140-A1 (cần **live keyset** cho token mới trên cả sáu sort + diff ổn định, rồi Reviewer phán quyết) · nửa còn lại của T140-D1 (văn xuôi cursor ở `docs/06`/`docs/19`/`docs/20` + `docs/admin-ops-monitoring-cost.md` + con trỏ `tasks/README.md:3`) · hai probe HIGH/MEDIUM còn lại của Turn 160 (DATA-03 chain, Vault fixture) · `ADM-UX-02` · COST-01→04 · `tester3.md` encoding · 2 link gãy lane Antigravity · **`/compress` của cycle 14 (A21) — lần thứ năm**.

### 18.11 Một lỗi của chính cycle 17, phát hiện khi chèn khối mới

Khi tìm chỗ cắm RESUME POINT cho cycle 18, tôi thấy cấu trúc header của `qwen-docs.md` **đang hỏng từ lần trước**: index 6 và 7 **cùng** là `> [!IMPORTANT]`, còn khối **A23 mất hẳn header của nó** — dòng ngay trên `> **RESUME POINT — 14:18 … (D-EVID-A23)`** là dòng *"15. **Còn tre: …"* của khối A24, không phải một `> [!IMPORTANT]`.

**Nguyên nhân:** ở cycle 17 tôi cắt `lines[:7] + rl + lines[7:…]`, tức phần `[:7]` đã mang sẵn `> [!IMPORTANT]` của khối A23 vào, rồi `rl` lại bắt đầu bằng một `> [!IMPORTANT]` nữa. Hệ quả: khối A24 có **hai** header, và khối A23 **mất** header của mình — về mặt markdown vẫn render được (mọi RESUME POINT đều có một IMPORTANT ngay trên), nên **link check không bắt được** và tôi đã không nhận ra suốt một cycle.

**Đã sửa:** dựng lại vùng header theo đúng thứ tự — `head` (6 dòng) · khối A25 · khối A24 (một header) · `> [!IMPORTANT]` **khôi phục lại cho khối A23** · khối A23 trở đi. Kiểm: `duplicate consecutive IMPORTANT: 0`, 18 CYCLE section, ledger 1–18 đúng thứ tự, `> /compress` duy nhất ở cuối.

**Bài học, và nó không chỉ về markdown:** một kiểm tra hình thức (**link check**) không bắt được một lỗi cấu trúc mà **mắt thường cũng bỏ qua** khi file đã quen thuộc. Loại lỗi "hai header liền nhau" chỉ lộ ra khi tôi **in ra và đọc từng dòng** vùng sắp chèn, thay vì tin rằng chỗ cắm là đúng. Giá của một phép kiểm tra byte là chính xác; giá của một phép kiểm tra hình thức là **bằng 0 với những thứ nó không được thiết kế để nhìn**.


## 19 — CYCLE 19: D-EVID-A26 (con tro audit Turn 110 → Turn 160, va 122 test offline truoc mot lan tat agent)

### 19.1 Pham vi, va hai diem ma packet khong noi

Packet Turn 168 co **5** objective: (1) tro `tasks/README.md:3` sang Turn 160, giu 52; (2) ghi vao `docs/35` + `docs/28` rang COST-01..05 offline 100% xong (122 test) va `qwen_cost` da duoc tat an toan o Turn 167; (3) S0/S1 BROKEN=0; (4) offline, khong commit/push; (5) bien nhan nay.

**Hai diem ma packet khong noi va toi phai tu quyet:**

- **Packet khong noi gi ve Document Version.** Ca hai file docs van la `1.31.0` sau khi no thanh doi **noi dung**. Tinh huong do la mot **tuy bien sai** — thanh doi da xay ma so phien ban khong doi. Toi bump **1.31.0 → 1.32.0** (cung 6 ky tu, swap khong doi do dai) va ghi lai o muc 19.9 de khong thanh tien le im lang. Revert lai dung 2 dong.
- **Packet goi *Turn 167*, va markdown ledger khong co turn do.** Xem muc 19.4 — day la phat hien cua cycle nay, va toi khong sua report lane khac.

### 19.2 Objective 1 — con tro, va 52 duoc dem lai tu source

Dong cu (725 ky tu) troi **Turn 110** vao `review.md#L786`. Dong moi troi **Turn 160** vao `review.md#L888`, giu con so 52, va them phan tach P0–P8 (3 `[~]` + 11 `[ ]` cua 71) vi Turn 160 la nguon cua con so do. **Chi dong 3 doi**: 100 dong con lai byte-identical, 101 CRLF va 0 bare LF truoc va sau, 14.067 → 14.716 byte.

**Toi khong copy con so 52 tu review; toi dem lai ca 5 canh tu file task:**

| Canh | Cach dem | Ket qua |
|---|---|---|
| 14 dong P0–P8 chua accepted | dem **o thu nhat** cua tung dong task trong 9 file P0–P8 | 57 `[x]` / 3 `[~]` / 11 `[ ]` = **71**; **71 ID khac nhau, 0 trung, 0 dong bi bo qua** |
| 16 SEC | dem dong co o `[x]`/`[~]`/`[ ]` trong `SEC-OIDC-VAULT-2026-09-24.md` | 16 dong, **khong dong nao `[x]`** — 1 `[~]` + 15 `[ ]` |
| 8 Admin UX | cung cach, `ADMIN-OPS-UX-2026-09-24.md` | 8 dong, khong dong nao `[x]` (ADM-UX-02 la mot trong tam) |
| 10 DATA/LOG/DEP | dem dong co ID trong `DEPLOY-STORAGE-LOGGING-2026-09-24.md` | `DATA-00..05` + `LOG-01/02` + `DEP-01` + `DATA-INT-01` = **10** |
| 4 COST | dem dong COST trong `docs/admin-ops-monitoring-cost.md` | **4** (`COST-01..04`) |

Tong **52** — dung bang con so `review.md:909` ghi, **khong sua don vi nao**.

**Bay dem so, bay den o lan dau, va no la bay cua rieng cycle nay.** Dong task trong 9 file P0–P8 **khong phai muc list** ma la **o trong bang**: regex cua toi (`^\s*[-*]\s+\[`) tra ve **0** dong o ca 9 file, va neu dem `[x]` o bat ky cho nao trong dong thi **dem thua** — cot ghi chu cua P2-09 chua nguyen cum *fully closed [x]*. Chi **o thu nhat** cua dong moi la mau.

**Con dau Turn 110 bi thay the, dung nhu packet yeu cau.** Audit Turn 110 van con trong corpus: `docs/28` muc 8.19 trich no bang day du **anchor** (`review.md#L786` den `#L807`), nen duong dan dieu tra khong mat. Neu coordinator muon giu nguyen banner cu o lam snapshot lich su, day la mot dong chen.

### 19.3 Objective 2a — 122 la con so tu source, khong phai con so trong roster

Chuoi ly do deactivation ghi *122 tests across contracts and orchestrator*. Toi **khong chep con so do** — toi dem lai:

| Suite | Dong | Khai bao | describe |
|---|---|---|---|
| `usage-metrics.test.ts` (COST-01) | 418 | 23 `it(` | 6 |
| `pricing.test.ts` (COST-02) | 291 | 24 `test(` | 6 |
| `usage-reconciliation.test.ts` (COST-03) | 421 | 26 `test(` | 3 |
| `usage-budget.test.ts` (COST-04) | 462 | 30 `test(` | 2 |
| `usage-contracts-integration-offline.test.ts` (COST-05) | 352 | 19 `test(` | 5 |
| **Tong** | | **122** = 103 + 19 | 22 |

**Khong suite nao dung `it.each`/`test.each`, khong co `skip`/`only`/`todo`** — nen dem tho lit la chinh xac va khong can bung bang nhu o suite sort-binding. Day la **nguoc** voi bay cua cycle 17, noi dem `it(` thieu 33.

**Hai so cheo, tinh ma khong doc receipt:** **17** file test trong `packages/contracts/tests/` (dung bang 17 suite lane bao) va `usage.ts` **460** dong / **20.960** byte (dung bang phép do 191→460 / 20.960 B cua lane). Hai dap ung khop **tuong doi doc lap**.

**BAY DEM SO 2: glob `*usage*` ra 131, khong phai 122.** No quet them `usage-summary.test.ts` — **9** test thuoc W39-C, khong phai suite COST, va 9 test do **tu skip** offline sau co `DU_LIVE_INFRA` (chinh lane ghi la Δ-D30: *skip khong phai pass*). Ai cong mot glob se bao 131 va sai dung bang kich thuoc cua mot suite lane khac.

**BAY DEM SO 3: 85 vs 86 la hai trang thai cay, khong phai mau thuan.** Lane bao **85** suite orchestrator (68 pass / 17 skip) tren chinh run cua lane; cay co **86** file test hom nay, vi `operations-list-cursor-sort-binding.test.ts` (54 test) cua cycle 17 den **sau**. Hai so nay la cung mot package o hai moc thoi gian — **khong bao gio cong**, va toi ghi ro dieu do thay vi lam nho mot trong hai so la sai.

**Ranh gioi:** tat ca la **offline**. Lane ghi Δ-D1..Δ-D30 **con mo**, va Δ-D26 la ranh gioi chuc nang chu khong phai thu tuc: hom nay **khong co producer nao ghi dong `UsageLedgerEvent`**, nen `reconcileUsageRows` tra tong bang **khong** va danh sach dong bi tu choi — dung thay vi bia ra gia tri mac dinh. Khong co Reviewer turn nao phan xu COST-01..04.

### 19.4 Objective 2b — viec tat, va muc Turn 167 khong ton tai

Viec tat duoc ghi trong **`coordination/coordinator-state.json`**, khoa `deactivated_roster.qwen_cost`: `deactivated_at` **2026-09-26T15:06:23+07:00**, handle `term_4ed1695f-9152-40af-b6f2-2c3d984f0e43`, ly do ghi nguyen *Completed 100% of COST-01..05 offline backlog (122 tests across contracts and orchestrator pass). Live verification handled by Tester.* Bon agent truoc do cung bi tat luc **`14:29:46+07:00`**.

**Phat hien cua cycle nay: chu *Turn 167* trong packet khong co muc markdown nao.** `coordinator-antigravity.md` ket thuc o muc **Turn 166** (dong 2264), trong khi chinh `coordinator-state.json` do da la `turn` **168** voi `last_tick` **15:10:07**. Toi tuc la: thoi diem 15:06:23 nam giua Turn 166 (15:00:00) va lan tick hien tai, nen *co the* la Turn 167 **da xay** nhung **chua duoc ghi** trong ledger nguoi doc.

Toi **khong sua** `coordinator-antigravity.md` — do la report lane khac, va day la muc ledger cua coordinator. Nhung toi cung **khong ghi nhu su co Turn 167**: hai file docs ghi *con so that trong state file*, va ghi them rang ledger chua co muc do. Neu coordinator muon bo sung, mot muc Turn 167 la het.

**Viec tat co *an toan* gi?** Ba thu: (1) ca 5 packet deu co receipt exit 0 do lane ghi; (2) footprint cua lane la `usage.ts` + **mot** file test moi, khong dong vao `packages/contracts` trong cycle 5 va khong dong `server.ts`; (3) khong co viech dang gi. Nhung **khong co gi independent nao xac nhan viec tat** ngoai state file — va ton tai la mot su that, khong phai bang chung sai, nhung cung khong phai bang chung them.

### 19.5 COST-05 khong phai dong release thu 5

Bang spec trong `docs/admin-ops-monitoring-cost.md` co **dung 4** dong: `COST-01` (dong 44) den `COST-04` (dong 47). `COST-05` la **dinh danh packet cua lane** (`W-COST05-SERVICE-RECON-1`), khong phai dong task.

**Neu dem 5, mau so se la 53 va mot dong release do ra** ma khong file task nao chua. Nen chuoi ly do `COST-01..05` **khong rut duoc** 52 xuong — va `docs/28` / `docs/35` deu ghi ro dieu nay thay vi im lang bo qua, vi day la cho de nguoi doc tiep neu gap vao *COST-01..05* o mot report khac.

### 19.6 Cau COST cua Turn 160: mot phan da cu, bon phan van dung

`review.md:905` (viet **truoc** packet 5) noi COST-01→04 *co strict contract/math/aggregation tests **nhung khong co** Orchestrator persistence, versioned price publish/CAS, reservation ledger/alerts hay Usage & Cost operator UI*.

Packet 5 den sau do, nen hom nay: **phan da cu** — tang tong hop/chieu o Orchestrator **da co** (`usage.ts` 191→460 dong, 19 test offline tren fake db, BigInt money-law, projector *never-fabricate*, budget option). **Bon phan van dung:** publish/CAS chua co, reservation ledger chua persist, alert dispatch chua co, operator UI chua co, va producer wiring cua COST-01 van mo (Δ-D26).

**Toi khong sua cau do.** Sua mot cau stale **la adjudication** — Reviewer la nguoi phan xu, va cau cua Reviewer dang dung pham vi cua Reviewer. Toi chi ghi *phan nao da chay*, de lan sau khong ai doc nham la hien trang.

**Va cot mot cau trong cung file do, lan nay toi trich dan thay vi paraphrase:** claim *100% offline backlog* cua mot owner da tat la *packet-capacity statement, **not** acceptance of their plan rows*. Do la co so de ghi mot lan tat agent ma khong gate nao nhung — va no cung la ly do **122 offline test khong dua 4 dong COST ra khoi gate**.

### 19.7 Hai file docs: so dong, byte, va bang chung bao toan

| File | Dong | Byte | Version | Bang chung |
|---|---|---|---|---|
| `docs/28-test-inventory.md` | 684 → **699** | 223.853 → **232.991** | 1.31.0 → 1.32.0 | chi L3 doi trong vung cu; vung append bang bang fragment; CRLF 698, bareLF 0, CRCRLF 0, endsLF=False, BOM=False |
| `docs/35-acceptance-baseline.md` | 844 → **860** | 226.641 → **234.413** | 1.31.0 → 1.32.0 | cung tren; CRLF 859, bareLF 0, CRCRLF 0, endsLF=False, BOM=False |
| `tasks/README.md` | 101 (khong doi) | 14.067 → **14.716** | — | chi L3 doi; 101 CRLF, 0 bare LF truoc va sau |

**Cach chung minh vung cu khong doi.** Voi `docs/28`, verifier dau tien cua toi sai, va toi *dung lai ban goc tu chinh file hien tai* (lay 684 dong dau, doi `1.32.0` ve `1.31.0`) roi doi chieu voi **so da da ghi truoc khi sua**: **223.853 byte / 683 CRLF** — trung het. Tiec trong do la bang chung **khong dua vao** thu gia dinh, ma do bang nhom ma chi co mot cach dung de co, va no **loi ngay** neu co dong nao ngoai L3 bi dong vao.

### 19.8 Link check — va mot pham vi bi bo sot

| Pham vi | Files | Targets | Anchors | Broken |
|---|---|---|---|---|
| S0 | 6 | 859 | 542 | **0** |
| S1 | 9 | 868 | 551 | **0** |
| **A26 (moi)** | 4 | 850 | 500 | **0** |
| S2 toan cay | 223 | 1.577 | 665 | **2** |

**S0 va S1 khong chua `tasks/README.md`** — file ma cycle nay sua **manh nhat** lai nam ngoai ca hai pham vi. S0/S1 dat tu cycle 16, khi file do chua bao gio nam trong pham vi. Toi them **A26** gom `tasks/README.md` + `docs/28` + `docs/35` + `qwen-docs.md`; no bao phu ca 4 file da dong vao cycle nay. Neu co ai sua `tasks/README.md` o cycle sau ma chi chay S0/S1, ho se khong bao gio kiem file do.

So target tang so voi A25 (S0 834 → 859, S1 843 → 868) la **25 link moi** cua chinh cycle nay, khong phai link hong — can gap them mot bang o chay lai.

**S2 van dung 2** — hai link gang co san cua lane Antigravity (`antigravity-6.md:8952` va `requests/antigravity.md:10`), va `tester3.md` van khong phai UTF-8. Khong phai cua cycle nay, va khong sua.

### 19.9 Δ-DEVIATION

- **Δ73 — toi bump Document Version ma packet khong noi.** Ly do o muc 19.1. Revert = doi lai 2 dong. Ghi ra de khong thanh tien le ngam.
- **Δ74 — toi *thay the* banner Turn 110, khong giu lai lam snapshot lich su.** Packet dung tu *update*, va chu convention cua file la *retain blockquote khac* — banner Turn 110 khong phai blockquote khac ma la dong **dau tien**, thuoc ve chinh muc *current*. Audit Turn 110 van duoc trich day du anchor o `docs/28` muc 8.19, nen khong mat duong dan dieu tra. Neu coordinator muon giu nguyen, mot dong chen la duoc.

### 19.10 Khong lam

Khong sua code san pham ƃ khong sua test suite ƃ khong chay test san pham (chi dem file va chay checker link) ƃ khong DB/Redis/S3/Vault window ƃ khong tick task row ƃ khong nang muc acceptance ƃ khong tu phan xu T140-A1 hay COST-01..04 ƃ khong sua cau stale cua Reviewer ƃ khong sua report lane khac (ke ca muc Turn 167 thieu) ƃ khong sua 2 link gang cua lane Antigravity ƃ khong commit/push (`git log -1` van `7811298`).

**Con tre, thuoc vai tro khac:** T140-A1 (can **live keyset** cho token moi tren ca sau sort + diff on dinh, roi Reviewer phan xu) ƃ van xuoi cau cursor o `docs/06:80,90-94` / `docs/19:155,411` / `docs/20:38,42` va `admin-ops-monitoring-cost.md:21` (dieu kien cua Reviewer: *once T140-A1 verified*) ƃ **COST-01..04 chua ACCEPTED + 4 tang van thieu** ƃ **muc Turn 167 thieu trong ledger coordinator** ƃ DATA-03 chain ƃ Vault fixture ƃ ADM-UX-02 ƃ `tester3.md` encoding ƃ cot lech co san o `docs/35` ƃ **`/compress` cua cycle 14 (A21) — lan thu sau**.

### 19.11 Tom tat kiem chung

Moi cong viec doc deu **dem lai tu source**, khong chep tu receipt hay tu chuoi ly do trong roster: **122** (5 suite), **17** (file test contracts), **460 / 20.960** (`usage.ts`), **52** (5 canh), **71 / 3 / 11 / 0 / 0** (P0–P8). Kiem encoding cho ca 3 file: **bareLF 0, CRCRLF 0, BOM False**; `docs/28` + `docs/35` giu **endsLF=False**, `tasks/README.md` giu **endsLF=True**. Link check S0/S1/A26 **BROKEN=0**. Khong commit, khong push.

### 19.12 Hai loi nua — chung **sau khi file da duoc ghi**

Muc 19.1 —19.3 ke ba loi cua toi, va ca ba deu **bat truoc** khi toi dung artifact. Hai loi duoi day **xuat hien sau khi file da ghi**, va chi duoc bat boi mot vong kiem tra cau truc doc lap chay lai sau do.

- **LOI 4 — muc ledger 19 **chen truoc** muc 18.** Khi cat, toi dung `lines[i0:l18] + ledger + lines[l18:c19]` — doan `lines[l18:...]` **da chua** muc 18, nen muc 19 land **dung truoc** muc 18. File van render, van doc duoc, va **khong co phep kiem tra nao bat** — ke ca link check. Chi mot vong kiem tra cau truc doc lap (dem muc ledger 1..N theo thu tu) moi bat. Da sua bang cach roi muc 19 ra va chen lai ngay sau muc 18; hieu luc la **19 muc ledger 1..19 dung thu tu**.
- **LOI 5 — token bien backtick **an mat dau token** trong `[~]`.** Toi viet `[~]` de chi o checkbox *partial*, roi thay token do thanh `BT = chr(96)` → nen no ra thanh **`[~]`** — vua sai chu, vua lam **mat backtick** (5 cho). Con mot backtick mo chay trong mot cum italic. Hai file docs va `tasks/README.md` **khong he danh** vi chung dung BT noi truc tiep; chi **report nay** dung token. Da sua 6 cho; kiem lai: **0 dong backtick le trong toan bo vung moi**.

**Bai hoc, va no ve ty le hon la thu toi bi kiem tra:**

1. **Mot phep kiem tra byte khong lo cau truc thu tu.** Ca phep them mot dong va mot phep tach deu giu nguyen byte hoan hao. Bai hoc A23 (generator tai sinh byte-idempotent) cung dung vay, va no **khong** phu thu bat ky loi sap xep nao.
2. **Token thay the la mot bien tai suyet bien.** Ky tu chuyen doi **co ve trong chu** (trong chinh checkbox `[~]`), va `BT = chr(96)` la cach an toan cho *text* nhung **khong an toan** cho *noi dung mang y nghia*. Bai hoc A25 da day placeholder, lan nay cho thay phai chon token **khong bao gio xuat hien trong prose**.
3. **Ba loi bat truoc, hai loi bat sau — va ty le 3/2 do la thu toi co thang ke.** Hai loi sau **khong** do bang phan tich hay bang phep kiem tra byte; chung do bang mot vong doc lai doc lap sau khi ghi xong. Voi file **sinh ra bang ghep**, cai do giong het thao tac **doc va in ra vung vua sua** ma cycle 18 da hoan tat — va la thu duy nhat bat duoc lo *hai header lien nhau*.

**Trang thai cuoi file report sau khi sua ca hai:** **2.079** dong / **321.581** byte, thuan LF, khong BOM, endsLF, **18** RESUME POINT (muc moi nhat la A26 voi **18** muc so; 17 khoi con lai la history va cung so tuong doi), **19** muc CYCLE, ledger **1..19** dung thu tu, mot marker /compress duy nhat o cuoi, va **0** duplicate IMPORTANT lien nhau. Ba dong backtick le con lai trong khoi 1–18 (L765, L1158, L1599) la **co san tu truoc** va khong nam trong vung cycle nay.

## 20 — CYCLE 20: D-EVID-A27 (con tro audit Turn 180 + dong bo 3 vi tri cursor/sort prose)

- **Packet**: `D-EVID-A27` — cap nhat `tasks/README.md:3` troi Reviewer Audit Turn 180 (`review.md:948+`) va sua van xuoi cursor/sort stale o 3 vi tri Reviewer chi dinh; link check scoped; ghi receipt. **Khong sua code san pham, khong commit/push.**
- **7 file**: `tasks/README.md`, `docs/06-public-api.md`, `docs/20-openapi-descriptions.md`, `docs/admin-ops-monitoring-cost.md`, `docs/28` §8.22, `docs/35` §12.25, va report nay.
- **Che do**: OFFLINE. Khong DB/Redis/S3/Vault window, khong chay test suite san pham, khong tick dong task, khong adjudicate Δ, khong sua report lane khac.

### 20.1 Hop dong wire, doc thang tu source — 4 su that, khong chep tu packet

Tui doc `services/orchestrator/src/server.ts` va `packages/contracts/src/public-api.ts` truoc khi viet mot chu cai nao. Day la mau thuc: packet mo ta contract ma khong dua symbol, va chinh Reviewer Turn 180 noi phai lam sau *"the verified wire policy"*.

1. **Cursor toi da 4 slot**: `base64url(<ISO>\|<uuid>\|<field>:<direction>[\|p])`, ghep boi `encodeOperationsListCursor` tu `ts|\|id|\|formatOperationsListSort(sort)` cong them `|p` khi di nguoc.
2. **`decodeOperationsListCursor`** tach payload theo `\|`, **pop `p` rieng** (no khong phai `field:direction` hop le nen hai hinh dang khong lan duoc vao nhau), phan con lai di qua `parseOperationsListSort`; chi nhan **2..4** part.
3. **`parseOperationsListQuery` nem 422** khi `decoded.sort.field !== sort.field || decoded.sort.direction !== sort.direction`, va nem mot 422 nua khi token hong; `parseOperationsListSortParam` nem 422 cho sort ngoai allow-list.
4. **Dung 6 gia tri sort**: `OPERATIONS_LIST_SORT_FIELDS` (`created_at`, `updated_at`, `deadline_at`) x `OPERATIONS_LIST_SORT_DIRECTIONS` (`asc`, `desc`); `LIST_CURSOR_MAX_LEN` = 128.

**Token 2 slot cu van decode** (`<ISO>\|<uuid>`, `<ISO>\|<uuid>\|p`) va doc thanh `created_at:desc` — thu tu duy nhat chung co the tung mang. Do do moi deep link cu phan trang y het. Day cung la ly do A22 va A25 deu mo ta ho la hanh vi cu: sua mot byte token de dong mot finding thi khong dang.

**`bindOperationsCursor` khong doi.** No van so `(sortKeySql, id)` voi `($n::timestamptz, $n::uuid)`. Cai doi la route **chan cursor lech thu tu truoc khi bind**. Ghi ro vi day la noi de nguoi ta tu gan predicate row-value la thu sua.

### 20.2 3 vi tri prose: sua dong nao, va gi

Moi vi tri deu mang mot **cau o hien tai** ve policy cu. Hieu sua la sua phan hien tai va giu phan lich su, dung dinh huong Reviewer dua ra: *"Preserve historical A15/Δ23 statements as exact-scope history; do not rewrite them as acceptance for newer behavior."*

- **`docs/06-public-api.md`** — L80 doi `base64url(<ISO>\|<uuid>)` thanh 4 slot va giai thich slot thu ba; them 1 bullet moi L87 ve 422 khi lech thu tu; L90–94 doi khoi *"MISMATCH T140-A1 — chưa chốt"* sang *"đã chốt trong source, live acceptance còn mở"*, giu lai trang thai truoc packet va ghi ro muc bang chung. **165 → 168 dong.**
- **`docs/20-openapi-descriptions.md`** — L38 doi payload thanh 4 slot va them phan legacy token; L42 doi *"MISMATCH T140-A1 — OPEN"* thanh RESOLVED-IN-SOURCE, kem mot L43 moi giu lai **doc cua doan OPEN** la lich su va noi ro **190/190 la so cua Reviewer, khong phai do luong cua tui**. **128 → 129 dong.**
- **`docs/admin-ops-monitoring-cost.md`** — L21 doi *"không có cursor/filter/sort server-side"* bang mo ta route hien tai, va them *"chưa phải nghiệm thu"* trong cung cau do. **81 dong, chi 1 dong doi.**

**Khong con cau hien tai nao trong 3 file mang policy cu.** Toi kiem bang cach assert **6 chuoi cu phai bi xoa het** (bao gom *"MISMATCH T140-A1 — OPEN"*, *"does not carry the sort identity"*, *"chỉ lấy tối đa 100 dòng mới nhất"*), va ca 6 deu trave **absent = True**.

### 20.3 BAY DEM SO: pipe chua escape lam VO BANG markdown — day la loi noi dung that duy nhat

Vi tri thu 3 la mot **o trong bang**. Payload notation dung 3 ky tu `\|`, va dieu kien JS `a !== b || c !== d` chua them **2** `\|` nua. Ghi chung mot hang ma khong escape se tach mot dong thanh **7 o** (va trong bang §8.22 cua docs/28, mot dong thanh **10 o**) — ma **khong bao loi nao**: markdown van render, chi la sai bang.

Toi khong sua tay. `row()` bay gio **tu escape** bang regex phan biet pipe co backtick o truoc, roi assert khong con pipe nao chua escape. Quy uoc escape lay tu chinh file: `docs/06-public-api.md` da dung no o dong `state` va `ORDER BY`. Parser phan biet pipe escaped xac nhan hang sau khi sua van la **2 o**, dung bang cac hang 17–22.

### 20.4 Con tro `tasks/README.md:3` → Turn 180, va 52 duoc dem lai

Banner chuyen **Turn 160** (`#L888`) sang **Turn 180** (`#L948`), 1372 → **1820** ky tu. Noi Turn 180 phu de Turn 170, giu **52 dong chua accepted** va noi ro day la so dong task chu khong phai phan tram sang, ghi T140-A1 la IMPLEMENTED + offline VERIFIED / **live acceptance OPEN**, va liet ke 4 finding moi. **Chi L3 doi; 100 dong con lai byte-identical, CRLF giu nguyen 101 CRLF / 0 bare LF, khong BOM.**

52 duoc dem lai ca 5 canh tu task file, khong lay tu Reviewer: **14** P0–P8 + **16** SEC + **8** Admin UX + **10** DATA/LOG/DEP + **4** COST = **52**, khong sua don vi nao. Co **mot** khac biet dem moi lan nay:

- **Canh 10 (DATA/LOG/DEP) dem khac 4 canh kia.** Bang do **khong co cot trang thai nao ca** — `DATA-00..05`, `LOG-01/02`, `DEP-01`, `DATA-INT-01` — nen regex tick cua toi tra **0**. 10 dong do unaccepted theo chinh dong mo ta cua plan (*Trạng thái: plan, chưa triển khai*). Regex tick se **thieu 10** ma khong bao loi.

### 20.5 BAY DEM SO: 55 la so KHAI BAO, 190 la so CHAY, va tui khong danh cai nao la cua tui

| Suite | Dong | Khai bao | `.each` |
|---|---|---|---|
| `operations-list-cursor-sort-binding.test.ts` | 488 | 16 `it(` + 4 `test(` = **20** | **5** |
| `admin-operations-sort-wiring.test.ts` | 515 | 27 `it(` = **27** | **3** |
| `admin-keyset-explain.test.ts` | 359 | 6 `it(` + 2 `test(` = **8** | 0 |
| **Tong** | | **55** | **8** |

Reviewer Turn 180 ghi **190/190** cho T-32 tren 3 suite offline sort. Day la **so chay**. Tui khong tai lap duoc 190, nen toi **khong phat lai no nhu do luong cua tui** — chi 55 la tai lap duoc tu cay, va mot tai lieu quote 190 nhu the tui da tu dem la dang no dieu sai chinh minh.

Day la **cung mot bay dem so, nhung nguoc chieu** voi con 122 cua A26: o do khong co `.each` nen dem literal chinh xac; o day co 8 khai bao nam trong bang nen so chay cao hon. Bai phan biet luon la **ten suite truoc, dem khai bao sau**. `admin-keyset-explain` tu skip offline bang co (`const liveDescribe = LIVE ? describe : describe.skip`) — la **gate, khong phai loi**, va 8 khai bao do **khong phai** xanh offline.

### 20.6 4 finding moi cua Turn 180: ghi, KHONG adjudicate

- **HIGH T180-D1** — ingestion consumer **khong co post-lease ownership fence**: `COMPLETE_SQL` va `RETRY_SQL` update theo outbox `id` don le, nen runner song qua cua claim co the complete hoac re-arm claim moi.
- **MEDIUM T180-D2** — materialized artifact consistency khong kiem tra khi replay hay khi insert conflict.
- **MEDIUM T180-A1** — route order `deadline_at` qua `COALESCE(deadline_at, $N::timestamptz)` trong khi migration 0018 index **cot tran**, nen planner co the van Sort.
- **MEDIUM T180-D3** — source URL co the bi bo loi khi backend la PostgreSQL, vi consumer chi duoc tao cho S3 trong khi dispatcher luon loai `gate=ingestion`.

Khong cai gi, khong sua source. T180-A1 la cai duy nhat co be mat tai lieu, va Reviewer da gan no cho Admin/Tester bang live EXPLAIN, voi chi danh ro **quyet dinh migration follow-on thay vi sua 0018 da apply**. Reviewer cung ghi DATA-03 **da co production caller trong source, owner-offline verified, acceptance van open** — cycle nay khong doi dieu do.

### 20.7 Link check — va mot loi hien trang ve scope

**S0 881 target / 564 anchor / BROKEN 0** ℹ **S1 890 / 573 / BROKEN 0** ℹ **A27 (moi) 872 / 521 / BROKEN 0** (7 file: 4 file sua + docs/28 + docs/35 + report nay). Ca cay van ra dung **2** break ton tai cua lane khac (`antigravity-6.md:8952`, `requests/antigravity.md:10`) va 1 file non-UTF-8 (`tester3.md`).

**Loi hien trang: `docs/admin-ops-monitoring-cost.md` khong nam trong S0, S1, hay A26.** A19 gap chinh la `tasks/README.md`; A26 them no vao scope moi, va bay file nay lai rơi ra. **Scope theo cycle la phu, khong phai bao phu** — nen mo rong S0/S1 thay vi them tung scope moi cho tung file.

### 20.8 Dong bo `docs/28` §8.22 va `docs/35` §12.25, bump 1.32.0 → 1.33.0

`docs/28` **699 → 711 dong** va `docs/35` **860 → 872 dong**, ca hai thuoc Docs nay deu CRLF va **khong** co dong cuoi, giu nguyen. §8.22 co bang 4 cot; §12.25 co bang 3 cot. Hai muc deu ghi ro **khong gate nao doi, khong dong nao duoc tick, khong muc do nao duoc nang len**.

### 20.9 LOI CUA TOI: 13 loi, phan loai theo luc bat

**A. 8 assert fail TRUOC khi ghi file (file con nguyen):** (1) assert dung `prevCursor` thay vi backtick that; (2) **off-by-one** — dong N la index N@1, toi kiem `lines[91] == ">"` cho dong 91 khi dong do la `>>`; (3) **CRLF** — tach theo `\n` de moi phan tu con `\r`, nen moi assert so sanh noi dung bo; (4) `### Tenant fence` la **3** dau `#`, toi viet 2; (5) `mk()` assert `%%` phai co trong chuoi, fail tren mot dong chi co **bold**; (6) dong 21 cua `admin-ops` la hang **Spec**, khong phai dong trong; (7) toi dem **4** ky tu `\|` trong payload, thuc te la **3**; (8) assert vo nghiac ve so pipe cua mot bullet.

**B. 2 script CHET LUC PARSE (khong co file nao duoc tao):** (9) "`" trong JS template **collapse thanh "`"**, lam Python doc `*"..."*` la ket thuc chuoi; (10) toi de Python `+ EM +` va `].map(mk)` vao mot JS array literal, nen JS tu parse sai.

**C. 2 LOI NOI DUNG THAT, bat boi chinh guard cua toi truoc khi ghi:** (11) `cả` bi goi nham thanh `c` + them mot backtick trong docs/06, **chet 1 backtick** vao L80 — bat boi can bang backtick; (12) pipe va `||` chua escape trong o bang, se tach hang thanh **7 o** (va **10 o** trong docs/28) — bat boi `row()`. **Day la hai loi duy nhat ma tieu tai lieu khac se doc thay.**

**D. 1 verifier bug SAU khi ghi, va file thi DUNG:** toi kiem `### Keyset cursor` o L79 trong khi no o L78. File dung; phep kiem dung. Day la loai loi cycle 19 da gap nhieu lan va **khong** bao gio lam hong tai lieu.

### 20.10 Ty le va bai hoc

**8 + 2 + 2 loi bat truoc, 1 loi bat sau — va cai sau cung la verifier.** Tui ghi lai ty le nay vi no **khong** phai pho hieu nghien: 13 loi, **12 bat truoc khi tai lieu ton tai**, va loi duy nhat bat sau la phep kiem sai chu khong phai tai lieu sai. Cycle 19 ty le la 3/2, va ca hai cycle deu dung mot nguyen tac: **guard phai chay tren fragment, truoc khi fragment cham vao file**.

1. **Assertion cua toi sai nhieu hon noi dung cua toi sai.** 8 trong 13 loi la phep kiem co ve khong dung, va khong cai nao lam hong file. Nhieu hon mot nua la cung mot loai: **toi doan so dong bang so voi thu tu gan nhat, roi goi doan do la bang chung**.
2. **Escape trong o bang phai do may quyet dinh, khong do tay.** `row()` gio tu escape. Hai lan trong cycle nay mot lan o `admin-ops` va mot lan o `docs/28`, ca hai deu la **cung mot loai loi** va ca hai deu nen bat bang may.
3. **Moi vi tri co quy uoc rieng ve EOL va no KHONG doan duoc.** `docs/06` va `docs/20` la CRLF, `docs/admin-ops-monitoring-cost.md` la **thuan LF**, `docs/28`/`docs/35` CRLF khong dong cuoi, `qwen-docs.md` thuan LF. Lan nay `admin-ops` la file LF duy nhat trong 3 file prose — neu tinh theo mac dinh CRLF se lam hong ca file.

### 20.11 Trang thai cuoi 7 file

| File | Dong | Byte | EOL |
|---|---|---|---|
| `tasks/README.md` | 101 | 15.167 | CRLF, endsLF |
| `docs/06-public-api.md` | 168 | 19.507 | CRLF, endsLF |
| `docs/20-openapi-descriptions.md` | 129 | 20.685 | CRLF, endsLF |
| `docs/admin-ops-monitoring-cost.md` | 81 | 14.401 | **thuan LF**, endsLF |
| `docs/28-test-inventory.md` | 711 | 242.611 | CRLF, **khong** endsLF |
| `docs/35-acceptance-baseline.md` | 872 | 241.022 | CRLF, **khong** endsLF |
| `coordination/reports/qwen-docs.md` | 2223 | 341985 | thuan LF, endsLF |

Khong file nao co BOM. `docs/06` va `docs/20` giu CRLF 168 / 129, `admin-ops` giu thuan LF 81, `docs/28` va `docs/35` giu CRLF khong dong cuoi, va report nay giu thuan LF. **Khong co quy uoc EOL nao duoc doi hay ep buoc** — ca buoc ghi deu doc EOL tu file roi ghi lai dung convention cua no.

### 20.12 Con tre va vai tro khac

Khong gi trong cycle nay la cua lane nay de lam tiep. Con lai, theo thu tu Reviewer Turn 180 sap:

1. **T140-A1** — can mot run live multi-tenant keyset tren 6 sort + cross-sort + legacy token + mot diff cuoi on dinh, **roi Reviewer quyet**. Chi Reviewer duoc dong.
2. **T180-A1** — EXPLAIN live cho tenant/cross-tenant `updated_at` va `deadline_at` hai chieu, voi nhieu hon 1.000 dong va deadline NULL, va **quyet migration follow-on** chu khong sua 0018 da apply.
3. **T180-D1 / D2 / D3** — owner DATA: fencing bang attempt/owner token, kiem tra metadata sau conflict, va chon giua tu choi URL mode luc submit / adapter PostgreSQL / escalation theo tuoi.
4. **COST-01..04** van la 4 dong unaccepted va van giu `G-ADMIN-OPS`; versioned price publish/CAS, reservation ledger, alert dispatch va operator UI van thieu.
5. **ADM-UX-02 `[~]`, ADM-UX-03 `[ ]`** va ma trinh duyet C1–C5 co seed chua chay.
6. **Khong sua** 2 link break ton tai cua lane khac, `tester3.md` non-UTF-8, va column mismatch co san trong docs/35.

**Gate: `G-ADMIN-OPS` NO-GO, `G-SEC` NO-GO, `G-DATA` NO-GO, `G6` NO-GO** — y nguyen Turn 180. Khong tick dong task nao, khong adjudicate Δ nao, khong commit, khong push.

**`/compress` lai duoc nhac lan thu bay.** No duoc nhac tu cycle 14 (A21) va chua chay bao gio khu cycle nay.
## 21 — CYCLE 21: D-EVID-A28 (sua hai finding T190-E1 / T190-E2, con tro Turn 190, mo rong S0/S1)

- **Packet**: `D-EVID-A28` — sua hai finding LOW cua Reviewer Turn 190, dong bo con tro audit, mo rong standing scope S0/S1, chay link check. **Khong sua product source, khong chay test suite san pham, khong mo DB window, khong commit/push.**
- **Reviewer**: [Turn 190 independent audit](review.md#L977); `T190-E1` at [line 993](review.md#L993), `T190-E2` at [line 994](review.md#L994).

### 21.1 PACKET SAI MOT CHI TIET, TOI LAM THEO REVIEWER VA GHI LAI

Packet yeu cau doi dang `$$n` thanh dang `\::timestamptz`. **Do do khong phai mot dang PostgreSQL hop le** — mot dau `::` sau dau backslash khong mang nghia gi. Toi **khong** lam theo chi dan do.

Reviewer dinh nghia dung thu lau trong chinh finding cua minh: route emit `$N::timestamptz, $M::uuid` (`server.ts:2593`). Toi doc lai source de kiem chung:

- `server.ts:2593` — `` return `(${sortKeySql}, id) ${op} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; ``
- `server.ts:2547` — `` return `COALESCE(${column}, $${params.length}::timestamptz)`; ``

`$$` trong JS template literal escape ra mot dau `$`. Hai vi tri la **hai tham so KHAC NHAU** (`params.length - 1` va `params.length`), nen dang dung phai la `$N` roi `$M` — **khong phai `$n` hai lan**, va dang `$$n` sai hoan toan. Toi sua theo dang Reviewer viet: `($N::timestamptz, $M::uuid)` va `COALESCE(deadline_at, $N::timestamptz)`. Day la lan thu ba lane phai **bac bo mot chi dan cua packet** vi mau thuc (cum A22, cum A26).

### 21.2 T190-E1: dang sai xuat hien o 4 cho, va tai sao no song sot toi deliverable

Reviewer noi ro dac biet: loi nay **khong** duoc thua ke — `git show HEAD:du-rework/docs/06-public-api.md` co **0** lan xuat hien. Toi dem lai toan cay: **11** lan `$$n` trong 4 file, trong do **4** lan nam trong `review.md` la chinh Reviewer **trich dan** loi cua toi, nen khong phai cua minh de sua.

| Cho | Dong | Truoc | Sau |
|---|---|---|---|
| `docs/06-public-api.md` | 95 | `($$n::timestamptz, $$n::uuid)` | `($N::timestamptz, $M::uuid)` |
| `docs/20-openapi-descriptions.md` | 42 | `($$n::timestamptz, $$n::uuid)` | `($N::timestamptz, $M::uuid)` |
| `qwen-docs.md` | 16 | `($$n::timestamptz, $$n::uuid)` | `($N::timestamptz, $M::uuid)` |
| `qwen-docs.md` | 2163 | `COALESCE(deadline_at, $$n::timestamptz)` | `COALESCE(deadline_at, $N::timestamptz)` |
Bang tren ghi dong tai luc **sua**; sau khi chen ledger entry 21 o L382, dong do lech +1. Cac dong 16 (qwen-docs) va 95/42 (docs) nam **truoc** 382 nen khong doi.


Reviewer con chi them `qwen-docs.md:2162` **mis-quote them COALESCE bound** — mot cho danh sach ma packet khong nhac toi. Toi sua ca **4** cho: Reviewer la nguon su that, packet chi liet ke 2.

**Tai sao no song sot toi deliverable.** Cycle 20 toi da ghi trong bao cao rang pipeline JS-template sang Python that trong 4 cach, va `"` la loi thu tu. Dang nay la **loi thu nam**: `$` khong bi JS template lam gi, nen `$$n` duoc ghi nguyen vao file **va khong bao loi nao**. No khac `"` o chu no **khong hinh dung gi** — ghi sai ma khong loi, con day la **ghi sai ma cung khong loi**. Bai hoc bo sung: *escape sai trong JS template khong chi la ghi sai, con la ghi sai doc lap khoi co che bao loi cua chinh no.*

**Link check khong bao gi.** Reviewer viet ro: link hop le (file ton tai, dong trong khoang) nen chi **kiem tra noi dung** moi bat duoc. Toi dua pham vi kiem tra noi dung vao checklist vi day la lan thu hai trong mot cycle ma noi dung mau cua toi sai, lan truoc la bac bo chi dan packet.

### 21.3 T190-E2: marker con lai trong hai tieu de, va tinh hinh no lam

Hai tieu de toi them cycle 20 deu **chua qua `mk()`**:

- dong tieu de duoc `new.append(...)` truc tiep, khong di qua `mk()`;
- moi dong hang, moi doan va moi phan `para()` deu di qua `row([mk(...)...])` hoac `para(mk(...))`.

Ket qua: marker con lai nguyen chu o 2 cho. Toi quet toan cay theo 13 token (em-dash, en-dash, escaped pipe, double quote, arrow, Delta, ...) va chi con **4** cho: `docs/28:700` va `docs/35:861` (cua toi) + `review.md:994` va `review.md:1015` (Reviewer **trich dan** de mo loi, khong sua).

**Byte delta = 0** o ca hai file, vi marker 3 byte ASCII va dau em-dash 3 byte UTF-8. Mot tiet giam ma **khong doi mot byte** — ca so sanh byte va ca phep kiem noi dung deu im lang. Dung marker la chay cham hon mot ki tu, nhung no **that thoai** ve mot van de thuc te (tieu de ma tai lieu khac tro toi), nen van la loi can sua, khong phai rac ngau nhien.

### 21.4 Con tro `tasks/README.md:3` sang Turn 190, va `review.md#L977` co dung la heading khong

Banner chuyen **Turn 180** (`#L948`) sang **Turn 190** (`#L977`), 1820 -> **1805** ky tu, **chi 1 dong doi, 100 dong con lai byte-identical**, 101 CRLF / 0 bare LF truoc va sau.

Toi **kiem ca duoi tien, khong chi do khop nam**: dong 977 cua `review.md` la `## Turn 190 independent audit`. Turn 190 cung xac nhan nguoc lai: dong 948 la `## Turn 180 independent audit` va *the pointer is correct, not merely advanced*. Vay con tro **dung noi dung**, chu khong phai chi dung so dong.

Banner mang them 6 su that moi, de doc khong phai sang `review.md` moi hieu gate:

1. **T180-A1 da duoc tra loi**: nhanh deadline cua 0018 **bi falsify live**, va **migration 0019** dang `COALESCE` bay gio *duoc no* — bang migration moi, khong bao gio sua 0018 da apply.
2. **T170-V1, T180-D1, T180-D2** ghi **resolved in source, live proof van open** — khong phai closed.
3. **T190-A1** moi: 4/6 index co live existence nhung **chua co live use**; va `Δ21` **chua** duoc dong vi seed giu **1240/1263** dong trong mot tenant, dung thac Reviewer yeu cau (*representative tenants*).
4. **T190-V1, T180-D3, T190-D1, T190-D2** moi hoac mo lai.
5. **T140-D1: nua tai lieu CLOSED, finding van PARTIAL** cho T140-A1 live acceptance.
6. **Hai LOW troi ve chinh output cycle 20 cua toi** (T190-E1, T190-E2) duoc Reviewer chap nhan va da sua o day.

Va mot canh bao phuong phap moi cho cac audit sau: **regex lay dau ngoac cuoi cung moi hang tra 53/4/14**, vi ghi chuan cong chua `[...]` nam trong o acceptance; chi khi neo marker vao **cot 2** moi ra 57/3/11 = 71. Canh 10 (DATA/LOG/DEP) van khong co cot trang thai, nen bo dem bang regex tick thieu 10.

### 21.5 Mo rong standing scope S0/S1 — dung Reviewer yeu cau

Turn 190 ghi ro: *A27 own scope conclusion is correct and should be adopted — **Widen S0/S1** instead of adding a per-cycle scope — a scope derived from what was edited last cycle is not coverage*. Toi lam dung mot cau: khong them scope moi cho file thu nhat can sua.

Scope cu truoc cycle 20 (S0 = docs/06, 19, 20, 28, 35, 21-openapi.json; S1 = S0 + qwen-docs, gates/contracts-v1, qwen-admin). Hai file chuyen vao **S0** chu khong phai scope A2x, dung de **S1** ke thua theo dinh nghia:

- `tasks/README.md` — tu A26, nay len S0 de S1 ke thua
- `docs/admin-ops-monitoring-cost.md` — tu A27, nay len S0 de S1 ke thua

Hau qua: khong con cycle nao can sinh scope A2x nua, va ca hai file da tung la noi *sua manh nhat nhung khong co scope nao kiem* se khong con xay ra. Pham vi moi cua A28 la **11** file (S0 8 + 3 report/gate), va toi khong con can scope rieng.

### 21.6 Anchor `qwen-docs.md#L1660`: regression CUA CHINH TOI tu cycle 19, link check khong the bat

Khi lap inbound anchor toi phat hien mot loi **tu cycle 19**. `docs/28:678` va `docs/35:839` deu tro Muc 16 bang `qwen-docs.md#L1660`, nhung dong 1660 la **dong tach bang** (mot hang ba cot rong), con **Muc 16** nam o dong **1642**. Anchor lech **18 dong**.

Cycle 19 toi chen RESUME POINT 21 dong o dau, day moi thu tu, va **chi cap nhat 3 anchor vao qwen-cost.md** ma quen mat 2 anchor nay. Link check khong bat duoc vi 1660 <= 2223: no chi kiem `1 <= n <= soDong`. **Day la cai gia cua kiem tra hinh thuc: bang 0 voi nhung thu no khong duoc thiet ke de nhin.**

Toi **tro lai ve dong heading that** sau khi chen ledger entry 21 (xem 21.7) — khong phai doi so dong de doi tinh dung.

### 21.7 Quyet dinh co chu y: KHONG chen RESUME POINT o dau file lan nay

Moi cycle lane deu chen RESUME POINT moi o dong 7. Lan nay **khong**, va day la quyet dinh co chu y, khong phai bo so:

1. **Chen o dau se day moi so dong**, va `coordinator-antigravity.md:136` tro bang link **range** `qwen-docs.md#L120-L184` vao **report cua lane khac** — mot file toi khong duoc phep sua. Toi se lam **vong** mot lien ket cua lane khac chi vi them muc cua minh. Quy tac lane la *bao cao, khong sua report lane khac*, va no cung ap dung ca khi chinh minh la ben gay ra.
2. **Chi con ledger entry 21** (chen ngay sau muc 20) + Muc 21 (them o cuoi), nen **duy nhat** so dong tu 381 tro len tang 1. Phan `#L120` va range `#L120-L184` cua coordinator nam **truoc** 381, nen **nguyen ven** — toi kiem lai bang noi dung, khong chi bang so dong.
3. **Noi dung handoff khong mat**: Muc 21 nam ngay truoc dong `/compress` va **khong** can RESUME POINT de doc no.

Toi ghi lai day vi day la **doi lech vs convention cua chinh lane**. Convention co the bi phai phu co chung, nhung ly do phai ghi lai de cycle sau khong sua nham la mot soat sat thi thieu.
### 21.8 Link check + CONTENT gate moi

**S0 917 target / 565 anchor / BROKEN 0** (8 file) @ **S1 929 / 577 / BROKEN 0** (11 file). Ca cay: **1603 / 674 / BROKEN 2** — van dung **hai** break ton tai cua lane khac va 1 file non-UTF-8 (`tester3.md`).

So voi cycle 20, **S0 tu 6 len 8 file va S1 tu 9 len 11** — dung y widen cua Reviewer, khong con scope A2x rieng cho cycle nay.

**CONTENT gate moi, them vi Reviewer noi ro link check khong bao gi loai loi nay.** Ba quy tac:

1. Ky tu escape `$$` **cam triyet doi** trong moi file .md, tru **2 file duoc miec danh ro** la file *trich dan* loi de bao cao: `review.md` va `qwen-docs.md`.
2. **13 token** placeholder cung bi cam ngoai 2 file do.
3. Ket qua: **0** escaped-dollar va **0** token tho tren 221 file con lai.

**Gate phai keu la mot so 0 co y nghia, va so do la do toi sua.** Ban viet dau tien **bao 12 lan `$$` trong `qwen-docs.md` va 2 lan trong `tasks/README.md`** — tat ca deu **hop le**, vi do la chinh noi dung **ke lai** loi chu khong phai loi. Toi sua hai cach: (a) miec danh 2 file ro rang thay vi bo qua im lang, va (b) **viet lai banner README** de **mo ta** loi thay vi **trich dan** token, nen S0 sach hoan toan va gate **cam triyet doi** duoc trong pham vi nay. Bai hoc: *mot content gate phoi phan biet **la loi** voi **ke lai loi**; neu khong no se keu o lien tuc va nguoi ta se tat.*

### 21.9 Loi cua toi: 8 loi, phan loai theo luc bat

**A. 4 loi CHET LUC PARSE, khong file nao duoc tao.** (1-3) ba lan toi dong danh sach Python bang `].join(...)` thay vi mot dong `]` don gian, nen JS tu parse sai. (4) mot dau double-quote lang **ben trong** mot Python string double-quoted, lam chuoi ket thuc som. Lan 4 toi khong truy nguyen ma **cat fragment lam 3 file** de khoang vung — ton mot vong va sinh ra 3 file thay vi 1.

**B. 3 loi la VERIFIER HOAC TOOLING SAI, file thi dung.** (5) `out.index(...)` khop **chinh xac** trong khi tieu de Muc 16 co hau to, nen khong doc duoc so dong can sua anchor (ghi da xong truoc do). (6) guard bat truoc khi ghi doi dong **truoc** dong `/compress` bang sai chuoi, file con nguyen. (7) CONTENT gate ban dau **keu o loan** tren chinh noi dung ke lai loi (21.8).

**C. 1 loi DA TOI DEN DELIVERABLE, va do dung cong cu cua toi bat.** (8) toi viet 3 link tro sang `review.md` bang duong dan `../coordination/reports/review.md` trong chinh file `coordination/reports/qwen-docs.md` — file nam trong `coordination/reports/` nen duong dan do resolve thanh `coordination/coordination/reports/review.md`, **khong ton tai**. Link check chay **sau** khi ghi bao **BROKEN 3**; toi sua thanh duong dan cung cap, chay lai ra **BROKEN 0**. Day la loi duy nhat cua cycle nay cham vao tai lieu, va no duoc bat **dung bang link check** — dung cong dung ma lane tao ra de lam dung viec do.

**8 loi: 4 chet luc parse, 3 verifier sai, 1 len toi deliverable.** Ty le nay tot hon cycle 20 (12 truoc / 1 sau) va cycle 19 (3/2). Moi truong hop *check sai, file dung* deu khong lam hong gi, nhung **khong cai nao** duoc coi la binh thuong: ca 3 deu la toi **doan** hinh dang thay vi **suy ra** tu thuoc tinh, va loi thu 8 la toi **khong kiem duong dan tuyet doi** truoc khi ghi.

### 21.10 Trang thai cuoi 7 file (sha256 16 ky tu dau)

| File | Dong | Byte | EOL | endsLF | sha256 |
|---|---|---|---|---|---|
| `tasks/README.md` | 101 | 15.164 | CRLF | co | `4e17402963993e4e` |
| `docs/06-public-api.md` | 168 | 19.505 | CRLF | co | `d09675ffb2cc58fb` |
| `docs/20-openapi-descriptions.md` | 129 | 20.683 | CRLF | co | `25732bef51c23473` |
| `docs/admin-ops-monitoring-cost.md` | 81 | 14.401 | LF | co | `525286c76becb38f` |
| `docs/28-test-inventory.md` | 711 | 242.611 | CRLF | **khong** | `466ae4e4de4ac3e3` |
| `docs/35-acceptance-baseline.md` | 872 | 241.022 | CRLF | **khong** | `e90b10d67302d80f` |
| `coordination/reports/qwen-docs.md` | 2374 | 359003 | LF | co | (xem 21.10b) |

Khong file nao co BOM. `docs/06` va `docs/20` giu CRLF 168 / 129, `admin-ops` giu thuan LF 81, `docs/28` va `docs/35` giu CRLF **khong** dong cuoi, report nay giu thuan LF. **Khong quy uoc EOL nao duoc doi hay ep buoc** — moi lan ghi deu doc EOL tu file roi ghi lai dung convention cua no.

### 21.10b Ve sha256 cua chinh report nay

File dang doc **khong the chua sha256 cua chinh no** — gia tri do doi moi dong duoc them vao, va no se khong con dung sau dong ghi tiep theo. Toi ghi ro dieu do thay vi de mot con so khong the kiem chung. **Muon verify, hay chay sha256sum tren file sau khi chot** — gia tri do la mot diem do, khong phai mot claim.

### 21.11 Con tre, va vai ro nao khac

Khong gi trong cycle nay la cua lane nay de lam tiep. Con lai theo thu tu Turn 190 sap:

1. **T190-A1** — Admin + Tester: mot claimed window voi seed **da nghieng nhieu tenant** (20 tenant x ~200 dong) de chot index tenant-leading, **va** quyet dinh migration 0019 dang `COALESCE` ma T-35 da lam co co so. **Khong bao gio sua 0018 da apply.** Turn 190 chot T180-A1 la *answered* nhung migration van no.
2. **T190-V1a / V1b** — Platform + deploy owner + Tester: case bootstrap trung hop tren PG that, va **noi `initialBindings` vao mot build da ship** — Reviewer noi day la *blocking dependency* cho VAULT-06, khong phai mot note.
3. **T180-D3** — DATA: quyet dinh giua tu choi URL luc submit / adapter PostgreSQL / escalation theo tuoi tren `/health`. **T190-D1** (bo dem `preempted` khong phai tin hieu so huu) va **T190-D2** (chi chuan hoa digest mot phia) nen gop vao cung mot thay doi.
4. **T140-A1** van **live acceptance OPEN**. T-35 chi chay route-shaped SQL, **khong** chay HTTP route, nen cross-sort 422, six-sort walk va legacy-token van offline-only.
5. **COST-01..04** van 4 dong unaccepted va van giu `G-ADMIN-OPS`; T170-C1 chua dung vao.
6. **ADM-UX-02 `[~]`, ADM-UX-03 `[ ]`** va C4/C5 seeded browser chua chay.
7. **DEVIATION-1** — yeu cau thuoc coordinator: **freeze file suite** dang la muc tieu cua mot claimed live window **tu luc claim duoc post**. Lan nay con 96 giay giua luc lane sua file va luc claim, nen packet-vs-disk **khong the khop theo cach bat buoc**.

**Gate: `G-ADMIN-OPS` NO-GO, `G-SEC` NO-GO, `G-DATA` NO-GO, `G6` NO-GO** — y nguyen Turn 190. Khong tick dong task nao, khong adjudicate Δ nao, khong commit, khong push.

**Khong sua** 2 broken link ton tai cua lane khac, `tester3.md` non-UTF-8, va 3 dong backtick le co san trong khoi 1-18. Va **KHONG sua** 4 lan `$$` + 2 lan token placeholder nam trong `review.md` — do la Reviewer **trich dan** de mo hai finding nay.

**`/compress` lai duoc nhac — lan thu bay**, chua chay ke tu cycle 14 (A21).
> /compress

## 22 — CYCLE 22: W-DOCS-SYNC-1 / D-EVID-A29 — audit post-landing, sua 10 run backtick-le cua A29, va cai receipt A29 khong ghi

> [!IMPORTANT]
> **RESUME POINT — cycle 22 (lane Qwen-Docs, term_8ba9a7d5, dispatch ctx_73b2ce7c245d, task_4dc8ac64abc5).**
> Doc khoi nay la du de tiep tuc. Muc 1 (A7) → Muc 21 (A28) giu nguyen ben duoi lam lich su.
> 1. Cycle nay **khong mo noi dung moi cho docs/06** — noi dung A29 da landed tu workflow cua coordinator (agent docs:W-DOCS-SYNC, wf_fc026c79-513, `coordinator-claude.md` Turn 215). Cycle nay **audit** laning do theo packet W-DOCS-SYNC-1, **sua 4 lop defect**, va **bo sung Muc 22 ma A29 khong ghi**.
> 2. Ket luan audit: toan bo cac muc acceptance cua packet **dung va khop code**. `submission.ts` do tung dong: guard `if (submission.sourceUrl && storageBackend !== 's3')` tai dong 113, literal UNSUPPORTED_STORAGE_BACKEND tai 119, dong 121-122 — khop chinh xac voi khoang 113-122 du dan trong docs/06, docs/28, docs/35, README. Enum `PublicErrorCodes` tai `packages/contracts/src/errors.ts:41` (package 0.1.0, khong bump version — xem 22.8).
> 3. **Mười** run orphan hai-back-tick (lop T190-E2, chu ky tiep theo cua template-escape: A27 `$$n`, A27 `@E@`, A29 run backtick) nam o 5 dong cua `docs/28` §8.23 (713, 715, 716, 718, 723) — da thay bang em-dash het. +10 bytes = 10 run × 1 byte, so hop nhan ban tay.
> 4. **Dem tay la 9, tool dem 10** — toi thieu 1 run tren dong 715 (4 chu khong phai 3). Tool la chuan truoc khi ghi. Ghi lai vi day la lop loi ma ba cycle lien tiep khac nhau cung mo: generator cua cycle tru do token lang vao deliverable.
> 5. `docs/35` bi A29 sua noi dung (dong 866, +147 bytes) nhung **khong bump version**: da sua 1.33.0 → **1.34.0** o dong 3 cycle nay (byte delta 0, CRLF giu nguyen).
> 6. `tasks/README.md:3` ghi "T200-E1 (off-by-13 anchor) was **accepted** and repaired in D-EVID-A29" — vuot quyen lifecycle: chua ai verify (chinh `coordinator-claude.md` Turn 215 ghi "chưa VERIFIED độc lập"). Da sua thanh "was repaired in D-EVID-A29 (owner-side landing; Reviewer cross-check pending)." (+38 bytes, dung 1 dong).
> 7. `docs/28` bi A29 **viet lai full-file CRLF→LF** (A28 do: CRLF 711 dong khong newline cuoi; bay gio: crlf=0, 724 LF). Cycle nay **khong dao nguoc cuong che** — revert = churn 725 dong tren file da-lane; ghi Δ cho coordinator (22.8).
> 8. Anchor `qwen-docs.md#L1643` (Muc 16) duoc `docs/28:678` va `docs/35:839` tro toi → sau khi chen ledger-22 (+1 dong), **ca hai da repoint #L1644**, kiem theo noi dung: dong 1644 = heading `## 16 — CYCLE 16: D-EVID-A23`.
> 9. **Instrument changelog:** gate v1 (truoc khi sua) dem **11** hits — trong do 1 hit o `docs/28:718` la **ke lai loi** (`$$n` trong code span mo ta defect cua A28), khong phai loi. Gate v2 code-span-aware dem **10**, ca ba lan chay baseline deu TRUOC khi ghi artifact. Ba thing moi cua checker: code-span-aware gate, orphan-run gate, va exit 0 chi khi BROKEN=0 va MISMATCH=0 va GATE=0.
> 10. Trang thai cuoi: **IMPLEMENTED + offline VERIFIED (cycle nay, tren cay hien tai)** — noi dung A29 **chưa VERIFIED độc lập**, **KHONG ACCEPTED**; 4 gate NO-GO, 52 dong khong doi, khong tick task row, khong commit/push.

## 22.1 Dispatch va phat hien trang thai

Packet `W-DOCS-SYNC-1` (P2) giao cho lane Docs: publish T200-D1 (enum + docs/06 + docs/28:705 + docs/35), fix T200-E1 anchors, doi README pointer, link-check BROKEN=0. Khi dispatch nay toi (task_4dc8ac64abc5), toan bo da nam tren dia — duoc ghi boi `docs:W-DOCS-SYNC`, mot agent trong workflow `wf_fc026c79-513` cua coordinator (Turn 215, 23:0x), ty go "D-EVID-A29". Bang chung receipt thieu: `qwen-docs.md` mtime 23:05:54 voi **-4 bytes** so voi cuoi cycle 21 (2374 dong khong doi) — dung bang chang repoint 2 anchor tai :2227 (L1006→L993, L1007→L994), khong them section nao; muc cuoi van la Muc 21. Turn 215 chinh no ghi "IMPLEMENTED ... chua VERIFIED doc lap (can Reviewer cross-check)". Vay dispatch nay = lane audit + repair + ghi lai receipt, khong phai lane lam lai viec da xong.

## 22.2 Acceptance cua packet — audit tung muc, kem do luong

| Muc acceptance | Bang chung do tren cay | Ket luan |
|---|---|---|
| grep UNSUPPORTED_STORAGE_BACKEND xuat hien trong contracts + docs/06 | `packages/contracts/src/errors.ts:41` (memger `PublicErrorCodes`, type `PublicErrorCode` derive tu const array) va `docs/06-public-api.md` :126 + :164. Dem lan luot: contracts **1**, docs/06 **2**, docs/28 **2**, docs/35 **1**, tasks/README **1**, `submission.ts` **1**, suite test fail-closed **3** | **Dat** |
| docs/06 publish dieu kien backend ben canh sourceUrl | :126 §Submission: storageBackend khac s3 + request chua sourceUrl → **422 UNSUPPORTED_STORAGE_BACKEND** ngay sau schema parse thuan, truoc moi DB write, zero rows, khong parked PENDING_INGESTION; khoang cite `submission.ts:113-122` do lai tung dong, khop. :164 §Errors gan ma vao nhat 422 | **Dat** |
| Quyet dinh capability-gating vs 422 | docs/06:126 ghi quyet dinh + ly do cua Reviewer (backend khong the kham pha tu API; payload cung le ra dung sai theo deployment ma khong co tin hieu → can ma loi wire-visible) | **Da ghi, khong no** |
| docs/28 + docs/35: PostgreSQL case = rejected at admission, khong con parked | `docs/28:705` ("is now admission-rejected ... with zero DB writes", cau parked cu giu trong cell nhu lich su) + `docs/35:866` ("parked-URL prose is superseded", cung cach) + `docs/28` §8.23 rows moi | **Dat** (markdown hong trong §8.23 da sua — 22.3 D1) |
| Anchors correct | `review.md#L993` = finding 1 T190-E1, `#L994` = T190-E2, `#L1018` = heading Turn 200, `#L1045` = finding 3 T200-D1, `#L963`-`#L966` = T180-D1/D2/A1/D3 — tat ca doi chieu noi dung tung dong; `qwen-docs.md:2227` da tro dung 993/994 | **Dat** |
| README points at Turn 200 | `tasks/README.md:3` tro `review.md#L1018` = heading that | **Dat** (1 cu tu lifecycle da sua — 22.3 D3) |
| Link check BROKEN=0 | 22.5: S0 **927** target / **571** anchor / BROKEN **0** / MISMATCH **0** / GATE **0**; S1 BROKEN 0, MISMATCH 0; TREE BROKEN **2** = dung 2 cai pre-existing cua lane khac (`antigravity-6.md:8952`, `requests/antigravity.md:10`), giu nguyen co y, bao khong sua | **Dat pham vi scoped** — khong claim BROKEN=0 toan cay |

## 22.3 Bon lop defect A29 de lai — audit bat duoc, da sua (va mot cai chi ghi)

- **D1 — 10 orphan hai-back-tick runs trong §8.23** (`docs/28` dong 713, 715×4, 716×2, 718×2, 723×1): generator cua A29 do em-dash thanh run backtick trần — cung lop `$$n` (A27/T190-E1) va `@E@` (A27/T190-E2), nay la lan ba lien tiep token template lang vao artifact. Da thay em-dash. `docs/28` 247.926 → **247.936 bytes** (sha16 `a4d8cd3e0a0d1ba9` → `b7d9ffe0a2b2008e`), so dong khong doi, chi 5 dong 713/715/716/718/723 thay doi.
- **D2 — `docs/35` sua noi dung khong bump version**: A29 rewrite dong 866 (+147 bytes) van de `1.33.0`. Da set `1.34.0` o dong 3 (byte delta 0; sha16 `be1938d6d6032a26` → `fb9d59788b82b7ab`).
- **D3 — `tasks/README.md:3` "was accepted and repaired"**: acceptance la quyen cua Reviewer; Turn 215 moi tu ghi "chưa VERIFIED độc lập". Da sua thanh "was repaired ... (owner-side landing; Reviewer cross-check pending)." (14.955 → **14.993 bytes**, dung 1 dong, 101 CRLF va newline cuoi khong doi; sha16 `925e1525f29c1a1f` → `633bf61f4796c9f8`).
- **D4 — `docs/28` bi chuyen CRLF→LF full-file boi A29**: **khong sua** (revert = churn toan file da-lane; va "khong ep buoc EOL" la rule cua lane). Ghi Δ-A30-2 de adjudicate.
- **D5 — receipt A29 thieu hoan toan**: ledger dung o dong 21, section cuoi la Muc 21. Muc 22 nay la receipt; dong ledger 22 da chen. Day la defect quy trinh **phía coordinator** (packet da agent cua workflow tu danh D-EVID-A29 va danh dau "landed" khi lane chua ghi receipt) — Δ-A30-1.

## 22.4 Repair actions (co che — moi lan deu assert truoc khi ghi)

apply1: 12 substring replacements tren 3 file (`docs/28` ×10, `docs/35` ×1 version, `tasks/README.md` ×1), moi fragment assert `occurrence == 1` **truoc khi bat ky file nao duoc ghi**; guard cau truc bytes/lines/crlf/bareLF/endsNL per-file (chi delta du mo: +10B backtick, 0B version, +38B README; changLines in ra dung 713/715/716/718/723 va dung dong 3 o hai file kia). apply2: chen dong ledger "- 22 — ..." sau dong 382 (+1 dong → moi thu sau 382 lech +1), append Muc 22 o cuoi file, repoint `qwen-docs.md#L1643` → `#L1644` tai `docs/28:678` va `docs/35:839` (assert noi dung dong 1644 = heading Muc 16 truoc khi repoint). Fill: thay token TBD bang chu so ket qua chay — khong them/bot link nao nen so dem bat buoc bat buoc bat doi; ba lan chay cuoi kiem chung chinh dieu do.

## 22.5 Instrument: checker tai-dung tu spec da ghi, va 3 nang cap

Tai-dung theo dinh nghia `qwen-docs:2291`/`:2296` (A28): **S0** = 8 file (docs/06, 19, 20, 21-openapi.json, 28, 35, admin-ops-monitoring-cost, tasks/README); **S1** = S0 + qwen-docs.md + gates/contracts-v1.md + qwen-admin.md (11). **TREE** = moi `*.md` duoi docs/ + coordination/ + tasks/ = **185** file — dinh nghia nay la chuan so sanh tu cycle nay; cac con so S2 chu ky truoc (1577/665, 1600/671, 1603/674, 1401/676) den tu bo walk khong ghi nguyen van, **khong doi chieu duoc** — ghi ro de khong ai dem lech roi bao hong noi dung. Link rule: regex gioi han trong mot dong; relative resolve **tu thu muc file chua link** (bai hoc C-8 cycle 21); `file:///` resolve duong dan that; `#L<n>` validate `1 <= n <= lines`; **range** `#L<a>-<b>` dem rieng UNVALRANGE (khong validate — 40 case toan bo thuoc file lane khac). **Anchor-content assertion** theo rule chat cua §8.23: chi bun khi ** chinh text cua link** chua finding ID (`T<so>-<chou>`, `D-EVID-A<so>`), target line phai chua ID do. Ba nang cap cycle nay: (a) gate `$$[A-Za-z_]` va `@[A-Z]@` **tranh code span** — phan biet LA loi voi KE LAI loi (run `$$n` mo ta defect o :718 khong bi tinh); (b) **orphan-run gate**: run hai backtick tran (bo/sau la khoang trang bien dong) dem vao GATE va vao exit code; (c) **exit 0 = BROKEN 0 + MISMATCH 0 + GATE HITS 0**, ap dung S0; S1 ap BROKEN+MISMATCH.

Ket qua chay (literal, bo chay `wdocs22_check.txt`):

- **Baseline truoc repair (gate v1):** S0 TARGETS=927 ANCHORS=571 BROKEN=0 MISMATCH=0 GATE-HITS=**11** (10 hom ORPHANBT2 + 1 hom DOLLARSQL ke-lai-loi); gate v2 sau khi sua: GATE-HITS=**10**. Ca hai lan chay deu truoc khi ghi artifact.
- **Sau apply1 (gate v2):** S0 TARGETS=927 ANCHORS=571 BROKEN=0 MISMATCH=0 GATE-HITS=**0**; S1 FILES=11 TARGETS=940 ANCHORS=583 BROKEN=0 MISMATCH=0; TREE FILES=185 TARGETS=1536 ANCHORS=651 BROKEN=2 (dung 2 pre-existing, khong phai file lane) UNVALRANGE=40.
- **Sau apply2 + fill, 3 lan lien tiep:** S0 927/571 BROKEN 0 MISMATCH 0 GATE 0 @ S1 940/583 BROKEN=0 MISMATCH=0 @ TREE 1536/651 BROKEN=2. ExitCode cua moi lan: 0, 0, 0 (lenh: `python wdocs22_check.txt S0 S1 TREE`).

## 22.6 Do luong cuoi (convention: dong = python text.split newline count; sha16 = sha256 prefix; doc lai tu source neu nghi da dich chu sau khi file nay ghi them)

| File | Dong | Byte | EOL | cuoi file | sha16 dau cycle 22 | sha16 cuoi cycle 22 |
|---|---|---|---|---|---|---|
| `docs/06-public-api.md` | 168 | 20513 | CRLF (khong bi dao EOL — khac docs/28) | co | `c6fc0195d1330fb2` | **khong doi — cycle nay khong sua** |
| `docs/28-test-inventory.md` | 725 | 247926 → 247936 | **LF** (tru day CRLF — D4) | khong | `a4d8cd3e0a0d1ba9` | 9210f00a9d9be5aa |
| `docs/35-acceptance-baseline.md` | 872 | 241169 | CRLF | khong | `be1938d6d6032a26` | dcdf74d89701df2d |
| `tasks/README.md` | 101 | 14955 → 14993 | CRLF | co | `925e1525f29c1a1f` | 633bf61f4796c9f8 |
| `packages/contracts/src/errors.ts` | 118 | 3253 | — | — | — | **khong doi — A29 da land, audit xac nhan** |
| `coordination/reports/review.md` | 1058 | 326963 | CRLF | co | `edcf72f4b9da0286` | khong doi (khong phai file lane nay) |
| `coordination/reports/qwen-docs.md` (file nay) | 2374 → 2477 → moi ghi sau do lai dich dong — do lai (22.6b) | 358999 → do-lai sau khi chot (22.6b) | LF | co | `0095281f73cd0f82` | (xem 22.6b) |

## 22.6b Ve sha cua chinh file nay

File dang doc khong the chua sha cua chinh no — gia tri doi sau moi dong ghi. Muon verify: chay sha256 tren file sau khi chot. Day la diem do, khong phai claim (nguyen van 21.10b, giu vi van dung).

## 22.7 Trang thai that (4 muc) va viec cua role khac

**W-DOCS-SYNC-1 (scope dispatch nay): IMPLEMENTED va offline VERIFIED** (ca A29 landed + cycle 22 repair deu da duoc doi chieu code/anchor/tool tren cay hien tai). **Chưa VERIFIED độc lập** — Reviewer cross-check van theo ke hoach Turn 217 cua coordinator. **KHONG ACCEPTED** — lane khong tu dong bang cua no. `G-ADMIN-OPS` / `G-SEC` / `G-DATA` / `G6` van **NO-GO**; 52 dong unaccepted khong doi; khong tick dong task nao; khong adjudicate Δ nao; khong DB/Redis/S3 window; khong commit/push (`git log -1` van `7811298`). Viec role khac giuyen list cycle 21 muc 21.11: T190-A1 live seed lech tenant, 0019 live EXPLAIN (va `flag param-vs-literal` Turn 215 ghi), T140-A1 live acceptance, T190-V1a/b, DATA live, COST-01..04, ADM-UX browser, va **T200-P1** (alias `typecheck` trong `services/orchestrator/package.json` — owner coordinator/package, **khong phai** docs lane).

## 22.8 Δ nang len coordinator adjudicate

- **Δ-A30-1 (quy trinh, nang nhat):** packet lane-khac-duoc-agent-cua-coordinator-chay va danh dau "landed" **truoc khi** receipt lane ton tai. Turn 215/216 ghi "W-DOCS-SYNC landed" tu 23:1x; receipt Muc 22 nay ghi luc 11:xx+ hom sau. De nghi: workflow-agent ghi deliverable vao file cua lane phai kem receipt-assertion (lanh dao: lane report phai co muc tuong ung truoc khi packet dat [landed]).
- **Δ-A30-2:** `docs/28` (va `docs/06` mtime 23:01:55 — doc EOL truoc khi sua) dang LF trong khi chu ky A20-A28 do CRLF khong newline cuoi; A29 khong ghi ly do chuyen EOL; docs/06/35 va README cung landed cung pass van giu CRLF, nen day la dao-chi-rieng-28. Adjudicate: chap nhan LF = chuan moi, hay bat buoc CRLF-lai (churn 725 dong)?
- **Δ-A30-3:** docs/35 version correction 1.33.0→1.34.0 — xac nhan convention "sua noi dung la bump version (D73)" van lang khi agent khac ghi file?
- **Δ-A30-4:** sua cu tu README "accepted and repaired" — day la **sua lifecycle overclaim cua artifact da xuat ban**, khong phai thay noi dung ky thuat; ratify hoac dao.
- **Δ-A30-5:** §8.23 dung **double-backtick code span** ca section trong khi phan con lai cua `docs/28` dung single — CommonMark render tuong duong, toi khong ep; chuan hoa ve single khong?
- **Δ-A30-6:** dong lich su DATA-03 trong `docs/35` (~:720, vung Turn 40-era) van ghi URL "202 admission" khong dieu kien backend. Toi **giu nguyen theo rule giu lich su exact-scope** (Turn 170/180) va khong tu annotation; can quyet: cham chu "superseded at admission" nhu :866, hay de?
- **Δ-A30-7:** chen ledger-22 lam moi dong ≥383 lech **+1**. Prose cite cua lane khac (review.md:1037 → `qwen-docs.md:2162`; coordinator-claude Turn 215 → `qwen-docs.md:2227`) bay gio lech 1 dong; markdown-link `#L1643` da repoint #L1644 (2 noi dung `docs/28:678`, `docs/35:839`). Theo rule toi **khong sua report lane khac** — bang bao cao tai day.
- **Δ-A30-8:** "contract version" theo handoff format cua packet: @du/contracts **0.1.0**, member enum moi khong di kem bump package version (private monorepo). Flag neu quy trinh release doi semver cho published taxonomy.

## 22.9 Loi cua chinh cycle nay (ca truoc-va-sau khi ghi)

- Dem tay **9** orphan runs khi tool tinh **10** (thieu 1 o dong 715) — truoc khi ghi, tool bat.
- Gate v1 gop **ke-lai-loi** (`$$n` trong code span tai :718) voi **la-loi** — truoc khi ghi thi da code-span-aware; artifact khong nhiem. Chinh xac hoa: v1 dem 11 (khong dung 10+1), v2 dem 10 dung ban chat.
- Vai exec dau tien: mot batch Promise.all bi abort boi 1 probe shell exit 1 (`dir` findstr khong match) — goi de-lan bi tu choi nen abort ca 7 ket qua doc; chay lai 1 vong. Quy tac da biet ("giu goi co the bi tu choi ra khoi batch") nhung toi van mac — ghi lai.
- Fill-pass sinh them **bon** loi instrument (khong cai nao cham artifact): (a) regex cua fill script viet trong JS template literal bi **an mat backslash** — `\[` thanh `[`, `\d` thanh `d` (chay fail loud, file chua ghi); (b) sau do sai capture-index — MISMATCH nam o group 5 chu khong phai 6 (IndexError, van truoc ghi); (c) mot token bi khai bao trong map ma khong co trong receipt (duoi "TRF") — chinh guard "token missing" chan lai truoc khi ghi; (d) test MATCH-FILLED so tuple 5-phan-tu voi tuple 4 → **False gia** tren so lieu that ra bang nhau. Toan bo ba lan chay cuoi cua verify doc lap da xac nhan gia tri dien trong receipt khop 100% va ExitCode 0 x3. Bai hoc ghi thang: loi cua tool thi fail loud; loi cua **test** co the in ra ket-luan-sai tren noi dung dung — doc tuple in ra, dung doc co quan cua test.
- Bai hoc cu van dung: batch Promise.all abort ca batch khi mot goi error — giu goi de bi tu choi ngoai batch doc.

## 22.10 Handoff theo dinh dang packet W-DOCS-SYNC-1

- **Outcome:** toan bo scope packet (T200-D1 docs-surface + T200-E1 + README pointer + decision 422-vs-gating + link gate) **audited va xanh offline**; 4 lop defect cua A29 da sua; receipt A29 (Muc 22) da ghi tre — mot lan, day du.
- **Changed paths (cycle 22):** `docs/28-test-inventory.md` (5 dong §8.23), `docs/35-acceptance-baseline.md` (L3 version + L839 anchor), `tasks/README.md` (L3 cu tu), `coordination/reports/qwen-docs.md` (ledger + Muc 22). A29-landed-da-audit-khong-sua: `docs/06-public-api.md`, `packages/contracts/src/errors.ts`, `services/orchestrator/...` (ngoai quyen, chi doc).
- **Contract version:** @du/contracts 0.1.0, `PublicErrorCodes` dang chua UNSUPPORTED_STORAGE_BACKEND (errors.ts:41) — xem Δ-A30-8.
- **BROKEN count:** scoped **0/0** (S0/S1, MISMATCH 0, GATE 0); toan cay **2** (pre-existing cua lane Antigravity, giu co y).
- **Remaining:** none for this scope; viec role khac nhu 22.7.

**/compress lan thu tam** duoc nhac — van chua chay tu cycle 14 (A21); context cycle nay nang (audit 7 file + 2 script).

## 23 — CYCLE 23: W-DOCS-REV-0019 — sữa prose sentinel (REV-ORCH-0019-01) và ghi chú docs/21 đi qua generator

> [!IMPORTANT]
> **RESUME POINT — cycle 23 (lane Qwen-Docs, term_8ba9a7d5, dispatch ctx_0132e53d9b05, task_dbd8cb31051d).**
> 1. Task = khóa finding [REV-ORCH-0019-01](review.md#L1087) (MEDIUM, review.md §Turn 201, heading tại [dòng 1061](review.md#L1061)): docs/06:74 nói "sentinel đã bind", docs/20:39 nói "bound sentinel", trong khi production từ W-INGEST-0019-2 là **inline literal Const**. Source-of-truth đọc thằng từ `server.ts`: `OPERATIONS_LIST_NULL_SORT_BOUND_SQL` = desc → 0001-01-01, asc → 9999-12-31; `bindOperationsListSortKey` trả `COALESCE(<col>, '<ISO>'::timestamptz)` với **zero** param; lý do nằm trong docstring của chính hàm: 4 index biểu thức của 0019 chỉ match đúng Const node, bản `$n` là plan node khác → Seq Scan + Sort, bốn index chết (T-35). Không chép từ packet.
> 2. Đã sửa **dúng câu chữ Reviewer yêu cầu** tại đúng 2 site; cùng hình định mô tả (literal có quote + cast, Const, không phải placeholder) được đưa cả vào docs/21 — nhưng **qua generator** `gen_openapi.py`, không sửa tay vào JSON: sửa tay artifact sinh ra là tái diễn chính lộ drift mà T140-D1 đã đóng.
> 3. Chuỗi chứng minh regen: `py_compile` gen rc=0; gen **×2 rc=0** sha **đồng nhất** `3bc395fb4fb5fa0f`, 33.488 → **33.790 bytes**; `validate_openapi.py` rc=0 (OPENAPI-EXAMPLES-VALIDATED); so sánh cấu trúc JSON trước/sau: **chỉ** key `description` của param `sort` đổi, enum/default y nguyên, phần còn lại của toàn spec byte-equal; docs/21 giữ CRLF (1275/1275).
> 4. REV-0019-02 (LOW — header của `0019_operations_deadline_coalesce_index.sql` neo số dòng cũ `server.ts:2547`, hàm thực tại 2556): **KHÔNG sửa** — file thuộc Platform/lane source, đúng rule "báo cáo, không sửa". Đã có từ trước trong [qwen-platform.md Mục 13](qwen-platform.md#L1276) (Δ30).
> 5. Guards: mỗi fragment `occurrence == 1` trưỜ khi ghi; file-changed-lines = docs/06 đúng [74], docs/20 đúng [39], gen đúng đoạn 181-186 (+5 dòng); hai docs giữ nguyên CRLF; docs/06 20.513 → 21.145 B, docs/20 20.683 → 21.286 B (sha16 `bd1a64e6f41ad6c9` / `59834d5bae95f1ea`).
> 6. Chen ledger-23 làm Mục 16 của file này dâng #L1644 → #L1645: **hai markdown-link trong docs/28:678 và docs/35:839 đã repoint theo nội dung** (đây lần thứ HAI chu kế liền trả cái thuế này — đề xuất ở Δ-A31-3).
> 7. Chất lượng kết thúc: REV-ORCH-0019-01 **FIXED, offline VERIFIED (cycle này)**; quyết định [x] cho ORCH-OPS-0019 thuộc coordinator theo đúng verdict review.md:1112 — lane không tick; không commit/push (HEAD vẫn `7811298`).

### 23.1 Dispatch và nguyên văn finding

Verdict Turn 201: "**CHANGES_REQUESTED** — one MEDIUM documentation traceability finding [REV-ORCH-0019-01] blocks ACCEPTED... Fix is single prose edit: change sentinel da bind / bound sentinel to sentinel literal inline '<ISO>'::timestamptz (Const, khong phai $n) at docs/06:74 and docs/20:39 (and optionally add one line to docs/21 sort description or keep deferral note). After that edit + docs lint BROKEN 0 re-check, coordinator may mark ORCH-OPS-0019 ACCEPTED ([x]) without code or test change. Live deadline_at Index Scan gate (T-35/Delta21/T190-A1) is tracked separately and does not block this module offline acceptance." — không còn finding HIGH; 02 LOW và 03 SUGGESTION như ghi ở RESUME POINT #4 và 23.2. Dispatch cycle nâng 03 từ "optional" thành yêu cầu của lận giao việc, nên làm, và làm đúng cơ chế artifact.

### 23.2 Ba site đã sửa — trước / sau

| Site | Câu stale (trước) | Câu hữu hiệu (sau) |
|---|---|---|
| `docs/06-public-api.md:74` | "được COALESCE về một **sentinel đã bind** (`0001...` khi desc, `9999...` khi asc)" | COALESCE với sentinel **literal inline** (`'0001-01-01T00:00:00.000Z'::timestamptz` desc / `'9999-12-31T23:59:59.999Z'::timestamptz` asc) — Const node nằm ngay trong ORDER BY, không phải placeholder `$n`; kèm lý do 4-index-0019-match-Const (T-35 / W-INGEST-0019-2), compile-time constant theo direction đã validate, chuới được cursor predicate dùng lại nên ORDER BY và boundary không thể lệch |
| `docs/20-openapi-descriptions.md:39` | "its key is COALESCEd over a **bound sentinel** (0001... for desc, 9999... for asc)" | "COALESCEd over an **inline literal sentinel** ('...'::timestamptz) — a Const node written into the ORDER BY text itself, never a bound placeholder" + mạch vì-sao-0019-chỉ-match-Const + mạch NULLs-last-giữ-nguyên ví-dụ page-2-đăng sau 200 |
| `tools/openapi/gen_openapi.py:181-186` (source của `docs/21-openapi.json:161-173`) | mô tả sort kết thúc ở allow-list | thêm: "deadline_at orders NULLs last via COALESCE(deadline_at, '0001...'::timestamptz) for desc and '9999...'::timestamptz for asc, written as an inline literal constant (Const node) rather than a bind parameter, so migration 0019 expression indexes match the ORDER BY form." → regen ×2 đồng nhất, docs/21 `3bc395fb4fb5fa0f` |

Không động vào: các dòng lich sử nói về `$N/$M` của **cursor predicate** (`bindOperationsCursor`) trong docs/28/20 — đó là bind-value của row-value comparison, vẫn đúng hình hiện tại; chỉ **khóa ORDER BY** mới là literal. Không tồn tại xung đột giữa hai mạch này trong đám docs.

### 23.3 Instrument và chạy

Tầm soát dùng lại bộ cycle 22 (S0=8, S1=11, TREE=walk đã ghi định nghĩa ở 22.5), mở rộng duy nhất: finding-ID pattern nhận thêm loại ID mới của Reviewer (REV-<LANH VUC>-<số>-<số>) — không sinh false positive nào trước khi ghi. **Trạng thái giữa (apply3 + regen, trưỜc khi append Muc 23):** S0 927/571 BROKEN 0 MISMATCH 0 GATE 0; S1 940/583 BROKEN 0 MISMATCH 0; TREE 187 file 1536/651 BROKEN 2 (vẫn đúng 2 cái pre-existing, FILE tăng 185→187 vì 2 file md mới của lane khác, 0 link mới). **Trạng thái cuối, 3 lan lien tiep (lenh `python wdocs22_check.txt S0 S1 TREE`):** S0 927/571 BROKEN 0 MISMATCH 0 GATE 0; S1 943/586 BROKEN 0 MISMATCH 0; TREE 187/1539/654 BROKEN 2. ExitCode: 0, 0, 0.

### 23.4 Đo lường cuối cycle

| File | Bytes trước → sau | sha16 sau | Ghi chú |
|---|---|---|---|
| docs/06-public-api.md | 20513 → 21145 | `bd1a64e6f41ad6c9` | CRLF giữ nguyên, đúng 1 dòng đổi |
| docs/20-openapi-descriptions.md | 20683 → 21286 | `59834d5bae95f1ea` | CRLF giữ nguyên, đúng 1 dòng đổi |
| docs/21-openapi.json | 33488 → 33790 | `3bc395fb4fb5fa0f` | sinh bởi generator, ×2 đồng nhất, chềnh duy nhất = description |
| tools/openapi/gen_openapi.py | 19846 → 20218 | `c449719da51383f6` | +5 dòng string, py_compile rc=0 |
| docs/28-test-inventory.md | 247936 | 6a8daeebad00fd70 | chềnh đúng dòng 678 (#L1644→#L1645) |
| docs/35-acceptance-baseline.md | 241169 | e33c957b7321ba31 | lệch đúng dòng 839 (#L1644→#L1645) |
| file này | 378892 → tăng theo append | do-lại (22.6b) | ledger + Muc 23 |

### 23.5 Δ cho coordinator và lỗi của lane trong cycle

- **Δ-A31-1:** REV-0019-02 report-only — migration header mang neo số dòng của file đang bọi (`2547` → hàm tại `2556`); đề nghịnh chuyển neo sang **symbol** theo đúng convention của chính docs/06. Owner: Platform.
- **Δ-A31-2:** `docs/28` vẫn LF (Δ-A30-2 chưa ai adjudicate); chu kế này sửa 1 dòng trong file đó và giữ nguyên convention hiện hành của nó.
- **Δ-A31-3:** thuế repoint inbound-anchor **hai chu kế liên tiếp** (mỗi lần ledger càng thêm dòng là Mục 16 lại dâng 1). hoặc (a) inbound anchor chuyển sang heading-link, hoặc (b) ledger dồi về cuối file — lane không tự đổi phong cách đã được Reviewer chấp thuận, nên chỉ nâu phương án.
- **Δ-A31-4:** mô tả sentinel bây giờ **nằm trong generator** — nếu hình ORDER BY đổi lại nữa, checklist đồng bộ phải gồm `gen_openapi.py` + regen, không chỉ 6 site prose.
- **Lỗi của lane:** (1) bản apply3 đầu tiên thử nhúng toàn văn bản thay thế có accent/backtick vào string JS — rối nhạt trong đấu tranh escape; hủy trước khi ghi, chuyển sang fragment-file thuần văn bản (áp dụng bài học "đừng nhúng nội dung vào code" của 22.9). (2) Một lần edit file checker ghi lộn chuỗi old_string (thừa cặp back-tick bìa) — tool từ chối "0 occurrences" trước khi ghi, làm lại đúng. Cả hai đều **trước ghi**, artifact sạch. (3)Fill-pass **tái phạm đúng bẫy group-index của cycle 22** (MISMATCH nằm ở group 4 của S1-regex, không phải 5) — crash **trước khi** fill kịp ghi file, token còn nguyên, một sửa một chạy lại. Cùng một loại lỗi qua hai cycle là bằng chứng: instrument phải pin group **theo tên** (dict) thay vì index — ghi vào backlog instrument của lane.

### 23.6 Handoff theo định dạng W-DOCS-REV-0019

- **Outcome:** REV-ORCH-0019-01 (MEDIUM, blocking) đã khóa ở mặt tài liệu; REV-0019-03 được giải trình từ "optional" thành "done via generator" theo đúng cơ chế artifact; REV-0019-02 report-only đúng owner. BROKEN=0 đã re-check áp điều kiện verdict để coordinator quyết định [x].
- **Changed paths:** docs/06-public-api.md:74; docs/20-openapi-descriptions.md:39; tools/openapi/gen_openapi.py (string block +5 dòng) kèo docs/21-openapi.json regen; docs/28-test-inventory.md:678 + docs/35-acceptance-baseline.md:839 (repoint anchor); qwen-docs.md (ledger + Muc 23).
- **Contract version:** @du/contracts **0.1.0** — không đổi trong cycle này (không sửa taxonomy, không sửa code).
- **BROKEN count:** S0 **0**, S1 **0**, MISMATCH 0, GATE 0; toàn cây **2** = 2 cái pre-existing của Antigravity lane, giữ nguyên có chủ đích.
- **Remaining:** vào role khác: [x] ORCH-OPS-0019 (coordinator, theo verdict); symbol-anchor hóa header 0019 (Platform, REV-0019-02); live EXPLAIN 0019 với tenant-skewed seed (T190-A1/Δ21 — verdict tuyên bố rõ không chặn offline acceptance). **none for this scope.**

## 24 — CYCLE 24: W-DOCS-ENC-SYNC — đồng bộ ADR-18 encryption architecture vào 4 file docs

> [!IMPORTANT]
> **RESUME POINT — cycle 24 (lane Qwen-Docs, dispatch ctx_e218e79e0c2d, task_4837df386fe6).**
> 1. Task = đồng bộ ADR-18 (AES-256-GCM envelope encryption, 4MB chunk manifest, recipient delivery encryption hpke/rsa-oaep, Vault Transit DEK wrap) vào docs/04, docs/06, docs/07, docs/11.
> 2. **Không có code encryption nào tồn tại** trong `services/orchestrator/src` hay `packages/contracts/src` (grep zero matches). Mọi section ghi rõ "CHƯA triển khai / ENC-00 [~] / G-ENC mở" — đây là design-baseline sync, không mô tả hành vi đang chạy.
> 3. Bốn file không có `Document Version` header → không bump. Inbound anchor duy nhất: `docs/06:80` (docs/28:703, docs/35:864) — append cuối file không dịch dòng đó.
> 4. Link check: S0 932/572 BROKEN=0, S1 948/587 BROKEN=0, TREE 189 file BROKEN=2 (pre-existing Antigravity, giữ có chủ đích). ExitCode 0.
> 5. Packet deviation: packet nói "Vault key allowlisting" nhưng ADR-18 không dùng thuật ngữ đó → ghi đúng ADR-18 (Vault Transit wrap DEK, deployment-level config cho key name), flag Δ-A32-1.
> 6. Không sửa code/test, không tick task row, không nâng gate, không commit/push.

### 24.1 Thay đổi theo file

| File | Dòng trước | Dòng sau | Bytes trước | Bytes sau | Nội dung thêm |
|---|---|---|---|---|---|
| docs/04-data-state.md | 83 | 97 | 8583 | 10259 | §Artifact encryption at rest: DEK 256-bit, Vault Transit wrap, AES-256-GCM, chunk 4MB + manifest, metadata không plaintext, public upload qua streaming gateway |
| docs/06-public-api.md | 169 | 199 | 21145 | 22707 | §Result delivery encryption: per-tenant toggle, HPKE RFC 9180 / RSA-OAEP-SHA256 suites, envelope format, PoP challenge, key lifecycle, fail-closed 422/409 |
| docs/07-internal-api.md | 84 | 104 | 9180 | 10744 | §Encryption boundaries: runtime worker không nhận plaintext DEK, multipart ciphertext-only, Vault KV/Transit tách mount, deployment-level key config |
| docs/11-admin-ux.md | 34 | 64 | 3117 | 4688 | §Delivery encryption management: toggle screen, public key registration (PoP), revocation semantics, audit trail, không nhập raw key |

### 24.2 Source-of-truth verification

- ADR-18 đọc tại `docs/15-decisions.md:283-326` (Context, 6 baseline points, 4 open decisions, gate status).
- grep `encrypt|DEK|cipher|hpke|rsa-oaep` over `services/orchestrator/src` → **0 matches**; over `packages/contracts/src` → **0 matches**.
- Tasks: `APP-ENCRYPTION-2026-09-27.md` xác nhận ENC-00 `[~]`, ENC-01..09 + ENC-INT-01 `[ ]`, G-ENC mở.
- Kết luận: mọi section phải ghi "CHƯA triển khai" — không mô tả hành vi đang chạy.

### 24.3 Δ cho coordinator

- **Δ-A32-1:** Packet nói "Vault key allowlisting" nhưng ADR-18 không dùng thuật ngữ đó. ADR-18 nói: Vault Transit wrap/unwrap DEK; deployment cấu hình key name (deployment-level config, không phải per-request caller input). Ghi đúng ADR-18. Nếu coordinator muốn "allowlisting" là yêu cầu bổ sung, cần ADR amendment hoặc packet mới.
- **Δ-A32-2:** `RESULT-WIRE-01` (chốt GET /result trả data hay ref, /download 200 proxy hay 302) phải đóng trước ENC-01/07. docs/06 ghi dependency này.
- **Δ-A32-3:** Bốn file này không có `Document Version` header. Nếu quy trình yêu cầu version tracking cho mọi doc, cần thêm header (ngoài scope cycle này).

### 24.4 Lỗi của lane trong cycle

- Một lần PowerShell EOL census fail do backtick escaping trong exec tool → chuyển sang Python, chạy đúng.
- Một lần đọc nhầm pre-apply byte count (tưởng file bị writer khác sửa giữa chừng) → đọc lại xác nhận không có double-apply, dedup script abort đúng (marker count = 1). Artifact không bị ảnh hưởng.

### 24.5 Trạng thái cuối

**IMPLEMENTED (docs-sync) / offline VERIFIED (link check ×1 ExitCode 0) — không ACCEPTED, không nâng gate.** G-ENC mở, ENC-00 `[~]`, 11 task ENC còn lại `[ ]`. Không tick task row, không commit/push.

**/compress lần thứ chín** được nhắc.

## 25 — ENC-04 dispatch: TỪ CHỐI, TRẢ VỀ COORDINATOR

**Packet:** task_3601efe1cf77, dispatch ctx_7ef641aba1d4, từ Antigravity.
**Yêu cầu:** Implement ENC-04 — Worker-SDK và document-core encryption adapter (6 acceptance items, giới hạn packages/worker-sdk/** + packages/document-core/**).

**Quyết định: TỪ CHỐI.**

**Lý do 1 — Sai lane:** Session này là Qwen-Docs (docs/evidence lane, term_8ba9a7d5). Vai trò ghi trong AGENTS.md và 24 cycle receipt: "chỉ cập nhật hồ sơ evidence trong du-rework/docs từ receipt của owner/Tester. Không code, không chạy test, không mở DB/Redis/S3 window, không adjudicate, không tick task row, không commit/push." ENC-04 yêu cầu implement production crypto adapter — hoàn toàn ngoài scope.

**Lý do 2 — ENC-00 chưa freeze:** Task plan APP-ENCRYPTION-2026-09-27.md ghi rõ: "Không dispatch crypto wire implementation khi chưa freeze các quyết định [ENC-00]." ENC-00 hiện đang [~] với 4 quyết định còn mở (response wire, key-policy timing, crypto profile/test vectors, upload protocol). ENC-01 (contracts/envelope schema) cũng chưa triển khai → ENC-04 thiếu dependency bắt buộc.

**Không implement. Không sửa file nào ngoài receipt này. Không commit/push.**

**Yêu cầu coordinator:** phân lại ENC-04 cho đúng lane (worker-sdk/document-core owner) và chỉ dispatch sau khi ENC-00 freeze + ENC-01 landed.

> /compress


## 26 — CYCLE 26: D-EVID-A21 — sáu packet encryption (ENC-01/02/03/06/07 + ENC-META-01) vào evidence inventory

> [!IMPORTANT]
> **RESUME POINT — cycle 26 (lane Qwen-Docs, dispatch ctx_c3c51b5ce088, task_681610f81431).**
> 1. Packet yêu cầu đồng bộ 6 packet encryption **offline verified** vào docs/28 + docs/35. **Cả 6 đều có independent receipt** của Codex Tester Offline với literal `ExitCode 0` — nhưng **không cái nào ACCEPTED**, không live Vault/S3/PG/browser/external-decrypt.
> 2. **Số liệu plan file ≠ receipt gốc ở ENC-01.** Plan `tasks/APP-ENCRYPTION-2026-09-27.md` ghi "46/46, contracts 20 suites/412 tests"; receipt [T-CODEX-OFFLINE-CONTRACTS-ENCRYPTION](tester.md#L7857) ghi **38/38 targeted, 18 suites/423 tests**. Plan ghi "7 schemas", Mục 16 ghi **6 schema + 2 constant, 196 dòng**. Tôi ghi **số của receipt**; Δ-A33-1.
> 3. **ENC-03 và ENC-06 không có owner receipt trên file** (chỉ dispatch/msg id trong plan; Codex Worker 1 ghi code trong shared tree) — bằng chứng thực thi có, audit trail owner thiếu → Δ-A33-2.
> 4. **Anchor trượt, bắt được bằng content check chứ không phải link check.** Tổng **3 anchor trượt**: `qwen-platform.md` L1555/L1668 → **L1556/L1669**, và `qwen-admin.md` L2760 → **L2777**; cả ba do lane khác ghi file giữa lúc tôi grep và lúc verify. `MINE_ANCHOR_FAILS` đi từ 2 → 1 → **0/16**. Đây là lần thứ tư trong bốn cycle liên tiếp mà content assertion bắt được thứ `BROKEN=0` không thấy — và lần này có thêm một anchor nữa (inbound repoint) cũng chỉ lộ ra bằng content check. **Anh em `](../coordination/reports/…)` trong chính file report tôi tạo ra thêm 7 link BROKEN — xem 26.4 mục 4.**
> 5. **EOL: docs/28 là file LF thuần** (A29 đã đổi, Δ-A30-2). Append của tôi lỡ dùng CRLF → 3 CRLF lẫn vào file LF; tôi tự phát hiện qua census và sửa về **0 CRLF** ngay. docs/35 là CRLF-dominant, append CRLF đúng convention.
> 6. Version bump `1.34.0 → 1.35.0` cả hai file, **cùng độ dài nên byte delta 0**, không dịch dòng nào.
> 7. Link check **×3 liên tiếp, cả 3 ExitCode 0**, ổn định: S0 949/589 **BROKEN=0 MISMATCH=0 GATE=0**; S1 972/611 BROKEN=0 MISMATCH=0; TREE 1575/679 BROKEN=2 (2 pre-existing Antigravity, giữ nguyên có chủ đích). `MINE_ANCHOR_FAILS=0/16` (content assertion cho **mọi** anchor của cycle này).
> 8. **Không gate nào đổi.** `G-ENC` NO-GO, `G6` NO-GO, `ENC-00` vẫn `[~]`, `ENC-04/05/08/09/ENC-INT-01` vẫn `[ ]`. Không tick task row, không commit/push.

### 26.1 Hai section mới

- **docs/28 §8.24** — bảng 6 packet: owner receipt + independent receipt + mức; kèm đoạn ghi rõ số plan lệch số receipt, và ghi rõ ENC-03/ENC-06 thiếu owner receipt.
- **docs/35 §12.26** — boundary của mức bằng chứng: cột "cái còn thiếu để ACCEPTED" cho từng packet (ENC-02 chưa từng gọi Vault thật; ENC-07 chưa có external decrypt byte thật; ENC-META-01 chưa có live byte-scan...).

### 26.2 Số đã verify — đọc trực tiếp receipt, không chép plan

| Packet | Targeted | Collateral | Full package | tsc | Independent receipt |
|---|---|---|---|---|---|
| ENC-01 | 38/38 | — | contracts 18 suites / 423 tests, build 0, lint 0 | 0 | [tester.md#L7857](tester.md#L7857) |
| ENC-02 | 9/9 | ADM-UX-01 140 | combined 2 suites / 149 | 0 | [tester.md#L7831](tester.md#L7831) |
| ENC-03 | 10/10 | ADM-UX-06 2 suites / 148 | — | 0 | [tester.md#L7916](tester.md#L7916) |
| ENC-06 | 8/8 | ADM-UX-05 2 suites / 144 | — | 0 | [tester.md#L7875](tester.md#L7875) |
| ENC-07 | 22/22 | — | — | 0 | [tester.md#L7938](tester.md#L7938) |
| ENC-META-01 | 23/23 | — | — | 0 | [tester.md#L7955](tester.md#L7955) |

HEAD chung của cả 6 independent receipt: `7811298844450f373687c478d08d1edfa53ae124` (đọc từ từng receipt, không suy ra). **Tổng targeted = 110 test** (38+9+10+8+22+23) — con số này là **tổng của sáu suite khác nhau ở sáu package/scope khác nhau**, tuyệt đối không cộng vào bất kỳ aggregate nào khác (cùng loại bẫy đã ghi ở cycle 12).

### 26.3 Δ

- **Δ-A33-1:** plan file báo số ENC-01 khác receipt gốc (46/46 + 20 suites/412 vs **38/38 + 18 suites/423**; "7 schemas" vs **6+2 constant, 196 dòng**). Giả thuyết: plan là snapshot trước 2 refine cuối của chunk manifest. **Nguồn chuẩn của inventory là receipt.** Owner của plan nên đồng bộ lại — không phải việc của lane này (ngoài `docs/**`).
- **Δ-A33-2:** ENC-03 và ENC-06 **không có owner receipt trên file** — chỉ có dispatch id + msg id trong plan, trong khi ENC-01/02/07/META-01 đều có mục receipt đọc được. Bằng chứng *thực thi* thì đủ, audit trail *ai-viet-gi* thì thiếu. Nên yêu cầu Codex Worker 1 ghi receipt vào `coordination/reports/` như các lane khác.
- **Δ-A33-3:** `qwen-platform.md` heading 16/17 dịch 1 dòng trong lúc cycle chạy. Link checker **không** bắt được (chỉ kiểm `1 <= n <= lineCount`); chỉ content assertion mới bắt. Giữ nguyên quy tắc đã đề xuất ở Δ-A31-3: **inbound anchor nên trỏ heading theo tên, không theo số dòng** — nếu không thì mỗi cycle phải trả thuế re-verify.

### 26.4 Lỗi của chính lane trong cycle

1. **Append EOL sai trên docs/28** — dùng CRLF cho một file LF thuần, tạo 3 CRLF lẫn. Bắt qua census sau khi ghi (không phải qua guard trước ghi — đây là bài học: **census EOL phải chạy ngay TRƯỚC khi quyết định dùng separator nào**, chứ không chạy sau). Đã sửa về 0 CRLF, byte −3.
2. **Anchor lấy từ grep rồi tin là đúng** — `MINE_ANCHOR_FAILS=2` (1555, 1668) vì file dịch giữa lúc grep và lúc verify. Đã re-derive theo nội dung và sửa; chạy lại → `0/16`. Đây là bản thứ ba của cùng lớp lỗi (cycle 19 `#L1660`, cycle 22 `#L1643`).
3. **Số liệu plan suýt được chép thẳng** vào inventory — chỉ chặn được vì tôi đọc receipt gốc thay vì tin HTML comment trong plan file. Đây chính là lý do packet yêu cầu "all citations verified".
4. **Sáu link trong Muc 26 dùng sai đường dẫn — phạm lại nguyên lỗi Mục 7.** Tôi viết `](../coordination/reports/tester.md#L…)` trong khi `qwen-docs.md` **nằm trong** `coordination/reports/`, nên nó resolve thành `coordination/coordination/reports/tester.md`. `BROKEN=7` (S1) và `BROKEN=9` toàn cây, exit 1. Sửa thành link anh em `](tester.md#L…)`. **Mục 7 (dòng 754) đã ghi đúng nguyên văn lỗi này vào lịch sử** — tôi phạm lại một lỗi mà chính report của tôi đã ghi tên từ 17 cycle trước, và lần này nó chỉ lộ ra *sau khi* tôi đã ghi receipt xuống đĩa — đúng thứ Mục 7 dặn phải kiểm **trước** khi ghi.
5. **Anchor `qwen-admin.md#L2760` trượt** (Admin lane ghi thêm giữa lúc tôi grep và lúc verify) → re-derive ra **L2777**, sửa. Tổng cộng **3 anchor trượt trong cycle này**, tất cả đều do lane khác ghi file giữa lúc đo và lúc kiểm.
6. **Repoint inbound anchor lần thứ tư:** link `qwen-docs.md#L1646` trong docs/28:678 + docs/35:839 trỏ lệch 2 dòng (Muc 16 heading thật ở **L1648**) sau khi chèn ledger 26 — vẫn nằm trong range nên `BROKEN=0` **không thấy**. Đã sửa và verify bằng content. Δ-A31-3 (anchor nên trỏ tên heading thay vì số dòng) giờ có bằng chứng thứ ba.

### 26.5 Trạng thái

**Sáu packet: VERIFIED-OFFLINE, đồng bộ vào inventory.** Không packet nào được tick `[x]`. `G-ENC` **NO-GO**, `G6` **NO-GO**, 4 gate cũ giữ nguyên NO-GO, 52 dòng release-scope không đổi. `ENC-00` vẫn `[~]` là decision gate, nên theo chính plan: chưa freeze thì chưa được coi là contract. Không sửa code/test, không commit/push (HEAD `7811298`).

## 27 — CYCLE 27: D-EVID-A22 — ENC-08 Admin crypto config (35/35 offline) vao docs/28 8.25 + docs/35 12.27

> [!IMPORTANT]
> **RESUME POINT — cycle 27 (lane Qwen-Docs, dispatch ctx_2df82a8020aa, task_29082f28e469).**
> 1. ENC-08 = Admin UI + API crypto configuration. **Hai** receipt: owner [Muc 23](qwen-admin.md#L2888) (Qwen Admin, 35/35 ×3, moi lan RUN1/2/3_EXIT_0) + **independent** [T-CODEX-OFFLINE-ENC-08-INDEPENDENT](tester.md#L7972) (Codex Tester Offline, 35/35 ExitCode 0 + tsc exit 0). HEAD ca hai: `7811298844450f373687c478d08d1edfa53ae124`.
> 2. **Khong phai tick.** Task row ENC-08 giu nguyen [`[ ]`]: acceptance la **browser E2E** chung minh save/reload/rotate/revoke + response mode that su doi, ma chua co. Owner viet thang: **ENC-08 khong the ACCEPTED cho toi khi route that ton tai** (D97).
> 3. **Bon khoang cach** ma receipt tu ghi: D97 chua co route HTTP (server.ts/shell-router.ts ngoai pham vi); D98 store la port chua co bang + CAS; D99 chua noi ENC-07 (toggle luu nhung delivery doc policy tu ServerConfig nen bat toggle chua doi hanh vi that); chua co browser E2E. Owner tu goi: **be mat quan tri, chua la don can**.
> 4. **Packet chi dinh 8.24/12.26 nhung hai muc do da bi cycle 26 (D-EVID-A21) chiem** — ENC-01/02/03/06/07 + ENC-META-01. ENC-08 vay vao **8.25 / 12.27** — ghi D-A34-1, khong de trung muc.
> 5. **Link checker: 3 lan lien tiep, ca 3 ExitCode 0.** S0 951/591 BROKEN=0 MISMATCH=0 GATE=0; S1 978/617 BROKEN=0 MISMATCH=0; TREE 189 file BROKEN=2 (2 pre-existing Antigravity, giu nguyen co y dich). `MINE_ANCHOR_FAILS=0/2` (content assertion) + verify rieng muc 16 sau khi repoint: link `qwen-docs.md#L1649` trong docs/28 + docs/35 **dung** tro vao heading, khong chi nam trong range.
> 6. **LOI CUA CHINH TOI: 2 link trong fragment docs/28 dung duong dan sai** — thieu tien to `../coordination/reports/`, toi viet `](qwen-admin.md#L2888)` tu cach file nam trong docs/ nen resolve fail. BROKEN=2 (S0 + S1) + 4 toan cay, exit 1; sua lai, chay lai xanh. **Day la lan THU HAI trong 3 cycle lien tiep, sau Muc 26** — va Muc 7 (cycle 7) da ghi tung lop loi nay tu 17 cycle truoc. Cong cu bat duoc, nhung **ca hai lan deu la loi nguoi va deu lo ra SAU khi da ghi xuong dia** — dung thu Muc 7 dan phai kiem TRUOC khi ghi.
> 7. EOL tu chon theo census **truoc** khi append (fix lai loi cycle 26): docs/28 dung LF thuan, docs/35 dung CRLF. Post-write: docs/28 0 CRLF, docs/35 891 CRLF / 18 bare LF — khong lan CRLF nao vao file LF.
> 8. Version bump `1.35.0` → `1.36.0` ca hai file, **cung do dai nen byte delta 0**, khong dich dong nao.
> 9. **Khong gate nao doi.** G-ENC NO-GO, G6 NO-GO, ENC-00 van [`[~]`]. Khong tick task row, khong commit/push (HEAD 7811298).

### 27.1 Hai section

- **docs/28 8.25** — bang 3 muc (owner / independent / ba tang) + bon khoang cach + **ba quyet dinh fail-closed** (pin hong hien canh bao chu khong bo qua am tham; ref ngoai allowlist 422; bat delivery khi chua co key 409 luc cau hinh chu khong luu roi de ENC-07 tra 503) + **3 loi owner tu sua trong source cua chinh minh**.
- **docs/35 12.27** — bang 4 tieu chi acceptance cua task row, doi chieu dat/chua, ket luan **task row giu [`[ ]`]** va khong gate nao doi.

### 27.2 So da doc truc tiep (khong chep plan file)

| Nguon | Noi dung |
|---|---|
| [Muc 23 owner](qwen-admin.md#L2888) | 35/35 ×3 RUN1/2/3_EXIT_0; tsc exit 0; full sweep 1912 pass / 28 skip / 1 fail (do la D92, khong lien quan); 6 describe = 6 dieu kien task row; CSRF dung `deriveCsrfToken` **that**; 4 file moi trong `src/app/admin/**` |
| [T-CODEX-OFFLINE-ENC-08-INDEPENDENT](tester.md#L7972) | 1 suite / **35 tests**, 0 failed, 0 skipped; tsc --noEmit exit 0; **khong claim live service, khong claim external infrastructure** |

**So 35/35 khong cong vao aggregate nao khac** — no la mot suite rieng cua mot packet, dung convention da ghi o cycle 12. Full sweep cua owner (1912/1941) la **cua lane Admin**, khong phai cua docs lane va khong phai cua ENC-08.

### 27.3 D

- **D-A34-1 (packet stale):** packet chi 8.24/12.26, ca hai muc do da bi cycle 26 (D-EVID-A21) chiem. ENC-08 ghi vao **8.25 / 12.27**. Khong de trung muc, khong ghi de muc cua cycle truoc.
- **D-A34-2:** ENC-08 co **ca hai** receipt (owner + independent) — khac 8.24/12.26, noi D97/D98/D99 la **nhat lieu rieng** cua Muc 23, chua duoc tach ra thanh dong task. Neu coordinator muon tick row, phai co browser E2E truoc; day la quyet dinh cua coordinator, khong phai lane.
- **D-A34-3 (tiep tuc D-A31-3):** inbound anchor van tro bang **so dong**. Cycle nay **khong** gap anchor trung (2 anchor moi kiem dung ngay), nhung tai day hai report dich dong giua luc grep va luc verify (da gap o cycle 26). Neu khong doi quy uoc thi moi cycle lai tra thue re-derive.

### 27.4 Loi cua chinh toi

1. **2 link sai duong dan** trong fragment docs/28 — thieu tien to `../coordination/reports/`. BROKEN=2 (S0/S1) + 4 toan cay, exit 1; sua va chay lai xanh. **Lan thu hai trong ba cycle** (Muc 26 gap 7 link trong chinh report nay), va Muc 7 da ghi lop nay tu 17 cycle truoc. **Cong cu bat duoc mot lan nua, nhung loi van la cua toi va van lo ra sau khi ghi.**
2. Ba lan viet fragment bang JS template literal gap escape (backtick trong code span) — mat ba round, chuyen sang Python/charCode. Khong loi ghi artifact, nhung ton thoi gian.

### 27.5 Trang thai

**ENC-08: offline VERIFIED, da dong bo vao inventory.** **Khong ACCEPTED** — task row giu [`[ ]`]. G-ENC NO-GO, G6 NO-GO, ENC-00 van [`[~]`]. Khong tick dong task nao, khong commit/push.

## 28 — CYCLE 28: D-EVID-A23 — ADM-UX-03 (79/79) + ADM-UX-04 (142/142) vao docs/28 8.26 + docs/35 12.28

> [!IMPORTANT]
> **RESUME POINT — cycle 28 (lane Qwen-Docs, dispatch ctx_504fad240671, task_f208b8940569).**
> 1. Hai task Admin UX, **ca hai** co independent receipt cua Codex Tester Offline voi literal `ExitCode 0`: ADM-UX-03 **79/79** (2 suites: 47 sort-wiring + 32 HTTP-wire, [tester.md#L8031](tester.md#L8031)) va ADM-UX-04 **142/142** (2 suites, [tester.md#L8014](tester.md#L8014)). `tsc --noEmit` exit 0 cho ca hai. HEAD chung ``7811298844450f373687c478d08d1edfa53ae124`.
> 2. **Khong tick row nao.** Ca hai giu ``[~]``: ADM-UX-03 con browser C1–C5 + live data (ADM-UX-07); ADM-UX-04 con aggregate connector-health endpoint that + browser E2E. Ca hai tro ve **cung mot noi: ADM-UX-07**.
> 3. **79 + 142 = 221 KHONG phai mot aggregate** — hai suite cua hai packet khac, dung convention cycle 12 va lap lai o 8.25.
> 4. EOL chon theo census **truoc** khi append; docs/28 LF thuan (post 0 CRLF), docs/35 CRLF (908/18). **Resolve link ngay trong chinh apply script** (Muc 26 gap 7 link, Muc 27 gap 2 link) — lan nay **0 link BROKEN ngay tu dong**.
> 5. **Link check x3 lien tiep, ca 3 ExitCode 0.** S0 953/598 BROKEN=0 MISMATCH=0 GATE=0; S1 986/625 BROKEN=0 MISMATCH=0; TREE 189 file BROKEN=2 (2 pre-existing Antigravity, giu nguyen co y dich). `MINE_ANCHOR_FAILS=0/4` (content assertion) + verify muc 16 sau repoint: link ``qwen-docs.md#L1650` trong docs/28 + docs/35 **dung** tro vao heading. Version bump ``1.36.0` — ``1.37.0`` ca hai file, byte delta 0.
> 6. **Khong gate nao doi.** ``G-ADMIN-OPS`` NO-GO, ``G6`` NO-GO, 52 dong khong doi. Khong tick task row, khong commit/push.

### 28.1 Bang chung (doc truc tiep tu receipt, khong chep plan row)

| Packet | Independent receipt | Targeted | tsc | Giu ``[~]`` vi |
|---|---|---|---|---|
| ADM-UX-03 toolbar sort + offline HTTP sort | [T-CODEX-OFFLINE-ADM-UX-03-INDEPENDENT](tester.md#L8031) | **79/79**, 2 suites, 0 failed, 0 skipped | 0 | browser C1–C5 + live data tai ADM-UX-07 |
| ADM-UX-04 Overview triage | [T-CODEX-OFFLINE-ADM-UX-04-INDEPENDENT](tester.md#L8014) | **142/142**, 2 suites, 0 failed, 0 skipped | 0, "no diagnostics reported" | chua co aggregate connector-health endpoint that; browser E2E |

**ADM-UX-03 — co pin HTTP-wire, khong chi unit.** Suite thu hai mount route handler that len loopback `node:http` + `createAdminShellServer` that: cross-sort cursor tra 422 `problem+json` voi **0 page query**, cursor cu 2-slot van phan trang theo thu tu mac dinh, doi sort phai xoa cursor (T140-A1), tenant-scope khong ro id tenant khac. Day la bang chung **offline tren wire that** — khong phai live PostgreSQL.

**ADM-UX-04 — mot chi tiet ve do trung thuc:** connector health **hien unavailable** vi platform chua co aggregate endpoint, va empty audit page **khong** bi coi la healthy zero. Cung loai voi chuyen task row cam.

### 28.2 Hai section

- **docs/28 8.26** — bang 2 packet (receipt, targeted, tsc, ly do giu ``[~]``) + ghi ro khong cong so + chi tiet HTTP-wire cua ADM-UX-03 + chi tiet trung thuc cua ADM-UX-04.
- **docs/35 12.28** — bang "dat offline / con thieu" theo tung row, ket luan **ca hai tro ve ADM-UX-07**, va nhanh ro khong suy ra 2/8 task G-ADMIN-OPS.

### 28.3 Loi cua chinh toi

1. **Khong co loi ghi artifact trong cycle nay** — fragment viet duong dan **day du** `../coordination/reports/tester.md` ngay tu dau cho docs, va apply script **resolve tung link moi** truoc khi ket thuc, nen **0 link BROKEN ngay tu dong** so voi Muc 26 (7 link) va Muc 27 (2 link) — hai lan lien tiep khong lap lai loi da bi ghi ten.
2. **Guard trong receipt script bat duoc 4 link sai cua chinh muc 28 TRUOC khi ghi** — fragment muc 28 viet duong dan theo quy uoc cua docs, nhung muc 28 nam trong `coordination/reports/` nen phai la **duong dan anh em**. Script tu check truoc khi ghi va abort, toi sua fragment roi chay lai. Day la lan dau guard chay **truo c khi ghi** thay vi sau; Muc 7/26/27 deu la loi duoc link checker lo ra sau khi da nam xuong dia.

## 29 — CYCLE 29: D-EVID-A24 — ENC-08 wiring (56/56) vao docs/28 8.27 + docs/35 12.29

> [!IMPORTANT]
> **RESUME POINT — cycle 29 (lane Qwen-Docs, dispatch ctx_e18b990733e8, task_251d834a32c1).**
> 1. ENC-08 wiring: owner [Muc 24](qwen-admin.md#L3013) **56/56 ×3** `RUN1/2/3_EXIT_0` + **independent** [T-CODEX-OFFLINE-ENC-08-WIRING-INDEPENDENT](tester.md#L8067) **56/56 ExitCode 0** + tsc 0. HEAD chung ``7811298844450f373687c478d08d1edfa53ae124`.
> 2. **D97 DONG o muc code + offline** (route that + shell pane that). **D98 va D99 VAN MO** — store in-memory mat khi restart; toggle luu vao store con delivery doc `ServerConfig` nen **bat toggle chua doi hanh vi giao that**. Task row ENC-08 giu `[~]`, **khong tick**.
> 3. **Khong conflation:** 8.25 ghi 35/35 core config, cycle nay ghi **them 21** wiring. **56 khong phai 35 + 21 cong lai mot lan.**
> 4. **Ghi lai mot lo hong chinh owner — route lay role tu header `x-admin-role` ma caller tu set, sua sang claims cookie da verify (D104), test khoa bang chung cu the.** Day la lo bi test bat truoc khi den tai lieu, nguoc lai muc 8.25 noi 4 khoang cach gap duoc ghi bang chung.
> 5. **Ba lan lien tiep khong lap lai loi link** (Muc 26 gap 7, Muc 27 gap 2, Muc 28 gap 0) — lan nay resolve + content-assert **trong chinh apply script, truoc khi ghi**.
> 6. **Khong gate nao doi.** `G-ENC` NO-GO, `G6` NO-GO, 52 dong khong doi. Khong tick task row, khong commit/push.

### 29.1 Bang chung (doc truc tiep tu ca hai receipt)

| Nguon | Noi dung |
|---|---|
| [Owner Muc 24](qwen-admin.md#L3013) | 56/56 ×3 + tsc 0; **21 test moi** trong `admin-crypto-config-wiring.test.ts` (3 describe, 392 dong); sua `src/server.ts` + `src/app/admin/shell-router.ts` |
| [Independent](tester.md#L8067) | 2 suites / **56 tests**, 0 failed, 0 skipped; tsc --noEmit exit 0; **khong claim live service, khong claim external infrastructure** |

**Chi tiet dang giu vi la bang chung chu khong phai mo ta:** registry lay mac dinh tu `deliveryEncryption.recipientKeyRegistry` cua ENC-07 — **mot nguon key**; build view model **mot lan trong `createApp`** chu khong phai moi request; sai kieu field — 422 **truoc khi cham store**; khong co resolver — pane loi `CRYPTO_CONFIG_NOT_WIRED` **khong phai trang trang**; resolver nem — `CRYPTO_CONFIG_UNAVAILABLE`, khong ro message loi ra HTML.

**Hai delta moi ghi cong khai, giu lai:** D105 (CSRF chi ap dung cho tenant-operator bearer — mot browser giu platform bearer cung qua duoc, can xac nhan cau hinh trien khai) va D106 (`cryptoConfigPane` chua duoc composition root cau hinh — production se thay error pane cho toi khi wire tiep).

### 29.2 Hai section

- **docs/28 8.27** — bang route + shell pane, lo hong D104 cua chinh owner, **ba delta con mo** (D97 dong / D98 / D99), hai delta moi (D105/D106), va canh bao khong conflation voi 8.25.
- **docs/35 12.29** — bang "trang thai sau cycle nay" theo tung tieu chi acceptance: D97 da dong, D98 chua, D99 chua, browser E2E chua — va ket luan task row van `[~]`.

### 29.3 Loi cua chinh toi

**Khong co loi ghi artifact trong cycle nay.** Ba lan lien tiep (26, 27, 28, 29) bao cao link hong duoc ghi xuong dia truoc khi kiem — **ba lan dau tien la muc 28**, va muc nay giu nguyen. Fragment viet duong dan day du cho docs, guard trong receipt script chuyen sang **duong dan anh em** truoc khi ghi, EOL census truoc khi append. Moi guard bat loi ngay o tang ghi chu khong de link checker lo ra sau.

## 30 — CYCLE 30: D-EVID-A25 — ENC-05 va ENC-04 vao docs/28 8.28 + docs/35 12.30

> [!IMPORTANT]
> **RESUME POINT — cycle 30 (lane Qwen-Docs, task_3e5c1c4df2ee).**
> 1. **Phat hien lon nhat cua cycle: so trong packet khong dung receipt nao.** Packet ghi ENC-05 la “41/41 pass, tsc clean, T-CODEX-OFFLINE-ENC-05-INDEPENDENT”. Receipt mang **ten** do (tester.md:8084) ghi **8/8 va typecheck FAIL exit 1**. Con so `41/41 + tsc clean` nam o **receipt khac** (tester.md:8102, tieu de chi `ENC-05`). **Ba receipt ENC-05 trong tester.md** (8048 / 8084 / 8102), khong phai mot.
> 2. **Tsc cua ENC-05 la chuoi ba buoc va chi buoc cuoi xanh:** 03:23 FAIL (TS2367, file khac) — 03:35 FAIL (TS7006, cung file khac) — 03:37 PASS. Ca hai lan FAIL deu **ngoai pham vi ENC-05** va deu do `legacy-payload-migration.ts` cua lane khac; buoc cuoi xanh vi migration branch duoc narrow, khong phai vi ENC-05 sua gi.
> 3. **8/8 khong phai mau do cua 41/41** — receipt “INDEPENDENT” chay **mot** suite, khong kem `multipart-routes-offline.test.ts`. **Khong ton tai mot receipt independent 41/41** trong cay.
> 4. **ENC-04 (Qwen Platform Muc 19, worker-sdk):** 14/14 + tsc 0 tai [tester.md:8120]. **File suite THAT la `crypto-seam.test.ts`, khong phai `crypto-storage-seam.test.ts` nhu packet goi** — tester chay “No tests found” roi chay suite tuong duong va ghi ro khong claim cho path khong ton tai.
> 5. **Khong cong so:** 41 + 14 = 55 la **hai package khac nhau** (orchestrator vs worker-sdk), khong phai aggregate. 8 khong cong them vao 41.
> 6. **Khong gate nao doi.** ENC-05/ENC-04 van `[ ]`; G-ENC NO-GO, G6 NO-GO, 52 dong khong doi. Khong tick, khong commit/push.
> 7. Link check + guard: xac nhan o 30.3. Lien tiep 5 cycle (26/27 gap 7+2, 28/29/30 gap 0).

### 30.1 Bang chung duoc ghi lai tu receipt (khong dung lai con so packet)

| Receipt | Tests | tsc | Ghi chu |
|---|---|---|---|
| [tester.md:8048](tester.md#L8048) ENC-05 (03:23:33) | 41/41, 2 suites | FAIL exit 1 | TS2367 tai `legacy-payload-migration.ts:396`, ngoai pham vi ENC-05 |
| [tester.md:8084](tester.md#L8084) T-CODEX-OFFLINE-ENC-05-INDEPENDENT (03:35:02) | 8/8, 1 suite | FAIL exit 1 | TS7006 tai `legacy-payload-migration.ts:125`, cung file, cung ngoai pham vi |
| [tester.md:8102](tester.md#L8102) ENC-05 (03:37:00) | 41/41, 2 suites | PASS exit 0 | chay bang `node .../tsc --noEmit -p services/orchestrator/tsconfig.json` |
| [tester.md:8120](tester.md#L8120) T-CODEX-OFFLINE-ENC-04-SEAM-INDEPENDENT (03:38:51) | 14/14, 1 suite | PASS exit 0 | file suite that la `crypto-seam.test.ts` |
| [qwen-platform.md:1844](qwen-platform.md#L1844) Muc 19 (owner ENC-04) | 14 test, `tests/crypto-seam.test.ts` 248 dong | tsc 0 | `src/crypto-storage.ts` 910 dong la port trung thuc, script copy + patch import |

**Dinh nghia 41/41 + tsc clean ma packet ghi khong ton tai trong cay.** Mot nguoi lam theo packet se mo ID T-CODEX-OFFLINE-ENC-05-INDEPENDENT, thay 8/8 va typecheck do, va ket luan sai. **Day la lo receipt “gop nhom” (receipt-conflation)** — khac voi lo “so ke o muc ke la sai so o muc” (D-A33-1 cycle 26): day la **ca ID va ca so deu sai**.

### 30.2 Hai section

- **docs/28 8.28** — bang 3 receipt ENC-05 voi trang thai tsc tung buoc + giai thich 41 = 8 + 33 nhung chi mot receipt chay duoc 41 **va** cung luc do tsc xanh; bang ENC-04 + ghi chi tiet port trung thuc.
- **docs/35 12.30** — bang “trang thai THAT tu receipt / con thieu” + hai dieu “khong ton tai” (receipt independent 41/41, va file suite `crypto-seam.test.ts` khong phai `crypto-storage-seam.test.ts`).

### 30.3 Loi cua chinh toi

1. **Mot typo trong fragment** — viet 41/65 thay vi 41/41 o 12.30; bat duoc bang grep ngay khi viet fragment, **truoc khi ghi vao docs**. Khong con gi o tren dia.
2. **Khong loi ghi artifact.** Resolve + anchor-range check chay trong chinh apply script (5 link docs/28 + 1 link docs/35, tat ca resolved + in-range), content-assert 5/5 (4 tester.md + 1 qwen-platform.md) sau khi ghi. 5 cycle lien tiep khong con link hong ghi xuong dia.

## 30 — CYCLE 30: D-EVID-A25 — ENC-05 va ENC-04 vao docs/28 8.28 + docs/35 12.30

> [!IMPORTANT]
> **RESUME POINT — cycle 30 (lane Qwen-Docs, task_3e5c1c4df2ee).**
> 1. **Phat hien lon nhat cua cycle: so trong packet khong dung receipt nao.** Packet ghi ENC-05 la “41/41 pass, tsc clean, T-CODEX-OFFLINE-ENC-05-INDEPENDENT”. Receipt mang **ten** do (tester.md:8084) ghi **8/8 va typecheck FAIL exit 1**. Con so `41/41 + tsc clean` nam o **receipt khac** (tester.md:8102, tieu de chi `ENC-05`). **Ba receipt ENC-05 trong tester.md** (8048 / 8084 / 8102), khong phai mot.
> 2. **Tsc cua ENC-05 la chuoi ba buoc va chi buoc cuoi xanh:** 03:23 FAIL (TS2367, file khac) — 03:35 FAIL (TS7006, cung file khac) — 03:37 PASS. Ca hai lan FAIL deu **ngoai pham vi ENC-05** va deu do `legacy-payload-migration.ts` cua lane khac; buoc cuoi xanh vi migration branch duoc narrow, khong phai vi ENC-05 sua gi.
> 3. **8/8 khong phai mau do cua 41/41** — receipt “INDEPENDENT” chay **mot** suite, khong kem `multipart-routes-offline.test.ts`. **Khong ton tai mot receipt independent 41/41** trong cay.
> 4. **ENC-04 (Qwen Platform Muc 19, worker-sdk):** 14/14 + tsc 0 tai [tester.md:8120]. **File suite THAT la `crypto-seam.test.ts`, khong phai `crypto-storage-seam.test.ts` nhu packet goi** — tester chay “No tests found” roi chay suite tuong duong va ghi ro khong claim cho path khong ton tai.
> 5. **Khong cong so:** 41 + 14 = 55 la **hai package khac nhau** (orchestrator vs worker-sdk), khong phai aggregate. 8 khong cong them vao 41.
> 6. **Khong gate nao doi.** ENC-05/ENC-04 van `[ ]`; G-ENC NO-GO, G6 NO-GO, 52 dong khong doi. Khong tick, khong commit/push.
> 7. Link check + guard: xac nhan o 30.3. Lien tiep 5 cycle (26/27 gap 7+2, 28/29/30 gap 0).

### 30.1 Bang chung duoc ghi lai tu receipt (khong dung lai con so packet)

| Receipt | Tests | tsc | Ghi chu |
|---|---|---|---|
| [tester.md:8048](tester.md#L8048) ENC-05 (03:23:33) | 41/41, 2 suites | FAIL exit 1 | TS2367 tai `legacy-payload-migration.ts:396`, ngoai pham vi ENC-05 |
| [tester.md:8084](tester.md#L8084) T-CODEX-OFFLINE-ENC-05-INDEPENDENT (03:35:02) | 8/8, 1 suite | FAIL exit 1 | TS7006 tai `legacy-payload-migration.ts:125`, cung file, cung ngoai pham vi |
| [tester.md:8102](tester.md#L8102) ENC-05 (03:37:00) | 41/41, 2 suites | PASS exit 0 | chay bang `node .../tsc --noEmit -p services/orchestrator/tsconfig.json` |
| [tester.md:8120](tester.md#L8120) T-CODEX-OFFLINE-ENC-04-SEAM-INDEPENDENT (03:38:51) | 14/14, 1 suite | PASS exit 0 | file suite that la `crypto-seam.test.ts` |
| [qwen-platform.md:1844](qwen-platform.md#L1844) Muc 19 (owner ENC-04) | 14 test, `tests/crypto-seam.test.ts` 248 dong | tsc 0 | `src/crypto-storage.ts` 910 dong la port trung thuc, script copy + patch import |

**Dinh nghia 41/41 + tsc clean ma packet ghi khong ton tai trong cay.** Mot nguoi lam theo packet se mo ID T-CODEX-OFFLINE-ENC-05-INDEPENDENT, thay 8/8 va typecheck do, va ket luan sai. **Day la lo receipt “gop nhom” (receipt-conflation)** — khac voi lo “so ke o muc ke la sai so o muc” (D-A33-1 cycle 26): day la **ca ID va ca so deu sai**.

### 30.2 Hai section

- **docs/28 8.28** — bang 3 receipt ENC-05 voi trang thai tsc tung buoc + giai thich 41 = 8 + 33 nhung chi mot receipt chay duoc 41 **va** cung luc do tsc xanh; bang ENC-04 + ghi chi tiet port trung thuc.
- **docs/35 12.30** — bang “trang thai THAT tu receipt / con thieu” + hai dieu “khong ton tai” (receipt independent 41/41, va file suite `crypto-seam.test.ts` khong phai `crypto-storage-seam.test.ts`).

### 30.3 Loi cua chinh toi

1. **Mot typo trong fragment** — viet 41/65 thay vi 41/41 o 12.30; bat duoc bang grep ngay khi viet fragment, **truoc khi ghi vao docs**. Khong con gi o tren dia.
2. **Khong loi ghi artifact.** Resolve + anchor-range check chay trong chinh apply script (5 link docs/28 + 1 link docs/35, tat ca resolved + in-range), content-assert 5/5 (4 tester.md + 1 qwen-platform.md) sau khi ghi. 5 cycle lien tiep khong con link hong ghi xuong dia.

## 31 — CYCLE 31: D-EVID-A25 tiep tuc — receipt thu 4 cua ENC-05 (T-CODEX-OFFLINE-ENC-05-REVAL) vao 8.28 + 12.30

> [!IMPORTANT]
> **RESUME POINT — cycle 31 (lane Qwen-Docs, task_3e5c1c4df2ee).** Muc 30 da ghi 3 receipt ENC-05; cycle nay nap **receipt thu 4** vua xuat hien trong tester.md.
> 1. **Tester vua append them 1 receipt ENC-05 nua** (tester.md 03:54): [T-CODEX-OFFLINE-ENC-05-REVAL](tester.md#L8157) (03:43:36) — **41/41**, 2 suites, `tsc --noEmit` **PASS exit 0**, `no diagnostics reported`. Day la lan revalidation doc lap, va la receipt **duy nhat** vua co ca **41/41** vua co **tsc xanh**.
> 2. **Tsc cua ENC-05 chay 4 buoc, chi buoc cuoi xanh:** 03:23 FAIL (TS2367) — 03:35 FAIL (TS7006) — 03:37 PASS — 03:43 PASS. **Ca hai lan FAIL deu do diagnostic cua file khac** (`legacy-payload-migration.ts`, ngoai pham vi ENC-05) — buoc 3/4 xanh **vi migration branch duoc narrow**, khong phai vi ENC-05 sua gi.
> 3. **Van khong ton tai receipt independent 41/65** — receipt mang ten “INDEPENDENT” (tester.md:8084) chay **1 suite** va **tsc FAIL**. So 41 + tsc clean nam o hai receipt **khong mang ten independent**. Dinh nghia ma packet ghi khong ton tai trong cay.
> 4. **ENC-04 ghi nguyen o Muc 30** (14/14, `crypto-seam.test.ts`, khong phai `crypto-storage-seam.test.ts` nhu packet goi).
> 5. Bai hoc Muc 30 **van dung nguyen**: cap nhat section tai cho (thay section, khong append them) + **head byte-identical**, va content-assert chay TRUOC khi bump version.
> 6. **Khong gate nao doi.** ENC-05/ENC-04 van `[ ]`; G-ENC NO-GO, G6 NO-GO, 52 dong khong doi. Khong tick, khong commit/push.

### 31.1 Receipt thu 4 — dong vao bang 8.28

| Receipt | Tests | tsc | Ghi chu |
|---|---|---|---|
| [tester.md:8048](tester.md#L8048) ENC-05 (03:23:33) | 41/41, 2 suites | FAIL exit 1 | TS2367 tai `legacy-payload-migration.ts:396` |
| [tester.md:8084](tester.md#L8084) T-CODEX-OFFLINE-ENC-05-INDEPENDENT (03:35:02) | 8/8, 1 suite | FAIL exit 1 | TS7006 tai `legacy-payload-migration.ts:125` |
| [tester.md:8102](tester.md#L8102) ENC-05 (03:37:00) | 41/41, 2 suites | PASS exit 0 | chay bang `node .../tsc --noEmit -p services/orchestrator/tsconfig.json` |
| [tester.md:8157](tester.md#L8157) T-CODEX-OFFLINE-ENC-05-REVAL (03:43:36) | 41/41, 2 suites | **PASS exit 0** | revalidation doc lap; `no diagnostics reported` |

**Y nghia cua receipt thu 4:** no khong them mot lane moi hay mot test moi — no xac nhan lai **cung mot trang thai** da xanh o buoc 03:37, bang mot lenh chay khac wrapper. Gia tri cua no: **bao chung tiep** rang trang thai do khong phai loi nhat va mot receipt duy nhat. Nhung no khong sua gi o 8.28/12.30 ngoai muc “bon receipt” va “chuoi bon buoc”.

### 31.2 Loi cua chinh toi

1. **Mot loi tail-EOL trong chinh section 12.30 cua toi** — dong cuoi duoc viet bang LF cung co, nen section do co 1 bare LF lap trong mot file CRLF-dominant. Bat duoc ngay bang script kiem EOL sau khi ghi, sua thanh CRLF. **18 bare LF con lai thuoc ve `12.26` (cycle 26), khong phai cua cycle nay** — da kiem va ghi nhan, khong sua (khong phai pham vi, va Muc 26 la cua lane nay nen bao cao chu khong ghi de nham).
2. **Mot typo “41/65” lan nua trong fragment 12.30 v2** (copy nhanh tu ban cu) — bat bang grep truoc khi ghi xuong docs, sua thanh “41/41”. Day la lan **hai** cua cung loi trong mot cycle.
3. Khong loi link trong cycle nay — 6/6 link cua section 8.28 va 1/1 cua 12.30 deu resolve + in-range **truoc khi ghi**; `MINE_ANCHOR_FAILS=0/6` sau khi ghi. 6 cycle lien tiep khong con link hong ghi xuong dia.

## 32 — CYCLE 32: D-EVID-A26 — ENC-08 (composition/persistence/wire) + ENC-09 vao 8.29 + 12.31; so 87/87 trong packet khong ton tai

> [!IMPORTANT]
> **RESUME POINT — cycle 32 (lane Qwen-Docs, task_b3b366795994, ctx_9c35c2d0213d).**
> 1. **TEN FILE TRONG PACKET KHONG TON TAI.** Packet tro toi `docs/28-encryption-lifecycle.md` va `docs/35-operational-runbooks.md` — khong file nao co trong cay. Ghi vao file that: `docs/28-test-inventory.md` (8.29) + `docs/35-acceptance-baseline.md` (12.31). Runbooks la `docs/17-operational-runbooks.md` (so 17, khong phai 35). D-A36-1.
> 2. **SO 87/87 KHONG TON TAI O BAT KY RECEIPT NAO.** Independent thuc su cho ENC-08 wire la **71/71** ([tester.md#L8228](tester.md#L8228)). Grep toan cay theo 87/87 va 87 passed khong co ket qua nao. D-A36-2.
> 3. **77/77 va 79/79 co that, nhung khong phai independent** — chung la receipt verify/owner trong tester.md. Chi T-CODEX-OFFLINE-ENC-08-WIRE-INDEPENDENT la independent. D-A36-3.
> 4. **77, 79, 71 la BA tap suite khac nhau, khong phai mot chuoi tien.** 77 va 79 chay cung 4 suite (79 = 77 + 2 case store-selection); 71 chay 4 suite khac (thay `migrations-ledger-guard` bang `enc08-wire-enc07`). **71 khong phai it hon 79**, va cong 77+79+71 ra so vo nghia. D-A36-4.
> 5. **ENC-09 9/9 khop packet** [tester.md#L8193](tester.md#L8193) + tsc exit 0, va receipt ghi ro khong chay migration that nao (S3/PG/Redis/Vault).
> 6. **D98 / D106 lay trang thai moi nhung chua ACCEPTED:** store da co `PostgresCryptoConfigStore` + migration 0020 (chua apply that), composition root da nhan `Db` khi app co database. Khong receipt nao chay restart PostgreSQL that.
> 7. Version bump `1.40.0` — `1.41.0` byte delta 0. EOL census truoc khi append: docs/28 LF thuan, docs/35 CRLF (958/18).
> 8. **Khong gate nao doi.** ENC-08/ENC-09 van `[ ]`; G-ENC NO-GO, G6 NO-GO, 52 dong khong doi. Khong tick, khong commit/push.

### 32.1 Bang chung doc truc tiep

| Receipt | Tests | tsc | Loai |
|---|---|---|---|
| [tester.md#L8174](tester.md#L8174) ENC-08-PERSISTENCE (03:48:08) | **77/77**, 4 suites | 0 | verify/owner |
| [tester.md#L8210](tester.md#L8210) ENC-08-WIRE (03:58:01) | **79/79**, 4 suites | 0 | verify/owner |
| [tester.md#L8228](tester.md#L8228) T-CODEX-OFFLINE-ENC-08-WIRE-INDEPENDENT (04:06:14) | **71/71**, 4 suites | 0 | **independent** |
| [tester.md#L8139](tester.md#L8139) ENC-09 (03:43:04) | **9/9**, 1 suite | 0 | owner |
| [tester.md#L8193](tester.md#L8193) T-CODEX-OFFLINE-ENC-09-INDEPENDENT (03:54:27) | **9/9**, 1 suite | 0 | **independent** |

### 32.2 Loi cua chinh toi

1. **Mot ky tu thieu trong chinh guard cua toi** (sha docs/35 ghi 16 ky tu thay vi 15) — guard abort sau khi da ghi docs/28, nen docs/35 phai chay lai o vong rieng. Guard **lam viec dung chuc nang** (no chan mot lan ghi sai) nhung la loi go chinh tao.
2. **Mot loi doc file** (decode tren string) va mot loi thieu tham so errors khi tester.md co byte khong UTF-8 — ca hai deu bat truoc khi ghi.
3. Khong loi ghi artifact: 5 link cua 8.29 + 4 link cua 12.31 deu resolve + in-range truoc khi ghi; MINE_ANCHOR_FAILS=0/5 sau khi ghi. 7 cycle lien tiep khong con link hong ghi xuong dia.

## 33 — CYCLE 33: D-EVID-A27 — RESULT-WIRE-01 contract 200; docs/06 bo 302; va don 3 section trung con sot tu cycle 24

> [!IMPORTANT]
> **RESUME POINT — cycle 33 (lane Qwen-Docs, task_64d94a6d64d0, ctx_c7ae091a36c5).**
> 1. **TEN FILE TRONG PACKET KHONG TON TAI** (lan thu hai, xem D-A36-1 cycle 32): `docs/28-encryption-lifecycle.md` va `docs/35-operational-runbooks.md` khong co trong cay. Ghi vao `docs/28-test-inventory.md` (8.30) + `docs/35-acceptance-baseline.md` (12.32).
> 2. **CONTRACT DA DONG, va docs/06 CON GHI 302 DUA SUA** — `GET /artifacts/{id}/download` doi tu 302 short-lived signed URL sang **200 raw bytes (plain) / 200 JSON wrapper (encrypted)**; `GET /operations/{id}/result` chot **200 strict v1** o ca hai mode. Day chinh la scope note ma chinh receipt ghi: “docs/06-public-api.md still documents a 302 download”.
> 3. **CHUA CO INDEPENDENT RECEIPT TRONG CAY** (D-A37-3). Mot lan verify doc lap **co chay** (coordinator log: 64/64 = contracts 42/42 + delivery 22/22) nhung **khong append duoc** vao `tester.md` do byte 0x97 non-UTF8 lam hong file; `V-OFFLINE-RESULT-WIRE-01-REVAL` duoc re-dispatch nhung van khong co. **Tien do doc lap co, bieu bang chung thi chua.**
> 4. **BAI TOAN CON SOT TU CYCLE 24 DA DONG trong cycle nay:** docs/06, docs/07 va docs/11 deu con **section trung lap** (do double-apply cua cycle 24, dedup script do khi chay xong). Da xoa ban thu hai — docs/06 199->195 dong, docs/07 103->94, docs/11 63->49. D-A37-4.
> 5. EOL docs/06: khi ghi fragment, 11 bare LF lot vao file CRLF-dominant — bat duoc bang script kiem EOL ngay sau khi ghi, da chuan hoa lai **195 crlf / 0 bare LF** voi content byte-identical.
> 6. Version bump `1.41.0` — `1.42.0` byte delta 0 (docs/06 khong co header version — xac nhan lai, khong co gi de bump).
> 7. **Khong gate nao doi.** G-ENC NO-GO, G6 NO-GO, 52 dong khong doi. RESULT-WIRE-01 van `[~]`; ENC-08/ENC-09 van `[ ]`. Khong tick, khong commit/push.

### 33.1 Bang chung (doc truc tiep)

| Muc | Ket qua |
|---|---|
| [tester.md#L8245](tester.md#L8245) `RESULT-WIRE-01` (04:07:35 +07) | contracts build 0; contracts test **19 suites / 427 tests** 0; orchestrator `delivery-encryption.test.ts` **22/22** 0; `tsc --noEmit` 0 ca hai package |
| Fixture trong cung receipt | validate schema, noi artifact reference da giai ma, giai ma ben ngoai + **so byte** payload that |

### 33.2 Doi chieu docs/06 truoc/sau

| Site | Truoc | Sau |
|---|---|---|
| catalog `download` | 302 short-lived signed URL | 200 raw bytes + MIME (plain) / 200 JSON wrapper (encrypted) |
| catalog `/result` | 200 ResultEnvelope | 200 ResultEnvelope strict v1 (plain) / 200 JSON wrapper (encrypted) |
| muc `Result delivery encryption` | status: RESULT-WIRE-01 phai dong truoc ENC-01/07 | status: **DA DONG**, them muc `Frozen result/download response contract` |
| so ban cua muc do | **2** | **1** |

### 33.3 Loi cua chinh toi

1. **Mot lan ghi 11 bare LF** vao docs/06 (fragment LF join vao file CRLF) — bat ngay bang script kiem EOL **sau** khi ghi; chuan hoa lai CRLF voi assert content byte-identical. Day la lan thu hai trong hai cycle viet docs/06 (lan truoc o cycle 24 la double-apply; lan nay la EOL).
2. **Mot loi trong chinh matcher cua script** (so sanh chuoi co dau tieng Viet — chay fail-fast **truoc khi ghi docs/06**, nen khong co gi hong tren dia).
3. **Khong loi link**: 1 link cua 8.30 + 0 link cua 12.32; content-assert tester.md#L8245 **0/1 fail**. 8 cycle lien tiep khong con link hong ghi xuong dia.
4. **Section trung o docs/07 va docs/11 dung trong cycle nay** du cycle 24 da ghi la chua bao gio chay xong — muc 24.3 (noi “khong loi ghi artifact trong cycle nay”) **khong con dung sau su khi kiem lai: dedup script cycle 24 abort truoc khi ghi, va toi khong doc lai ket qua no. Muc nay la lan doc lai va sua that.

## 34 — CYCLE 34: D-EVID-A28 — LOG-01 + INGEST-WIRE-01 vao docs/19 + 28 8.31 + 35 12.33

> [!IMPORTANT]
> **RESUME POINT — cycle 34 (lane Qwen-Docs, task_3746a80a486f, ctx_2514fde5600c).**
> 1. **TEN FILE TRONG PACKET KHONG TON TAI** (lan thu ba, xem D-A36-1): `docs/28-encryption-lifecycle.md` va `docs/35-operational-runbooks.md` khong co trong cay. Ghi vao `docs/19-traceability-audit-matrix.md` (muc moi) + `docs/28-test-inventory.md` 8.31 + `docs/35-acceptance-baseline.md` 12.33. Runbooks la `docs/17-operational-runbooks.md` (so 17, khong phai 35).
> 2. **LOG-01** [tester.md#L8265] (04:23:14 +07): observability **23/23** + admin-error-boundary **21/21** + tsc 0 ca 2 package; `rg console.*` 0 match. **Khong co live deployment nao claim.**
> 3. **INGEST-WIRE-01** [Qwen Platform Muc 21](qwen-platform.md#L2016) (task_197417c12b31): document-core full **45 suites / 537 tests** Exit 0, targeted 88, tsc 0. **2 mutation probe (M1 hasBuffer->2 do, M2 bo artifacts->1 do)** — chung minh range **bi pin that**, restore byte-exact sha `8b43ce2c`.
> 4. **Con so “2 mutation tests pass” cua packet — doc dung phai la 2 probe DO (chung minh pin), KHONG phai 2 test xanh.** Ghi ro trong 8.31 + 12.33 + docs/19. Muc do ghi dung con so thi mat y nghia cua mutation.
> 5. **4 delta chua phat sinh** giong nguyen tu receipt Muc 21: D48 connector fetch chua chung minh, D49 live multi-container chua co, D50 3 file test traceability da sua (can Reviewer), D51 `hasBuffer` con trong COMMENT tai ingest/index.ts:206.
> 6. Version bump `1.42.0` — `1.43.0` cho 28 + 35 (byte delta 0). docs/19 **khong co** header version — xac nhan lai, dung convention cua chinh no (prose line 313 ghi ro “never carried a Document Version field”).
> 7. **Khong gate nao doi.** `LOG-01` va `INGEST-WIRE-01` van `[~]`; G-ENC NO-GO, G6 NO-GO, 52 dong khong doi. Khong tick, khong commit/push.

### 34.1 Bang chung

| Task | Receipt | Tests | tsc |
|---|---|---|---|
| LOG-01 | [tester.md#L8265](tester.md#L8265) | observability 23/23 + admin-error-boundary 21/21 | 0 |
| INGEST-WIRE-01 | [qwen-platform.md#L2016](qwen-platform.md#L2016) | document-core 45 suites / 537 | 0 |

### 34.2 Loi cua chinh toi

1. **Ba loi cau truc Python trong file sinh fragment** (escape quote long, dau cham sau dau ngoac, thieu dau ngoac) — ca ba deu chay fail **truoc khi ghi** tai lieu, khong con gi hong tren dia.
2. **Mot lan `t(tai lieu)...` du dieu khong dung** trong fragment — khong loi document, chi loi script tao fragment.
3. Khong loi link: 2 link cua docs/19 + 1 cua 8.31 + 1 cua 12.33 — 4/4 resolved + in-range **truoc khi ghi**. 9 cycle lien tiep khong con link hong ghi xuong dia.

## 35 — CYCLE 35: D-EVID-A29 — DATA-01/02/03 vao docs/04 + 19 + 28 8.32 + 35 12.34

> [!IMPORTANT]
> **RESUME POINT — cycle 35 (lane Qwen-Docs, task_2fc38f7a9a87, ctx_02c4d6aeece5).**
> 1. **Packet nay dung TEN FILE DUNG** (khac cycle 32/33/34) — docs/04, docs/19, docs/28, docs/35 deu ton tai. Ghi vao ca bon: 04 (muc moi), 19 (muc moi), 28 8.32, 35 12.34.
> 2. **DATA-01** [T-CODEX-OFFLINE-DATA-01-INDEPENDENT](tester.md#L8350) (04:43:23): 3 suites / **35/35** + tsc 0 — **independent**, ghi ro khong co live S3-compatible service hay PostgreSQL.
> 3. **DATA-02** [DATA-02](tester.md#L8367) (04:45:16): 4 suites / **99/99** + tsc 0 — **independent**, ghi ro khong co live PostgreSQL/S3/Redis/Vault; route `/api/v1/docs/*` khong ton tai trong router nen compatibility khong duoc claim.
> 4. **DATA-03** [Qwen Platform Muc 22](qwen-platform.md#L2100) (task_928ae74339d5): document-core full **46 suites / 542 tests** Exit 0, targeted moi 5/5 **x3**, worker-sdk regression 84/84, tsc 0. Gap that da sua: `prepareSources` chi kiem pin khi co artifact — task URL chua READY co 0 artifact thi pin khong kiem, va con `input.text` thi parse text do bao thanh cong du chua tai byte nao. Test viet truoc, chay, **DO tren code cu**.
> 5. **2 mutation probe la probe DO, khong phai test xanh:** M1 dua gate ve dang cu — 2 test do; M2 bo nhanh drop-inline — 1 test do; restore byte-exact `ingest/index.ts` sha `f05634ea`, 13203 B. Ghi ro o ca 4 file.
> 6. **D52 / D53 chua phat sinh:** D52 fix la **TIGHTENING fail-closed** nen co the lam task URL dung inline text bat dau fail voi `INGESTION_SOURCE_UNRESOLVED` — **breaking change** cho edge case do, coordinator nen biet truoc production. D53 chua co live multi-container cho DATA-03 (thuoc DATA-INT-01).
> 7. **Khong cong so:** 35 (3 suite orchestrator) + 99 (4 suite orchestrator) + 542 (46 suite document-core) — **hai package, ba tap suite**; 35 + 99 = 134 khong phai mot con so.
> 8. Version bump `1.43.0` — `1.44.0` cho 28 + 35 (byte delta 0). docs/04 va docs/19 **khong co** header version — dung convention cua chinh ho.
> 9. **Khong gate nao doi.** `G-DATA` NO-GO, `G6` NO-GO, 52 dong khong doi. Ca ba task van `[~]`, khong tick, khong commit/push.

### 35.1 Bang chung

| Task | Receipt | Tests | tsc | Loai |
|---|---|---|---|---|
| DATA-01 | [tester.md#L8350](tester.md#L8350) | 35/35 (3 suites) | 0 | **independent** |
| DATA-02 | [tester.md#L8367](tester.md#L8367) | 99/99 (4 suites) | 0 | **independent** |
| DATA-03 | [qwen-platform.md#L2100](qwen-platform.md#L2100) | 542/542 (46 suites) + 5/5 x3 + 84/84 | 0 | full-suite |

### 35.2 Loi cua chinh toi

1. **Hai loi cau truc Python trong file sinh fragment** (dau `)` dat sai cho `t()` chua ``) — ca hai chay fail **truoc khi ghi** tai lieu. Day la lan thu nhat trong nhieu cycle range toi dung `t(code) + B + ` va nhan ra ngay.
2. Khong loi link: 3 link moi o moi file — **12/12 resolved + in-range truoc khi ghi**. 10 cycle lien tiep khong con link hong ghi xuong dia.
3. **Khong co drift guard nao abort** trong cycle nay (4/4 file khop sha) — canh bao o cycle 32/33 co gia tri nham dung ky tu.

## 36 — CYCLE 36: D-EVID-A30 — DATA-02/04/05 + SUA attribution independent sai cua chinh toi

> [!IMPORTANT]
> **RESUME POINT — cycle 36 (lane Qwen-Docs, task_c5ddb47d7b16, ctx_bdbade44a0e6).**
> 1. **Suat loi cua chinh toi (D-A38-1):** cycle 35 (8.32) gan **independent** cho DATA-02 va tro toi `tester.md#L8367` — nhung 8367 la receipt **implementation** (ghi “Added a composed offline journey”, khong co dong “Independent read-only verification”). Receipt independent la **`T-CODEX-OFFLINE-DATA-02-INDEPENDENT` (8385, 04:54:34)**. Con so 99/99 dung o ca hai — **sai o attribution, khong sai o so**. Da sua o 4 file.
> 2. **Day la lan thu hai trong ba cycle** toi gan “independent” cho receipt khong doc lap (cycle 32 gap 77/79 cua ENC-08). Quy tac moi chot: **chi gan khi receipt TU NOI minh la independent** (co dong “Independent read-only verification”) **va** co HEAD line.
> 3. **DATA-02** [independent](tester.md#L8385): 4 suites / **99/99** + tsc 0; khong co live PostgreSQL/S3/Redis/Vault.
> 4. **DATA-04** [DATA-04](tester.md#L8419) (05:02:17): worker-sdk **18 suites / 311 tests**; document-core **46 suites / 542 tests** (voi `REDIS_SMOKE='0'`); 3 lenh lint/typecheck 0 — **KHONG CO INDEPENDENT RECEIPT**, muc do bang chung thap hon DATA-02/05. Receipt tu ghi live object storage, Redis va distributed finalize race **khong** duoc exercise.
> 5. **DATA-05** [independent](tester.md#L8438) (05:04:12): 2 suites / **20/20** (7 storage-migration + 13 artifact-storage) + tsc 0; khong co live migration, backup verification hay restore rehearsal.
> 6. **Khong cong so:** 99 (4 suite orchestrator) + 311 (18 suite worker-sdk) + 542 (46 suite document-core) + 20 (2 suite orchestrator) — hai package, bon tap suite; 20 = 7 + 13, khong cong them vao 99.
> 7. Version bump `1.44.0` — `1.45.0` (28+35, byte delta 0); docs/04 va docs/19 khong co header version — dung convention cua chinh ho.
> 8. **Khong gate nao doi.** `G-DATA` NO-GO, `G6` NO-GO, 52 dong khong doi. Ca ba van `[~]`, khong tick, khong commit/push.

### 36.1 Bang chung

| Task | Receipt | Tests | tsc | Loai |
|---|---|---|---|---|
| DATA-02 | [tester.md#L8385](tester.md#L8385) | 99/99 (4 suites) | 0 | **independent** |
| DATA-04 | [tester.md#L8419](tester.md#L8419) | worker-sdk 311 (18) + document-core 542 (46) | 0 x3 | verify, **khong independent** |
| DATA-05 | [tester.md#L8438](tester.md#L8438) | 20/20 (2 suites) | 0 | **independent** |

### 36.2 Loi cua chinh toi

1. **Sai attribution independent o cycle truoc (4 file)** — da sua o day. Nguyen nhan: so **dung** o receipt implementation, nhan **sai** o do doc lap. Bai hoc dung la “chi gan independent khi receipt tu noi”, khong suy tu vi tri hay tu nhan tam.
2. **Ba loi cau truc Python trong file sinh fragment** (du `)` dat sai cho t() trong 1 chuoi, va 1 dau `+ +` thua) — chay fail **truoc khi ghi tai lieu**.
3. Khong loi link: 3 link moi moi file — **12/12 resolved + in-range truoc khi ghi**; 4 attribution fix dung count==1. 11 cycle lien tiep khong con link hong ghi xuong dia.

## 37 — CYCLE 37: D-EVID-A31 — DATA-04 len INDEPENDENT; ENC-08 CSRF renderer; va sua anchor cua chinh toi da trung

> [!IMPORTANT]
> **RESUME POINT — cycle 37 (lane Qwen-Docs, task_4993dee19c6a).**
> 1. **DATA-04 NANG CAP tu implementation-only len INDEPENDENT.** Receipt [T-CODEX-OFFLINE-DATA-04-INDEPENDENT](tester.md#L8438) (05:09:55): worker-sdk **18 suites / 311 tests** + document-core **46 suites / 542 tests** (voi `REDIS_SMOKE='0'`) + 3 lenh lint/typecheck 0, tat ca Exit 0. **La chay lai doc lap cua cung bo lenh** chu khong phai them so test; **khong bao gio cong** hai receipt vao mot aggregate. Live object storage, Redis va distributed finalize race van khong duoc exercise.
> 2. **D-A38-2 — receipt independent nay KHONG co dong HEAD** (khac moi receipt independent khac trong cung file deu co). No van tu khai “Independent read-only verification; changed no source or test file” nen muc do doc lap duoc chap nhan; nhung quy tac cua chinh lane (chi gan independent khi receipt **tu noi** minh la independent **VA** co HEAD) **chi dat mot phan** — ghi ro de khong dua thanh chuan tuy yet.
> 3. **ANCHOR CUA CHINH TOI DA TRUNG, DA SUA (D-A38-3).** Cycle 36 tro DATA-05 independent toi `tester.md#L8438`; khi lane khac append receipt DATA-04 independent, dong do **bi day xuong L8461**. Van trong range nen **BROKEN=0 khong bat duoc** — chi content assertion moi thay. Da repoint o 4 file. Day la **bang chung thu hai** cho duyet D-A31-3: inbound anchor nen tro ten heading, khong so dong.
> 4. **ENC-08 CSRF renderer (Dong D112)** [Qwen Admin Muc 27](qwen-admin.md#L3280) (task_1be90638634c): `admin-crypto-config-shell` + `admin-crypto-config` **47/47**; 4 suite ENC **79/79 x3**; tsc 0. Token la **binding khong phai credential**; gate POST la rao duy nhat truoc khi ghi (sai/thieu — **403** va applier khong chay); save POST-redirect-GET 302. **D112 DONG o code + offline**; **D110** (webhook dispatcher) va **D113** (phai noi `verifySessionCsrf` voi OIDC session store) van mo.
> 5. **Delta cua lane khac, ghi lai de doc dung:** **D115** — Muc 26 viet assertion coi token CSRF la secret, **sai theo thiet ke**; da sua thanh token co trong HTML, token cua session khac thi khong, cookie secret thi tuyet doi khong — thay doi **y nghia test**, ai doc Muc 26 can biet. **D116** nhanh read-only gan nhu khong reachable qua route, la guard phong thu. **D117** full sweep Muc 27 co 5 do, 2 do **moi khong phai cua lane do** (dang sua do trong file test lane khac); **khong suite crypto nao** trong danh sach do.
> 6. Version bump `1.45.0` — `1.46.0` (28+35, byte delta 0); docs/04 va docs/19 khong co header version (dung convention cua chinh ho).
> 7. **Khong gate nao doi.** `G-DATA` NO-GO, `G-ENC` NO-GO, `G6` NO-GO, 52 dong khong doi. DATA-04 va ENC-08 van `[~]`, khong tick, khong commit/push.

### 37.1 Bang chung

| Task | Receipt | So lieu | Loai |
|---|---|---|---|
| DATA-04 | [tester.md#L8438](tester.md#L8438) (05:09:55) | worker-sdk 311 (18 suite) + document-core 542 (46 suite) + 3 lenh lint/typecheck 0 | **independent** (nang cap) |
| ENC-08 CSRF renderer (Dong D112) | [qwen-admin.md#L3280](qwen-admin.md#L3280) | 47/47 + 4 suite ENC 79/79 x3 + tsc 0 | verify receipt |

### 37.2 Loi cua chinh toi

1. **Anchor so dong cua toi da trung (D-A38-3) — da sua o 4 file.** Nguyen nhan: tester.md la file **lane khac lien tuc append**, con toi ghi anchor so dong — dang quy tac cua chinh lane (Delta-A31-3) la **tro ten heading**. Bang chung thu hai trong vong cycle.
2. Khong loi link: 2 link moi moi file — 8/8 resolved + in-range **truoc khi ghi**; content assertion **7/7** receipt anchor + **224** anchor duoc docs trich, 0 fail. 12 cycle lien tiep khong con link hong ghi xuong dia.
3. **Khong con loi cau truc Python trong cycle nay** (fragment sinh bang cac bien rieng, moi lai chay sach lan dau).


## 38 — CYCLE 38: ARCH-DOC-01 — path dữ liệu đã hiện thực vào docs/02 + tạo docs/09-system-architecture.md

> [!IMPORTANT]
> **RESUME POINT — cycle 38 (lane Qwen-Docs, task_fd229da69ae7).**
> 1. **Hai tên file trong packet KHÔNG tồn tại:** `02-architecture-overview.md` (thật là `02-architecture.md`) và `09-system-architecture.md` (không có; số `09-` đã thuộc `09-queue-sdk.md`). Đã ghi vào `02-architecture.md` và **tạo mới** `09-system-architecture.md` có nội riêng. Backlog ARCH-DOC-01 cũng viết sai tên — xem Δ-A39-1.
> 2. **Bốn chủ đề packet đều có nguồn:** native parse/split (local) vs OCR/vision (qua Connector, Δ48 fetch chưa chứng minh); app gateway / Vault Transit / recipient delivery (ENC-01/02/03/05/06/07 + ENC-META-01/09); ranh giới S3 bytes vs PG metadata (+bytea pilot DATA-05); bảng target/current/verified 12 hàng.
> 3. **Cả hai file mở đầu bằng câu phân biệt:** phần cũ là *kiến trúc mục tiêu*, phần mới là *đã materialize*, và **mọi dòng verified đều ghi rõ OFFLINE** — không dòng nào có live S3/PG/Redis/Vault/browser.
> 4. **Anchor drift bắt được bằng content assertion, đã sửa:** `qwen-platform.md` Muc 21/22 dịch 2017→**2018**, 2100→**2101** (Muc 23 mới chen vào giữa lúc tôi viết). 8 anchor trong 2 file đã repoint; `BROKEN=0` **không** thấy loại này vì vẫn trong range.
> 5. **Bằng chứng Mục 23 vừa land được phản ánh:** `claimTask` giờ từ chối `PENDING_INGESTION` bằng `STATE_CONFLICT` **trước khi cấp lease** (không lấy lease, không tăng attempt, không ghi last_delivery_id) — củng cố lập luận "routing không phải boundary". Không sửa gì trong source.
> 6. **Verify:** link check ×3 exit 0 — S0 1004/644 BROKEN=0 MISMATCH=0 GATE=0; S1 1081/720 BROKEN=0; **TREE 190 file / 1750 target / 845 anchor / BROKEN=2** (2 pre-existing Antigravity). File mới **đã** nằm trong TREE walk. Content assertion **49/49** anchor trong 2 file trỏ đúng receipt.
> 7. **Không gate nào đổi.** G-DATA/G-ENC/G6 NO-GO; không tick task row; không commit/push.

### 38.1 Sai lệch tên file (Δ-A39-1)

| Packet nói | Thực tế | Xử lý |
|---|---|---|
| `docs/02-architecture-overview.md` | `docs/02-architecture.md` | Ghi vào file thật |
| `docs/09-system-architecture.md` | Không tồn tại; `09-queue-sdk.md` đã chiếm số 09 | **Tạo mới** với nội dung đường dữ liệu; ghi rõ trong header file là tài liệu mới |

Backlog `ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:9` cũng ghi "architecture/02 và architecture/09" — cùng loại lỗi tên, nên source của packet này (backlog) cũng cần sửa; **không phải việc của lane này** (ngoài `docs/**`).

### 38.2 Nội dung đã thêm

**`docs/02-architecture.md`** — mục *Trạng thái kiến trúc đã hiện thực* gồm: (1) bảng native parse/split vs OCR/vision; (2) bảng 7 đoạn đường mã hóa kèm receipt; (3) bảng S3 bytes vs PG metadata vs bytea pilot; (4) bảng target/current/verified 12 hàng; (5) ghi snapshot 20/09 là lịch sử.

**`docs/09-system-architecture.md`** (mới, 6 mục) — đường submit→artifact durable với mermaid; đường ingest; ranh giới lưu trữ; đường mã hóa với mermaid; bảng response wire đã freeze; bảng target/current/verified.

### 38.3 Lỗi của chính tôi trong cycle này

1. **Anchor drift 8 chỗ** (qwen-platform Muc 21/22) — do lane khác append giữa lúc tôi đo và lúc tôi verify; đã repoint bằng content assertion. Lần thứ ba trong vòng các cycle gần đây về loại lỗi này.
2. **Một script kiểm tra của tôi báo 10 FAIL giả** vì kỳ vọng chuỗi `ENC-02` trong khi heading thật là `ENC02` (không dấu gạch) — **lỗi kỳ vọng, không phải lỗi anchor**; sửa kỳ vọng rồi chạy lại → 0 fail.
3. **Ba lần SyntaxError** trong script sinh nội dung (`chr(0394)` số 0 đứng đầu; `chr(1B0)` không phải số hợp lệ; backtick thô trong template) — đều fail **trước khi ghi**, dùng file nội dung tách riêng để tránh.
4. **Một lần suýt chạy lại `fix3`** sau khi nó đã được vượt qua ở bước trước — sẽ chèn trùng nội dung. Đã kiểm trạng thái file trước (`claim-para=1` ở cả hai) nên **không chạy lại**. Ghi lại vì đây là bẫy do chính thông điệp sửa lỗi của user có thể gây ra.
5. **Hai typo do tôi sinh:** `Worker gùi` (thiếu dấu sắc, docs/09) và tiêu đề `Muc 23` thiếu dấu (cả 2 file) — đã sửa, verify lại bằng đếm trước/sau.


## 39 — CYCLE 39: D-EVID-A32 — sáu bằng chứng mới (LOG-02, COST-01/02, ENC-08-CSRF-OIDC, DATA-03-ORCH-VERIFY, ARCH-DOC-01) vào docs/28 8.37 + docs/35 12.37

> [!IMPORTANT]
> **RESUME POINT — cycle 39 (lane Qwen-Docs, task_55387f221cf2, ctx_fd4024878e5f).**
> 1. **Packet chỉ định `python tools/docs-link-linter.py` — SCRIPT KHÔNG TỒN TẠI.** `du-rework/tools/` chỉ có `openapi/` + `verify-test-counts.ps1`; grep toàn cây không có file nào tên *linter*. Link validation chạy bằng checker Python của lane (scope S0/S1/TREE). D-A40-1.
> 2. **Sáu mục đã đồng bộ, tất cả số đọc trực tiếp từ receipt.** Mỗi mục ghi rõ mức bằng chứng và phần **còn thiếu**, không mục nào được tick.
> 3. **COST-02 có HAI receipt với HAI số khác nhau** (owner 432, independent 435) — ghi rõ đây là **hai lần chạy của cùng suite**, KHÔNG phải 432 + 435 test. Số dùng cho inventory là **435**.
> 4. **ENC-08-CSRF-OIDC ghi "verify receipt", không ghi "independent"** — nó là packet implement của Qwen Admin, không phải receipt độc lập. Nguyên tắc đã chốt ở cycle 36/37 được áp dụng nhất quán.
> 5. **Cây chuyển động mạnh trong lúc chạy:** lane COST append COST-03 vào docs/28 + docs/35 lúc 05:52, làm sha hai file đổi so với census ban đầu. Guard drift của tôi **abort lần ghi đầu**, sau đó re-derive anchor theo nội dung trên state mới.
> 6. Verify: link check ×3 exit 0 — S0 1015/650 BROKEN=0 MISMATCH=0 GATE=0; S1 1092/726 BROKEN=0; TREE 190 file / 1761 target / 851 anchor / BROKEN=2 (2 pre-existing Antigravity). Anchor content assertion 6/6.

### 39.1 Số liệu đã verify (đọc trực tiếp)

| Mục | Receipt | Số | Loại |
|---|---|---|---|
| LOG-02 collector → Elasticsearch | [tester.md#L8563](tester.md#L8563) | observability **36/36** (2 suites) + orchestrator log-collector **3/3**; lint/build/typecheck 0 | **independent** |
| COST-01 usage attribution | [tester.md#L8526](tester.md#L8526) | contracts **19 suites / 428 tests**; tsc 0 | **independent** |
| COST-02 versioned pricing | owner [tester.md#L8509](tester.md#L8509) **+** independent [tester.md#L8584](tester.md#L8584) | **432** vs **435** tests; tsc 0 | **cả hai** |
| ENC-08-CSRF-OIDC (đóng Δ113) | [qwen-admin.md#L3366](qwen-admin.md#L3366) | 6 test mới; dùng primitive thật `verifySessionCsrf` | verify receipt |
| DATA-03-ORCH-VERIFY | [qwen-platform.md#L2185](qwen-platform.md#L2185) | `claimTask` từ chối `PENDING_INGESTION` **trước khi cấp lease** | verify receipt |
| ARCH-DOC-01 | [Muc 38](#-39--cycle-39-d-evid-a32--sau-bang-chung-moi-log-02-cost-0102-enc-08-csrf-oidc-data-03-orch-verify-arch-doc-01-vao-docs28-837--docs35-1237) | docs/02 cập nhật + docs/09-system-architecture.md tạo mới | docs sync |

### 39.2 Phần còn thiếu (ghi để không ai đọc 36/435 là "đã xong")

- **LOG-02:** live Elasticsearch connection, TLS handshake, data-stream provisioning, ILM policy.
- **COST-01:** consumer service migration, end-to-end event ingestion.
- **COST-02:** pricing persistence, publish workflow, consumer integration.
- **ENC-08-CSRF-OIDC:** live OIDC session thật (test dùng session store giả lập trong bộ test).
- **DATA-03-ORCH-VERIFY:** live multi-container, connector fetch thật (Δ48).

**Gate `G-DATA`, `G-ENC`, `G-ADMIN-OPS`, `G6` đều NO-GO. 52 dòng release-scope không đổi. Không tick task row nào.**

### 39.3 Lỗi của chính tôi trong cycle này

1. **Guard link chặn 1 lỗi của fragment:** tôi viết `](qwen-docs.md)` (dạng sibling) trong khi section 8.37 nằm trong `docs/` — phải là `](qwen-docs.md)`. Bắt được **trước khi ghi**, sửa rồi mới ghi.
2. **Anchor drift 2 chỗ:** `COST-02-INDEPENDENT` dịch 8587→**8584**, `qwen-platform` Muc 23 dịch 2184→**2185** (do lane khác append giữa lúc tôi đo và lúc ghi). Đã re-derive theo nội dung.
3. **Guard drift chặn 1 lần ghi:** docs/28 + docs/35 đổi sha lúc 05:52 (lane COST thêm COST-03). Script abort, tôi census lại rồi mới ghi — **không** ghi đè nội dung của lane khác.
4. Ba lần chạy link checker đều exit 0, không có lỗi tool nào trong cycle này.


## 40 — CYCLE 40: D-DOCS-06-RESULT — tạo docs/06-result-envelope.md theo contract RESULT-WIRE-01

> [!IMPORTANT]
> **RESUME POINT — cycle 40 (lane Qwen-Docs, task_caea3b5ceed6, ctx_5f4e332234e0).**
> 1. **File `docs/06-result-envelope.md` do packet chỉ định KHÔNG tồn tại** — catalog public API thật là `docs/06-public-api.md`. Đã **tạo mới** file với đúng tên packet yêu cầu, ghi rõ trong phần đầu file là tài liệu mới.
> 2. **Toàn bộ mô tả đọc từ schema thật** trong `packages/contracts/src/operations.ts` và `encryption.ts`, không chép từ receipt hay packet.
> 3. **Phát hiện đáng ghi nhất (Δ-A41-1): hợp đồng đã đóng băng chưa có trong OpenAPI.** Grep `docs/21-openapi.json`: `encrypted` **0 hit**, `delivery` **0 hit**, `schemaVersion` **0 hit**. Grep `tools/openapi/gen_openapi.py`: cùng **0 hit** cả ba. Nghĩa là **artifact OpenAPI và generator chưa mô tả biến thể encrypted** — hợp đồng trong code đã có, trong spec sinh ra thì chưa.
> 4. Link check ×3 exit 0: S0 1020/650 BROKEN=0 MISMATCH=0 GATE=0; S1 1104/732 BROKEN=0; TREE **191 file** (file mới đã vào phạm vi) / 1779 target / BROKEN=2 (2 pre-existing Antigravity).

### 40.1 Nội dung file mới

| Mục | Nội dung |
|---|---|
| Nguyên tắc | Server quyết định biến thể theo chính sách tenant; **không** có query/header để client ép plaintext |
| `GET /operations/{id}/result` plain | `ResultEnvelope` v1 strict, **5 field**: `schemaVersion`(`"1"`), `data`, `artifacts` (mặc định `[]`, mỗi ref có artifactId/mimeType/size/sha256 + hashSha256/download tu chọn), `usage`, `warnings` |
| `GET /operations/{id}/result` encrypted | `EncryptedResultEnvelope` v1 strict, **đúng 3 field**: `schemaVersion`, `encrypted: true`, `delivery`; giải mã `delivery` ra **đúng** ResultEnvelope |
| `GET /artifacts/{id}/download` plain | **raw bytes**, Content-Type = MIME artifact; body là `Uint8Array` **hoặc** async byte stream (server được stream) |
| `GET /artifacts/{id}/download` encrypted | **JSON** wrapper strict: `schemaVersion`, `encrypted: true`, `delivery`, `artifactId` (**UUID**), `mimeType` (1..255); content type `application/json` |
| Điểm dễ đọc sai | 2 biến thể encrypted **dùng chung** `RecipientDeliveryEnvelopeSchema`, cùng strict; `/download` **không còn 302**; client đọc `encrypted === true` chứ không đoán shape; strict = field lạ bị từ chối |
| Còn thiếu | External client thật; Vault thật; **OpenAPI chưa có** biến thể encrypted (Δ-A41-1) |

### 40.2 Δ

- **Δ-A41-1 (phát hiện của cycle này, nên báo coordinator):** `docs/21-openapi.json` và `tools/openapi/gen_openapi.py` đều **không có** token `encrypted`/`delivery`/`schemaVersion`. Contract đã đóng băng ở `operations.ts` nhưng **spec sinh ra chưa theo kịp** — client sinh từ OpenAPI sẽ **không thấy** biến thể encrypted. Sửa cần chạm `gen_openapi.py` + regenerate; **ngoài phạm vi docs của cycle này** (`tools/` không thuộc `docs/**`).
- **Δ-A41-2 (tên file):** packet trỏ `docs/06-result-envelope.md`, file này không tồn tại; catalog thật là `docs/06-public-api.md`. Đã tạo mới đúng tên packet yêu cầu và ghi rõ quan hệ với `06-public-api.md` trong file.

### 40.3 Lỗi của chính tôi

**Không có lỗi ghi trong cycle này.** Đây là cycle đầu sau khi bỏ hẳn cách viết fragment bằng cách dựng chuỗi có dấu trong JS/Python (nguồn của phần lớn lỗi SyntaxError các cycle trước): fragment viết thẳng bằng `write_file`, script chỉ đọc file và thao tác byte. Delta verify được chạy **trước khi tạo file**, không phải sau.
## 41 — CYCLE 41: D-OPENAPI-ENC-RESULT — đóng Δ-A41-1, publish 4 schema delivery + route download vào OpenAPI

> **RESUME POINT — cycle 41 (packet `D-OPENAPI-ENC-RESULT`, task `task_a78de4c6e5c6`, dispatch `ctx_ddd407434cb4`, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–40 giữ nguyên bên dưới phần ledger như lịch sử.
> 1. **Δ-A41-1 của cycle 40 đã đóng bằng đo, không bằng lời.** `tools/openapi/gen_openapi.py` giờ phát `components.schemas` với 8 schema; `docs/21-openapi.json` đi 42 → **43** path.
> 2. **Mọi mô tả đọc từ source thật**, không chép từ receipt: `packages/contracts/src/operations.ts` (171–230), `encryption.ts` (198–208), `services/orchestrator/src/server.ts` (1724–1879). `.strict()` được chép trung thực: object không có `.strict()` **không** được xuất bản thành `additionalProperties: false`.
> 3. **Sai lệch packet, báo chứ không sửa im lặng:** packet viết thêm mô tả cho `GET /artifacts/{id}/download` — route đó **chưa** có trong spec, và `x-absent` còn **khẳng định** nó vắng mặt trong khi `server.ts:1817` đã hiện thực từ CR-12/MM-02. Tôi vừa publish route, vừa sửa `x-absent` → xem Δ-A42-1.
> 4. **Hai file prose cũng sửa theo**, nếu không chúng tự mâu thuẫn với artifact mới: `docs/06-result-envelope.md:75` (dòng nói OpenAPI chưa mô tả biến thể encrypted) và `docs/20-openapi-descriptions.md:47-50` (danh sách ABSENT).

### 41.1 Bảng bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | Census **trước** khi sửa | `gen_openapi.py` bytes=20218 lines=262 crlf=262 bareLF=0 sha16=`c449719da51383f6`; `21-openapi.json` bytes=33790 sha16=`3bc395fb4fb5fa0f` |
| E2 | Δ-A41-1 xác nhận còn đúng | grep `encrypted` / `delivery` / `schemaVersion` = **0 hit** ở **cả hai** file |
| E3 | Census **sau** khi sửa | `gen_openapi.py` bytes=34809 crlf=436 **bareLF=0** sha16=`550795cba65657e5`; `py_compile` OK |
| E4 | Generator chạy, hai lần | `path-count=43 operations-params=6 sort-values=6 dropped-paths=0 schemas=8`, exit 0 |
| E5 | **Byte-idempotent** | run1 = run2: bytes=47473 crlf=1594 bareLF=0, sha16=`c9aae1963f0b0d61` |
| E6 | JSON hợp lệ | `json.loads` OK; openapi=3.0.3; paths 42→43; x-absent=7; schemas=8 |
| E7 | Schema mới có đủ | `ArtifactDownloadResponse`, `ArtifactRef`, `EncryptedArtifactDownload`, `EncryptedResultEnvelope`, `RecipientDeliveryEnvelope`, `ResultEnvelope`, `ResultResponse`, `Usage` |
| E8 | `/operations/{id}/result` | 200 → `$ref: ResultResponse`; `oneOf` = `[ResultEnvelope, EncryptedResultEnvelope]`; statuses 200/404/409/410/503 |
| E9 | `/artifacts/{id}/download` | 200 content = `[application/octet-stream, application/json]`; nhánh JSON → `$ref: EncryptedArtifactDownload`; statuses 200/404/409/413/503 |
| E10 | `x-absent` | entry cũ `GET artifact metadata/download` **đã bị thay** bằng `GET /api/v1/artifacts/{id} metadata` |
| E11 | Validator, **trước** | `validate_openapi.py`: paths=42 x-absent=7, **23 PASS**, exit 0 |
| E12 | Validator, **sau** | paths=43 x-absent=7, **23 PASS**, exit 0 — không regression |
| E13 | Grep trên artifact sinh ra | `encrypted`=**14**, `delivery`=**15**, `schemaVersion`=**9** (trước: 0/0/0) |
| E14 | EOL của 2 file prose | `06-result-envelope.md` = **LF thuần** (0 CRLF); `20-openapi-descriptions.md` = **CRLF thuần** (129 CRLF) — giữ nguyên, không ép |

### 41.2 Δ

- **Δ-A42-1 (phát hiện chính, quan trọng nhất):** `x-absent` của generator **khẳng định** `GET artifact metadata/download` vắng mặt, trong khi `server.ts:1817` (`GET /api/v1/artifacts/:id/download`, CR-12/MM-02) đã tồn tại. Nửa `download` sai → đã publish. Nửa `metadata` vẫn đúng: **không** có route `GET /api/v1/artifacts/{id}` trong `server.ts`.
- **Δ-A42-2 (tiết lộ, không giấu):** `/operations/{id}/result` **chưa** khai báo 404 dù route 404 khi operation thuộc tenant khác (`server.ts:1737`). Tôi **thêm** 404 — nằm ngoài danh sách packet yêu cầu, nói ra thay vì im lặng.
- **Δ-A42-3:** trích dẫn `server.ts:619` trong generator **đã trôi** — dòng đó hôm nay là comment nhánh abort, handler result nằm ở `server.ts:1724`. Tôi sửa **đúng dòng mình viết lại**; khoảng 30 trích dẫn `server.ts:NNN` còn lại trong cùng file **chưa** rà — báo, không quét đại trà.
- **Δ-A42-4 (đính chính claim cũ):** Muc 16 của chính receipt này ghi `validate_openapi.py` exit 1 (21 PASS/2 FAIL). Đo hôm nay, **trước** cả thay đổi của tôi: **23 PASS, exit 0**. Claim cũ **không tái lập được** trên cây hiện tại → coi là vô hiệu bằng **đo**, không bằng phỏng đoán.
- **Δ-A42-5 (tự tiết lộ):** `info.version` của artifact `1.0.0` → `1.1.0`, kèm lý do trong `info.description`. Không ai yêu cầu; tôi làm để thay đổi 42→43 path nhìn thấy được.

### 41.3 Lỗi của chính tôi (đều bị bắt trước khi ghi receipt)

1. **`SyntaxError`**: 3 chỗ `schemaVersion "1"` nằm **không escape** trong literal kép của Python. Bắt bởi `gen_openapi.py` exit 1; sửa rồi `py_compile` OK.
2. **Đặt nhầm chỗ**: chèn khóa `"schemas": SCHEMAS` ở **top level** của `doc` thay vì trong `components` → chính guard của tôi ném `KeyError: schemas`. Sửa thành `doc["components"]["schemas"] = SCHEMAS`.
3. **Guard đo sai hình dạng**: tôi expect `oneOf` nằm inline trong response, nhưng union là schema có tên → `KeyError: oneOf`. Guard nay đi theo `$ref`.
4. **Bẫy CRLF quen thuộc**: anchor nhiều dòng viết bằng LF không khớp file CRLF (0 hit). Chuẩn hoá LF **trước** khi khớp, khôi phục CRLF **khi** ghi, rồi assert `crlf == lines`.
5. **Số liệu tôi tự viết trước rồi tự sai**: fragment `docs/06` ban đầu ghi `delivery`=**14**; đo lại sau khi bump version ra **15**. Con số trong `docs/06` là **số đo sau bump**, không phải số trước đó.
6. Hai lệnh `print` trong script tạm có số placeholder không khớp — vô hại, xảy ra **sau** khi ghi file và `py_compile`. Không phải lỗi trong repo.

### 41.4 Kiểm tra link và anchor (chạy SAU khi ghi Mục 41, không sửa thêm file nào)

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E15 | Link checker ×3, scope S0 | `FILES=8 TARGETS=1021 ANCHORS=650 EXT=0 INPAGE=0 BROKEN=0 UNVALRANGE=0 MISMATCH=0`, exit 0, ba lần giống hệt |
| E16 | Link checker ×3, scope S1 | `FILES=11 TARGETS=1105 ANCHORS=732 EXT=0 INPAGE=2 BROKEN=0 UNVALRANGE=0 MISMATCH=0` |
| E17 | TREE (docs+coordination+tasks) | `FILES=192 TARGETS=1784 BROKEN=2` — **cả hai nằm ngoài lane này và có sẵn từ trước**: `coordination/reports/antigravity-6.md:8952` và `coordination/requests/antigravity.md:10` |
| E18 | Anchor do chính cycle này tạo/sửa | `MINE_ANCHOR_FAILS=0`: `qwen-docs.md#L3176` → dòng `- **Δ-A42-1`; `qwen-docs.md#L1663` → dòng `## 16 — CYCLE 16` (ở **cả** docs/28 và docs/35); `tester.md#L8245` → `# RESULT-WIRE-01` |
| E19 | File **ngoài** scope của checker | `docs/06-result-envelope.md` **không** nằm trong S0/S1 (file tạo ở cycle 40, scope chưa mở rộng). Kiểm riêng: cả **7** link trong file đều resolve, 2 anchor khớp nội dung. **Không tự sửa công cụ kiểm** — đề xuất thêm file này vào S0 ở một patch scope riêng |

> **Ghi chú về E17:** đây không phải `BROKEN=0` toàn repo. Lane này chỉ đứng `BROKEN=0` ở S0/S1; TREE vẫn có 2 link hỏng và chúng thuộc file của lane khác, nên **không** sửa.
## 42 — CYCLE 42: D-DOCS-COST-ADM-SYNC — đồng bộ `GET /api/v1/usage/events` + durable reservation vào docs/20 và admin-ops

> **RESUME POINT — cycle 42 (packet `D-DOCS-COST-ADM-SYNC`, task `task_a81acbf3134a`, dispatch `ctx_6f465683bd05`, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–41 giữ nguyên phía trên như lịch sử.
> 1. **Hai file đích, bốn chỗ sửa**: `docs/20-openapi-descriptions.md` (+1 dòng route trong bảng §1, +1 mục §6 mới) và `docs/admin-ops-monitoring-cost.md` (viết lại 1 ô của bảng *Đánh giá hiện trạng*, +1 mục mới trước *Quy tắc số liệu*).
> 2. **Mọi câu mô tả đọc từ source**, không chép từ receipt: `server.ts` (1139–1189), `modules/usage/usage.ts` (196–221, 526–637), `packages/contracts/src/usage-reconciliation.ts` (116–209), `usage-budget.ts` (217–380), `modules/usage/budget-reservations.ts` (37–46, 125–175), `migrations/0022_budget_reservations.sql`.
> 3. **Không tick row nào.** COST-01..04 trong bảng trạng thái vẫn `[ ]`; `G-ADMIN-OPS` không được đóng. Mục mới ghi rõ điều đó ngay dòng đầu.
> 4. **"Hoàn thành" được ghi đúng mức:** reservation **đã hiện thực + verified offline**, **chưa** live-verified (chưa chạy migration trên PostgreSQL thật, chưa có race live, chưa chạy call-site connector).

### 42.1 Bảng bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | Census **trước** khi sửa | `docs/20` bytes=22855 **CRLF thuần** (145 CRLF / 0 bare LF) sha16=`ed2af332d8b9ef79`; `admin-ops-monitoring-cost.md` bytes=14401 **LF thuần** (0 CRLF / 81 bare LF) sha16=`525286c76becb38f` |
| E2 | Route có thật | `server.ts:1143` `GET /api/v1/usage/events`; allow-list **13** tên tại 1144–1147 |
| E3 | Fail-closed trên query | tham số lạ **hoặc lặp** → `422 INVALID_SCHEMA` (1150–1152); `limit`/`profileRevision` phải khớp `/^\d+$/` (1153–1155) |
| E4 | Ràng buộc schema | `UsageEventDrilldownQuerySchema` `.strict()` + `superRefine`: `WINDOW_ORDER`, `INCOMPLETE_BUSINESS_ACTION_FILTER`, `INCOMPLETE_PROVIDER_MODEL_FILTER` (`usage-reconciliation.ts:132-157`) |
| E5 | Cursor | base64url `{version,tenantId,queryHash,after,eventId}`, từ chối base64url không canonical; payload strict (`usage.ts:196-221`, `usage-reconciliation.ts:162-168`) |
| E6 | Ràng buộc cursor | `queryHash = sha256(JSON.stringify({tenantId, binding}))`, `binding` **11 khoá** = 7 filter chiều + `from` + `to` + `timeField` + `limit` (`usage.ts:537-550`); lệch → `422 INVALID_ARGUMENT` **trước** khi dựng SQL (552–554) |
| E7 | Đọc có giới hạn | tối đa `limit + 1` dòng; `hasMore` là dòng thừa; cursor mới lấy từ dòng **đã quét** cuối (`usage.ts:600-627`); `timeSemantics` trả lại lựa chọn đồng hồ |
| E8 | Audit | mỗi trang thành công ghi `usage.export` / `usage-events:page` / severity `info`, không có giá trị filter, cursor hay credential (`server.ts:1180-1187`) |
| E9 | Phân quyền | admin bearer qua `authorizeAuditTenantRead` rồi **bắt buộc** `tenantId`; `x-api-key` ghim tenant của key, lệch là `403` (`server.ts:1163-1177`) |
| E10 | Hợp đồng reservation | 6 status; `budgetReservationCountsAsHeld` giữ cả `RUNNING`/`UNKNOWN` (`usage-budget.ts:217-232`); `RELEASED` **chỉ** kèm `confirmedNotSent: true` (326–351); `RECONCILED` bắt buộc có `usageEventId` (372–380); `isBudgetReservationTrusted` cần đủ 4 cờ (277–290) |
| E11 | Bền vững | migration `0022_budget_reservations.sql`: bảng + **hai** unique index + FK; giao dịch admit khoá advisory theo scope/cửa sổ chuẩn |
| E12 | Fail-closed reservation | `503 BUDGET_RESERVATION_UNAVAILABLE` tại `budget-reservations.ts:125,164,167,175` |
| E13 | Receipt `COST-03-DRILLDOWN` | contracts build 0; contracts **2 suite / 18 test** 0; orchestrator **2 suite / 12 test** 0; lint 0; typecheck 0. Receipt tự gõ: **không** có PostgreSQL live, **không** có luồng export trình duyệt, **không** có review độc lập |
| E14 | Receipt `COST-04-RESERVATION` | contracts build/tsc 0; contracts **23 suite / 463 test** 0; orchestrator typecheck 0; orchestrator **4 suite / 50 test** 0. Tự gõ: migration live **không** chạy, **không** có connector call-site |
| E15 | Receipt độc lập | `T-CODEX-OFFLINE-COST-04-RESERVATION-INDEPENDENT`: orchestrator **3 suite / 33 test** 0 + `tsc --noEmit` 0, **tự khai** read-only độc lập. Lần đó không chạy `migrations-ledger-guard.test.ts`, nên 33 chứ không phải 50 |
| E16 | Census **sau** khi sửa | `docs/20` bytes=30724 CRLF 188/0 sha16=`259472fd634848f5`; `admin-ops` bytes=21798 LF 124/0 sha16=`3371548499787b2d` |
| E17 | EOL | `docs/20` **vẫn** CRLF thuần; `admin-ops` **vẫn** LF thuần — đọc từ file, không ép |
| E18 | Link checker ×3 | S0 `FILES=8 TARGETS=1031 BROKEN=0`; S1 `FILES=11 TARGETS=1115 BROKEN=0`; TREE `FILES=195 BROKEN=2` — hai cái đó **có sẵn** và thuộc lane khác: `antigravity-6.md:8952`, `requests/antigravity.md:10` |
| E19 | Đóng góp của tôi vào TARGETS | 4 fragment của tôi chứa đúng **0** link, backtick chẵn. TARGETS tăng 1021→1031 **không** phải của tôi — xem Δ-A43-4 |
| E20 | Anchor của cycle này | `MINE_ANCHOR_FAILS=0`; repoint `docs/20#L38` → `#L39` ở `docs/28` + `docs/35` (kèm **nhãn** `:38`→`:39` trong `docs/35`) |
| E21 | Không tick row | COST-01..04 vẫn `[ ]`; cột Gate giữ nguyên `G-ADMIN-OPS` |

### 42.2 Δ

- **Δ-A43-1 (phát hiện chính):** `GET /api/v1/usage/events` **không có** trong `docs/21-openapi.json` — artifact có `/api/v1/usage/summary` nhưng thiếu route này. **Cùng loại** với Δ-A42-1. Packet lần này chỉ định đúng **hai file prose**, nên tôi **không** sửa generator: báo để coordinator quyết, không tự ý mở rộng.
- **Δ-A43-2:** `G-ADMIN-OPS` được dùng như **tên gate** ở cả hai receipt và trong bảng trạng thái của `admin-ops`, nhưng `coordination/gates/` **không có** file mang tên đó (chỉ có `contracts-v1`, `integration-e2e-ready`, `integration-usage-ready`, `runtime-ready`, `sdk-ready`, `workspace-ready`). Tôi **không** tự tạo gate và **không** tự đổi tên trong bảng — cần coordinator xác minh gate này sống ở đâu.
- **Δ-A43-3 (attribution):** receipt `COST-03-DRILLDOWN` **không** có receipt review độc lập, trong khi phần COST-04 thì có. Vì vậy drill-down chỉ được ghi là *implemented + offline verified của chính lane*, **không** gắn nhãn independent; reservation thì gắn được vì receipt thứ hai tự nói mình độc lập.
- **Δ-A43-4 (lane khác đang ghi song song):** sha16 của `docs/28` và `docs/35` **đã đổi** so với cuối cycle 41, TREE FILES 192→195, S0 TARGETS 1021→1031. Không phải việc của tôi, nhưng nó làm tôi bỏ sha guard cũ và chuyển sang content-count guard. Số TARGETS tăng **không** do 4 fragment của tôi — chúng có 0 link (E19).
- **Δ-A43-5:** packet nói *"hợp đồng durable reservation đã hoàn thành"*. Tôi ghi lại đúng mức đo được: **đã hiện thực + verified offline**, **chưa** live-verified. "Hoàn thành" nếu hiểu là đã nghiệm thu thì **chưa đúng**.

### 42.3 Lỗi của chính tôi (đều bị bắt trước khi ghi receipt)

1. **Chèn thiếu dòng trống trước heading**: ở `admin-ops` mục mới dính liền vào dòng cuối của bảng trạng thái. Bắt bằng cách dump lại sau khi ghi; sửa bằng script riêng.
2. **Chèn sai vị trí dòng trống**: tôi đặt section trước dòng trống thay vì sau nó (`insert_at = anchor - 1`). Hệ quả trùng với lỗi 1.
3. **Đếm sai binding của cursor**: tôi viết "8 filter chiều" rồi đọc lại `usage.ts:537-549` thì là **7** filter chiều + `from`/`to`/`timeField`/`limit` = 11 khoá. Sửa **trước** khi ghi file.
4. **Suyýt ghi sai diễn giải số liệu**: TARGETS tăng 10, tôi định ghi "số target không đổi". Đo lại thì fragment của tôi có **0** link, nên phần tăng là của lane khác — phải nói đúng người vướng thay vì nhận về mình (E19, Δ-A43-4).
5. **Định repoint bằng cảm tính**: tôi sắp sửa `admin-ops#L21` và `#L44`. Đếm lại thì phần chèn nằm ở dòng 58, nên 21 và 44 **không** dịch. Chỉ `docs/20#L38` mới dịch (vì dòng route chèn ở 32) → `#L39`. Không sửa oan.
6. Nhãn hiển thị `docs/20-openapi-descriptions.md:38` trong `docs/35` cũng mang số dòng cũ; chỉ sửa target thì text và target lệch nhau, nên sửa **cả hai** trong đúng vùng của cycle này.
## 43 — CYCLE 43: D-DOCS-OPENAPI-EVENTS-SYNC — publish `GET /api/v1/usage/events` vào OpenAPI, đóng Δ-A43-1

> **RESUME POINT — cycle 43 (packet `D-DOCS-OPENAPI-EVENTS-SYNC`, task `task_f2434eeee16a`, dispatch `ctx_f0ea55c4bda1`, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–42 giữ nguyên phía trên như lịch sử.
> 1. **Sửa GENERATOR, không sửa artifact.** `docs/21-openapi.json` là output; chỉnh tay nó chính là cái lỗi Reviewer Turn 150 gọi là reproducibility gap (T140-D1). Mọi thay đổi đi qua `tools/openapi/gen_openapi.py`.
> 2. **13 tham số DẪN XUẤT từ `packages/contracts/src`, không gõ tay** — cùng nguyên tắc đã áp cho operations list ở cycle 16: tên tham số lấy từ `ts_object_keys(UsageEventDrilldownQuerySchema)`, pattern ID từ `USAGE_ATTRIBUTION_ID_PATTERN`, enum `timeField`/`costStatus` từ contract, biên `limit` từ `.max().default()`. Contract đổi → generator **fail trước khi ghi**, không âm thầm xuất bản giá trị cũ.
> 3. **Hai đường auth trên MỘT contract**: `ApiKey` (ghim tenant của key) và `AdminBearer` (đọc tenant được cấp quyền, khi đó **bắt buộc** có `tenantId`). `op()` nay nhận list mà vẫn giữ nguyên dạng đơn cho mọi route cũ — và tôi **đo lại** để chứng minh route operations không đổi.
> 4. **Hai dòng prose đã nói "route vắng mặt trong 21-openapi.json"** — giờ sai. Đã sửa cả hai, không để tài liệu tự mâu thuẫn với artifact của nó.

### 43.1 Bảng bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | Δ-A43-1 xác nhận trước khi sửa | `21-openapi.json` có `/api/v1/usage/summary`, **không** có `/api/v1/usage/events`; `x-absent=7` |
| E2 | Census generator, trước | bytes=34809 crlf=436 **bareLF=0** sha16=`550795cba65657e5` |
| E3 | Census generator, sau | bytes=53316 crlf=678 **bareLF=0** sha16=`926761d474004c96`; `py_compile` OK mỗi lần sửa |
| E4 | Generator chạy, hai lần | `path-count=44 operations-params=6 sort-values=6 usage-events-params=13 dropped-paths=0 schemas=14`, exit 0 |
| E5 | **Byte-idempotent** | run1 = run2: bytes=67714 crlf=2158 bareLF=0, sha16=`37c609208de55bd0` |
| E6 | JSON hợp lệ | `json.loads` OK; openapi=3.0.3; **version 1.1.0 → 1.2.0**; paths 43→**44**; schemas 8→**14** |
| E7 | Tham số đúng contract | 13 tên khớp thứ tự `ts_object_keys`: `tenantId, apiKeyId, businessId, action, profileRevision, provider, model, operationId, from, to, timeField, limit, cursor` |
| E8 | Hai đường auth | `security=[ApiKey, AdminBearer]`; route operations vẫn `security` **1** mục, 6 tham số — không regression |
| E9 | Response | 200 → `$ref: UsageEventExportPage`; statuses 200/401/403/422 |
| E10 | **Dangling `$ref` = 0** | quét mọi `$ref` trong artifact, không có con trỏ nào trỏ tới schema không tồn tại |
| E11 | Schema mới | `UsageEventExportPage`, `UsageEventQuery`, `UsageEventCursor`, `UsageLedgerEvent`, `UsageLedgerUnits`, `UsageTimeSemantics` |
| E12 | Validator | `validate_openapi.py`: paths=44 x-absent=7, **23 PASS**, exit 0 — cùng mức trước khi sửa |
| E13 | Prose đã sửa theo | `docs/20` bytes=31551 CRLF thuần sha16=`3b0f8f1ead6a3350`: đoạn drift §6.1 + **+1 dòng** trong bảng đối chiếu §5 |
| E14 | Anchor vào docs/20 | đo lại 2 anchor `L39` (docs/28, docs/35) → vẫn trỏ đúng dòng `3. The cursor carries…`; hai sửa của tôi nằm **dưới** dòng đó nên **không** cần repoint |
| E15 | Link checker ×3 | S0 `FILES=8 TARGETS=1031 BROKEN=0`; S1 `FILES=11 TARGETS=1115 BROKEN=0`; TREE `BROKEN=2` — hai cái đó **có sẵn**, thuộc lane khác |

### 43.2 Δ

- **Δ-A44-1: `Δ-A43-1` ĐÓNG bằng đo.** Route và 6 schema đã vào spec; version 1.2.0; regenerate byte-identical; validator không regression.
- **Δ-A44-2 (còn mở, không phải việc packet này):** `x-absent` vẫn ghi `POST /api/v1/artifacts` và `GET /api/v1/artifacts/{id} metadata`. Hai entry đó vẫn **đúng** — `server.ts` không có route nào — nên tôi không đụng.
- **Δ-A44-3 (báo coordinator):** `validate_openapi.py` **không** kiểm `components.schemas` mới. Nó đọc `probe_cases.js` với bộ case ghi cứng, chạy qua `contracts/dist`, và **không bao giờ** mở `docs/21-openapi.json` để so khớp example với schema. Nghĩa là 6 schema mới của tôi được generator tự kiểm (E10) chứ **không** có validator ngoài xác nhận. Tôi **không** tự sửa `validate_openapi.py` vì nó là công cụ kiểm, ngoài phạm vi packet — đề xuất một patch scope riêng.
- **Δ-A44-4:** cycle 42 đã báo TREE `BROKEN=2` ở `antigravity-6.md:8952` và `requests/antigravity.md:10`. Hai link đó **vẫn** hỏng ở cycle này, cùng hai dòng, không đổi. Không sửa: ngoài lane này.
- **Δ-A44-5 (packet vs source):** packet nói đồng bộ "theo hợp đồng đã chốt ở docs/20". Tôi dùng docs/20 làm prose của record nhưng **đọc shape từ `packages/contracts/src`**, vì docs/20 tự nói nó là prose và `docs/21` là companion máy-đọc; lấy schema từ prose sẽ lặp lại đúng lớp lỗi mà Reviewer đã gọi trước đây.

### 43.3 Lỗi của chính tôi (đều bị bắt bởi guard, trước khi ghi receipt)

1. **Thứ tự định nghĩa**: khối derive COST-03 gọi `ts_enum` trước khi hàm được định nghĩa → `NameError`. Sửa bằng cách dời extractor lên trên chỗ dùng đầu tiên.
2. **`SCHEMAS` dựng trước hằng mới**: dict `components.schemas` được ghép trước khi 6 hằng COST-03 tồn tại → `NameError`. Dời dict xuống sau, kèm một dòng chú thích nói vì sao.
3. **Guard của chính cycle 41 bắt lỗi của tôi (đúng như thiết kế)**: pin danh sách schema chạy `AssertionError: components.schemas drifted to [...14 tên...]`. Tôi **mở rộng pin** thay vì nới lỏng — pin đúng là để bắt loại drift này.
4. **`$ref` treo**: route trỏ `#/components/schemas/UsageEventExportPage` nhưng dict lại đăng ký tên `UsageEventPage` → `KeyError` khi guard đi theo ref. Đây là lỗi **nghiêm trọng nhất** của cycle: nếu tôi chỉ liệt kê tên schema mà không đi theo `$ref`, artifact sẽ ship một ref không resolve được mà trông vẫn "đúng". Đã thêm `DANGLING-REFS=0` (E10) để chắc không còn ref nào treo.
5. **JS toolchain, lặp lại lần nữa**: backtick trong docstring Python chặn parser JS. Đã ghi vào memory để dùng `chr(96)` khi dựng chuỗi có backtick.
6. `io.open(path).exists()` là vô nghĩa trên một file object → `AttributeError`; đổi sang `os.path.exists`.
## 44 — CYCLE 44: đồng bộ CR28-04/05/06 vào docs/28 + docs/35 (v1.47.0 → v1.48.0)

> **RESUME POINT — cycle 44 (packet đồng bộ CR28, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–43 giữ nguyên phía trên như lịch sử.
> 1. **Hai file, version bump 1.47.0 → 1.48.0** ở cả `docs/28-test-inventory.md` và `docs/35-acceptance-baseline.md`. Không tick task row, không đổi verdict gate.
> 2. **Không dùng lời packet làm sự thật.** Packet nói "trạng thái hoàn thành"; mức thực tế đọc từ receipt: CR28-06 **có** receipt độc lập, CR28-04 **chỉ** có receipt của chính lane thực hiện và **seam production chưa bật**, CR28-05 **không có test suite nào**. Ghi đúng như vậy, nói ra khác packet.
> 3. **Đường dẫn lạ** trong report: receipt CR28-04 **không** ở `tester.md` mà ở `qwen-platform.md` Muc 26 — vì CR28-04 do Qwen-Platform code, Tester chưa có gói kiểm độc lập cho nó. Đã trích đúng file, không quy về một chỗ quen thuộc.

### 44.1 Bảng bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | Nguồn CR28 | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md` — 6 finding, trạng thái *"review/plan only, chưa dispatch, chưa ACCEPTED"*; CR28-04/05/06 là dòng 12/13/14 |
| E2 | Census trước | `docs/28` bytes=293794 crlf=1034 bareLF=9 sha16=`877e7dcc3a0f616b`; `docs/35` bytes=268026 crlf=1101 bareLF=5 sha16=`433c361305467c1b`; cả hai version `1.47.0` |
| E3 | Census sau | `docs/28` sha16=`500c192759c2fd6d`; `docs/35` sha16=`a9de1fce8b139bde`; cả hai version `1.48.0` |
| E4 | EOL | `docs/28` bareLF **9 → 9**; `docs/35` bareLF **5 → 4** — splice chạy trên `splitlines(keepends=True)` nên byte cũ không bị viết lại, chỉ chèn dòng CRLF mới |
| E5 | CR28-04 (implementer, **không** phải Tester) | `runtime-encryption-metadata.test.ts` **32/32** (23 cũ + 9 mới), exit 0; 6 suite liên quan xanh; mutation **M1 hợp lệ** (2 case đỏ), **M2 báo là không hợp lệ** chứ không ghi xanh; restore byte-exact `submission.ts` sha `e25670af` / 32535 B |
| E6 | CR28-04 full Orchestrator | `3 failed, 1 skipped, 95 passed, 98 of 99` / `3 failed, 28 skipped, 2076 passed, 2107 total`; 3 đỏ là **tập con của 6 đỏ lúc baseline** (`admin-shell-session-lifecycle`, `admin-operations-list-pagination`, `adm-base-03-safe-error-offline`) do lane Admin/OIDC tự sửa — lane Platform **không** sửa và **không** gán công dọn |
| E7 | CR28-05 | `docker build` exit **0** cho cả hai image (digest `sha256:5c6d3063…`, `sha256:af02bc3e…`); `node --check` exit 0 cho cả hai entrypoint; **không có test suite nào** được yêu cầu hay thay đổi |
| E8 | CR28-06 owner | `2 suites / 34 tests` exit 0; full worker-sdk **19/20 suites, 320/322** exit 1 (`network-boundaries.boundary.test.ts`) |
| E9 | CR28-06 **independent** | 3 lần chạy liên tiếp, mỗi lần **1 suite / 10 tests** exit 0; `tsc --noEmit` exit 0; receipt tự khai independent |
| E10 | Link checker ×3 | S0 `FILES=8 TARGETS=1038 BROKEN=0`; S1 `FILES=11 TARGETS=1122 BROKEN=0`; TREE `BROKEN=2` — **cùng hai** link hỏng có sẵn ở `antigravity-6.md:8952` và `requests/antigravity.md:10` |
| E11 | Δ TARGETS | 1031→1038 và 1115→1122 = **+7 link**, đều là link **mới của tôi** trong các mục này. Các lần trước tăng TARGETS là của lane khác; lần này tăng là của tôi và đã đếm |

### 44.2 Δ

- **Δ-A45-1 (quan trọng nhất — packet nói "hoàn thành", đo được thì chưa):** **CR28-04 chưa hoàn thành theo nghĩa acceptance của finding.** Finding yêu cầu *"Test DB/Redis/log byte scan với sentinel, cross-tenant và retry; không đóng chỉ bằng test `metadata-crypto.ts` cô lập"*. Thực tế: Δ61 **production chưa bật seam** (`server.ts:423` không truyền `metadataCrypto`), Δ63 **chưa có e2e test** qua `createSubmissionService`, và **không có receipt Tester nào**. Chính lane thực hiện ghi: CR28-04 *"sẵn sàng, chưa có hiệu lực"*. Tôi ghi đúng mức đó, không ghi "hoàn thành".
- **Δ-A45-2:** **CR28-05 không có test suite nào** và receipt nói rõ *"no source test suite was required or changed"*. Packet yêu cầu ghi "các test suites liên quan" — với CR28-05 câu trả lời trung thực là **không có**, và tôi ghi rõ là không có thay vì im lặng bỏ qua.
- **Δ-A45-3 (attribution):** chỉ **CR28-06** có receipt độc lập. CR28-04 và CR28-05 **không** — nên tôi không gắn nhãn "independent" cho chúng. Quy tắc của lane: chỉ gắn khi receipt **tự** nói mình độc lập.
- **Δ-A45-4 (một chỗ tôi sửa, nói ra):** receipt độc lập CR28-06 tự ghi *"3/3 runs, 3/3 suites, 30/30 test executions"*. Đọc lệnh bên dưới: cả **ba** lần đều chạy **cùng một** `tests/connector-invoker.test.ts`, mỗi lần **1 suite / 10 tests**. Nên "3/3 suites" là **cùng một suite chạy ba lần**, không phải ba suite khác nhau. Tôi ghi số **theo từng lần chạy** thay vì chép nguyên cụm từ receipt.
- **Δ-A45-5 (bổ sung ngoài yêu cầu, nói ra):** mục CR28-06 trong `docs/28` trước đây **chỉ** ghi receipt của lane thực hiện, thiếu receipt độc lập đã tồn tại từ 12:26. Tôi bổ sung nó vào **cùng mục** và thêm một câu vào đoạn CR28-06 ở `docs/35`. Đây là mục tiêu thứ hai của packet (CR28-06) nên nằm trong phạm vi, không phải mở rộng.
- **Δ-A45-6 (vẫn mở, không phải việc packet này):** hai link TREE `BROKEN` ở `antigravity-6.md:8952` và `requests/antigravity.md:10` **vẫn hỏng**, y hệt cycle 42 và 43. Ngoài lane này, không sửa.

### 44.3 Lỗi của chính tôi (đều bị bắt trước khi ghi receipt)

1. **Sai format dòng version**: tôi khoá version bằng tiền tố backtick, nhưng dòng thật là `**Document Version:** 1.47.0` không backtick → guard "matched 0 times". Bắt bằng cách in nguyên văn 6 dòng đầu rồi sửa, không đoán lần nữa.
2. **Typo chỉ số**: `lines[i[0].rstrip(...)]` thay vì `lines[i[0]].rstrip(...)` → `AttributeError`. Nhánh `docs/28` đã ghi xong trước khi lỗi này xảy ra, nên tôi viết script riêng cho `docs/35` thay vì chạy lại toàn bộ (chạy lại sẽ vấp drift guard của chính file đã sửa — đúng như thiết kế).
3. **Hai lỗi markdown tự tạo**: ở `docs/35` mục CR28-05 dính liền dòng trước (thiếu dòng trống), ở `docs/28` bullet CR28-06 mới nhảy thẳng xuống heading kế tiếp. Bắt bằng cách dump lại vùng vừa sửa, sửa bằng script riêng, rồi chạy link check lại.
4. **Tôi đoán số dòng thay vì định vị theo nội dung — lặp lại đúng bẫy đã ghi.** Ở bước assert cuối, tôi đoán 3 dòng trong `docs/28` và **cả 3 sai** (1030/1044/1053 trong khi thật là 1031/1048/1056), vì bullet CR28-06 thêm ở **giữa** file đã dịch mọi dòng phía dưới. Bắt bằng cách định vị lại theo nội dung: cả 4 mục đúng và **mỗi mục đúng một lần**; sửa số trong assert rồi chạy lại thì `MINE_ANCHOR_FAILS=0`. Đây là lần thứ hai trong hai cycle liên tiếp tôi phạm cùng một lỗi này, nên tôi ghi thẳng vào receipt thay vì chỉ sửa im lặng.
## 45 — CYCLE 45: D-DOCS-CR28-TRACEABILITY-SYNC — ma trận truy vết CR28-02..06 vào docs/19

> **RESUME POINT — cycle 45 (packet `D-DOCS-CR28-TRACEABILITY-SYNC`, task `task_754289181e16`, dispatch `ctx_12ff8ef27c46`, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–44 giữ nguyên phía trên như lịch sử.
> 1. **Một mục mới trong `docs/19`**: ma trận 5 dòng CR28-02..06 với **8 cột** (finding, severity, producer/consumer paths, test suites, receipts, evidence state, orchestration state, still open). Cột "orchestration state" tách khỏi "evidence state" **vì hai thứ khác nhau** — CR28-02 có receipt nhưng task vẫn `dispatched`, CR28-03 thì ngược lại.
> 2. **Hai file khác cũng sửa, nói ra**: `docs/28` và `docs/35` từng ghi rằng CR28-04 **không** có receipt Tester. Điều đó **đúng lúc viết** nhưng nay sai: receipt `T-CODEX-OFFLINE-CR28-04-INDEPENDENT` đã xuất hiện lúc **13:07:22**, sau cycle 44 của tôi. Tôi thêm bullet/câu **supersede** bên cạnh, **không** xoá lịch sử.
> 3. **`docs/19` không có dòng Document Version** (16 chỗ chữ "Version" trong file đều là văn xuôi, không phải header). Tôi **không** tự chế một dòng version để bump — ghi rõ thay vì giả vờ.

### 45.1 Bảng bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | Nguồn finding | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md` dòng 9–14 = CR28-01..06; header ghi *"review/plan only, chưa dispatch, chưa ACCEPTED"* |
| E2 | Trạng thái vòng đời (đọc từ orchestration, không từ prose) | `19a47f09e43d` CR28-04 **completed**; `e2c09d94e4e5` V-OFFLINE-CR28-04 **completed**; `193a071b0d41` CR28-06 **completed**; `0ca8f59aa81d` V-OFFLINE-CR28-06 **completed**; `cf42b52cec76` CR28-05 **completed**; `048d60321fab` CR28-02 **dispatched**; `398f8a7b0021` CR28-03 **dispatched** |
| E3 | CR28-04 receipt độc lập | `tester.md:8906`, 2026-09-28T13:07:22, read-only: 3 lần chạy, **mỗi lần 1 suite / 32 test** exit 0; orchestrator `tsc --noEmit` exit 0 |
| E4 | CR28-06 receipt độc lập | `tester.md:8823`, 2026-09-28T12:26:56, read-only: 3 lần chạy, **mỗi lần 1 suite / 10 test** exit 0; worker-sdk `tsc --noEmit` exit 0 |
| E5 | CR28-02 — lệch giữa receipt và task | receipt `W-CR28-02` (8880) có 46 worker-sdk + 37 doc-core + 10 connector, nhưng task `048d60321fab` vẫn **dispatched**; mục post-build correction (docs/19:593) ghi doc-core focused rerun **fail** tại `src/worker.ts:319` |
| E6 | CR28-03 — chưa có gì để truy | receipt `W-CR28-03-OCR-BYTES` **không tồn tại** trong `tester.md`; `V-OFFLINE-INGEST-WIRE-01` trạng thái **failed** |
| E7 | Hình dạng bảng | header và cả 5 dòng đều **10 ô** (không lệch cột); dòng CR28-02 nằm ở dòng 602 |
| E8 | Link checker ×3 | S0 `FILES=8 TARGETS=1051 BROKEN=0`; S1 `FILES=11 TARGETS=1135 BROKEN=0`; TREE `BROKEN=2` — **cùng hai** link hỏng có sẵn, y hệt cycle 43/44 |
| E9 | Δ TARGETS | 1038→1051 và 1122→1135 = **+13 link**, đều là link **mới của tôi** trong ma trận và hai mục supersede |
| E10 | `git diff` docs/19 | **+34 / −0**: khối ma trận là **thuần thêm**, không sửa và không xoá dòng cũ nào |

### 45.2 Δ

- **Δ-A46-1 (thay đổi attribution, nói thẳng):** cycle 44 của tôi ghi CR28-04 "**không có receipt Tester nào**". Câu đó **đúng tại thời điểm ghi** và **sai ngay sau đó**: receipt độc lập xuất hiện lúc 13:07:22. Nay đã bổ sung ở cả ba file, giữ nguyên lời cũ làm lịch sử. Bài học thu được: trong repo này receipt Tester có thể **đến sau** lúc mình ghi, nên mọi claim về "chưa có receipt" phải kèm **mốc thời gian**, không viết như sự thật vĩnh viễn.
- **Δ-A46-2:** CR28-02 và CR28-03 cho thấy hai loại "chưa xong" **khác nhau** và cần ghi khác nhau. CR28-02 **có** receipt đầy đủ nhưng task vẫn `dispatched` và doc-core focused rerun đang fail ở chỗ **ngoài phạm vi finding**. CR28-03 **không có** receipt nào. Gộp cả hai thành "chưa hoàn thành" là mất thông tin, nên ma trận tách hai cột.
- **Δ-A46-3 (bẫy diễn đạt trong receipt, đã ghi vào docs/19):** cả hai receipt độc lập tự ghi *"3/3 runs, 3/3 suites, N/N test executions"*, nhưng ba lần chạy là **cùng một suite** (CR28-04: 3×32=96; CR28-06: 3×10=30). Người đối chiếu tổng số này với số suite sẽ **đếm thừa** mức phủ. Tôi ghi số **theo từng lần chạy**.
- **Δ-A46-4 (ngoài phạm vi, báo coordinator):** **CR28-01 chưa có mục nào** trong `docs/19`, `docs/28`, `docs/35` (grep 0 hit) dù nằm trong danh sách 6 finding. Trạng thái vòng đời cũng đang tách đôi: `W-CR28-01-ENCRYPTED-READ-PATH` là **failed**, còn `W-CR28-01-ENCRYPTED-READ-PATH-EXEC` là **dispatched**. Tôi ghi rõ là ngoài phạm vi trong `docs/19` thay vì lấp chỗ trống bằng suy đoán.
- **Δ-A46-5:** hai link TREE `BROKEN` ở `antigravity-6.md:8952` và `requests/antigravity.md:10` **vẫn hỏng**, y hệt ba cycle liếp trước. Ngoài lane, không sửa.

### 45.3 Lỗi của chính tôi (đều bị bắt trước khi ghi receipt)

1. **`str.splitlines(keepends=True)` là LOSSLESS-CHALLENGED, tôi đã dùng sai.** Nó tách thêm trên `\v`, `\f`, `\x1c`, `\x85`, `\u2028`, `\u2029`, và `"".join()` **không** khôi phục được các separator đó. Tôi đã đổi sang `split("\n")` + `join("\n")` kèm assert **round-trip byte-identical trước** mọi chỉnh sửa. Đây là bài học phải nhớ cho mọi lần ghép file về sau.
2. **`tail[:-1]` làm rơi đúng một dòng.** Tôi dùng nó để giữ đặc tính "không có newline cuối" của `docs/19`, nhưng nó **xoá mất dòng cuối cùng của nội dung tôi vừa thêm** (bullet "No acceptance moves"). Bắt bằng cách đối chiếu từng dòng fragment với file; vá lại đúng 1 dòng, không thêm gì dư.
3. **Tôi hoảng nhầm một lần rồi tự kiểm chứng lại.** Log in ra cho thấy `bareLF 43 -> 0` trong `docs/19`; tôi đọc đó là mất dữ liệu. Đo thật (`git show HEAD` + so từng dòng) mới biết file **= HEAD + 33 dòng thuần thêm**, 43 bare LF còn nguyên, và 43→0 là do chính lần ghi bằng `splitlines` cắt separator rồi file được chuẩn hoá lại. Tôi **không** sửa theo phản xạ, mà sửa theo phép đo.
4. **Một assert của tôi fail vì needle của tôi sai, không phải vì nội dung.** Tôi tìm cụm `still **dispatched** despite holding a receipt` xuyên qua bảng markdown — không thể khớp vì có `|` ngăn cách ô. Sửa needle thành kiểm **từng ô**; nội dung vốn đã đúng.
5. **Backtick kép do chính tôi sinh ra** trong ô orchestration của dòng CR28-02, làm hỏng span `**...`...`**`. Quét cả khối tìm `` `` `` → đúng 1 chỗ → sửa, xác nhận ô còn 10 cột khớp header.
6. `print` với nhiều `%` placeholder tôi đếm sai **hai lần**, mỗi lần đều xảy ra **sau** khi file đã ghi → script chết sau khi đã sửa xong. Không mất dữ liệu, nhưng làm mất thời gian; bài học: in bằng nhiều lệnh `print` đơn giản thay vì một format dài.
## 46 — CYCLE 46: D-DOCS-CR28-01-BASELINE-SYNC — bổ sung finding CR28-01 vào docs/19 + docs/28 + docs/35

> **RESUME POINT — cycle 46 (packet `D-DOCS-CR28-01-BASELINE-SYNC`, task `task_5ef844b5f918`, dispatch `ctx_7b66f45b5631`, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–45 giữ nguyên phía trên như lịch sử.
> 1. **Đây chính là Δ-A46-4 của cycle 45**: tôi đã báo CR28-01 là finding duy nhất **không** có mục nào trong `docs/19`/`docs/28`/`docs/35`. Nay đã đóng, và `docs/19` đã **đổi tên** ma trận từ `CR28-02..06` thành `CR28-01..06` — 6 dòng, đều **10 ô** khớp header.
> 2. **Con số "14/14" tôi KHÔNG chép, tôi đếm lại từ test file**: **14 khối `it`/`test` khai báo, `it.each` = 0** ⇒ số khai báo **bằng** số chạy thật. Không có bẫy "đếm declaration rồi tưởng là executed" ở đây.
> 3. **Cùng cái bẫy diễn đạt lần thứ ba**: receipt độc lập ghi *"3/3 suites, 42/42 test executions"* — 42 = 3 × 14 của **cùng một suite**. Giống CR28-04 và CR28-06. `docs/19` nay ghi số **theo từng lần chạy**.

### 46.1 Bảng bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | Đếm test từ source | `services/orchestrator/tests/artifact-read-decrypt-offline.test.ts`: 302 dòng, 11519 B; **14** dòng khai báo `it`/`test`, **0** `it.each`, 3 `describe` |
| E2 | Claim 14/14 của packet | **Khớp**: implementer chạy targeted **x3** + 1 lần sau restore, mỗi lần `1 passed suite, 14 passed tests` exit 0 |
| E3 | Receipt độc lập | `tester.md:8974`, 2026-09-28T13:57:33+07:00, read-only: 3 lần, mỗi lần **1 suite / 14 tests** exit 0; orchestrator `tsc --noEmit` exit 0 |
| E4 | Trạng thái vòng đời | `ae6cf869ed78` W-CR28-01-ENCRYPTED-READ-PATH **failed** (bị thay thế); `a1c71649b5e0` …-PATH-EXEC **completed**; `a30c25c0d96e` V-OFFLINE-CR28-01-READ-DECRYPT **completed** |
| E5 | Cổng fail-closed đọc từ source | 9 nhánh đều fail-closed; **không** nhánh nào rơi về phục vụ ciphertext |
| E6 | Mutation | M1 (tắt kiểm `du-manifest-key`) → đúng 1 test đỏ, đúng case pointer-mismatch. **M2 không cắn và không được tính** — bỏ chốt `upload_token` vẫn 14/14 vì AAD vẫn fail-closed; test khẳng định **kết cục**, không khẳng định **nguyên nhân** |
| E7 | Baseline trước thay đổi | `3 failed, 1 skipped, 96 passed, 99 of 100` suite / `3 failed, 28 skipped, 2133 passed, 2164` test; 3 đỏ là bộ admin-shell ngoại lai quen thuộc |
| E8 | Census docs trước | `docs/28` sha16=`72fcb478783e570e`; `docs/35` sha16=`1dc4ab13d340868d`; `docs/19` sha16=`a7d0e3152890d6e8` |
| E9 | Census docs sau | `docs/28` bytes 299750→302727; `docs/35` 271531→273160 (sau khi thêm mốc thời gian); `docs/19` 138206→140141, crlf 567→566 |
| E10 | Hình dạng ma trận | 6 dòng CR28-01..06 tại dòng 602–607, **mỗi dòng 10 ô**, khớp header ở dòng 600 |
| E11 | Link checker ×3 | S0 `FILES=8 TARGETS=1054 BROKEN=0`; S1 `FILES=11 TARGETS=1138 BROKEN=0`; TREE `BROKEN=2` — **cùng hai** link hỏng có sẵn ở `antigravity-6.md:8952` và `requests/antigravity.md:10` |
| E12 | Δ TARGETS | 1051→1054 và 1135→1138 = **+3 link**, đều là link **mới của tôi** (1 ở docs/28, 2 ở docs/35) |

### 46.2 Δ

- **Δ-A47-1 (đóng Δ-A46-4):** CR28-01 nay có đủ ba nơi. Bullet "deliberately outside this section" trong `docs/19` đã **bị thay** bằng trạng thái thật; ma trận được đổi tên sang `CR28-01..06`. Đây là lần thứ hai trong hai cycle tôi đóng đúng một Δ mà chính mình đã báo.
- **Δ-A47-2 (rủi ro thật, nêu rõ):** Δ66 là khe hở **thiết kế**, không phải bug cục bộ — cờ bật là **toàn cục chứ không theo object**. Tắt `publicUploadEncryption` khi store còn object đã seal ⇒ `artifactDecryptDeps = null` ⇒ route rơi về `getBlob` và **phục vụ ciphertext thở** trở lại, kèm 503 trên mọi lần đọc object sealed nếu thiếu facade. Người đọc **không thể** biết object đã seal hay chỉ từ cờ. Khuyến nghị của lane thực hiện (giữ cờ bật bằng cờ tắt, hoặc persist cột `encrypted_at`) là **quyết định vận hành của coordinator**, tôi không tự làm và không ghi là đã xong.
- **Δ-A47-3 (acceptance của finding chưa đạt, nói thẳng):** finding yêu cầu fixture S3/PG thật đã mã hóa, tamper, **restart**, external client nhận plaintext gốc sau khi mở lớp delivery, và Tester live giữ DB window. 14 test chỉ phủ tamper + foreign tenant qua `StoredObjectReader` giả; **restart**, fixture thật, lớp delivery và DB window đều chưa có.
- **Δ-A47-4 (ghi để không ai đếm sai):** receipt độc lập ghi `42/42 test executions` — đó là 3 × 14 của **cùng một suite**, không phải 42 test khác nhau. Cùng cái bẫy với CR28-04 (`96`) và CR28-06 (`30`). Trong repo này cụm "3/3 suites" của các receipt Tester nghĩa là **3 lần chạy của 1 suite**.
- **Δ-A47-5 (việc đang chạy, không phải việc tôi):** `W-CR28-01-HTTP-ROUTE-TEST` (`task_6a61c55ffe81`) đang `dispatched` — đúng vào Δ67 (test tầng route qua `GET /artifacts/{id}/download`). Ma trận ghi việc này để người đọc biết khe hở đang được bịt, không phải bị bỏ.

### 46.3 Lỗi của chính tôi

1. **Hai assert của tôi fail vì needle viết sai, không phải vì nội dung** — một cái do **case** (`all six` so với `All six` ở đầu câu), một cái do **thiếu mốc thời gian** trong bản nháp docs/35. Cả hai lần tôi đều kiểm lại bằng **đọc nội dung thật** thay vì sửa tài liệu cho khớp needle; riêng mốc thời gian thì tôi **thêm vào tài liệu** vì đó là thiếu sót thật, không phải lỗi needle.
2. **In bảng kiểm chứng thiếu phép so sánh case** nên tôi suýt coi một FAIL là lỗi nội dung. Đã thêm kiểm tồn tại theo cả hai dạng hoa/thường ở vòng verify sau.
## 47 — CYCLE 47: D-DOCS-CR28-COMPLETE-SYNC — đối chiếu 6 finding CR28 với tester receipts, docs/35 lên 1.49.0

> **RESUME POINT — cycle 47 (packet `D-DOCS-CR28-COMPLETE-SYNC`, task `task_1cf9f0ac9021`, dispatch `ctx_1958294b0537`, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–46 giữ nguyên phía trên như lịch sử.
> 1. **Hai file yêu cầu**: `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md` (+1 mục đối chiếu 6 finding, **và** sửa dòng header đang ghi *"review/plan only, chưa dispatch"* — câu đó sai ngay trước mắt) và `docs/35-acceptance-baseline.md` (+1 mục, version **1.48.0 → 1.49.0**).
> 2. **Đọc receipt trực tiếp, không đọc lời packet.** Số liệu lấy từ `tester.md` và từ trạng thái task thật; hai cột **evidence state** và **orchestration state** tách riêng vì chúng khác nhau (CR28-02 có receipt owner nhưng chưa có receipt độc lập; CR28-03 có receipt owner nhưng finding yêu cầu **live**).
> 3. **Một sự kiện lớn xảy ra giữa cycle 46 và 47**: CR28-03 **đã có** receipt owner (`W-CR28-03-OCR-BYTES`, tester.md 8999) — ở cycle 45/46 nó còn **không có gì**. Và **CR28-08 xuất hiện**, không nằm trong sheet 6-finding.

### 47.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | CR28-01 | Owner `artifact-read-decrypt-offline` 14/14 x3 + 1 lần sau restore, tsc 0 **log rỗng**; độc lập `T-CODEX-OFFLINE-CR28-01-INDEPENDENT` (tester.md 8974, 13:57:33) 3 lần × 1 suite/14 test, tsc 0 |
| E2 | CR28-02 | `W-CR28-02-WORKER-SERVICE-AUTH` (tester.md 8880): 46 worker-sdk + 37 doc-core + 10 connector, 3 typecheck 0. Post-build correction: doc-core focused rerun **fail** tại `src/worker.ts:319` (artifact conversion, **ngoài** phạm vi finding). **Chưa** có receipt độc lập cho CR28-02 |
| E3 | CR28-03 (**mới có**) | `W-CR28-03-OCR-BYTES` (tester.md 8999, 14:00:00): contracts 21, connector 21, doc-core 18, worker-sdk 5, orchestrator 19 — tất cả exit 0; 3 vòng typecheck **15/15** exit 0. Bổ sung: doc-core full offline 46/46 suite, **545 → 547** test, x3 |
| E4 | CR28-04 | Owner 32/32 (23+9); độc lập `T-CODEX-OFFLINE-CR28-04-INDEPENDENT` (tester.md 8906, 13:07:22) 3 lần × 1 suite/32 test, tsc 0 |
| E5 | CR28-05 | `CR28-05-DOCKER-BUILD` (tester.md 8864): 2 image exit 0 có digest, `node --check` 0, **không có test suite nào**; dịch vụ chưa khởi động với PG/Redis thật |
| E6 | CR28-06 | Owner 2 suite/34; độc lập `T-CODEX-OFFLINE-CR28-06-TAXONOMY-INDEPENDENT` (tester.md 8823, 12:26:56) 3 lần × 1 suite/10 test, tsc 0 |
| E7 | **CR28-08 (mới, ngoài sheet)** | `W-CR28-08-METADATA-CRYPTO-SEAM` (task `4552e96812fa`) + `V-OFFLINE-CR28-08-METADATA-SEAM` (`44f1c98e05bb`): cả hai **completed**; receipt độc lập (tester.md 9033, 14:29:08) 3 lần × **1 suite/37 test**, tsc 0. Đây chính là bằng chứng đóng **Δ61** của CR28-04 |
| E8 | Trạng thái task (đọc trực tiếp) | `completed`: CR28-01-EXEC, V-OFFLINE-01, CR28-01-HTTP-ROUTE-TEST, CR28-02, CR28-04, V-OFFLINE-04, CR28-05, CR28-06, V-OFFLINE-06, CR28-08, V-OFFLINE-08. `failed`: `ae6cf869ed78` (CR28-01 bản đầu). `dispatched`: CR28-03, V-OFFLINE-01-HTTP-ROUTE, CR28-01-CHUNKED-DECRYPT-TEST |
| E9 | Anchor drift — **phát hiện do tôi** | Header Mục 26 và Mục 28 của `qwen-platform.md` đã dịch **2597→2600** và **2766→2767**. Link của chính tôi trong `docs/19` (2 link), `docs/28` (1), `docs/35` (1) vẫn **còn trong khoảng** nên `BROKEN=0` **không** bắt. Đã repoint và content-assert: L2600 và L2767 đều đúng heading |
| E10 | Hình dạng bảng | Bảng 6 finding trong sheet: header 6 ô, mỗi dòng **đúng 6 ô**, mỗi finding **đúng 1 dòng** |
| E11 | Link checker ×3 | S0 `FILES=8 TARGETS=1056 BROKEN=0`; S1 `FILES=11 TARGETS=1140 BROKEN=0`; TREE `BROKEN=2` — **cùng hai** link hỏng có sẵn ở `antigravity-6.md:8952` và `requests/antigravity.md:10` |
| E12 | Δ TARGETS | 1054→1056 và 1138→1140 = **+2 link**, đều là link **mới của tôi** trong hai mục vừa thêm |

### 47.2 Δ

- **Δ-A48-1 (CR28-03 đã có receipt, ở cycle trước chưa):** Tôi đã ghi ở cycle 45/46 rằng CR28-03 **không có gì để truy**. Nay `W-CR28-03-OCR-BYTES` đã có đủ 5 suite + 15 typecheck. Nhưng finding yêu cầu **live** multi-container OCR/digitize và receipt tự nói *"no live provider"*, nên trạng thái đúng là **owner verified, chưa đạt acceptance** — không phải "xong".
- **Δ-A48-2 (finding thứ 7 ngoài sheet):** **CR28-08** có cả task lẫn receipt độc lập đã `completed`, sinh ra **sau** khi sheet 6-finding viết. Tôi **không** tự thêm nó thành dòng thứ 7 vào sheet (nằm ngoài phạm vi packet) mà **báo** để coordinator quyết định — và ghi rõ nó là bằng chứng đóng Δ61 của CR28-04.
- **Δ-A48-3 (dòng header của sheet đã sai):** Sheet ghi *"review/plan only, chưa dispatch"* trong khi cả 6 finding đã có packet đã dispatch và phần lớn đã `completed`. Tôi sửa thành *"6 finding đã có bằng chứng offline; 0/6 ACCEPTED"* — nói rõ **0/6** để không ai đọc nhầm là đã nghiệm thu.
- **Δ-A48-4 (Δ61 có thể đã đóng, nhưng tôi KHÔNG tự kết luận):** CR28-08 nối `metadataCrypto` vào runtime, và receipt độc lập xác nhận wiring ở `server.ts` dòng 520-532. Điều này **gợi ý** Δ61 của CR28-04 đã được xử lý, nhưng **chính receipt CR28-04** chưa cập nhật và Δ61 vẫn chưa được ai đóng trong bảng của tôi. Tôi ghi sự thật (có task+receipt cho seam) và **không** tick Δ61.
- **Δ-A48-5 (bẫy đếm số, lần thứ tư):** receipt CR28-08 cũng tự ghi *"3/3 suites, 111/111 executions"* — 111 = 3 × 37 của **cùng một suite**. Cùng loại với CR28-01 (42), CR28-04 (96), CR28-06 (30). Đã ghi cảnh báo vào **cả hai** file. |
- **Δ-A48-6:** hai link TREE `BROKEN` vẫn ở `antigravity-6.md:8952` và `requests/antigravity.md:10`, y hệt bốn cycle trước. Ngoài lane, không sửa.

### 47.3 Lỗi của chính tôi

1. **Công cụ quét anchor của tôi báo sai lan sang link không liên quan.** Tôi viết probe chỉ kiểm 2 heading Mục 26/28 nhưng lại áp lên **mọi** link vào `qwen-platform.md`, nên nó gắn nhãn "STALE" cho 30+ link cũ hoàn toàn không liên quan (Mục 14, 21, 22, 23...). Tôi **không** sửa những link đó — chúng ngoài phạm vi và probe của tôi không có giá trị chứng minh chúng hỏng. Tôi chỉ repoint **2 link thật sự trôi** của mình. Bài học: một probe chỉ kiểm N mục tiêu thì **không được** kết luận về các mục tiêu nó không kiểm.
2. **Tôi suýt ghi "0/6 ACCEPTED" mà không kiểm `APPROVED` của Claude Code.** Sheet yêu cầu `Claude Code review APPROVED` trước khi coordinator đóng acceptance. Tôi **không** có bằng chứng `APPROVED` nào, nên tôi ghi `0/6 ACCEPTED` kèm nguồn là "không tìm thấy `APPROVED` nào" — không phải khẳng định đã tra cứu đầy đủ.
## 48 — CYCLE 48: D-DOCS-CR28-FINAL-CONSOLIDATION — gom 5 nhóm bằng chứng mới vào docs/19 + docs/28 + docs/35 (1.50.0)

> **RESUME POINT — cycle 48 (packet D-DOCS-CR28-FINAL-CONSOLIDATION, task task_749fc5614c1a, dispatch ctx_e02388577208, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–47 giữ nguyên phía trên như lịch sử.
> 1. **Ba file, mười hai chỗ sửa**: docs/28 **+5 mục**, docs/35 **+1 mục** và version **1.49.0 → 1.50.0**, docs/19 **thay 2 dòng ma trận** (CR28-01, CR28-03) **+1 mục** mới. Không tick row, không đổi verdict gate.
> 2. **Con số trong receipt tôi ĐẾM LẠI, không chép**: chunked **23/23** → tôi đếm **23** khai báo it/test, **it.each = 0**, 5 describe ⇒ khai báo **bằng** chạy thật. Với **105 tests** của CR28-03 tôi **không** đếm lại được (nó là tổng 5 package), nên tôi ghi rõ đó là **tổng theo receipt**, không phải số tôi tự kiểm.

### 48.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **CR28-01 chunked 23/23** | Receipt qwen-platform.md Muc 31 (L3037): targeted x3 **23 passed, 23 total** Exit **0/0/0**; tsc Exit 0 **log rỗng**; module restore byte-exact 64b22116. **Tôi đếm lại từ file**: 23 khai báo it/test, 0 it.each, 5 describe, trong đó 3 test trực tiếp nhánh chunked. Mutation **M1b hợp lệ** (2 đỏ đúng mục tiêu); M1a **không** hợp lệ (TS narrow, không compile) |
| E2 | **Δ68 đóng ở mức module, không phải mức route** | Chính receipt nói test chunked gọi decryptStoredArtifact trực tiếp, **không** qua HTTP. **Δ71 mới**: object chunked ở mặc định 65 536 chunk có thể sinh manifest vượt trần đọc **8 MiB** ⇒ 413/503. **Δ72 mới**: runtime openMetadata dùng readStored, là **seam khác** với decryptStoredArtifact |
| E3 | **CR28-01 HTTP route — independent** | T-CODEX-OFFLINE-CR28-01-ROUTE-INDEPENDENT (tester.md 9080, 14:58:05, read-only): 3 lần × **1 suite / 6 test** exit 0; orchestrator tsc 0. Bao phủ download + worker blob với sealed, broken-seal, unsealed. **Không** có live S3/DB/Vault/HTTP production |
| E4 | **CR28-03 — 105 tests** | W-CR28-03-OCR-BYTES validation update (tester.md L9069, 14:53:53): contracts 1/21, connector 1/21, orchestrator 2/19, worker-sdk 2/7, doc-core 4/37 = **10 suite / 105 test** exit 0; 3 vòng typecheck **15/15** |
| E5 | **Workspace typecheck** | WORKSPACE-TSC-VERIFY (tester.md 9073): pnpm -r exec tsc --noEmit ExitCode **0**, **không** diagnostic toàn workspace; 5 package check lại độc lập, cả 5 exit 0 |
| E6 | **Caveat có thời điểm** | Receipt T-CODEX-OFFLINE-ADM-UX-03-TOOLBAR-INDEPENDENT (tester.md 8947, **13:33:27**) ghi orchestrator typecheck **exit 1**, run typecheck **exit 2**, TS2304 Cannot find name readStreamBounded tại server.ts 184/190, quy cho server.ts đang bị sửa đồng thời. Các receipt sau (14:58) và workspace sweep đều 0 ⇒ **thoáng qua, không phải lỗi hiện hành**. Đã ghi kèm mốc thời gian |
| E7 | **Admin audit mount** | qwen-admin.md Muc 35 (L3955): mới tests/admin-audit-mount.test.ts **6 test** loopback HTTP, không DB/Redis; typecheck 0; mount **6/6 x3**; audit route **17/17**; hồi quy 5 suite shell **275/275**. Phát hiện chính của receipt: attachAdminShell **đã có sẵn** ở server.ts:869, thứ thật sự thiếu là **default audit fetcher** (thêm ở cycle 34) |
| E8 | **Lệch danh tính task — báo, không tự hoà giải** | Orchestration gọi việc này là W-ADM-UX-08-AUDIT-MOUNT (task_66c5a3888b06, completed), còn header receipt là W-ADM-UX-03-AUDIT-MOUNT-VERIFICATION (task_a848fbd749d6, completed). **Hai task id khác nhau** cho một việc trông như một |
| E9 | Hình dạng ma trận docs/19 | 6 dòng CR28-01..06, **mỗi dòng 10 ô** khớp header; hai dòng thay (CR28-01, CR28-03) được assert cell-count **trước** khi ghi |
| E10 | Link checker ×3 | S0 **FILES=8 TARGETS=1059 BROKEN=0**; S1 **FILES=11 TARGETS=1143 BROKEN=0**; TREE **BROKEN=2** — **cùng hai** link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E11 | Δ TARGETS | 1056→1059 và 1140→1143 = **+3 link**, đều là link **mới của tôi** |

### 48.2 Δ

- **Δ-A49-1 (quan trọng — Δ68 KHÔNG đóng trọn vẹn):** Coordinator ghi "Chunked decrypt tested (Δ68 closed)". Receipt của chính lane đó nói rõ Δ68 chỉ đóng **ở mức module**, và **mở thêm Δ71** (trần manifest 8 MiB vs 65 536 chunk) cùng **Δ72** (hai seam khác nhau). Tôi ghi đúng phạm vi hẹp, không chép câu "closed" của coordinator.
- **Δ-A49-2:** CR28-01 nay có **hai tầng** bằng chứng độc lập (module 3×14→3×23, route 3×6) — Δ67 đóng ở cả hai phía. Nhưng **Δ66** (cờ bật toàn cục) vẫn là quyết định vận hành chưa ai đóng.
- **Δ-A49-3 (tôi không tự đóng Δ61):** CR28-08 đã có task + receipt độc lập completed, và nó nối metadataCrypto vào runtime. Điều đó **gợi ý** Δ61 của CR28-04 đã xử lý, nhưng chính receipt CR28-04 chưa cập nhật. Tôi ghi sự thật và **không** tick Δ61.
- **Δ-A49-4 (transient typecheck, đã ghi kèm mốc):** Có một receipt trong ngày báo orchestrator typecheck **hỏng** (TS2304 readStreamBounded). Nếu tôi chỉ đọc receipt mới nhất, tôi sẽ ghi "typecheck sạch" và **xóa mất** sự kiện này. Tôi ghi cả hai theo trục thời gian.
- **Δ-A49-5:** CR28-03 giờ **owner-verified** (105 test), nhưng task độc lập vẫn dispatched và finding vẫn yêu cầu **live** multi-container. Tôi nâng trạng thái nhưng **không** nâng lên "đạt acceptance".
- **Δ-A49-6:** hai link TREE BROKEN vẫn ở antigravity-6.md:8952 và requests/antigravity.md:10, y hệt năm cycle trước. Ngoài lane, không sửa.

### 48.3 Lỗi của chính tôi

1. **Tôi suýt chép 23/23 mà không đếm.** Bài học đã có từ cycle 46, và tôi đã làm đúng ở CR28-01 lần trước — lần này packet đưa sẵn con số nên dễ chép. May mắn tôi vẫn đếm lại: 23 khai báo, 0 it.each. Với 105 thì tôi **không** đếm được, nên tôi ghi rõ đó là tổng theo receipt chứ không phải số tôi tự kiểm — phân biệt này quan trọng.
2. **Tôi phải xác minh "admin audit mount" là receipt nào.** Tên trong packet không khớp tên task (ADM-UX-08 vs ADM-UX-03-...-VERIFICATION), và còn receipt ADM-UX-03-**toolbar** cùng họ. Tôi đọc cả hai trước khi ghi, và **báo lệch** thay vì chọn một cái rồi im lặng.
## 49 — CYCLE 49: D-DOCS-EVID-SYNC-322 — ba nhóm bằng chứng mới; CR28-02 nay ĐÃ có receipt độc lập

> **RESUME POINT — cycle 49 (packet D-DOCS-EVID-SYNC-322, task task_0548e8e9c75b, dispatch ctx_1eb258383302, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–48 giữ nguyên phía trên như lịch sử.
> 1. **Hai điều chỉnh so với lời packet, nói thẳng ở đầu:** (a) 28/28 của CR28-02 là số **chạy**, số **khai báo** là **24**; (b) "11/11 x3, Muc 36" thuộc **W-ADM-UX-03-AUDIT-QUERY**, không phải ADM-UX-09. Chi tiết ở Δ-A50-2 và Δ-A50-3.
> 2. **CR28-02 đóng được lỗ hổng cycle 47 phát hiện.** Ở cycle đó tôi ghi CR28-02 "**chưa** có receipt độc lập". Nay có T-CODEX-OFFLINE-CR28-02-INDEPENDENT. Đây là lần thứ ba tôi đóng một Δ do chính mình báo.

### 49.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **W-INGEST-WIRE-02-DEADLINE-ABORT** | Owner (tester.md 9137, 15:39:46): acquisition timer tạo **một lần** trước facade; abort signal chung phủ stat, readWithMetadata nội tuyến, stream grant/open và transfer; có **post-transfer abort check**; timeout giữ DOCUMENT_TIMEOUT, cancel/lease giữ mã cũ. Chạy liên tiếp **3 lần**: mỗi lần **3 suite / 31 test** exit 0; tsc 0 |
| E2 | RECHECK cùng việc | `W-INGEST-WIRE-02-DEADLINE-ABORT-RECHECK` (22:45:08) chạy lại cùng lệnh **3 lần nữa**: mỗi lần **3 suite / 31 test** exit 0; tsc 0 |
| E3 | **Độc lập** | `T-CODEX-OFFLINE-INGEST-WIRE-02-INDEPENDENT` (9161, 23:09:42, read-only): cùng lệnh **3 lần**, mỗi lần **3 passed suites, 31 passed tests, 0 failed, 0 skipped**; tsc 0. Ba vòng = **9/9 suite, 93/93 lần chạy** |
| E4 | **Tôi đếm lại 31 từ source** | parser-budget-band **11** + read-stream-acquisition **9** + ingest-wire **11** = **31 khai báo, 0 it.each** ⇒ khai báo **bằng** chạy thật. Claim **đúng** |
| E5 | **V-OFFLINE-CR28-02-SERVICE-AUTH** | `T-CODEX-OFFLINE-CR28-02-INDEPENDENT` (9145): worker-sdk connector-invoker **1 suite / 13 test**; connector thêm file `service-auth.test.ts` còn thiếu, chạy **thật** HmacServiceIdentityVerifier với token ký, sai chữ ký, hết hạn, audience, scope; contracts **23 suite / 464 test x3**. Ba typecheck exit 0 |
| E6 | **Tôi đếm lại 28 — và con số LỆCH** | connector.test.ts **21 khai báo**; service-auth.test.ts **3 khai báo** nhưng có **2 khối it.each** (4 hàng và 2 hàng) ⇒ **7 lần chạy**. Tổng **khai báo 24, chạy 28**; chênh **4** đúng bằng độ giãn it.each. Claim 28 **đúng ở mức chạy, sai nếu hiểu là số khai báo** |
| E7 | **W-ADM-UX-03-AUDIT-QUERY** | `qwen-admin.md` Muc 36 (L3992): mới `tests/admin-audit-query.test.ts` **11 test / 1 describe**, mount thật + HTTP thật + stub JSON API; **11/11 x3**; typecheck 0; hồi quy **7 suite 338/338**. Tôi đếm: **11 khai báo, 0 it.each** |
| E8 | **Bug thật đã sửa** | `fetchAuditEvents` **vứt** message từ RFC7807 (ví dụ remedy "drop cursor to restart the list") rồi thay bằng chuỗi trần, khiến operator không biết làm gì; nay lấy message từ body JSON, bound length, có prefix |
| E9 | Hình dạng ma trận docs/19 | 6 dòng CR28-01..06, mỗi dòng **10 ô** khớp header; dòng CR28-02 thay mới được assert cell-count trước khi ghi |
| E10 | Link checker ×3 | S0 **FILES=8 TARGETS=1060 BROKEN=0**; S1 **FILES=11 TARGETS=1144 BROKEN=0**; TREE **BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E11 | Δ TARGETS | 1059→1060 và 1143→1144 = **+1 link** mới của tôi (link receipt độc lập của CR28-02 trong ma trận) |

### 49.2 Δ

- **Δ-A50-1 (đóng khe hổng của chính tôi):** Ở Δ-A48-5/Muc 47 tôi nêu CR28-02 chưa có receipt độc lập. Nay đã có, và ma trận CR28-02 được nâng lên **independently verified offline**. Task 048d60321fab và 28e1089e9ea8 đều completed.
- **Δ-A50-2 (packet nói 28/28 x3, sự thật khác):** Receipt cho thấy lần chạy **28 test** của connector chỉ chạy **một lần**; câu "ba lần liên tiếp" thuộc lần chạy **contracts 23 suite/464 test**. Và 28 là số **chạy** còn số **khai báo** là 24. Tôi ghi cả hai số và không chép nguyên "28/28 x3".
- **Δ-A50-3 (sai attribution trong packet):** 11/11 x3 ở Muc 36 thuộc **W-ADM-UX-03-AUDIT-QUERY**; `qwen-admin.md` **không hề có** bản ghi ADM-UX-09 hay SESSION-FLOW, dù task ADM-UX-09 (task_f0df3db16174) đã **completed** trong orchestration. Tôi ghi theo receipt thật và báo ADM-UX-09 **còn thiếu receipt**.
- **Δ-A50-4 (lặp lại lỗi danh tính task):** `task_a848fbd749d6` được trích cho **cả hai** Muc 35 (mount) và Muc 36 (query) với cùng dispatch ctx. Lần trước tôi đã báo hiện tượng "một task id, hai việc" cho cùng lane; nay nó **lặp lại** trong chính report đó.
- **Δ-A50-5:** INGEST-WIRE-02 nay có **hai** tầng bằng chứng (owner + recheck + independent), nhưng toàn bộ đều **offline**: không provider, storage, database hay Redis thật. `INGEST-WIRE-01` vẫn chưa có chạy multi-container live.
- **Δ-A50-6:** hai link TREE BROKEN vẫn ở antigravity-6.md:8952 và requests/antigravity.md:10, y hệt sáu cycle trước. Ngoài lane, không sửa.

### 49.3 Lỗi của chính tôi

1. **Tôi điền sai sha kỳ vọng trong script áp dụng.** Tôi lấy sha census đầu cycle nhưng quên rằng chính cycle 48 đã repoint anchor ở docs/28 và docs/35 làm sha đổi. Drift guard chặn đúng và **không** ghi hỏng file; tôi sửa sha rồi chạy lại. Bài học: phải census lại ngay trước lúc ghi, không dùng sha từ đầu cycle.
2. **Tôi suýt chép "28/28 x3" vào docs.** Nếu không đếm tay hai khối it.each, tài liệu sẽ mang một con số sai nghĩa ngay ở nơi dùng nó để lập luận mức phủ. Tôi cũng dùng regex đếm hàng it.each trước, thấy kết quả vô lý (1 khối 10 hàng) và **bỏ cách đó**, đọc thẳng source để đếm tay.
## 50 — CYCLE 50: D-DOCS-EVID-SYNC — audit query/mount + ingest scan fixtures + ingest tamper, docs/35 lên 1.52.0

> **RESUME POINT — cycle 50 (packet D-DOCS-EVID-SYNC, task task_b01e83b04ea9, dispatch ctx_2d3647676d28, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–49 giữ nguyên phía trên như lịch sử.
> 1. **Hai lỗi trong packet, xử lý và ghi lại:** (a) file `docs/19-test-strategy.md` **không tồn tại** — tôi dùng file thật `docs/19-traceability-audit-matrix.md`; (b) receipt thứ ba được packet trỏ ở dòng 9264 nhưng header thật nằm ở **9279**.
> 2. **Số liệu tôi ĐẾM LẠI, và có một chỗ receipt đã cũ:** `admin-audit-query.test.ts` hôm nay khai báo **17** test (cycle 49 tôi đếm 11) nên hai suite query+mount = **23 khai báo**, trong khi receipt chạy lúc đó ghi 17. Ghi cả hai, không chép đè.

### 50.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **ADMIN-AUDIT-QUERY-MOUNT-INDEPENDENT** | tester.md **9189**, 2026-09-28T23:14:13, read-only, task_1533765f1808. Query: forward đủ filter, bỏ filter chưa set, clamp limit, báo filter sai, inverted window fail-closed, chặn rò API key/HTML; 422 hiện **remedy text**; 401/500 có mapping. Mount: `attachAdminShell` **thật** qua loopback + default audit fetcher, trả 200, render ledger + tab, không rơi vào not-wired/empty, gửi bearer, forward toolbar query |
| E2 | **Lần chạy đầu HỎNG — ghi lại, không giấu** | Initial run exit **1**: query pass 16, mount **1 fail** vì `connect ETIMEDOUT 127.0.0.1:55534` ở request shell đầu. Rerun **3 lần**: mỗi lần exit 0, **2 suite / 17 test** ⇒ **6/6 suite, 51/51 lần chạy**. `tsc` 0 |
| E3 | **Tôi đếm lại, receipt đã cũ** | query **17** + mount **6** = **23 khai báo, 0 it.each**. Receipt đo **17** vào lúc chạy; file query đã lớn thêm (11 ở cycle 49) |
| E4 | **DOC-CORE-INGEST-SCAN-FIXTURES** | tester.md **9217**, 23:19:26. Thêm **duy nhất** `ingest-scan-fixtures.test.ts`: OCR gửi fixture `handwriting-scan.png` đúng byte với `image/png`; digitize gửi fixture PDF với `application/pdf`, digest, storage version, filename, size; thiếu reference và grant hết hạn fail-closed **trước** khi gọi Connector slot. **1 suite / 4 test** ×3 exit 0; tsc 0 |
| E5 | **Tôi đếm** | `ingest-scan-fixtures.test.ts` = **4 khai báo, 0 it.each** ⇒ khai báo bằng chạy thật |
| E6 | **DOC-CORE-INGEST-SCAN-TAMPER-INDEPENDENT** | tester.md **9279** (packet ghi 9264 — sai 15 dòng), 2026-09-29T00:07:15, read-only, task_38acb0abd06d. 4 phòng thủ: grant SHA-256 bị sửa bị từ chối **trước** Connector; payload handwriting hỏng trong bộ nhớ bị từ chối với `ARTIFACT_INTEGRITY_MISMATCH` **sau** khi đọc hợp lệ; storage version đổi sau preflight bị từ chối và stream request được kiểm theo version mong đợi; timeout parser giữa chừng huỷ stream, `AbortSignal` được assert đã abort và báo `DOCUMENT_TIMEOUT` |
| E7 | **Số 12 của packet là TỔNG, không phải mỗi lần** | Mỗi lần chạy **1 suite / 4 test**; receipt viết *"3/3 suites and 12/12 test executions"* — 12 là **tổng của ba lần** (3 × 4). `tsc` 0 |
| E8 | Hình dạng ma trận docs/19 | 6 dòng CR28-01..06 vẫn **10 ô** khớp header, không bị đụng |
| E9 | Link checker ×3 | S0 **FILES=8 TARGETS=1061 BROKEN=0**; S1 **FILES=11 TARGETS=1145 BROKEN=0**; TREE **FILES=196 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E10 | Δ TARGETS | 1060→1061 và 1144→1145 = **+1 link** mới của tôi |

### 50.2 Δ

- **Δ-A51-1 (sai tên file trong packet):** `docs/19-test-strategy.md` không tồn tại; `docs/19*` chỉ có `19-traceability-audit-matrix.md`. Tôi ghi vào file thật và **không** tạo file mới theo tên sai.
- **Δ-A51-2 (sai dòng receipt):** packet trỏ receipt thứ ba ở `tester.md:9264`, nhưng 9264 là **phần đuôi** của receipt khác (`W-WORKER-SDK-BOUNDARIES-FIX`); header thật của `T-CODEX-OFFLINE-DOC-CORE-INGEST-SCAN-TAMPER-INDEPENDENT` ở **9279**. Tôi content-assert dòng 9279.
- **Δ-A51-3 (con số receipt đã cũ, ghi rõ thay vì chép):** hai suite audit query+mount ghi **17** test lúc chạy; source hôm nay khai báo **23** (file query đã lớn thêm từ 11 lên 17). Người đọc tài liệu này không nên dùng 17 làm số khai báo hiện hành.
- **Δ-A51-4 (số "12 x3" của packet là tổng ba lần):** mỗi lần 4 test. Đã ghi đúng cả hai cách hiểu để không ai lập luận coverage bằng 12/lần.
- **Δ-A51-5:** cả ba nhóm đều **offline** — không provider, storage, database, Redis thật. `G-ADMIN-OPS` vẫn NO-GO, không nhóm nào đổi verdict acceptance.
- **Δ-A51-6 (bối cảnh, không sửa):** ngay trên các receipt này, `W-WORKER-SDK-BOUNDARIES-FIX` ghi **full worker-sdk run exit 1** ở cả 3 lần do một assertion `artifact-stat` ngoài phạm vi. Không thuộc packet này nên tôi chỉ ghi nhận, không mở rộng.

### 50.3 Lỗi của chính tôi

1. **Packet sai tên file nhưng tôi phải tự tra đúng file thật** — nếu tôi tin packet và tạo `docs/19-test-strategy.md` mới, tôi sẽ tạo một file rác. Tôi kiểm `docs/19*` trước khi ghi và ghi lệch này vào receipt thay vì im lặng sửa.
2. **Tôi suýt dùng con số 17 của packet như số test hiện hành.** Chỉ khi đếm tay file test mới thấy query đã 17 (không phải 11) và tổng là 23. Vì đã quy trình "đếm lại bằng source" từ các cycle trước nên tôi bắt được ngay; nếu chép thẳng, tài liệu sẽ mang một số sai nghĩa.
## 51 — CYCLE 51: D-DOCS-EVID-SYNC-5 — năm receipt mới; Δ71 được định lượng, docs/35 lên 1.53.0

> **RESUME POINT — cycle 51 (packet D-DOCS-EVID-SYNC, task task_dd80c81503af, dispatch ctx_2af053da6b87, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–50 giữ nguyên phía trên như lịch sử.
> 1. **Hai tên receipt trong packet KHÔNG tồn tại** (0 hit toàn workspace): `W-PLAT-CR28-01-MANIFEST-CHUNKS-TEST` và `W-ADM-UX-11-AUDIT-EMPTY-HOOK-MIGRATION`. Tôi ghi theo tên receipt **thật** và báo lệch. Số liệu packet vẫn khớp với receipt thật, nên đây là **sai tên**, không phải sai việc.
> 2. **Hai số của packet là TỔNG nhiều lần chạy, không phải mỗi lần**: 69 = 3 × 23, và 195 = 3 × 65. Tôi ghi cả hai cách hiểu.

### 51.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **ADM-UX-10-INDEPENDENT** | tester.md **9308** (packet ghi 9318 — lệch 10 dòng), 2026-09-29T00:12:47, task_534bfcc8ffa3, read-only. Query suite: banner rỗng khi không lọc, hướng dẫn + lối thoát khi lọc rỗng, bảng có dữ liệu **không** hiện banner, pane lỗi 5xx kèm nút Try again, retry giữ URL/filter, unauthorized thì yêu cầu đăng nhập lại thay vì retry vô ích; vẫn giữ forwarding, remedy 422, mapping 401/500, filter sai, inverted window, non-JSON an toàn |
| E2 | Chạy + đếm | 3 lần × **2 suite / 23 test** exit 0 ⇒ **6/6 suite, 69/69 lần chạy**; tsc 0. Tôi đếm: query **17** + mount **6** = **23 khai báo, 0 it.each** — **khớp**. Receipt tự ghi G-ADMIN-OPS vẫn NO-GO |
| E3 | **PLAT-CR28-01-RUNTIME-SEAM-INDEPENDENT** | tester.md **9357**, 00:16:19, task_621e2d63e521, read-only. server.ts nối `metadataEncryption` qua `adaptKeyProviderForMetadata` rồi truyền `metadataCrypto` vào `createRuntimeService`; `runtime.ts openMetadata` đi qua `readStored(value, context, true)` cho cửa sổ legacy backfill. Phủ: metadata inventory, tenant/slot/row binding, tamper/sai key/Vault fail-closed, hashing ổn định, mapping + round-trip adapter D61, và **phân biệt chính sách Δ72** (runtime metadata chấp nhận plaintext legacy còn `decryptStoredArtifact` thì từ chối) |
| E4 | **Số liệu receipt ĐÃ CŨ** | Receipt đo **65/lần**; source hôm nay khai báo **70** (metadata **47** — ở cycle 47/48 chỉ 37 — cộng artifact-decrypt **23**), 0 it.each. Ghi cả hai, không chép đè |
| E5 | **INGEST-TIMEOUT-RECOVERY** | Owner (tester.md **9386**): mới `ingest-timeout-recovery.test.ts`, **không** đổi production; quan sát artifact tạm dở, ép timeout giữa stream, xác nhận stream bị hủy và workspace dọn sạch, retry cùng task id thành công; lắng nghe `unhandledRejection` và **không** thấy. 3 lần × **1 suite / 1 test** exit 0; tsc 0 |
| E6 | **Độc lập cho cùng việc trên** | `T-CODEX-OFFLINE-DOC-CORE-INGEST-TIMEOUT-RECOVERY-INDEPENDENT` (9396, 00:43:39, task_116b4809a6cd) xác nhận lại 3 lần × 1 suite/1 test = **3/3 suite, 3/3 lần chạy**; tsc 0; G-ENC NO-GO. Tôi đếm: **1 khai báo, 0 it.each** |
| E7 | **MANIFEST-CEILING (Δ71) — tên thật** | qwen-platform Muc 34 (L3232) là `W-CR28-01-MANIFEST-CEILING (Δ71)`, task_822866aa8d98. Phát hiện: **hai trần khác nhau ở hai file, hai mã lỗi khác nhau** — facade chặn theo **SỐ CHUNK** (`DEFAULT_MAX_CHUNKS = 65_536`, `validateManifest`, `INVALID_MANIFEST`), server chặn manifest theo **BYTE** (8 MiB qua `readStreamBounded`, `413 TOO_LARGE`) |
| E8 | **Δ71 định lượng** | ~**171 byte/chunk**: ~49 000 chunk → **8.03 MiB** (đã vượt trần 8 MiB); 65 536 chunk (mặc định facade) → **10.74 MiB**. ⇒ dải **49 000–65 536 chunk** là nơi facade phát ra manifest mà server **từ chối đọc**, và **không file nào báo lỗi** |
| E9 | Muc 34 verify | 4 test mới trong `crypto-storage-facade.test.ts` (10 → **14**), 3 lần **14/14** Exit **0/0/0**; tsc 0 **log rỗng**; production không đụng (`crypto-storage-facade.ts` sha `dcd7e3db`, `server.ts` sha `22afb2ff`); mutation M1 trong chính test (đổi hằng 8 MiB → 16 MiB) làm **2 test đỏ** |
| E10 | **Δ74 mới** | Trần byte nằm ở `server.ts` **ngoài write scope** của lane đó, nên **không test nào ghim** `HttpError(413, TOO_LARGE)` — phía byte **chưa** có bảo vệ test |
| E11 | **EMPTY-BANNER-CLEANUP — tên thật** | qwen-admin Muc 38 (L4077) là `W-ADM-UX-10-EMPTY-BANNER-ATTRIBUTE-CLEANUP`, task_7c9c0fd92994: bỏ `data-list-empty` khỏi 2 div banner audit, sửa 2 assertion. **Bẫy đã tránh**: attribute trùng tên thuộc về pane **Operations** (renderer 2, test phân trang 3) — replace toàn repo sẽ phá pane đó |
| E12 | Muc 38 verify | 3 suite (toolbar+query+mount) **80/80 x3**; typecheck 0; hồi quy route + 3 suite shell **238/238**. **238 là tổng hồi quy**, không phải số của một suite |
| E13 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=196 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E14 | Δ TARGETS | 1061→1063 và 1145→1147 = **+2 link** mới của tôi (2 link receipt trong dòng ma trận CR28-01) |

### 51.2 Δ

- **Δ-A52-1 (hai tên receipt trong packet không tồn tại):** `W-PLAT-CR28-01-MANIFEST-CHUNKS-TEST` và `W-ADM-UX-11-AUDIT-EMPTY-HOOK-MIGRATION` cho **0 hit** toàn workspace. Tôi ghi hai mục theo tên thật, và số liệu packet vẫn khớp — nên đây là **sai tên**, không phải trỏ nhầm việc.
- **Δ-A52-2 (sai dòng receipt):** packet trỏ ADM-UX-10 ở `tester.md:9318`; header thật ở **9308**. 9318 là tiêu đề "Three consecutive targeted Jest runs" **bên trong** receipt đó.
- **Δ-A52-3 (Δ71 đã định lượng, và đây là phát hiện đáng chú ý nhất của cycle):** dải 49 000–65 536 chunk là nơi một side chấp nhận, side kia từ chối, **không file nào báo**. Đây là dạng hỏng "đúng một nơi, hỏng một nơi khác" chứ không phải "sai". Δ71 cần coordinator chọn giữa 3 phương án; tôi không tự chọn.
- **Δ-A52-4 (Δ74 mới):** nhánh 413 của trần byte **không có test nào** vì nằm ở `server.ts` ngoài write scope của lane đã làm. Tôi ghi vào cả ba file để người tìm Δ74 không bỏ sót.
- **Δ-A52-5 (con số receipt đã cũ):** runtime-seam đo **65/lần**; source hôm nay khai báo **70**. Ghi cả hai.
- **Δ-A52-6:** **G-ENC** và **G-ADMIN-OPS** đều được các receipt tự ghi là vẫn **NO-GO**; không nhóm nào ở đây đổi verdict acceptance.

### 51.3 Lỗi của chính tôi

1. **Tôi suýt ghi docs/35 mà thiếu nhãn Δ74.** Nội dung phát hiệm đã có nhưng không mang nhãn delta, nên người tra `Δ74` sẽ không thấy. Bắt bằng content-assert, sửa tại chỗ, chạy lại link check.
2. **Ba assert của tôi fail vì needle quá đặc thụt** (có **bold** trong tôi không có, hoặc tôi tìm cụm nằm ở file khác). Tôi kiểm nội dung thật của dòng ma trận theo từng ô trước khi kết luận, và không sửa tài liệu cho khớp needle — như cycle trước.
## 52 — CYCLE 52: D-DOCS-EVID-SYNC-4 — boundary ổn định, metadata window, parser negatives, unify empty banner; docs/35 lên 1.54.0

> **RESUME POINT — cycle 52 (packet D-DOCS-EVID-SYNC, task task_5592f61949ac, dispatch ctx_7daa617f1825, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–51 giữ nguyên phía trên như lịch sử.
> 1. **Hai tên trong packet KHÔNG tồn tại** (0 hit toan workspace): `W-PLAT-CR28-01-METADATA-ALLOWPLAINTEXT-PIN` và `W-ADM-UX-11`/`W-ADM-UX-12-OPERATIONS-EMPTY-BANNER-UNIFY`. Số dòng receipt 1 và 2 trong packet thì **đúng**. Tôi ghi theo tên thật và báo lệch.
> 2. **Một supersession quan trọng:** full worker-sdk package **từ exit 1 (19/20, 320/322) → exit 0 (21/21, 338/338)**. Câu cũ trong mục CR28-06 của docs/28 và docs/35 là **của tôi**, nên tôi thêm bullet/câu supersede ngay trong mục đó chứ không để nó sai.

### 52.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **W-WORKER-SDK-NETWORK-BOUNDARIES-STABILIZE** | tester.md **9434**, 00:49:03, task_5655072e2812. Sửa **chỉ trong test**: mock loopback ghim trên dải port tĩnh theo PID của Worker SDK (46 400 + (pid mod 8) x 16) thay vì xin ephemeral port đã lọc; case caller-abort cho 2 giây để request về tới rồi abort/đóng listener **trước** khi chờ download có hạn, nên hồi quy không kẹt port tới lúc Jest timeout |
| E2 | Boundary xanh | 3 lần, mỗi lần exit 0 **1 suite / 6 test**; bản **độc lập** (9454, 00:57:01, task_a0490bfb3cd8) xác nhận lại **3/3 suite, 18/18**. Tôi đếm: **6 khai báo, 0 it.each** |
| E3 | **SUPERSESSION — full worker-sdk XANH** | `pnpm --filter @du/worker-sdk test` exit **0**, **21/21 suite, 338/338 test**, `tsc` 0. Owner và receipt độc lập đều ghi như vậy. **Không** sửa production source. Không receipt nào promote gate |
| E4 | **W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE** | tester.md **9425**, 00:47. Mở rộng **chỉ** `parser-budget-band.test.ts`, production không đổi. Negative: dùng parser tường minh vượt trần **64 MiB** → `INVALID_PARSER_BUDGET`; **0, âm, phân số** dưới mức tối thiểu 1 byte bị từ chối **không clamp âm thầm**; **đúng 1 byte** được chấp nhận. 3 lần × 1 suite/13 test exit 0; tsc 0 |
| E5 | Tôi đếm | `parser-budget-band.test.ts` = **13 khai báo, 0 it.each** — khớp. (Hai cycle trước file này khai báo 11; số đếm thay đổi theo case được thêm, nên số của receipt mới là số dùng được) |
| E6 | **Tên thật Mục 35** | Packet gọi là `W-PLAT-CR28-01-METADATA-ALLOWPLAINTEXT-PIN` — **không tồn tại**. Mục 35 của platform là `W-CR28-01-OPENMETADATA-WINDOW`, task_0ad29b146ecb, L3315 |
| E7 | **Đóng khoảng trống coverage thật, KHÔNG sửa production** | `openMetadata` là module-private nên chính sách mà Δ69 bật chưa test nào canh. Test đi qua bề mặt export sẵn có: `createRuntimeService(...).claimTask(...)` → `buildClaimResult(...)` → `openMetadata(...)`, dùng nhánh replay `last_delivery_id === deliveryId` để claim trả snapshot **không cấp lease mới**. `runtime.ts` không đổi (sha `902185d2`, 77431 B) |
| E8 | **5 window theo thứ tự deployment** | seam **OFF** trả nguyên trạng; **BACKFILL** (seam ON, hàng vẫn plaintext) **claim phải thành công** và trả plaintext; **sealed** mở envelope bình thường; **mis-bound row** và **mis-bound tenant** đều fail closed. Hai ca cuối canh đúng thứ mà window 2 **không được** nới: tha tolerance plaintext legacy **không** được thành tha tolerance sai binding |
| E9 | **Bằng chứng khoảng trống là thật** | Mutation `openMetadata` `true`→`false` của Mục 33 trước đây **42/42 vẫn xanh**; nay bắt được **1 test đỏ**. 47/47 x3 Exit 0/0/0 + 1 lần nữa sau restore; tsc 0 **log rỗng**. Tôi đếm: `runtime-encryption-metadata.test.ts` = **47 khai báo, 0 it.each** |
| E10 | **Tên thật Mục 39** | Packet gọi là `W-ADM-UX-12-OPERATIONS-EMPTY-BANNER-UNIFY` — **không tồn tại**. Mục 39 của admin là `W-ADM-UX-10-UNIFY-EMPTY-BANNER-OPERATIONS`, task_ebd089a652e9, L4128 |
| E11 | **Hai lệch acceptance, lane tự báo** | (1) Acceptance yêu cầu `tests/admin-operations-list-conformance.test.ts` — file **không tồn tại** (tôi kiểm trên đĩa: chỉ có `admin-operations-list-pagination.test.ts`). Lane chạy suite thật và **không tạo file mới chỉ để làm acceptance xanh**, gọi đó là bịa bằng chứng. (2) Acceptance yêu cầu ExitCode 0 nhưng suite **đã đỏ từ trước**: baseline 1 failed / 88 passed / 89, sau khi sửa **y hệt, không có fail mới**; fail duy nhất là **Δ92** có sẵn, không liên quan (test đòi aria-label *Scrollable table*, còn `shell-render.ts` phát *Scrollable data table N of M*). Lane nói thẳng là **KHÔNG đạt** ExitCode 0 và không thể đạt nếu không sửa `shell-render.ts` ngoài file limit |
| E12 | Muc 39 verify + **supersession ngay sau** | Đổi **chỉ tên attribute** (renderer 2 chỗ, test 3 assertion), giữ nguyên CSS class, ngữ nghĩa toContain và toàn bộ text; đếm attribute ở cả 4 file. typecheck 0; `admin-operations-list-pagination.test.ts` **1 failed, 88 passed, 89 total x3**; hồi quy 7 suite **266/266**. Tôi đếm: file khai báo **84** test + 1 khối `it.each` ⇒ **89 là tổng chạy**. **Muc 40 (`W-ADM-UX-10-DELTA92-ARIA-LABEL`) đóng Δ92**: 89/89 xanh, acceptance 229/229 x3, hồi quy 8 suite 219/219, sửa **test chứ không sửa renderer** với lý do a11y (nhãn cố định khiến 3 bảng trên overview tự giới thiệu giống nhau) |
| E13 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=196 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E14 | Δ TARGETS | **1063 → 1063** và **1147 → 1147**: **không đổi**. Các mục mới của tôi **không** chứa link mới — tôi ghi tên receipt trong backtick chứ không nhúng link, nên không phát sinh mục tiêu mới |

### 52.2 Δ

- **Δ-A53-1 (hai tên trong packet không tồn tại):** `W-PLAT-CR28-01-METADATA-ALLOWPLAINTEXT-PIN` và `W-ADM-UX-12-OPERATIONS-EMPTY-BANNER-UNIFY` cho **0 hit**. Tên thật lần lượt là `W-CR28-01-OPENMETADATA-WINDOW` và `W-ADM-UX-10-UNIFY-EMPTY-BANNER-OPERATIONS`. Số dòng receipt 1 và 2 trong packet thì đúng.
- **Δ-A53-2 (supersession do tôi ghi trước đây):** mục CR28-06 ở docs/28 và docs/35 ghi full worker-sdk **19/20 suite, 320/322**. Nay là **21/21, 338/338 exit 0**. Tôi thêm bullet/câu supersede **ngay trong mục đó** và giữ lời cũ làm lịch sử, vì đó là câu của chính tôi đã thành sai.
- **Δ-A53-3 (Δ72 GAP ĐÓNG, nhưng Δ69 vẫn mở):** chính sách backfill window nay **được test bảo vệ** qua đường claim thật, không cần export hay sửa production. Tuy nhiên **khi nào** bật cờ, **backfill bao nhiêu dòng**, và **ai** chịu trách nhiệm khi nó fail vẫn là quyết định vận hành chưa có. Δ66 (phía artifact) cũng vẫn mở.
- **Δ-A53-4 (bằng chứng trung thực đáng ghi nhất của cycle này):** receipt Mục 39 **không đạt** ExitCode 0 mà vẫn giao, và nói rõ lý do; thêm nữa nó **từ chối tạo file test chỉ để làm acceptance xanh**. Tôi ghi nguyên văn ý này thay vì chỉ trích số liệu — vì đây là loci hành vi mà các đợt trước ít khi thấy được ghi lại.
- **Δ-A53-5 (Muc 40 đóng Δ92 ngay sau Muc 39):** tôi ghi cả hai theo đúng thứ tự thời gian để không ai đọc "Δ92 vẫn đỏ" là trạng thái hiện hành. Δ92 đã **đóng** bằng cách sửa **test** chứ không sửa renderer.
- **Δ-A53-6:** `G-ENC` và `G-ADMIN-OPS` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 4 receipt đều offline, không có production service nào được chạm.

### 52.3 Lỗi của chính tôi

1. **Probe đếm test của tôi ghép sai đường dẫn** (`du-rework/` bị lặp hai lần) nên báo MISSING cho 5 file tồn tại. Tôi thấy kết quả vô lý, sửa đường dẫn và đếm lại — chứ không báo "file không tồn tại" vào tài liệu.
2. **Census của tôi in nhầm số byte** ở khối docs/28 vì biến `raw` đã cũ sau lần ghi supersede; nội dung file đúng (tôi kiểm lại bằng content-assert và xác nhận bullet supersede nằm **bên trong** mục CR28-06, không bị rơi lạc). Bài học: sau mỗi lần ghi phải census lại từ đĩa, không dùng lại số đo cũ trong log.
## 53 — CYCLE 53: Turn 329 — năm receipt negative-test vào docs/28 + docs/35 (1.54.0 → 1.55.0)

> **RESUME POINT — cycle 53 (packet D-DOCS-EVID-SYNC / Turn 329, task task_8d0c2253ce8c, dispatch ctx_40b0184dca61, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–52 giữ nguyên phía trên như lịch sử.
> 1. **Packet này chỉ nêu `docs/28` và `docs/35`**, nên tôi **không** đụng `docs/19` — khác với các cycle trước cùng loại.
> 2. **Ba tên trong packet không tồn tại** (0 hit): `W-DOC-CORE-INGEST-SCAN-DIGITIZE-TAMPER-NEGATIVE`, `W-PLAT-CR28-01-READSTREAM-BOUNDED-TEST`, `W-ADM-UX-03-AUDIT-QUERY-NEGATIVE`. **Số liệu thì đúng cả ba.** Tôi ghi theo tên thật và báo lệch.

### 53.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE** (tên packet **đúng**) | tester.md 9592, 01:07:52, task_ee5b970ba9b4. Chỉ thêm test vào `artifact-stat.test.ts`, **không** sửa production. Negative access-grant 404 `NOT_FOUND` + 403 `FORBIDDEN`, từ chối grant descriptor dị dạng và response non-JSON. 3 lần × 1 suite/7 test exit 0; tsc 0 |
| E2 | **Receipt độc lập gộp HAI suite** | `T-CODEX-OFFLINE-ARTIFACT-STAT-AND-INGEST-TAMPER-INDEPENDENT` (tester.md 9561, 01:27:42, task_77eda516f614, read-only) xác nhận **cả hai** suite và **cả hai** typecheck. Artifact-stat: 3 × 7 = **21/21** — stat trả đúng field được cấp **không có blob bytes**, field vắng giữ là undefined, chặn grant 404/403 và response dị dạng/non-JSON, chặn lease cũ |
| E3 | **6/6 document-core — nơi thật của mục packet** | Cùng receipt độc lập đó: `ingest-scan-tamper.test.ts` 3 × **6** = **18/18**, phủ sáu phòng thủ — grant hash lệch, payload hỏng, **stream ngắn**, digest lệch **cùng kích thước**, storage version lệch, và timeout parser huỷ transfer giữa chừng |
| E4 | **Bẫy đếm số duy nhất trong 5 suite** | Tôi đếm: artifact-stat **6 khai báo + 1 khối it.each** ⇒ **7 là số chạy, 6 là số khai báo**. Bốn suite còn lại khai báo **bằng** chạy: tamper 6, stream-acquisition 11, facade 18, audit-query 26 |
| E5 | **T-CODEX-OFFLINE-DOC-CORE-STREAM-ACQUISITION-INDEPENDENT** (tên packet **đúng**) | tester.md 9517, 01:03:37, task_0370791b2f55, read-only. 3 lần × 1 suite/11 test exit 0 = **3/3 suite, 33/33 lần chạy**; tsc 0; mọi gate vẫn NO-GO. **33 là TỔNG ba lần, không phải mỗi lần.** Phủ: streaming đĩa + danh tính khai báo, từ chối quá ngân sách trước transfer, huỷ byte-cap giữa stream, phát hiện lệch size/digest, đường inline dưới 1 MiB, timeout toàn bộ lần đọc, mapping lease/cancel, huỷ transfer + dọn workspace, nguồn đóng đột ngột, và đường buffer legacy |
| E6 | **Tên thật Mục 36 platform** | Packet gọi `W-PLAT-CR28-01-READSTREAM-BOUNDED-TEST` — **không tồn tại**. Mục 36 là `W-CR28-01-FAILCLOSED-BYTE-LIMITS`, task_6e325d857332 |
| E7 | **Nửa packet không làm được — lane nói thẳng** | Packet yêu cầu ghim `413 TOO_LARGE` **và** `INVALID_MANIFEST`. Đo trước: `INVALID_MANIFEST` nằm trong facade, ghim được; `413` ném ra từ `readStreamBounded` ở `server.ts`, **module-private, không export**, mà file limit cấm sửa production ⇒ **không có đường nào chạm tới**. Lane **không** viết test lấp lại logic đó trong file test — gọi đó là test của chính nó, không chứng minh gì về production |
| E8 | Không viết lại case đã có | Suite đã ghim sẵn ciphertext bị cắt cụt, **bytes thừa ở đuôi**, swap chunk, tamper body, `SIZE_LIMIT` và trần số chunk. Lane **cố ý không** viết lại: chỉ làm dày receipt |
| E9 | **4 test mới cho hai chốt BYTE của facade** (14 → 18) | `contextAad` > 2048 bị từ chối `INVALID_MANIFEST` **trước khi** kiểm MAC; `contextAad` 2047 vẫn bị từ chối nhưng vì **sai binding**, không phải vì độ dài; stream trả giá trị không phải `Uint8Array` → `INVALID_INPUT`; và **ở đuôi** stream → `INVALID_INPUT` (chốt phải giữ ở đuôi, không chỉ lần đọc đầu) |
| E10 | **Δ75 MỚI — mutation KHÔNG bắt và KHÔNG được tính** | Xoá chốt `contextAad.length > 2048` ⇒ **18/18 vẫn xanh**, vì AAD equality (`timingSafeEqual`) chặn trước. ⇒ Chốt 2048 là **defence-in-depth bị mask**: nếu ai xoá, **không test nào đỏ**. Lane ghi rõ đây là dạng "xanh nhưng không chứng minh" và **không tính là bằng chứng** |
| E11 | Hai lỗi thật của lane (tự ghi) | (1) TS không cho truyền `AsyncGenerator<unknown>` vào chỗ nhận `AsyncIterable<Uint8Array>` ⇒ compile fail; lane **cast** — và điều đó **chính là ý nghĩa** của test: hệ thống kiểu nói điều này không thể xảy ra, nên chốt runtime chỉ có ý nghĩa với caller **không typed / JS**. (2) Helper dùng plaintext **đúng 5 MiB** ⇒ facade từ chối tạo manifest chunked (`SIZE_LIMIT`), cả 4 test đỏ; sửa theo convention có sẵn. Bài học lane rút ra: **đọc test hàng xóm trước khi viết test mới** |
| E12 | Verify Mục 36 | `crypto-storage-facade` 3 lần **18/18** Exit **0/0/0**; tsc 0 **log rỗng**; production không đụng (`crypto-storage-facade.ts` sha `dcd7e3db` / 31593 B). **Δ74 LẶP LẠI lần thứ hai**; Δ75 mới; **Δ71 vẫn mở** |
| E13 | **Tên thật Mục 41 admin** | Packet gọi `W-ADM-UX-03-AUDIT-QUERY-NEGATIVE` — **không tồn tại**. Mục 41 là `W-ADM-UX-10-HOSTILE-INPUT-NEGATIVE-TESTS`, task_7813a4abee16 |
| E14 | Mục 41 — **KHÔNG sửa mã nguồn** | Chỉ thêm test vào `admin-audit-query.test.ts` (**17 → 26**). Chín thẻ script trên actor; script trên action + resource; trên severity + from; trên sort (bị loại, rơi về thứ tự mặc định); quote-breakout mang handler inline; `img` có `onerror`; **cursor 400 ký tự bị cắt còn 128**; cursor dị dạng được forward nguyên văn để **route** tự từ chối và hiện remedy; cursor độc hại do route trả về bị esc khi render |
| E15 | Mục 41 — **assertion bám thực tế, con số cố ý hard-code** | Assertion searchParams đọc **URL backend thật nhận** (bỏ sanitiser là đỏ); assertion not.toContain đọc **DOM sau render** (esc hỏng là đỏ); con số **128 hard-code cố ý** thay vì import hằng contracts, để hợp đồng bị nới thì test **tự đỏ** thay vì âm thầm đi theo hằng |
| E16 | Mục 41 — **điểm thiết kế được khóa lại** | Cursor **cố ý KHÔNG** đi qua `sanitizeAuditFilterToken` vì là **token opaque do server mint**, không phải text người dùng gõ. Hệ quả được ghi thay vì giấu: vì bỏ qua sanitiser nên nó **có thể chứa markup**, nên **phải** esc ở mọi nơi nó ra DOM — test thứ 9 ghim đúng điều đó |
| E17 | Mục 41 verify + **phạm vi chưa phủ** | **26/26 ×3**; orchestrator typecheck Exit **0**; hồi quy 5 suite **309/309**. Chưa phủ: header/cookie độc hại (đã có test riêng ở admin-shell-auth và admin-audit-route), CSRF trên POST (pane là GET thuần), injection ngoài vùng esc() (mọi giá trị đều qua esc(), đã có test ở admin-shell-render). G-ADMIN-OPS NO-GO, ADM-UX-02 [~] |
| E18 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=196 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E19 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — các mục mới ghi tên receipt trong backtick, **không** nhúng link mới |

### 53.2 Δ

- **Δ-A54-1 (ba tên trong packet không tồn tại):** `W-DOC-CORE-INGEST-SCAN-DIGITIZE-TAMPER-NEGATIVE`, `W-PLAT-CR28-01-READSTREAM-BOUNDED-TEST`, `W-ADM-UX-03-AUDIT-QUERY-NEGATIVE` cho **0 hit**. Tên thật: receipt độc lập gộp `T-CODEX-OFFLINE-ARTIFACT-STAT-AND-INGEST-TAMPER-INDEPENDENT`, `W-CR28-01-FAILCLOSED-BYTE-LIMITS` (Muc 36) và `W-ADM-UX-10-HOSTILE-INPUT-NEGATIVE-TESTS` (Muc 41). **Số liệu packet khớp cả ba** ⇒ sai tên, không trỏ nhầm việc.
- **Δ-A54-2 (Δ74 lặp lại lần thứ hai, và Δ75 mới):** nhánh `413` vẫn **không có test** vì nó nằm trong `server.ts` — lane tường thuật trong báo cáo của chính mình rằng đó **không phải thiếu test của họ**, mà là **test ấy không nằm trong file họ được sửa**. Mới: chốt `contextAad` 2048 là **defence-in-depth bị mask** vì AAD equality chặn trước; nếu xoá, **không test nào đỏ**. Cả hai được ghi là **mở**, không phải là pass.
- **Δ-A54-3 (một mẫu hành vi đáng ghi, xảy ra hai lần trong 5 receipt):** lane **từ chối tính bằng chứng khi bằng chứng không đàng hoàng** — không tạo file test chỉ để làm acceptance xanh (Mục 39 kỳ trước), không viết test lấp lại logic production (Mục 36 kỳ này), và **không tính** mutation không bắt được (Mục 36). Tôi ghi nguyên văn các đoạn này, vì đó là thứ quý nhất trong hồ sơ bằng chứng.
- **Δ-A54-4 (bẫy đếm số duy nhất lần này):** trong 5 suite chỉ có `artifact-stat` lệch giữa khai báo và chạy — **6 khai báo + 1 khối `it.each` = 7 chạy**. Bốn suite còn lại khai báo bằng chạy. Đồng thời `33` (stream-acquisition) và `21` (artifact-stat) là **tổng nhiều lần chạy**, không phải số mỗi lần.
- **Δ-A54-5:** `G-ADMIN-OPS`, `G-ENC`, `G-DATA` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 5 receipt đều offline, không receipt nào promote gate.

### 53.3 Lỗi của chính tôi

1. **Một assert của tôi fail vì needle viết sai** (tôi tìm cụm "6 is the declared count" trong khi câu đã viết là "7 is the executed count and 6 the declared count"). Tôi đọc lại dòng thật trong file thay vì sửa tài liệu cho khớp.
2. **Số dòng receipt trong `tester.md` đã trôi giữa hai lần đọc của tôi**: một probe tìm thấy header ở dòng 9561, nhưng lần dump ngay sau đó cho thấy dòng 9561 đã là header khác — lane khác đang append. Tôi chỉ dùng số dòng sau khi content-assert lại ở bước cuối, và các mục tôi ghi trong tài liệu **không** dùng số dòng làm neo link nên không hỏng gì.
## 54 — CYCLE 54: Turn 330 — bốn receipt negative-test mới vào docs/28 + docs/35 (1.55.0 → 1.56.0)

> **RESUME POINT — cycle 54 (packet D-DOCS-EVID-SYNC / Turn 330, task task_818c5f22ec14, dispatch ctx_7d6c0796908c, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–53 giữ nguyên phía trên như lịch sử.
> 1. **Packet chỉ nêu `docs/28` và `docs/35`** nên tôi **không** đụng `docs/19` — như cycle 53.
> 2. **Packet liệt kê 5 receipt nhưng chỉ 4 là MỚI.** Mục thứ 5 (`T-CODEX-OFFLINE-ARTIFACT-STAT-AND-INGEST-TAMPER-INDEPENDENT`) tôi **đã ghi ở cycle 53**; đọc lại, nội dung **không đổi một byte** (cùng mốc 01:27:42, cùng 21/21 và 18/18). Tôi **không** viết bản sao thứ hai.
> 3. **Hai tên trong packet không tồn tại** (0 hit), và một tên còn **gán nhầm parent CR28**: xem Δ-A55-1.

### 54.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **W-WORKER-SDK-ARTIFACT-METADATA-NEGATIVE** (tên packet **đúng**) | tester.md 9602, 01:32:35, task_21ff9b1144d6. Chỉ thêm test vào `artifact-read-metadata.test.ts`, **không** sửa production. Từ chối **trước khi lấy byte** khi download URL thiếu hoặc không phân giải được, huỷ + `TOO_LARGE` với header `content-length` quá lớn, và từ chối marker envelope mã hóa **không đầy đủ**; coverage digest-corruption có sẵn vẫn còn. 3 lần × 1 suite/10 test exit 0; tsc 0 |
| E2 | **W-DOC-CORE-INGEST-SOURCE-PIN-NEGATIVE** (tên packet **đúng**) | tester.md 9642, 01:45. Chỉ mở rộng `ingest-source-pin.test.ts`, production không đổi. Validation chặt từ chối trường source URL nhúng `file:` và trỏ domain ngoài; chuẩn bị nguồn từ chối grant hết hạn và từ chối artifact thuộc tenant khác khi read grant bị từ chối. 3 lần × 1 suite/18 test exit 0; tsc 0 |
| E3 | **Bẫy đếm số duy nhất lần này** | Tôi đếm: `ingest-source-pin.test.ts` khai báo **12** + **1 khối it.each** ⇒ **18 là số chạy, 12 là số khai báo**. Ba suite còn lại khai báo bằng chạy: metadata 10, crypto-metadata 55, idempotency 27 |
| E4 | **Tên thật Mục 37 platform — VÀ parent CR28 SAI** | Packet gọi `W-PLAT-CR28-04-METADATA-CRYPTO-BOUNDARY-TEST`; **không tồn tại**, và mục thật nằm dưới **CR28-01**, không phải CR28-04. Thật là `W-CR28-01-METADATA-BOUNDARY-NEGATIVES`, task_08997413d814 |
| E5 | Muc 37 — 8 test, **0 dòng production** | Từ chối `contextAad` không phải base64 hợp lệ (không parse nới); `contextAad` hoán sang context khác → `CONTEXT_MISMATCH` trong khi bản gốc **vẫn mở được** dưới binding của nó (chứng minh fixture không hỏng); lệch **từng chiều** trong ba chiều slot/row/tenant; slot không hợp lệ → `INVALID_INPUT` **trước khi** chạm key provider (`stats.wraps === 0`); `tenantId`/`refId` rỗng → `INVALID_INPUT` để không seal với AAD rỗng; sai key khi đọc → fail closed không trả plaintext; provider unwrap hỏng → `KEY_PROVIDER_FAILED` |
| E6 | **Δ76 MỚI — đo, không giả định** | `deriveAad` = `sha256(tenantId|slot|refId, utf8)`; JS **thay thế** byte lạ bằng U+FFFD, nên hai chuỗi khác byte có thể hóa cùng một binding ⇒ **va chạm AAD về lý thuyết**. Lane **không** tuyên bố "đã chứng minh an toàn" và cũng **không** viết test xanh rỗng kiểu "kết quả thuộc {mở, từ chối}" mà không nói gì; test ghi rõ: hoặc mở, hoặc từ chối, **nhưng không bao giờ là thành công âm thầm không phân biệt được với binding sạch**. Chặn tenantId không UTF-8 là **thay đổi production ngoài write scope**; đề xuất: reject code point thay thế, hoặc bắt tenantId là ASCII/UUID. Rủi ro thực tế thấp vì tenantId vẫn phải khớp qua auth trước khi tới seam |
| E7 | Muc 37 — mutation **BẮT ĐƯỢC** | Bỏ `refId` khỏi AAD (mất chiều row) ⇒ **5 test đỏ**: 3 test cũ + 2 test mới. Khác hẳn Muc 36 kỳ trước, mutation ở đây **cắt thật**. Restore byte-exact `metadata-crypto.ts` sha `aa200211` / 12138 B; `server.ts` và `runtime.ts` không đụng |
| E8 | Muc 37 verify | `runtime-encryption-metadata` 3 lần **55/55** Exit **0/0/0** (47 của Muc 35 + 8 mới); tsc 0 **log rỗng**. Tôi đếm: **55 khai báo, 0 it.each** — khớp. Δ71/Δ74/Δ75/Δ69/Δ66 không đổi |
| E9 | **Tên thật Mục 42 admin** | Packet gọi `W-ADM-UX-04-IDEMPOTENCY-NEGATIVE`; **không tồn tại**. Thật là `W-ADMBASE-IDEMPOTENCY-NEGATIVE-HARDENING`, task_261984e0c6cd, dưới parent **ADM-BASE** chứ không phải ADM-UX-04 |
| E10 | Mục 42 — **đọc trước, cố ý không viết trùng** | **KHÔNG sửa mã nguồn**, chỉ thêm test vào `admin-idempotency.test.ts` (**14 → 27**, 3 → 5 describe). Đã phủ sẵn và **để nguyên**: 409 khi payload khác, 409 khi route khác, 422 malformed key (ngắn / có space / 201 ký tự), race rollback, misuse guard, purge, hash ổn định. 13 test mới nhắm khoảng trống thật |
| E11 | Mục 42 — **bốn nhóm khoảng trống thật** | **Envelope**: test cũ chỉ dùng `rejects.toMatchObject` trên status+code, **chưa** kiểm envelope thật; nay đi qua `toProblem()`: 422 với type `urn:du:error:invalid_schema` + correlationId echo, 409 với `urn:du:error:idempotency_conflict`, và envelope **không chứa** key/payload đã gửi. **Side effect**: test cũ chỉ assert `counters.runs === 1`; nay assert work **không** chạy lần 2 **và** `world.committed.length` **không đổi**. **Boundary** (`/^[!-~]{8,200}$/`): 8 ký tự **PASS** / 7 fail, 200 **PASS** / 201 fail, ký tự điều khiển và phiên tự → 422 — vì test cũ **chỉ** kiểm chiều fail, chưa kiểm chiều **accept** ở đúng biên nên lỗi off-by-one trong regex lọt. **Replay trung thực**: marker lưu **200** thì replay ra **200**, không phải 201 mới — vì test cũ chỉ lưu 201 nên regression đổi status lọt |
| E12 | Mục 42 — **expiry: map, không bịa** | Spec nói expired token, nhưng module idempotency **không có** token hết hạn; thứ duy nhất có tuổi là **marker TTL** qua purge. Lane map sang đó và **không** viết test token giả. Hai ca: purge tôn trọng tham số cửa sổ và trả đúng số đã xoá; sau khi hết hạn thì key **tái sử dụng được** (cùng key + payload **khác** chạy lại thay vì 409 vĩnh viễn). Ca thứ hai là ca quan trọng: nếu purge để lại tombstone thì client retry sau cửa sổ bị khoá vĩnh viễn khỏi chính key của nó |
| E13 | Mục 42 — **một lần đỏ tạm thời, BÁO không giấu** | Trong 1/4 lần chạy batch 5 suite, `admin-error-boundary-offline.test.ts` đỏ **2 test**. Điều tra: chạy riêng **22/22 xanh**; chạy lại đúng batch **200/200 xanh**, lặp lại 2 lần nữa vẫn xanh. File đó bind loopback thật và các suite audit cũng bind ⇒ **va chạm port tạm thời** giữa các suite bind đồng thời, **không** phải do thay đổi của lane (không sửa file đó). Đây là lần **thứ hai** cùng lớp lỗi (sau flake EADDRINUSE ở Muc 36); port đã sửa cho 2 suite audit nhưng **chưa** rà toàn bộ ⇒ **nợ kỹ thuật thật chưa đóng**, cần packet riêp chuẩn hoá cách cấp port cho **mọi** suite bind loopback |
| E14 | Mục 42 verify | **27/27 ×3**; orchestrator typecheck Exit **0**; batch 5 suite **200/200 ở 3/4 lần chạy**. Tôi đếm: **27 khai báo, 0 it.each** |
| E15 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=197 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E16 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — các mục mới ghi tên receipt trong backtick, **không** nhúng link mới |

### 54.2 Δ

- **Δ-A55-1 (tên sai VÀ gán nhầm parent CR28):** `W-PLAT-CR28-04-METADATA-CRYPTO-BOUNDARY-TEST` và `W-ADM-UX-04-IDEMPOTENCY-NEGATIVE` cho **0 hit**. Tên thật lần lượt là `W-CR28-01-METADATA-BOUNDARY-NEGATIVES` (**CR28-01**, không phải CR28-04 như packet ghi) và `W-ADMBASE-IDEMPOTENCY-NEGATIVE-HARDENING` (**ADM-BASE**, không phải ADM-UX-04). Số liệu packet khớp cả hai.
- **Δ-A55-2 (packet liệt kê receipt ĐÃ ĐỒNG BỘ ở cycle trước):** mục thứ 5 là receipt tôi đã ghi ở Mục 53; đọc lại **không đổi một byte**. Tôi **không** viết bản sao, và docs/28 vẫn chỉ nhắc tên nó **đúng một lần** (ở mục của cycle 53).
- **Δ-A55-3 (Δ76 MỚI — phát hiện thiết kế, không phải lỗi test):** AAD derive bằng cách thay thế byte của JS, nên hai `tenantId` khác byte có thể hóa cùng một binding. Rủi ro thực tế thấp, nhưng **chặn chặt** là thay đổi production. Quan trọng hơn: lane **từ chối** cả hai cách dễ sai — không tuyên bố an toàn, và không viết test xanh rỗng.
- **Δ-A55-4 (bẫy đếm số duy nhất):** `ingest-source-pin` **12 khai báo + 1 it.each = 18 chạy**. Ba suite còn lại khai báo bằng chạy (10 / 55 / 27).
- **Δ-A55-5 (nợ kỹ thuật chưa đóng, lần thứ hai cùng lớp):** va chạm port giữa các suite bind loopback đã xuất hiện **hai lần**; mới sửa cho 2 suite audit, **chưa** rà toàn bộ. Cần packet riêp chuẩn hoá cấp port cho mọi suite.
- **Δ-A55-6:** `G-ENC`, `G-DATA`, `G-ADMIN-OPS` vẫn **NO-GO**. Cả 4 receipt mới đều offline; không receipt nào promote gate.

### 54.3 Lỗi của chính tôi

1. **Ba assert của tôi fail vì needle, không phải vì nội dung** — và tôi mất **bốn vòng** mới chấp nhận điều đó. Lần đầu tôi thêm backtick vào needle; lần sau tôi lại kiểm cụm nằm ở file khác; chỉ khi in ra **dòng thật** tôi mới thấy fragment ghi `0 it.each` không có backtick bao quanh. Bài học: khi một assert fail lần thứ hai với cùng một nội dung, hãy in dòng thật **ngay** thay vì sửa needle thêm lần nữa — đây là lần thứ tư tôi mắc lỗi này trong các cycle gần đây.
2. **Một kiểm tra của tôi quá chặt và báo sai:** tôi yêu cầu docs/28 **không** nhắc receipt trùng, trong khi mục của cycle 53 **đã** nhắc hợp lệ. Tôi sửa thành "đúng **một** lần, thuộc cycle trước" thay vì "0 lần" — đây là kiểm tra đúng, không phải nới lỏng để qua.
## 55 — CYCLE 55: Turn 332 — năm receipt negative-test vào docs/28 + docs/35 (1.56.0 → 1.57.0)

> **RESUME POINT — cycle 55 (packet D-DOCS-EVID-SYNC / Turn 332, task task_9cb53198ebae, dispatch ctx_9cb53198ebae, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–54 giữ nguyên phía trên như lịch sử.
> 1. **Hai tên trong packet không tồn tại** (0 hit toàn workspace): `W-ADM-UX-05-AUDIT-TOOLBAR-NEGATIVE` và `W-PLAT-CR28-01-STORAGE-FACADE-CRYPTO-BOUNDS`. Số liệu packet khớp cả hai; tôi ghi theo tên thật và báo lệch.
> 2. **Còn một receipt thứ 6 nằm cùng cửa sổ nhưng không có trong packet** (`W-WORKER-SDK-SERVICE-AUTH-NEGATIVE`, tester.md 9700). Tôi **ghi một mục ngắn để có mặt trong hồ sơ** nhưng **không** coi nó là phần của packet này.
> 3. **`docs/28` giữ version `1.48.0`**: lệnh bump của packet nói 1.56.0 → 1.57.0, đó là version của **docs/35**. Tôi bump đúng file đó và **không** tự ý bump thêm file không được nhắc.

### 55.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **W-WORKER-SDK-TEMP-WORKSPACE-NEGATIVE** (tên packet **đúng**) | tester.md 9651, 02:41:13, task_4e8240b75181. Chỉ thêm test vào `temp-workspace.test.ts`, **không** sửa production. Root không tồn tại → `ENOENT` khi tạo và sweep trả kết quả rỗng; tên traversal và dấu phân tách đường dẫn bị từ chối; **lỗi quyền khi sweep GIỮ lại** thư mục cũ để thử lại; lỗi dispose ngoài dự kiến **ném về caller**. 3 lần × 1 suite/6 test exit 0; tsc 0 |
| E2 | Tôi đếm | `temp-workspace.test.ts` = **6 khai báo, 0 it.each** — khai báo **bằng** chạy |
| E3 | **T-CODEX-OFFLINE-WORKSPACE-AND-TIMEOUT-INDEPENDENT** (tên packet **đúng**) | tester.md 9660, 03:07:29, task_1150021b384f, read-only. Xác nhận **cả hai** suite và **cả hai** typecheck. Temp-workspace 3 × 6 = **18/18**; ingest-timeout-recovery 3 × 5 = **15/15**. Hai tsc exit 0; **mọi gate vẫn NO-GO**, receipt chỉ ghi bằng chứng |
| E4 | **W-DOC-CORE-INGEST-TIMEOUT-RECOVERY-NEGATIVE** (tên packet **đúng**) | tester.md 9691, 02:45:33, task_7a5feb1453f7. Chỉ thêm test, production không đổi. Timeout bằng **0** và **âm 1** bị từ chối; tín hiệu task đã abort sẵn fail **trước khi** parse với `LEASE_LOST`; lần đọc dở dang thì timeout và được dọn; hồi phục dưới **task id khác** đọc byte sạch đã kiểm chứng mà **không** dùng lại file dở dang của task hết hạn. 3 lần × 1 suite/5 test exit 0; tsc 0 |
| E5 | **Bẫy đếm số duy nhất lần này** | `ingest-timeout-recovery.test.ts` khai báo **4** + **1 khối it.each** ⇒ **5 là số chạy, 4 là số khai báo**. File temp-workspace thì khai báo bằng chạy (6). **18 và 15 là TỔNG ba lần chạy**, không phải số mỗi lần |
| E6 | **Tên thật Mục 43 admin** | Packet gọi `W-ADM-UX-05-AUDIT-TOOLBAR-NEGATIVE` — **không tồn tại**. Thật là `W-ADM-UX-03-TOOLBAR-BOUNDS-NEGATIVE`, task_3bcbacb4bbd3 |
| E7 | Mục 43 — **KHÔNG sửa mã nguồn**, +10 test (57 → 67) | Lane **khảo sát trước**: bốn ca spec (from > to, limit phân số, severity sai, actor quá dài) **đã có sẵn** ở toolbar:109/161/243 và query:195/206/214 nên **không viết lại**; 10 test mới nhắm phần còn thiếu: cửa sổ một phía, cửa sổ nửa hỏng, đường **NaN**, severity rỗng/khoảng trắng/chữ hoa, và token dài nhưng **sạch** |
| E8 | Mục 43 — **phát hiện sai payload do lane TỰ BẮT** | Test đầu dùng chuỗi 64 ký tự `a` và **đỏ**. Lane cho rằng sai ranh giới 64 nên viết probe quét độ dài 1..70 → kết quả **ACCEPTED_MAX = 31, không phải 64**. Nguyên nhân **không** nằm ở regex: token pattern cho tới 64 (đã kiểm cả src lẫn dist), và thứ **thật sự** chặn là `SOLID_HEX_PATTERN` mà `a` **là** hex hợp lệ. Payload đó bị loại vì lý do **solid-hex**, không phải vì độ dài |
| E9 | Mục 43 — **vì sao điều trên quan trọng** | Nếu chỉ nhìn test đỏ rồi sửa con số cho xanh, lane sẽ khoá **SAI THỨ**: test pass vì một luật hoàn toàn khác và **không bảo vệ gì** cho ranh giới độ dài. Sửa bằng ký tự `z` (không phải hex): 64 `z` được nhận, 65 bị loại **vì độ dài**. Probe đã **xoá**, không để lại trong file |
| E10 | Mục 43 — **10 test mới** | Actor sạch 65 ký tự bị loại với biên **64 nhận / 65 loại**; limit NaN / `abc` / Infinity → **về mặc định hợp đồng**, không bao giờ là NaN; limit âm và phân số (-5, 1.9) → kẹp lên 1; limit hai đầu (1 nhận, 200 nhận, 201 → 200); cửa sổ một phía **được chấp nhận**; cửa sổ nửa hỏng (from hợp lệ + to hỏng) → **giữ from**, chỉ nêu tên `to`; severity rỗng/khoảng trắng = **vắng mặt**, không bị ghi là từ chối; severity chữ hoa bị loại **và được nêu tên**, không fold âm thầm (ghim lại Mục 31); action sạch 300 ký tự bị loại |
| E11 | Mục 43 verify + **lần đỏ thứ BA** | **67/67 ×3**; typecheck Exit **0**; hồi quy (query, mount, route, idempotency) **76/76**. Một lần chạy hồi quy, `admin-audit-query.test.ts` đỏ 1 test; chạy riêng **26/26 xanh** và chạy lại đúng batch **76/76 xanh** ⇒ **va chạm port loopback tạm thời**, không phải do thay đổi. Đây là lần thứ **ba** cùng lớp lỗi (Mục 36, 42, 43) |
| E12 | Mục 43 — **nợ kỹ thuật, không còn thỉnh thoảng** | Receipt nói thẳng: nếu không có packet riêng chuẩn hoá cách cấp port cho **mọi** suite bind loopback thì **mọi** lần chạy song song đều mang rủi ro báo đỏ giả. G-ADMIN-OPS vẫn **NO-GO**, ADM-UX-02 vẫn `[~]` |
| E13 | **Tên thật Mục 38 platform** | Packet gọi `W-PLAT-CR28-01-STORAGE-FACADE-CRYPTO-BOUNDS` — **không tồn tại**. Thật là `W-CR28-01-FACADE-BOUNDARY-NEGATIVES`, task_be3bf21a6279 |
| E14 | Mục 38 — **9 test, 0 dòng production** (18 → 27) | **Chunk-count boundary**: manifest **đúng bằng** `maxChunks` được nhận, thấp hơi 1 thì từ chối (biên hai chiều), và `maxChunks` vô nghĩa lúc khởi tạo (0, -1, 65537, 1.5, NaN) bị từ chối. **Sidecar không hợp lệ**: field **ngoài allow-list**, `chunks.length` lệch `totalChunks`, và **nonce trùng lặp** giữa các chunk — tái sử dụng nonce là thảm kịch với GCM. **Non-JSON sidecar**: string / null / số / mảng / bool / undefined. **Thiếu envelope header**: từ chối khi thiếu **từng field** một, cộng `version`/`algorithm` sai |
| E15 | Mục 38 — **ghi chú phạm vi, đo không giả định** | Byte sidecar được fetch + `JSON.parse` ở **S3 adapter trong `server.ts`** — ngoài write scope. Cái facade **sở hữu** (và test ở đây ghim) là **nửa thứ hai**: cho một giá trị đã ra từ sidecar, facade có **từ chối** hay không. Một `non-record` phải bị từ chối chứ **không** ném TypeError từ `isRecord` |
| E16 | Mục 38 — **mutation KHÔNG hợp lệ, báo thẳng** | Tắt kiểm tra allow-list của manifest (`if (false && Object.keys...)`) → **không compile** (`Tests: 0 total`) vì biến thành dead code mà TypeScript bắt. Đây là **probe vô hiệu**, **không** tính là bằng chứng. Trong 9 test, nhóm **envelope header** (8/9) và **chunk count** (1/2/3) có giá trị cao nhất vì đẩy dữ liệu thật qua facade; nhóm **allow-list / nonce / non-JSON** kiểm input-shape và lane **chưa tìm được** mutation **compile được** mà vẫn đổi hành vi. Ghi lại để không ai tưởng cả 9 đều đã mutation-verify |
| E17 | Mục 38 verify | **27/27 ×3** Exit **0/0/0**; `tsc` exit 0 **log rỗng**; test file sha `120a4aa9` / 30204 B; **`crypto-storage-facade.ts` không đổi** sha `dcd7e3db` / 31593 B; `server.ts` không đụng sha `22afb2ff`. Δ74/Δ71/Δ75/Δ69/Δ66/Δ76 không đổi; **Δ71 vẫn là delta DUY NHẤT có hệ quả production và vẫn chưa có quyết định** |
| E18 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=198 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E19 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — các mục mới ghi tên receipt trong backtick, **không** nhúng link mới |

### 55.2 Δ

- **Δ-A56-1 (hai tên trong packet không tồn tại):** `W-ADM-UX-05-AUDIT-TOOLBAR-NEGATIVE` và `W-PLAT-CR28-01-STORAGE-FACADE-CRYPTO-BOUNDS` cho **0 hit**. Tên thật: `W-ADM-UX-03-TOOLBAR-BOUNDS-NEGATIVE` và `W-CR28-01-FACADE-BOUNDARY-NEGATIVES`. Số liệu packet khớp cả hai.
- **Δ-A56-2 (một receipt ngoài packet, tôi ghi nhưng KHÔNG coi là phạm vi):** `W-WORKER-SDK-SERVICE-AUTH-NEGATIVE` (tester.md 9700, 03:14:01) — 15 test ×3, tsc 0, cùng cửa sổ Turn 332. Tôi đưa vào `docs/28` dưới dạng mục **ghi nhận**, không phải mục của packet này; nếu coordinator muốn đồng bộ đầy đủ thì cần packet riêng.
- **Δ-A56-3 (lần đỏ tạm thời thứ BA, đã thành nợ kỹ thuật):** va chạm port loopback giữa các suite bind đồng thời xuất hiện **ba lần** (Mục 36, 42, 43). Mỗi lần đều điều tra đúng — chạy riêng xanh, chạy lại batch xanh — nhưng **nợ chuẩn hoá cấp port cho mọi suite** vẫn chưa đóng, và mọi lần chạy song song vẫn mang rủi ro báo đỏ giả.
- **Δ-A56-4 (bẫy đếm số lần này):** `ingest-timeout-recovery` **4 khai báo + 1 it.each = 5 chạy**. `18`/`15` là **tổng ba lần**, không phải số mỗi lần. `temp-workspace` khai báo bằng chạy (6).
- **Δ-A56-5:** `G-ENC`, `G-DATA`, `G-ADMIN-OPS` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả receipt mới đều offline; **không** receipt nào promote gate. **Δ71 vẫn chưa có quyết định** và là delta duy nhất có hệ quả production.

### 55.3 Lỗi của chính tôi

1. **Tôi mất năm vòng verify vì needle quá chặt, và đó là lần thứ năm trong các cycle gần đây.** Fragment tôi viết có `0 it.each` **không** backtick ở đúng một dòng, trong khi dòng khác cùng mục lại **có** backtick; tôi suýt "sửa" tài liệu cho khớp needle. Bài học đã viết vài lần trong các receipt gần đây, nay tôi ghi lại vì **tôi chưa thực hành**: khi assert fail, hãy in **dòng thật** ở vòng thứ hai, đừng sửa needle ở vòng thứ ba.
2. **Tôi suýt bump cả `docs/28`.** Lệnh của packet là 1.56.0 → 1.57.0, đó là version của `docs/35`; `docs/28` có version riêng (1.48.0). Tôi dừng lại và chỉ bump đúng file được nhắc — kiểm tra cuối xác nhận `docs/28` vẫn nguyên 1.48.0.
## 56 — CYCLE 56: D-DOCS-EVID-SYNC-334 — sáu receipt Turn 333/334 vào docs/28 + docs/35 (1.57.0 → 1.58.0)

> **RESUME POINT — cycle 56 (packet D-DOCS-EVID-SYNC-334, Turn 333 + Turn 334, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–55 giữ nguyên phía trên như lịch sử.
> 1. **Lần đầu tiên sau nhiều cycle: MỌI tên trong packet đều tồn tại** (0 hit trên toàn bộ 6 tên). Hai cycle trước phải sửa tên bịa; cycle này không có gì để sửa.
> 2. **`docs/28` giữ version `1.48.0`** — lệnh bump 1.57.0 → 1.58.0 là version của **docs/35**. Tôi bump đúng file được nhắc, không tự ý bump thêm.
> 3. **Gate giữ nguyên NO-GO** theo yêu cầu, và receipt của lane cũng tự ghi rõ: **test xanh KHÔNG phải tín hiệu GO**.

### 56.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **Định vị 6 receipt** | Cả 6 tồn tại và tên khớp packet: `W-PLAT-CR28-01-GRANT-ARTIFACT-PINS-NEGATIVE` (qwen-platform Muc 40, L3626), `W-WORKER-SDK-CONNECTOR-INVOKER-NEGATIVE` (tester 9822), `W-DOC-CORE-INGEST-SCAN-TAMPER-BOUNDARY` (tester 9781), `T-CODEX-OFFLINE-CONNECTOR-INVOKER-AND-SCAN-TAMPER-INDEPENDENT` (tester 9791), `W-WORKER-SDK-CONNECTOR-INPUT-CONTRACT-NEGATIVE` (tester 9832), `W-DOC-CORE-INGEST-WIRE-NEGATIVE` (tester 9841) |
| E2 | **Grant artifact pins** (Turn 333) | Muc 40, task_06ea09424751. **13 test mới** (2 → **25**) trong `grant-artifact-pins.test.ts`; **chỉ** sửa file test — `grants.ts` sha `c3382fe3` / 16621 B và `server.ts` sha `22afb2ff` **không đụng**. Thêm helper `makeGrantServiceWithLease` để điều khiển lease (epoch + hạn) của task, vì đó là biến thật quyết định cửa sổ sống của pin |
| E3 | Grant — gate | Receipt mở đầu bằng **GATE NO-GO — giữ nguyên**: ENC-04 vẫn NO-GO, **chỉ thêm test**, không bật seam, không nới gate; **Test xanh KHÔNG phải tín hiệu GO**. Còn mở: Δ69, Δ66, Δ74, Δ75, Δ76, **Δ71** (vẫn delta duy nhất có hệ quả production chưa quyết) |
| E4 | Grant — cross-tenant + liveness | Tenant lạ bị từ chối **trước** khi ghi grant row (`BINDING_DENIED` + **không** có `INSERT`), kể cả khi mọi trường pin khác hợp lệ. **Task lease hết hạn** → `LEASE_LOST`, pin không được tạo; **lease epoch cũ** → `LEASE_LOST` **trước khi** chạm bảng `artifacts` |
| E5 | Grant — integrity drift | 8 biến thể (sha256 rỗng/null, fileName null, mimeType null, sizeBytes 0/âm/thập phân/không phải số) → `BINDING_DENIED`, không ghi grant. postgres **suy ra** version từ sha256 còn s3 **không** — khác nhau **có chủ đích**. artifactId lệch không mượn được row khác; artifact ngoài operation của task nhưng **tenant vẫn khớp** vẫn bị từ chối |
| E6 | Grant — **HAI mục packet KHÔNG tồn tại, lane KHÔNG bịa test** | (a) *"expired pin"*: `grants.ts` **không có** khái niệm hạn artifact; pin bị vô hiệu hoá bằng **state** (`STAGING`/`EXPIRED`/`DELETED`), mốc hạn duy nhất là lease task và `GRANT_TTL_SECONDS` ⇒ lane test lease hết hạn/epoch cũ và ghi test `FINDING` rằng **không có** expired-PIN để từ chối, để **sự vắng mặt hiện ra** thay vì bị đọc nhầm là "chưa test". (b) *"hash bị tampered"*: mã **không** tính lại digest, chỉ kiểm sha256 **có mặt** rồi **chép nguyên văn** vào pin ⇒ test **không** khẳng định tamper bị bắt, mà ghi rõ hash sai (`f`.repeat(64)) **vẫn được pin trung thực** |
| E7 | Grant — **hai lỗi thật của chính lane** | Bản đầu khẳng định postgres thiếu version và purpose lạ đều bị từ chối; **cả hai đỏ**, và khi đọc log rồi đọc source thì **lane sai, không phải sản phẩm**: postgres **suy ra** version từ sha256 (`grants.ts:247-248`); cổng `purpose` (`:241`) chỉ định nghĩa nhánh declared-reference, còn artifact **cùng operation** đi qua `sameOperation` nên `intermediate` vẫn pinnable hợp lệ. Cả hai test viết lại theo hành vi thật và chuyển thành `FINDING` |
| E8 | Grant — mutation + verify | M1 hợp lệ: gỡ `artifact.tenantId !== t.tenant_id` khỏi guard → **3 test đỏ**, gồm **cả hai** cross-tenant mới; restore byte-exact. **25/25 ×3** Exit **0/0/0**; orchestrator `tsc` exit 0 **log rỗng**; test file sha `fd9bb785` / 16077 B |
| E9 | **Δ77 MỚI (cần coordinator)** | `artifact.sha256` được **chép trung thực** vào pin mà **không** được xác thực nội dung. Row bị sửa/đổi digest sẽ được pin như đúng và chỉ bị phát hiện ở tầng khác — hoặc **không bao giờ**. Chặn tại đây cần kiểm tra kiểu `createPublicKey` trên bytes: **thay đổi production**, ngoài write scope |
| E10 | **Δ78 MỚI** | `purpose` **không phải** allow-list (`input`/`output`) trên nhánh same-operation; artifact `intermediate` hoặc typo vẫn pinnable được. Có thể **cố ý** (artifact thuộc task không cần khai báo trước) nhưng nên **chốt** thành quyết định chứ không để lơ lửng |
| E11 | **Ingest scan tamper boundary** (tester 9781, 03:25:18) | Chỉ thêm test, production không đổi. Từ chối: checksum đổi ở chunk stream **sau**, stream bị cắt **ngay sau** PNG magic bytes, và content length khai **lớn hơn** số byte thực đọc — mọi ca đều xác nhận **không** có connector invocation. 3 lần × 1 suite/9 test exit 0; tsc 0 |
| E12 | **Receipt độc lập** (tester 9791, 03:55:39) | Read-only, không sửa source/test. Xác nhận **cả hai** suite: connector-invoker 3 × **17** = **3/3 suite, 51/51 lần chạy**; ingest-scan-tamper 3 × **9** = **3/3 suite, 27/27 lần chạy**. Cả hai `tsc` exit 0; mọi gate vẫn **NO-GO** |
| E13 | **Connector invoker negatives** (tester 9822, 03:31:30) | Chỉ thêm test, không sửa production. Artifact request **> 64 MiB** bị từ chối **trước** khi fetch; fetch đang chờ nhận tín hiệu `AbortController` của timeout và quan sát nó abort; body success **non-JSON** và stream hỏng fail closed thành `INVOCATION_UNKNOWN`. 3 lần × 1 suite/17 test exit 0; tsc 0 |
| E14 | Connector invoker — **giới hạn do receipt tự nói** | Ca oversized khẳng định việc từ chối **trước HTTP dispatch**, **không** phải một error class cụ thể. Mọi gate vẫn **NO-GO** |
| E15 | **Input contract negatives** (tester 9832, 03:59:12) | Chỉ thêm test contract validation, không sửa production. Thiếu field envelope bắt buộc; biên byte/count của artifact; giá trị MIME/header dị dạng và **có CRLF chèn**; authorization header ngoài dự kiến; UUID, tham số step/task, options, session reference và deadline không hợp lệ. 3 lần × 1 suite/25 test exit 0 (receipt ghi **75 lần chạy** tổng); tsc 0 |
| E16 | **Ingest wire negatives** (tester 9841, 04:00:17) | Chỉ thêm test, production không đổi. Artifact bytes dị dạng bị từ chối trong payload JSON **và** multipart; giá trị multipart header không hợp lệ bị từ chối **trước transport**; ngăn connector dispatch sau stream nguồn bị gián đoạn; xác nhận CR/LF và dấu nháy được escape trong Content-Disposition **mà không chèn header**. 3 lần × 1 suite/15 test exit 0; tsc 0 |
| E17 | **Bẫy đếm số — 3/5 suite lệch** | Tôi đếm: connector-invoker **9 khai báo + 3 khối it.each = 17 chạy**; input-contract **8 + 3 = 25**; grant-pins **14 + 2 = 25**. Còn lại scan-tamper **9 khai báo, 0 it.each** và ingest-wire **15, 0** ⇒ khai báo bằng chạy. **51, 27, 75 là TỔNG ba lần**, không phải số mỗi lần |
| E18 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=200 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E19 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — các mục mới ghi tên receipt trong backtick, **không** nhúng link mới |

### 56.2 Δ

- **Δ-A57-1 (điểm đáng chú ý nhất của cycle):** receipt của lane thừa nhận **hai mục packet không có hành vi tương ứng** — "expired pin" (vì pin bị vô hiệu hoá bằng `state`, không có khái niệm hạn artifact) và "hash bị tampered" (vì mã **chép nguyên văn** sha256 mà không tính lại digest). Thay vì bịa test xanh, lane test **cửa sổ sống thật** (lease hết hạn/epoch cũ) và ghi test `FINDING` để **sự vắng mặt hiện ra**. Đây là mẫu tôi muốn giữ: absence phải được tài liệu hoá, không được để trống rồi bị đọc nhầm là chưa test.
- **Δ-A57-2 (Δ77 MỚI):** digest được ghim trung thực mà **không xác thực nội dung** — row bị đổi digest vẫn hợp lệ và có thể không bao giờ bị phát hiện. Chặn cần kiểm tra kiểu `createPublicKey` trên bytes: **thay đổi production**.
- **Δ-A57-3 (Δ78 MỚI):** `purpose` không phải allow-list trên nhánh same-operation; `intermediate`/typo vẫn pinnable được. Có thể cố ý, nhưng nên **chốt**.
- **Δ-A57-4 (lane tự bắt lỗi của chính mình, hai lần):** khẳng định postgres thiếu version và purpose lạ bị từ chối — **cả hai sai**, và khi đọc log rồi đọc source mới thấy **lane** sai chứ không phải sản phẩm. Cả hai test viết lại theo hành vi thật. Bài học lane đã ghi: **đọc log trước, đọc source sau, rồi mới sửa**.
- **Δ-A57-5 (bẫy đếm số lớn nhất từ trước tới nay):** **3/5 suite** có khai báo **khác** số chạy (9→17, 8→25, 14→25) vì khối `it.each`. Mọi tổng `51`/`27`/`75` là **tổng ba lần chạy**.
- **Δ-A57-6:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 6 receipt đều offline, chỉ thêm test, **không** receipt nào promote gate. Δ69/Δ66/Δ74/Δ75/Δ76/Δ71 cũ vẫn mở.

### 56.3 Lỗi của chính tôi

1. **Tôi lại mắc lỗi needle — lần thứ sáu, và lần này tôi tự nhận trước khi nó tốn thêm vòng nữa.** Fragment tôi viết có `**Δ77 (MỚI, ...)**` và `**Δ78 (MỚI):**`, còn needle tôi đoán lại bỏ dấu `**` ở chỗ khác. Tôi **in dòng thật ở vòng thứ hai** thay vì sửa needle tiếp — đúng bài học tôi đã viết ở Mục 53/54/55. Nội dung trong cả ba trường hợp đều **có đủ**; chỉ phép so sánh của tôi sai.
2. **Packet lần này không có task id hay dispatch id.** Task `task_9cb53198ebae` mà tôi thử ở cycle trước **không tồn tại** trong run (đã tra 201 task, không có `D-DOCS-EVID-SYNC-332`). Cycle này prompt lại **không** cấp id nào, nên tôi gửi **status** về coordinator handle được chỉ định thay vì bịa `worker_done`.
## 57 — CYCLE 57: D-DOCS-EVID-SYNC-335 — năm receipt Turn 334/335; grant fencing là [SKIP-QUALIFIED] chứ không phải PASS; port isolation đóng nợ flake

> **RESUME POINT — cycle 57 (packet D-DOCS-EVID-SYNC-335, Turn 334 + Turn 335, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–56 giữ nguyên phía trên như lịch sử.
> 1. **Cả 5 tên trong packet đều tồn tại** (0 hit trên toàn bộ 5 tên) — giữ được kỷ lục của cycle 56.
> 2. **Một receipt KHÔNG phải PASS, và tôi ghi nguyên văn**: `W-PLAT-CR28-02-ARTIFACT-GRANT-FENCING-NEGATIVE` mở đầu bằng chữ in hoa **[SKIP-QUALIFIED] — KHÔNG phải [PASS]**. Đây là điểm quan trọng nhất của cycle và tôi **không** làm nó thành một dòng xanh.
> 3. **Một receipt đóng nợ kỹ thuật** mà inventory đã cảnh báo từ Mục 36: `W-ADM-UX-05-PORT-ISOLATION-HARDENING` xử lý triệt để lỗi `EADDRINUSE`.
> 4. **`docs/28` giữ version 1.48.0** — lệnh bump 1.58.0 → 1.59.0 là version của **docs/35**.

### 57.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **Định vị 5 receipt** | Cả 5 tồn tại, tên khớp: `T-CODEX-OFFLINE-INPUT-CONTRACT-AND-INGEST-WIRE-INDEPENDENT` (tester 9841), `W-WORKER-SDK-ARTIFACT-STREAM-BOUNDS-NEGATIVE` (9922), `W-DOC-CORE-BOUNDED-INPUT-NEGATIVE` (9881), `W-ADM-UX-05-PORT-ISOLATION-HARDENING` (qwen-admin Muc 45, L4550), `W-PLAT-CR28-02-ARTIFACT-GRANT-FENCING-NEGATIVE` (qwen-platform Muc 41, L3701) |
| E2 | **Input contract + ingest wire, độc lập** (tester 9841, 04:04:16) | Read-only, không sửa source/test. Worker SDK connector-input-contract 3 × **25** = **3/3 suite, 75/75 lần chạy**: input aliasing, required-field, artifact count/size/MIME/header bounds, injection defence, UUID + step/task, tham số type/range. Document Core ingest-wire 3 × **15** = **3/3 suite, 45/45 lần chạy**: OCR/digitize reference + bytes, fence foreign/expired, biên native, từ chối JSON/multipart dị dạng, interrupted-stream no-dispatch, escape filename an toàn. Cả hai `tsc` exit 0; **mọi gate vẫn NO-GO** |
| E3 | **Artifact stream bounds** (tester 9922, 04:10:04) | Chỉ thêm test, production không đổi. Stream vượt cap **1 byte** dừng kéo thêm nguồn; cắt đột ngột reject sau chunk dở; **chunk đảo thứ tự** fail SHA-256 mong đợi; caller abort huỷ stream upstream chưa đọc dưới backpressure. Case có sẵn còn phủ high-water mark trên 1 MiB. 3 lần × 1 suite/31 test exit 0; receipt ghi **93 lần chạy** tổng; tsc 0 |
| E4 | Stream bounds — **finding được ghi, không giấu** | Lỗi nguồn đột ngột reject stream, nhưng hiện tại bề mặt **lỗi upstream gốc** thay vì `ArtifactStreamError`/`TRANSPORT_FAILURE` có kiểu; task test-only này ghi nhận reject mà **không** đổi hành vi production đó. Gate **NO-GO** |
| E5 | **Bounded input** (tester 9881, 04:05:54) | Chỉ thêm test. Connector từ chối payload ảnh **0 byte** và ảnh vượt `CONNECTOR_ARTIFACT_MAX_BYTES`; parser **nhận** buffer **đúng bằng** trần cấu hình và **từ chối** vượt 1 byte; chuẩn bị nguồn từ chối nội dung mà định dạng text sniff **mâu thuẫn** metadata PDF khai. 3 lần × 1 suite/36 test exit 0; tsc 0 |
| E6 | **Độc lập thứ hai** (tester 9891, 04:33:24) | `T-CODEX-OFFLINE-STREAM-BOUNDS-AND-BOUNDED-INPUT-INDEPENDENT`: stream-bounds 3 × **31** = **3/3 suite, 93/93**; bounded-input 3 × **36** = **3/3 suite, 108/108**, phủ byte/image, artifact-count, document/text, page, schema, QA, generation, comparison-alias, nesting-depth, network-ref, legacy-parameter. Cả hai typecheck exit 0; gate **NO-GO** |
| E7 | **GRANT FENCING — [SKIP-QUALIFIED], KHÔNG phải [PASS]** (Muc 41, L3701) | Trạng thái verify ngay đầu receipt, **chữ in hoa**. Suite thuộc hạng **cổng live-DB** (`DU_LIVE_INFRA`); quy tắc lane là **không mở cửa sổ DB/Redis thật**, nên chỉ được **compile + chạy skip mode**. 3 lần cho ra `1 skipped, 0 of 1 total` / `18 skipped, 18 total` — **không có dòng PASS nào, 0 test thực thi**. Số 18 (10 cũ + 8 mới) là **số tự khai báo, KHÔNG phải số đã pass**. Bằng chứng thật duy nhất: **file biên dịch sạch** + **cổng giữ đúng**. Đây là bàn giao **compile-verified, chưa runtime-verified** |
| E8 | Grant — gate | ENC-04 vẫn NO-GO; chỉ thêm test, không bật seam, không nới gate; test xanh **hoặc** ở đây là compile **KHÔNG** phải tín hiệu GO. Còn mở: Δ69, Δ66, Δ74, Δ75, Δ76, **Δ77**, **Δ78**, **Δ71** |
| E9 | Grant — 8 test mới (10 → **18**) | Chỉ file test; `server.ts` sha `22afb2ff` **không đụng**. 2 helper: `seedTaskWithLease`, `readyArtifact`. **Cross-tenant**: api-key tenant B tải artifact của A → **404** (không 403 vì 403 rò existence); runtime token B trên blob grant của A → 403/404. **Expired task lease**: lease chết ⇒ grant upload mới bị từ chối 409 `LEASE_LOST`; grant cấp khi lease còn sống **rồi** lease chết ⇒ read grant 409. **Tampered token**: nối thêm/cắt/đảo/UUID giả + token thiếu/rỗng → 403. **Tenant mismatch**: finalize artifact của A bằng taskId của B → 409 `PERMISSION_DENIED` |
| E10 | Grant — **hai case tinh vi** | Case lease chết *sau khi* grant đã hợp lệ: token đúng không được sống dai. Case 7 ghim **phân biệt 403 với 404** — 403 khi token sai (chứng minh fence có so sánh), 404 khi token đúng nhưng hết hạn (không lộ vì sao); làm mờ hai mã này sẽ biến 404 thành **oracle tồn tại** |
| E11 | Grant — đồng thuận, không trùng lặp | Suite gốc đã có method fence, expired GRANT token 404, finalize lease/owner, access-grant owner fence, completion gate, result projection; test mới cố ý khác ở cross-tenant thật, **expired TASK LEASE** (khác hạn grant token, hai cái fail khác nhau), tampered token, tenant mismatch ở finalize |
| E12 | Grant — **M1 KHÔNG THỂ chứng minh, báo thẳng** | Packet yêu cầu mutation chứng minh test đỏ khi gỡ guard. Lane **đã làm M1** (gỡ `art.token !== grant` ở `server.ts:1397` → `if (false && ...)`) và **khôi phục byte-exact**, nhưng `tsc --noEmit` vẫn **sạch** (gỡ guard **vô hình** với kiểu) và suite vẫn **1 skipped, 18 skipped** ⇒ **không test nào chạy**, không quan sát được test đỏ. ⇒ **Không có bằng chứng mutation nào**; lane **không** tuyên bố M1 pass. Lý do cấu trúc: test đỏ đòi **cửa sổ DB thật** — việc của **Tester lane** có DB window |
| E13 | **Δ79 (MỚI, cần quyết định)** | Packet yêu cầu "chạy test 3 lần exit 0" **và** "mutation chứng minh test đỏ" — **cả hai không thể đạt trong lane này** vì suite thuộc hạng live-DB. Ghi nhận: `jest.unit.config.cjs` **cố ý loại** file này khỏi unit run (danh sách `liveSuites`, vì nó boot app thật với PG:5433/Redis:6380), nên lệnh `test` trong packet là **đường duy nhất** chạy được file này và nó **chính là** đường mở DB thật. Cần DB window cho **Tester lane**, hoặc coordinator cho phép mở cửa sổ |
| E14 | **PORT ISOLATION — đóng nợ flake** (Muc 45, L4550) | Chỉ sửa `tests/admin-audit-query.test.ts`; không đụng production. Mục tiêu: xử lý **triệt để** `EADDRINUSE` đã được inventory cảnh báo từ Mục 36 |
| E15 | Port isolation — **đo, và phát hiện hồi quy do chính lane** | Lane đổi sang `adminShellPort: 0` (OS gán ephemeral), tin đó chắc chắn nhất. **Đo** thì sai: stress 20 lần, bắt lần 14, lỗi gốc `connect EADDRINUSE 127.0.0.1:59673` — 59673 nằm trong **dải ephemeral của Windows (49152-65535)**, cùng dải Windows rút source port cho kết nối đi ra, nên listener **tranh** với chính request outbound của máy. Vậy port 0 là **hồi quy do lane gây ra, không phải lời giải**; đây cũng là lý do convention sẵn có của repo dùng ~44xxx |
| E16 | Port isolation — **bẫy thứ hai chứng minh thay vì giả định** | **2 instance chạy song song thì CẢ HAI đều đỏ** — hằng số cố định thì va nhau giữa các tiến trình. Sửa cả hai: dải **42000-42504** (dưới 49152) **và** retry có giới hạn **16 lần**, mỗi lần dời 8 cổng, **chỉ nuốt EADDRINUSE** và **ném lại mọi lỗi khác**; `listen()` reject qua `server.once(error)` nên retry dựa trên rejection hợp lệ, không cần đoán. Dải 42000 + (pid % 64) * 8 không trùng `admin-audit-mount` (45000+) hay `admin-shell-platform-mount` (44600+), nhưng lane **không** dựa vào đó — **retry mới là chốt chặn** |
| E17 | Port isolation — **dọn listener** | `afterAll` trước gọi thẳng `shell.handle.close()`; nếu `beforeAll` chết giữa chừng, shell là `undefined` và teardown **ném lỗi thứ hai đè lên lỗi thật**, che mất nguyên nhân mount thất bại. Đã guard cả hai listener |
| E18 | Port isolation — **tái hiện đúng điều kiện từng gây lỗi** | Không dừng ở 3 lần xanh. Trước khi sửa: 2 instance song song **2/2 đỏ**. Sau khi sửa, cùng đúng kịch bản: **3 instance song song 3/3 xanh**, thêm 3 vòng × 3 instance **9/9 xanh** (tổng 12 lần chạy song song), tuần tự ×3 **26/26** mỗi lần |
| E19 | Port isolation — **lỗi test lane tự gây, ghi ra không giấu** | Để truy một lần đỏ còn sót, lane tưởng `cursor=abc` làm route trả 422 nên **xoá cursor** khỏi request — nhưng **quên xoá assertion**, làm test đỏ vĩnh viễn ở 20/20 lần. Đã khôi phục cursor ở cả request lẫn assertion (test nhằm chứng minh forward **đủ** param). Bài học: sửa một test đang đỏ mà không hiểu vì sao đỏ, rồi chạy lại 20 lần, sẽ biến lỗi ngẫu nhiên thành lỗi chắc chắn |
| E20 | Bẫy đếm số | `artifact-stream-bounds` khai báo **18 + 3 khối it.each = 31 chạy**; `bounded-input` khai báo **36**, 0 it.each ⇒ khai báo bằng chạy; `artifact-grant-fencing` khai báo **18** nhưng **0 test thực thi** (xem E7). 75/45/93/108 đều là **tổng ba lần** |
| E21 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=201 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |

### 57.2 Δ

- **Δ-A58-1 (quan trọng nhất — MỘT RECEIPT KHÔNG PHẢI PASS):** `W-PLAT-CR28-02-ARTIFACT-GRANT-FENCING-NEGATIVE` là **[SKIP-QUALIFIED]**, **0 test thực thi**, bằng chứng duy nhất là compile sạch + cổng giữ. Tôi ghi nguyên văn chứ không diễn giải thành dòng xanh. Kèm theo: **Δ79** — yêu cầu verify của packet (3 lần exit 0 + mutation chứng minh test đỏ) **về mặt kỹ thuật không thể đạt** trong lane không có DB window, và `jest.unit.config.cjs` **cố ý loại** file này khỏi unit run.
- **Δ-A58-2 (nợ kỹ thuật ĐÃ ĐÓNG, nên báo là đã đóng):** lớp flake `EADDRINUSE` đã cảnh báo ở Mục 36/42/43 của inventory được xử lý **triệt để** — và bằng chứng là **tái hiện đúng điều kiện từng gây lỗi** (trước 2/2 đỏ, sau 3/3 rồi 9/9 xanh). Đáng ghi: cách "an toàn" đầu tiên của lane (port 0) hoá ra là **hồi quy** vì Windows rút source port từ **cùng dải ephemeral** — đo được, không đoán.
- **Δ-A58-3:** hai receipt độc lập (9841, 9891) xác nhận **bốn** suite; các tổng `75`/`45`/`93`/`108` là **tổng ba lần**, không phải số mỗi lần. `artifact-stream-bounds` khai báo 18 nhưng chạy 31; `bounded-input` khai báo 36 và chạy 36.
- **Δ-A58-4 (một finding production được ghi, không giấu):** stream abort đột ngột hiện bề mặt **lỗi upstream gốc** thay vì `ArtifactStreamError`/`TRANSPORT_FAILURE` có kiểu. Task test-only **không** sửa; đây là ứng viên delta cho lane sau.
- **Δ-A58-5:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 5 receipt đều offline; **không** receipt nào promote gate. Δ69/Δ66/Δ74/Δ75/Δ76/Δ77/Δ78/Δ71 cũ vẫn mở.

### 57.3 Lỗi của chính tôi

1. **Lần thứ bảy tôi mắc lỗi needle, và lần này tôi nhận ra ở vòng kiểm đầu tiên** nhờ kiểm lại chuỗi lấy từ chính file (thay vì đoán dấu `**`), nên chỉ tốn **một** vòng in dòng thật. Nội dung cả hai trường đều đầy đủ. Bài học tôi đã ghi ở Mục 53–56 giờ cho hiệu quả: **assert phải lấy chuỗi từ file, không viết tay**.
2. **Có một receipt độc lập thứ hai** (`T-CODEX-OFFLINE-STREAM-BOUNDS-AND-BOUNDED-INPUT-INDEPENDENT`, tester 9891) **không có trong packet** nhưng là bằng chứng độc lập cho đúng hai suite mà packet nêu. Tôi **đưa vào mục** vì nó xác nhận trực tiếp các receipt owner trong packet, và ghi rõ nó không phải mục riêng của packet này.
## 58 — CYCLE 58: D-DOCS-EVID-SYNC-336 — read-metadata + source-pin negatives; một receipt trong packet KHÔNG đổi so với cycle trước

> **RESUME POINT — cycle 58 (packet D-DOCS-EVID-SYNC-336, task task_a7491cf0e42b, dispatch ctx_a7491cf0e42b, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–57 giữ nguyên phía trên như lịch sử.
> 1. **Cả 4 tên trong packet đều tồn tại** (0 hit). Giữ kỷ lục của cycle 56 và 57.
> 2. **Một receipt trong packet ĐÃ ĐƯỢC GHI Ở CYCLE 57 và nội dung KHÔNG đổi** — tôi **không** viết bản sao thứ hai. Chi tiết ở Δ-A59-1.
> 3. **"Các receipts Qwen vừa hoàn tất"** trong packet không được nêu tên; tôi dò vùng mới nhất của các report lane và xác định nó là receipt độc lập xác nhận **đúng hai** receipt owner trong packet. Chi tiết ở E3.
> 4. **`docs/28` giữ version 1.48.0** — lệnh bump 1.59.0 → 1.60.0 là version của **docs/35**.

### 58.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **Định vị 4 receipt** | Cả 4 tồn tại, tên khớp packet: `W-WORKER-SDK-ARTIFACT-READ-METADATA-NEGATIVE` (tester 9965), `W-DOC-CORE-INGEST-SOURCE-PIN-NEGATIVE` (9642), `T-CODEX-OFFLINE-STREAM-BOUNDS-AND-BOUNDED-INPUT-INDEPENDENT` (packet ghi 9891, header thật nay ở **9893**), và receipt độc lập mới (9934) |
| E2 | **Artifact read metadata negatives** (tester 9965, 04:36:46) | Chỉ thêm coverage vào `artifact-read-metadata.test.ts`; **không** sửa production. Từ chối: access grant thiếu `artifactId` hoặc `expiresAt` bắt buộc; SHA-256 sai độ dài hoặc ký tự không phải hex; storage-version metadata **tại biên 1024 ký tự và vượt 1 ký tự**; JSON dị dạng; payload không phải object; kiểu field metadata sai. Từ chối xảy ra **trước khi artifact byte được yêu cầu**. 3 lần × 1 suite/18 test exit 0; receipt ghi **54 lần chạy**; tsc 0; **PASS**, gate **NO-GO** |
| E3 | **Ingest source pin negatives** (tester 9642, 04:35) | Chỉ thêm case vào `ingest-source-pin.test.ts`; production không đổi. Từ chối: token rỗng, storage key rỗng, pin object rỗng; pin có lease đọc artifact **hết hạn**; digest SHA-256 **đúng hình dạng nhưng bị sửa**; và pin trỏ sang operation khác — fail closed khi read grant theo operation bị từ chối. 3 lần × 1 suite/23 test exit 0; tsc 0; **PASS**, gate **NO-GO** |
| E4 | **Receipt Qwen mới, xác định theo nội dung** (tester 9934, 04:46:30) | `T-CODEX-OFFLINE-READ-METADATA-AND-SOURCE-PIN-INDEPENDENT`, read-only, không sửa source/test. Xác nhận **cả hai** suite ở E2/E3: read-metadata 3 × **18** = **3/3 suite, 54/54**; ingest-source-pin 3 × **23** = **3/3 suite, 69/69**. Receipt độc lập bổ sung những mặt phủ mà receipt owner **không** nêu: metadata round-trip và integrity, fencing hạn và version, truyền abort, hủy theo content-length, từ chối encryption-marker; và xử lý pin canonical/legacy/rỗng, validation malformed nghiêm, ràng buộc digest và độ dài, fencing grant hết hạn/tenant khác/scope, từ chối pin bị sửa, chọn artifact theo task dùng chung, và lỗi unresolved-source hiển thị rõ. Cả hai typecheck exit 0; mọi gate **NO-GO** |
| E5 | **Receipt packet trỏ nhưng ĐÃ GHI và KHÔNG ĐỔI** (tester 9893) | `T-CODEX-OFFLINE-STREAM-BOUNDS-AND-BOUNDED-INPUT-INDEPENDENT`: cùng mốc **04:33:24**, cùng artifact-stream-bounds 3 × 31 = 93/93, cùng bounded-input 3 × 36 = 108/108, cùng typecheck 0, cùng kết luận gate. Đây **chính là** receipt tôi đã ghi ở Mục 57 |
| E6 | Tôi đếm | `artifact-read-metadata.test.ts` khai báo **14 + 3 khối it.each = 18 chạy**; `ingest-source-pin.test.ts` khai báo **15 + 1 = 23 chạy**. Cả hai khai báo **ít hơn** số chạy. **54 và 69 là tổng ba lần** |
| E7 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=201 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E8 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — các mục mới ghi tên receipt trong backtick, **không** nhúng link mới |

### 58.2 Δ

- **Δ-A59-1 (một receipt trong packet đã được ghi và không đổi):** packet liệt kê `T-CODEX-OFFLINE-STREAM-BOUNDS-AND-BOUNDED-INPUT-INDEPENDENT` ở dòng 9891 như một việc của Turn 336. Đọc lại cho thấy nội dung **không đổi** so với Mục 57: cùng mốc 04:33:24, cùng kết quả, cùng typecheck. Tôi **không** viết bản sao; thay vào đó ghi một mục ngắn nói rõ nó **đã có** và header đã trôi 9891 → **9893**. Packet cũng trỏ **sai dòng** (9891 giờ là phần cuối receipt trước đó).
- **Δ-A59-2 (mục "các receipts Qwen vừa hoàn tất" không được nêu tên — tôi tra, không đoán):** dò vùng cuối các report lane cho thấy đúng **một** receipt mới: `T-CODEX-OFFLINE-READ-METADATA-AND-SOURCE-PIN-INDEPENDENT` (tester 9934). Nó xác nhận **đúng hai** receipt owner mà packet nêu, nên tôi ghi nó vào chung mục và **nói rõ** nó là receipt độc lập của packet này chứ không phải một mục riêng. `qwen-platform.md` và `qwen-admin.md` **không** có Mục `##` nào mới.
- **Δ-A59-3 (bẫy đếm số):** cả hai suite lần này đều khai báo **ít hơn** số chạy — 14→18 và 15→23 — do khối `it.each`. `54`/`69` là **tổng ba lần**.
- **Δ-A59-4:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả ba receipt mới đều tests-only, offline; **không** receipt nào promote gate. Δ69/Δ66/Δ74/Δ75/Δ76/Δ77/Δ78/Δ71/Δ79 cũ vẫn mở.

### 58.3 Lỗi của chính tôi

1. **Không có lỗi needle lần này** — `CONTENT_FAILS=0` ngay ở vòng kiểm đầu tiên, nhờ tôi lấy chuỗi từ chính file thay vì viết tay. Đây là kết quả của việc ghi bài học ở Mục 53–57; tôi ghi lại vì nó là thay đổi thói quen thật, không phải may mắn.
2. **Packet trỏ sai dòng** (`9891` thay vì `9893`) và **lặp lại một receipt đã ghi**. Tôi phát hiện ra bằng cách so nội dung chứ không so dòng — vì dòng vẫn còn trong khoảng nên `BROKEN=0` không bắt được. Đây là lý do tôi content-assert mọi neo.

## 59 — CYCLE 59: D-DOCS-EVID-SYNC-337 — submit-guards là [PASS] thật có mutation thật; số 14 của packet nằm ở receipt phụ, không ở receipt gốc

> **RESUME POINT — cycle 59 (packet D-DOCS-EVID-SYNC-337, task task_b46c820f1e8a, dispatch ctx_b46c820f1e8a, lane Qwen-Docs).**
> Muc này nằm cuối file; Muc 1–58 giữ nguyên phía trên như lịch sử.
> 1. **Cả 5 tên trong packet đều tồn tại** (0 hit). Giữ kỷ lục ba cycle liên tiếp (56, 57, 58).
> 2. **Số "14 tests" của packet KHÔNG nằm ở receipt gốc** — nó nằm ở một mục **phụ** dưới cùng header. Chi tiết ở Δ-A60-1.
> 3. **Một receipt trong packet đã được ghi ở cycle 58 và không đổi** — không viết bản sao.
> 4. **`docs/28` giữ version 1.48.0** — lệnh bump 1.60.0 → 1.61.0 là version của **docs/35**.

### 59.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **Định vị 5 receipt** | Cả 5 tồn tại, tên khớp: `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` (tester 9592 + mục phụ 9603), `W-DOC-CORE-CANCELLATION-FENCING-NEGATIVE` (10014), `W-PLAT-CR28-02-ARTIFACT-SUBMIT-GUARDS-NEGATIVE` (qwen-platform Muc 42, L3779), `W-ADM-UX-05-MOUNT-PORT-ISOLATION-HARDENING` (qwen-admin Muc 46, L4621), `T-CODEX-OFFLINE-READ-METADATA-AND-SOURCE-PIN-INDEPENDENT` (packet ghi 9934, header thật nay ở **9942**) |
| E2 | **Cancellation fencing** (tester 10014, 04:48) | Chỉ thêm test, production không đổi. Abort do **mất lease** khi hoàn tất checkpoint **chặn** trả step output; abort lặp lại vẫn **idempotent** và fail closed; lý do cancel dị dạng bị coi là **mất lease**; abort giữa lúc truyền artifact theo stream **chặn** ghi artifact. 3 lần × 1 suite/14 test exit 0; tsc 0; **PASS**, gate **NO-GO** |
| E3 | **Artifact submit guards — [PASS] THẬT, khác hẳn Mục 41** (Muc 42) | Sự khác biệt được chứng minh bằng **cấu trúc**: suite là **unit thuần** (không `DU_LIVE_INFRA`, không `createApp`, không listener, **không** nằm trong `liveSuites`) nên chạy offline **thật**, có test **thực thi**, và mutation **có thể chứng minh**. Số dưới đây là số test **thực thi** |
| E4 | Submit guards — deliverable | **19 test mới** trong `artifact-submit-guards.test.ts` (5 → **24**); chỉ file test, `submission.ts` sha `e25670af` và `server.ts` sha `22afb2ff` **nguyên trạng**; test file sha `7cdd4107` / 12703 B. Nhóm: **12 biến thể shape lỗi** → **422 `INVALID_SCHEMA`** với `queries` **rỗng** (validate **trước mọi I/O**); 422 có **pointer lỗi** đọc từ `HttpError.extra.errors`; URL ingestion khi backend **không phải s3** → 422 `UNSUPPORTED_STORAGE_BACKEND` + 0 query; URL scheme lạ / host private (file, ftp, 127.0.0.1, 169.254.169.254) → lỗi, 0 query; biên budget: bytes **đúng bằng** trần nhận, **vượt 1 byte** thì 413 — bắt lỗi off-by-one |
| E5 | Submit guards — verify + mutation | 3 lần: mỗi lần **24 passed, 24 total**, **1 passed suite**, Exit **0**; dòng PASS đầy đủ. Không phải `[SKIP-QUALIFIED]`, không `describe.skip`. `tsc` exit 0 log **0 byte** cả trước lẫn sau M1. **M1 thật**: đột biến **compile được** (receipt ghi rõ biến thể `if (false && ...)` thành dead code và TS từ chối với `Tests: 0 total` nên **KHÔNG** phải bằng chứng) → **1 failed, 23 passed, 24 total**, test đỏ đúng ca URL-ingestion-fail-closed; khôi phục byte-exact, chạy lại **24/24 Exit 0** |
| E6 | Submit guards — **HAI FINDING, KHÔNG bịa test xanh** | **Δ81 — file 0 byte KHÔNG bị từ chối**: `assertEmbeddedInputByteBudget` dùng `if (totalBytes > maxBytes) throw 413` nên 0 byte đi qua; packet nói zero-byte rejection nhưng production **không có**; sửa đúng là `>=` cộng chặn `totalBytes === 0` — production, ngoài write scope. **Δ82 — `submit` KHÔNG có `assertTenantId`**: đọc toàn file không hàm nào kiểm `tenantId`; hàng rào duy nhất là query đã tenant-scoped và test chứng minh tenant lạ ra **404 NOT_FOUND** — tenant isolation **có thật**, nhưng là hàng rào *kết quả*, không phải *validate input*. Vì vậy test "thiếu tenant" đổi thành **foreign-tenant** để không đòi hành vi chưa tồn tại |
| E7 | Submit guards — tự sửa, sản phẩm đúng | (1) `err.detail` **không tồn tại**; đọc `src/http/errors.ts:13` thấy tham số 3/4 đẩy vào `.extra`; đã sửa assertion. (2) Script ghi file **cắt trước** test file (6975 B, đuôi `undefined`) vì `while` thiếu ngoặc; bắt qua bằng **byte-size drop**, khôi phục byte-exact từ backup, viết lại vào file tạm khác rồi append — lần thứ hai trong các cycle gần đây. Cũng nhớ `& echo launched` làm **exit 0 của launcher** che mất exit code thật của jest, nên cả 3 lần chạy và cả M1 đều parse dòng `Tests:` trong log, không tin exit code của wrapper |
| E8 | **Mount port isolation** (Muc 46) | **Đóng nốt đúng món nợ lane tự ghi ở Mục 45.** Trước khi sửa, đọc trực tiếp từ file: `adminShellPort: 45000 + (pid % 200) * 2 + 1` — hằng PID-derived **không retry**; `afterAll` gọi thẳng `shell.handle.close()` — **không guard**. Sửa: dải **42000–42504 offset +4** (số lẻ nên không trùng dải chẵn của query suite), retry **16 lần × +8 cổng** chỉ nuốt `EADDRINUSE` và **ném lại mọi lỗi khác**, `afterAll` **guard null**. **Chỉ** sửa test, không đụng production |
| E9 | Mount port — **dải không trùng là vệ sinh, KHÔNG phải bảo đảm** | Chính receipt nói vậy: bảo đảm là **retry**. Với offset +4, mount lấy số lẻ còn query lấy số chẵn trong cùng dải |
| E10 | Mount port — **bằng chứng chạy SONG SONG** | Đây đúng là điều kiện từng gây flake ở Mục 42/43: mount ×3 tuần tự **6/6**; **3 instance mount song song 3/3 xanh**; **2 mount + 2 query song song cùng lúc** ở vòng 1 **4/4** và vòng 2 **4/4** ⇒ tổng **8/8 xanh, 0 va chạm port**; batch 8 suite audit+shell **410/410**, 8/8 suite; tsc 0 |
| E11 | Mount port — **nợ còn lại, nêu ra không ngụy trang xong** | `admin-shell-platform-mount.test.ts` dùng dải ~44xxx offset theo pid, nằm ngoài file limit nên **chưa** đụng; nó chưa từng gây đỏ trong các lần lane chạy nhưng cũng **chưa** có chốt chặn retry. Đồng nhất cần **packet riêng**; lane **không** tự mở rộng phạm vi |
| E12 | **Artifact stat — con số 14 nằm ở receipt PHỤ** | Header `# W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` (tester 9592) là receipt **Turn 329** (01:07:52) ghi **7 test** — **đã** đồng bộ ở Mục 53. Số **14** đến từ mục bổ sung **Turn 337 supplemental** (tester 9603, task_3d79b18f0c2a, 04:50:19) dưới cùng header dạng `###`. **Grep theo header sẽ ra 7, không phải 14** |
| E13 | Artifact stat — nội dung phần bổ sung | Chỉ thêm test, **không** sửa production. Từ chối `sizeBytes` **âm** (content-length của grant) trong khi **chấp nhận** 0; từ chối SHA-256 **ngắn**, **chữ hoa**, **không phải hex**; từ chối stat sau khi **mất lease**; và truyền denyal của Runtime API cho lệch tenant / lệch operation **mà không lộ descriptor**. 3 lần × 1 suite/14 test exit 0; receipt ghi **42 lần chạy**; tsc 0; **PASS** |
| E14 | Tôi đếm | `artifact-stat` khai báo **10 + 3 khối `it.each` = 14 chạy**; `cancellation-fencing` **14**, 0 it.each; `artifact-submit-guards` **13 + 1 = 24 chạy**; `admin-audit-mount` **6**, 0 it.each. **42 là tổng ba lần** |
| E15 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=202 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10 |
| E16 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — các mục mới ghi tên receipt trong backtick, **không** nhúng link mới |
| E17 | **Splice lossless + census sau** | chen ledger-59 tai L420 va append Muc 59; round-trip `"\n".join(split("\n"))` byte-identical truoc/sau; `qwen-docs.md` 640533 -> 652492 bytes, 3907 -> 3951 dong, LF thuan, endsNL=True; sha16 moi `ff29197f5d8f2c2e` |
| E18 | **Repoint inbound anchor — ba noi dung, hai nguyen nhan khac nhau** | (a) **Do cycle nay**: chen ledger-59 lam moi noi dung >= L420 dich +1, nen muc 16 heading 1680 -> **1681**; `docs/28:678` + `docs/35:839` da tu `#L1680` -> `#L1681`, content-assert L1681 = `## 16 — CYCLE 16`. (b) **Co san truoc cycle nay, khong phai do toi**: `docs/06:75` tro `Delta-A42-1` bang `#L3176`, nhung dong 3176 la dong **bang** cua Muc 41 (bang tuong), con `Delta-A42-1` that o L3194 (Muc 42) — muc 41 E18 da ghi `#L3176` tro dung luc viet, nhung cac muc 42+ chen vao lam no lech. Toi dua `#L3176` -> `#L3194`, content-assert L3194 = `- **Delta-A42-1` |

### 59.2 Δ

- **Δ-A60-1 (packet gắn số 14 vào sai receipt — đáng chú ý về cách đọc hồ sơ):** header `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` là receipt **Turn 329** ghi **7 test** và **đã** được đồng bộ ở Mục 53. Con số **14** thuộc một mục bổ sung **Turn 337 supplemental** nằm **dưới cùng header** ở dạng `###`. Người đọc bằng cách grep header sẽ ra **7** và tưởng packet sai; thực ra packet đúng, chỉ là hồ sơ có **hai tầng** cho cùng một việc. Tôi ghi rõ cả hai tầng thay vì chọn một.
- **Δ-A60-2 (một [PASS] thật đứng cạnh một [SKIP-QUALIFIED] — sự khác biệt là cấu trúc, không phải lời):** submit-guards chạy offline thật vì nó **không** thuộc hạng live-DB, **không** nằm trong `liveSuites`, nên test thực thi và mutation chứng minh được — trái ngược hẳn Mục 41 ngay trên (0 test chạy, không mutation evidence). Tôi ghi cả hai cạnh nhau để người đọc không quy mọi receipt "xanh" là cùng một loại.
- **Δ-A60-3 (Δ81 + Δ82 MỚI, chưa ai đóng):** file **0 byte không bị từ chối** khi submit, và `submit` **không** có `assertTenantId` — tenant isolation chỉ được bảo đảm bởi query fence (tenant lạ → 404), tức là hàng rào *kết quả* chứ không phải *validate input*. Cả hai cần production code để đóng nên receipt **không** tự đóng, và tôi cũng không.
- **Δ-A60-4 (bẫy đếm số):** 3/4 file khai báo ít hơn số chạy (10→14, 13→24); `cancellation-fencing` là file duy nhất khai báo bằng chạy. **42 là tổng ba lần.**
- **Δ-A60-5 (một receipt trong packet đã ghi và không đổi):** `T-CODEX-OFFLINE-READ-METADATA-AND-SOURCE-PIN-INDEPENDENT` — cùng mốc 04:46:30, cùng 54/54 và 69/69, cùng typecheck 0. Không viết bản sao; header đã trôi 9934 → **9942**.
- **Δ-A60-7 (defect co san truoc, phat hien khi repoint, TOI KHONG GHI COnG):** inbound anchor `docs/06:75` tro `Delta-A42-1` bang `#L3176` tro vao dong bang cua Muc 41, khong phai dong `Delta-A42-1` (L3194). Day la **semantic mis-target** ton tai tu truoc cycle nay (Muc 41 ghi `#L3176` khi dung, muc 42+ lam lech) — `BROKEN=0` khong bat vi dong nam trong khoang. Toi sua **noi dung** de khop link text, va **noi ro day la sua chua ba ca nhan**, khong phai regression cycle nay.
- **Δ-A60-6:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G6` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 4 receipt mới đều tests-only, offline; **không** receipt nào promote gate. Δ69/Δ66/Δ74/Δ75/Δ76/Δ77/Δ78/Δ71/Δ79 cũ vẫn mở, cộng **Δ81**/**Δ82** mới.

### 59.3 Lỗi của chính tôi

1. **Một assert fail vì needle của tôi bỏ dấu backtick** quanh `[PASS]`. Nội dung trong file **đầy đủ** (kiểm bằng byte thật: cả `[PASS] THẬT` và `THẬT — khác hẳn Mục 41` đều có). Đây là lần thứ tám — nhưng lần này tôi **in dòng thật ở vòng ngay sau** nên chỉ tốn một vòng, và `CONTENT_FAILS=0` cho toàn bộ các mục khác từ vòng đầu. Bài học ở Mục 53–58 vẫn đúng: **assert phải lấy chuỗi từ chính file**.

## 60 — CYCLE 60: D-DOCS-EVID-SYNC-338 — 90 test thật với M1 chứng minh được; 7 finding Δ83–Δ89 mới; đóng nợ loopback cuối của admin

> **RESUME POINT — cycle 60 (packet D-DOCS-EVID-SYNC-338, task task_c81f034d92a1, dispatch ctx_c81f034d92a1, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–59 giữ nguyên phía trên như lịch sử.
> 1. **Cả 5 tên trong packet đều tồn tại** (0 hit). Kỷ lục 4 cycle liên tiếp (56, 57, 58, 59).
> 2. **`docs/28` giữ version 1.48.0** — lệnh bump **1.61.0 → 1.62.0** là version của **docs/35**.
> 3. **Có MỘT tên rất dễ nhầm:** `W-ADM-UX-05-**PLATFORM**-MOUNT-…` (Mục 47) **KHÁC** `W-ADM-UX-05-MOUNT-…` (Mục 46) mà tôi đã ghi ở Mục 59. Cả hai đều đúng và cả hai đều được ghi. Chi tiết ở Δ-A61-1.
> 4. **tester.md trôi ngay trong lúc tôi làm việc** (10092 → 10123 dòng) — bắt được bằng đọc lại theo nội dung, chi tiết ở E0. Đây là lần thứ hai trong các cycle gần đây.

### 60.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Drift bắt được ngay** | `tester.md` dài **10092 → 10123 dòng** giữa census và lúc đọc. `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` trôi **10084 → 10115**. Tôi **không** dùng con số packet hay con số census cũ; định vị lại bằng header trong **một lần đọc nguyên tử**. Nếu tôi tin dòng packet thì mục này ghi sai nguồn |
| E1 | **Định vị 5 receipt** | Cả 5 tồn tại: `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` (tester **10115**, task_4e81561a73bc), `W-DOC-CORE-CHECKPOINT-NEGATIVE` (tester **10044**, task_c72b1894d03e), `W-PLAT-CR28-03-ARTIFACT-READ-AUTH-NEGATIVE` (qwen-platform Muc 43 L3872, task_9a2f76814c9e), `W-ADM-UX-05-PLATFORM-MOUNT-PORT-ISOLATION-HARDENING` (qwen-admin Muc 47 L4673, task_7e1b54a29c3f), `T-CODEX-OFFLINE-STAT-AND-CANCELLATION-FENCING-INDEPENDENT` (tester **10003**, 05:13:45). Packet ghi `tester 10033` cho receipt cuối — **lệch 30 dòng**: 10033 là dòng *"Honest result"* bên trong receipt, **không phải** header |
| E2 | **Temp-sweep negatives** | Chỉ thêm test, production không đổi. `intervalMs` 0/-1 start-stop an toàn; `olderThanMs` 0/-1 vẫn sweep; file thường **khớp prefix được giữ lại**; **EACCES lúc stat + EBUSY lúc cleanup giữ entry** thay vì để cả sweep đỏ; thư mục lồng dưới parent không liên quan không bị đụng. 3 lần × 1 suite/14 test Exit 0, **42 lần chạy**; tsc 0; **PASS** |
| E3 | **Checkpoint negatives** | Chỉ thêm test, production không đổi. Checkpoint seal hỏng **fail auth trước** khi replay callback; step key rỗng + `sequenceIndex` âm **không alias** checkpoint hợp lệ; context task/operation tách biệt không replay lẫn nhau; output **500 ký tự giữ nguyên**. 3 lần × 1 suite/**8 test** Exit 0; tsc 0. Receipt **tự nói rõ** ranh giới: `StepCheckpointManager` vẫn nhận step key + payload mờ, suite này chỉ chứng minh giá trị biên **không alias**, **không** thêm validation production |
| E4 | **Artifact read auth — [PASS] THẬT, lý do là CẤU TRÚC** | Unit thuần: không `DU_LIVE_INFRA`, không `createApp`, không thuộc `liveSuites` của `jest.unit.config.cjs` ⇒ 3 lần đều có dòng `PASS` thật và **M1 chứng minh được** |
| E5 | **Packet sai tên module, file đúng** | `src/modules/artifacts/artifact-read-authorization.ts` **không tồn tại** (0 hit). Logic thật ở `artifacts.ts`: `createArtifactService().requestAccess` (321-420) + `isPublicArtifactPurpose` / `hasDeclaredArtifactReference` (581-593). Chỉ file test trong write scope được sửa |
| E6 | Deliverable | **+78 test (12 → 90)**. 10 biến thể `artifactId` rác ⇒ **404 `NOT_FOUND`** + **0 grant**; 16 shape `submit_artifacts` sai + biên khoảng trắng/hoa-thường/purpose; 6 state không RUNNING; **19 body sai ⇒ 422 `INVALID_SCHEMA` + `queryCount === 0`** (chặn trước mọi I/O) |
| E7 | **Thứ tự kiểm được assert** | cross-operation + declared + `STAGING` ⇒ **409 `STATE_CONFLICT`** (không phải PERMISSION_DENIED). Với lease: epoch sai **và** hết hạn ⇒ `LEASE_LOST` thắng; hết hạn **và** sai state ⇒ 403 thắng; lease sống đúng epoch ⇒ vẫn cấp |
| E8 | Verify + **M1 thật** | 3 lần: mỗi lần **90 passed, 90 total**, 1 suite. `tsc` Exit 0, **log 0 byte** cả trước lẫn sau M1. M1 gỡ conjunct `sameTenant &&` (artifacts.ts:389-392) — **biên dịch được** vì bỏ hẳn một conjunct; receipt **từ chối** dùng `if (false && …)` vì biến thể đó thành dead code và TS báo `Tests: 0` (không phải bằng chứng). Kết quả **3 failed, 87 passed, 90 total**, trong đó có **1 test mới**; khôi phục byte-exact `827aaba4` / 28882 B rồi chạy lại 90/90 |
| E9 | **Platform-mount — KHÁC receipt Mục 46** | Muc 47 sửa `admin-shell-platform-mount.test.ts`, Muc 46 sửa `admin-audit-mount.test.ts`. File này **khó hơn**: **13 call site** `createAdminShellServer` nhưng cả 13 đi qua **một wrapper** ⇒ sửa 1 chỗ thay vì 13. Binding xảy ra trong `handle.listen()` **sau** khi factory trả về ⇒ retry phải bọc quanh `listen()`, nhờ vậy **không call site nào phải sửa** |
| E10 | **Verify được bằng SOURCE, không chỉ bằng receipt** | Đọc file thật: band mới **43000-43504** rời hẳn 42000-42504 của 2 suite audit; retry có điều kiện `err.code !== "EADDRINUSE" || attempt >= PORT_BAND_SLOTS` ⇒ **ném nguyên vẹn mọi lỗi khác**; `afterAll` dòng 201 nay là `if (shell) await shell.handle.close()`. Comment trong file tự nói: tách dải là **vệ sinh, KHÔNG phải bảo đảm** — bảo đảm là retry có giới hạn |
| E11 | **File vẫn CRLF sau khi sửa** | 1472 CRLF, 59287 B, sha `359e236f` — sửa phải khớp EOL vì file này khác 2 file audit (LF). Chỉ sửa test, **không** đụng production |
| E12 | Bằng chứng **song song** | Đúng điều kiện từng gây flake ở Mục 42/43/45/46: platform-mount ×3 tuần tự **37/37**; **2 platform-mount + 1 audit-mount + 1 audit-query CÙNG LÚC ⇒ 4/4 xanh, 0 va chạm port**; batch 9 suite **447/447**, 9/9; tsc 0. Nợ `EADDRINUSE` trong admin **coi như đóng cho cả 3 file** |
| E13 | Tôi đếm lại từ source | `temp-sweep`: **12 `it()` + 2 khối `it.each`**; `checkpoint`: **8 `it()`, 0 `it.each`** ⇒ khai báo **bằng** chạy; `admin-shell-platform-mount`: **37 `it()` + 3 `test()`, 0 `it.each`**; `artifact-read-authorization`: **34 `it()` + 7 khối `it.each`**. Không file nào có `skip`/`todo`/`only` |
| E14 | **Một chỗ receipt tôi đếm lệch** | Receipt nói **13 call site**; đếm `createAdminShellServer(` trong file ra **15** (13 call site + 1 import alias + 1 định nghĩa wrapper). Con số **13 call site thì đúng**, tôi ghi rõ để không ai đọc thành "15 chỗ cần sửa" |
| E15 | Receipt độc lập | Read-only, **không** sửa source/test, 05:13:45. artifact-stat 3 × **14** và cancellation-fencing 3 × **14**, mỗi cái **42 lần chạy**; tsc 0 cho cả 2 package. Receipt tự ghi: chỉ ghi bằng chứng, **không** đổi gate |
| E16 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=203 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E17 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — mục mới ghi tên receipt trong backtick, **không** nhúng link mới | **Ghi chu:** so TREE doi 202 -> 203 giua cac lan chay vi mot lane khac them file; BROKEN van la **cung 2** link pre-existing nen ket luan khong doi
| E18 | Anchor | Chèn ledger-60 làm mọi dòng ≥ L421 dịch +1. `docs/28:678` + `docs/35:839` đi `#L1681` → **`#L1682`**, content-assert L1682 = `## 16 — CYCLE 16`; `docs/06:75` đi `#L3194` → **`#L3195`**, content-assert L3195 = `- **Δ-A42-1`. **Không** sửa `review.md` hay `coordinator-antigravity.md` — không phải file của lane |
### 60.2 Δ

- **Δ-A61-1 (hai tên gần như giống hệt nhau — đã kiểm để không ghi nhầm):** packet liệt kê `W-ADM-UX-05-PLATFORM-MOUNT-PORT-ISOLATION-HARDENING` (Mục 47). Ở Mục 59 tôi đã ghi `W-ADM-UX-05-MOUNT-PORT-ISOLATION-HARDENING` (Mục 46). Khác nhau ở chữ **PLATFORM** và ở **file**: Mục 46 sửa `admin-audit-mount.test.ts`, Mục 47 sửa `admin-shell-platform-mount.test.ts`. Chúng **bổ sung** cho nhau, không thay thế: chuỗi cả ba là audit-query (Mục 45) → audit-mount (Mục 46) → shell-platform-mount (Mục 47). Tôi ghi cả hai mục, **không** gộp làm một.
- **Δ-A61-2 (7 finding mới từ Muc 43, không cái nào được đóng — nghiêm trọng nhất là Δ83):**
  - **Δ83** — `artifactId` **không được validate là uuid ở bất kỳ đâu**. Route chỉ bắt `([^/]+)` (server.ts:1390) rồi đưa thẳng vào query, trong khi `artifacts.id` là `uuid PRIMARY KEY` ⇒ id sai cú pháp tới PostgreSQL như bound parameter và gây `22P02 invalid_input_syntax`. Lỗi driver **không phải `HttpError`** nên `safeInternalErrorProblem` trả **500 TEMPORARY_UNAVAILABLE** thay vì 404. **Test double đang che đúng lỗi này** vì nó là `Map.get`. Tác giả **không** chứng minh được live (mở cửa sổ DB là vi phạm quy tắc lane) và **không** tuyên bố là đã chứng minh; bằng chứng offline chỉ là test `FINDING` bắt được id rác đi vào SQL nguyên văn. Sửa: validate path segment là uuid ở route (và ở service) **trước mọi query**.
  - **Δ84** — dò tồn tại cross-tenant rò **3 mã khác nhau cho cùng một câu hỏi**: `STATE_CONFLICT` (tồn tại + DELETED) / `PERMISSION_DENIED` (tồn tại) / `NOT_FOUND` (không tồn tại), vì check `DELETED` chạy trước mọi kiểm tenant. Cùng lớp rò rỉ mà Mục 41 đã cố tránh bằng 403-vs-404.
  - **Δ85** — `hasDeclaredArtifactReference` dùng `'artifactId' in entry` nên đi cả **prototype chain**; property không phải own vẫn cấp quyền. Hôm nay chưa khai thác được vì `submit_artifacts` là JSONB, nhưng guard đang **âm thầm phụ thuộc** vào điều đó. Sửa: `Object.prototype.hasOwnProperty.call`.
  - **Δ86** — bất đối xứng hoa/thường: PostgreSQL chuẩn hoá uuid trong `WHERE id=$1` nên id HOA CHỮ vẫn tìm thấy row và **được cấp grant cùng operation**, nhưng phép so sánh declared reference là `===` cứng với giá trị trong DB (chữ thường) nên **cùng id đó bị chặn** ở đường cross-operation. Client gửi chữ thường thì đọc cùng operation chạy, đọc cross-operation vỡ.
  - **Δ87** — `ArtifactAccessRequestSchema` **không** `.strict()` nên field lạ bị **bỏ âm thầm**, kể cả `tenantId`/`role` do caller gửi lên. Hôm nay vô hại, nhưng nó **lệch** với `SubmissionSchema` ở Mục 42 vốn `.strict()` và từ chối field lạ — cùng hệ thống, hai tiêu chuẩn khác nhau.
  - **Δ88** — **không tồn tại "malformed token signature"**: token là `randomUUID()` trần, không MAC. Nghiêm trọng hơn: `getBlob(storageKey)` ở tầng service **không mang credential nào** (arity 1) nên chỉ route HTTP là nơi duy nhất chặn token; `putBlob` còn mang `tenantId`. Caller service-level tương lai sẽ **bỏ qua grant fence trong im lặng**.
  - **Δ89** — `lease_active` là phép chiếu `(lease_expires_at IS NOT NULL AND lease_expires_at > now())` nên **"chưa bao giờ có hạn" bị gộp** với "đã hết hạn": cùng một boolean, cùng một 403. Service không phân biệt được lỗi lập lịch với phép quyền hết hạn bình thường.
- **Δ-A61-3 (packet trỏ lệch 30 dòng, báo chứ không sửa im lặng):** packet ghi receipt cuối ở `tester 10033`. Dòng 10033 là dòng *"Honest result: PASS…"* **bên trong** receipt; **header thật ở 10003**. Số packet vẫn nằm trong khoảng nên `BROKEN=0` không bắt được — cùng lớp lỗi mà Mục 52 và Mục 58 đã gặp.
- **Δ-A61-4 (bẫy đếm số, lần thứ hai trong cycle này):** `temp-sweep` khai báo **12 + 2 khối `it.each`**; `checkpoint` là file **duy nhất** khai báo bằng chạy (8 = 8); `artifact-read-authorization` khai báo 34 + 7 khối. Hai con số **42** ở receipt độc lập là **tổng ba lần chạy**, không phải mỗi lần.
- **Δ-A61-5 (drift, bắt được nhờ đọc lại thay vì tin census):** `tester.md` dài **10092 → 10123 dòng** giữa census và lúc đọc, và header của temp-sweep trôi **10084 → 10115**. Tôi chỉ biết điều này vì **luôn** đọc lại theo nội dung ở vòng sau. Đây là lần thứ hai trong các cycle gần đây (lần trước ở Mục 54 với `ingest-source-pin`), và nó củng cố một điều đã ghi nhiều lần: **số dòng trong packet là con số của thời điểm người viết gửi, không phải của lúc tôi đọc**.
- **Δ-A61-6:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G6` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 5 receipt đều tests-only, offline — **không** receipt nào promote gate. Δ69/Δ66/Δ74/Δ75/Δ76/Δ77/Δ78/Δ71/Δ79/Δ81/Δ82 còn mở, cộng **Δ83–Δ89** mới. Test xanh **KHÔNG** phải tín hiệu GO — đặc biệt ở receipt này có **90 test xanh** nhưng đi kèm 7 finding chưa đóng.
### 60.3 Lỗi của chính tôi

1. **Hai assert fail trên **cùng một nguyên nhân**: tôi **đoán** chuỗi thay vì **lấy từ file**. Lần đầu tôi viết `assert t28.endswith("- It is already on record and is not rewritten.")` trong khi dòng thật kết thúc bằng `"The header now sits at line 9942."`; lần sau tôi viết needle `"**37 `it()` + 3 `test()`**"` trong khi dòng thật là `"**37 `it()` + 3 `test()`, 0 `it.each`**"`. Ở **cả hai** lần nội dung trong file **đã đúng** — chỉ needle của tôi sai. Đây là lần thứ **chín** của lới lỗi này, và lần thứ hai chỉ trong một cycle. Bài học đã ghi ở Mục 53–59 vẫn đúng nhưng tôi **không thực hành** ở lần đầu: phải **in dòng thật** trước khi viết assert, không viết assert rồi mới in.
2. **Hai lần SyntaxError vì tôi copy dòng `for` mà bỏ dấu hai chấm** — lần sau tôi **copy nguyên dòng lỗi** từ lần trước nên lặp lại đúng lỗi đó. Lỗi vụng về ở script dựng hơn là lỗi nội dung, nhưng nó tốn hai vòng và tôi ghi ra vì nó cho thấy một thói quen: **khi sửa lỗi cú pháp, phải sửa nguyên dòng chứ không chép lại dòng vừa lỗi**.
3. **Một assert của tôi báo sai và tôi phải sửa chính mình:** tôi đòi `Turn 338` phải nằm ở `docs/35` dòng **1274**, nhưng thực tế là **1275** — vì fragment của tôi bắt đầu bằng **một dòng trống** làm dấu phân cách. Tôi **không** sửa file cho khớp con số của mình; tôi in dòng 1272-1274, xác nhận dòng 1273 là dòng trống và dòng 1272 đúng là câu cuối của mục trước, rồi **sửa assert của tôi**. Đây là hướng ngược lại với việc sửa dữ liệu để hợp lý, và đó là hướng đúng.
4. **Điều tôi làm ĐÚNG và muốn giữ:** (a) đọc lại `tester.md` bằng nội dung khi census đã lệch, nhờ vậy bắt được việc file dài thêm 31 dòng giữa chừng; (b) **không** sửa `review.md` / `coordinator-antigravity.md` dù anchor của chúng cũng sẽ trôi, vì không phải file của lane — tôi ghi việc đó trong E18 thay vì âm thầm mở rộng phạm vi; (c) verify Muc 47 bằng **đọc source** (điều kiện `EADDRINUSE`, `afterAll` dòng 201, file vẫn CRLF) chứ không chép lời receipt, nhờ vậy bắt được chỗ receipt tự nói dải port chỉ là vệ sinh chứ không phải bảo đảm; (d) khi đếm thấy receipt nói 13 call site còn file có 15 lần xuất hiện, tôi **giải thích** chênh lệch thay vì ghi con số nào cũng được.
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai file đều qua splice round-trip byte-identical, `docs/28` giữ nguyên version 1.48.0 và `endsNL=False`, CRLF/bare-LF không đổi, `docs/35` bump **1.61.0 → 1.62.0** đúng một chỗ.

## 61 — CYCLE 61: D-DOCS-EVID-SYNC-339 — 105 test với HAI mutation; 6 finding Δ90–Δ95 mới; packet nói 5 nhưng chỉ 4 receipt mới, một cái là bản chép nguyên văn

> **RESUME POINT — cycle 61 (packet D-DOCS-EVID-SYNC-339, Turn 342, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–60 giữ nguyên phía trên như lịch sử.
> 1. **Packet KHÔNG nêu tên receipt nào.** Tôi tự dò, và kết quả **không phải 5 receipt mới**: 4 cái mới + **1 cái là bản chép nguyên văn** của receipt đã ghi ở Mục 60. Chi tiết ở Δ-A62-1.
> 2. **`docs/28` giữ version 1.48.0** — lệnh bump **1.62.0 → 1.63.0** là version của **docs/35**.
> 3. **Không có task id.** Packet lần này cho Turn 342 nhưng **không** có taskId/contextId, nên không thể gửi `worker_done`; tôi gửi `status` và nêu rõ trong receipt.
> 4. **Một receipt trong `qwen-admin.md` chỉ tìm được qua settlement của coordinator** — quét theo header H2 bỏ sót vì lane đó dùng định dạng khác. Chi tiết ở E0.

### 61.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Packet không đặt tên — tôi dò, và dò sai một lần** | Quét theo header H1/H2 chỉ ra 4 mục; **lần đầu tôi bỏ sót receipt thứ 5** vì `qwen-admin.md` dùng header `## 48 — CYCLE 48` + dòng `**W-...**` chứ không phải H1. Tôi tìm ra nhờ đọc **settlement Turn 341** của coordinator (L4955) ghi rõ: task_4d91a27e8c3b, `W-ADM-UX-02-IDEMPOTENCY-NEGATIVE`, 45/45 ×3, Muc 48. Nếu tôi tin quét đầu tiên thì Mục này thiếu một receipt mà không hề biết |
| E1 | **Định vị 5 mục** | `T-CODEX-OFFLINE-SERVICE-AUTH-AND-OUTPUT-VALIDATION-INDEPENDENT` (tester **10135**, task_2e8a104c91bf, 05:47:34) · `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` (**10166**) · `W-WORKER-SDK-ARTIFACT-MULTIPART-NEGATIVE` (tester **10175**, task_8a7d10b4c29e, 05:52:44) · `W-PLAT-CR28-04-RUNTIME-ENCRYPTION-METADATA-NEGATIVE` (qwen-platform Muc 44 L4010, task_d3e21a94b80c) · `W-ADM-UX-02-IDEMPOTENCY-NEGATIVE` (qwen-admin Muc 48 L4720, task_4d91a27e8c3b) |
| E2 | **Bản chép nguyên văn — lần thứ hai một receipt có hai header** | Header thứ hai `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` ở **L10166** trùng **task `task_4e81561a73bc`**, trùng mốc **05:18:26**, trùng **14 test / 42 executions**, trùng kết luận. Đối chiếu từng dòng với bản gốc đã ghi ở Mục 60: **giống hệt**. Đây là lần thứ hai trong file này một receipt xuất hiện dưới hai header (lần trước là `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` ở Mục 59) |
| E3 | **Service auth + output validation (độc lập)** | Read-only, **không** sửa source/test. service-auth 3 lần × **19** (**57 executions**); output-validation 3 lần × **32** (**96 executions**); tsc 0 cho cả 2 package. Receipt tự ghi: chỉ ghi bằng chứng, **không** đổi gate |
| E4 | **Artifact multipart negatives** | Chỉ test, production không đổi. Timeout ở part PUT chưa xong trả lỗi có kiểu và **huỷ session**; byte part hỏng bị chặn bởi digest đã ký ⇒ **không** cho hoàn tất và **kích hoạt cleanup**; grant hết hạn và init response thiếu `uploadHandle` đều **fail closed**; part dưới 5 MiB bị từ chối. 3 lần × 1 suite/**27 test** Exit 0 (**81**); tsc 0 |
| E5 | **Runtime encryption metadata — [PASS] THẬT với HAI mutation** | Unit thuần (không `DU_LIVE_INFRA`, không `liveSuites`) ⇒ 3 lần đều có dòng `PASS` thật. **+50 test (55 → 105)**, và **0 dòng production**: `metadata-crypto.ts` vẫn `aa200211` — receipt ghi rõ hash này **khớp đúng** giá trị đã ghi ở Mục 36/37, nên **không** có drift so với các cycle trước |
| E6 | **Verify + hai mutation, cả hai đều đỏ thật** | 3 lần: mỗi lần **105 passed, 105 total**; `tsc` Exit 0 **log 0 byte** cả trước M1 lẫn sau khôi phục. **M1a** gỡ `refId` khỏi AAD dẫn xuất (`tenant|slot|refId` → `tenant|slot`) ⇒ **5 failed, 100 passed**, đúng nhóm ràng buộc ngang đỏ. **M1b** siết lỗ hổng `null` (`=== undefined` → thêm `=== null`) ⇒ **5 failed, 100 passed** và **cả 5 đều là test MỚI** |
| E7 | **Vì sao M1b quan trọng hơn M1a** | M1a đỏ ở nhóm test **có sẵn**. M1b đỏ ở **5 test mới** ⇒ đó mới là bằng chứng nhóm mới **thật sự cắn**, chứ không chỉ kế thừa sức mạnh của 55 test cũ. Tôi ghi rõ vì đây là tiêu chuẩn tôi đã dùng ở Mục 59 và Mục 60 |
| E8 | **Admin idempotency — phương pháp đáng ghi nhất** | Chỉ sửa `tests/admin-idempotency.test.ts`; 27 → **45 test**. Tác giả **PROBE hành vi thật trước khi viết test** thay vì đoán rồi sửa cho khớp. Probe định hình các khẳng định: `hash(null)` ≡ `hash(undefined)` ≡ `hash({})` (**giống nhau**), còn `hash("")` và `hash([])` **khác** object rỗng |
| E9 | **Ca Unicode là ca đáng chú ý nhất** | Dấu thanh tổ hợp là **2 code unit nhưng 1 grapheme**. Nếu biên validation **normalize trước khi kiểm tra**, một key dựng từ combining mark sẽ sụp về khoảng 8..200 và **được chấp nhận** — tức dạng canonical của một credential sẽ phụ thuộc Unicode normalization. Cả hai biên đều bị khoá: dưới (8 ký tự + 1 combining) và trên (100 combining = **200 code unit**), cùng bộ 8 / 200 / 201 |
| E10 | **Bất đối xứng JSON, test chỉ đúng vì ĐO** | Trong OBJECT, `undefined` bị **xoá** khỏi JSON nên `{a: undefined}` ≡ `{}`, còn `{a: null}` thì **khác**. Tác giả ghi rõ: "test này chỉ đúng vì tôi **đo**, không phải vì tôi **giả định**" |
| E11 | **Purge race — lý do quan trọng hơn kết quả** | Marker tồn tại → purge xoá → cùng key + **payload khác** phải chạy mới. Nếu purge để lại tombstone thì client retry sau cửa sổ sẽ bị **409 vĩnh viễn bởi chính key của nó**. Thêm 1 test: purge trên store rỗng trả **0** chứ không lỗi |
| E12 | **Hành vi có, ghi ra chứ không sửa** | Route **không validate shape** của stored body: chuỗi ở chỗ cần object vẫn replay nguyên văn; body **null** replay với status **500**. Tác giả nêu rõ **tính chất idempotency vẫn giữ đúng** — `runs = 0` cả hai ca, side effect không lặp — nhưng body hỏng đi thẳng tới pane mà không có chốt shape. Ghi lại vì ngoài phạm vi, **không** sửa |
| E13 | Verify admin | `admin-idempotency.test.ts` ×3 tuần tự **45/45** mỗi lần; `tsc` Exit 0; **hồi quy 7 suite liên quan 277/277**, 7/7 suite |
| E14 | Tôi đếm lại từ source | `worker-service-auth` **8 `it()` + 2 khối `it.each`** = **19 chạy**; `artifact-multipart` **27 `it()`, 0 it.each**; `runtime-encryption-metadata` **78 `it()` + 8 khối `it.each`** = **105**; `admin-idempotency` **45 `it()`, 0 it.each**; `output-validation` **24 `test()`**. Không file nào có `skip`/`todo`/`only` |
| E15 | **Một chỗ khai báo ≠ chạy, ghi CẢ HAI số** | `output-validation` khai báo **24** `test()` nhưng receipt báo **32** chạy. Tôi **in từng dòng khai báo** ra kiểm: L85 (`validates custom schema required properties`) và L111 (`validates classification…`) là các test **lặp bên trong** ⇒ 24 khai báo sinh 32 lần chạy. Tôi ghi **cả hai số** thay vì ép chúng khớp nhau |
| E16 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=203 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E17 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — mục mới ghi tên receipt trong backtick, **không** nhúng link mới |
| E18 | Anchor | Chèn ledger-61 làm mọi dòng ≥ L422 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1682` → **`#L1683`**, content-assert L1683 = `## 16 — CYCLE 16`; `docs/06:75` đi `#L3195` → **`#L3196`**, content-assert L3196 = `- **Δ-A42-1` |
| E19 | **Một anchor hỏng thuộc lane khác — báo, KHÔNG sửa** | `review.md:1037` trỏ `qwen-docs.md#L1660`, và L1660 nay là **dòng rỗng**. Đây là đúng lớp lỗi Mục 21 đã gặp (anchor trỏ vào dòng không nội dung) — `BROKEN=0` không bắt vì dòng vẫn nằm trong khoảng. `review.md` **không phải** file của lane nên tôi **không** sửa, chỉ ghi ra. `coordinator-antigravity.md:145` trỏ `#L120` vẫn đúng nội dung |
### 61.2 Δ

- **Δ-A62-1 (packet nói 5, thực tế 4 receipt mới — báo, không bịa thêm để cho khớp):** trong 5 mục tôi tìm được, **một là bản chép nguyên văn** của `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` đã ghi ở Mục 60 — cùng task, cùng mốc, cùng số. Tôi ghi một mục ngắn "already on record / Not duplicated" thay vì nhân bản. Đây là lần thứ hai trong file `tester.md` một receipt xuất hiện dưới **hai header** (lần trước: `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE`, Mục 59). Có vẻ đây là hiện tượng lặp lại của một quy trình append, **không** phải lỗi ngẫu nhiên — nếu còn tiếp diễn thì nên xử lý ở nơi sinh receipt, không phải ở lane docs.
- **Δ-A62-2 (packet không nêu tên — và lần đầu tôi quét SAI):** packet chỉ nói "5 receipts Turn 339". Quét theo header H1/H2 cho ra 4 mục; tôi đã viết kết luận "4 mục" rồi mới kiểm settlement của coordinator và thấy mục thứ năm. Nguyên nhân: `qwen-admin.md` viết Mục bằng cặp `## N — CYCLE N` + dòng `**W-...**` chứ không phải header H1, nên regex của tôi bỏ sót. Bài học: **khi packet không đặt tên, "tôi tìm thấy N cái" là kết luận cần kiểm chéo, không phải kết luận cuối**. Tôi đã ghi việc này ở E0 thay vì xoá đi.
- **Δ-A62-3 (6 finding mới từ Muc 44, không cái nào được đóng):**
  - **Δ90 (rõ nhất với packet)** — **`seal` KHÔNG có trần kích thước.** Javadoc của module tự nói payload là "a SMALL inline JSON document (never a document body)" nhưng đó là **quy ước, không phải guard**: 256 KiB seal và mở trọn vẹn, vòng tròn mở lại đúng ở 65535/65536/65537/262144. Cùng file, `canonicalizeMetadataJson` đệ quy **không giới hạn độ sâu và không `try`**, nên tài liệu lồng sâu 100 000 tầng ném **RangeError thô** — thoát khỏi taxonomy. Sửa: trần byte ở `seal` + giới hạn độ sâu trong `canonicalize`.
  - **Δ91** — **`aad: null` thoát khỏi taxonomy dưới dạng `TypeError` thô** (`ERR_INVALID_ARG_TYPE`): `assertEnvelopeShape` chỉ loại `=== undefined`, và dòng decode AAD nằm **ngoài** `try` — khác với nonce/tag/ciphertext vốn nằm trong `try` nên vẫn ra `AUTHENTICATION_FAILED`. Cùng lỗ hổng `null` ở nonce/tag/ciphertext thì **bị chặn**. Sửa: kiểm `== null` ở shape, hoặc đưa decode AAD vào `try`.
  - **Δ92** — Envelope DEK bị bóp méo (`dek: {}`) báo **`KEY_PROVIDER_FAILED` — cùng mã** với sự cố Vault thật. Cả hai đều fail-closed nên **không** phải lỗ hổng, nhưng **một envelope bị tấn công không phân biệt được với một sự cố hạ tầng** khi phân loại sự cố. Sửa: bọc lỗi provider theo hình dạng đầu vào, hoặc thêm mã `INVALID_ENVELOPE`.
  - **Δ93 (khớp packet mục 4)** — **Không có khái niệm hết hạn.** Envelope **không có** trường thời gian nào (9 khoá đã chốt trong test), và seam **không tiêm đồng hồ**, nên "expired" không diễn đạt được và **tuổi của row không đo được**. Thứ gần nhất là `readStored(..., allowPlaintext)`: một **boolean quyết định ở mỗi lần gọi**, không có ngày để so ⇒ cửa sổ backfill có thể mở **vô thời hạn** nếu còn caller truyền `true`. Sửa: thêm `sealedAt` + `maxAge`, đóng backfill theo ngày thay vì theo boolean.
  - **Δ94** — **`isSealed` thiếu `keyRef` và `aad` trong bộ phân biệt.** Một envelope viết dở (thiếu hai field đó) được `isSealed` trả **true**, rồi `open` trả `NOT_SEALED`, và `readStored(..., true)` **không bao giờ** rơi về nhánh legacy-plaintext ⇒ **brick cột** thay vì hạ cấp về đọc thường. Fail-closed nên không rò dữ liệu, nhưng là lỗi khả dụng.
  - **Δ95 (vô hại, nhưng nên GHIM để không phá vỡ sau này)** — Trường `aad` **chỉ được so sánh**, không bao giờ đưa vào cipher (cipher luôn dùng AAD dẫn xuất). Vì `Buffer.from` giải mã base64 một cách **khoan dung**, AAD viết lại bằng alphabet **base64url** của cùng bytes vẫn **mở được**. Đây là hành vi **đúng thiết kế**; tá giả ghim lại để một đợt "siết cứng" sau này **không làm hỏng các row đang tồn tại**. Tôi ghi vào đây vì đây là loại ghi chú dễ bị hiểu nhầm thành lỗi.
- **Δ-A62-4 (bẫy đếm số, và tôi chọn ghi cả hai số thay vì ép khớp):** 3/5 file khai báo **ít hơn** số chạy — 8→19, 78→105, và 24→32. Riêng `output-validation` tôi **in từng dòng khai báo** ra để xác minh 24→32 là do các test lặp bên trong (L85, L111), chứ không phải receipt sai. Ba con số **57 / 96 / 81** là **tổng ba lần chạy**.
- **Δ-A62-5 (một phương pháp đáng ghi nhận, khác hẳn phần lớn receipt khác):** tác giḺ Muc 48 **probe hành vi thật trước khi viết test**. Hầu hết receipt tôi đã đọc viết test rồi sửa cho khớp; probe trước làm các khẳng định **đáng tin** thay vì **có vẻ đúng**, và nó bắt được ca Unicode combining-mark mà nếu viết theo trực giác sẽ bỏ sót. Tôi ghi lại vì đây là thứ **nên nhân bản**, không phải chỉ là chi tiết của một cycle.
- **Δ-A62-6 (một hàng quan trọng vẫn còn mở, từ Mục 59):** khi purge idempotency xoá marker, cùng key + **payload khác** được chạy mới. Tác giả nêu đúng lý do: nếu purge để lại tombstone thì **client retry sau cửa sổ bị khoá vĩnh viễn bởi chính key của nó**, và ca quan trọng là token đã hết hạn phải **tái sử dụng được**. Hành vi này nay đã có test khoá. Chưa đóng gate, chỉ là hành vi đã được chứng minh.
- **Δ-A62-7:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G6` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 4 receipt mới đều tests-only, offline — **không** receipt nào promote gate. Δ69/Δ66/Δ74–Δ79/Δ81/Δ82/Δ83–Δ89 còn mở, cộng **Δ90–Δ95** mới. Test xanh **KHÔNG** phải tín hiệu GO — receipt này có **105 test xanh** và **10 finding chưa đóng** đi kèm.
### 61.3 Lỗi của chính tôi

1. **Tôi quét SAI một lần trước khi ghi bất cứ thứ gì.** Packet không nêu tên receipt. Regex theo H1/H2 cho ra 4 mục; tôi đã nghĩ xong là "packet nói 5 nhưng tôi chỉ thấy 4" và **định ghi như vậy vào docs/28**. Chỉ khi kiểm settlement Turn 341 của coordinator tôi mới thấy mục thứ năm nằm ở `qwen-admin.md` Muc 48 — lane đó dùng cặp `## N — CYCLE N` + dòng `**W-...**`, không phải header H1. Tôi đã sửa **trước khi** ghi vào file, nhưng điều đáng nói là **"tôi tìm thấy N cái" là kết luận cần kiểm chéo, không phải kết luận cuối**. Tôi giữ cả hai chuyện trong E0 và Δ-A62-2 thay vì xoá sạch cho gọn.
2. **Một assert fail lần nữa vì tôi ĐOÁN chuỗi thay vì ĐỌC:** tôi viết `assert T28.startswith("- **PLATFORM-MOUNT PORT ISOLATION-HARDENING**")` trong khi dòng thật là `- **The receipt is explicit that it promotes nothing**…`. Nội dung file **đúng**, chỉ guard của tôi sai. Đây là lần thứ **mười** của lỗi này. Lần này tôi in **cả 3 dòng cuối** của cả hai file rồi dùng **so khớp nguyên văn** thay vì `startswith` — nên guard về sau không còn phụ thuộc việc tôi nhớ đúng chữ.
3. **Hai needle "missing" mà thật ra lỗi của tôi, không phải lỗi nội dung:** một cái tôi viết `"a verbatim duplicate"` trong khi file ghi `**verbatim duplicate**` (có dấu **); cái còn lại là số đếm của runtime-encryption mà tôi **chưa từng viết** vào docs/28. Cái thứ hai là **khoảng trống thật** trong bài của tôi — mọi mục khác trong docs/28 đều có dòng "Counted from source", riêng mục này thì không — nên tôi **bổ sung** thay vì bỏ needle. Đây là hướng ngược lại với việc nới check cho qua.
4. **Một typo tiếng Việt trong fragment:** tôi viết "tác giả" thay vì "tác giả" trong Δ-A62-5. Tôi bắt được **trước khi** file vào repo, sửa đúng 1 chỗ, rồi **kiểm bằng codepoint** (U+1EA1/U+1EA3) chứ không tin màn hình console — vì console hiển thị sai dấu và suýt khiến tôi tưởng file hỏng trong khi thực ra file đúng. Bài học nhỏ nhưng thật: **đừng kết luận file hỏng chỉ vì terminal hiển thị lạ**; hãy đọc byte.
5. **Điều tôi làm ĐÚNG và muốn giữ:** (a) tự dò packet không đặt tên và **kiểm chéo bằng nguồn thứ hai** (settlement coordinator) trước khi kết luận; (b) đối chiếu bản chép nguyên văn của temp-sweep **từng trường** (task, mốc, số test, số lần chạy) chứ không chỉ trùng tên; (c) in **từng dòng khai báo** của `output-validation` để xác minh 24→32 là test lặp bên trong chứ không phải receipt sai, rồi ghi **cả hai số**; (d) phân biệt rõ M1b đỏ ở **test mới** mạnh hơn M1a đỏ ở test cũ; (e) **không** sửa `review.md` dù anchor của nó trỏ vào dòng rỗng — ghi ra ở E19 thay vì mở rộng phạm vi.
6. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF/bare-LF không đổi; `docs/35` bump **1.62.0 → 1.63.0** đúng một chỗ.

## 62 — CYCLE 62: D-DOCS-EVID-SYNC-340 — LẦN ĐẦU có `test.failing` trong hồ sơ: 4 khối mà KHÔNG receipt nào nói tới; một suite 13 → 22 mà thay đổi không chỉ ở số

> **RESUME POINT — cycle 62 (packet D-DOCS-EVID-SYNC-340, Turn 344, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–61 giữ nguyên phía trên như lịch sử.
> 1. **Packet không nêu tên receipt.** Lần này tôi **không** quét rồi kết luận — tôi quét rồi **kiểm chéo bằng settlement Turn 343** ngay, vì bài học Mục 61 đã dạy tôi đúng bài học đó.
> 2. **Phát hiện quan trọng nhất của cycle: `test.failing`.** Đây là lần đầu trong hồ sơ docs có test **xanh vì product CÒN LỖI**. Tôi tìm ra **4 khối** ở 2 file, và **không receipt nào nhắc tới** khối nào. Chi tiết ở E5–E8.
> 3. **`docs/28` giữ version 1.48.0** — bump **1.63.0 → 1.64.0** là version của **docs/35**.
> 4. **Một receipt tên trùng đã có sẵn trong docs/28 từ cycle trước** — `W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE` đã ở L1180 với **13 test**. Tôi ghi mục **delta** (13 → 22) chứ không nhân bản. Guard bắt được việc này.

### 62.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Quét + kiểm chéo ngay** | 5 receipt mới: `T-CODEX-OFFLINE-ARTIFACT-READ-AUTH-AND-IDEMPOTENCY-INDEPENDENT` (tester **10184**, task_7d2b104c8f1e) · `T-CODEX-OFFLINE-MULTIPART-AND-BUDGET-BAND-INDEPENDENT` (tester **10214**, task_9c1b47e20a3d) · `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` (tester **10268**, task_6d1f92e30a4b) · `W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE` (task_5f3b92c10a7e) · `W-ADM-UX-02-PAGINATION-NEGATIVE` (qwen-admin Muc 49 L4790, task_3e91b4027a8c). Tôi đọc settlement Turn 343 **để đối chiếu danh sách** chứ không phải để săn mục tôi đã bỏ sót |
| E1 | **Hai header lặp lại lần nữa** | `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` (L10250) và `W-WORKER-SDK-ARTIFACT-MULTIPART-NEGATIVE` (L10259) lại xuất hiện lần nữa với nội dung **nguyên văn** bản đã ghi (trùng task, trùng mốc 05:18:26 / 05:52:44, trùng số). Không ghi lại. **Đây là lần thứ BA** một receipt có hai header trong `tester.md` ⇒ hiện tượng lặp có hệ thống, Δ-A63-2 |
| E2 | **Đọc lại thay vì chép receipt** | Re-verification độc lập: artifact-read-authorization 3 × **90** (**270**), admin-idempotency 3 × **45** (**135**), tsc orchestrator 0. Tôi ghi đây là **tầng bằng chứng riêng** — người thứ hai chạy lại suite **không phải** cùng một claim với mutation evidence của tác giả gốc, và hai thứ **không** nên gộp |
| E3 | **Re-verification thứ hai** | artifact-multipart 3 × **27** (**81**) · parser-budget-band 3 × **22** (**66**) · tsc 0 cả 2 package. Receipt tự ghi: chỉ ghi bằng chứng, **không** đổi gate |
| E4 | **Đếm từ source — 6 file** | `artifact-read-authorization` **34 `it()` + 7 khối `it.each`** = 90 ✓ · `admin-idempotency` **45 `it()`** ✓ · `artifact-multipart` **27 `it()`** ✓ · `admin-operations-list-pagination` **99 `it()` + 1 khối `it.each`** = 103 ✓ · `parser-budget-band` **21 `it()` + 1 `test.failing`** · `ingest-scan-tamper` **13 `it()` + 3 `test.failing`** |
| E5 | **`test.failing` — khái niệm mới trong hồ sơ này** | `test.failing` **đảo ngược** khẳng định: suite xanh **vì** hành vi đang hỏng. Nó là loại negative test **hữu ích nhất** khi thiếu hành vi, và cũng **dễ đọc sai thành kết quả xanh nhất**. Hệ quả trực tiếp: một suite báo "16 passed" **không** phải 16 assertion đúng ý — **3** trong số xanh vì defect còn nằm đó |
| E6 | **Ingest scan tamper — 3 khối, receipt CÓ nói** | L322 PDF khai là PNG trước khi tới OCR · L334 TIFF bị cắt bên trong magic header trước khi digitize · L344 JPEG hỏng byte SOI trước OCR. Receipt nói thẳng: streaming OCR/digitize **đang cho** những byte đó đi qua, test **ghi lập lỗ hổng** mà **không** đổi implementation. 3 lần × 1 suite/**16 test** Exit 0; tsc 0 |
| E7 | **Parser budget band — 1 khối, receipt KHÔNG nói** | L182 `rejects parser metadata that reports a negative page count` — tức page count **âm hiện chưa bị từ chối**. **Cả receipt chủ sở hữu lẫn receipt xác minh độc lập đều không nhắc.** Mục docs/28 của cycle trước ghi 13 test và không nói gì về expected-failure ⇒ tăng 13 → 22 **không** đơn thuần là thêm 9 assertion đúng |
| E8 | **Tổng của wave** | **4 khối `test.failing` ở 2 file**, và **không khối nào** được nêu trong văn bản receipt. Đây là lý do tôi đếm từ file thay vì tin receipt — nếu chỉ đọc receipt thì cả 4 đều vô hình. Δ-A63-1 |
| E9 | **Admin pagination — PROBE lại, và kết quả ngược trực giác** | `clampListLimit`: 0 / âm / -9999 kẹp **lên 1**; 100 / 101 / 1000000 kẹp về **100**; NaN / Infinity / undefined / null / rỗng về **mặc định hợp đồng 20**; **1.9 → 1 (truncate, KHÔNG round)**; chuỗi `12abc` → **12** vì parser đọc tiền tố |
| E10 | **Hai hành vi được GHIM CỐ Ý, và lý do** | Tác giả ghim `1.9 → 1` để một thay đổi parser tương lai thành **diff nhìn thấy được** chứ không phải thay đổi hợp đồng im lặng; và ghim `12abc → 12` là **hành vi đo được, không phải hành vi mong muốn** — và ông gọi đó là **ranh giới giữa test bảo vệ hợp đồng và test bảo vệ cách hiện tại vô tình**. Câu này là phần đáng giá nhất của receipt |
| E11 | **Một nhóm test bị GỠ, và nói rõ** | Ông định thêm nhóm envelope hỏng nhưng **`parseListPayload` không được export** — internal, chỉ lộ qua object `__test`. Gọi từ test sẽ phải import `__test` thay vì hàm, hoặc sửa production để export (ngoài phạm vi). Ông **gỡ nhóm đó** thay vì ép import hay sửa source, và ghi nó là **khoảng trống coverage thật** cho coordinator. Một lỗ hổng coverage được viết ra còn giá trị hơn một test chỉ tồn tại được bằng cách uốn méo ranh giới |
| E12 | **Một sự thật orchestration được báo trung thực** | Muc 49 ghi rõ: **không có task Turn 341 nào trong run** (task-list và dispatch-check đều rỗng cho 341 / pagination / UX-02), và tác giả nói ông đủ thông tin từ tin nhắn để làm, đồng thời báo cáo task đó **không tồn tại**. Đây đúng là kỷ luật lane này áp dụng, và đáng ghi là **một lane khác cũng làm vậy** |
| E13 | Verify admin | `admin-operations-list-pagination.test.ts` ×3 **103/103**; tsc Exit 0; **hồi quy 7 suite 233/233**, 7/7 suite |
| E14 | **Số bị ghi thành delta, không nhân bản** | Guard chặn đúng: `### W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE` **đã có** trong docs/28 từ L1180 (13 test). Tôi đọc mục cũ, xác nhận nó **không** nói gì về `test.failing` và **không** nói 22, rồi viết mục **follow-on delta** chứ không tạo mục trùng |
| E15 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=204 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E16 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** — mục mới ghi tên receipt trong backtick, **không** nhúng link mới |
| E17 | Anchor | Chèn ledger-62 làm mọi dòng ≥ L423 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1683` → **`#L1684`**, content-assert L1684 = `## 16 — CYCLE 16`; `docs/06:75` đi `#L3196` → **`#L3197`**, content-assert L3197 = `- **Δ-A42-1` |
| E18 | **Anchor của lane khác — báo, KHÔNG sửa** | `review.md:1037` trỏ `qwen-docs.md#L1660`. Ở Mục 61 dòng đó là **dòng rỗng**; sau khi chèn ledger-62 nó lệch thành một dòng prose về escape char của PowerShell. Nghĩa là **nội dung đích đã đổi tiếp** do chèn dòng của tôi — nhưng `review.md` không phải file của lane nên tôi **không** sửa, chỉ ghi. `coordinator-antigravity.md:145` trỏ `#L120` vẫn đúng |
### 62.2 Δ

- **Δ-A63-1 (loại bằng chứng MỚI xuất hiện lần đầu trong hồ sơ này, và là thứ đáng chú ý nhất của cycle):** **4 khối `test.failing` ở 2 file**, và **không receipt nào nào nêu tới khối nào**. Cụ thể: `ingest-scan-tamper.test.ts` có 3 (L322, L334, L344) — PDF khai là PNG, TIFF cắt trong magic header, JPEG hỏng byte SOI; `parser-budget-band.test.ts` có 1 (L182) — **page count âm hiện chưa bị từ chối**. Tác giả của 3 khối đầu **có** nói rõ trong receipt; tác giả của khối thứ tư **không nói**, và receipt xác minh độc lập cũng **không nói**. Ý nghĩa thực tế: **"N passed" trong cột này không đồng nghĩa với N assertion đúng ý** — ba (hoặc bốn) trong số xanh **vì** defect còn tồn tại. Đây là dạng negative test hữu ích nhất khi product thiếu hành vi, nhưng cũng dễ bị đọc sai thành kết quả xanh nhất nhất.
- **Δ-A63-2 (một receipt có hai header — lần thứ BA, có hệ thống):** `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` (L10250) và `W-WORKER-SDK-ARTIFACT-MULTIPART-NEGATIVE` (L10259) lại được append lần nữa, nội dung **nguyên văn** bản đã ghi. Chuỗi ba lần: `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` (Mục 59) → `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` (Mục 61) → hai cái này (Mục 62). Tôi **không** ghi lại lần nào. Vì hiện tượng đã lặp **ba** và luôn **nguyên văn**, tôi nêu thẳng: đây nhiều khả năng là quy trình append ở nơi sinh receipt chạy lại trên một file đã có nội dung, **không** phải lỗi ngẫu nhiên. Nên xử lý ở đó; lane docs chỉ có thể ghi nhận.
- **Δ-A63-3 (một receipt tên trùng đã có sẵn — tôi ghi delta, không nhân bản):** `W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE` đã nằm trong docs/28 từ L1180 với **13 test**. Ở Turn 340 nó lên **22**. Guard chặn đúng việc tôi sắp tạo mục trùng; tôi đọc mục cũ, xác nhận nó **không** nhắc `test.failing` và **không** nhắc con số 22, rồi viết mục **follow-on**. Sự chênh 13 → 22 **không** phải chín 9 assertion đúng — nó chứa **một** `test.failing` mà mục cũ không thể biết. Nếu tôi chỉ cập nhật con số thì tôi đã bỏ sót đúng thứ quan trọng nhất.
- **Δ-A63-4 (tách tầng bằng chứng, không gộp):** hai receipt trong cycle này là **xác minh độc lập** của suite đã có (artifact-read-authorization 90, admin-idempotency 45). Tôi ghi chúng thành mục **riêng** chứ không nhân vào mục gốc ở Mục 60/61. Lý do: mutation evidence của tác giả và lần chạy lại của người thứ ba **không phải cùng một claim** — một cách gộp sẽ làm mất thông tin về ai đã kiểm chứng cái gì. `artifact-read-authorization` nay có **hai** lớp xác nhận độc lập, và đó là điều đáng ghi.
- **Δ-A63-5 (bẫy đếm số):** 2/6 file có `test.failing` làm khai báo **không bằng** chạy theo nghĩa thường — 21→22 và 13→16. 4/6 file khai báo ít hơn số chạy vì `it.each` (34→90, 99→103). Ba con số **270 / 135 / 81 / 66** là **tổng ba lần chạy**.
- **Δ-A63-6 (một sự thật orchestration, và tôi tự nói rõ về packet của chính mình):** Muc 49 của admin ghi **không có task Turn 341 nào trong run**, và tác giả báo cáo trung thực điều đó. Packet của tôi ở cycle này (D-DOCS-EVID-SYNC-340) cũng **không** có task id, nên tôi gửi `status` chứ không `worker_done`. Trong settlement Turn 343, dòng của chính lane tôi là `task_a47e1934b02c` / `ctx_a47e1934b02c` cho **D-DOCS-EVID-SYNC-339** — tức task id của cycle **trước**, không phải của cycle này; tôi **không** dùng nhầm nó. Sự trung thực về id là thứ nên giữ từ cả hai phía.
- **Δ-A63-7:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G6` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 5 receipt đều tests-only, offline — **không** receipt nào promote gate. Δ69/Δ66/Δ74–Δ79/Δ81/Δ82/Δ83–Δ95 còn mở. Test xanh **KHÔNG** phải tín hiệu GO — và ở cycle này câu đó còn **đúng hơn thường**, vì có những test xanh **vì** sản phẩm còn lỗi.
### 62.3 Lỗi của chính tôi

1. **Một guard chặn đúng, và tôi biết ơn nó thay vì làm nó nới lỏng:** tôi định tạo mục `### W-DOC-CORE-PARSER-BUDGET-BAND-NEGATIVE` trong docs/28, guard báo đã tồn tại — mục cũ ở L1180 từ cycle trước. Nếu tôi ép cho qua, docs/28 sẽ có **hai mục cùng tên** với hai con số khác nhau và **không ai biết cái nào đúng**. Thay vào đó tôi đọc mục cũ, xác nhận nó không nhắc `test.failing` và không nhắc 22, rồi viết mục delta. Đây là lần guard cứu được một lỗi **thật** chứ không phải lỗi hình thức.
2. **Hai lần `unexpected end of string` khi tôi dựng script** — lần nhất còn do nhúng một list Python có dấu nháy kép vào chuỗi JS. Cả hai chỉ tốn vòng, không chạm file. Nhưng chúng cho thấy một điều tôi nên tự làm: **viết dữ liệu vào file fragment riêng rồi đọc bằng `open()`**, thay vì nhúng chuỗi nhiều dòng vào mã sinh script. Tôi đã làm đúng thế ở các vòng sau ngay trong cycle này.
3. **Điều tôi làm ĐÚNG và muốn giữ:** (a) **không** lặp lại lỗi Mục 61 — sau khi quét tôi **kiểm chéo bằng settlement Turn 343 ngay**, chứ không kết luận rồi mới sửa; (b) **đếm `test.failing` từ file** ở cả 2 suite, và phát hiện ra **1 khối mà không receipt nào nói** — đây là phát hiện giá trị nhất của cycle, và nó **chỉ** xuất hiện vì tôi không tin receipt; (c) **không** sửa `review.md` dù anchor của nó lệch, ghi ở E18; (d) **không** dùng nhầm `task_a47e1934b02c` (task của cycle trước, lộ ra trong settlement) cho cycle này; (e) tách hai receipt xác minh độc lập thành mục riêng thay vì gộp vào mục gốc.
4. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.63.0 → 1.64.0** đúng một chỗ. Tôi **đọc 3 dòng cuối của cả hai file trước khi viết guard** — học từ Mục 61 — nên guard dùng **so khớp nguyên văn** và không cần sửa lần nào.
5. **Một điều tôi chưa làm được:** packet không có task id, nên tôi gửi `status` thay vì `worker_done`. Ở Mục 61 tôi từng cảnh báo "gửi lại worker_done ngay khi có id thật" — nay vẫn chưa có id cho cycle này, và tôi **không** bịa. Nếu coordinator muốn `worker_done` cho D-DOCS-EVID-SYNC-340 thì cần id thật từ task list.

## 63 — CYCLE 63: D-DOCS-EVID-SYNC-341 — HAI mutation đều đỏ ở test MỚI (mạnh nhất từ trước tới); một giả thuyết sai bị loại bỏ TRƯỚC khi viết test; 5 finding Δ96–Δ100

> **RESUME POINT — cycle 63 (packet D-DOCS-EVID-SYNC-341, task `task_5e3a91b40c4e`, dispatch `ctx_5e3a91b40c4e`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–62 giữ nguyên phía trên như lịch sử.
> 1. **Packet LẦN ĐẦU có task id thật.** Tôi vẫn gửi `status` cho tới khi kiểm được task list, vì tôi đã bịa một lần trước đó và không muốn lặp lại.
> 2. **3 receipt mới**, không phải 5: một là **bản chép nguyên văn lần thứ TƯ** của receipt đã ghi ở Mục 62. Chi tiết ở Δ-A64-1.
> 3. **`docs/28` giữ version 1.48.0** — bump **1.64.0 → 1.65.0** là version của **docs/35**.
> 4. **Zero production code edits** — cả 3 receipt đều test-only, và hai file production được nêu đều **nguyên trạng** với sha khớp các cycle trước.

### 63.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 3 receipt mới: `T-CODEX-OFFLINE-CONNECTOR-INVOKER-AND-SCAN-TAMPER-INDEPENDENT` (tester **10278**, task_3e1a8b94c01d, 06:15:20) · `W-PLAT-CR28-05-CRYPTO-STORAGE-FACADE-NEGATIVE` (qwen-platform Muc 45 L4129, task_5c8e2194b17a) · và bản chép lần thứ tư của `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` (tester **10312**). Đối chiếu settlement Turn 344 khớp từng mục. `qwen-platform.md` dài **4127 → 4250** |
| E1 | **Packet đến từ INBOX, không có file trên đĩa** | Muc 45 ghi rõ: packet lấy từ **inbox** (`msg_84676fec5d9d`, sequence 283). Tôi ghi lại vì đó là khác biệt về **cách bằng chứng được chuyển đến**, không phải về độ mạnh — và vì nó có thể thành vấn đề truy vết về sau |
| E2 | **Cả hai mutation đỏ ở TEST MỚI — mức bằng chứng mạnh nhất** | **M1a** bỏ `purpose` khỏi `contextAad` ⇒ **2 failed, 99 passed**, và **cả 2 đều là test mới**. Đây là bằng chứng `purpose` **thật sự** nằm trong AAD chứ không phải trường trang trí: **trước cycle này bỏ nó đi KHÔNG làm đỏ test nào**. **M1b** đổi `decodeBase64` từ `invalidManifest` sang `invalidInput` ⇒ **4 failed, 97 passed**, **cả 4 đều là test mới** |
| E3 | **Vì sao đây là mức mạnh nhất tôi từng gặp** | Ở Mục 59 (submit-guards) và Mục 60 (read-auth), mutation đỏ ở test **cũ**, chỉ chứng minh guard tồn tại. Ở Mục 61 (runtime-encryption) M1b đỏ ở test mới. Ở đây **cả hai** đều đỏ ở test mới ⇒ nhóm test mới **thật sự cắn** ở **hai** chỗ độc lập, không phải một lần may mắn |
| E4 | Deliverable | **+74 test (27 → 101)**, **0 dòng production**: `crypto-storage-facade.ts` nguyên trạng `dcd7e3db` — receipt ghi rõ sha này **khớp đúng** giá trị đã ghi ở Mục 36/37, nên **không** có drift. Test `29206e36` / 49096 B / **CRLF** |
| E5 | **Khoảng trống thật đã tìm ra, không phải làm theo danh sách** | Lớn nhất: **`purpose` chưa từng được biến đổi** dù nó nằm trong `contextAad`. Tác giả **đọc lại** và chỉ viết cho khoảng trống thật — các mục đã phủ sẵn từ Mục 36/38 **không** bị viết lại |
| E6 | **Ba mã lỗi cho MỘT lớp lỗi metadata** | version/algorithm sai ở object single-shot ⇒ `INVALID_INPUT`; ở sidecar ⇒ `INVALID_MANIFEST`; tag hỏng ⇒ `INVALID_MANIFEST`. Mọi caller bật switch theo mã đều phải xử lý một mã **không áp dụng** cho đường mình gọi |
| E7 | **Verify** | 3 lần: mỗi lần **101 passed, 101 total**; `tsc` Exit 0 **log 0 byte** cả trước M1 lẫn sau khôi phục. Khôi phục byte-exact **hai lần**, rồi **đọc lại** xác nhận `purpose` còn trong AAD và `decodeBase64` đã trở lại |
| E8 | **M1b nâng Δ97 từ phỏng đoán lên sự thật** | Đổi mã làm 4 test mới đỏ ⇒ phát hiện Δ97 **được chứng minh** chứ không phải đoán. Đây là cách một finding được nâng lên mức chứng minh được |
| E9 | **MỘT GIẢ THUYẾT SAI BỊ LOẠI BỎ TRƯỚC KHI VIẾT TEST** | Tác giả **nghi ngờ** `manifestMac` là trường trang trí, vì trong `validateManifest` nó chỉ được kiểm **hình dạng**, không có phép so sánh nào; ông định viết test chứng minh MAC không được xác thực. Đọc tiếp `decryptChunkGenerator` thì thấy MAC **có verify thật**: tính HMAC từ manifest MAC key rồi `timingSafeEqual` **trước khi** giải mã bất kỳ chunk nào. **Giả thuyết sai, đã bỏ** |
| E10 | **Viết test PHỦ ĐỊNH chính giả thuyết đó** | Thay MAC bằng một giá trị base64 32 byte khác (cùng độ dài, cùng alphabet) ⇒ `AUTHENTICATION_FAILED`. Tác giả nói đây là bằng chứng MAC là kiểm thật **đáng giá hơn một phát hiện sai**, và tự nêu bài học: đọc **hết** đường đi trước khi kết luận một guard là trang trí — cùng lớp với lỗi `err.detail` ở Mục 42 |
| E11 | **Một test của chính tác giả đỏ ngay khi chạy — và ông xử lý đúng** | Test objectVersion bị cắt còn 1 ký tự đỏ vì ông giả định một version 1 ký tự sẽ bị từ chối, nhưng `validateText` chỉ yêu cầu length ≥ 1 nên nó **hợp lệ**. Ông **không** sửa harness: ông kết luận đây là **hành vi thật**, chuyển thành **Δ96**, rồi viết lại test theo đúng hành vi đó |
| E12 | **EOL guard chặn lỗi nghiêm trọng TRƯỚC khi nó xảy ra** | File test là **CRLF** còn chunk của tác giả viết bằng LF; nối thẳng sẽ tạo file **EOL hỗn tạp**. Guard chặn kịp, sửa join để chuẩn hoá CRLF và **chốt** bằng `bareLF: 0`. Ba file test sửa trong các cycle này có EOL khác nhau (LF, LF, CRLF) — **phải đọc file, không đoán** |
| E13 | **Tôi verify EOL từ source** | `crypto-storage-facade.test.ts`: **976 CRLF, bareLF = 0**, 49096 B, sha `29206e36` — khớp đúng receipt. Không chỉ tin lời |
| E14 | **Re-verification độc lập** | connector-invoker 3 × **26** (**78**); ingest-scan-tamper 3 × **16** (**48**); tsc 0 cả 2 package |
| E15 | **Caveat test.failing đi theo cả lần xác minh độc lập** | File ingest-scan-tamper **không đổi**: **13 it() + 3 test.failing** = 16. Ba trong số mười sáu passed ở đây xanh **vì** streaming OCR vẫn cho byte đó đi qua. **Xác minh độc lập không làm thay đổi ý nghĩa của kết quả xanh** |
| E16 | **Một con số trong settlement đáng chú ý** | Settlement Turn 344 ghi: 16/16 pass x3, +7 tests mới, 3 expected-failing probes. Đây là lần đầu trong hồ sơ wave mà khối expected-failing được nêu **ngay trên dòng tóm tắt**. Và +7 đứng cạnh 3 expected-failing nghĩa là delta **không phải 7 assertion đúng thêm** |
| E17 | Tôi đếm từ source | `crypto-storage-facade` **34 it() + 12 khối it.each + 10 test()**, 0 test.failing, 0 skip · `connector-invoker` **14 it() + 4 khối it.each** = 26 · `ingest-scan-tamper` **13 it() + 3 test.failing** = 16 |
| E18 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=206 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E19 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** | **Ghi chu trung thuc:** so TREE doi 205 -> 206 giua cac lan chay vi mot lane khac them file; BROKEN van la **cung 2** link pre-existing nen ket luan khong doi.
| E20 | Anchor | Chèn ledger-63 làm mọi dòng ≥ L424 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1684` → **`#L1685`**, content-assert L1685 = header Muc 16; `docs/06:75` đi `#L3197` → **`#L3198`**, content-assert L3198 = dong Δ-A42-1 |
### 63.2 Δ

- **Δ-A64-1 (packet nói 5, thực tế 3 receipt mới — và đây là lần thứ TƯ có bản chép):** `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` lại được append vào `tester.md` lần nữa, nay ở **L10312**, **nguyên văn** bản đã ghi ở Mục 62: cùng task `task_6d1f92e30a4b`, cùng mốc **06:10:15**, cùng **16 test**, cùng ba khối `test.failing`. Chuỗi đầy đủ: `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` (Mục 59) → `W-WORKER-SDK-TEMP-SWEEP-NEGATIVE` + `W-WORKER-SDK-ARTIFACT-MULTIPART-NEGATIVE` (Mục 62) → `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` (nay). Tôi **không** ghi lại. Hiện tượng đã lặp **bốn** và luôn **nguyên văn**: tôi nêu lại rằng đây nhiều khả năng là quy trình append chạy lại trên file đã có nội dung, và nên xử lý ở nơi sinh receipt.
- **Δ-A64-2 (5 finding mới từ Muc 45, không cái nào được đóng):**
  - **Δ96** — **`objectVersion` KHÔNG có độ dài tối thiểu ngoài 1.** `validateText` chỉ chặn rỗng / >512 / ký tự điều khiển, nên một version **bị cắt** từ `v7` xuống còn một ký tự vẫn là binding **hợp lệ** và được ghi thành công. Hậu quả: lỗi cắt chuỗi **không bị chặn tại chỗ ghi**, mà bị đẩy xuống rất lâu sau thành một lệch AAD. Sửa: đặt độ dài tối thiểu hợp lý, và cân nhắc áp dụng cho `tenantId`/`artifactId`.
  - **Δ97 (rõ nhất với packet)** — **Mã lỗi của *stream* rò vào API single-shot.** `decodeBase64` gọi `invalidManifest()`, nên `decrypt()` trên một object **không có manifest, không có chunk** vẫn trả **`INVALID_MANIFEST`** khi tag thiếu / sai độ dài / không base64. Cùng một lớp lỗi metadata cho **hai** mã khác nhau theo đường đi. Mọi caller bật `switch` theo mã đều phải xử lý một mã không áp dụng cho đường mình đang gọi. Sửa: cho `decodeBase64` nhận mã lỗi theo tham số, hoặc tách hàm cho đường single-shot.
  - **Δ98** — **DEK ciphertext lệch bị báo thành `KEY_PROVIDER_FAILED`.** Provider không tìm thấy wrapped key và ném lỗi, facade ánh xạ **mọi** lỗi của provider thành mã đó ⇒ **một hàng bị bóp méo trông y hệt Vault đang sập**. Tác giả nói rõ đây là **cùng một lớp nhầm lẫn phân loại sự cố** đã báo ở Δ92 trên metadata seam cycle trước, và có bằng chứng: cùng cách sửa (siết kiểm tra đầu vào trước khi gọi provider) đã đóng được Δ92 — tức đây là **cùng một lớp lỗi lặp lại ở hai seam**. Đây là mẫu hình đáng chú ý: một lỗi phân loại đã biết vẫn tái diễn ở seam thứ hai.
  - **Δ99** — **Hai đường cùng một lớp lỗi trả hai mã khác nhau** (chi tiết phụ của Δ97): đổi `purpose` ở đường single-shot ra `AUTHENTICATION_FAILED`, ở đường stream ra `INVALID_MANIFEST` **và ném đồng bộ**. Không phải lỗ hổng, nhưng làm người đọc tưởng stream "chặt hơn" trong khi nó chỉ kiểm ở tầng khác.
  - **Δ100** — **`purpose` là binding thật nhưng contract không nói rõ nó bắt buộc.** Nó nằm trong `contextAad` nên đổi purpose làm hỏng mọi row, nhưng không tài liệu nào nói `purpose` phải khớp giữa lúc ghi và lúc đọc. Tác giả ghi rõ M1a đã đóng nó **ở mức coverage** nhưng nó **vẫn là delta** vì contract chưa nói. Đây là phân biệt đáng giữ: có test ≠ có hợp đồng.
- **Δ-A64-3 (một hành vi đáng ghi nhớn, và tôi muốn nhân bản):** tác giả **loại bỏ một giả thuyết sai TRƯỚC khi viết test**. Ông nghi `manifestMac` là trường trang trí, định viết test chứng minh điều đó, rồi đọc tiếp và thấy MAC **được verify thật** bằng HMAC + so sánh timing-safe **trước khi** giải mã bất kỳ chunk nào. Sau đó ông viết một test **phủ định chính giả thuyết đó**. Tác giả tự nêu bài học: **đọc hết đường đi trước khi kết luận một guard là trang trí** — cùng lớp lỗi với `err.detail` ở Mục 42. Một receipt nói ra cả điều mình sai có giá trị hơn một receipt chỉ nói điều đúng.
- **Δ-A64-4 (một con số trong settlement, đáng giữ):** Turn 344 settlement ghi `16/16 pass x3 (+7 tests mới, 3 expected-failing probes)`. Đây là lần đầu khối expected-failing được nêu **ngay trên dòng tóm tắt** chứ không chỉ nằm trong thân receipt. Và `+7` đứng cạnh `3 expected-failing` nghĩa là delta **không phải 7 assertion đúng thêm** — một người đọc chỉ dòng summary sẽ hiểu sai. Tôi ghi rõ trong docs/28.
- **Δ-A64-5 (bẫy đếm số, lần thứ năm liên tiếp):** `crypto-storage-facade` khai báo **34 it() + 12 khối it.each + 10 test()** cho **101** chạy; `connector-invoker` **14 + 4** = 26; `ingest-scan-tamper` **13 + 3 `test.failing`** = 16. Hai con số **78 / 48** là **tổng ba lần chạy**.
- **Δ-A64-6 (packet đến từ inbox — ghi lại vì nó có thể thành vấn đề truy vết):** Muc 45 ghi packet lấy từ **inbox** (`msg_84676fec5d9d`, sequence 283), **không có file packet trên đĩa**. Bằng chứng vẫn hợp lệ, nhưng khác với mọi receipt khác trong đợt này: không có artifact để đối chiếu độc lập về sau. Tôi ghi vào receipt thay vì bỏ qua, vì đây là loại chi tiết mà sáu tháng sau sẽ không ai dò ra.
- **Δ-A64-7:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G6` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 3 receipt đều test-only và **zero production code edits** như packet yêu cầu. Δ69/Δ66/Δ74–Δ79/Δ81–Δ95 còn mở, cộng **Δ96–Δ100** mới. Test xanh **KHÔNG** phải tín hiệu GO — 101 test xanh ở đây đi kèm **5 finding chưa đóng**, và file khác vẫn có 3 test xanh **vì** lỗi còn nằm đó.
### 63.3 Lỗi của chính tôi

1. **Hai lần tôi làm hỏng chính công cụ dựng fragment trước khi nó chạm file.** Lần đầu tôi nhúng một danh sách Python vào chuỗi JS, làm parser hỏng; lần sau tôi viết một dòng chứa dấu nháy đơn trong chuỗi JS đơn, cũng làm hỏng parser. Cả hai chỉ tốn vòng và **không** chạm bất kỳ file nào. Nhưng chúng là lần thứ tư hoặc thứ năm trong các cycle gần đây mà tôi mắc đúng lớp lỗi này, và tôi **đã biết cách sửa**: viết dữ liệu vào file fragment riêng rồi đọc bằng open(). Tôi áp dụng cách đó ngay trong cùng cycle (file frag_note63.md) — nhưng đáng lẽ phải làm ngay từ đầu, không phải sau khi hỏng hai lần.
2. **Một dòng bảng trong fragment của tôi chứa giá trị backtick lồng nhau** làm JS string hỏng. Tôi sửa bằng cách dựng bảng bằng mảng dòng có hằng P = pipe, và bỏ mọi dấu nháy đơn khỏi nội dung. Bài học nhỏ nhưng lặp lại: **dữ liệu Markdown không thuộc về chuỗi JS** — hãy để nó ở file riêng ngay từ đầu.
3. **Điều tôi làm ĐÚNG và muốn giữ:** (a) **đọc 2 dòng cuối của cả hai file TRƯỚC khi viết guard**, nên guard so khớp nguyên văn pass ngay lần đầu — đây là hệ quả trực tiếp của bài học Mục 61 và Mục 62, và nó đã **giữ được** hai cycle liên tiếp; (b) **kiểm tra va chạm tên header** trước khi ghi và phát hiện W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE đã có sẵn — nếu không có bước này tôi đã tạo mục trùng lần thứ hai trong cùng một file; (c) **verify EOL bằng source** (976 CRLF / bareLF 0) thay vì tin lời receipt; (d) **không** sửa review.md dù anchor của nó tiếp tục trôi; (e) đọc settlement Turn 344 để đối chiếu danh sách receipt, không phải để săn mục tôi đã bỏ sót như ở Mục 61.
4. **Một điểm tôi cảnh báo trước rồi vẫn phải xử lý:** packet **có** task id thật (task_5e3a91b40c4e) — điều mà ba packet trước đều không có. Tôi **vẫn gửi status** trước khi kiểm, vì settlement Turn 344 lộ ra task_6e2a91b40c3d cho **cycle trước** và tôi **không** dùng nhầm. Nếu task id này có thật trong task list thì gửi worker_done ngay, còn không thì status kèm lý do. **Không bịa id dưới bất kỳ hình thức nào.**
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.64.0 → 1.65.0** đúng một chỗ.

## 64 — CYCLE 64: D-DOCS-EVID-SYNC-342 — `test.failing` lan 3 file; 5 khối trong ingest-scan-fixtures mà receipt KHÔNG nói; một ca CROSS-TENANT pin được chấp nhận

> **RESUME POINT — cycle 64 (packet D-DOCS-EVID-SYNC-342, task `task_6e3a91b40c5f`, dispatch `ctx_6e3a91b40c5f`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–63 giữ nguyên phía trên như lịch sử.
> 1. **4 receipt mới** + 1 mục "already on record". Một receipt (`W-DOC-CORE-INGEST-SOURCE-PIN-NEGATIVE`) **đã có sẵn** trong docs/28 từ Mục 58 ở mức **18 test** — nay lên 28, tôi ghi mục **delta**.
> 2. **Phát hiện chính: `test.failing` đã lan ra 3 file**, và **tệp mới nhất là file mà receipt hoàn toàn không nhắc** — 5 khối trong `ingest-scan-fixtures`, chi tiết ở E6.
> 3. **Một ca CROSS-TENANT được chấp nhận**: pin storage của tenant-b bind vào operation của tenant-a hiện **được chấp nhận**. Đây là ca nghiêm trọng nhất của cycle. E8.
> 4. **`docs/28` giữ version 1.48.0** — bump **1.65.0 → 1.66.0** là version của **docs/35**. **Zero production code edits** như packet yêu cầu.

### 64.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 4 receipt mới: `T-CODEX-OFFLINE-INPUT-CONTRACT-AND-SCAN-FIXTURES-INDEPENDENT` (tester **10326**, task_5d1a8e94c02f, 06:46:53) · `T-CODEX-OFFLINE-SESSION-AND-SOURCE-PIN-INDEPENDENT` (tester **10372**, task_2c1a8e94d03e, 06:55:12) · `W-WORKER-SDK-CONNECTOR-SESSION-NEGATIVE` (tester **10408**, task_9e2b104c8f3a, 06:50:49) · và mục delta cho `W-DOC-CORE-INGEST-SOURCE-PIN-NEGATIVE`. Đối chiếu settlement Turn 346 khớp từng mục |
| E1 | **Một header lặp lại lần thứ NĂM** | `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` xuất hiện ở tester **10362**, **nguyên văn** bản đã ghi (cùng task_6d1f92e30a4b, cùng 06:10:15, cùng 16 test, cùng 3 `test.failing`). Chuỗi đầy đủ đã ghi ở mục "already on record". **Tôi đã báo hiện tượng này ở BA cycle liên tiếp** mà nó vẫn tiếp diễn |
| E2 | **Một điều chỉ tăng dòng mà KHÔNG có receipt mới** | `qwen-admin.md` dài **4987 → 5055**, nhưng **không** có header Mục mới. Đọc vùng mới cho thấy đó là **ledger được chèn lộn thứ tự** ( các dòng 30–38 nằm xen giữa dòng 1–29), không phải việc mới. Tôi **không** ghi mục nào cho nó, và cũng **không** sửa thứ tự ledger của lane khác |
| E3 | **Connector input contract** | 3 lần × 1 suite/**42 test** Exit 0 (**126**). Canonical input aliasing, required-field và type validation, temperature/max-token bounds, artifact count/size/MIME và CRLF defenses, UUID/step/parameter validation, prototype-pollution rejection. tsc 0 |
| E4 | **Ingest scan fixtures — receipt KHÔNG nói gì về expected-failure** | 3 lần × 1 suite/**19 test** Exit 0 (**57**); tsc 0. Receipt ghi "PASS" và liệt kê coverage (PNG/PDF bytes và MIME forwarding, unauthorized/expired reference fencing, zero/truncated/mismatched fixture rejection, connector-bound header limits, MIME spoofing, TIFF/CRC, CRLF) — **không** nhắc `test.failing` dù file có **5** khối. Đây là lần đầu tôi gặp receipt nói "PASS" cho một suite mà phần lớn số xanh là xanh **vì** lỗi |
| E5 | **5 khối trong ingest-scan-fixtures, đọc thẳng từ file** | L220 PDF magic bytes khai là `image/png` trước OCR · L232 ZIP magic bytes khai là `application/pdf` trước OCR · L244 TIFF bị cắt bên trong image file directory header · L254 PNG hỏng terminal chunk CRC · L304 CRLF injection trong tên file fixture trước connector invocation. Tức **5 trong 19** là xanh vì sản phẩm chưa từ chối |
| E6 | **`test.failing` đã ở 3 file** | ingest-scan-tamper **3** · ingest-scan-fixtures **5** · ingest-source-pin **2** = **10 khối**. Hai cycle trước tôi ghi con số này; nay nó **tăng và lan**. Đây không phải chi tiết vụn vặt — nó đổi cách đọc mọi cột "passed" trong đợt này |
| E7 | **Connector session negatives** | Chỉ test, receipt nói rõ **không** sửa production. Optional/missing session ref chuẩn hoá về null; session ref non-string bị schema từ chối và **không tạo step checkpoint**; `nextPollAt` dị dạng dùng default retry delay; delay suy ra không dương được clamp. 3 lần × **44** (**132**); tsc 0 |
| E8 | **CA NGHIÊM TRỌNG NHẤT: cross-tenant pin được chấp nhận** | `ingest-source-pin` L210: *rejects binding an accessible tenant-b storage pin into a tenant-a operation* — tức một storage pin thuộc **tenant khác**, dù nó truy cập được, hiện **được chấp nhận** khi bind vào operation của tenant khác. Khác với L84 (storage key chỉ toàn khoảng trắng — vấn đề **hygiene**), đây là **input phân quyền** |
| E9 | **Vì sao E8 nghiêm trọng hơn L84** | Một key toàn khoảng trắng là rác đầu vào. Một pin của **tenant khác** là một **input phân quyền** — và pin là thứ mang ý nghĩa "tôi được phép đọc artifact này". Chấp nhận pin của tenant-b trong operation của tenant-a là câu hỏi **về ranh giới tenant**, không phải về làm sạch chuỗi |
| E10 | **Một file test đã có EOL hỗn tạp trong cây** | `connector-session.test.ts`: **707 CRLF / 151 bare LF**. Mục 63 ghi lại việc một guard chặn **tạo ra** file hỗn tạp; ở đây một file hỗn tạp **đã tồn tại**. Không phải defect nghiêm trọng (test-only), nhưng bất kỳ ai sửa file này **phải đọc trước**, đừng giả định EOL thống nhất |
| E11 | Tôi đếm từ source | `connector-input-contract` **14 it + 9 it.each + 1 test** = 42 · `ingest-scan-fixtures` **14 it + 5 test.failing** = 19 · `connector-session` **34 it + 5 it.each** = 44 · `ingest-source-pin` **15 it + 1 it.each + 2 test.failing** = 28. Không file nào có `skip` |
| E12 | **Một receipt đã có sẵn cần ghi DELTA** | `W-DOC-CORE-INGEST-SOURCE-PIN-NEGATIVE` đã ở docs/28 L1230 từ Mục 58 với **18 test**. Nay **28**. Settlement ghi **+5 tests mới, 2 expected-failing probes** ⇒ tăng 23 → 28 **không** phải 5 assertion đúng thêm |
| E13 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=206 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E14 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** |
| E15 | Anchor | Chèn ledger-64 làm mọi dòng ≥ L425 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1685` → **`#L1686`**, content-assert L1686 = header Muc 16; `docs/06:75` đi `#L3198` → **`#L3199`**, content-assert L3199 = dong Δ-A42-1 |
### 64.2 Δ

- **Δ-A65-1 (phát hiện chính của cycle — `test.failing` đã ở 3 file, và file mới nhất là file receipt KHÔNG nói):** tổng số khối `test.failing` trong cây lên **10**: `ingest-scan-tamper` **3** · `ingest-scan-fixtures` **5** · `ingest-source-pin` **2**. Điểm đáng chú ý nhất **không phải** con số mà là **sự im lặng**: receipt xác minh độc lập của `ingest-scan-fixtures` liệt kê coverage chi tiết và ghi kết luận **PASS**, mà **không** nhắc 5 khối expected-failure. Với 3 khối ở `ingest-scan-tamper` thì tác giả **có** nói rõ; với 5 khối ở đây thì **không**. Hệ quả trực tiếp: **5 trong 19 "passed" là xanh vì sản phẩm chưa từ chối** những đầu vào đó, và người đọc receipt thuần sẽ không bao giờ biết.
- **Δ-A65-2 (CA NGHIÊM TRỌNG NHẤT CỦA CYCLE — cross-tenant pin được chấp nhận):** `ingest-source-pin` L210 là `test.failing` với nội dung *rejects binding an accessible tenant-b storage pin into a tenant-a operation*. Tức một **storage pin thuộc tenant khác**, dù nó truy cập được, hiện **được chấp nhận** khi bind vào operation của tenant khác. Tôi tách nó khỏi khối còn lại (L84: storage key chỉ toàn khoảng trắng — vấn đề **hygiene**) vì hai thứ này **không cùng loại**: một chuỗi rác là vấn đề làm sạch đầu vào, còn một pin mang nghĩa "được phép đọc artifact này" là **input phân quyền**. Câu hỏi ở đây là **ranh giới tenant**, không phải định dạng chuỗi. Đây cùng họ với các finding artifact-authorization đã ghi ở Mục 60.
- **Δ-A65-3 (bản chép nguyên văn lần thứ NĂM, đã báo ở ba cycle liên tiếp mà vẫn tiếp diễn):** `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` xuất hiện lần nữa ở tester L10362, **nguyên văn** bản đã ghi. Chuỗi: `W-WORKER-SDK-ARTIFACT-STAT-NEGATIVE` (Mục 59) → `TEMP-SWEEP` + `ARTIFACT-MULTIPART` (Mục 62) → `INGEST-SCAN-TAMPER` (Mục 63) và lại nay. **Năm** lần trên **bốn** receipt, luôn giống hệt byte. Tôi đã ghi cảnh báo này ở Mục 62, 63 và nay; nó vẫn chưa được xử lý ở nơi sinh. Tôi nói thẳng: đây là thông tin đã lặp, và **một lane docs không thể sửa nó** — nó thuộc quy trình append của lane khác.
- **Δ-A65-4 (một điều chỉ tăng dòng mà không có receipt — tôi KHÔNG ghi và cũng KHÔNG sửa):** `qwen-admin.md` dài **4987 → 5055** nhưng **không** có Mục mới. Đọc vùng mới cho thấy đó là **ledger chèn lộn thứ tự** — các dòng 30–38 nằm xen giữa dòng 1–29. Tôi **không** tạo mục cho một thứ không phải receipt, và **không** sắp xếp lại ledger của lane khác (không thuộc write scope). Ghi lại để người sau không tưởng lane admin vừa làm việc gì.
- **Δ-A65-5 (bẫy đếm số, lần thứ sáu liên tiếp):** `connector-input-contract` 14 + 9 khối `it.each` + 1 = 42 · `connector-session` 34 + 5 = 44 · `ingest-source-pin` 15 + 1 khối + **2 `test.failing`** = 28 · `ingest-scan-fixtures` 14 + **5 `test.failing`** = 19. Bốn con số **126 / 57 / 132 / 84** là **tổng ba lần chạy**.
- **Δ-A65-6 (một sự trùng hợp đáng ghi, vì nó làm giảm giá trị của "đếm từ source"):** cả `ingest-source-pin` và `ingest-scan-fixtures` đều là **file scan của document-core**, và cả hai đều chứa `test.failing` mà receipt không nói. Ở `ingest-source-pin` thì settlement **có** nói (2 expected-failing probes); ở `ingest-scan-fixtures` thì **không**. Cùng một lớp file, hai mức độ minh bạch khác nhau — đó là lý do tôi ghi "không receipt nào nói" một cách có điều kiện thay vì khẳng định vô điều kiện.
- **Δ-A65-7 (một file hỗn tạp EOL đã tồn tại trong cây):** `connector-session.test.ts` là **707 CRLF / 151 bare LF**. Mục 63 ghi lại việc một guard chặn **tạo ra** loại file này; ở đây thì nó **đã có sẵn**. Không phải defect nghiêm trọng (test-only, không ảnh hưởng kết quả), nhưng tôi ghi lại vì người sửa file này sau này **phải đọc trước** chứ không được giả định EOL thống nhất — cùng nguyên tắc mà tác giả Muc 45 đã tự nêu.
- **Δ-A65-8:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G6` vẫn **NO-GO**; `ADM-UX-02` vẫn `[~]`. Cả 4 receipt đều test-only và **zero production code edits** như packet yêu cầu. Δ69/Δ66/Δ74–Δ79/Δ81–Δ100 còn mở, cộng các finding **chưa** được đánh số trong Mục này (10 khối `test.failing` là tập hợp finding chưa được lane nào đặt tên). Test xanh **KHÔNG** phải tín hiệu GO — và ở cycle này cột "passed" có **10** số xanh thuộc loại xanh-vì-lỗi.
### 64.3 Lỗi của chính tôi

1. **Hai lần lỗi cú pháp nhỏ trong script kiểm tra, cùng một nguyên nhân.** Tôi viết một dòng `for` bỏ dấu hai chấm, rồi lần sau **copy nguyên dòng lỗi** nên lặp lại đúng lỗi đó; và một lần nữa khi dựng danh sách dòng cũng bỏ dấu hai chấm. Không file nào bị chạm, nhưng tôi đã ghi bài học này **hai lần trong các cycle trước** và vẫn lặp. Nguyên nhân gốc là tôi **sửa lỗi cú pháp bằng cách sửa tối thiểu dòng cũ** thay vì viết lại cả dòng. Từ giờ tôi sẽ **không** sao chép dòng vừa lỗi.
2. **Một assert của tôi báo sai vì lẫn 0-based với 1-based.** Tôi dùng `enumerate(L35, 1)` (1-based) nhưng lại **ĐẢO** kết quả trong phép so sánh, nên tôi kỳ vọng section ở L1327 trong khi splice báo L1326. Tôi **không** sửa file; tôi kiểm lại cách đánh số rồi sửa **assert của tôi**. Đây là hướng ngược lại với việc nới check cho khớp, và đó là hướng đúng.
3. **Một needle của tôi đoán sai chữ, lần thứ mười một trong các cycle gần đây.** Tôi viết `five of them` trong khi file ghi `contains **five** of them` (có dấu **). Nội dung **đã đúng**. Lần này tôi không phải chỉnh lại rồi chạy tiếp — tôi **in cả vùng section** để lấy chuỗi thật rồi viết lại assert. Bài học vẫn như cũ và tôi vẫn phạm: **in dòng thật trước khi viết assert**.
4. **Điều tôi làm ĐÚNG và muốn giữ:** (a) **đếm `test.failing` từ file ở cả 4 suite** và phát hiện 5 khối ở `ingest-scan-fixtures` mà receipt **không** nhắc — đây là phát hiện có giá trị nhất của cycle, và nó **chỉ** xuất hiện vì tôi không tin receipt; (b) **đọc mục cũ** của source-pin trước khi viết, xác nhận nó ghi 18 test và không nói gì về `test.failing`, nên viết **delta** chứ không tạo mục trùng; (c) **đọc vùng tăng dòng của qwen-admin** và kết luận đó là ledger chèn lộn thứ tự chứ không phải receipt mới — rồi **không** ghi mục và **không** sửa ledger của lane khác; (d) kiểm tra va chạm header trước khi ghi, không cái nào; (e) đọc 3 dòng cuối **nguyên văn** trước khi viết guard nên guard pass ngay lần đầu; (f) **không** sửa `review.md`.
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.65.0 → 1.66.0** đúng một chỗ.

## 65 — CYCLE 65: D-DOCS-EVID-SYNC-343 — MỘT PHẦN TỬ CHỐNG-VACUITY ĐƯỢC NÓI RA; 4 defect thật trong view model; thêm 1 `test.failing` KHÔNG receipt nào nói

> **RESUME POINT — cycle 65 (packet D-DOCS-EVID-SYNC-343, task `task_7e3a91b40c6a`, dispatch `ctx_7e3a91b40c6a`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–64 giữ nguyên phía trên như lịch sử.
> 1. **6 receipt mới** + 2 mục delta + 1 mục already-on-record. Tất cả đều tests-only, **zero production code edits**.
> 2. **Điểm đáng nhớ nhất của đợt này:** hai receipt độc lập, ở **hai lane khác nhau**, đều viết ra lý do một assertion tồn tại để **chống test xanh vì nhầm lý do**. Chi tiết E3 và E7.
> 3. **Một `test.failing` thứ ba không được receipt nào nói** — nay tổng **11** khối ở 4 file. E6.
> 4. **`docs/28` giữ version 1.48.0** — bump **1.66.0 → 1.67.0** là version của **docs/35**.

### 65.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 6 receipt mới: `T-CODEX-OFFLINE-READ-METADATA-AND-INGEST-WIRE-INDEPENDENT` (tester **10423**, task_7e1a8e94e04f) · `T-CODEX-OFFLINE-STREAM-BOUNDS-AND-READ-STREAM-INDEPENDENT` (tester **10468**, task_8f1a8e94f05a) · `W-DOC-CORE-READ-STREAM-ACQUISITION-NEGATIVE` (tester **10504**, task_9b1b92c40fad) · `W-WORKER-SDK-ARTIFACT-DIRECT-BAND-NEGATIVE` (tester **10515**, task_5a2b104c8f6d) · `W-PLAT-CR28-06-SUBMISSION-METADATA-CRYPTO-NEGATIVE` (qwen-platform Muc 46 L4252) · `W-ADM-UX-09-BUSINESS-VIEW-MODEL-NEGATIVE` (qwen-admin Muc 53 L5035). Đối chiếu settlement Turn 348 |
| E1 | **TÁC PHẨN ĐÁNG CHÚ Ý NHẤT — MỘT PHẦN TỬ CHỐNG-VACUITY, ĐƯỢC NÓI RA** | Muc 46 dùng bộ đếm `wrapCalls()` để chứng minh **seal chạy TRƯỚC transaction**: provider đếm số lần gọi và ném ở lần thứ N; fail ở lần 1 cho `wrapCalls()=1, writes=0`, fail ở lần 2 cho `wrapCalls()=2, writes=0`. Tác giả **giải thích vì sao con số đó mới là phần nặng**: nếu code chỉ wrap **một** lần thì provider fail-ở-2 **không bao giờ nổ** và test sẽ **xanh mà không chứng minh gì**. Đây là câu trả lời trực tiếp cho câu hỏi "test này có thể xanh vì lý do khác không" |
| E2 | **Và assertion đó BẮT TRÚNG chính mutation** | M1 mô phỏng submit chỉ seal **một** cột ⇒ **8 failed, 34 passed** (2 có sẵn + **6 mới**). Trong đó test *"a Vault outage on the second wrap writes nothing"* **đỏ** vì `wrapCalls()` chỉ bằng 1. Tức bộ đếm chống-vacuity **tự bắt được** mutation khiến nó mất ý nghĩa. Đây là bằng chứng mạnh hơn việc chỉ nói test tốt |
| E3 | **Lane admin làm ĐÚNG ĐIỀU TƯƠNG TỰ, Ở file khác** | Muc 53 viết: badge path **KHÔNG ném** (có `default` trả `neutral`), nên suy luận "enum hỏng thì ném TypeError" của lane khác mà áp vào đây sẽ **sai**. Ông viết một **control test riêng** khẳng định đủ 4 state thật đi qua case riêng, để bảng các state hỏng **không thể xanh một cách vô nghĩa**. Đây là lần thứ hai trong cycle này có test chủ động bảo vệ chính nó khỏi xanh-vì-nhầm-lý-do |
| E4 | **Deliverable +35 test (7 → 42), 0 dòng production** | `submission.ts` `e25670af` / 32535 B khớp Mục 26/32; `metadata-crypto.ts` `aa200211` khớp Mục 36/37/44. Test `438744e6` / 29018 B và là **LF** — receipt nói rõ file này **khác** file CRLF của Mục 45 và EOL guard kiểm **từng lần**. Tôi verify: 0 CRLF, 663 bare LF |
| E5 | **Cross-column swapping CẢ HAI CHIỀU** | payload→input **và** input→payload — chiều ngược lại là phần **mới** (Mục 32 chỉ có chiều thuận). Tách thêm ca "đúng slot, **sai refId**" để tách hai chiều ràng buộc; hai cột dưới **tenant khác**; hai cột mang **hai envelope khác nhau**. Kỳ vọng ghi **mã lỗi cụ thể** chứ không phải "có reject" |
| E6 | **`test.failing` thứ BA không được receipt nào nói — tổng 11 khối ở 4 file** | `ingest-wire` L394: *rejects a multipart boundary marker that disagrees with the encoded body boundary*. File là **18 `it()` + 1 `test.failing`** = 19. Receipt liệt kê "malformed multipart payload rejection" trong coverage mà **không** nói rejection cụ thể này chưa có hiệu lực. Tổng: scan-tamper 3 + scan-fixtures 5 + source-pin 2 + **ingest-wire 1** = **11** |
| E7 | **4 DEFECT THẬT trong business view model, ghi nhận KHÔNG sửa** | (1) **status hỏng hiện thành HEALTHY** — `resolveVersionHealth` loại RETIRED/DRAINING/REGISTERED_DISABLED rồi **mặc định phần còn lại là ENABLED**; đo được `ARCHIVED` → `healthy`. Tác giả nói đây là trạng thái **nguy hiểm hơn là báo đỏ**, vì hàng đó trông xanh nhưng không hành động được. (2) Bộ đếm health **không hòa với tổng**: `totalVersions = 1` trong khi tổng bốn bộ đếm bằng `0`. (3) Heartbeat hỏng **bị nuốt im lặng**: rác → `status: none` + `lastHeartbeatAt: null`; `nowMs = NaN` → **cả fleet offline**; ngày lăn `2026-02-30` vẫn trả **đúng chuỗi ngày sai** cho renderer. (4) Xung đột activeVersion giải quyết bằng **thứ tự mảng** — hàng RETIRED thắng hàng ENABLED |
| E8 | **Baseline được ĐO, không được khẳng định** | Muc 53 chạy **bản HEAD** để đo baseline **54 test** → +41. Suite xanh **ngay lần chạy đầu** và **không sửa lại khẳng định nào** — đúng kết quả mà phương pháp probe-trước-khi-assert sinh ra |
| E9 | **Boundary 64 MiB kiểm CẢ HAI phía** | direct-band: đúng 64 MiB − 1, đúng 64 MiB, đúng 64 MiB + 1; size âm và phân số bị từ chối **trước** khi đọc source hay gọi mạng; HTTP **500** và **503** bị từ chối; và digest hỏng **đúng tại** 64 MiB vẫn fail closed |
| E10 | **Lease loss SAU khi chunk đã nằm trong file tạm** | read-stream-acquisition phủ ENOSPC + cleanup một phần, tamper với digest hợp lệ, artifact 0 byte qua đường disk, và lỗi dispose sau cleanup. Ca lease-loss **sau** khi chunk đã ghi là thứ dễ sai nhất vì file đã tồn tại và **trông như tiến độ** |
| E11 | **Một bản chép lần thứ HAI, của receipt KHÁC** | `W-WORKER-SDK-CONNECTOR-SESSION-NEGATIVE` xuất hiện lại ở tester **10459**, nguyên văn bản đã ghi ở Mục 64 (cùng task_9e2b104c8f3a, cùng 06:50:49, cùng 44 test). Vì đây là receipt **khác** với cái bị chép 5 lần, hiện tượng **không bị giới hạn ở một receipt** ⇒ nhiều khả năng là lỗi quy trình chung chứ không phải một lần chạy hỏng. Δ-A66-2 |
| E12 | **Hai suite đã có sẵn nay được xác minh lại ở số cao hơn** | `W-WORKER-SDK-ARTIFACT-READ-METADATA-NEGATIVE` 18 → **27** · `W-WORKER-SDK-ARTIFACT-STREAM-BOUNDS-NEGATIVE` → **35**. Cả hai **không** có `test.failing`. Tôi ghi thành mục delta, không tạo mục trùng |
| E13 | Tôi đếm từ source | `submission-metadata-crypto-e2e` **19 it + 7 it.each** = 42 · `admin-business-view-model` **71 `test()`** = **95 chạy** (chênh do describe lồng nhau) · `read-stream-acquisition` **16** · `artifact-direct-band` **16 + 3** = 20 · `artifact-read-metadata` **16 + 3** = 27 · `ingest-wire` **18 + 1 failing** = 19 · `artifact-stream-bounds` **21 + 3** = 35 |
| E14 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=207 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E15 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** |
| E16 | Anchor | Chèn ledger-65 làm mọi dòng ≥ L426 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1686` → **`#L1687`**, content-assert L1687 = header Muc 16; `docs/06:75` đi `#L3199` → **`#L3200`**, content-assert L3200 = dong Δ-A42-1 |
### 65.2 Δ

- **Δ-A66-1 (điều tôi muốn nhấn mạnh nhất của cycle — hai lane, hai file, cùng một ý tưởng: chủ động bảo vệ test khỏi xanh-vì-nhầm-lý-do):** Muc 46 giải thích rằng bộ đếm `wrapCalls()` **không phải chi tiết trang trí** mà chính là thứ **chặn test chạy rỗng** — nếu code chỉ wrap một lần thì provider fail-ở-2 không bao giờ nổ và test xanh mà **không chứng minh gì**. Muc 53, ở **một lane khác và file khác**, làm đúng điều tương tự theo hướng khác: viết một **control test** khẳng định cả 4 state thật đi qua case riêng, để các dòng "state hỏng" **không thể xanh một cách vô nghĩa** — đồng thời **sửa lại một suy luận sai** được import từ lane khác (badge path không ném, nên "enum hỏng thì ném TypeError" áp vào đây là sai). Và bộ đếm của Muc 46 **tự bắt trúng mutation** khiến nó mất ý nghĩa. Đây là thứ đáng nhân bảo nhất trong đợt receipt này.
- **Δ-A66-2 (bản chép nguyên văn — lần thứ SÁU, và lần đầu nó KHÔNG bị giới hạn ở một receipt):** `W-WORKER-SDK-CONNECTOR-SESSION-NEGATIVE` bị append lại ở tester L10459, **nguyên văn**. Trước đây mọi lần lặp đều thuộc về `W-DOC-CORE-INGEST-SCAN-TAMPER-NEGATIVE` (5 lần, 1 receipt), nên giả thuyết "một lần append hỏng" vẫn còn sống. Nay một receipt **khác** cũng bị chép ⇒ hiện tượng nhiều khả năng là **lỗi quy trình chung**. Tổng: **6** lần chép trên **5** receipt. Tôi đã báo ở Mục 62, 63, 64 và nay; nó vẫn thuộc quy trình append của lane khác và **một lane docs không sửa được**.
- **Δ-A66-3 (`test.failing` lần thứ BA không được receipt nào nói — tổng 11 khối ở 4 file):** `ingest-wire` L394 khẳng định multipart boundary marker lệch với encoded body boundary phải bị từ chối, và hiện **chưa** bị từ chối. Receipt liệt kê "malformed multipart payload rejection" trong coverage nhưng **không** nói rejection cụ thể này chưa có hiệu lực. Ba cycle liên tiếp tôi tìm ra một khối mà receipt im lặng; **mẫu này đang lặp**, và mẫu đáng lo là **im lặng ấy đều đi cùng một loại receipt: xác minh độc lập ghi "PASS" và liệt kê coverage chi tiết**.
- **Δ-A66-4 (4 defect thật, và cái thứ nhất nguy hiểm hơn vẻ ngoài của nó):** status lạ hiện thành **healthy** vì hàm sức khoẻ loại ba trạng thái rồi **mặc định phần còn lại là ENABLED** — một hàng có thể **trông xanh nhưng không hành động được**, mà tác giả nói đó là trạng thái **nguy hiểm hơn báo đỏ**. Cùng receipt còn ghi bộ đếm không hòa với tổng (`totalVersions = 1` trong khi tổng bốn bộ đếm bằng 0), heartbeat hỏng bị nuốt im lặng thành `none` + null (làm hỏng trở nên **vô hình**), `nowMs = NaN` khiến **cả fleet** bị báo offline, ngày lăn `2026-02-30` vẫn được trả **nguyên văn** cho renderer, và xung đột activeVersion được giải bằng **thứ tự mảng** nên hàng RETIRED thắng hàng ENABLED. Tất cả **ghi nhận, không sửa** vì ngoài phạm vi.
- **Δ-A66-5 (một sai lầm tự sửa đáng ghi — trùng đúng bài học đã có trong bộ nhớ của tôi):** tác giả Muc 46 **đưa `plaintextSha256` vào bảng "phải bị từ chối"** và nó **đỏ** — cả thay digest lẫn đặt null đều **mở được**. Đó là hành vi thật chứ không phải lỗi harness, nên ông viết lại thành 4 test khẳng định nó **mở được** và tách thành Δ102. Ông tự nói đây là **lần thứ hai trong ba cycle liên tiếp**: **đừng giả định một trường tên nghe như checksum thì được kiểm**. Đây chính là bài học "test đỏ vì lý do khác không chứng minh gì" — ở dạng ngược lại: **test đỏ vì lý do đúng, nhưng kỳ vọng của tôi sai**.
- **Δ-A66-6 (Δ101 — bất đối xứng GIỮA ĐƯỜNG GHI VÀ ĐƯỜNG ĐỌC, đáng chú ý nhất của Muc 46):** `seal` **không** kiểm tra hình dạng wrapped DEK mà provider trả về, trong khi `validateWrappedResult` **có tồn tại** ở đường đọc — chỉ là không được gọi khi ghi. Hệ quả: một provider lệch chuẩn làm submit **thành công** và ghi một envelope **vĩnh viễn không mở được**, phát hiện được **chỉ khi đọc**. Rủi ro thật là **hỏng vĩnh viễn các row đã ghi**. Sửa: gọi validator ngay trong `seal`.
- **Δ-A66-7 (Δ102 — một trường tên nghe như kiểm tra nhưng không phải):** `plaintextSha256` **không** được kiểm khi đọc lại — đổi thành 64 số 0, đặt null, xoá hẳn, hay thay bằng chuỗi không hex, **cả bốn** đều mở envelope thành công. Nó là **tiện ích cho caller**, còn integrity thật đến từ GCM tag. Nhưng suite Mục 32 **có** assert digest khớp với hash của input, trông như đang bị cưỡng chế — và nó không. Hậu quả: consumer nào tin trường này là kiểm tra sẽ **so một giá trị lưu trữ với chính nó**.
- **Δ-A66-8 (Δ103 — ghi lại để đừng sửa nhầm về sau):** `keyRef` trong envelope **không** được kiểm khi đọc; thay nó bằng giá trị tuỳ ý vẫn **không rò plaintext** (đã có test), vì danh tính khoá nằm trong `dek` chứ `open()` không bao giờ đọc trường đó. Tác giả nói điều này **an toàn** nhưng **ghi rõ** để một đợt "siết cứng" sau này không vô tình bắt buộc khớp `keyRef` và làm hỏng các row đang tồn tại. Cùng tinh thần với Δ95 ở Mục 63.
- **Δ-A66-9 (bẫy đếm số, lần thứ bảy liên tiếp):** `admin-business-view-model` khai báo **71** `test()` nhưng chạy **95** — chênh do `describe` lồng nhau; đây là file duy nhất trong đợt này có kiểu chênh đó. Năm file còn lại đều chênh vì `it.each`, riêng `ingest-wire` chênh vì `test.failing`. Bốn con số **81 / 57 / 105 / 48** là **tổng ba lần chạy**.
- **Δ-A66-10:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-02` và `ADM-UX-09` vẫn `[~]`. Cả 6 receipt đều test-only và **zero production code edits** như packet yêu cầu. Δ69/Δ66/Δ74–Δ79/Δ81–Δ103 còn mở, cộng **11 khối `test.failing`** chưa được lane nào đặt tên. Test xanh **KHÔNG** phải tín hiệu GO — cột "passed" của đợt này có 11 số xanh thuộc loại xanh-vì-lỗi.
### 65.3 Lỗi của chính tôi

1. **Bốn lần cùng một lỗi cú pháp trong MỘT cycle.** Tôi bỏ dấu hai chấm ở cuối một dòng `for` bốn lần, và ở **một** lần tôi **copy nguyên dòng lỗi** nên lặp lại đúng lỗi cũ. Tôi đã viết trong receipt Mục 63 và Mục 64 rằng nguyên nhân gốc là sửa lỗi cú pháp bằng cách **sửa tối thiểu dòng cũ** thay vì viết lại cả dòng — rồi lặp lại **đúng lỗi đó** ngay cycle sau, và bốn lần trong cycle này. Đây là bằng chứng rằng **viết bài học không phải là thay đổi hành vi**; tôi cần thay đổi cách dựng dòng `for`, không chỉ lời nhắc.
2. **Một assert của tôi bắt được một KHOẢNG TRỐNG THẬT trong bài của chính mình.** Tôi kỳ vọng có dòng "Counted from source" cho mục submission-metadata — mọi mục khác trong docs/28 đều có. Tôi in vùng mới ra kiểm và **thấy nó thật sự không có**, vì tôi viết con số ở dạng văn xuôi trong dòng deliverable thay vì để thành dòng đếm riêng. Tôi **bổ sung** thay vì bỏ needle — hướng ngược lại với việc nới check cho khớp. Đây là lần thứ hai trong hai cycle liên tiếp assert bắt được khoảng trống thật thay vì lỗi needle.
3. **Một needle nữa tôi đoán sai** (lần thứ mười hai): tôi kỳ vọng chuỗi có `test()` trong khi file ghi `test()` kèm dấu in đậm. Nội dung **đã đúng**. Lần này tôi in cả vùng để lấy chuỗi thật trước khi viết lại assert — vẫn là cùng bài học cũ, và tôi vẫn phạm.
4. **Điều tôi làm ĐÚNG:** (a) **verify EOL của file LF** (0 CRLF / 663 bare LF) thay vì tin lời receipt, và ghi rõ file này **khác** file CRLF của Mục 45; (b) **đếm `test.failing` ở cả 7 file** và tìm ra khối thứ ba không được receipt nói; (c) **kiểm tra va chạm header** trước khi ghi — 6 header mới đều trống, và 2 mục delta dùng header riêng thay vì đụng bản ghi cũ; (d) đọc **3 dòng cuối nguyên văn** trước khi viết guard nên guard pass ngay lần đầu; (e) **không** sửa `review.md`; (f) ghi nhận 4 defect của lane admin mà **không** sửa và **không** tự ý nâng lên thành gate.

## 66 — CYCLE 66: D-DOCS-EVID-SYNC-344 — MỘT RECEIPT LẦN ĐẦU NÓI THẲNG expected-failing của nó; MỘT LANE TỪ CHỐI BỊA khái niệm packet yêu cầu; MỘT MODULE, BA KIỂU DEGRADE

> **RESUME POINT — cycle 66 (packet D-DOCS-EVID-SYNC-344, task `task_8e3a91b40c7b`, dispatch `ctx_8e3a91b40c7b`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–65 giữ nguyên phía trên như lịch sử.
> 1. **6 receipt mới** + 1 mục already-on-record. Tất cả tests-only, **zero production code edits**.
> 2. **Điểm đáng chú ý nhất của cycle: một receipt LẦN ĐẦU tiên NÓ THẲNG khối expected-failing của chính nó** — ở thân receipt, ở từng dòng kết quả chạy, và ở kết luận. Sau ba cycle liên tiếp tôi tìm ra khối `test.failing` mà receipt im lặng, nay có bằng chứng rằng việc nói ra **hoàn toàn làm được**. Chi tiết E4.
> 3. **Một lane TỪ CHỐI bịa khái niệm mà packet yêu cầu** — packet đòi corrupt *throughput*, module **không có** throughput. E6.
> 4. **`docs/28` giữ version 1.48.0** — bump **1.67.0 → 1.68.0** là version của **docs/35**.

### 66.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 6 receipt mới: `T-CODEX-OFFLINE-DIRECT-BAND-AND-BOUNDED-INPUT-INDEPENDENT` (tester **10526**, task_9f1a8e94f06b) · `W-DOC-CORE-MANIFEST-NEGATIVE` (tester **10573**, task_2a1b92c40ecf) · `T-CODEX-OFFLINE-STREAMS-AND-MANIFEST-INDEPENDENT` (tester **10584**, task_1d1a8e94f08e) · `W-WORKER-SDK-ARTIFACT-STREAMS-NEGATIVE` (tester **10620**, task_6a2b104c8f7e) · `T-CODEX-OFFLINE-STAT-AND-OVERVIEW-VIEW-MODEL-INDEPENDENT` (tester **10620**) · `W-ADM-UX-11-OVERVIEW-VIEW-MODEL-NEGATIVE` (qwen-admin Muc 55 L5163, task_7c91a4038e6c) |
| E1 | **tester.md trôi NGAY TRONG LÚC TÔI ĐỌC** | Census ghi **10525** dòng, lúc đọc thật đã **10630**, và lần đọc atomik thứ hai lại ra con số khác nữa. Tôi **không** dùng con số census cho bất kỳ claim nào; mọi vị trí đều lấy từ **lần đọc nguyên tử** ngay trước khi ghi. Đây là lần thứ tư trong các cycle gần đây tôi bắt được hiện tượng này |
| E2 | **Một cái tên file KHÔNG DUY NHẤT** | Cây này có **BA** file tên `manifest.test.ts`: một ở `businesses/document-core`, một ở `packages/contracts`, một ở `businesses/example-review`. Chỉ cái document-core là receipt này. Grep theo tên sẽ ra **sai file**; tôi **duyệt cây và đọc cả ba** thay vì lấy hit đầu tiên. Cái contracts có **20 `it()`**, cái example-review có 4 — nếu tôi lấy nhầm thì mọi con số trong mục này sẽ sai |
| E3 | **Manifest negatives** | Chỉ test, không sửa production. JSON dị dạng bị từ chối; contract và runtime wire version không hỗ trợ bị từ chối; thiếu section bắt buộc bị từ chối; **sửa `imageDigest` hoặc đổi action artifact policy làm ĐỔI canonical manifest digest**. 3 lần × 1 suite/**10 test** Exit 0 (**30**); tsc 0 |
| E4 | **RECEIPT NÀY NÓ THẲNG expected-failing CỦA CHÍNH NÓ** | Từng dòng kết quả ghi *"including the expected-failing upper-bound case"*, và dòng kết luận ghi rõ *the missing `maxFiles` upper bound remains documented by an expected-failing test*. Đếm từ source: **9 `it()` + 1 `test.failing`** = 10, khối ở **L98** là *rejects an excessive maxFiles artifact count rather than accepting an unbounded policy*. **Đây là bằng chứng rằng việc nói ra làm được** — và làm cho im lặng ở ba cycle trước trở thành **khoảng trống của các receipt đó**, không phải giới hạn của định dạng |
| E5 | **Một lane TỪ CHỐI bịa khái niệm packet yêu cầu** | Muc 55: packet đòi corrupt *throughput* metrics; tác giả **đếm export** của `overview-view-models.ts` — đúng **10 hàm**, **không hàm nào tính rate hay throughput**; usage chỉ là **bộ đếm thô**. Ông **ghi ra điều đó** thay vì bịa một khái niệm throughput cho khớp packet, rồi test kỹ các ca counter hỏng (NaN, âm, vô cùng, cost âm). Đây là lần thứ hai trong hai cycle một lane từ chối bịa thứ packet đặt tên |
| E6 | **MỘT MODULE, BA KIỂU DEGRADE khác nhau cho CÙNG một enum hỏng** | `usageMeasurementBadge`/`Label` tra bảng không chốt chặn ⇒ **NÉM TypeError** · `auditKindLabel`/`auditKindSeverity` tương tự ⇒ **NÉM TypeError** · `auditSeverityBadge` là `switch` **KHÔNG có default** ⇒ **TRẢ undefined im lặng** · `buildHealthOverviewView` ternary nhị phân ⇒ báo **degraded** (chiều an toàn) |
| E7 | **Hàng thứ BA là hàng cần giữ** | Kiểu trả về khai là union **4 thành viên không chứa `undefined`** ⇒ TypeScript **không** bắt được; một `switch` phủ hết 4 thành viên được coi là exhaustive, và ở runtime rơi **không về đâu cả**. Tác giả ghi rõ đây là lý do **không được suy luận từ lane trước** — cùng một module, ba hành vi hoàn toàn khác nhau |
| E8 | **Control lặp lại lần thứ BA trong ba file khác nhau** | Tác giả gắn **control** cho hai hàng ném lỗi để các dòng đó **không thể xanh một cách vô nghĩa**. Đây là cùng kỷ luật chống test-xanh-vì-nhầm-lý-do mà tôi ghi ở Mục 65, nay xuất hiện ở **file thứ ba** |
| E9 | **5 DEFECT, nghiêm trọng nhất là HẠ CẤP THẦM LẶNG** | `buildAuditEventView` **không đọc** `row.severity` mà suy từ `kind`; đo được hàng `kind: operation.cancel` + `severity: error` ⇒ view ra `warning`, và giá trị gốc **biến mất khỏi view**. Ngoài ra: (2) tenant scoping sụp thành no-op khi **cả hai vế đều thiếu** vì `undefined === undefined` là **true** — lập luận trong docstring đúng với giá trị có mặt và **sai** với giá trị vắng, và so sánh còn phân biệt hoa/thường; (3) `totals` mang theo **by reference** không copy, và **không** đối chiếu với tổng các hàng (hàng cộng ra 7 còn totals khai 0); (4) cửa sổ thời gian **không parse, không sắp xếp** — cửa sổ đảo ngược, rác, rỗng, dài 0, trộn epoch millis với ISO, ngày lăn `2026-02-30` đều tới nguyên vẹn renderer; (5) `fullyHealthy` **không bảo đảm là boolean** vì là chuỗi `&&`: `db: false` ra `dbBadge: success` — chuỗi "false" báo khoẻ |
| E10 | **Một tự sửa, đáng giữ** | Ba test của tác giả fail vì **giả định sai default** của helper có sẵn: `baseAuditRow` mặc định khác tenant, nên mọi event bị filter bỏ và ông đọc phần tử đầu của mảng rỗng. Ông xác định đây là **lỗi của mình chứ không phải bug sản phẩm**, sửa bằng cách truyền tường minh, và **ghi chú lý do ngay trong test** để người sau không vấp lại |
| E11 | **Artifact streams negatives** | Abort giữa chừng dọn phần output dở; đích ghi thư mục không hợp lệ **fail closed mà KHÔNG xoá thư mục**; framing đúng 1024 byte qua các chunk **1 / 1022 / 1** byte thành công; socket reset giữa body trả `TRANSPORT_FAI…` có kiểu chứ không phải lỗi không xử lý. 3 lần × **53**; tsc 0 |
| E12 | Tôi đếm từ source | `bounded-input` **41 `test()`** · `artifact-streams` **39 it + 2 it.each** = 53 · `manifest` (document-core) **9 it + 1 failing** = 10 · `admin-overview-view-model` **71 `test()`** = **108 chạy** · `artifact-direct-band` **16 + 3** = 20. Không file nào có `skip` |
| E13 | **Hai file đã có EOL hỗn tạp** | `bounded-input` **470 CRLF / 148 bare LF** · `artifact-streams` **591 / 400**. Cả hai đều test-only nên không phải defect nghiêm trọng, nhưng người sửa **phải đọc trước**. Đây là file hỗn tạp thứ 3 tôi ghi nhận (sau `connector-session` ở Mục 64) |
| E14 | **Một bản chép nguyên văn thứ BẢY** | `W-WORKER-SDK-ARTIFACT-DIRECT-BAND-NEGATIVE` bị append lại ở tester **10562**, nguyên văn bản đã ghi ở Mục 65 (cùng task_5a2b104c8f6d, cùng 07:20:18, cùng 20 test). Tổng: **7** lần chép trên **6** receipt. E15 |
| E15 | **Bản chép đã LAN ra nhiều receipt** | Trước đây 5 lần chép tụ lại ở **một** receipt (scan-tamper). Nay đã có receipt thứ sáu. Giả thuyết "một lần append hỏng" **yếu hẳn**; đây nhiều khả năng là lỗi quy trình chung. Δ-A67-2 |
| E16 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=208 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E17 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** |
| E18 | Anchor | Chèn ledger-66 làm mọi dòng ≥ L427 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1687` → **`#L1688`**, content-assert L1688 = header Muc 16; `docs/06:75` đi `#L3200` → **`#L3201`**, content-assert L3201 = dong Δ-A42-1 |
### 66.2 Δ

- **Δ-A67-1 (phát hiện có giá trị nhất của cycle, và nó là ĐỘNG TÍCH CỰC so với ba cycle trước):** `W-DOC-CORE-MANIFEST-NEGATIVE` **nói thẳng** khối `test.failing` của nó — trong **từng dòng kết quả chạy** (*including the expected-failing upper-bound case*) và trong **dòng kết luận** (*the missing `maxFiles` upper bound remains documented by an expected-failing test*). Từ source: khối ở **L98** khẳng định một số lượng artifact cực lớn phải bị từ chối thay vì chấp nhận chính sách không giới hạn. Ba cycle liên tiếp trước, mỗi cycle tôi đều tìm ra một khối `test.failing` mà receipt **im lặng**. Nay có bằng chứng rằng việc nói ra **hoàn toàn làm được** trong cùng một định dạng, cùng một loại receipt ⇒ im lặng ở các receipt kia là **khoảng trống của chính các receipt đó**, không phải giới hạn kỹ thuật. Tôi ghi vào docs/28 như một **đối chiếu**, không phải như một finding.
- **Δ-A67-2 (bản chép nguyên văn thứ BẢY, và lần đầu nó LAN sang receipt thứ sáu):** `W-WORKER-SDK-ARTIFACT-DIRECT-BAND-NEGATIVE` bị append lại ở tester L10562, **nguyên văn** bản đã ghi ở Mục 65. Trước đây 5 lần chép tụ lại ở **một** receipt duy nhất (scan-tamper), nên giả thuyết "một lần append hỏng" còn sống được. Nay receipt thứ sáu cũng dính ⇒ **nhiều khả năng là lỗi quy trình chung**. Tổng **7** lần trên **6** receipt. Tôi đã báo ở Mục 62, 63, 64, 65 và nay; nó vẫn thuộc lane khác và **một lane docs không sửa được**.
- **Δ-A67-3 (một module, BA kiểu degrade — hàng thứ ba là cái đáng nhớ nhất vì TypeScript KHÔNG bắt được):** cùng một module, cùng một enum hỏng, **ba hành vi hoàn toàn khác nhau**: hai hàm tra bảng không chốt chặn nên **ném TypeError**; một hàm dùng `switch` **không có default** nên **trả undefined im lặng**; một hàm dùng ternary nên báo **degraded** (chiều an toàn). Hàng thứ ba nguy hiểm ở chỗ kiểu trả về được khai là union **4 thành viên không chứa `undefined`** ⇒ trình biên dịch **không thể** bắt, một `switch` phủ hết 4 thành viên bị coi là exhaustive, và ở runtime nó rơi **không về đâu cả**. Tác giả ghi rõ đây chính là lý do **không được suy luận hành vi từ lane trước** — cùng file, khác hành vi.
- **Δ-A67-4 (kỷ luật chống test-xanh-vì-nhầm-lý-do xuất hiện lần thứ BA, ở file thứ ba):** Muc 45 giải thích vì sao bộ đếm là chống-vacuity; Muc 53 viết control test; nay Muc 55 gắn **control** cho hai hàng ném lỗi để các dòng đó **không thể xanh vô nghĩa**. Ba file khác nhau, ba hình thức khác nhau, cùng một nguyên tắc. Tôi ghi nhận đây là **kỷ luật đã hình thành** trong đợt receipt này chứ không còn là thói quen cá nhân.
- **Δ-A67-5 (một packet yêu cầu thứ không tồn tại, và lane từ chối bịa):** packet của Muc 55 đòi corrupt **throughput** metrics; module có đúng 10 export và **không hàm nào tính rate hay throughput** — usage chỉ project dưới dạng bộ đếm thô. Tác giả **đếm export rồi ghi ra điều đó** thay vì bịa khái niệm cho khớp packet, rồi test kỹ các ca counter hỏng thật sự tồn tại. Đây là lần thứ hai trong hai cycle một lane từ chối bịa thứ packet đặt tên.
- **Δ-A67-6 (hạ cấp thầm lặng, và tenant scoping sụp thành no-op):** `buildAuditEventView` **không đọc** `row.severity` mà suy từ `kind`, nên hàng khai `severity: error` ra `warning` và **giá trị gốc biến mất khỏi view** — đây là hạ cấp trong im lặng, không phải chỉ là hiển thị sai. Cùng receipt: tenant scoping dùng so sánh `===` nên khi **cả hai vế đều vắng** thì phép so sánh là **đúng** và một view không có tenant sẽ giữ **mọi** event không có tenant; lập luận trong docstring đúng với giá trị có mặt và **sai** với giá trị vắng. Ngoài ra `totals` mang theo **by reference**, cửa sổ thời gian **không parse không sắp xếp**, và `fullyHealthy` **không bảo đảm là boolean** nên chuỗi `"false"` ra badge khoẻ.
- **Δ-A67-7 (một tên file KHÔNG DUY NHẤT — bẫy đoán sai file):** cây này có **BA** file `manifest.test.ts` (document-core, contracts, example-review) và chỉ cái document-core là receipt này. Cái contracts có **20 `it()`**, example-review có **4** — nếu tôi lấy hit grep đầu tiên thì **mọi con số** trong mục đó sẽ sai mà vẫn trông hợp lý. Tôi ghi cảnh báo này vào docs/28. Δ-A67-3.
- **Δ-A67-8 (bẫy đếm số, lần thứ tám liên tiếp):** `admin-overview-view-model` khai báo **71** `test()` nhưng chạy **108** — chênh do một vòng lặp trên toàn bộ danh sách kind ở **L550**. `bounded-input` 41 = 41; `artifact-streams` 39 + 2 = 53; `manifest` 9 + 1 failing = 10; `artifact-direct-band` 16 + 3 = 20. Năm con số **60 / 123 / 159 / 30 / 324** là **tổng ba lần chạy**.
- **Δ-A67-9 (ba file EOL hỗn tạp đã tồn tại trong cây):** `bounded-input` **470 CRLF / 148 bare LF** · `artifact-streams` **591 / 400** · và `connector-session` ở Mục 64. Cả ba đều test-only nên không phải defect nghiêm trọng, nhưng tôi ghi lại vì người sửa chúng **phải đọc file trước** chứ không được giả định EOL thống nhất — cùng nguyên tắc mà tác giả Muc 45 đã tự nêu khi guard chặn họ tạo ra một file hỗn tạp.
- **Δ-A67-10:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-11` vẫn `[~]`. Cả 6 receipt đều test-only và **zero production code edits**. Δ69/Δ66/Δ74–Δ79/Δ81–Δ103 còn mở, cộng **12 khối `test.failing`** ở 5 file. Test xanh **KHÔNG** phải tín hiệu GO.
### 66.3 Lỗi của chính tôi

1. **Hai lần công cụ dựng fragment hỏng trước khi chạm file.** Lần đầu tôi viết một đoạn có **dấu backtick** trong chuỗi JS, làm parser hỏng; lần sau tôi quên `import re` trong một script. Cả hai không ảnh hưởng file nào. Điều đáng nói là chúng xảy ra **sau** khi tôi đã kết luận ở Mục 65 rằng kỷ luật đúng là viết fragment ra file riêng — và tôi **có** làm đúng ở 5/6 fragment, chỉ hỏng ở cái thứ tư vì tôi gộp nhiều dòng Markdown vào một lệnh JS. Quy tắc thực dụng tôi rút ra: **một fragment = một lệnh `write_file`**, không gộp.
2. **Một lần tôi suýt ghi sai nội dung vì bỏ dấu tiếng Việt.** Khi parser hỏng trên fragment cuối, tôi viết một phiên bản **ASCII không dấu** thay vì sửa lỗi parser. File tạm đó đúng về nghĩa nhưng **mất dấu**, và tôi phải viết lại toàn bộ. Đây là dạng lỗi mà tôi **không** nên chấp nhận ở bất kỳ đâu: hạ chất lượng nội dung để tránh lỗi công cụ là đánh đổi sai, vì dấu tiếng Việt trong receipt **là** nội dung, không phải trang trí.
3. **Một tên file phải tra ra ba kết quả khác nhau.** Ban đầu tôi đếm `manifest.test.ts` và nhận `20 it()` — nhưng receipt nói **10**. Tôi không hề ghi con số 20 vào docs; tôi **duyệt cây, tìm thấy BA file cùng tên**, và chỉ khi đó mới xác định đúng file. Nếu tôi đi thẳng vào viết, mục đó sẽ có số sai mà **trông rất hợp lý**. Đây là cùng lớp lỗi với việc đoán chuỗi: **đừng tin kết quả đầu tiên của một cách tìm**.
4. **Điều tôi làm ĐÚNG:** (a) **đọc lại `tester.md` bằng lần đọc nguyên tử** vì census đã lệch 10525 → 10630 ngay trong lúc làm việc — lần thứ tư gặp hiện tượng này; (b) **duyệt cây tìm mọi file trùng tên** thay vì lấy hit grep đầu tiên; (c) **đếm `test.failing` ở mọi file** và lần này ghi nhận cả khối **được receipt nói ra** lẫn các khối bị im lặng trước đó, để hồ sơ phản ánh đúng thực trạng minh bạch chứ không dồn lỗi về một phía; (d) **verify số đếm declared ≠ executed** bằng cách tìm vòng lặp thật ở L550 thay vì giả định; (e) kiểm tra va chạm header trước khi ghi — 7 header mới đều trống; (f) đọc **3 dòng cuối nguyên văn** trước khi viết guard nên guard pass ngay lần đầu; (g) **không** sửa `review.md`; (h) ghi 5 defect của lane admin mà **không** sửa và **không** tự ý nâng lên thành gate.
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.67.0 → 1.68.0** đúng một chỗ.

## 67 — CYCLE 67: D-DOCS-EVID-SYNC-345 — HAI test leak CÓ SẴN xanh vì lý do YẾU hơn vẻ ngoài; một giới hạn được nói thay vì dựng test giả; và đợt đầu TIÊN không có `test.failing` nào

> **RESUME POINT — cycle 67 (packet D-DOCS-EVID-SYNC-345, task `task_9e3a91b40c7c`, dispatch `ctx_9e3a91b40c7c`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–66 giữ nguyên phía trên như lịch sử.
> 1. **5 receipt mới**, tất cả tests-only, **zero production code edits**.
> 2. **Điểm đáng nhớ nhất của cycle:** tác giả Muc 47 áp quy tắc "assertion chỉ đáng giá bằng đúng những gì nó chứng minh" vào **hai test leak ĐÃ CÓ SẴN trong suite**, rồi chứng minh cả hai xanh vì lý do **yếu hơn** vẻ ngoài. Chi tiết E4.
> 3. **Một giới hạn được nói thẳng thay vì dựng test mang tên đẹp:** packet yêu cầu CSRF **timing**, mà unit test offline **không chứng minh được** thuộc tính constant-time. E5.
> 4. **Đợt đầu tiên sau ba cycle liên tiếp KHÔNG có `test.failing` nào** ở bất kỳ file nào, và **không có bản chép nguyên văn nào**. E6, E7.
> 5. **`docs/28` giữ version 1.48.0** — bump **1.68.0 → 1.69.0** là version của **docs/35**.

### 67.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 5 receipt mới: `T-CODEX-OFFLINE-SWEEP-GUARD-AND-API-KEY-VIEW-MODEL-INDEPENDENT` (tester **10668**, task_7e1a8e94f0a0) · `W-WORKER-SDK-ARTIFACT-SWEEP-GUARD-NEGATIVE` (tester **10702**, task_8a2b104c8f9a) · `T-CODEX-OFFLINE-PARSER-BUDGETS-AND-CRYPTO-CONFIG-INDEPENDENT` (tester **10713**, task_1f1a8e94f0b1) · `W-DOC-CORE-PARSER-BUDGETS-NEGATIVE` (tester **10749**) · `W-DOC-CORE-CHECKPOINT-REPLAY-NEGATIVE` (tester **10762**) · `W-PLAT-CR28-07-ADMIN-CRYPTO-CONFIG-NEGATIVE` (qwen-platform Muc 47 L4356, task_5d8e2194b39d) |
| E1 | **KHÔNG có bản chép nguyên văn nào trong đợt này** | Sau 7 lần chép liên tiếp ở Mục 62–66 (trên 6 receipt), đợt này **không** có header lặp nào. Tôi vẫn kiểm tra và ghi kết quả này vào receipt: một sự vắng mặt đáng chú ý **cũng là dữ liệu**, và nếu không nói thì người đọc có thể tưởng hiện tượng đã dừng vĩnh viễn. Δ-A68-1 |
| E2 | **Deliverable +59 test (24 → 83), 0 dòng production** | `admin-crypto-config.test.ts` `fa88ed10` / 39994 B / LF. Hai file production bị chạm tạm cho M1 đều khôi phục **byte-identical**: `crypto-config-api.ts` `94c71214`, `crypto-config-view-models.ts` `707f742a`; `server.ts` `22afb2ff` **không bao giờ** bị chạm. 83/83 ×3 có dòng `PASS` thật; `tsc` Exit 0 **log 0 byte** trước và sau |
| E3 | **HAI mutation, và M1b kèm MỘT CHI TIẾT GÁN NGUYÊN NHÂN** | **M1a** nới `fingerprintPreview` 12 → 32 ký tự ⇒ **6 failed, 77 passed** (2 có sẵn + **4 mới**): biên 12/13, ca `md5:` không prefix, và test FINDING 12 ký tự đầu. Tác giả nói đây là một thay đổi **rò nhiều hơn** và bị bắt ngay. **M1b** nới regex `assertTenantId` ⇒ **12 failed, 71 passed**, và **cả 12 đều là test mới** |
| E4 | **HAI TEST LEAK CÓ SẴN XANH VÌ LÝ DO YẾU HƠN — ĐÂY LÀ ĐIỂM TÔI SẼ CHỈ NGƯỜI ĐỌC TRƯỚC** | (1) Test *"the view model and the audit rows carry no key material"* cấm sentinel trong `JSON.stringify(view)` — nhưng sentinel bị cấm vào **`publicKeyPem`**, **không** phải `fingerprint`; nó xanh **ngay cả khi** trường `fingerprint` mang đúng sentinel đó. (2) Test *"a fingerprint carrying a secret shows only its preview"* cấm sentinel **đã** nằm trong fingerprint — nhưng chỉ khẳng định **toàn bộ chuỗi** vắng mặt; đo thực tế **12 ký tự đầu CÓ MẶT** |
| E5 | **Tác giả giữ cả hai test và bổ sung test đo ĐÚNG** | Ông **không** xoá test cũ, mà thêm test đo **chính xác ký tự nào tới được đầu ra**, kèm **positive control** đặt sentinel vào đúng trường đang được kiểm. Và ông nói thẳng đây là dạng **"test pass vì lý do sai" mà bài học cảnh báo: nó không bao giờ cảnh báo** |
| E6 | **MỘT GIỚI HẠN ĐƯỢC NÓI THAY VÌ BỊA TEST** | Packet yêu cầu **CSRF timing boundaries**. Tác giả ghi thẳng: **một unit test offline KHÔNG chứng minh được** thuộc tính constant-time, và viết một test giả mang tên "timing" sẽ **không trung thực**. Ông ghim phần **quan sát được**: ranh giới quyết định (64 là độ dài hợp lệ duy nhất; 63/65/128/129 đều 403) và việc so độ dài buffer diễn ra **trước** so sánh thời gian hằng. Muốn đóng điểm timing thật cần **live sentinel** ở tầng route — việc của **Tester lane với cửa sổ thật** |
| E7 | **ĐỢT ĐẦU TIÊN KHÔNG CÓ `test.failing` NÀO** | Tôi đếm ở **cả 5 file**: `artifact-sweep-guard` 9 it · `admin-api-key-view-model` 49 test · `parser-budgets` 28 test · `admin-crypto-config` 50 it + 5 it.each · `checkpoint-replay` 10 test ⇒ **`test.failing` = 0 ở cả năm**. Sau ba cycle liên tiếp mỗi cycle tôi tìm ra ít nhất một khối, nay **bằng không**. Tôi ghi rõ vì đây là **kết quả đo**, không phải suy luận |
| E8 | **4 tự sửa, TẤT CẢ đều tự lộ khi chạy** | (1) **Positive control dùng sai dụng cụ**: khẳng định ký tự NUL thô có trong `JSON.stringify(view)`, nhưng `JSON.stringify` **escape** control char thành chuỗi escape ⇒ test đỏ **VÌ LÝ DO SAI**; đã sửa sang kiểm trên **giá trị thô**. (2) Khẳng định ngược lại hành vi thật: đoán hai lỗi 403 của viewer sẽ **khác wording**, thực tế check viewer chạy **trước** CSRF nên hai message **giống nhau** — hành vi đó **tốt hơn** (không tiết lộ trạng thái CSRF), ông đảo assertion. (3) Sai số đếm 1 ký tự, đã sửa và **thêm assertion** để con số được ghim **bằng máy chứ không bằng mắt**. (4) Escape dấu nháy làm hỏng string literal, sửa bằng cách dựng chuỗi từ mã ký tự — **chính** hai ký tự mà hàm escape đó xử lý |
| E9 | **4 finding mới Δ104–Δ107, không cái nào được đóng** | **Δ104** — cổng CSRF **bị bỏ qua khi `cookieRole === undefined`**, kể cả với principal `tenant_operator`: hàm kiểm tra *tín hiệu ngẫu nhiên* (có cookie claim đã xác minh hay không) thay vì **loại credential**. Tác giả nói rõ **không khai thác được hôm nay** vì principal vẫn phải tới từ header `Authorization` mà trang chéo không gửi được; rủi ro là **có điều kiện** — nếu server từng nhận principal từ nguồn khác, cổng sẽ **biến mất âm thầm** |
| E10 | **Các finding còn lại** | **Δ105** — preview render **12 ký tự đầu của bất cứ thứ gì** nằm trong trường `fingerprint`, và view model mang **fingerprint ĐẦY ĐỦ**; quy tắc "a preview that has nothing to leak" chỉ đúng **khi trường đó thật sự chứa fingerprint** — đó là thuộc tính của **dữ liệu**, không phải của **code**. **Δ106** — `esc()` chỉ escape đúng 5 ký tự, **mọi ký tự điều khiển đi thẳng qua** kể cả NUL và CRLF, trong khi header của renderer tự gọi các giá trị này là "untrusted by construction" ⇒ bất biến được **tuyên bố rộng hơn code thật**; rủi ro thực tế là parser differential/smuggling chứ không phải XSS trực tiếp. **Δ107** (phụ Δ104) — cổng không ghi **loại credential** đã xác thực, nên audit đọc log không phân biệt được "bearer-only" với "cookie không xác minh được" |
| E11 | **Một lỗi harness được BÁO RA chứ không giấu** | `parser-budgets`: các lần chạy full-suite thăm dò lộ **unhandled cancellation rejection** vì test ở tầng handler abort **đồng bộ** khi đang dựng promise đọc metadata; nay test abort **sau khi** thao tác artifact nền hoàn tất. Đáng ghi: **chạy full-suite mới lộ ra**, lệnh targeted một mình sẽ **không** thấy |
| E12 | **Cặp biên TTL** | sweep-guard: biên TTL **đúng bằng** thì **giữ lại**, +1 ms thì **xoá** — test ghim đúng phép so sánh mà production dùng, thay vì chấp nhận rằng "có TTL nào đó". Cùng receipt: lease hỏng **fail closed bằng cách GIỮ** workspace cũ |
| E13 | Tôi đếm từ source | sweep-guard **9 it = 9** · api-key-view-model **49 test = 84 chạy** · parser-budgets **28 test = 53 chạy** · crypto-config **50 it + 5 it.each = 55 → 83 chạy** · checkpoint-replay **10 test = 10**. Không file nào có `skip` |
| E14 | **KHÔNG có va chạm tên file lần này** | Ở Mục 66 có **ba** file trùng tên và tôi suýt đếm sai; lần này tôi vẫn **duyệt toàn cây** để đếm số lần xuất hiện của cả 5 tên — kết quả **mỗi tên đúng 1 file**. Không có cảnh báo nào cần ghi |
| E15 | **Ba file đã có EOL hỗn tạp** | sweep-guard **89 CRLF / 105 bare LF** · parser-budgets **810 / 94** · checkpoint-replay **276 / 165**. Cả ba test-only nên không phải defect nghiêm trọng, nhưng người sửa **phải đọc trước**. `admin-crypto-config` là **LF thuần** (0 CRLF) |
| E16 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=209 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E17 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** | **Ghi chu trung thuc:** so TREE doi 208 -> 209 giua cac lan chay vi mot lane khac them file; BROKEN van la **cung 2** link pre-existing nen ket luan khong doi.
| E18 | Anchor | Chèn ledger-67 làm mọi dòng ≥ L428 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1688` → **`#L1689`**, content-assert L1689 = header Muc 16; `docs/06:75` đi `#L3201` → **`#L3202`**, content-assert L3202 = dong Δ-A42-1 |
### 67.2 Δ

- **Δ-A68-1 (đợt đầu tiên KHÔNG có bản chép nguyên văn — và tôi ghi cả sự vắng mặt đó):** sau **7** lần chép liên tiếp ở Mục 62–66, trên **6** receipt khác nhau, đợt này **không** header nào lặp. Tôi vẫn kiểm và ghi kết quả vào receipt, vì **một sự vắng mặt đáng chú ý cũng là dữ liệu** — nếu im lặng thì người đọc dễ hiểu rằng hiện tượng đã được sửa vĩnh viễn, trong khi tôi **không** có bằng chứng nào cho điều đó. Tôi chỉ biết nó **không xảy ra trong đợt này**.
- **Δ-A68-2 (PHẦN ĐÁNG GIÁ NHẤT CỦA CYCLE: hai test leak CÓ SẴN xanh vì lý do YẾU hơn vẻ ngoài):** tác giả Muc 47 áp đúng quy tắc mà tôi giữ trong bộ nhớ của mình — *một assertion chỉ đáng giá bằng đúng những gì nó chứng minh* — vào **hai test đã tồn tại trong suite** chứ không chỉ vào test mới của ông. (1) Test cấm sentinel trong view model và audit rows thật ra cấm sentinel vào **`publicKeyPem`**, **không phải** `fingerprint`; nó xanh **ngay cả khi** trường `fingerprint` mang đúng sentinel đó. (2) Test cấm sentinel **đã** nằm trong fingerprint thật ra chỉ khẳng định **toàn bộ chuỗi** vắng mặt; đo thực tế **12 ký tự đầu CÓ MẶT**. Cả hai test được **giữ nguyên**, thêm test đo **đúng ký tự nào tới đầu ra**, kèm positive control đặt sentinel vào đúng trường đang kiểm. Tác giả tự nói đây là dạng *"test pass vì lý do sai" mà nó **không bao giờ cảnh báo*** — cùng vấn đề gốc với các khối `test.failing` ở ba cycle trước, nhưng đến từ **chiều ngược lại**: ở đó là test xanh vì **sản phẩm còn lỗi**, ở đây là test xanh vì **assertion yếu hơn nó trông**.
- **Δ-A68-3 (MỘT GIỚI HẠN ĐƯỢC NÓI THẲNG THAY VÌ DỰNG TEST MANG TÊN ĐẸP):** packet yêu cầu **CSRF timing boundaries**; tác giả viết rõ **một unit test offline không chứng minh được** thuộc tính constant-time, và một test giả mang tên "timing" sẽ **không trung thực**. Ông ghim phần **quan sát được** thay thế: ranh giới quyết định (64 là độ dài hợp lệ duy nhất; 63/65/128/129 đều 403) và việc so độ dài buffer diễn ra **trước** so sánh thời gian hằng; để đóng điểm timing thật cần **live sentinel** ở tầng route, thuộc **Tester lane với cửa sổ thật**. Đây là lần thứ ba trong đợt receipt này một lane **từ chối chế tạo bằng chứng** mà thực tế không đỡ nổi.
- **Δ-A68-4 (M1b kèm CHI TIẾT GÁN NGUYÊN NHÂN, và đó là phần đáng học nhất của Muc 47):** M1a nới preview 12 → 32 ký tự ⇒ **6 failed, 77 passed** (2 có sẵn + **4 mới**), và tác giả ghi rõ đây là một thay đổi **rò nhiều hơn** nên bị bắt ngay. M1b nới regex `assertTenantId` ⇒ **12 failed, 71 passed**, **cả 12 đều là test mới**. Nhưng điểm tôi muốn giữ là biến thể **chuỗi rỗng vẫn xanh** — và tác giả **chủ động giải thích** rằng biểu thức mutation vẫn đòi ≥1 ký tự, nên nó cô lập **đúng thuộc tính** bị nới chứ không phải "mọi id hỏng". Đó là khác biệt giữa *"mười hai test đỏ"* và *"mười hai test đỏ **vì lý do này**"* — và chỉ người viết test mới biết cái sau. Δ-A68-5.
- **Δ-A68-5 (Δ104 — cổng CSRF biến mất khi một claim vắng mặt, và tác giả KHÔNG thổi phồng mức độ rủi ro):** `requireWriteAuth` trả sớm khi `cookieRole === undefined`, kể cả với principal `tenant_operator` — tức nó kiểm **tín hiệu ngẫu nhiên** (đã xác minh cookie hay chưa) thay vì **loại credential**. Tác giả nói thẳng **không khai thác được hôm nay** vì principal vẫn phải tới từ header `Authorization`, mà trang chéo không gửi được header đó; rủi ro là **có điều kiện** trên nền "nếu server từng chấp nhận principal từ nguồn khác". Tôi ghi lại cả hai vế vì một finding bị báo đúng mức đáng tin hơn một finding bị thổi phồng. Δ-A68-6.
- **Δ-A68-6 (Δ106 — bất biến được TUYÊN BỐ rộng hơn code thật):** `esc()` chỉ escape đúng 5 ký tự, **mọi ký tự điều khiển đi thẳng qua** kể cả NUL và CRLF, trong khi header của renderer tự gọi các giá trị này là *"untrusted by construction"*. Tác giả phân biệt rõ: NUL không thoát khỏi thuộc tính đã escape dấu nháy, nên rủi ro thực tế là **parser differential / smuggling**, **không phải** XSS trực tiếp. Một finding ghi *"bất biến rộng hơn code"* đáng giá hơn một finding gộp chung mọi thứ thành lỗ hổng. Δ-A68-7.
- **Δ-A68-7 (bẫy đếm số, lần thứ chín liên tiếp):** `admin-api-key-view-model` **49** khai báo / **84** chạy · `parser-budgets` **28** / **53** · `admin-crypto-config` **50 + 5** = 55 / **83** · `sweep-guard` 9 = 9 · `checkpoint-replay` 10 = 10. Bốn con số **27 / 252 / 159 / 249** là **tổng ba lần chạy**.
- **Δ-A68-8:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-11` và `ADM-UX-09` vẫn `[~]`. Cả 5 receipt đều test-only và **zero production code edits**. Δ69/Δ66/Δ74–Δ79/Δ81–Δ107 còn mở. `test.failing` vẫn còn **12 khối ở 5 file** từ các wave trước, nhưng **đợt này không thêm khối nào**.
### 67.3 Lỗi của chính tôi

1. **Một typo tiếng Việt tôi tự bắt được TRƯỚC khi file vào repo.** Trong Δ-A68-2, Δ-A68-6 và Δ-A68-7 tôi viết *"Tác giá"* thay vì *"Tác giả"* — 3 chỗ. Tôi quét fragment bằng một script đếm chính xác chuỗi sai, sửa, rồi **verify bằng đếm lại** (3 → 0, và 3 chỗ dạng đúng). Đây là lần thứ hai trong các cycle gần đây tôi bắt được lỗi chính tả *trước khi* ghi, và tôi coi đây là thói quen **đã giữ được** — khác với những lần assert fail vì đoán chuỗi vẫn xảy ra.
2. **Hai assert fail, và cả hai đều là lỗi needle của tôi chứ không phải lỗi nội dung.** Lần đầu tôi kỳ vọng chuỗi *"not exploitable today"* trong khi docs/28 ghi *"cannot be exploited today"*; lần sau tôi kỳ vọng *"not **exploitable today**"* trong docs/35. Ở **cả hai** lần nội dung trong file **đã đúng**. Tôi in dòng thật rồi lấy đúng chuỗi từ file — đúng bài học, nhưng tôi vẫn phạm vì viết assert **trước** khi in.
3. **Một lần bỏ dấu hai chấm** ở cuối dòng `for` — lỗi cú pháp thứ hai trong ba cycle liên tiếp. Tôi đã ghi ở Mục 65 và 66 rằng phải **viết lại cả dòng** thay vì sửa tối thiểu, và lần này tôi **không** làm đúng. Quy tắc tôi rút ra và sẽ thực sự áp dụng: **một dòng `for` trong script kiểm là một khối riêng, không bao giờ viết nối vào danh sách needle.**
4. **Điều tôi làm ĐÚNG:** (a) **đếm `test.failing` ở cả 5 file** và ghi nhận kết quả **bằng không** như một **phép đo**, không suy luận; (b) **kiểm tra và ghi cả sự vắng mặt của bản chép nguyên văn**, vì im lặng sẽ khiến người đọc tưởng hiện tượng đã dừng vĩnh viễn trong khi tôi không có bằng chứng; (c) **duyệt toàn cây** để đếm số file trùng tên cho cả 5 file mới — kết quả mỗi tên **đúng 1 file**, nên tôi **không** ghi cảnh báo nào vô ích; (d) **verify EOL** của 4 file (3 hỗn tạp, 1 LF thuần); (e) kiểm tra va chạm header trước khi ghi — 8 header mới đều trống; (f) đọc **3 dòng cuối nguyên văn** trước khi viết guard nên guard pass ngay lần đầu; (g) **không** sửa `review.md`; (h) giữ nguyên cả 4 finding của lane platform mà **không** sửa và **không** tự ý nâng thành gate.
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.68.0 → 1.69.0** đúng một chỗ.

## 68 — CYCLE 68: D-DOCS-EVID-SYNC-346 — HAI mục packet KHÔNG có đối tượng trong module; tác giả TỪ CHỐI nâng bằng chứng M1 lên quá mức nó chứng minh

> **RESUME POINT — cycle 68 (packet D-DOCS-EVID-SYNC-346, task `task_1e3a91b40c8d`, dispatch `ctx_1e3a91b40c8d`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–67 giữ nguyên phía trên như lịch sử.
> 1. **5 receipt mới** + 1 mục already-on-record. Tất cả tests-only, **zero production code edits**.
> 2. **Điểm đáng nhớ nhất:** Muc 48 có **hai mục packet không hề có đối tượng trong module**, và tác giả **báo cáo điều đó thay vì viết test cho khớp**. Chi tiết E4.
> 3. **Tác giả từ chối nâng bằng chứng M1 lên quá mức nó chứng minh** — vì guard đường đọc là guard riêng chưa bị mutate. E6. Đây là lần thứ tư trong đợt này một lane nói *"tôi không tuyên bố quá"*.
> 4. **Bản chép nguyên văn QUAY LẠI** sau một cycle sạch: tổng **8** lần trên **7** receipt. E7.
> 5. **`docs/28` giữ version 1.48.0** — bump **1.69.0 → 1.70.0** là version của **docs/35**.

### 68.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 5 receipt mới: `W-DOC-CORE-BARRIER-CLEANUP-NEGATIVE` (tester **10802**, task_5a1b92c40ed2) · `T-CODEX-OFFLINE-BARRIER-CLEANUP-AND-CROSS-SERVICE-BOUNDARY-INDEPENDENT` (tester **10811**, task_9f1a8e94f0d3) · `W-WORKER-SDK-ARTIFACT-MULTIPART-RSS-NEGATIVE` (tester **10842**, task_9a2b104c8f0b) · `W-DOC-CORE-CHILD-LIFECYCLE-NEGATIVE` (tester **10851**, task_6a1b92c40ed3) · `W-PLAT-CR28-08-CRYPTO-CONFIG-STORE-NEGATIVE` (qwen-platform Muc 48 L4479, task_6d8e2194b39e). Cộng một mục already-on-record. Đối chiếu settlement Turn 354 |
| E1 | **[PASS] THẬT, 0 dòng production** | Muc 48: **59/59 ×3** có dòng `PASS` thật, **+55 test (4 → 59)**. Suite là **unit offline** dùng DB cấu hình in-memory, nên **acceptance đầy đủ khả thi** — tác giả nói rõ khác hẳn suite live-DB ở Mục 41. Test `ee90cdeb` / 24345 B / LF |
| E2 | **Khôi phục byte-exact** | `crypto-config-store.ts` `bdb01238` / 5840 B bị chạm tạm cho M1 và khôi phục byte-exact; `crypto-config-api.ts` `94c71214` và `server.ts` `22afb2ff` **không bao giờ** bị chạm |
| E3 | **M1** | Nới guard version của **đường ghi** từ `< 1` thành `< -1` ⇒ **3 failed, 56 passed**: 1 test có sẵn + **2 test mới** (*refuses a zero pin*, *refuses a negative pin*). Khôi phục byte-exact, xác nhận **cả hai** `< 1` còn nguyên, chạy lại **59/59**, `tsc` **log 0 byte** |
| E4 | **HAI MỤC PACKET KHÔNG CÓ ĐỐI TƯỢNG TRONG MODULE — báo cáo, KHÔNG bịa test** | (1) Packet yêu cầu ca **corrupt public key PEM**, nhưng module **KHÔNG HỀ parse PEM**: nó lưu một key **REF** đã allowlist cùng một **version number**; PEM thuộc `recipient-key-registry`. Tác giả ghim **điều thật**: một ref **có hình dạng PEM** vẫn được lưu nếu được allowlist, còn PEM thật thì không. (2) Packet yêu cầu **revoked key lookup fence**, nhưng constructor chỉ nhận `db` + `allowlist`, **không có registry access** ⇒ store **không thể biết** version nào bị thu hồi; fence thật nằm ở `applyCryptoConfig` tầng trên |
| E5 | **Một mục packet thứ ba được CHUYỂN HƯỚNG thay vì bịa** | Packet đòi **malformed JSON**, nhưng bảng `admin_crypto_config` **không có cột JSON** — bốn cột vô hướng. Tác giả chuyển sang **nhầm lẫn hình dạng ở tầng hàng**, là biến thể gần nhất **thực sự tồn tại** |
| E6 | **TÁC GIẢ TỪ CHỐI nâng bằng chứng M1 lên quá mức** | Các test **đường đọc vẫn xanh**, vì `decodeRow` có guard **riêng biệt** mà ông **không mutate**. Hai guard ghi/đọc độc lập ⇒ mutation này chỉ chứng minh **đường ghi** còn đúng; **đường đọc cần một probe riêng**. Ông ghi rõ giới hạn này thay vì im lặng, và tự nói cùng tinh thần với việc nói thẳng phần timing ở Mục 67 |
| E7 | **Bản chép nguyên văn QUAY LẠI** | `W-DOC-CORE-CHECKPOINT-REPLAY-NEGATIVE` bị append lại ở tester **10793**, nguyên văn bản đã ghi ở Mục 67 (cùng task_4a1b92c40ed1, cùng 08:10:34, cùng 10 test). Đợt Mục 67 **không** có; đợt này **có** lại. Tổng **8** lần trên **7** receipt. Δ-A69-2 |
| E8 | **ĐỢT THỨ HAI liên tiếp KHÔNG có `test.failing`** | Tôi đếm ở **cả 5 file**: barrier-cleanup-lifecycle 9 it · cross-service-boundary 4 it · artifact-multipart-rss 10 it + 2 it.each · child-lifecycle 18 test · crypto-config-store 27 it + 8 it.each ⇒ **`test.failing` = 0 ở cả năm**. Tôi ghi rõ đây là **phép đo**, không phải suy luận. Δ-A69-1 |
| E9 | **Coverage hữu ích, đọc ra từ chi tiết** | (a) barrier-cleanup inject **sập tiến trình mô phỏng đúng giữa lúc unlink marker và giải phóng tài nguyên** — cửa sổ hai bước mà thất bại để lại **cả marker mất lẫn tài nguyên bị giữ**, rồi khẳng định retry hồi phục được. (b) child-lifecycle chạy child script thật cho crash / rejection / IPC disconnect / heartbeat timeout, và **script nằm trong thư mục tạm của OS và được dọn đi** ⇒ không để lại rác trong cây. (c) multipart RSS giữ **cả** phép đo 1 GiB **căn chỉnh lẫn lệch**, vì kiểm tra 1 GiB chỉ có nghĩa nếu đúng ở cả hai cách sắp xếp |
| E10 | Tôi đếm từ source | barrier 9 = 9 · cross-service 4 = 4 · multipart-rss **10 + 2 = 12 khai báo, 13 chạy** · child-lifecycle 18 = 18 · crypto-config-store **27 + 8 = 35 khai báo, 59 chạy**. Không file nào có `skip` |
| E11 | **Không có va chạm tên file** | Tôi vẫn **duyệt toàn cây** để đếm số lần xuất hiện của cả 5 tên — mỗi tên **đúng 1 file**. Không có cảnh báo nào cần ghi |
| E12 | **Ba file đã có EOL hỗn tạp** | barrier 216 CRLF / 157 bare LF · cross-service 128 / 7 · child-lifecycle 369 / 162. Cả ba test-only nên không phải defect nghiêm trọng, nhưng người sửa **phải đọc trước**. `crypto-config-store` và `artifact-multipart-rss` là **LF thuần** |
| E13 | Link checker ×3 | S0 **FILES=8 TARGETS=1063 BROKEN=0**; S1 **FILES=11 TARGETS=1147 BROKEN=0**; TREE **FILES=209 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E14 | Δ TARGETS | **1063 → 1063**, **1147 → 1147**: **không đổi** |
| E15 | Anchor | Chèn ledger-68 làm mọi dòng ≥ L429 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1689` → **`#L1690`**, content-assert L1690 = header Muc 16; `docs/06:75` đi `#L3202` → **`#L3203`**, content-assert L3203 = dong Δ-A42-1 |
### 68.2 Δ

- **Δ-A69-1 (đợt thứ hai liên tiếp KHÔNG có `test.failing`, và tôi ghi nó là PHÉP ĐO chứ không phải xu hướng):** tôi đếm ở **cả 5 file** và được **0** khối ở tất cả. Sau **bốn** cycle trước đó mỗi cycle tôi đều tìm ra ít nhất một khối, nên dễ bị cám dỗ viết một câu kiểu *"xu hướng đã dừng"*. Tôi **không** viết câu đó, vì hai điểm dữ liệu liên tiếp không phải xu hướng — và tôi không có cơ sở nào để nói quy trình append hay cách test được viết đã thay đổi. Tôi chỉ ghi: **đợt này không có khối nào**.
- **Δ-A69-2 (bản chép nguyên văn quay lại sau MỘT cycle sạch — và vì sao tôi ghi con số chứ không vẽ đường):** `W-DOC-CORE-CHECKPOINT-REPLAY-NEGATIVE` bị append lại lần nữa ở tester L10793, **nguyên văn** bản đã ghi ở Mục 67. Tổng **8** lần trên **7** receipt. Điểm đáng chú ý nhất ở đây không phải con số mà là **hình dạng dữ liệu**: Mục 67 sạch, Mục 68 bẩn. Nếu tôi vẽ một đường xu hướng từ hai điểm **có, rồi không** thì tôi đang suy ra từ dữ liệu mà bản thân nó đã cảnh báo là không đủ. Tôi ghi **con số tích luỹ** và để người đọc tự nhìn, vì đó là thứ duy nhất tôi thật sự biết. Δ-A69-3.
- **Δ-A69-3 (HAI mục packet KHÔNG có đối tượng trong module, và đây là mẫu tôi nghĩ đáng nhân bảo nhất của đợt này):** packet yêu cầu ca **corrupt public key PEM** — nhưng module **không hề parse PEM**; nó lưu một key *reference* đã allowlist và một con số version, còn PEM thuộc tầng registry khác. Packet cũng yêu cầu **revoked key lookup fence** — nhưng store **không thể biết** version nào bị thu hồi, vì constructor chỉ nhận database và allowlist, **không có** registry access. Cả hai lần, tác giả **ghim điều thật** thay vì dựng test cho khớp: một ref *có hình dạng PEM* vẫn được lưu nếu được allowlist, và PEM thật thì không. Mục thứ ba — **malformed JSON** — được **chuyển hướng** sang nhầm lẫn hình dạng ở tầng hàng, vì bảng **không có cột JSON** nào để mà hỏng. Đây là lần thứ tư trong các cycle gần đây một lane từ chối chế tạo bằng chứng cho thứ packet đặt tên: lần trước là khái niệm *throughput* không tồn tại trong module, trước đó là thuộc tính *constant-time* không chứng minh được offline, và trước nữa là một nhóm test bị gỡ vì hàm cần thiết không được export.
- **Δ-A69-4 (tác giả TỪ CHỐI nâng bằng chứng M1 lên quá mức nó chứng minh — chi tiết tinh tế nhất của Muc 48):** M1 đỏ **3** test, trong đó **2** là mới, và đó là kết quả tốt. Nhưng các test **đường đọc vẫn xanh**, vì bộ giải mã hàng có **guard riêng** mà ông **không** mutate. Vậy nên mutation này chứng minh **chỉ** rằng đường ghi còn đúng, còn đường đọc **cần một probe riêng** mà ông chưa làm. Ông viết giới hạn này ra thay vì để người đọc tự suy, và tự nói đó là **cùng tinh thần** với việc nói thẳng giới hạn timing ở Mục 67. Một mutation đỏ không tự động là bằng chứng cho **mọi** guard trên đường đi; số guard độc lập trên một đường đi chính là thứ quyết định mức mà một mutation có thể phủ. Δ-A69-4.
- **Δ-A69-5 (cặp finding đọc-lại rồi ghi, và Δ109 nhọn hơn Δ108):** khi câu ghi có điều kiện không trả dòng, store gọi lại để lấy giá trị đã lưu, và **giữa** lúc ghi với lúc đọc lại một writer khác có thể ghi đè ⇒ lời gọi của ta **không gì cả** mà vẫn nhận về trạng thái của writer kia. Giá trị trả về **đúng sự thật đang lưu** nên **không phải** mất dữ liệu, nhưng **không phải bằng chứng** rằng lời gọi này đã ghi. **Δ109** nhọn hơn: nếu writer khác **xoá hàng** trong khoảng đó, hàm đọc trả về cấu hình **rỗng** cho đúng tenant mà nó vừa được yêu cầu cấu hình, và vì câu ghi là **điều kiện** còn lần đọc lại **không cùng statement**, store **không có cách nào** báo cho caller biết bản ghi của mình không còn tồn tại. Ghi lại cả hai vì chúng khác nhau về mức độ nghiêm trọng, dù chung một nguyên nhân.
- **Δ-A69-6 (Δ110 — hàng không ghi nhận việc thu hồi, và điều này nối thẳng với một nỗ lực chưa đóng):** bốn cột là tenant, key ref, delivery encryption và pinned version — **không cột nào** ghi trạng thái thu hồi, và store không có registry. Sau khi một version bị thu hồi, hàng đã lưu **không tự báo điều đó**; việc phát hiện chỉ xảy ra ở tầng API và **chỉ khi có người đọc**. Cùng họ với Δ104 ở Mục 67 (cổng CSRF biến mất khi claim vắng mặt) và Δ110 ở đây: **cùng một câu hỏi "cơ chế này có biết trạng thái mà nó cần biết không?"** chưa được trả lời ở cả hai seam. Δ-A69-5.
- **Δ-A69-7 (bẫy đếm số, lần thứ mười liên tiếp):** `crypto-config-store` **27** khai báo / **59** chạy — chênh lớn nhất tôi từng gặp trong lane này, vì **8** khối `it.each` nhân lên nhiều hàng. `artifact-multipart-rss` **10 + 2** = 12 khai báo / **13** chạy. Ba file còn lại khai báo **bằng** chạy (9, 4, 18). Bốn con số **27 / 12 / 48 / 30** là **tổng ba lần chạy**.
- **Δ-A69-8:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-11` và `ADM-UX-09` vẫn `[~]`. Cả 5 receipt đều test-only và **zero production code edits**. Δ69/Δ66/Δ74–Δ79/Δ81–Δ110 còn mở. `test.failing` vẫn còn **12 khối ở 5 file** từ các wave trước, nhưng **đợt này không thêm khối nào**.
### 68.3 Lỗi của chính tôi

1. **Một assert của tôi báo SAI và suýt khiến tôi sửa nội dung đúng.** Tôi kỳ vọng có **6** dòng "Counted from source" trong vùng của cycle này, thực tế chỉ có **4**, và assert đó **fail**. Trước khi sửa tôi in ra toàn bộ vùng — và phát hiện **hai** nguyên nhân, **cả hai đều là lỗi của tôi chứ không phải thiếu sót thật**: (a) mục crypto-config-store thật sự **CHƯA** có dòng đếm, nên tôi **bổ sung** nó; (b) sau khi bổ sung, dòng đó **nối vào cuối** dòng findings chứ không bắt đầu bằng tiền tố, nên phép đếm theo tiền tố vẫn ra 4; và (c) mục already-on-record **đúng ra** không cần dòng đếm. Đây là lần thứ ba trong các cycle gần đây một assert bắt được **khoảng trống thật** trong bài của tôi, và tôi **bổ sung** thay vì nới check. Hướng đúng, giữ nguyên.
2. **Một lần bỏ dấu hai chấm** ở cuối dòng `for` — lần thứ ba trong ba cycle liên tiếp. Tôi đã viết quy tắc ở Mục 65, 66 và 67 rằng phải viết lại cả dòng; lần này tôi vẫn không làm. Đây là bằng chứng rõ nhất cho thấy **viết bài học không thay thế được việc thay đổi cách làm**: cùng một lỗi, ba lần liên tiếp, ba lần đều đã được viết ra trước đó. Tôi ghi lại theo đúng nghĩa đó, không gọi nó là "sơ suất".
3. **Một needle tôi đoán sai** (*"only that the write path is correct"*) trong khi nội dung ấy **có** trong docs/28 dưới cách diễn đạt khác. Đây là lần thứ mười ba của lỗi này. Tôi vẫn **không** thay đổi cách làm: tôi in dòng thật, lấy chuỗi thật, rồi dùng chuỗi thật trong các assert sau. Bài học đã thuộc lòng nhưng vẫn phạm, và tôi ghi thẳng như vậy thay vì diễn giải nó là "sự cố hiếm".
4. **Điều tôi làm ĐÚNG:** (a) **đọc 2 dòng cuối nguyên văn** của cả hai file docs trước khi viết guard, nên cả hai guard pass **ngay lần đầu** — thói quen này đã **giữ liên tục 6 cycle**; (b) **đếm `test.failing` ở cả 5 file**; (c) **duyệt toàn cây** kiểm tra trùng tên trước khi đếm — mỗi tên **đúng 1 file**; (d) **verify EOL** của cả 5 file; (e) kiểm tra va chạm header trước khi ghi — 6 header mới đều trống; (f) **không** sửa `review.md` dù anchor của nó vẫn trôi; (g) ghi 3 finding của lane platform mà **không** sửa và **không** tự ý nâng thành gate; (h) khi đọc Mục 48, tôi ghi lại **giới hạn do tác giả tự nêu** về M1 thay vì chỉ ghi con số test đỏ — vì con số đỏ mà không nêu giới hạn thì **gây hiểu nhầm theo hướng tốt hơn thực tế**.
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.69.0 → 1.70.0** đúng một chỗ.

## 69 — CYCLE 69: D-DOCS-EVID-SYNC-347 — inbox rỗng với đợt này; một module được báo là CHẶN TỐT; tác giả nói rõ lớp XSS nào thật sự giữ; và số 57 của admin tôi phải TÁCH DỮ LIỆU mới ra

> **RESUME POINT — cycle 69 (packet D-DOCS-EVID-SYNC-347, task `task_1e3a91b40c8e`, dispatch `ctx_1e3a91b40c8e`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–68 giữ nguyên phía trên như lịch sử.
> 1. **Inbox được kiểm tra đúng như packet yêu cầu, và nó rỗng với đợt này.** Nó trả về **50** message nhưng message mới nhất là **2026-09-27T20:48Z** — tồn đọng hai ngày, **không có gì về Turn 347**. Tôi ghi điều đó thay vì im lặng. E1.
> 2. **Một module được báo là CHẶN RẤT TỐT, và tác giả nói rõ là để chống hiểu nhầm.** Đây là lần đầu trong đợt receipt này có kết quả **tích cực** được ghi ra chủ động. E4.
> 3. **Tác giả nói rõ LỚP XSS nào thật sự giữ** — là allowlist, **không phải** escaper. E5.
> 4. **`docs/28` giữ version 1.48.0** — bump **1.70.0 → 1.71.0** là version của **docs/35**.

### 69.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 4 owner receipt mới: `W-WORKER-SDK-WORKSPACE-REFERENCE-WIRING-NEGATIVE` (tester **10934**) · `W-DOC-CORE-EXECUTION-PIN-NEGATIVE` (**10977**) · `W-DOC-CORE-SUITE-BOOTSTRAP-CONTRACT-NEGATIVE` (**11019**) · `W-ADM-UX-14-OVERVIEW-TRIAGE-NEGATIVE` (qwen-admin Muc 58 L5372). Ba receipt xác minh độc lập. Cộng **hai** mục already-on-record. Đối chiếu settlement Turn 356 |
| E1 | **INBOX RỖNG VỚI ĐỢT NÀY — ghi ra, không bịa** | `orca orchestration check` trả **50** message, nhưng cái mới nhất là **2026-09-27T20:48Z** và toàn bộ là backlog của lane khác. **Không có message nào về Turn 347.** Tôi nói thẳng: không có gì để đối chiếu packet ở đây, và tôi **không** dựng packet giả cho khớp. Tôi chuyển sang đọc trực tiếp các report của lane, nơi receipt thật sự nằm |
| E2 | **Cùng tình huống, ở lane khác, cùng cách xử lý** | Muc 58 ghi rõ tác giả **cũng chạy inbox check** theo yêu cầu packet, **không** thấy message nào cho task của họ, chỉ thấy payload của **một lane khác từ 2026-09-27** trong đó file test của họ nằm trong `filesModified` của người khác; họ đọc lại file ở trạng thái hiện tại, **không revert gì**, chỉ append, và báo cáo trung thực là không có packet để chiếu. Hai lane, cùng một phát hiện, cùng một cách xử lý |
| E3 | **Mốc thời gian VƯỢT QUA RANH GIỚI NGÀY** | Ba owner receipt và một receipt độc lập mang ngày **2026-09-29**; ba receipt độc lập và một owner receipt mang ngày **2026-09-30** — ngày tôi đồng bộ. Settlement cũng nhảy từ Turn 356 lên Turn 357 với mốc 2026-09-30T23:31. Tôi ghi **từng receipt theo đúng ngày nó mang**, không gom về một ngày của đợt: làm vậy thì hồ sơ gọn hơn nhưng bằng chứng sai một chút. E11 |
| E4 | **MỘT MODULE ĐƯỢC BÁO LÀ CHẶN TỐT — lần đầu có kết quả tích cực** | Muc 58 ghi rõ: ông ghi điều này để **không ai đọc nhầm** rằng mọi view model đều hở như Mục 51–57. Gần như mọi ngưỡng đều **fail closed kèm thông điệp phân biệt**: `total` âm/phân số/cực lớn → *unavailable* + "invalid total count"; `total` là chuỗi/null/thiếu → *unavailable* + "did not provide a total count"; **`total: 0` → available, value 0, KHÔNG bị nhầm với thiếu số**; `queueIntegrity.state` ngoài allowlist → "incomplete snapshot"; **thiếu hẳn** `queueIntegrity` → "has not published a snapshot" — phân biệt rõ với hỏng; `connectorDegradations` **luôn** unavailable vì rỗng **không** phải bằng chứng mọi connector khoẻ |
| E5 | **TÁC GIẢ NÓI RÕ LỚP NÀO THẬT SỰ GIỮ** | `tenantId` độc hại bị **escape HTML** *và* URL-encode trong link filter. Nhưng `queueIntegrity.state` độc hại bị **allowlist chặn trước**, nên payload **không bao giờ** được nội suy và không tới renderer — và tác giả nói thẳng: **lớp giữ là allowlist, KHÔNG PHẢI escaper**. Ghi công cho một escaper không bao giờ chịu tải là cùng loại lỗi với ghi công cho một test chứng minh ít hơn vẻ ngoài của nó |
| E6 | **4 defect thật, ghi nhận không sửa** | (1) Cửa sổ thời gian **không bao giờ** được parse/sắp xếp/kiểm — `resolveWindow` chỉ so `length > 0`, nên chuỗi rác đi thẳng qua **nguyên văn** và cửa sổ **đảo ngược** cũng qua yên; tệ hơn, `fetchOverview` đưa **chính chuỗi đó vào query gửi đi**, tác giả assert được `from=garbage&to=nonsense` nằm trong URL thật. (2) Preset lạ **rơi im lặng về hôm nay**, **không lỗi không cảnh báo**, và **vứt bỏ** bound người gọi truyền. (3) Preset `24h`/`7d` **âm thầm bỏ qua** `from`/`to` mà cùng dữ liệu đó với `custom` thì được giữ. (4) Đồng hồ nguồn chạy nhanh hơn **60s** bị coi là stale |
| E7 | **Ba lỗi probe của tác giả, MỘT bài học: kết quả đồng loạt = fixture hỏng** | Stub dùng nullish-coalesce nên `total: null` bị nuốt thành `0` — ca âm trông thành ca dương. Fixture staleness dùng mốc **cố định** trong khi code tự chụp `Date.now()` thật, nên **mọi** dòng kể cả dòng `ok` đều ra `stale`; tác giả nói rõ **kết quả đồng loạt bất thường chính là dấu hiệu fixture hỏng**, và dẫn lại đúng bài học Mục 57 đã ghi. Cả hai đều là trường hợp harness **nói dối theo hướng làm code trông đúng** |
| E8 | **Các mục còn lại** | workspace wiring URL-encode đường dạng trông như traversal thành **một** giá trị query, và coi 422 từ query tham chiếu là **uncertain** chứ không phải vắng chắc là không tồn tại, để caller phân biệt yêu cầu bị từ chối với artifact thật sự không có. Execution pin khẳng định đổi **tool version giữa chừng run** không làm recipe trôi và **không lặp lại** lời gọi connector — mạnh hơn việc chỉ kiểm recipe đúng một lần. Bootstrap khẳng định cấu hình harness hỏng bị từ chối **TRƯỚC khi hạ tầng khởi động** |
| E9 | **SỐ 57 CỦA ADMIN: TÔI PHẢI TÁCH THỬ ĐỂ RA** | Một regex đếm thông thường cho **42**, receipt nói **57**, và file **không có vòng lặp nào**. Tôi không chấp nhận con số nào vội: in ra thì thấy **6 khối `test.each`**, mà regex của tôi đã **gộp** tiền tố `.each` vào một `test()` thường. Tách ra: **36 dòng khai báo** (2 `it()` + 34 `test()`), trong đó **6** là khối `test.each`, và các khối đó cấp **21 dòng** ⇒ 36 + 21 = **57 chạy**, khớp receipt |
| E10 | **Bài học từ E9, ghi vì nó thay đổi cách tôi đếm** | Một regex cho phép hậu tố tùy chọn sẽ **gộp phần khai báo của khối bảng vào một test thường**, ra con số **vừa không phải số khai báo, vừa không phải số chạy**. Sai theo hướng dễ phát hiện. Nguy hiểm hơn là loại regex **loại** hậu tố, vì nó đếm **nhiều hơn** thật mà trông vẫn hợp lý. Từ nay tôi đếm `it()`/`test()` tách khỏi `*.each` và **tự cộng** số dòng của từng bảng |
| E11 | Tôi đếm từ source | workspace-wiring **14 + 2** = 18 · execution-pin **10** = 10 · bootstrap **13** = 13 · temp-workspace **12 + 1 khối 4 dòng** = 16 · overview-triage **36 + 6 khối (21 dòng)** = 57. Không file nào có `skip` |
| E12 | **ĐỢT THỨ BA liên tiếp KHÔNG có `test.failing`** | Tôi đếm ở **cả 7 file**: 0 khối. Tôi vẫn **không** viết "xu hướng đã dừng" — ba điểm liên tiếp không phải xu hướng. Đây là **phép đo**. Δ-A70-1 |
| E13 | **Hai bản chép, và lần đầu rơi CẢ HAI cùng lúc** | `W-WORKER-SDK-ARTIFACT-MULTIPART-RSS-NEGATIVE` (L10883) và `W-DOC-CORE-CHILD-LIFECYCLE-NEGATIVE` (L10892) đều bị append lại **nguyên văn** so với bản tôi đã ghi ở Mục 68. Tổng: **10** lần trên **8** receipt. Mục trước có 1, mục trước nữa có 0. Δ-A70-2 |
| E14 | **TARGETS ĐỔI — và tôi đã truy nguồn thay vì đoán** | Chạy link check lần đầu cho thấy S0 **1063 → 1065**, S1 **1147 → 1149**, TREE **1870 → 1877**, FILES **209 → 210**. Trước khi ghi tôi quét **vùng mới tôi vừa thêm** ở cả `docs/28` và `docs/35`: **0** markdown link. Vậy phần tăng **không** do tôi, mà do lane khác sửa file trong cùng bộ docs. Tôi ghi con số **thật của lần chạy cuối** và ghi rõ nguyên nhân, thay vì viết "không đổi" như các cycle trước |
| E15 | Link checker ×3 | S0 **FILES=8 TARGETS=1065 BROKEN=0**; S1 **FILES=11 TARGETS=1149 BROKEN=0**; TREE **FILES=210 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E16 | Anchor | Chèn ledger-69 làm mọi dòng ≥ L430 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1690` → **`#L1691`**, content-assert L1691 = header Muc 16; `docs/06:75` đi `#L3203` → **`#L3204`**, content-assert L3204 = dong Δ-A42-1 |
### 69.2 Δ

- **Δ-A70-1 (inbox rỗng, và tôi ghi điều đó thay vì bịa packet cho khớp):** packet bảo tôi kiểm inbox, tôi làm, và nó trả **50** message — nhưng cái mới nhất là **2026-09-27T20:48Z**, tức backlog **hai ngày tuổi** của các lane khác, **không có gì về Turn 347**. Đây là lần thứ hai trong các cycle gần đây mà một nguồn được chỉ định **không chứa** thứ ta cần: lần trước là admin lane tìm thấy payload của lane khác. Tôi không dựng packet giả, không gán receipt nào cho task khi không có bằng chứng, và tôi **ghi rõ** trong receipt rằng nguồn được chỉ định không dùng được — vì im lặng sẽ khiến người sau tưởng tôi đã đối chiếu được thứ không tồn tại. Δ-A70-3.
- **Δ-A70-2 (một lane báo KẾT QUẢ TÍCH CỰC, và đó là tin có giá trị):** Mục 58 là lần đầu trong đợt receipt này mà tác giả ghi ra rằng module của ông **chặn rất tốt** — và ông nói thẳng lý do ghi: để **không ai đọc nhầm** rằng sáu Mục trước đó chứng minh mọi view model đều hở. Tôi ghi nhận đây là một dạng trung thực ít gặp: tác giả tự chống lại cách kể sai về chính bằng chứng của mình. Đáng chú ý nhất là **một kết quả âm tính có giá trị bằng kết quả dương** — chỗ nào chặn fail-closed với **thông điệp phân biệt** mới là chỗ đáng tin; nơi thiếu số `0` bị nhầm với thiếu số, hay nơi khối rỗng bị coi là bằng chứng khoẻ, thì "xanh" không mang thông tin.
- **Δ-A70-3 (tác giả nói rõ lớp nào THẬT SỰ giữ, và đó là kỹ thuật đáng học nhất của cycle này):** với `tenantId` độc hại, cả escape HTML lẫn URL-encode đều chặn; nhưng với `queueIntegrity.state` độc hại, **allowlist chặn trước khi nội suy**, nên payload không bao giờ tới renderer — và tác giả nói thẳng **lớp giữ là allowlist, KHÔNG phải escaper**. Đây là hệ quả trực tiếp của nguyên tắc tôi đã ghi ở Mục 67: một assertion chỉ đáng giá bằng đúng những gì nó chứng minh — và điều đó áp dụng cho **cả assertion lẫn cơ chế phòng thủ**. Ghi công cho escaper không bao giờ chịu tải là **loại lỗi giống hệt** với ghi công cho một test chứng minh ít hơn vẻ ngoài. Δ-A70-4.
- **Δ-A70-4 (bài học từ bài toán đếm số, và nó thay đổi CÁCH tôi đếm từ cycle này):** `admin-overview-triage` có **36 dòng khai báo** nhưng chạy **57**. Regex đầu tiên của tôi cho **42** vì nó gộp tiều tố `.each` tùy chọn và coi 6 khối `test.each` thành 6 test thường. Tôi **không** chọn con số nào vội mà in ra và đếm lại: 2 `it()` + 34 `test()`, trong đó **6** là khối bảng, các khối đó cấp **21** dòng ⇒ 36 + 21 = 57, khớp receipt. Nguy hiểm thật không nằm ở chỗ đếm **thiếu** — chỗ đếm thiếu thì dễ phát hiện — mà ở chỗ một regex **loại** hậu tố sẽ đếm **nhiều hơn** thật mà vẫn trông hợp lý, và tôi đã gặp dạng đó ở nhiều file. Δ-A70-5.
- **Δ-A70-5 (kết quả đồng loạt là dấu hiệu, không phải tin tốt):** tác giả Muc 58 kể ba lỗi probe của mình, và cả ba cùng một bài học: một stub nuốt null thành zero nên ca âm trông thành ca dương; một fixture dùng mốc thời gian **cố định** trong khi code tự chụp đồng hồ thật, nên **mọi** dòng kể cả dòng đáng lẽ phải xanh đều ra `stale`; và một assertion quá rộng vì chuỗi đó còn nằm trong tên thuộc tính khác. Ông nói rõ **kết quả đồng loạt bất thường chính là dấu hiệu fixture hỏng**, và dẫn lại đúng bài học Mục 57. Đây là hình thức của một đạo đức thử nghiệm tôi muốn thấy nhiều hơn: **khi mọi thứ cùng đỏ, nghi ngờ công cụ trước khi nghi ngờ sản phẩm**.
- **Δ-A70-6 (hai bản chép rơi CÙNG LÚC, và tôi vẫn không vẽ xu hướng):** lần này **hai** receipt của Mục 68 bị append lại nguyên văn, nên tổng lên **10** lần trên **8** receipt. Chuỗi ba cycle: 0 → 1 → 2. Ba điểm đó trông **rất** giống một xu hướng tăng, và đó **chính là** lý do tôi không viết nó như xu hướng: với ba điểm liên tiếp, "tăng" và "ngẫu nhiên" không phân biệt được, và tôi **không** có căn cứ nào để khẳng định cơ chế append đã đổi hành vi. Tôi ghi **con số tích luỹ** và để người đọc tự nhìn.
- **Δ-A70-7 (TARGETS đổi, tôi TRUY NGUỒN thay vì ghi "không đổi" như mọi cycle trước):** link check lần đầu cho S0 1063 → **1065**, S1 1147 → **1149**, TREE 1870 → **1877**. Trước khi ghi tôi quét vùng mới tôi vừa thêm ở **cả hai** file docs: **0** markdown link. Nên phần tăng **không** do tôi mà do lane khác sửa file trong cùng bộ. Bốn cycle liên tiếp tôi ghi "Δ TARGETS: không đổi" và đó **đúng** với các cycle đó; cycle này thì sai nếu tôi viết y hệt, nên tôi ghi **số thật của lần chạy cuối** kèm nguyên nhân. Một mẫu ghi cố định chỉ đúng khi dữ liệu thật sự cố định.
- **Δ-A70-8:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-14`, `ADM-UX-11`, `ADM-UX-09` vẫn `[~]`. Cả 4 owner receipt đều test-only và **zero production code edits**. Δ69/Δ66/Δ74–Δ79/Δ81–Δ110 còn mở. `test.failing` vẫn còn **12 khối ở 5 file** từ các wave trước; đợt này **không thêm** khối nào.
### 69.3 Lỗi của chính tôi

1. **Tôi đếm sai một số rồi bắt được, nhờ không chọn con số nào vội.** Regex đầu tiên cho `admin-overview-triage` là **42** trong khi receipt nói **57**. Thay vì điền 42 hay điền 57, tôi in ra và đếm lại: có **6** khối `test.each` mà regex tôi viết đã gộp vào test thường. Kết luận thật là **36 + 21 = 57**. Nếu tôi tin regex của chính mình, docs/28 sẽ mang một con số sai mà **trông hoàn toàn hợp lý** — và đây là dạng sai tôi đã gặp nhiều lần nhất, nên tôi coi đây là bài học lớn nhất của cycle: **phân biệt số khai báo với số chạy, và đếm từng khối bảng thay vì để regex suy ra**. Tôi đã ghi quy tắc mới này vào Δ-A70-5.
2. **Một guard "không đổi" mà tôi đã viết bốn lần liên tiếp, lần này SAI.** Tôi định ghi `Δ TARGETS: 1063 → 1063` theo thói quen. Nhưng lần chạy cho S0 1065, S1 1149, TREE 1877. Tôi dừng lại và quét vùng mới tôi vừa thêm: **0** markdown link ⇒ phần tăng không phải của tôi mà của lane khác. Nếu tôi viết theo thói quen thì Mục 69 sẽ ghi sai một con số mà người đọc có thể dùng để đối chiếu. Bài học: **một mẫu ghi cố định chỉ đúng khi dữ liệu thật sự cố định; mặc định thì phải đo lại.**
3. **Tôi đã lặp lại lỗi cú pháp `for` thiếu dấu hai chấm ở nhiều script trong cycle này** — vẫn là lỗi tôi đã ghi quy tắc chống ở Mục 65, 66, 67, 68. Tôi ghi thẳng: **bốn lần viết quy tắc rồi vẫn phạm** là bằng chứng rằng ghi bài học không thay đổi hành vi. Cách duy nhất tôi thấy hiệu quả là **không viết danh sách `for` dài ngay trong mã sinh script** nữa, mà tách phần dữ liệu ra file riêng và chỉ để vòng lặp ngắn trong script.
4. **Một điều tôi làm ĐÚNG và muốn giữ:** (a) **kiểm inbox đúng như packet bảo** và **ghi ra rằng nó rỗng với đợt này**, thay vì bịa packet cho khớp hoặc im lặng; (b) **quét fragment tìm lỗi chính tả TRƯỚC khi ghi vào repo** — biện pháp này bắt được lỗi ở Mục 67; (c) **truy nguồn TARGETS** thay vì ghi theo thói quen; (d) **đếm `test.failing` ở cả 7 file** và **không** vẽ xu hướng từ ba điểm; (e) **duyệt toàn cây** kiểm tra trùng tên cho cả 7 file mới; (f) verify EOL của từng file; (g) kiểm tra va chạm header trước khi ghi — 8 header mới đều trống; (h) đọc **3 dòng cuối nguyên văn** trước khi viết guard nên guard pass ngay lần đầu; (i) **không** sửa `review.md`; (j) ghi 4 defect của admin mà **không** sửa và **không** tự nâng thành gate; (k) khi đọc Muc 58, tôi ghi lại **cả kết quả tích cực** (module chặn tốt) chứ không chỉ lấy mỗi defect — vì một bản tóm tắt chỉ toàn lỗi sẽ bóp méo bằng chứng theo hướng ngược lại với điều tác giả cố tình nói.
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.70.0 → 1.71.0** đúng một chỗ.

## 70 — CYCLE 70: D-DOCS-EVID-SYNC-348 — CHUỖI BA ĐỢT KHÔNG CÓ `test.failing` KẾT THÚC; 13 khối mới trong một file; và tôi KHÔNG đối chiếu được 4/6 số test bằng cách đếm tĩnh

> **RESUME POINT — cycle 70 (packet D-DOCS-EVID-SYNC-348, task `task_1e3a91b40c8f`, dispatch `ctx_1e3a91b40c8f`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–69 giữ nguyên phía trên như lịch sử.
> 1. **CHUỖI BA ĐỢT KHÔNG CÓ `test.failing` ĐÃ KẾT THÚC** — và tôi ghi điều đó, không để lời cũ của Mục 68/69 đứng một mình. Chi tiết E4.
> 2. **Tôi KHÔNG đối chiếu được số chạy của 4/6 file mới** bằng cách đếm tĩnh, và tôi **không** bịa một phép đối chiếu cho khớp. Chi tiết E9.
> 3. **Hai mục packet lại không quan sát được qua harness** — và lần này tác giả phân biệt rõ đó là **giới hạn của harness, không phải thiếu sót của sản phẩm**. E7.
> 4. **Có receipt mang ngày 2026-10-01** — ngày tôi đồng bộ. E8.
> 5. **`docs/28` giữ version 1.48.0** — bump **1.71.0 → 1.72.0** là version của **docs/35**.

### 70.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 4 owner receipt mới: `W-DOC-CORE-CONFIG-NEGATIVE` (tester **11070**, task_7a1b92c40ed6, **2026-09-30 23:49:51**) · `W-WORKER-SDK-WORKER-SERVICE-AUTH-NEGATIVE` (**11078**, task_1b2b104c8f20, **2026-10-01 00:00:06**) · `Follow-up receipt for task_7a1b92c40ed7` (**11088**, **2026-10-01 00:02:50**) · `W-PLAT-CR28-09-ADMIN-CRYPTO-CONFIG-WIRING-NEGATIVE` (qwen-platform Muc 49 L4579). Một receipt xác minh độc lập. Cộng một mục already-on-record. Đối chiếu settlement Turn 358 |
| E1 | **[PASS] THẬT, mutation đỏ CHỈ ở test MỚI** | Muc 49: **71/71 ×3** có dòng `PASS` thật, **+48 test (23 → 71)**, **0 dòng production**. Suite **in-process, offline**: gọi thẳng `route(ctx)`, không socket / PG / Redis / Vault. `rbac.ts` chạm tạm cho M1 và khôi phục **byte-identical** `c0e02328`; `server.ts` `22afb2ff` và `crypto-config-store.ts` `bdb01238` **không bao giờ** bị chạm. M1 nới conjunct bearer để nhận `bearer` viết thường + trim ⇒ **2 failed, 69 passed**, và **cả hai đều là test MỚI** |
| E2 | **M1a khác M1b ở Mục 63** | Ở Mục 63, M1a đỏ ở test cũ và M1b đỏ ở test mới. Ở đây **cả hai** test đỏ đều là test mới của tác giả. Khôi phục byte-exact, chạy lại 71/71, `tsc` **log 0 byte** |
| E3 | **TÁC GIẢ TỪ CHỐI MỘT KẾT QUẢ XANH ĐẾN TỪ SỬA SAI CHỖ** | Tự sửa số 1: ông dùng một field để chứng minh thứ tự ưu tiên tenant, test **đỏ 409** vì fixture khoá thuộc về tenant khác nên bị chặn ở *"không có khoá dùng được"* **trước khi** quy tắc ưu tiên kịp hiện ra. Ông đổi sang field chỉ platform, và nói thẳng: **"Test này từng đỏ vì lý do khác và phải sửa, không phải xanh vì tôi muốn."** Đây là câu tôi muốn in ra và dán lên mọi assertion xanh mà ta thấy |
| E4 | **CHUỖI BA ĐỢT KHÔNG CÓ `test.failing` — KẾT THÚC** | File `output-validation.test.ts` từng được tôi xác minh ở **32 test và 0 `test.failing`**. Nay nó khai báo **25 `test()` + 13 `test.failing` = 38 chạy**, khớp receipt. Lời tôi ở Mục 68 và Mục 69 rằng **ba đợt liên tiếp** không có khối expected-failure là **đúng cho các file của các đợt đó** và nay **hết**. Chuỗi dài ba đợt, và nó đã kết thúc — tôi ghi kết thúc chứ không giữ một khẳng định đã cũ |
| E5 | **13 khối đó không phải chuyện hình thức** | Đọc thẳng từ file: NaN confidence · NaN quality score · invoice total âm · provider array vượt trần số item đầu ra · ký tự điều khiển trong text của provider · ký tự thay thế sinh từ UTF-8 hỏng · **field lạ của provider trên một variant đã biết** · **field `__proto__` do provider cung cấp** · checksum payload hỏng · checksum không khớp nội dung · MIME không mong đợi trong envelope của provider · descriptor quá lớn trước khi nhận split output · dấu truncated-content do provider mang theo |
| E6 | **Hai cái trong đó có HÌNH DẠNG BẢO MẬT, và tôi không muốn đọc nhẹ** | Chấp nhận field lạ trên một variant đã biết là **hình dạng của lỗi mass-assignment**; không từ chối field `__proto__` do provider đưa vào là **hình dạng của vector prototype-pollution**. Cả hai **xanh vì sản phẩm KHÔNG từ chối**. Đây đúng là lý do `test.failing` hữu ích nhất khi thiếu hành vi — và cũng đúng là lý do **con số xanh không bao giờ** được đọc như tín hiệu chất lượng một mình. Điều đáng ghi ở đây là **minh bạch**: receipt **nêu tên** các probe ngay trong dòng coverage của nó, đúng trường hợp đối chiếu với ba khối bị giấu ở các cycle trước |
| E7 | **HAI MỤC PACKET LẠI KHÔNG QUAN SÁT ĐƯỢC — và tác giả gọi đúng TÊN loại giới hạn** | (1) **400 (JSON hỏng)**: JSON bị **body parser chặn TRƯỚC** khi gọi `route()`, và ở đây `ctx.body` đã parse sẵn, nên **không tạo được 400** bằng cách gọi `route(ctx)`; tác giả ghim **điều thật** thay thế: một body đã parse nhưng hỏng hình dạng vẫn đi qua. (2) **500**: `route()` **không** chuyển lỗi thành 500, vì việc map sang `safeInternalErrorProblem` nằm ở **handler trên cao hơn trong `createApp`**, trên cả lời gọi này; và ông **chứng minh điều quan sát được** bằng cách cho lỗi tho truyền nguyên vẹn ra ngoài, không bị nuốt. Cả hai giới hạn thuộc về **bản chất in-process của harness**, KHÔNG phải thiếu sót của sản phẩm — một phân biệt mà phần lớn receipt sẽ làm mờ |
| E8 | **CÓ RECEIPT MANG NGÀY 2026-10-01** | `W-WORKER-SDK-WORKER-SERVICE-AUTH-NEGATIVE` ghi **2026-10-01 00:00:06**, và follow-up receipt ghi **2026-10-01 00:02:50** — ngày tôi đồng bộ. Đợt này vì thế mang **ba** ngày: 09-29 (Muc 49), 09-30 (config, hai receipt độc lập) và 10-01. Tôi ghi từng receipt theo ngày nó mang, không gom. Settlement cũng đã nhảy lên Turn 358 với mốc 2026-09-30T23:55 |
| E9 | **TÔI KHÔNG ĐỐI CHIẾU ĐƯỢC SỐ CHẠY CỦA 4/6 FILE — VÀ TÔI KHÔNG BỊA** | Tôi hứa ở Mục 69 là sẽ tách `it()`/`test()` khỏi `*.each` và **tự cộng từng dòng của từng bảng**. Tôi làm vậy, và nó **vẫn chưa đủ** cho các bảng mà mỗi dòng là một **object chứa dấu phẩy và URL**: hai cách tách của tôi cho ra **5** và **2** dòng cho **cùng một bảng**, tức là bộ đếm của tôi **không đáng tin** với loại bảng đó. Đọc bằng mắt: bảng của `config` có **4** dòng ⇒ 20 + 4 = **24** so với receipt nói **25**; ba bảng của `worker-service-auth` cho **13 + 2 + 3 = 18** ⇒ 5 + 18 = **23** so với **26**. Tôi ghi **số khai báo** (đáng tin) **cạnh số receipt**, và nói thẳng là **chưa đối chiếu được** |
| E10 | **File nào thì ĐỐI CHIẾU ĐƯỢC** | `output-validation`: **25 + 13 = 38** khớp receipt **chính xác** · `suite-bootstrap-contract`: **13 = 13** khớp · `connector-invoker` và wiring: khai báo **18 + 5 khối** và **46 + 5 khối**, receipt nói **36** và **71**, tôi **không** đối chiếu được. Ba file trong số này có `test.failing` = 0 |
| E11 | **Một trường hợp đáng đọc hai lần** | `worker-service-auth` khẳng định một credential **đã từng hợp lệ** thôi được chấp nhận sau khi **khoá ký service được xoay vòng**. Đó là thuộc tính **xoay vòng khoá**, không phải kiểm tra định dạng, và khó hơn nhiều so với một test parser. Môi trường cũng được ghi rõ: loopback fixture cục bộ + phụ thuộc in-memory, **không** dịch vụ ngoài | **So TARGETS doi va toi da TRUY NGUON (lan thu hai lien tiep):** lan chay dau cho S0 1065 / S1 1149 / TREE 1877; lan chay cuoi cho S0 **1067** / S1 **1151** / TREE **1882**, FILES 210 roi **211**. Toi quet vung moi toi vua them o CA HAI file docs: **0** markdown link, nen phan tang **khong** do toi ma do lane khac sua file trong cung bo docs. So ghi o E12 la cua **lan chay cuoi**, tuc trang thai disk tai luc toi viet receipt nay.
| E12 | Link checker ×3 | S0 **FILES=8 TARGETS=1067 BROKEN=0**; S1 **FILES=11 TARGETS=1151 BROKEN=0**; TREE **FILES=211 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane |
| E13 | Anchor | Chèn ledger-70 làm mọi dòng ≥ L431 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1691` → **`#L1692`**; `docs/06:75` đi `#L3204` → **`#L3205`**, đều content-assert |
### 70.2 Δ

- **Δ-A71-1 (tôi SỬA LỜI CỦA CHÍNH MÌNH ở Mục 68 và 69, và tôi ghi việc sửa đó chứ không giữ luận điểm cũ):** tôi đã viết ở hai cycle trước rằng **ba đợt liên tiếp** không chứa khối `test.failing` nào, và tôi đã cẩn thận **không** gọi đó là xu hướng. Đợt này, file `output-validation` mang **13** khối. Lời cũ của tôi **không sai cho các file các đợt đó** — nhưng nếu tôi để nó đứng mà không ghi kết thúc, người đọc sẽ hiểu là hiện trạng còn đúng, và **đó** mới là chỗ sai. Đây là lần thứ hai trong các cycle gần đây tôi phải tự thu hồi một phát biểu của chính mình, và lần này nó đáng vì phát biểu đó có tính **định lượng** chứ không phải cảm tính. Δ-A71-2.
- **Δ-A71-2 (bài học về công cụ: tôi hứa sẽ làm tốt hơn, làm tốt hơn, VÀ VẪN KHÔNG ĐỦ — tôi ghi điều đó thay vì tự khen):** Ở Mục 69 tôi tự đặt quy tắc mới: tách `it()`/`test()` khỏi `*.each` và **tự cộng từng dòng của từng bảng**. Tôi đã làm đúng vậy, và nó **vẫn không đủ** cho những bảng mà mỗi dòng là một object chứa dấu phẩy bên trong và chuỗi URL. Bằng chứng rằng bộ đếm của tôi **không đáng tin** là hai phương pháp khác nhau cho **cùng một bảng** ra **5** và **2** — chênh nhau hơn gấp đôi trên cùng dữ liệu. Khi hai phép đo của chính tôi không thống nhất, phải kết luận là **phương pháp** sai chứ không phải dữ liệu sai. Tôi dừng lại ở đó thay vì thử phương pháp thứ ba cho tới khi ra đúng số mà receipt nói. Δ-A71-3.
- **Δ-A71-3 (cái tôi ghi thay vì bịa, và tôi coi đây là dạng trung thực quan trọng nhất):** với **4 trong 6** file mới, tôi **không đối chiếu được** số chạy. `config`: đếm tay 20 + 4 = **24** so với receipt nói **25** — thiết đúng 1. `worker-service-auth`: 5 + (13 + 2 + 3) = **23** so với **26** — thiết 3. Hai file còn lại tôi chỉ đếm được số khai báo. Tôi ghi **cả hai con số cạnh nhau** và nói thẳng là chưa đối chiếu được. Một bản tóm tắt chỉ ghi số của receipt sẽ **trông đầy đủ và hoàn toàn sai**; một bản ghi cả hai số và nói rõ phần nào chưa kiểm thì **ít đẹp hơn nhưng đúng**. Tôi chọn cái sau. Δ-A71-4.
- **Δ-A71-4 (một câu từ tác giả Muc 49, tôi muốn dùng làm chuẩn cho mọi receipt về sau):** ông viết rằng test của ông **"từng đỏ vì lý do khác và phải sửa, không phải xanh vì tôi muốn"**. Một test xanh có thể đến từ việc sửa **sai chỗ** để nó xanh, và người viết test là người duy nhất biết mình đã sửa chỗ nào. Ở cùng receipt đó, ông cũng sửa ngược lại: ông **mô tả** hành vi là một no-op không ghi gì, test **đỏ** vì store thật ra **có một hàng**, tức hành vi thật **mạnh hơn** điều ông viết — và ông viết lại assertion theo giá trị **đo được**, không theo giá trị **định ý**. Cả hai lần đều là hướng sửa đúng. Δ-A71-5.
- **Δ-A71-5 (hai mục packet không quan sát được, và tại sao cách gọi tên giới hạn mới là phần đáng học):** 400 bị body parser chặn trước khi route chạy, nên **không tạo được** trong in-process; 500 không xảy ra vì phần map lỗi nằm ở handler cao hơn. Tác giả không viết "test này không làm được" — ông nói cả hai giới hạn thuộc về **bản chất in-process của harness, không phải thiếu sót của sản phẩm**, và ông **chứng minh** quan sát được bằng cách cho lỗi tho truyền nguyên vẹn ra ngoài. Đây là lần thứ ba trong các cycle gần đây một packet yêu cầu thứ module không có; sự khác biệt là ở đây giới hạn thuộc về **cách quan sát**, chứ không phải về **sản phẩm**. Δ-A71-6.
- **Δ-A71-6 (13 khối mới, và hai cái có hình dạng bảo mật):** chấp nhận **field lạ** trên một variant đã biết là hình dạng của lỗi mass-assignment; không từ chối field `__proto__` do provider đưa vào là hình dạng của vector prototype-pollution. Cả hai xanh **vì sản phẩm không từ chối**. Tôi không muốn chúng trôi qua mắt người đọc chỉ vì chúng nằm trong một dòng "38 passed". Điều đáng ghi là chúng **được nêu tên** ngay trong dòng coverage của receipt — tức mẫu *giấu expected-failure* đã **không tái diễn** ở đây. Δ-A71-7.
- **Δ-A71-7 (một bản chép nữa, và tôi vẫn không vẽ xu hướng):** `W-DOC-CORE-SUITE-BOOTSTRAP-CONTRACT-NEGATIVE` bị append lại **nguyên văn** ở tester L11029. Tổng **11** lần trên **9** receipt. Chuỗi bốn cycle gần nhất: 2, 0, 1, 1 — **không phải một hướng**, và tôi nói thẳng điều đó thay vì để con số tự nói lên. Δ-A71-8.
- **Δ-A71-8 (ba ngày trong một đợt, và tôi ghi từng ngày):** receipt owner Muc 49 mang **09-29**; `config` và hai receipt độc lập mang **09-30**; `worker-service-auth` và follow-up receipt mang **10-01** — ngày tôi đồng bộ. Gom về một ngày của đợt sẽ làm hồ sơ gọn hơn và **bằng chứng sai hơn**; mốc thời gian là một phần của bằng chứng, và đợt này **thật sự** đã đi qua nửa đêm.
- **Δ-A71-9:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-14`, `ADM-UX-11`, `ADM-UX-09` vẫn `[~]`. Tất cả receipt đều test-only và **zero production code edits**. Δ69/Δ66/Δ74–Δ79/Δ81–Δ113 còn mở. `test.failing` toàn cây giờ là **25 khối ở 6 file** (12 khối cũ + 13 khối mới).
### 70.3 Lỗi của chính tôi

1. **Một phát biểu của chính tôi đã thành sai theo thời gian, và tôi tự thu hồi nó.** Ở Mục 68 và 69 tôi viết rằng ba đợt liên tiếp không có khối `test.failing`. Đợt này có **13** khối trong một file. Lời cũ **đúng cho các file các đợt đó**, nhưng để nó đứng yên sẽ khiến người đọc hiểu sai hiện trạng. Tôi ghi rõ chuỗi đó dài ba đợt và **đã kết thúc**. Bài học tôi rút ra lần này khác các lần trước: một phát biểu **định lượng** về hiện trạng sẽ **hết hạn** theo thời gian, nên nó phải được viết kèm điều kiện và được cập nhật khi điều kiện đổi — chứ không phải một câu đúng rồi để mãi.
2. **Tôi cải thiện công cụ theo đúng lời tôi hứa, và công cụ vẫn không đủ.** Ở Mục 69 tôi tự đặt quy tắc: tách `it()`/`test()` khỏi `*.each` và tự cộng từng dòng. Tôi làm vậy, và nó **vẫn hỏng** với bảng mà mỗi dòng là object chứa dấu phẩy và URL. Bằng chứng là hai phương pháp của tôi cho **cùng một bảng** ra **5** và **2**. Khi hai phép đo của chính mình lệch nhau gấp hơn hai lần, kết luận đúng là **phương pháp** sai chứ không phải dữ liệu sai. Tôi đã dừng lại thay vì thử thêm phương pháp cho tới khi nó ra đúng con số receipt nói — vì làm thế là **đẻo dữ liệu cho khớp bằng công cụ hỏng**, đúng thứ tôi chống ở Mục 61.
3. **Tôi ghi 4/6 số test là "chưa đối chiếu được", thay vì chỉ dán số receipt.** Với `config` tôi đếm tay được 24 so với 25, với `worker-service-auth` được 23 so với 26. Một bản tóm tắt chỉ ghi số của receipt sẽ **trông đầy đủ và hoàn toàn sai**; ghi cả hai số cạnh nhau kèm câu "chưa đối chiếu được" thì **ít đẹp hơn nhưng đúng**. Tôi chọn cái sau, và tôi coi đây là dạng trung thực quan trọng nhất của cycle — vì nó là thứ giữ cho hồ sơ này đáng tin khi bộ đếm của tôi hỏng.
4. **Một guard của tôi bắt sai, và tôi đã sửa guard chứ không sửa file.** Guard đọc đuôi `docs/28` tôi viết `"...distinct receipts."` trong khi dữ liệu thật là `"...distinct receipts,"` có dấu phẩy. Đây là lần thứ mười mấy của lỗi đoán chuỗi; tôi **không** nới check, tôi in ra 130 ký tự đầu để lấy chuỗi thật rồi viết lại guard. Và điều đáng nói ở đây: khi một guard **đỏ**, phản ứng đúng là **nghi ngờ guard trước**, vì guard là thứ tôi viết, còn file là thứ người khác viết.
5. **Điều tôi làm ĐÚNG:** (a) **quét fragment tìm lỗi chính tả TRƯỚC khi ghi vào repo** — biện pháp này bắt được lỗi ở Mục 67 và tôi giữ nó; (b) **đọc 3 dòng cuối nguyên văn** trước khi viết guard; (c) **kiểm tra va chạm header** — 6 header mới đều trống; (d) **duyệt toàn cây** kiểm tra trùng tên cho mọi file mới; (e) **đếm `test.failing` ở từng file** và đối chiếu với trạng thái các cycle trước — chính việc này phát hiện ra 13 khối mới; (f) **không** sửa `review.md`; (g) ghi 3 finding của Muc 49 mà **không** sửa và **không** tự nâng thành gate; (h) khi đọc Mục 49, tôi ghi lại **giới hạn của harness** tách khỏi **thiếu sót của sản phẩm** vì tác giả phân biệt rõ, và ghi lại **cả** tự sửa của ông chứ không chỉ kết quả đẹp.
6. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice round-trip byte-identical; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.71.0 → 1.72.0** đúng một chỗ.

## 71 — CYCLE 71: D-DOCS-EVID-SYNC-349 — TÔI SỬA MỘT CON SỐ MÀ TÔI ĐÃ ĐO BẰNG PHÉP CỘNG; và một receipt trùng TÊN nhưng KHÔNG phải bản chép

> **RESUME POINT — cycle 71 (packet D-DOCS-EVID-SYNC-349, task `task_1e3a91b40c90`, dispatch `ctx_1e3a91b40c90`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–70 giữ nguyên phía trên như lịch sử.
> 1. **Tôi phải sửa lại con số tôi đã ghi ở Mục 70.** Tôi viết *"toàn cây 25 khối ở 6 file"* — con số đó **suy ra bằng phép cộng**, không phải bằng đo. Đo thật: **30 khối ở 9 file**. Sai ở **cả** số khối lẫn số file. E1.
> 2. **Một receipt trùng TÊN nhưng là công việc MỚI**, và tôi phân loại bằng task id + mốc thời gian chứ không bằng tên. E7.
> 3. **Có receipt mang ngày 2026-10-01** cho cả đợt này. E2.
> 4. **Bắt được một va chạm tên file** (`package-boundary` ×2, `manifest` ×3) — cùng loại bẫy tôi đã ghi ở Mục 66, và tôi lại tránh được bằng cách duyệt **toàn cây**. E4.
> 5. **`docs/28` giữ version 1.48.0** — bump **1.72.0 → 1.73.0** là version của **docs/35**.

### 71.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E1 | **TÔI SỬA LỘI CON SỐ CỦA CHÍNH MÌNH** | Ở Mục 70 tôi ghi: *"test.failing toàn cây giờ là 25 khối ở 6 file (12 khối cũ + 13 khối mới)"*. Con số đó **được suy ra bằng cộng**, không đo. Tôi quét **toàn cây** lần này: **30 khối ở 9 file**. Sai **cả** số khối lẫn số file, và sai ở đúng chỗ tôi đã viết ba cycle liên tiếp rằng *"phải đo chứ đừng suy luận"* |
| E2 | **Toàn bộ receipt của đợt này mang ngày 2026-10-01** | package-boundary 00:28:25 · manifest follow-up 00:40:56 · bounded-input follow-up 00:54 · analyze 01:08 · và các receipt độc lập lúc 00:25:01 và 01:06:14. Settlement đã đi tới **Turn 362** với mốc 2026-10-01T00:54. Đợt này **không trộn nhiều ngày** như ba đợt trước |
| E3 | **Phân loại receipt: 5 mới, 3 xác minh độc lập, 4 bản chép** | Mới: `W-DOC-CORE-PACKAGE-BOUNDARY-NEGATIVE` · follow-up `task_7a1b92c40ed9` (manifest) · follow-up `task_7a1b92c40eda` (bounded-input) · `W-DOC-CORE-ANALYZE-NEGATIVE` · và receipt trùng tên ở E7. Độc lập: input-contract+package-boundary · service-auth+output-validation (bản mới) · stream-bounds+bounded-input. Bản chép nguyên văn: 4 receipt, xem E6 |
| E4 | **BẮT ĐƯỢC VA CHẠM TÊN FILE — và đây là lần thứ hai trong các cycle gần đây** | Cây có **hai** file `package-boundary.test.ts` (document-core: 6 `it()` + 2 `test.failing`; example-review: 3 `it()`, 0 failing) và **ba** file `manifest.test.ts` (document-core, contracts với 20 `it()`, example-review với 4). Tôi phân giải receipt theo **đường dẫn test mà receipt ghi** và **thư mục làm việc**, **không** lấy hit grep đầu tiên. Lấy hit đầu tiên sẽ tạo ra mục inventory **sai** mà vẫn **trông rất hợp lý** |
| E5 | **Đếm từ source — bốn file khớp receipt, hai file tôi ghi cả hai số** | package-boundary **6 + 2 failing = 8** khớp · bounded-input **47** khai báo **bằng** chạy, 0 failing, khớp chính xác · analyze **12 `it()` + 1 khối bảng + 1 failing** so với receipt nói **19** — tôi ghi cả hai, **không** ép khớp · manifest **10 + 1 khối bảng + 2 failing** so với **15** — tôi ghi cả hai |
| E6 | **Bốn bản chép nguyên văn** | suite-bootstrap-contract (task_7a1b92c40ed5, 2026-09-30 23:30:38) · connector-invoker-and-config independent (task_1a1a8e94f0e8, 23:58:46) · config (task_7a1b92c40ed6, 23:49:51) · worker-service-auth (task_1b2b104c8f20, 2026-10-01 00:00:06). Tổng **15** lần trên **11** receipt |
| E7 | **MỘT RECEIPT TRÙNG TÊN NHƯNG KHÔNG PHẢI BẢN CHÉP** | `T-CODEX-OFFLINE-SERVICE-AUTH-AND-OUTPUT-VALIDATION-INDEPENDENT` xuất hiện **hai** lần: bản cũ ở L10245 mang `task_2e8a104c91bf` lúc **2026-09-29T05:47:34**; bản ở L11175 mang **`task_1a1a8e94f0e9` lúc 2026-10-01T00:25:01**. Khác task, khác mốc ⇒ đây là **một lần xác minh độc lập MỚI**, không phải bản sao. Tôi phân loại theo **task id và mốc**, không theo tên — vì khớp tên mà đặt nhầm sẽ **đếm thiếu** đợt này |
| E8 | **Minh bạch giữ được: cả hai khối mới đều ĐƯỢC NÊU TÊN trong receipt** | package-boundary nêu rõ entry point **export module nội bộ** và `package.json` **không có** `exports` map hạn chế, với đúng hai probe; manifest nêu rõ một **action chưa đăng ký nhưng khớp handler kind vẫn được chấp nhận**. Mẫu *giấu expected-failure* đã **không** tái diễn ở đợt này |
| E9 | **Hai finding đáng để đọc** | (1) package-boundary là lỗ **đóng gói** chứ không phải logic: entry point lộ module nội bộ và không có `exports` map hạn chế. (2) manifest chấp nhận **action chưa đăng ký** — đây là lỗ **acceptance** thật, vì một action không có handler đăng ký vẫn lọt qua validator |
| E10 | **Một assertion mạnh hơn nhiều trong analyze** | Không chỉ *"timeout được phát hiện"* mà là timeout **truyền lên, không fallback và không retry**. Phát hiện timeout là khẳng định yếu hơn chứng minh nó **không bị nuốt im lặng** — và một fallback im lặng sẽ biến một lỗi suy luận thành kết quả trông hợp lý |
| E11 | **Bounded input là nửa không hào nhoáng của việc phòng thủ** | descriptor vượt trần bị từ chối **trước khi** truyền chứ không phải sau; stream **0 byte** với kích thước được cấp **khác 0**; truyền artifact bị cắt; multipart body bị cắt; **lệch boundary/body**; và nguồn non-seekable bị lỗi. Tất cả là loại kiểm tra mà dễ bị coi là hiển nhiên |
| E12 | **Ba xác minh độc lập, ghi thành tầng bằng chứng riêng** | Một xác nhận lại connector input contract và package-bounday ở số mới; một xác nhận stream bounds và bounded input. Tôi **không** gộp chúng vào mục gốc, vì gộp làm mất thông tin về **ai đã kiểm chứng cái gì** — và chỉ khi tách ra thì mới thấy được một suite đã tích luỹ được bao nhiêu xác nhận độc lập thật sự |
| E13 | Link checker ×3 | Chạy sau khi ghi xong, trên trạng thái disk cuối — xem E14 |
| E14 | **TARGETS: tôi ghi số đo được, và tôi truy nguồn nếu nó đổi** | Số thật của lần chạy cuối nằm ở E13 trong bảng cố định; nếu khác số census thì tôi ghi kèm nguyên nhân thay vì ghi "không đổi" theo thói quen |
| E15 | Anchor | Chèn ledger-71 làm mọi dòng ≥ L432 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1692` → **`#L1693`**; `docs/06:75` đi `#L3205` → **`#L3206`**, đều content-assert |
### 71.2 Δ

- **Δ-A72-1 (tôi sửa lại con số của chính mình, và đây là lần thứ ba trong ba cycle phải tự thu hồi một phát biểu):** Ở Mục 70 tôi viết *"test.failing toàn cây giờ là **25 khối ở 6 file** (12 khối cũ + 13 khối mới)"*. Con số đó **suy ra bằng phép cộng**, không đo. Quét toàn cây lần này: **30 khối ở 9 file**. Sai **cả** số khối lẫn số file. Điều đáng nói là nó sai **đúng chỗ** tôi đã viết ba cycle liên tiếp rằng phải đo chứ đừng suy luận — tôi đã viết quy tắc đó cho người khác rồi lại vi phạm nó với chính con số của mình. Ba lần tự thu hồi dần dạy tôi điều mà một lần không dạy: **một phát biểu về trạng thái hiện tại mà không kèm phép đo là một con số nghi ngờ**, và phải ghi nó xuống ngay khi có thể đo được.
- **Δ-A72-2 (một receipt trùng TÊN nhưng là công việc MỚI — và tôi phân loại bằng task id chứ không bằng tên):** `T-CODEX-OFFLINE-SERVICE-AUTH-AND-OUTPUT-VALIDATION-INDEPENDENT` xuất hiện **hai** lần trong `tester.md`: bản cũ ở L10245 mang `task_2e8a104c91bf` lúc **2026-09-29T05:47:34**, bản ở L11175 mang **`task_1a1a8e94f0e9` lúc 2026-10-01T00:25:01**. Khác task, khác mốc ⇒ một lần xác minh độc lập **mới**. Điều này ngược lại với **bốn** bản chép thật sự cùng kỳ, và hai nhóm đó chỉ phân biệt được bằng **task id và mốc thời gian**. Nếu tôi phân loại theo tên — cách rẻ nhất — tôi sẽ **gộp nhầm** một receipt mới vào nhóm bản chép và **đếm thiếu** đợt này, hoặc ngược lại làm số bản chép to lên. Tôi ghi cả hai sự thật riêng biệt.
- **Δ-A72-3 (lần thứ hai trong các cycle gần đây tôi tránh được một va chạm tên file, và tôi coi đây là bài học đã thành thói quen):** cây này có **hai** file `package-boundary.test.ts` và **ba** file `manifest.test.ts`. Tôi phân giải receipt theo **đường dẫn test mà receipt ghi** cùng **thư mục làm việc**, không lấy hit grep đầu tiên. Lần đầu tôi gặp bẫy này ở Mục 66 và suýt đếm sai; lần này tôi duyệt toàn cây **ngay từ đầu** nên không tốn vòng nào. Một mục inventory sai mà **trông hợp lý** nguy hiểm hơn một mục thiếu, vì người đọc không có cách nào biết nó sai.
- **Δ-A72-4 (minh bạch giữ được ở đợt này, và đây là điều tôi theo dõi suốt mấy cycle):** cả **hai** khối expected-failure mới đều được **nêu tên** trong receipt — entry point lộ module nội bộ cùng việc thiếu `exports` map, và việc một action chưa đăng ký nhưng khớp handler kind vẫn lọt validator. Mẫu *giấu expected-failure* đã **không tái diễn**. Nhưng tôi vẫn **đếm từ file** ở cả hai, vì đây là bài học rẻ nhất: một lần duy nhất trong đợt này mà tôi tin receipt mà không kiểm thì tôi sẽ không biết con số thật của cả cây là bao nhiêu.
- **Δ-A72-5 (hai finding khác nhau về bản chất, và tôi không gộp chúng):** package-boundary là lỗ **đóng gói** — entry point phơi ra module nội bộ và manifest không khai báo `exports` map, tức ranh giới package không được cưỡng chế ở mức consumer. Manifest là lỗ **acceptance** — một action không có handler đăng ký vẫn được validator chấp nhận, tức hợp đồng cho phép điều mà hệ thống không thực sự hỗ trợ. Gộp hai thành một mục *"các finding của đợt này"* sẽ làm mất chính cái phân biệt đó.
- **Δ-A72-6 (bốn bản chép, và tôi vẫn không vẽ xu hướng):** tổng **15** lần chép trên **11** receipt. Chuỗi bốn cycle gần nhất: 2, 0, 1, 1 — **không phải một hướng**, và tôi nói thẳng điều đó thay vì để dãy số tự nói lên. Tôi cũng ghi rõ **vì sao tôi không vẽ**: với bốn điểm rời rạc như thế, "tăng" và "ngẫu nhiên" không phân biệt được, và tôi không có quan sát nào về cơ chế append để biết nó đã đổi hay chưa.
- **Δ-A72-7 (bốn file đối chiếu khớp, hai file tôi ghi cả hai số):** package-boundary 6 + 2 = **8** khớp · bounded-input **47** khai báo bằng chạy, khớp chính xác — file sạch nhất của đợt · analyze và manifest thì **không** khớp số chạy của receipt, và tôi ghi **cả hai số cạnh nhau**. Tôi đã học từ Mục 70 rằng bộ đếm của tôi **không đáng tin** với bảng có object và URL, nên lần này tôi **không** thử ép nó cho khớp — tôi chỉ ghi số khai báo (đáng tin) và số của receipt, rồi nói rõ phần nào chưa kiểm.
- **Δ-A72-8:** `ENC-04`, `G-ENC`, `G-DATA`, `G-ADMIN-OPS`, `G-SEC`, `G6` vẫn **NO-GO**; `ADM-UX-14`, `ADM-UX-11`, `ADM-UX-09` vẫn `[~]`. Tất cả receipt đều test-only và **không** sửa production source. Δ69/Δ66/Δ74–Δ79/Δ81–Δ116 còn mở. `test.failing` toàn cây: **30 khối ở 9 file** (đo được ở đợt này).
### 71.3 Lỗi của chính tôi

1. **Tôi ghi một con số mà tôi KHÔNG đo, rồi nó sai.** Ở Mục 70 tôi viết *"25 khối ở 6 file"* — con số đó tôi **cộng ra** từ hai con số tôi nhớ, chứ không quét cây. Đợt này tôi quét thật: **30 khối ở 9 file**, sai **cả** số khối lẫn số file. Đáng nói nhất là nó sai **đúng chỗ** tôi đã viết ba cycle liên tiếp rằng *"phải đo chứ đừng suy luận"* — tôi đã viết quy tắc đó cho người khác rồi tự vi phạm với con số của chính mình. Bài học tôi rút ra sau **ba** lần tự thu hồi: một phát biểu về trạng thái hiện tại mà không kèm phép đo thì **nên coi là con số nghi ngờ ngay từ lúc viết**, không phải đợi đến khi người khác phát hiện.
2. **Tôi dừng bộ đếm ở chỗ nó không đáng tin, thay vì ép nó cho khớp.** Bộ đếm bảng của tôi hỏng với bảng có object chứa dấu phẩy và URL — tôi đã chứng minh điều đó ở Mục 70 bằng hai phương pháp cho ra 5 và 2 dòng trên cùng một bảng. Đợt này tôi **không** thử lại để ép con số receipt; tôi ghi số khai báo (đáng tin) cạnh số receipt và nói rõ phần nào chưa kiểm. Đây là hệ quả trực tiếp của việc công nhận giới hạn công cụ ở cycle trước.
3. **Một guard quá rộng lần nữa — dạng lỗi tôi đã mắc nhiều lần.** Guard kiểm "chuỗi cũ không còn trong file" sẽ **đòi** một con số biến mất khỏi *cả* file, trong khi bản ghi lịch sử của Mục trước **đúng là** vẫn chứa nó. Tôi thu hẹp guard chỉ trong vùng Mục 71 và **assert bản ghi Mục trước không đổi một byte**. Đây là lần thứ hai trong ba cycle (lần trước là guard typo quét cả file và trúng vào trích dẫn có chủ đích ở Mục 67) — và cùng một nguyên nhân: **guard viết bởi tôi thì đáng nghi hơn dữ liệu do người khác viết**.
4. **Điều tôi làm ĐÚNG:** (a) **quét toàn cây** tìm `test.failing` và tìm ra sai số của chính mình trước khi ghi bất cứ thứ gì; (b) **duyệt toàn cây** tìm tên file trùng **ngay từ đầu**, nên tránh được bẫy đã từng làm tôi mất vòng ở Mục 66; (c) **phân loại receipt bằng task id và mốc thời gian**, không bằng tên — nhờ đó một receipt trùng tên được tính là việc mới thay vì bị gộp nhầm vào nhóm bản chép; (d) **quét fragment tìm lỗi chính tả trước khi ghi vào repo**; (e) đọc **3 dòng cuối nguyên văn** trước khi viết guard; (f) kiểm tra va chạm header — 7 header mới đều trống; (g) **không** sửa `review.md`; (h) ghi hai finding của đợt này mà **không** gộp làm một, vì chúng thuộc hai loại khác nhau (**đóng gói** và **acceptance**).
5. **Không có lỗi nào ở docs/28 hay docs/35:** cả hai qua splice **round-trip byte-identical**; `docs/28` giữ nguyên version **1.48.0** và `endsNL=False`, CRLF 1077 không đổi; `docs/35` bump **1.72.0 → 1.73.0** đúng một chỗ.

## 72 — CYCLE 72: D-DOCS-EVID-SYNC-350 — Hai module cùng một khẳng định về timeout: KHÔNG fallback, KHÔNG bịa kết quả. Và số `test.failing` toàn cây đã lên 40

> **RESUME POINT — cycle 72 (packet D-DOCS-EVID-SYNC-350, task `task_1e3a91b40c91`, dispatch `ctx_1e3a91b40c91`, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–71 giữ nguyên phía trên như lịch sử.
> 1. **5 receipt mới + 2 bản chép nguyên văn.** Tất cả tests-only, **zero production source edits**.
> 2. **Hai module nói cùng một khẳng định về timeout** — phát hiện *truyền lên* khác nhiều so với chứng minh *không bị nuốt* và *không bịa kết quả*. E3.
> 3. **`test.failing` toàn cây: 40 khối ở 14 file** — đo, không suy luận. E7. Năm file trong số đó **không** có receipt nào trong packet này, và tôi ghi ra điều đó. E8.
> 4. **`docs/28` giữ version 1.48.0** — bump **1.73.0 → 1.74.0** là version của **docs/35**.

### 72.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 2 receipt owner mới: `W-DOC-CORE-EXTRACT-NEGATIVE` (tester **11464**, task_7a1b92c40edc, **2026-10-01 01:23**) · `W-DOC-CORE-TRANSFORM-NEGATIVE` (tester **11494**, task_7a1b92c40edd, **01:37**). Ba receipt xác minh độc lập. Hai bản chép nguyên văn. Đối chiếu settlement Turn 363–366 (Wave 9, 10, 11) |
| E1 | **Xác nhận nguồn bằng task id + mốc, không bằng tên** | `W-DOC-CORE-BOUNDED-INPUT-NEGATIVE` (L11359, task_7a1b92c40eda, 00:54) và `W-DOC-CORE-ANALYZE-NEGATIVE` (L11404, task_7a1b92c40edb, 01:08) **không đổi** so với Mục 71 — **không** ghi lại. Đây là cách tôi giữ kỷ luật ở Mục 71, và nó vẫn hiệu quả |
| E2 | **Extract: 21 test, 0 production** | Chỉ `extract.test.ts`; 3 lần × 1 suite / **21 passed** (**63 executions**); `tsc` 0. Đếm từ source: **15 `it()` + 1 `test()`**, trong đó **1 là khối bảng**, cộng **2 `test.failing`**. Tôi ghi **cả hai số** (15+1+2 vs 21) — không ép khớp |
| E3 | **ĐIỂM QUAN TRỌNG NHẤT: HAI MODULE NÓI CÙNG MỘT KHẲNG ĐỊNH** | Cả `extract` và `transform` đều khẳng định provider timeout **TRUYÊN LÊN** và **KHÔNG** có fallback/synth output/kiểm tra lặp. Tác giả ghi rõ đây là khẳng định **mạnh hơn** việc chỉ phát hiện timeout: một timeout **nuốt im lặng** sẽ biến một lỗi trích xuất thành **một tài liệu trông hợp lý**. Hai module, hai lane, cùng một ý tưởng |
| E4 | **Transform: 13 test, khớp chính xác** | Chỉ `transform.test.ts`; 3 lần × 1 suite / **13 passed** (**39 executions**); `tsc` 0. Đếm từ source: **12 `it()` + 1 `test.failing`** = **13** — khớp receipt. Một probe `test.failing` ghi hành vi hiện tại |
| E5 | **Ba receipt xác minh độc lập** | `T-CODEX-OFFLINE-MULTIPART-AND-ANALYZE-INDEPENDENT` (01:11, `task_1a1a8e94f0ee`): multipart **30 passed**, analyze **19** · `T-CODEX-OFFLINE-TEMP-WORKSPACE-AND-EXTRACT-INDEPENDENT` (01:36, `task_1a1a8e94f0f0`): temp-workspace **19**, extract **21** · `T-CODEX-OFFLINE-CONNECTOR-SESSION-AND-TRANSFORM-INDEPENDENT` (01:45, `task_1a1a8e94f0f1`): connector-session **53**, transform **13** |
| E6 | **Đếm từ source, 6 file** | extract **15 it + 1 test + 1 bảng + 2 failing** · transform **12 it + 1 failing** = 13 ✓ · multipart **30 it** ✓ · analyze **12 it + 1 bảng + 1 failing** vs **19** · temp-workspace **15 it + 1 bảng** vs **19** · connector-session **159 executions** |
| E7 | **`test.failing` toàn cây: 40 khối ở 14 file — đo, không suy luận** | Quét **toàn cây**: `output-validation` 13 · `ingest-scan-fixtures` 5 · `ingest-scan-tamper` 3 · `generate` 3 · `compare` 2 · `extract` 2 · `ingest` 2 · `ingest-source-pin` 2 · `manifest` 2 · `package-boundary` 2 · `parser-budget-band` 1 · `ingest-wire` 1 · `transform` 1 · `analyze` 1. Mục 70 tôi ghi **25/6** — con số đó **suy ra**, không đo |
| E8 | **NĂM FILE TRONG 14 FILE ĐÓ KHÔNG CÓ RECEIPT NÀO TRONG PACKET NÀY** | `generate`, `compare`, `ingest`, `parser-budget-band`, `ingest-wire` mang `test.failing` nhưng **packet này không nêu tên**. Tôi ghi ra để coordinator thấy: **phạm vi packet ≠ phạm vi cây**, và tôi **không** tự gộp những file đó vào mục riêng |
| E9 | **Hai receipt ĐÃ ĐƯỢC GHI: tôi không ghi lại** | bounded-input (L11359, 00:54) và analyze (L11404, 01:08) **không đổi** — cùng task, cùng mốc, cùng kết quả. Ghi lại sẽ tạo **số liệu trùng lặp** mà sau này người đọc dùng để phân biệt receipt thật và receipt sao |
| E10 | **Bảy file mới, không file nào trùng tên** | Tôi vẫn **duyệt toàn cây** cho cả 7 file mới: mỗi tên **đúng 1 file**. Mục 66 từng bắt ba file trùng tên và tôi đếm sai; lần này không có gì |
| E11 | **Ba file đã có EOL hỗn tạp** | extract **324 CRLF / 72 bare LF** · transform **180 / 65** · analyze **234 / 66**. Cả ba test-only, nhưng người sửa **phải đọc trước** |
| E12 | **Bốn dòng mốc ngày trong một đợt** | 01:11 · 01:23 · 01:36 · 01:45 — tất cả **2026-10-01**. Settlement lên tới Turn 366 |
| E13 | Link checker ×3 | S0 **FILES=8 TARGETS=1068 ANCHORS=656 BROKEN=0**; S1 **FILES=11 TARGETS=1152 ANCHORS=738 BROKEN=0**; TREE **FILES=213 TARGETS=1889 BROKEN=2** — cung hai link hong co san o antigravity-6.md:8952 va requests/antigravity.md:10, ngoai lane |
| E14 | — TARGETS: TÔI ĐÃ GHI SỐ CHƯA ĐO, SỬA LẠI | Bản đầu tôi viết **1067 → 1067, 1151 → 1151: không đổi** **trước khi** chạy link check. Số thật của lần chạy cuối: S0 **1067 → 1068**, S1 **1151 → 1152**, TREE FILES **211 → 213**. Tôi truy nguồn thay vì đoán: quét cả 7 fragment của cycle này + khối Mục 72 + dòng ledger-72 → **0** markdown link. Nên phần tăng **không** do tôi, mà do lane khác ghi vào cây trong cùng cửa sổ packet |
| E15 | Anchor | Chèn ledger-72 làm mọi dòng ≥ L433 dịch +1: `docs/28:678` + `docs/35:839` đi `#L1693` → **`#L1694`**; `docs/06:75` đi `#L3206` → **`#L3207`**, đều content-assert |
### 72.2 Δ so với cycle 71

| Δ | Nội dung |
|---|---|
| Δ-A73-1 | **Sửa số liệu từ Mục 70.** Mục 70 ghi `test.failing` toàn cây là "25 khối ở 6 file". Tôi đã viết con số đó bằng cách **cộng hai con số nhớ**, chứ không đo. Cycle 71 đo lại: **30/9**. Cycle 72 đo lại: **40/14**. Nguyên tắc tôi rút ra và ghi lại: **một phát biểu về trạng thái hiện tại mà không kèm phép đo thì coi là con số nghi ngờ ngay từ lúc viết** |
| Δ-A73-2 | **Đổi câu hỏi, không chỉ đổi số.** Cycle 71 hỏi "bao nhiêu test mới". Cycle 72 hỏi "**hai module nói cùng một khẳng định gì**". extract và transform không hề biết nhau; chúng ở hai file khác nhau, hai chạy khác nhau. Cái chung là **một tuyên bố về hành vi khi lỗi**, không phải về hành vi khi thành công |
| Δ-A73-3 | **Tách phạm vi packet khỏi phạm vi cây.** Tôi cũng đã từng gộp những file không có receipt vào mục của mình. Lần này tôi ghi rõ: **40 khối / 14 file là cây; 5 file trong đó không có receipt trong packet này.** Hai con số cùng đúng, và người đọc cần thấy cả hai |
| Δ-A73-4 | **`endsNL=False` là thuộc tính của file, không phải của mục.** Cả `docs/28` và `docs/35` đều **không** có newline cuối; splice ở giữa file không được phép thêm hay bỏ nó |
| Δ-A73-5 | **Nhãn Δ của mục này mang số 73, không phải 72.** Quy ước của lane là tiền tố = **số mục + 1**: Mục 70 dùng Δ-A71-\*, Mục 71 dùng Δ-A72-\*. Tôi soạn thảo với Δ-A72-\* và chỉ phát hiện ra khi đếm nhãn toàn file; Δ-A72-1..8 **đã thuộc về Mục 71**. Nếu tôi ghi đè, hai mục liên tiếp sẽ dùng chung một bộ nhãn và người đọc không còn phân biệt được phát hiện của cycle nào |
### 72.3 Lỗi của chính tôi trong cycle này

**1. Header fragment của tôi tự đụng header của Mục 71.**
Tôi đặt tiêu đề ghi chú cho hai receipt trùng lặp là `### Two receipts already on record: verbatim re-appends` — trùng **đúng** tiêu đề Mục 71 của tôi, ở L1901 của `docs/28`. Bộ kiểm tra va chạm bắt được trước khi tôi ghi. Tôi đổi thành `### Wave 10/11 — two receipts already on record: verbatim re-appends`. Đây là lần thứ hai trong vài cycle: tôi viết một tiêu đề ngắn, dễ trùng với chính tiêu đề tôi đã viết ở cycle trước, rồi bắt lỗi bằng bộ kiểm tra chứ không bằng đọc tới cuối. Bài học tôi ghi: **tiêu đề phải mang dấu hiệu của cycle, không chỉ mang nội dung**

**2. Tôi suy luận rồi báo như đo — lần thứ hai, ngay sau khi đã tự sửa ở cycle 71.**
Con số 25/6 trong Mục 70 là cộng hai con số nhớ. Ở cycle 71 tôi đã viết nguyên tắc "không có phép đo thì coi là nghi ngờ" — rồi ở cycle 72 tôi lại phát biểu về trạng thái cây **trước khi** quét, và chỉ quét sau. Kết quả quét đã xác nhận con số, nên may mắn không thành sai sót — nhưng **thứ tự** là sai, và thứ tự sai nghĩa là lần sau có thể ra con số sai. Tôi ghi Δ-A73-1 vì lỗi này không nằm trong kết quả, nó nằm trong cách tôi tiến tới kết quả

**3. Tôi suýt ép hai con số không khớp cho khớp.**
extract: receipt ghi 21, đếm source ra 15 `it()` + 1 `test()` + 1 khối bảng + 2 `test.failing`. analyze: receipt ghi 19, đếm ra 12 `it()` + 1 bảng + 1 failing. transform khớp chính xác 13. Trước đây tôi có lần ép số cho khớp và ghi "khớp". Lần này tôi ghi **cả hai số** trong E2/E6 và nói rõ chỗ nào khớp, chỗ nào không. Một bảng evidence mà mọi ô đều khớp là dấu hiệu cho thấy người lập bảng đang chọn số cho vừa, chứ không phải đang đo

**4. Tôi biết `BROKEN=0` không chứng minh đích đến.**
Bộ kiểm tra link chỉ chứng minh `1 <= n <= sốDòng`. Sau mỗi lần chèn ledger, mọi dòng phía dưới dịch +1, và một `#L####` sai vẫn "hợp lệ". Tôi content-assert từng đích (in ra dòng thật, đối chiếu nó là header mong đợi) thay vì tin con số dòng. Đây không phải phát minh cycle này — nó là quy tắc của lane, và tôi giữ nó vì một lần tôi đã từng tin số dòng

**5. Tôi phải tự kiểm tra công cụ trước khi bảo người khác rằng công cụ hỏng.**
Sai lệch đếm ở Mục 66 (ba file trùng tên, tôi đếm sai) và ở `admin-overview-triage` (regex cho 42, receipt ghi 57 — hoá ra có 6 khối `test.each` cấp 21 dòng) đều là lỗi **của bộ đếm**, không phải của người viết receipt. Quy tắc: **bộ đếm phải được kiểm chứng trước khi tôi trở thành người đưa ra nhận định về nó** — nếu không, tôi sẽ ghi "sai số" vào receipt của người khác

**6. TÔI VIẾT E13/E14 TRƯỚC KHI CHẠY LINK CHECK, RỒI SỐ TRONG RECEIPT SAI.**
Tôi soạn cả bảng evidence trước, rồi mới chạy link check. Hai ô E13/E14 của tôi lúc đó ghi số **dự đoán** (viết `không đổi`), và số đo được là **1068 / 1152 / 213** — sai cả ba. Đây là lần thứ ba trong vài cycle tôi viết số trước khi đo (sau 25/6 ở Mục 70 và số census trong tin status cycle 70). Chính Mục 70 đã dạy tôi cách xử lý đúng: **đo trước, nếu số đổi thì truy nguồn, đừng viết `không đổi` theo thói quen**. Tôi quên ngay bài học của mục trước. Tôi sửa ở E13/E14 và ghi luôn việc sửa này, thay vì âm thầm thay số

## 73 — CYCLE 73: D-DOCS-EVID-SYNC-371 — Bốn module cùng một khẳng định về timeout, và một mutation không bao giờ đỏ

> **RESUME POINT — cycle 73 (packet D-DOCS-EVID-SYNC-371, lane Qwen-Docs).**
> Mục này nằm cuối file; Mục 1–72 giữ nguyên phía trên như lịch sử.
> 1. **6 receipt mới, 0 bản chép lại.** Ba lane. Tất cả tests-only, **zero production source edits**.
> 2. **Khẳng định no-fallback đã lan ra 4 module** — extract, transform (cycle 72) và nay compare, generate. E3.
> 3. **Bốn lỗi bảo mật được ghi, KHÔNG sửa** trong crypto-config wiring. E6.
> 4. **Một mutation xanh khi nó chưa vô hiệu hoá gì cả** — bằng chứng mutation mạnh nhất wave này. E9.
> 5. Packet nói `stat`; **không có receipt `artifact-stat` mới** — tôi ghi việc này ra thay vì tự bịa. E2.

### 73.1 Bằng chứng

| # | Kiểm tra | Kết quả đo được |
|---|---|---|
| E0 | **Định vị + kiểm chéo** | 6 receipt mới: `W-ADM-UX-20-CRYPTO-CONFIG-WIRING-NEGATIVE` (qwen-admin **5785**, task_9c91a4038e95) · `W-PLAT-CR28-11-RECIPIENT-KEY-REGISTRY-NEGATIVE` (qwen-platform **4771**, task_7d8e2194b401) · 4 receipt ở tester **11537 / 11570 / 11582 / 11593** |
| E1 | **Phân loại theo task id, và wave này sạch** | Cả 6 task id trả **0 hit** ở docs/28, docs/35 và qwen-docs. **0 bản chép lại** — ngược với cycle 72 có 2. Đây là lần đầu nhiều cycle tôi không phải viết mục already-on-record |
| E2 | **PACKET NÓI `stat`, TÔI KHÔNG CÓ RECEIPT `stat` MỚI** | `artifact-stat` **đã có trên record** từ docs/28 L1199, L1346, L1415, và **không** có receipt mới trong cửa sổ này. Receipt thật là `T-CODEX-OFFLINE-METADATA-AND-COMPARE-INDEPENDENT` (read-**metadata** + compare). Tôi ghi receipt thật và ghi ra chỗ lệch, **không** tự chế một mục `stat` cho đủ với packet |
| E3 | **ĐIỂM CHÍNH: KHẲNG ĐỊNH NO-FALLBACK GIỜ Ở BỐN MODULE** | Cycle 72: extract + transform. Wave này: **compare** (timeout propagation without retry/synthesis) + **generate** (timeout propagates without retry or synthesized output). Bốn module **không chung code, khác tác giả, khác lane**. Một khẳng định mà không ai kiểm thì là khẳng định không ai kiểm; ở đây có bốn người độc lập cùng chốt |
| E4 | **Admin crypto-config: 122 kiểm bằng TAY, không tin bộ đếm** | **78 khai báo** (46 `it()` + 32 `test()`) + **25 dòng** ở 5 khối `it.each` viết inline + **19 dòng** ở 4 khối `test.each` trỏ hằng (`badDelivery` 3, `badKeyRef` 5, `badPin` 7, `junkBodies` 4) = **122**. Khớp receipt |
| E5 | **Ba baseline, một con số — và tôi nói rõ cái nào tôi đo được** | HEAD **23**, cây làm việc ngay trước Mục 64 **71**, sau Mục 64 **122** ⇒ delta thuộc Mục 64 là **+51**, không phải +99 như diff với HEAD. Tôi **tự đo được** mốc 122. Tôi **KHÔNG** tự dựng lại được mốc 71 (file chưa commit) nên tôi ghi nó theo lời receipt, không biến nó thành số tôi đo |
| E6 | **BỐN LỖI BẢO MẬT — GHI, KHÔNG SỬA** | (1) bearer VIEWER ghi được cấu hình khi **không gửi cookie**, vì `requireWriteAuth` chỉ kiểm `auth.cookieRole === viewer` còn bearer-only để `undefined` ⇒ nhánh chặn **không bao giờ chạy**; (2) cookie không xác minh được bị coi là *không có cookie* ⇒ **tắt luôn** kiểm CSRF; (3) phiên không bao giờ bị vô hiệu hoá (hết hạn, `iat` sau `exp`, ký bằng secret lạ → đều 200); (4) body không phải object là no-op 200 im lặng, không phải 422 |
| E7 | **Phần thật sự vững, và đáng giữ lại** | CSRF binding là kiểm duy nhất giữ được: token ký từ **một session hợp lệ khác** → 403. Validate field sai kiểu → 422 với **store không đụng, audit rỗng**. Field lạ bị loại và **không** tới audit. Cô lập tenant đúng ở **cả đọc lẫn ghi**. Một receipt báo cả hai nửa đáng giá hơn receipt chỉ báo nửa đạt |
| E8 | **Hai probe sai đã suýt thành phát hiện giả** | Dùng bearer **platform** làm mọi ca cookie/CSRF trả 200 — vì `requireWriteAuth` **cố ý** bỏ qua CSRF cho platform (chế độ máy-máy), không phải lỗ hổng. Và `pinnedRecipientKeyVersion` là tên *stored*, tên *request* là `recipientKeyVersion`. Cả hai là lỗi fixture, không phải bug sản phẩm |
| E9 | **MUTATION THẤT BẠI Ở LẦN ĐẦU, VÀ ĐÓ LÀ Bằng chứng tốt nhất wave** | Lần 1 sửa guard thành `key.version !== version + 0` ⇒ suite **vẫn xanh 49/49**. Vì `+ 0` là phép cộng vô nghĩa nên điều kiện **y hệt**, tức **chưa vô hiệu hoá được gì cả**. Tác giả nhận ra vì **đọc kết quả** thay vì giả định xanh là được bảo vệ. Lần 2, `key.version !== key.version`, đỏ đúng: **1 failed, 48 passed**. Một mutation **không bao giờ đỏ** thì chưa đo được gì |
| E10 | **Recipient-key-registry: 49 khớp chính xác** | **21 khai báo** (5 `it()` + 16 `test()`) + **28 dòng** ở 7 khối `it.each`, **0 expected failure** = **49**. Tôi cũng tái tạo đúng `5eb49ab8` / 35249 B / LF mà receipt ghi. Khôi phục byte-identical `d44a7e41`, đếm lại **2** chốt guard còn nguyên |
| E11 | **Hai deviation mới** | **Δ117** — `recordForTenant` trả `REGISTRY_UNAVAILABLE` nhưng thông điệp **không nêu tenant nào**, nên operator không biết bắt đầu điều tra từ đâu (giữ thông điệp chung là đúng về bảo mật, nhưng thiếu dữ liệu điều tra). **Δ118** — `completeRegistration` so challenge với input **chứ không** so với người gọi, nên lớp này **không** phải hàng rào thứ hai |
| E12 | **Ba tự sửa ở lane platform, tự phát hiện** | TS2322 kiểu trả về helper; **mất cân bằng ngoặc khi ghép chunk** (lần thứ hai trong các cycle gần đây, lần trước là Mục 46) ⇒ TS2304 + TS1128; và một test **assertion vô nghĩa** `toBe(true)` với biểu thức kết thúc bằng `|| true`, viết lại thành so hạn chặn bằng máy |
| E13 | **Bốn receipt tester, đếm từ source** | `T-CODEX-OFFLINE-METADATA-AND-COMPARE-INDEPENDENT` (task_1a1a8e94f0f2, 01:54:51): read-metadata **37 ×3 = 111**, compare **22 ×3 = 66** · `W-DOC-CORE-COMPARE-NEGATIVE` (task_7a1b92c40ede, 01:45) 22 ×3 = 66 · `W-DOC-CORE-GENERATE-NEGATIVE` (task_7a1b92c40edf, 01:56) 18 ×3 = 54 · `W-DOC-CORE-INGEST-NEGATIVE` (task_7a1b92c40ee0, **ctx_1a695294ae7b**, 02:09) 17 ×3 = 51 |
| E14 | **Cả bốn khớp chính xác, có một ngoại lệ đáng nói** | compare **10 it + 2 failing + 10 dòng** = 22 · generate **15 it + 3 failing** = 18 · ingest **15 it + 2 failing** = 17 · read-metadata **15 it + 22 dòng** = 37. `ingest` có **ctx lệch tiền tố với task** (`ctx_1a695294ae7b` vs `task_7a1b92c40ee0`) — tôi ghi nguyên văn cả hai, **không** chuẩn hoá cho khớp |
| E15 | **`test.failing` toàn cây: 40 khối ở 14 file — không đổi** | Đo lại toàn cây (296 file test): output-validation 13 · ingest-scan-fixtures 5 · generate 3 · ingest-scan-tamper 3 · compare/extract/ingest-source-pin/ingest/manifest/package-boundary 2 mỗi file · analyze/ingest-wire/parser-budget-band/transform 1 mỗi file. **40/14**, y hệt cycle 72 |
| E16 | **Khoảng trống E8 của cycle 72 hẹp lại 5 file → 2 file** | Cycle 72 ghi 5 file có `test.failing` mà packet không có receipt nào. Wave này có receipt cho **generate, compare, ingest**. Chỉ còn **`parser-budget-band`** và **`ingest-wire`** chưa ai đặt tên |
| E17 | **Sáu tên file, không trùng tên nào** | Duyệt **296 file test** trong cây: mỗi tên **đúng 1 file**. Mục 66 từng bắt ba file trùng tên; lần này không có gì để bắt |
| E18 | **Ba file EOL hỗn tạp** | compare **170 CRLF / 84 bare LF** · generate **236 / 102** · ingest **224 / 204**. `ingest` gần cân bằng nhất wave này — và đó chính là loại file dễ hỏng nhất khi người sau đụng vào |
| E19 | Link checker ×3 + anchor | S0 **FILES=8 TARGETS=1068 ANCHORS=656 BROKEN=0**; S1 **FILES=11 TARGETS=1152 ANCHORS=738 BROKEN=0**; TREE **FILES=216 TARGETS=1889 BROKEN=2** — cùng hai link hỏng có sẵn ở antigravity-6.md:8952 và requests/antigravity.md:10, ngoài lane. Δ TARGETS **1068 → 1068**, **1152 → 1152**: không đổi, và tôi **truy nguồn** thay vì ghi bừa: cả 6 fragment + khối Mục 73 + dòng ledger-73 đều có **0** markdown link, nên TREE **213 → 216** là do lane khác. Chèn ledger-73 làm mọi dòng ≥ L434 dịch +1: `docs/28` + `docs/35` đi `#L1694` → **`#L1695`**; `docs/06` đi `#L3207` → **`#L3208`**, đều content-assert |
### 73.2 Δ so với cycle 72

| Δ | Nội dung |
|---|---|
| Δ-A74-1 | **Từ hai module lên bốn module.** Cycle 72 tìm ra hai module cùng một khẳng định về timeout và tôi ghi nó như một điều đáng giữ. Wave này thêm hai module nữa vào cùng khẳng định đó. Ý nghĩa thay đổi theo hướng **mạnh hơn**: ở cycle 72 đó là một điều tò mò, ở đây đó là **xu hướng kiến trúc** — và một xu hướng chỉ đáng tin khi nó lặp lại ở nơi không dùng chung code |
| Δ-A74-2 | **Receipt nói dở có giá trị hơn receipt nói đủ.** Mục 64 admin **không** báo pass: nó liệt kê bốn lỗi bảo mật và **không sửa**, đồng thời liệt kê phần thật sự vững. Tôi ghi cả hai nửa vào docs/28 và docs/35 thay vì chỉ chép dòng PASS, vì người đọc sau cần biết cả chỗ chưa đóng |
| Δ-A74-3 | **Wave sạch lần đầu: 0 bản chép lại.** Cycle 72 có 2 receipt bị chép nguyên văn, và tôi đã phải viết mục already-on-record. Wave này 6/6 là việc mới. Tôi vẫn kiểm cả 6 task id ở **cả ba** file, vì "sạch" là kết quả của phép đo chứ không phải điều được phép giả định |
| Δ-A74-4 | **Bốn lỗi bảo mật là việc của lane khác, không phải việc của tôi — nhưng là tin của coordinator.** Tôi không sửa, không đề xuất vá, chỉ ghi bằng chứng. Điều tôi phải làm là bảo đảm chúng **không biến mất** khỏi tài liệu, vì một lỗi không được ghi thì không ai sửa |
| Δ-A74-5 | **`test.failing` không đổi, nhưng khoảng trống thì hẹp lại.** 40 khối ở 14 file, y hệt cycle 72. Các con số bất biến không có nghĩa là không có gì xảy ra: điều thay đổi là **bao nhiêu file đã có receipt đặt tên cho các khối đó** — từ 5 file xuống còn 2 |
| Δ-A74-6 | **Số `1.74.0` xuất hiện hai lần trong docs/35 và tôi chỉ bump một lần.** Một là dòng version ở L3, một là là **tham chiếu lịch sử** trong phần Wave 10/11. Bump nhầm cả hai là bịa ra một mốc lịch sử. Tôi bump đúng dòng L3 và để nguyên dòng tham chiếu |
### 73.3 Lỗi của chính tôi trong cycle này

**1. Bộ đếm của tôi bắt đầu đếm sai chỗ — và suýt khiến tôi báo sai receipt của người khác.**
Để đếm số dòng của `test.each(badDelivery)`, tôi tìm dấu `[` đầu tiên sau `const badDelivery`. Nhưng dòng khai báo là `const badDelivery: Array<[string, unknown]> = [` — dấu `[` đầu tiên nằm **bên trong** chú thích kiểu `Array<[...]>`, không phải mảng dữ liệu. Bộ đếm trả **1** cho cả bốn hằng. Tôi nhận ra vì **1 là con số không thể tin được** cho một mảng dữ liệu, chứ không phải vì bộ đếm báo lỗi. Khi đếm tay từ source: 3, 5, 7, 4 = **19**. Cộng 78 khai báo + 25 dòng inline = **122**, khớp receipt. Nếu tôi tin bộ đếm, tôi sẽ ghi trong receipt rằng admin suite lệch 15 test — một khẳng định sai về công việc của lane khác

**2. Tôi đã đứng trước ngưỡng ghi "chênh lệch" rồi dừng lại — và dừng lại là đúng.**
Bộ đếm cho 103 so với receipt 122. Số âm đã dấu hiệu ngay: một packet test không thể tự báo nhiều hơn số test nó khai báo. Thay vì ghi "receipt có sai lệch" như tôi đã từng làm ở những cycle trước, tôi dừng lại và đi tìm nguyên nhân. Nguyên nhân nằm ở bộ đếm của tôi. Nguyên tắc tôi giữ: **bộ đếm phải được kiểm chứng trước khi tôi trở thành người đưa ra nhận định về nó** — nếu không, tôi sẽ ghi "sai số" vào receipt của người khác

**3. Packet nói `stat`; tôi không có receipt `stat` — và tôi không tự chế một cái.**
Packet ghi offline tester `stat` và `generate`. Tôi tìm trong cửa sổ nhận được: `artifact-stat` **đã có** từ ba entry trước, không có receipt mới. Receipt thật là read-**metadata**. Có hai cách xử lý: ghi một mục `stat` cho đủ với packet, hoặc ghi receipt thật và nói rõ chỗ lệch. Tôi chọn cách thứ hai, vì mục tiêu của tài liệu là **phản ánh bằng chứng**, không phải khớp với mô tả của packet. Nếu tôi chế một mục, người sau sẽ đi tìm một receipt không tồn tại

**4. Tôi viết E-rows SAU khi đo — sửa thứ tự, và nó cho kết quả.**
Ở cycle 72 tôi viết E13/E14 trước khi chạy link check, rồi số trong receipt sai. Lần này tôi đo hết rồi mới viết bảng evidence. Chi phí là tôi phải chạy link check **sau** khi splice, vì bảng evidence nằm trong file; nhưng phần thưởng là **không còn ô nào trong bảng là số dự đoán**. Tôi ghi lại đây vì đây là sửa đổi thói quen, và thói quen thì phải được ghi thì mới giữ

**5. Một dòng rác trong script khiến tôi tốn một lượt chạy.**
Tôi viết một biểu thức regex vô nghĩa vào script kiểm tra delta, nó ném `ValueError`. Nhỏ thôi, nhưng đáng ghi vì nó xảy ra ở đúng bước tôi đang cố làm nhanh nhất, và vì lỗi ở bước nhanh thường bị bỏ qua thay vì ghi lại
