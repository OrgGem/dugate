# Báo cáo lane Qwen-Admin — Admin Ops UI Implementer

## RESUME POINT

- **Packet hiện tại:** W-ADMUX02-CROSS-SORT-422-1 — 422 chéo-sort + walk 6 sort qua **HTTP loopback
  thật** (route thật tầng A, shell thật tầng B + synthetic platform): nửa OFFLINE-wire của
  T180-A1/finding 4. Nộp ở Mục 19. **Packet mới (27/09):** W-ADMUX02-0019-LITERAL-HARNESS-1 (task_892296fa9542 / ctx_718d23f32fb5) — 3 harness fake-DB căn chỉnh ORDER BY sentinel literal của 0019; nộp ở Mục 20. **Packet mới (27/09):** W-ADMIN-ALIGN-EXPLAIN-0019 (task_222653f4cfd2 / ctx_c3234ad59db5) — align admin-keyset-explain harness với 0019 inline literal; nộp ở Mục 21. Packet trước: -0019-LITERAL-HARNESS-1 (Mục 20), -CROSS-SORT-422-1 (Mục 19).
  Mục 1 = W-ADMUX-01, 2 = -03-FILTER-1, 3 = W-ADMUX02-SRV-1,
  4 = -SRV-1-FIX, 5 = -CLEAN-1, 6 = -COPY-2, 7 = -IDX-1, 8 = -IDX-2, 9 = -EXPLAIN-FIX-1,
  10 = -STATUS-SYNC-1, 11 = W-CONTRACT-ALIGN-1, 12 = W-ADMUX02-EXT-1, 13 = -TOOLBAR-CHIPS-1,
  14 = -SORT-ALLOWLIST-1, 15 = -SORT-CURSOR-BIND-1, 16 = -SHELL-SORT-1, 17 = -IDX-SORT-0018, 18 = -EXPLAIN-SORT-1, 19 = -CROSS-SORT-422-1, 20 = W-ADMUX02-0019-LITERAL-HARNESS-1, 21 = W-ADMIN-ALIGN-EXPLAIN-0019, 22 = W-ENC-07-DELIVERY-1, 23 = W-ENC-08-CONFIG, 24 = W-ENC-08-WIRING, 25 = W-ENC-08-WIRE-ENC07, 26 = W-ADM-UX-08-SHELL, 27 = W-ENC-08-RENDERER-CSRF, 28 = W-ENC-08-CSRF-OIDC, 29 = W-ENC-08-WEBHOOK, 30 = W-ADM-UX-02-AUDIT-PAGE. Chờ packet mới.
  **T70-C1 đã đóng ở Mục 11** (contract về một nguồn, tham số ngoài contract = lỗi biên dịch).
  **Bug thật Mục 13 sửa:** `Clear all` giữ nguyên page size đang dùng (`?limit=50`) thay vì về
  `?limit=20` — trái chính checklist C1 mà Mục 10 tôi soạn cho Tester. Chip đã có từ Mục 2 nên
  **Δ42 không nhận công** phần đó; phần mới của chu kỳ là 7 test **đi theo link** thay vì so chuỗi.
- **Kết luận 4 mức:** ADM-UX-02 query/cursor contract + ADM-UX-03 filter-toàn-tập =
  IMPLEMENTED + VERIFIED-OFFLINE (tsc x3 exit 0; `pnpm --filter @du/orchestrator test`
  2 suite admin **207/207 x3**, migration pin **9 passed** x3; EXPLAIN **6 skipped** offline và
  **6/6 PASS live** (`T-CODEX-TEST-20`, sau lần 1 `T-CODEX-TEST-18` 4/6) → **Δ23 ĐÓNG**. Tất cả exit 0).
  ADM-UX-01/05/03-shell vẫn IMPLEMENTED + VERIFIED-OFFLINE.
- **Mục 13 (ADM-UX-03 toolbar):** `Clear all` reset + chip hop + URL↔pane sync = IMPLEMENTED +
  VERIFIED-OFFLINE — cặp packet **101/101 ×3 exit 0**, `tsc --noEmit` **×3 exit 0**, hồi quy 6 suite
  Admin UI **434/434 exit 0**, và **có đột biến**: baseline 94/94 xanh → revert một dòng → **3 đỏ**
  cùng thông báo `limit=5` vs `limit=20` → restore kiểm bằng đếm chuỗi trong source (2 file này `??`
  trong git, **không có `git diff` làm lưới**).
- **Mục 14 (ADM-UX-02 sort):** `sort` ở route operations = IMPLEMENTED + VERIFIED-OFFLINE —
  contracts build ×3 exit 0, contracts **385/385 ×3** exit 0, cặp packet **108/108 ×3** exit 0
  (chủng khác Mục 13: 108 = pagination 89 + operations-conformance 19 — **không so với 101**, Δ49),
  `tsc --noEmit` ×3 exit 0, hồi quy 10 suite **375 passed / 14 skipped** exit 0 (ba suite skip là
  live-gated, **skip ≠ pass**), và **ba lần đột biến đều bị bắt**: M1 bỏ xử lý NULL → 7 đỏ;
  M2 boundary bỏ `descending` → đỏ đúng 3 test `:asc`, mọi test `:desc` vẫn xanh; M3 sort sai trả
  default → 3 đỏ kèm nguyên một trang 200 nơi nợ 422. Hai bẫy thật đã xử lý: `deadline_at`
  NULLABLE (§14.2, không xử là **mất dòng im lặng** từ trang 2) và hướng keyset đổi theo
  `direction` (§14.3, default ra SQL **giống hệt từng byte**).
- **Mục 15 (T140-A1 / Δ52):** cursor keyset của route operations **tự khai ordering** — payload
  `<ISO>|<uuid>|<field>:<direction>[|p]`, legacy 2-slot vẫn đọc được (về `created_at:desc`), lệch thứ tự
  = **422 trước mọi query** và không lách được bằng cách bỏ `?sort=`; worst-case token 107 < bound 128 mà
  contracts cap, route kiểm lẫn **admin shell cắt**. **54 test mới** trong file
  `tests/operations-list-cursor-sort-binding.test.ts`; bộ operations-list **162/162 ×3 exit 0**, contracts
  **385/385 ×3 exit 0** (không đổi contracts — Δ61), `tsc` ×3 exit 0, hồi quy phía route **321 passed /
  123 skipped exit 0**. Ba đột biến: M1 nửa lock (`||`→`&&`) = **14 đỏ trong khi cả hai suite Mục 14 vẫn
  xanh nguyên vẹn** — đúng kết luận reviewer; M2 decoder bỏ slot = **22 đỏ**; M3 revert fold WHERE = **7
  đỏ**. Mục 15 còn lộ một **lỗi có trước**: `SELECT * FROM operations AND (created_at, id) < …` là
  statement hỏng cú pháp khi admin cross-tenant bấm Next trên list không lọc; đã sửa bằng fold predicate
  vào `whereClause`, placeholder không đổi (§15.3, Δ58). **Δ52 đóng ở mức code + offline**; phần live
  keyset vẫn nợ Tester.
- **Mục 16 (shell sort / W-ADMUX03-SHELL-SORT-1):** `sort` vào Admin Shell đủ ba tầng — router
  parse `?sort=` vào query state, fetcher sanitize bằng ĐÚNG `parseOperationsListSort()` của
  contracts (rác → drop + khai `ignoredFilters`, không vang lại; default omit khỏi URL), toolbar
  có `<select name="sort">` sáu option **và form không mang field cursor** ⇒ đổi sort = reset
  cursor **cấu trúc** (Δ67: không decode cursor trong shell để giữ opacity); mọi link mang cursor
  đều echo ordering; catalog offline mô phỏng `(key,id)` + NULL-deadline-cuối bằng sentinel.
  **47 test mới**; tsc **×3 Exit Code: 0**, packet-literal VM suite **74/74 ×3 Exit Code: 0**, bộ
  5-suite **400/400 ×3 Exit Code: 0**, sweep **69 pass / 17 skip / 0 fail (1695 pass / 209 skip)**
  Exit Code: 0; đột biến M1=5 đỏ, M2=1 đỏ (đúng test structural-reset), M3=2 đỏ, restore BAD=0.
  ADM-UX-03 vẫn `[ ]` chờ browser; phần live T140-A1 vẫn nợ; Δ66–Δ72.
- **Mục 17 (0018 sort indexes):** migration mới ĐÚNG packet-spec 4 câu (tất cả IF NOT EXISTS,
  không DROP/ALTER); guard **+6 test (17/17 ×3 Exit Code: 0)** pin sequence 18 + mỗi index bằng
  MỘT chuỗi exact đơn (name↔columns không đổi chỗ được) + count-4 + nguyên-caveat-text;
  `npx tsc --noEmit -p tsconfig.json` ×3 exit 0; sort-wiring hồi quy 47/47 ×3 exit 0. Đột biến
  M1=2 đỏ / M2=1 đỏ / M3=1 đỏ, restore BAD=0 bằng 13 đếm chuỗi. Caveat Δ73 ghi thẳng trong
  migration: route order `COALESCE(deadline_at, $n)` ⇒ cặp deadline plain có thể KHÔNG xoá được
  Sort — chờ live EXPLAIN của Tester; nếu còn Sort thì 0019 expression-form, cấm tidy 0018
  sau-apply. Sweep: 2 lần đầu đỏ DI-CHUYỂN ở suite lane khác (url-ingestion → admin-shell-server
  ETIMEDOUT loopback), mọi suite liên quan standalone xanh, sweep 3 SẠCH 70/17/0 (1727 pass) ⇒
  contention máy chung, không phải code lane (Δ74). Δ73–Δ76.
- **Mục 18 (W-ADMUX02-EXPLAIN-SORT-1 / T180-A1):** `admin-keyset-explain.test.ts` 6→**17 test** —
  pg_indexes six-name exact-list; `updated_at`: cross+tenant **no Sort** + đúng tên index, backward-hop
  theo bar T-18 (`Index Cond ROW(updated_at,id)>ROW(`, cấm Seq Scan, bounded-Sort cho phép);
  `deadline_at`: ba plan **đúng expression route** (COALESCE + shared-sentinel desc/asc, tenant+cross)
  chấm bằng `expectDeadlinePlanUsable` — SeqScan-đỏ=mở nhánh 0019, thiếu-tên-idx-đỏ=không được gọi
  0018 là used, material-Sort-đỏ=quyết định follow-on chứ KHÔNG tidy 0018 đã-apply (Δ24). Walk
  `updated_at` full-continuity; seed enriched (~620/1240 deadline NULL). **4 synthetic-test offline**
  chứng minh bar có răng cả khi live-gated. Evidence: explain ×3 exit 0, REG 4-suite 207/207 ×3 exit 0,
  tsc ×4 exit 0 (sau ~6 phút đỏ vì edit đang-chạy của lane khác — không chạm, poll converge, Δ80),
  sweep 70/17/0 (+7 skip đúng số live-test mới). Δ77–Δ81 (gồm Δ81: probe-edit tự gây, tự bắt, repair
  nguyên văn).
- **Mục 19 (CROSS-SORT-422 wire):** file mới `tests/admin-operations-sort-http-offline.test.ts` —
  **32 test, hai tầng**: A = `route()` THẬT mount loopback HTTP (interpreter-fake db đúng hình SQL
  §15, boundary problem+json mô phỏng server.ts:519-525), cursor **do route tự mint** replay chéo
  sort → **422 trên wire** (remedy trong `title`, zero SELECT trước query); legacy 2-slot/`|p`,
  over-128, sort-lỗi-trước-cursor-lỗi, 6 walk it.each theo oracle độc lập + safeParse từng hop,
  tenancy sạch cả hai phía. B = `createAdminShellServer` THẬT (login cookie) chống synthetic
  platform §15-policy: walk 6-sort qua href Next thật (zero 422 khi đi đúng), URL tự chế lệch →
  pane remedy thành thật, form trang-2 không cursor, >128 vào platform đúng 128 (chính-sách CẮT
  giờ có test pin hành-vi cuối). Lộ thật máy Δ82 (ephemeral-port filter ⇒ pin port tĩnh — giải
  thích luôn các đỏ Δ74), Δ83 (message ở `title`, không có `detail`), Δ84 (phân ranh A/B trong
  header file chống over-claim), Δ85 (3 lỗi test tự bắt bằng probe độc lập), Δ86 (không sửa
  source). Evidence: C19 32/32 ×3 exit 0, REG 343/343 ×3, tsc ×3, sweep 73/16/0 (1785/216);
  M-A guard = đúng 7 đỏ nguyên bộ replay / 25 xanh ngoài vùng, restore grep=0.
- **Mục 20 (0019 literal-sentinel harness):** đỏ do **source-change của lane khác** (W-INGEST-0019-1/2):
  `bindOperationsListSortKey` nhúng sentinel `0001…/9999…::timestamptz` nguyên văn vào SQL text (0019
  match biểu thức theo Const; dạng `$n` bind là chính hình chết-index T-35 đã bác). 3 harness
  §14/§15/§19 pin hình cũ ⇒ **14 đỏ đúng như packet**. Lane sửa test-only: interpreter đọc literal +
  `$n`-form bị phân-loại regression-throw; conformance đảo-cực 2 pin (fragment literal byte-exact theo
  chiều, không `$n` giữa ORDER BY và LIMIT); http-offline +2 guard CHƯA TỪNG có ở file (unreadable-
  boundary-throw, boundary-key≠ORDER BY-key) + sentinel↔direction check. 140/140 **×3 Exit Code 0**.
  tsc 0, probe regex độc lập 7/7; sweep unit 1788 passed — 1 đỏ KHÔNG-lane VAULT-06 vẫn đỏ standalone
  (Δ90). Đột biến source TỪ-CHỐI vì `server.ts` đang lane khác sửa hôm nay (tiền lệ Δ80). Nợ xin
  adjudicate: fixture EXPLAIN §18 còn pin hình cũ (Δ88), sentinel 4 nơi không một nguồn (Δ89), nhãn
  packet "(Delta 29)" lệch ledger (Δ87). ADM-UX-02 [~], ADM-UX-03 [ ], G-ADMIN-OPS giữ NO-GO.
- **Mục 21 (W-ADMIN-ALIGN-EXPLAIN-0019, Δ88):** align `admin-keyset-explain.test.ts` với 0019 inline
  literal — sentinel comment cập nhật, decision bar regex nhận CẢ 0018 plain lẫn 0019 coalesce
  (`deadline_(coalesce_(asc|desc)_)?id_idx`), pg_indexes 6→10 tên (+4 index 0019), 3 deadline SQL
  tests dùng `'<ISO>'::timestamptz` inline thay `$n` + renumber params, +1 synthetic 0019-name test.
  File 553→583 dòng. 18/18 ×3 Exit Code 0 (13 skip live + 5 synthetic pass), tsc Exit Code 0.
  Δ88 ĐÓNG. Lane khác (Platform W-INGEST-0019-2) đã sửa header + SQL trước đó nhưng để lại
  `.join('\n')` hỏng syntax (literal newline) — lane này repair. ADM-UX-02 [~], ADM-UX-03 [ ],
  G-ADMIN-OPS giữ NO-GO.
- **Mục 22 (W-ENC-07-DELIVERY-1, task_7e489eb6b6d6):** packet IMPLEMENTATION đầu tiên của lane này —
  delivery encryption cho public result/download. MỚI `src/modules/public-api/delivery-encryption.ts`
  (policy theo tenant, config-injected, **không có client override**; DEK mới + nonce mới mỗi
  response; AES-256-GCM; DEK wrap RSA-OAEP-SHA256 dưới key ENC-06; envelope validate theo schema
  ENC-01 trước khi ra khỏi service; pin keyId+version). **Cả hai route** `/result` và `/download`
  tuân cùng một policy — `/download` giữ nguyên stream `Readable` khi tắt, đọc có trần
  `maxBlobBytes` khi bật (quá trần 413, không buffer vô hạn). Fail-closed 503 trên cả hai route
  khi key thiếu/revoke/registry lỗi, chữ cố định theo code. **22 test** (10 service + 12 route
  qua `route()` thật) **22/22 ×3 Exit Code 0**, tsc Exit Code 0, sweep **1854 passed** (VAULT-06
  đã xanh). Đỏ sweep duy nhất **không thuộc ENC-07**: renderer `shell-render.ts:525` đổi
  `aria-label` so với pin cũ (Δ92). HPKE từ chối chứ không hạ cấp (Δ93); policy chưa bền, cần
  ENC-08 (Δ94); delivery lớn chưa có profile chunk (Δ95); `keyId` vs `fingerprint` (Δ96).
  `G-ENC`/`G6` giữ NO-GO; ADM-UX-02 [~], ADM-UX-03 [ ] không đổi.
- **Mục 23 (W-ENC-08-CONFIG, task_5b49655d9bbd):** Admin UI + API crypto configuration. MỚI 4 file
  trong `src/app/admin/`: `crypto-config-view-models.ts` (167), `crypto-config-renderer.ts` (126),
  `crypto-config-api.ts` (350), `crypto-config-index.ts` + MỚI `tests/admin-crypto-config.test.ts`
  (458 dòng, **35 test** / 6 describe). Chỉ sửa file MỚI, không đụng file tồn tại. Ba control
  (allowlisted Vault storage key ref / toggle delivery encryption / pin recipient key version),
  fingerprint chỉ hiện **preview 12 ký tự**, không có mặt trữ chỗ nào chứa secret nên renderer
  không thể lộ; RBAC: đọc tenant-scoped, ghi cần writer role + CSRF token **thật** của rbac.ts,
  chọn storage key ref là platform-only; mỗi field đổi ghi 1 dòng audit tên FIELD không tên giá trị,
  no-op thì không ghi; bật delivery mà chưa có key dùng được thì **409 từ chối lúc cấu hình**;
  pin hỏng (revoke / không còn tồn tại) được hiện cảnh báo chứ không bị bỏ âm thầm.
  35/35 **×3 Exit Code 0**, tsc Exit Code 0. **Tự bắt 1 bug thật trong source**
  (`effectiveRecipientKeyVersion` phụ thuộc thứ tự input) + 4 expectation sai của tôi (Δ ghi ở 23.5).
  **Ba khoảng cách lớn, ghi thẳng:** chưa có route HTTP (Δ97), chưa có bảng persistence (Δ98), và
  **chưa nối ENC-07 nên bật toggle ở Admin chưa đổi hành vi giao thật** (Δ99). ENC-08 ở đây là
  bề mặt quản trị, không phải đòn cần; KHÔNG phải ACCEPTED. Vault allowlist phải truyền vào từ
  composition root (Δ100), CSRF với OIDC session chưa ghép được (Δ101), không có mutation test
  vì toàn file mới (Δ102), hai lựa chọn chính sách cần ký (Δ103). `G-ENC`/`G6` giữ NO-GO.
- **Mục 24 (W-ENC-08-WIRING, task_4f4ddbfd7e07):** đóng **Δ97** — mount crypto-config lên HTTP route +
  Admin shell. SỬA `src/server.ts` (ServerConfig.cryptoConfig, RouteContext.cryptoConfig, store build
  MỘT LẦN trong createApp, route GET/POST `/api/v1/admin/crypto-config`, chưa cấu hình ⇒ 503) và
  `src/app/admin/shell-router.ts` (route `/admin/crypto-config` admin-only, `cryptoConfigPane`
  optional, không resolver ⇒ error pane chứ không trang trắng); MỚI `tests/admin-crypto-config-wiring.test.ts`
  (21 test / 3 describe). Route gọi **đúng handler** Mục 23 test ⇒ một bộ luật, hai cửa; registry lấy
  chung từ ENC-07 ⇒ một nguồn key.
  **Tự bắt 1 lỗ hổng thật do tôi tạo:** bản đầu đọc `cookieRole` từ header `x-admin-role` do caller
  set — trái nguyên tắc "role đến từ credential"; đã sửa sang claims cookie **đã verify chữ ký**, và có
  test chứng minh header giả không thay được cookie thật để né CSRF (Δ104).
  56/56 ×3 (2 suite ENC-08) Exit Code 0, tsc NO_TS_ERRORS, sweep **1938 passed** — 2 đỏ đều KHÔNG
  thuộc packet (Δ92 cũ + ENC-05 upload gateway của lane khác, fail độc lập). **Δ98 (bảng) và Δ99 (nối
  ENC-07 ⇒ toggle ở Admin CHƯA đổi hành vi giao thật) vẫn mở**; Δ105 (platform bearer không cần CSRF),
  Δ106 (composition chưa wire resolver) ghi thêm. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO.
- **Mục 25 (W-ENC-08-WIRE-ENC07, task_e7c21a0b6c2f):** đóng **Δ99** — toggle `deliveryEncryption` của Admin giờ điều khiển CẢ `/result` lẫn `/download` ngay lượt kế tiếp, không cần restart. `delivery-encryption.ts` nhận `policySource` bất đồng bộ (đọc mỗi request); `getPolicy` sync **ném lỗi** khi có policy động thay vì trả stale (Δ108); pin version được tôn trọng tuyệt đối qua `getKeyVersion` (rotation sau pin không đổi người giải mã), pin bị revoke ⇒ **503 fail-closed chứ không lùi về key hiện hành** (Δ109). MỚI `tests/enc08-wire-enc07.test.ts` (9 test). 87/87 ×3 (4 suite ENC), tsc sạch, sweep **1968 passed** — đỏ duy nhất là Δ92 cũ, đỏ ENC-05 đã xanh. **Δ98 (store in-memory) vẫn mở**; Δ110 ghi nhận webhook dispatcher chưa theo policy (ngoài phạm vi).
- **Mục 26 (W-ADM-UX-08-SHELL, task_ddc3efda9377):** đóng **Δ106** — `cryptoConfigPane` được nối vào composition root. `shell-server.ts` dựng `ShellRuntimeConfig` từ field cố định và **ngoài phạm vi**, nên composition root đăng ký qua `registerCryptoConfigWiring()` (Δ111 ghi rõ đánh đổi process-level này); `createApp` luôn ghi kể cả `undefined` để xoá đăng ký cũ. Resolver + applier lấy từ **cùng service** JSON API dùng. Route có thêm **POST** cho form, cổng theo thứ tự: cookie → `role >= admin` → **CSRF** (derive từ cookie + secret, so sánh constant-time) → mới gọi applier; save dùng **POST-redirect-GET**. Test soi DOM: không có PEM, bearer, cookie secret hay CSRF token. MỚI `tests/admin-crypto-config-shell.test.ts` (9 test). **41/41 ×3 Exit Code 0**, tsc sạch. **Sửa 1 assertion cũ của chính tôi** ở Mục 24 (POST từng là `null`, nay có chủ đích là route) — thay đổi hợp đồng, ghi rõ. Sweep 1979 passed; 2 đỏ mới **không thuộc packet**: đều là test **socket thật**, đã truy bằng probe in-process (đã xoá) chứng minh router của tôi lành, và `shell-server.ts` bị lane khác sửa lúc 04:15 trong lúc tôi làm việc (Δ114). Δ112 renderer chưa phát CSRF field (ngoài phạm vi) nên submit từ browser luôn 403 — fail-closed đúng nhưng UX chưa dùng được; Δ113 chưa nối `verifySessionCsrf` của OIDC. **Δ98 đã được lane khác đóng** (PostgresCryptoConfigStore). Δ110 vẫn mở. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO.
- **Mục 27 (W-ENC-08-RENDERER-CSRF, task_1be90638634c):** đóng **Δ112** — form `/admin/crypto-config` giờ mang hidden field `csrf` mà POST handler verify lại. Token là **binding chứ không phải secret**: `deriveCsrfToken(cookieSecret, sessionCookie)` là HMAC, cross-site page không đọc được (SameSite=Strict) và không tự tính được; chính vì thế Mục 26 tôi coi nó là secret là **sai** và đã sửa assertion (Δ115). Renderer nhận `csrfToken?`: có token ⇒ phát hidden field + nút Save; không có ⇒ READ-ONLY (không nút Save, có banner) — guard phòng thủ, gần như không reachable qua route vì session hợp lệ đã hàm ý có secret (Δ116). **Test end-to-end là bằng chứng thật**: lấy token RA khỏi HTML rồi POST lại ⇒ 302 + store cập nhật + 2 dòng audit. 47/47 (2 suite theo packet), 79/79 ×3 (4 suite ENC), tsc sạch. Sweep 1951 passed; 5 đỏ, **không suite crypto nào đỏ**; 2 đỏ mới (`url-ingestion-consumer` lỗi compile trong file test của lane khác, `admin-shell-server` socket Δ114) không phải của tôi (Δ117). Δ110/Δ113 vẫn mở. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO.
- **Mục 28 (W-ENC-08-CSRF-OIDC, task_b5bf4dc1e21a):** đóng **Δ113** — session plane của OIDC nay **sở hữu** CSRF của crypto-config, đúng như nó sở hữu danh tính. Trước đây `handleCryptoConfigPost` LUÔN verify bằng `validateCsrfToken` (derive từ `du_admin`) kể cả khi request đi trên `du_session`: dưới OIDC đó sai theo một trong hai hướng — form bị trao một token mà cổng sẽ từ chối, hoặc cổng chấp nhận một token được mint cho mặt phẳng khác. Sửa 4 điểm trong shell-router: `resolveOpaqueSession` mang `csrfToken` của session; GET đọc token từ store khi có `du_session` (nếu không mới derive legacy); POST **có** token thì verify bằng `verifySessionCsrf` thật (check 43 ký tự + `timingSafeEqual`) và **không fallback** legacy; `dispatchShellRequestAsync` truyền token xuống (tham số thứ 4 optional nên caller cũ không đổi). MỚI `tests/admin-crypto-config-oidc.test.ts` (233 dòng, 6 test, self-contained). 105/105 (3 suite theo packet), 76/76 ×3 (4 suite ENC), tsc sạch, sweep 1997 passed (không suite crypto nào đỏ; 2 đỏ mới ở Mục 27 đã xanh do lane sở hữu tự sửa). Ghi công khai 2 lần fixture của tôi sai (token 42 ký tự bị CSRF_RE thật chặn; key record thiếu tenantId) — cả hai là lỗi test, không sửa source. Δ118 (narrowing as SessionRecord có chủ đích), Δ119 (đường async chưa có test). **Δ110 vẫn mở** — mắt xích cuối của chuỗi ENC. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO.
- **Mục 29 (W-ENC-08-WEBHOOK, task_f0bcba8aa961):** đóng **Δ110** — webhook dispatcher nay tuân CÙNG policy per-tenant với `/result` và `/download`. Trước đây `deliverWebhooks` dựng body thẳng từ `row.payload` rồi ký HMAC và POST, không bước nào đọc policy ⇒ tenant đã bật delivery encryption vẫn nhận webhook operation của mình ở dạng rõ; bảng đã có `tenant_id` nhưng claim SELECT không lấy nên dispatcher không biết tra policy của ai. Sửa: port hẹp `WebhookDeliveryEncryption` (webhooks phụ thuộc **hành vi**, không import cả module public-api), `tenant_id` vào row + SELECT, `buildWebhookBody` trả đúng hình dạng envelope ENC-08 mà hai route kia dùng, **ký SAU khi mã hóa** (ký plaintext rồi hoán body là hỏng toàn vẹn im lặng), và **fail-closed** — lỗi đọc policy hoặc mã hóa ⇒ không POST gì, row nhận mã cố định `WEBHOOK_ENCRYPTION_FAILED`; policy đọc lỗi KHÔNG phải bằng chứng tenant đang tắt. `server.ts` truyền service thật (`?? undefined` ⇒ nền tảng không có crypto-config giữ nguyên hành vi cũ). MỚI `tests/webhook-delivery-encryption.test.ts` (334 dòng, 5 test) dùng service + registry + keypair **thật** nên envelope thật sự được private key giải mã. 64/64 ×3 (5 suite liên quan), tsc sạch, sweep **2014 passed** (không suite crypto/webhook nào đỏ; 3 đỏ là bộ đã biết Δ92 + 2 socket Δ114). Ghi công khai 3 lỗi của tôi trong test (tx không gắn vào db; đọc `params[2]` cho `last_error` trong khi release SQL dùng `$4`; import 2 header constant nhầm từ `webhooks` thay vì `@du/contracts`) — lỗi (ii) thuộc loại âm thầm, đọc sai chỉ số làm test pass với thông báo sai. **Δ120 (ký phủ ciphertext ⇒ receiver phải verify trên body đã nhận, đổi hợp đồng phía nhận), Δ121 (payload trong DB vẫn plaintext — thuộc ENC-META-01), Δ122 (lỗi crypto tốn ngân sách retry), Δ123 (port lặp shape service).** Trong lúc chạy, `server.ts` + `@du/contracts` đang được lane khác refactor làm đỏ 19 lỗi TS; tôi KHÔNG chạm, poll 2 lần (19→12→0) rồi mới chốt số — Δ80 lặp lần thứ ba. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO.
- **Phán quyết Turn 60 (đã ghi xuống ledger, Mục 10):** `W-ADMUX02-IDX-1/-IDX-2/-EXPLAIN-FIX-1` =
  **ACCEPTED ở phạm vi keyset index & query plan** (bằng chứng live `T-CODEX-TEST-20`: 6/6, PG
  :5433/du_orchestrator_test + Redis :6380). Row **ADM-UX-02 chỉ lên `[~]`, không `[x]`** — còn thiếu
  ~~sort allowlist~~ **đã có cho route operations (Mục 14)**; còn thiếu cùng contract cho
  businesses/API keys/audit + ~~index cho hai khoá sort mới (Δ53)~~ **0018 đã ship file + pin
  offline ở Mục 17, còn thiếu bằng chứng planner (live EXPLAIN — Δ73)** — bar EXPLAIN ĐÃ viết + có răng
  offline ở Mục 18, còn đúng bước Tester chạy trong window; và `operations_tenant_created_id_idx`
  vẫn chưa có bằng chứng được planner chọn. **`G-ADMIN-OPS` giữ NGUYÊN NO-GO** cho tới khi Tester xong
  browser journey (checklist C0–C5 đã soạn trong `tasks/ADMIN-OPS-UX-2026-09-24.md`).
  Lưu ý: cùng log đó có **M2/M3/M5** — bằng chứng live cho tenant fence + envelope mình viết ở Mục 3.
- **Đã đóng:** Δ14 + Δ18 (Mục 5–6), Δ22 (Mục 8), **Δ23** (live lần 2 = 6/6 PASS, `T-CODEX-TEST-20`),
  và **T70-C1** (Mục 11): contract operations-list giờ là **một nguồn** trong `@du/contracts`, cả route
  lẫn admin shell đều import; một tham số ngoài contract là **lỗi biên dịch** (seam `AllowListedQuery`).
  **Δ13 đóng phần code**, chỉ còn mục 3 dưới đây là phần query-plan.
- **Việc còn mở, theo thứ tự đáng làm:**
  1. **Browser Admin journey theo checklist C0–C5** (Tester, cần DB window) — blocker duy nhất
     còn lại của gate. Checklist đã soạn sẵn trong `tasks/ADMIN-OPS-UX-2026-09-24.md`, selector
     đã đối chiếu source (không bịa attribute). Sau Mục 13, C1 có thêm một điểm phải nhìn bằng mắt:
     `Clear all` từ `?limit=50&state=…` phải ra `?limit=20` sạch tham số; C2 có thêm bất động điểm
     "href không cursor được chính pane đích phát lại với `aria-current`". Offline đã khoá cả hai.
     **Mới từ Mục 18:** EXPLAIN cho bốn index 0018 đã có harness sẵn
     (`tests/admin-keyset-explain.test.ts`, 17 test, `DU_LIVE_INFRA=1`-gated) — packet Tester chỉ
     cần trỏ vào file; đỏ ở ca deadline là THÔNG TIN phán quyết Δ73/0019, không phải thứ được
     phép "sửa test cho xanh".
     **Mới từ Mục 19:** chính các kịch bản cross-sort-422 / sáu-sort-walk / tenancy đã có harness
     HTTP loopback offline (`tests/admin-operations-sort-http-offline.test.ts`) — phần T180-A1 còn
     nợ CHỈ còn là chạy lại nguyên hai harness (Mục 18+19) trên PG thật trong window đã-claim.
     **Phần live mà T140-A1 còn nợ (Mục 15):** replay một cursor `created_at` với `?sort=deadline_at`
     phải ra **422** trên server thật, và một walk đầy đủ dưới mỗi sort phải **không thiếu/trùng dòng**
     khi có insert xen giữa — bằng chứng `T-CODEX-TEST-20` là của hình thái cursor **cũ**, không dùng
     thay được. Reviewer đã ghi rõ needs "cross-sort negative **plus live keyset test**".
     **Mới từ Mục 16:** journey C-side có thêm một điểm mắt-thấy — đổi sort ở toolbar phải ra
     trang 1 của ordering mới (URL sạch `cursor`), và Next trong sort mới phải giữ `sort`; cả hai
     đã bị khoá bằng test offline, browser chỉ xác nhận lại.
  2. **Sort cho hai list còn lại + các filter chưa làm** — route operations **đã có `sort`**
     (Mục 14) và **admin shell đã có control sort + reset cấu trúc** (Mục 16, offline-verified);
     audit + api-keys **chưa**, vì `keysetPage()` vẫn hardcode `ORDER BY created_at`.
     Audit còn thiểu `time`/`actor`/
     `resource`. **`label` và `last-used` của API keys không có cột trong schema**
     (`api_keys` chỉ id/tenant_id/hash/prefix/status/created_at) ⇒ cần migration, không phải
     việc query. businesses/versions chưa có hợp đồng list.
  3. **Seed đa tenant** để chứng minh `operations_tenant_created_id_idx` thật sự được chọn,
     và quyết định giữ/xoá `operations_tenant_created` (prefix thừa). **Δ21 mở một nửa**: cả hai
     live run đều chọn index cross-tenant + `Filter: tenant_id`, vì seed chỉ có 1 tenant.
  4. **Docs lane dọn các dòng đã hết hiệu / sai tên symbol** (Δ36):
     - `docs/20:34` và `docs/19:157` vẫn ghi T70-C1 là MISMATCH **chưa sửa** — nguồn đã chốt ở Mục 11.
     - `docs/06` cần mô tả `|p` cursor + envelope 5 field (Δ12/Δ16).
     - **Mới từ Mục 15 (Δ64):** `docs/19-traceability-audit-matrix.md:155` vẫn mô tả payload là
       `<ISO>|<uuid>` — token giờ là `<ISO>|<uuid>|<field>:<direction>[|p]` và cursor lệch ordering là
       422; `docs/admin-ops-monitoring-cost.md:21` vẫn nói list "không có cursor/filter/sort server-side".
       Câu thay thế viết sẵn ở §15.7 để việc còn lại là one-line.
     - `docs/22:27` ghi nguồn enforcement là `contracts public-api.ts PageQuerySchema`. **Sau cycle
       này phần substance đúng** (bound 1..100/default 20 thật sự nằm trong contracts và route import
       nó), **nhưng vẫn sai tên symbol**: route import `OPERATIONS_LIST_LIMIT_DEFAULT/_MAX`, còn
       `PageQuerySchema` thì route **không** import (nó là generic base cho list route khác). Docs lane
       cần đổi tên symbol; đừng chép nguyên câu cũ — đây là loại lỗi chính tôi đã phạm ở Mục 10 §10.3.
- **Δ24 đã thành hiện thực:** 0017 **đã được apply** lên `du_orchestrator_test` ⇒ mọi sửa đổi
  tiếp theo vào 0017 **phải là file 0018** (runner không có checksum, sửa tại chỗ sẽ bị
  `migrate()` bỏ qua im lặng). **Mục 17 đã đi đúng luật này:** 0018 là file mới; 0017 không bị chạm một byte nào (guard test pin cả hai).
- **Không được suy rộng từ diện ACCEPTED này:** backward hop **vẫn có Sort node** (quicksort
  46kB / 63 dòng — planner đúng; xem §10.2 vì packet đã paraphrase lần này thành "NO Sort node");
  row ADM-UX-02 vẫn `[~]` (Mục 14 không tự tick — thiếu sort cho audit/api-keys,
  ~~chưa có index cho hai khoá mới~~ **0018 đã có file + pin (Mục 17; hiệu lực live chờ EXPLAIN, Δ73)**, ~~cursor chưa ràng buộc với sort Δ52~~ **đã bind + từ chối lệch ở Mục 15, chỉ còn
  thiếu bằng chứng live keyset**); **ADM-UX-03 vẫn `[ ]`** (Mục 13 không tự tick —
  ~~UI chưa có control sort dù route đã phục vụ~~ **shell đã có control sort ở Mục 16 (code +
  offline — Δ54 khép phía code)**, vẫn chờ browser; thiếu business/action/time filter; và
  "debounce/cancel" lệch mô hình server-render, Δ45); `G-ADMIN-OPS` vẫn **NO-GO**.
  Delta: **Δ9–Δ86**.
- **Bài học kỹ thuật (Mục 4):** keyset cursor là **vị trí**, không phải trang — không thể suy ra
  “trang trước” chỉ bằng một row lookup; phải biết **hướng đi**, nên hướng được mang trong token (`|p|`).
  Test fake-db phải **thực thi** predicate/SQL thay vì trả hàng hardcode, nếu không nó xanh trong khi
  product sai (đã xảy ra ở Mục 3).
- **Blocker:** không có ở phía lane. Lưu ý môi trường (tái kiểm ở sweep Mục 15): full offline cho
  `1625 passed / 209 skipped / 1838 total` = **66 suite xanh / 17 suite skip (live-gated) / 1 suite đỏ
  (4 test)**. Suite đỏ là `connector-revision-http-offline.functional` (VAULT-06), **đỏ cả khi chạy đơn
  lẻ**, root cause tĩnh: fixture seed `tenantId: ''` tại dòng 122 nên
  `ConnectorRevisionBindingSchema.safeParse` fail ở `workflow.ts:160-166` → 403 trước hop HTTP. Không
  phải hồi quy của cycle này; đã được ghi không thuộc lane từ Mục 12 và bởi Platform lane.
- **Phạm vi ghi:** `services/orchestrator/src/server.ts` + `src/app/admin/operation-section-data.ts`
  (2 file trong scope-list packet) + file test. Không commit/push. Không mở cửa DB/Redis/S3 live.

---

## 1 — CYCLE 1: W-ADMUX-01 —Operations list phân trang server-side + nền responsive shell

**Định nghĩa win/lose của packet:** (1) rà soát Admin UI; (2) nền responsive layout +
điều khiển phân trang **server-side** cho danh sách operations; (3) lint/typecheck
`apps/admin` xanh; chỉ sửa trong Apps/admin; báo cáo tại đây.

**Kết quả: ĐẠT (3/3), kèm 5 điểm lệch khai ở Δ-DEVIATION.**

### 1.1 Rà soát hiện trạng

- `apps/admin/` **không tồn tại** trong repo;Admin dashboard/view-models thật sống ở
  `services/orchestrator/src/app/admin/` (29 file). Đây là phạm vi ghi của lane (nghĩa trong
  ngoặc đơn của packet — Δ1).
- Nền responsive ADM-UX-01 **đã có sẵn một phần** từ W48-O2: banner "What this turn proves"
  đã bỏ; shell flex + `min-width:0`; `@media (max-width:480px)`; `.adm-reflow-scroller`
  (`wrapTablesForReflow`) bọc mọi `<table>` ở cả ready-body và deferred-extras
  (`shell-server.ts:176`). Chu kỳ này **mở rộng**, không dựng lại — Δ4.
- **Defect tìm thấy (đã sửa trong lane):** đường live của operations list bị hỏng.
  `GET /admin/operations` (không `operationId`) gọi `GET /api/v1/operations` → envelope
  `{rows,total,limit}` nhưng `parseFetchPayload` chỉ hiểu `{operation}` → mọi lượt live list
  trả `not-found` rỗng; list pane chưa từng hiển thị dòng nào. Catalog path chỉ hiện hint
  "Latest: <id>".
- Hợp đồng server (read-only với lane này, `server.ts:1176-1207`): admin bearer hỗ trợ
  `limit` 1..100 (default 20), **không** cursor/offset; `total` là echo của `rows.length`
  → ADM-UX-02 (Platform API lane) sở hữu cursor contract. UI vì vậy không được bịa total.

### 1.2 Thay đổi (7 file, chỉ đường dẫn ghi rõ)

| File | Thay đổi |
|---|---|
| `src/app/admin/operation-section-data.ts` | Envelope mới `kind:'list'` (`OperationListOkResult` + `OperationListRow`); `OperationFetcherInput.listLimit/cursor`; `clampListLimit` (1..100, default 20 — khớp server); live list GET `?limit=&cursor=`; `parseListPayload` nhận cả `{rows,total,limit}` (admin) lẫn `{items,nextCursor}` (tenant/ADM-UX-02 forward-compat); rule thành thật total: page lệch limit → exact; page đầy mà server chỉ echo → `total:null`; row hỏng bị loại, không placeholder; catalog offline phân trang con trỏ `off:<base36>` với total thật. |
| `src/app/admin/operation-section-renderer.ts` | Pane `kind:'list'`: bảng 8 cột có `data-col` priority (`adm-col-p1..p4`), mỗi dòng link `?operationId=`; thanh `<nav class="admin-pagination">` (prev/next link-or-disabled, count có nhãn `exact`/`page`, page-size 20/50/100 với `aria-current`, note `data-pagination-cursor-unavailable` khi page đầy không cursor); list pane **không** có `<form>`/action mutation nào (`data-can-*=false` giữ nguyên discriminator); detail pane thêm back-link echo `limit`+`cursor`. |
| `src/app/admin/shell-router.ts` | `parseOperationListQuery` (export, clamp + cursor chặn 128 chars) → `resolveOperationExtras` truyền `listLimit/cursor` vào fetcher và renderer. |
| `src/app/admin/shell-render.ts` | CSS: pagination bar flex-wrap + collapse ≤480px; bảng list cell padding/`overflow-wrap:anywhere`; column priority qua media query (p4 ẩn ≤720, p3 ≤560, p2 ≤420 — p1 luôn còn; reflow scroller vẫn là chốt chặn cuối). Không sửa hành vi sẵn có. |
| `src/app/admin/index.ts` | Export bổ sung (additive): `OperationListOkResult/OperationListRow`, `clampListLimit`, `OPERATION_LIST_*`, `parseOperationListQuery`, `OperationListQuery`. |
| `tests/admin-operations-list-pagination.test.ts` | **Mới**, 22 test offline (xem 1.3). |
| `tests/admin-shell-render.test.ts` | **1 test legacy đổi assertion** (`list-view renders with all action discriminators disabled`): chuyển từ hint-pane sang pane mới — vì packet đổi đúng hành vi đó; giữ nguyên mọi check an toàn `data-can-*=false`, thêm check không `data-action="cancel-operation"`. |

### 1.3 Định nghĩa win/lose của suite mới (22 test)

- `clampListLimit`: default 20; 0/±NaN → kẹp 1..100; chuỗi số và float chấp nhận (trunc).
- `parseOperationListQuery`: thiếu/sai → `{20,null}`; `limit` kẹp 1..100; cursor cắt 128 ký tự.
- Catalog 45 dòng: page1 = 20 dòng + `total=45` + `nextCursor=off:20`, không prev; page giữa có
  đủ prev+next; trang cuối 5 dòng, `nextCursor=null`; cursor rác (`'<bad>'`) → quay về page 1,
  **không** rỗng giả.
- Live (fetchImpl mock, không socket): page lệch → total exact; page **đầy** mà server echo
  `total=rows.length` → `total:null`, render `data-list-total="unknown"` + Next disabled +
  note chỉ đích danh ADM-UX-02; server tuyên bố total lớn hơn page → hiển thị `2 of 137`;
  shape `{items,nextCursor,prevCursor}` → link Next/Prev mang cursor **nguyên văn**, URL gửi đi
  chứa `limit=50&cursor=off%3Ak`; row hỏng bị loại; payload không `rows/items` → `error`
  (không suy thoái thành empty); `rows:[]` → empty-state **có dữ liệu** (`data-list-count="exact"`,
  `0 of 0`) — phân biệt 0-event với unavailable (ADM-UX-04 rule).
- HTML contract: dòng link `?operationId=`; không `<form>`/không action trong list pane;
  bảng được `wrapTablesForReflow` bọc `.adm-reflow-scroller` (region + tabindex); cột p1..p4
  present; giá trị hostile (`<img>`, `<svg>`, cursor `'<svg>'`) bị escape cả trong text lẫn
  attribute.
- Back-link: detail echo `limit=50&cursor=off%3Ak`; không có context → `?limit=20`.

### 1.4 Bằng chứng chạy (offline, không DB/Redis/S3)

cwd `D:\Git\dugate\du-rework\services\orchestrator` cho mọi lệnh. Wrapper literal `Exit Code:`.

1. `npx tsc --noEmit -p tsconfig.json` (= script `lint` của package; packet mục 3)
   — phát hiện lỗi pass đầu + **3 pass liên tiếp: `Exit Code: 0`, `Exit Code: 0`, `Exit Code: 0`, output rỗng.**
2. `npx jest --runInBand --config jest.unit.config.cjs` **12 suite admin targeted**
   (list-pagination, shell-render, shell-router, shell-server, view-model ×6, p6-01-fixtures):
   — `Test Suites: 12 passed, 12 total` / `Tests: 640 passed, 640 total` — **x3 liên tiếp,
   `Exit Code: 0` cả ba lần** (2026-09-26 ~00:31–00:35 local).
3. Full offline sweep `npx jest --runInBand --config jest.unit.config.cjs` (mọi suite không
   live-gate, bao gồm cả ngoài admin):
   — `Test Suites: 1 skipped, 56 passed, 56 of 57 total` / `Tests: 15 skipped, 1313 passed, 1328 total`,
   `Exit Code: 0`. Suite skipped = suite live-gated trong unit config (SKIP ≠ PASS, không tính).
4. Không chạy suite DB-window nào (`admin-*-live`, `admin-base-routes`, `admin-audit`,
   `admin-error-boundary`, `admin-shell-live-pane`, `operation-tenant-fence`…) — chặn bởi luật
   lane; chúng nằm ở cửa Tester.

### 1.5 Thống kê file (bằng chứng untracked — `src/app/` và `tests/` admin đang `??` trong `git status`, không dùng được `git diff`)

```
src\app\admin\operation-section-data.ts             | lines=883  | bytes=32009 | mtime=2026-09-26 00:28:39
src\app\admin\operation-section-renderer.ts         | lines=561  | bytes=25621 | mtime=2026-09-26 00:33:52
src\app\admin\shell-router.ts                       | lines=1141 | bytes=42244 | mtime=2026-09-26 00:28:39
src\app\admin\shell-render.ts                       | lines=527  | bytes=22819 | mtime=2026-09-26 00:29:07
src\app\admin\index.ts                              | lines=98   | bytes=3898  | mtime=2026-09-26 00:29:07
tests\admin-shell-render.test.ts                    | lines=2769 | bytes=106684| mtime=2026-09-26 00:29:53
tests\admin-operations-list-pagination.test.ts      | lines=427  | bytes=17281 | mtime=2026-09-26 00:33:52
```

Không commit, không push, không staging.

---

## Δ-DEVIATION (chờ coordinator adjudicate)

- **Δ1 — Phạm vi ghi:** `apps/admin/` không tồn tại; lane ghi trong
  `services/orchestrator/src/app/admin/` (đúng nghĩa ngoặc đơn "hoặc các component Admin
  dashboard/view-models" của packet). Không sửa `server.ts` hay bất kỳ file ngoài `src/app/admin/`.
- **Δ2 — File test ngoài thư mục lane:** tạo MỚI `tests/admin-operations-list-pagination.test.ts`
  và SỬA 1 test trong `tests/admin-shell-render.test.ts` (assertion của hành vi mà packet yêu cầu
  đổi). Lý do: AGENTS.md du-rework bắt buộc bằng chứng test cho logic mới; nếu coordinator muốn
  strict-path-only, revert phần test và mở follow-up packet cho Tester.
- **Δ3 — "Phân trang server-side" chỉ đạt một nửa hợp đồng hiện hành:** page size là server-side
  thật (`limit` được enforce bằng SQL LIMIT, UI không bao giờ lọc client-side); nhưng trang 2+
  **không thể có** vì admin list route chưa có cursor/offset (`server.ts:1176-1207`, ADM-UX-02
  thuộc Platform API lane). Lane KHÔNG sửa server.ts; thay vào đó UI map sẵn cả shape
  `{items,nextCursor}` tương lai — ADM-UX-02 vừa merge là phân trang đa trang chạy không cần
  đụng UI. Trang thái hiển thị trung thực (Next disabled + note), không giả page 2 rỗng.
- **Δ4 — Nền responsive đã tồn tại một phần (W48-O2):** chu kỳ này cộng column priority
  (p1..p4), pagination bar wrap, cell `overflow-wrap`; không gỡ code W48-O2.
- **Δ5 — ADM-UX-00 không có deliverable ảnh/wireframe:** packet chỉ đạo rà soát + build +
  lint; journey/baseline 1440×900 / 390×844 / 320px của ADM-UX-00 cần browser gate (người giữ:
  QA + cửa ADM-UX-07), ngoài luật offline-only của lane. Ghi lại để coordinator khỏi chờ.

**Đề xuất nghiệm thu (không tự tick):** Reviewer/Tester mở cửa live pane `admin-shell-live-pane`
+ screenshot desktop/mobile cho slice này khi có packet; đối chiếu Δ2/Δ3.

---

## 2 — CYCLE 2: W-ADMUX-03-FILTER-1 — Search/filter toolbar + deep link thống nhất cho Operations list

**Định nghĩa win/lose của packet:** toolbar (state chips ALL/RUNNING/COMPLETED/FAILED/TIMED_OUT,
tenant, ID search), chip + clear-all, giữ query trong deep link, debounce/cancel + không rò secret,
test vào `admin-operations-list-pagination.test.ts`, tsc + jest x3 exit 0, offline-only, receipt.

**Kết quả: ĐẠT (mục 1–5), 2 điểm lệch khai ở Δ-DEVIATION 6–7.**

### 2.1 Thay đổi (4 file, cùng đường dẫn lần trước)

| File | Thay đổi |
|---|---|
| `src/app/admin/operation-section-data.ts` | `OperationStateFilter` enum + `OPERATION_STATE_FILTERS` + nhóm state (RUNNING = ACCEPTED/QUEUED/RUNNING/RETRY_PENDING/WAITING_CHILDREN/CANCEL_REQUESTED/WAITING_INPUT; COMPLETED = SUCCEEDED; CANCELLED chỉ dưới ALL); `sanitizeStateFilter` (allowlist) + `sanitizeFilterToken` (charset + chặn hex ≥32 ký tự dạng raw key); `resolveListFilters` trả effective + `ignoredFilters`; `applyListFilters` lọc page-local trên row đã normalise; envelope `OperationListOkResult` + `filters`/`ignoredFilters`/`pageRows`; fetcher input + `stateFilter/tenantFilter/idFilter`. **Không** gửi param filter lên server (xem Δ7). |
| `src/app/admin/operation-section-renderer.ts` | Toolbar GET (`<form method="get" action="/admin/operations">`, select state + tenant + ID, hidden `limit`, nút Apply — không có JS, không POST); chip mỗi filter kèm link bỏ riêng (giữ filter còn lại, reset cursor) + `Clear all`; chip cảnh báo cho token bị từ chối (chỉ nêu tên, không echo giá trị); count khi có filter: `"X of Y rows on this page match the filters"`; empty dưới filter: `data-list-empty="filtered"` + chỉ ADM-UX-02; prev/next/size/back-link mang filter. |
| `src/app/admin/shell-router.ts` | `parseOperationListQuery` đọc `state/tenant/id` (raw, ≤128 chars) + `listFilters` (sanitized echo); `resolveOperationExtras` truyền cả 3 raw filter + `listFilters` xuống fetcher/renderer. |
| `src/app/admin/shell-render.ts` | CSS toolbar/chip: flex-wrap grid, 1 field/row ≤480px, chip pill + dashed clear-all, màu chip từ chối. |

### 2.2 Định nghĩa win/lose của suite mới (17 test, cùng file)

- Query: `state/tenant/id` thô đi qua; echo sanitize; state rác → echo `ALL` (fetcher báo ignored).
- Nhóm state: RUNNING khớp cả nhóm chờ người; COMPLETED = SUCCEEDED; CANCELLED chỉ ở ALL; state rác → ignored `[state]`, không echo vào envelope.
- Tenant exact-match; ID substring không phân biệt hoa thường; 3 filter giao nhau (AND).
- An toàn: chuỗi hex ≥32 (raw key) bị từ chối, `ignoredFilters=[id]`, **không** xuất hiện trong HTML; token rác chỉ hiện tên chip.
- Live: URL gửi server chỉ có `limit` (+cursor), không `state/tenant/id`; lọc áp page, `pageRows` = số dòng server trả.
- UI: option đang chọn có `selected`; input echo giá trị đã sanitize; limit ẩn; link bỏ state giữ tenant+limit và bỏ cursor; `Clear all` → `?limit=20`; count `filtered-page` không bịa tổng; link phân trang/size mang filter; empty dưới filter nêu ADM-UX-02; detail back-link phục hồi list đang lọc.

### 2.3 Bằng chứng (offline)

cwd `…\services\orchestrator`; wrapper literal `Exit Code:`.

1. `npx tsc --noEmit -p tsconfig.json` — discovery pass + **3 pass liên tiếp `Exit Code: 0`**.
2. `npx jest --runInBand --config jest.unit.config.cjs` 12 suite admin targeted (cùng danh sách Mục 1):
   `Test Suites: 12 passed` / **`Tests: 656 passed, 656 total` ×3, `Exit Code: 0` cả ba**
   (Mục 1: 640 → nay 656, +16 test filter mới; 1 test live-path phát hiện lỗi dữ liệu mock của chính
   test, đã sửa mock chứ không sửa product — ghi minh bạch).
3. Full offline sweep 1 lần: `1 skipped, 57 passed, 57 of 58` / `15 skipped, 1342 passed, 1357 total`, `Exit Code: 0`.
4. Không DB/Redis/S3; không commit/push.

### 2.4 Thống kê file (untracked — dùng lines/bytes/mtime, không `git diff`)

```
src\app\admin\operation-section-data.ts        | lines=1054 | bytes=38851 | mtime=2026-09-26 01:00:09
src\app\admin\operation-section-renderer.ts    | lines=683  | bytes=31714 | mtime=2026-09-26 01:02:18
src\app\admin\shell-router.ts                  | lines=1168 | bytes=43490 | mtime=2026-09-26 00:57:02
src\app\admin\shell-render.ts                  | lines=541  | bytes=24480 | mtime=2026-09-26 00:59:13
tests\admin-operations-list-pagination.test.ts   | lines=658  | bytes=27805 | mtime=2026-09-26 01:03:04
```

---

## Δ-DEVIATION Mục 2 (chờ coordinator adjudicate)

- **Δ6 — Sửa thêm 1 file ngoài scope-list:** `shell-router.ts` (mở rộng `parseOperationListQuery`
  + pass-through). Lý do: `?state/tenant/id` chỉ đi được từ request.query vào fetcher qua router; không
  sửa router thì toolbar không có dữ liệu để lọc (dead code). Thay đổi additive, nằm trong
  `src/app/admin/`, không chạm `server.ts`.
- **Δ7 — “Debounce/cancel request cũ” không áp dụng được:** shell là server-rendered thuần (không JS —
  thiết kế cố ý); mỗi lần submit là một GET navigation mới, không có fetch client song song để hủy.
  Rủi ro stale-response vốn đã bị chặn bởi mô hình per-request của shell + timeout AbortController 4 s
  trong fetcher. Nếu coordinator muốn client JS (debounce thật), cần packet riêng + CSP/security lane.
- **Δ8 — Lọc là page-local, không gửi param lên server:** admin list route (ADM-UX-02) chưa có filter
  allowlist; UI lọc trong page đã tải (≤100 dòng) và nói rõ “X of Y rows on this page” + empty-filter
  trỏ ADM-UX-02. Không gửi tham số đoán trước lên server để tránh ADM-UX-02 reject 422 khi siết allowlist;
  khi ADM-UX-02 có allowlist, sẽ cần 1 follow-on nhỏ (bật cờ wire) — ghi tại đây để không bị chôn.


---

## 3 — CYCLE 3: W-ADMUX02-SRV-1 — Query + cursor contract server-side cho `GET /api/v1/operations`

**Định nghĩa win/lose của packet:** (1) `state`/`tenant`/`cursor`/`limit` trên
`GET /api/v1/operations`; (2) `nextCursor` ổn định thay cho `null` cứng, envelope
`{items, nextCursor, total}`, `total` là COUNT thật; (3) allowlist chống query injection;
(4) UI fetcher truyền filter lên server; (5) test offline + tsc exit 0 + jest ×3 exit 0;
(6) offline only, không DB window, không commit/push.

**Kết quả: ĐẠT (6/6) ở mức VERIFIED-OFFLINE.** Đây là packet đóng Δ8 của Mục 2.

### 3.1 Vì sao phải sửa (bám đúng finding T20-A1)

`server.ts:1176-1207` cũ: admin bearer trả `{rows,total,limit}` với `total = rows.length`
(tức echo số dòng trả về, **không phải** quần thể), **không** cursor, **không** filter; nhánh
x-api-key luôn trả `nextCursor: null` cứng. Đó đúng là ba lỗi Reviewer nêu. Hệ quả thật:
một operation khớp ở trang 2+ không tìm được; trang rỗng dưới filter có thể cùng tồn tại với
dòng khớp ở trang khác; nút “Trang sau” chết vĩnh viễn.

### 3.2 Thay đổi (2 file trong scope-list, không file ngoài scope)

| File | Thay đổi |
|---|---|
| `src/server.ts` | Khối contract mới `ADM-UX-02` ngay trước `toOperationDetailWire` (~275 dòng): `OPERATIONS_LIST_DEFAULT_LIMIT/MAX_LIMIT/CURSOR_MAX_LEN`; `parseOperationsListQuery` (export, thuần) + `sanitizeOperationsListToken` + `decodeOperationsListCursor`; `buildOperationsListPredicates` (chỉ sinh **template** predicate, mọi giá trị đều bind `$n`); `bindOperationsCursor`; `listOperationsPage` (keyset + count + prev-lookup). Route `GET /api/v1/operations` viết lại: **một** contract cho cả hai nhánh. |
| `src/app/admin/operation-section-data.ts` | Fetcher gửi `state`/`tenant`/`id` (đã sanitize) lên URL; `parseListPayload` coi `total` từ server là **authoritative** (COUNT thật) thay vì nghi ngờ echo; `buildListFromCatalog` lọc **quần thể trước, phân trang sau** (đúng thứ tự server); cập nhật 5 doc-comment đã lỗi thời. |

**Hợp đồng mới:** `?state=RUNNING|COMPLETED|FAILED|TIMED_OUT` (enum UI, không phải state máy),
`?tenant=<uuid/token>`, `?id=<substring>`, `?limit=` (default 20, clamp 1..100), `?cursor=<opaque>` →
`{ items, nextCursor, prevCursor, total, limit }`.

**Vì sao chọn keyset `(created_at, id)` chứ không offset:** ADM-UX-02 yêu cầu “cùng filter qua
nhiều trang không mất/trùng dòng khi thêm bản ghi”. Offset trượt khi có insert giữa hai lượt xem;
keyset thì insert rơi **trên** con trỏ nên đơn giản là nằm ngoài cửa sổ trang hiện tại.
`id` là tiebreak bắt buộc vì `created_at` không unique — thiếu nó thì các dòng trùng phút sẽ
mất/đôi. Ba statement có giới hạn: probe `limit+1` (dòng thừa là bằng chứng duy nhất của trang sau),
`count(*)` trên quần thể **đã lọc**, và lookup `LIMIT 1` chỉ khi có cursor để dựng `prevCursor`.

**Chống injection:** allowlist 4 tên tham số, mỗi tên một validator; không có text người dùng nào
được nối vào SQL — chỉ có template predicate sinh sẵn; `ORDER BY` là literal cố định nên không có
bề mặt `ORDER BY` injection. Token sai → **422 INVALID_SCHEMA** (báo ra, không âm thầm bỏ qua, để
caller không tưởng filter đã áp). Cursor: base64url → `<ISO chuẩn>|<uuid>`, instant phải round-trip
đúng qua `toISOString()` nên thứ bind vào `::timestamptz` luôn là ISO thật, không bao giờ là ngày
cụt mà Postgres sẽ hiểu theo timezone server. `id` dùng `strpos(lower(id::text), lower($n))` chứ
**không** `LIKE`, vì lớp ký tự cho phép `_` — mà `_` là wildcard LIKE một ký tự; substring search
không được tự nhiên sinh ngữ nghĩa wildcard từ thao tác gõ của operator.

**Fence tenant (không nới lỏng):** phạm vi tenant đến từ **credential**, không phải tham số.
Platform principal được thu hẹp về tenant nào cũng được qua `?tenant=`; tenant operator bị ghim
về tenant của nó bằng SQL predicate và **403** khi xin tenant khác (đúng câu chữ canonical
`admin reads are scoped to the caller tenant` — giống hệt foreign lẫn unknown, không rò tenant).
Nhánh x-api-key vẫn bị key ghim tenant (R24-01 giữ nguyên); `?tenant=` lệch → 403 chứ không bị
bỏ qua âm thầm, để không caller nào tưởng mình đã mở rộng tầm nhìn.

### 3.3 Định nghĩa win/lose của test mới (30 test, cùng file)

Suite `parseOperationsListQuery allow-list` (8): default mọi filter; clamp `limit` 0/9999/abc/7;
4 state hợp lệ kể cả hoa/thường + khoảng trắng; state ngoài enum và state có dấu nháy → 422;
token tenant/id hợp lệ; 6 dạng injection (quote/`OR 1=1--`, `;`, space, `../..`, `<script>`, 65 ký tự) → 422;
raw key hex 56 ký tự → 422; cursor rác / cursor >128 ký tự → 422.
Suite `GET /api/v1/operations envelope` (6): envelope đúng key set; `total` = COUNT chứ không phải số dòng;
trang ngắn → hết, trang đầy+1 dòng → có `nextCursor` **lấy từ dòng cuối của trang** (không phải dòng probe)
và `LIMIT` bind = limit+1; **round-trip thật**: cursor trang 1 dùng lại được ở request trang 2;
trang 1 không chạy prev-lookup, trang 2 trả `prevCursor` là đúng cursor trang 1 đã dùng; trang 2 không có
dòng phía trên → `prevCursor: null`.
Suite `filters are server-side, bound, and tenant-fenced` (8): `state` thành `state = ANY($1::text[])`
bind, chữ `FAILED` **không** nằm trong SQL, count query thấy cùng filter; nhóm RUNNING đủ 7 state;
tenant thành `tenant_id = $1` bind; id dùng `strpos` và SQL **không** có `LIKE`; không tham số nào của
caller lọt vào text SQL; tenant operator bị ghim + 403 khi xin tenant khác **và 0 query đã chạy**;
x-api-key bị key ghim + 403; filter rác → 422 **trước** khi chạy query.
Suite `toolbar is wired` (4): URL mang `state`/`tenant`/`id`; vẫn lọc page-local làm defence-in-depth
cho build cũ; token bị từ chối **không** vào URL; trang rỗng dưới filter là data (0).

### 3.4 Bằng chứng (offline)

cwd `…\services\orchestrator`; wrapper literal `Exit Code:`.

1. `npx tsc --noEmit -p tsconfig.json` — discovery + sửa file test — **3 pass liên tiếp `Exit Code: 0`**.
2. `npx jest -c jest.unit.config.cjs` 10 suite admin targeted (pagination, shell-render, audit-scope,
   4 view-model, action-dispatcher, multipart-routes-offline, br12-isolation-offline):
   `Test Suites: 10 passed, 10 total` / **`Tests: 525 passed, 525 total` ×3 `Exit Code: 0`**
   (thực tế chạy 5 lượt liên tiếp, cả 5 đều 525/525 exit 0).
3. Suite riêng: `Tests: 65 passed, 65 total`, `Exit Code: 0` (Mục 2 là 48; nay +17 net).
4. **Full offline sweep: 4 suite ĐỎ, không phải của lane này** —
   `4 failed, 1 skipped, 54 passed, 58 of 59` / `13 failed, 15 skipped, 1377 passed, 1405 total`, `Exit Code: 1`.
   Điều tra từng cái, không quy cho lỗi mình:
   - `mock-vault-harness-offline.functional` (8) + `connector-revision-http-offline.functional` (4):
     đều dừng ở `src/modules/connector-credentials/workflow.ts:166` `BINDING_DENIED`. Cả thư mục
     `connector-credentials/` lẫn 2 file test này đều **untracked** (`git status` = `??`) — việc
     đang-dở của lane khác trên shared checkout này. Chúng **không** import `operation-section-data`
     và **không** gọi `/api/v1/operations` (grep 0 match). Số suite cũng 58 → 59, đúng bằng 2 suite mới.
   - `admin-error-boundary-offline` + `webhook-error-boundaries.boundary`: lỗi
     `connect ETIMEDOUT 127.0.0.1:64463` (loopback HTTP thật). Chạy **riêng** 2 suite này:
     `2 passed` / `53 passed, 53 total`, `Exit Code: 0` — flake tranh chấp port khi sweep song song 59 suite.
   - Cùng sweep Mục 2 (2026-09-26 ~01:00) từng xanh `57 passed`; chênh lệch là do việc lane khác,
     không phải do cycle này.
5. Không DB/Redis/S3; không commit/push. Không mở cửa live.

### 3.5 Minh bạch sự cố trong lúc làm

- File test bị hỏng **do chính tôi** khi nối `read_file().output` (bản render có tiền tố số dòng và
  bị cắt ở 595/751 dòng) vào rồi `write_file` lại. Phát hiện ngay ở lần chạy jest kế tiếp (syntax
  error), **không** có giao dịch/commit nào để hoàn tác. Đã sửa bằng cách dựng lại từ các phần còn
  nguyên vẹn (596 dòng đầu) + phần đuôi viết lại từ nội dung gốc đã đọc + block server mới, rồi
  **typecheck sạch** và **65/65 xanh**. Bài học đã ghi: không bao giờ nối `read_file().output` vào
  `write_file`; muốn append thì `edit`, hoặc đọc bằng tool khác.
- 4 assertion cũ **đổi vì contract đổi** (ghi minh bạch, không giấu): (a) “total echo → unknown” nay
  là “không có count thì unknown”, vì theo contract mới `total` là COUNT thật; (b)+(c) catalog nay
  lọc quần thể trước nên `pageRows` 7→3 và nhãn `1 of 3`→`1 of 1`; (d) suite “live path stays
  page-local, sends no speculative wire params” **bị thay** bằng suite mới khẳng định filter **có**
  gửi lên server — đây chính là điều Δ8 chờ, giờ đóng.

### 3.6 Thống kê file

```
src\server.ts                                    | lines=2483 | bytes=113321 | mtime=2026-09-25 18:40:41
src\app\admin\operation-section-data.ts          | lines=1080 | bytes=40422  | mtime=2026-09-25 18:41:07
tests\admin-operations-list-pagination.test.ts   | lines=1187 | bytes=49402  | mtime=2026-09-25 18:56:48
```

`src/server.ts` là file **tracked** nhưng mang delta chưa commit rất lớn từ công việc branch khác
(HEAD chỉ 374 dòng, bản hiện tại 2483) — nên `git diff --stat` hiện ~2206 insertions, **không**
phải 2206 dòng của cycle này. Delta của cycle này là khối ADM-UX-02 (~275 dòng) + viết lại route.
Hai file kia untracked nên dùng lines/bytes/mtime.

---

## Δ-DEVIATION Mục 3 (chờ coordinator adjudicate)

- **Δ9 — Envelope có thêm `prevCursor` và `limit` so với 3 key packet nêu** (`{items,nextCursor,total}`).
  Lý do: renderer Mục 1 đã vẽ nút “Previous” lấy từ `prevCursor`; nếu route không trả keyset-prev thì
  từ trang 3 trở đi nút đó là link chết, tức là **hồi quy** so với ADM-UX-03. `prevCursor` chỉ tốn một
  lookup `LIMIT 1` và chỉ chạy khi request có cursor. `limit` là echo để UI render đúng page size.
  Cả hai đều additive, không phá consumer.
- **Δ10 — Cho phép `?id=` ngoài 4 tham số packet liệt kê** (`state`,`tenant`,`cursor`,`limit`).
  Lý do: toolbar Mục 2 đã có ô tìm ID; nếu chỉ gửi `state`+`tenant` thì ô ID sẽ **âm thầm** kệt
  page-local trong khi hai ô kia đã lọc toàn tập — không nhất quán và gây hiểu nhầm cho operator.
  Đây cùng cơ chế allowlist, cùng lớp ký tự, chỉ thêm một predicate.
- **Δ11 — Nhánh x-api-key không còn đi qua `runtime.listOperations`, gọi SQL trực tiếp như nhánh admin.**
  Lý do: cần `count(*)` + keyset cursor + prev-lookup trên cùng một connection; `listOperations`
  cũ (`created_at < (SELECT …)`) chính là offset-ish cursor không ổn định. Fence R24-01 giữ nguyên
  (`tenant_id` luôn từ key). Hệ quả: `runtime.listOperations` **không còn caller nào** — **không xóa** vì
  ngoài scope packet và có thể lane khác đang dùng; ghi lại ở đây.
- **Δ12 — Docs contract CHƯA cập nhật (việc còn mở, không phải lỗi).** `docs/06` mô tả envelope
  `{items, nextCursor}`; nay route trả `{items, nextCursor, prevCursor, total, limit}` và có allowlist
  mới. Theo AGENTS.md phần “đồng bộ spec” thì owner phải cập nhật contract + `docs/19-traceability-audit-matrix.md`
  (BR) — nhưng docs thuộc docs lane và ngoài scope packet, nên **cần packet follow-on cho docs lane**.
  Tới lúc đó, contract trên wire là nguồn sự thật và docs đang **stale** (mở MISMATCH nếu Reviewer cần).
- **Δ13 — Index hỗ trợ chưa có (việc còn mở).** Migration hiện có
  `operations_tenant_created (tenant_id, created_at DESC)`; sort của keyset là
  `(created_at DESC, id DESC)` nên Postgres có thể phải sort thêm. Cần index
  `(tenant_id, created_at DESC, id DESC)` để ADM-UX-02 đạt “index/query-plan test cho dữ liệu lớn”.
  `migrations/` ngoài scope packet và cần cửa DB để verify EXPLAIN — **để mở cho packet sau / Tester**.
- **Δ14 — Renderer chưa đổi câu chữ (ngoài scope, câu nói vẫn đúng nhưng đã lạc hậu).**
  `operation-section-renderer.ts:535` vẫn in “X of Y rows on this page match the filters” và `:580`
  vẫn trỏ “Whole-population filtering arrives with the ADM-UX-02 server contract”. Nay ADM-UX-02 **đã**
  tới nên câu thứ hai thành lạc hậu; câu đầu vẫn đúng (X==Y khi server đã lọc) nhưng thừa. Sửa cần
  packet mở rộng scope sang renderer + cập nhật assertion của `admin-shell-render.test.ts`. **Còn mở.**


---

## 4 — CYCLE 4: W-ADMUX02-SRV-1-FIX — `prevCursor` là một **nhảy lùi thật**, không phải trang đầu rơi về

**Định nghĩa win/lose của packet:** (1) `listOperationsPage` phải trả `prevCursor` dẫn về đúng
trang trước; (2) có test roundtrip trang 1 → 2 → 1; (3) verify bằng lệnh pnpm được giao; (4) receipt.

**Kết quả: ĐẠT — nhưng sửa **2 lỗi**, không phải 1. Lỗi thứ hai chỉ lộ ra nhờ test roundtrip.**

### 4.1 Lỗi 1 — prevCursor trỏ ngược vào chính trang hiện tại

Code cũ (Mục 3 §3.2/3.3 đã ghi) làm lookup “dòng ngay phía trên `firstRow`” rồi đóng cursor đó.
Với sort `ORDER BY created_at DESC, id DESC`, dòng *phía trên* `firstRow` tức là dòng **mới hơn**
— tức là dòng thuộc về chính trang đang xem. Trace trên quần thể 8 dòng, limit 2:

```
page1=[r1,r2]  page2=[r3,r4]  page3=[r5,r6]  page4=[r7,r8]
page2.firstRow = r3
lookup "dòng mới hơn r3" theo DESC, LIMIT 1  ->  r1   (r1 thuộc page1, r2 thuộc page1)
```

Rõ hơn: dùng `r1` làm cursor forward thì ra `[r2,r3]` — **lẫn dòng của page1 và page2**, không
phải page1. Nên nút “Previous” trước đây không hề quay lại trang trước.

**Vì sao `> firstRow` + ASC + reverse (cách gợi ý trong packet) cũng chưa đủ:** keyset cursor là
một **vị trí**, không phải một trang. Truy vấn forward (`key < cursor`, DESC) **không bao giờ** trả về
được trang 1, vì cần một cursor có rank < 1 mà không tồn tại. Kiểm bằng mô phỏng: với `firstRow`
của page3, cả ASC+reverse lẫn DESC đều trả `[r1,r2]` thay vì `[r3,r4]` — **lệch nguyên một trang**.
Muốn đúng bắt buộc phải lấy `limit` dòng *mới hơn* `firstRow`, theo **ASC** để `LIMIT` rơi vào
đúng khối liền kề rồi **đảo lại** — và phải cho route biết đó là hướng lùi.

### 4.2 Sửa: cursor mang **hướng đi** trong chính token

Route chỉ có **một** tham số `?cursor=`; UI (`operation-section-renderer.ts:524`) chỉ phát
`?cursor=<prevCursor>` — không có tham số thứ hai để nói “đi lùi”. Nên hướng phải nằm trong token:
`<ISO>|<uuid>[|p]`, `|p` = backward.

| Mảng | Trước | Sau |
|---|---|---|
| Cursor | `ISO|uuid` | `ISO|uuid` (next) hoặc `ISO|uuid|p` (prev); `OperationsListCursor.direction` |
| Predicate | `(created_at,id) < (ts,id)` | `<` khi next, `>` khi prev (`bindOperationsCursor`) |
| ORDER BY | `DESC` | `ASC` khi prev, `DESC` khi next — ASC để `LIMIT` chọn khối **liền kề** biên |
| Thứ tự dòng | — | `pageRows.reverse()` khi prev, để mọi trang đều hiển thị mới-nhất-trước |
| prevCursor | lookup “dòng phía trên” (`LIMIT 1`) | encode `firstRow` của trang hiện tại, mark `prev` — **không cần query phụ** |

Hệ quả có lợi: **request chỉ còn 2 statement** (trước là 3) — bỏ hẳn lookup `LIMIT 1`.

### 4.3 Lỗi 2 — lùi tới trang 1 vẫn phát prevCursor (link tự tham chiếu)

Test roundtrip bắt được: lùi về page1 xong `prevCursor` **vẫn khác null**. Lý do: guard cũ chỉ
kiểm `query.cursor` có tồn tại, mà lượt lùi thì có cursor. Hệ quả thật: pane render nút
“Previous” trên trang 1, bấm vào lại quay về trang 1 — vô nghĩa.

Sửa: `hasPageAbove = backwards ? hasMore : query.cursor !== null`. Diễn giải: một trang có trang ở
trên khi và chỉ khi có dòng **mới hơn `firstRow`** của nó. Lượt đi tới luôn có (ta vừa từ đó tới);
lượt đi lùi chỉ có khi probe ASC thấy dòng thứ `limit+1` — dòng đó mới hơn mọi dòng trả về, tức là
đỉnh của một trang nữa.

### 4.4 Test mới (5 test, suite `W-ADMUX02-SRV-1-FIX`)

Fake db **có trạng thái**: thực sự áp predicate `(created_at,id) <op>` đọc từ SQL + ORDER BY +
LIMIT (nên test sẽ đỏ nếu route đổi hướng mà fixture không theo). Không còn fixture `above`
hardcode — chính cách hardcode đó khiến test cũ **xanh trong khi product sai**.

1. **Roundtrip 1 → 2 → 1**: rows trả về **giống hệt** page1 (so cả id lẫn thứ tự), và page1 lúc
   này `prevCursor = null`.
2. Đi sâu 3 trang rồi lùi từng trang: `[[1,2],[3,4],[5,6]]` → lùi ra `[3,4]` → `[1,2]`, không
   trùng không lỗi.
3. Cursor lùi **phải** là ASC + `>` (DESC sẽ lấy dòng mới nhất phía trên và lỗi một trang).
4. Lùi tới trang 1 → `prevCursor = null` (chống link tự tham chiếu), nhưng lượt đi tới vẫn có.
5. Trang cuối lệch (5 dòng / limit 2) vẫn có trang trước, và lùi về đúng `[3,4]`.

### 4.5 Bằng chứng (offline)

cwd `…\du-rework` (lệnh pnpm) và `…\services\orchestrator` (tsc/jest); wrapper literal `Exit Code:`.

1. `pnpm --filter @du/orchestrator test -- tests/admin-operations-list-pagination.test.ts`
   → `Test Suites: 1 passed` / `Tests: 70 passed, 70 total`, **×3 liên tiếp `Exit Code: 0`**
   (Mục 3 là 65; nay +5 test FIX).
2. `npx tsc --noEmit -p tsconfig.json` — **3 pass liên tiếp `Exit Code: 0`**.
3. Hồi quy 10 suite admin (cùng danh sách Mục 3):
   `Test Suites: 10 passed, 10 total` / `Tests: 530 passed, 530 total` **×3 `Exit Code: 0`**
   (Mục 3: 525 → 530, +5 test mới; **không** test cũ nào bị xoá hay nới lỏng).
4. Test cũ đã **thay thế** (không xoá im lặng): `page 1 never looks for a previous page; page 2+
   returns a real prev cursor` bị bỏ vì nó **chứng minh sai** (assert theo hàng hardcode).
   Thay bằng `page 1 reports no previous page` + suite FIX ở §4.4.
5. Không DB/Redis/S3; không commit/push.

### 4.6 Thống kê file

```
src\server.ts                                    | lines=2527 | bytes≈114.6 KB
tests\admin-operations-list-pagination.test.ts   | lines=1321 | bytes≈53.5 KB
```

---

## Δ-DEVIATION Mục 4

- **Δ15 — Lệch so với cách sửa được giao, vì cách giao sai về mặt ngữ nghĩa.** Packet yêu cầu
  “query `(created_at,id) > firstRow`, ASC, reverse”. Tôi **không** làm đúng câu đó một cách
  mù quáng: mô phỏng cho thấy `> firstRow` + ASC + `LIMIT 1` vẫn lệch một trang (xem §4.1), vì
  cursor là **vị trí** chứ không phải trang. Sửa đúng đắn phải gồm 3 thứ: (a) lấy `limit` dòng mới
  hơn `firstRow` theo **ASC** rồi **đảo**; (b) predicate phải là `>` **và** cursor phải **mang
  hướng đi** (`|p`) vì route chỉ có một tham số `?cursor=`; (c) bỏ query lookup `LIMIT 1`. Nếu
  chỉ làm (a) mà không có (b), nút “Previous” vẫn hỏng — và đó chính là lý do tôi ghi Δ này thay vì
  im lặng làm khác đi.
- **Δ16 — Định dạng cursor thay đổi (`ISO|uuid` → `ISO|uuid[|p]`).** Token cũ (chưa từng ra
  production, chỉ sinh trong Mục 3) vẫn decode được như cũ và mặc định `next`, nên **không** phá
  deep link đã lưu. Ghi rõ vì docs/06 (Δ12) cần mô tả đúng dạng này.


---

## 5 — CYCLE 5: W-ADMUX02-CLEAN-1 — Xoá câu chữ ADM-UX-02 "sẽ tới" ở list rỗng dưới filter (đóng Δ14)

**Định nghĩa win/lose của packet:** (1) `operation-section-renderer.ts:580` không còn hứa hẹn
ADM-UX-02 ở tương lai; (2) assertion tương ứng được cập nhật; (3) verify bằng lệnh pnpm được giao;
(4) receipt. Offline only, không commit/push.

**Kết quả: ĐẠT (4/4).** Đây là **Reviewer Turn 40** — finding review.md:18 xác nhận Δ14 của Mục 3.

### 5.1 Câu chữ cũ và lý do sai

```
CŨ: "No rows on this page match the active filters — other pages may contain matches.
     Whole-population filtering arrives with the ADM-UX-02 server contract."
```

Cả hai vế đều lỗi theo contract mới:
- **"other pages may contain matches"** — sai. Sau Mục 3, `state/tenant/id` đã là query param allowlist
  của server, nên server lọc **toàn tập** rồi mới phân trang. Trang rỗng dưới filter = **không có
  dòng nào khớp**, không phải "chưa chắc ở trang khác".
- **"arrives with the ADM-UX-02 server contract"** — sai về mặt thời gian; contract **đã** tới.

Câu mới (giữ nguyên attribute `data-list-empty="filtered"` vì đó là hợp đồng DOM mà CSS/test dựa vào):

```
MỚI: "No operations match the active filters. The server filters the whole population, so this
      is an empty result, not a page you need to page through — clear a filter to widen the search."
```

Vẫn phân biệt được với nhánh không-filter (`data-list-empty="true"` = "platform reported zero rows"),
vẫn chỉ ra hành động (clear filter — khớp với `data-filter-clear-all` đã có sẵn trong chip row).

### 5.2 Δ17 — File test trong packet **không chứa** assertion cần sửa

Packet ghi "update associated assertions in `tests/admin-shell-render.test.ts`". Đã kiểm tra:
grep `list-empty|on this page|pagination-cursor-unavailable|list-count` trong file đó → **0 match**.
`admin-shell-render.test.ts` (2769 dòng) **không assert** câu chữ này; chạy nó trước khi sửa cũng
xanh. Assertion thật duy nhất nằm ở
`tests/admin-operations-list-pagination.test.ts` (test `empty-under-filter…`) — **ngoài danh sách
file của packet**. Không sửa file đó thì `not.toContain`/`toContain` cũ sẽ đỏ ngay.

Vì vậy: sửa **thêm** 1 file test ngoài scope-list (Δ17), và **không** sửa `admin-shell-render.test.ts`
(vì không có gì để sửa — ghi rõ để không bị hiểu là bỏ sót).

### 5.3 Bằng chứng (offline)

cwd `…\du-rework` (pnpm) và `…\services\orchestrator` (tsc); wrapper literal `Exit Code:`.

1. `pnpm --filter @du/orchestrator test -- tests/admin-shell-render.test.ts` (lệnh packet giao)
   → `Test Suites: 1 passed` / `Tests: 136 passed, 136 total`, **×3 liên tiếp `Exit Code: 0`**.
2. `pnpm --filter @du/orchestrator test -- tests/admin-operations-list-pagination.test.ts`
   → `Tests: 70 passed, 70 total`, **×3 liên tiếp `Exit Code: 0`** (file thực sự bị sửa).
3. `npx tsc --noEmit -p tsconfig.json` — **3 pass liên tiếp `Exit Code: 0`**.
4. Grep toàn repo `other pages may contain matches|Whole-population filtering arrives|points at
   ADM-UX-02` → chỉ còn 2 hit, cả hai đều **hồ sơ**, không phải product:
   `review.md:18` (bản ghi finding của Reviewer) và `qwen-admin.md` Mục 3 (ghi Δ14 lúc mở).
5. Không DB/Redis/S3; không commit/push.

### 5.4 Δ14 đóng một phần — **2 câu chữ cũ còn lại, chưa đụng** (cần packet tiếp)

Reviewer Turn 40 nêu đúng một message, và mình sửa đúng message đó. Nhưng trong cùng renderer còn
2 chỗ nữa cùng loại, **nằm ngoài objective của packet** nên mình **không tự mở rộng**:

- **`operation-section-renderer.ts:555`** — `"More operations exist beyond this page. Server-side
  paging needs the platform cursor contract (ADM-UX-02); until then only the most recent page is
  reachable."` Cũng hứa ADM-UX-02 ở tương lai, và sau Mục 4 thì **sai thật** (đã có cursor 2 chiều).
  Nhưng nhánh này chỉ chạy khi `f.total === null && f.pageRows >= f.limit` — tức server **không gửi
  `total`**, điều không xảy ra với server tuân thủ contract ADM-UX-02. Nên nó gần như **dead** với
  server thật, chỉ là fallback cho build cũ. Sửa cần chọn lời cho case "server không báo tổng" —
  khác về nghĩa so với case "không có kết quả", nên mình để coordinator/quyền packet quyết.
- **`:535`** — `"X of Y rows on this page match the filters"`. Không sai (với server đã lọc thì
  X == Y) nhưng thừa. Muốn gọn thì bỏ nhánh `filtered-page` khi server đã lọc, nhưng đó là đổi
  hành vi render + assertion `data-list-count="filtered-page"`, vượt "đổi câu chữ".

Cả hai đều **không sai nghiêm trọng** và đều là copy, không phải lỗi đúng/sai. Đề nghị packet sau.

### 5.5 Thống kê file

```
src\app\admin\operation-section-renderer.ts       | lines=684  | bytes=31745  (trước 31714, +31)
tests\admin-operations-list-pagination.test.ts     | lines=1326 | bytes=56190
tests\admin-shell-render.test.ts                   | lines=2769 | bytes=106684 (KHÔNG đổi — 0 assertion liên quan)
```

---

## Δ-DEVIATION Mục 5

- **Δ17 — Sửa thêm `tests/admin-operations-list-pagination.test.ts`, không sửa file test packet nêu.**
  Lý do nêu ở §5.2: `admin-shell-render.test.ts` không có assertion nào cho câu chữ này; assertion
  thật nằm ở file kia. Không sửa thì build đỏ. `admin-shell-render.test.ts` **không bị đụng** và vẫn
  chạy xanh như lệnh packet yêu cầu.
- **Δ18 — Không tự mở rộng sang 2 câu chữ cũ còn lại** (renderer `:555`, `:535`), dù cùng loại.
  Lý do ở §5.4; cần packet riêng vì `:555` đòi chọn lời cho case khác và `:535` đòi đổi hành vi
  render. Ghi ra đây để không bị chôn như Δ8/Δ14 trước đó.


---

## 6 — CYCLE 6: W-ADMUX02-COPY-2 — Xoá nốt 2 câu copy cũ (đóng Δ18, nốt Δ14)

**Định nghĩa win/lose của packet:** (1) `:555` không còn hứa cursor contract "until then…";
(2) `:535` không còn framing "trên trang này"; (3) cả hai mô tả đúng contract cursor hai chiều +
lọc toàn tập; (4) verify pnpm + tsc exit 0; (5) receipt. Không commit/push, không DB window.

**Kết quả: ĐẠT (5/5).** Đóng nốt Δ18 → **Δ14 đóng trọn vẹn**.

### 6.1 `:555` — note "cursor unavailable"

`@
CŨ: "More operations exist beyond this page. Server-side paging needs the platform
     cursor contract (ADM-UX-02); until then only the most recent page is reachable."
MỚI: "This page is full and the platform returned no continuation cursor, so the next
      page cannot be loaded from here — narrow the filters or raise the page size to
      reach the rest."
`@

Hai lỗi, một là **sai sự thật**, một là **sai thời gian**:
- *"More operations exist beyond this page"* — **không biết**. Nhánh này chạy khi
  `total === null && pageRows >= limit`: tức **không có** con số để biết có bao nhiêu dòng nữa.
  Câu cũ biến một điều **không chắc** thành khẳng định. Câu mới nói thẳng là *không load được
  trang kế tiếp từ đây*.
- *"needs the platform cursor contract (ADM-UX-02); until then…"* — contract **đã** tới (Mục 3/4).

Nhánh này vẫn là **fallback cho server không gửi `total`**, không phải đường chính; nhưng khi nó
chạy thì copy phải nói *giới hạn + lối ra* (narrow filter / nâng page size), đúng như nó làm.

### 6.2 `:535` — nhãn đếm dưới filter

`@
CŨ (data-list-count="filtered-page"): "X of Y rows on this page match the filters"
MỚI (data-list-count="exact"):       "X of Y operations match the filters"
`@

Lý do đổi **cả logic nhánh**, không chỉ chữ: sau Mục 3, `total` là `count(*)` **trên quần thể đã
lọc** (count query dùng cùng `filtersWhere`, bỏ mệnh đề cursor). Nên khi có filter mà `total !== null`
thì con số đó **chính là** tổng số khớp — dùng nhánh `exact` là **đúng**, không phải là vay mượn.
Còn nhánh `filtered-page` chỉ còn đúng khi `total === null`, tức server **không** báo tổng:

| Điều kiện | State | Copy |
|---|---|---|
| filter + có `total` | `exact` | "X of Y operations match the filters" |
| filter + **không** `total` | `page` | "X operations match the filters on this page (page limit L) — the platform did not report how many match in total" |
| không filter + có `total` | `exact` | "X of Y operations" (không đổi) |
| không filter + không `total` | `page` | "X operations on this page (page limit L)" (không đổi) |

State `data-list-count="filtered-page"` **bị bỏ hẳn**. Đã grep toàn repo `data-list-count` /
`filtered-page`: chỉ có renderer + 2 assertion trong test của chính lane; **không** có browser test,
CSS, hay docs nào phụ thuộc → bỏ an toàn về mặt hợp đồng DOM. `data-list-total` và
`data-filter-page-rows` (dùng cho nhánh `:555`) giữ nguyên.

### 6.3 Test (cùng file, +1 net)

1. `count label states the whole filtered population, not a page-local figure` (viết lại): khẳng định
   `data-list-count="exact"`, **không** còn `filtered-page`, có "1 of 1 operations match the
   filters", **không** còn "rows on this page match the filters".
2. `count label falls back to page-local wording when the platform withholds the count` (mới): server
   **không** gửi `total` **và** trang **đầy** → phải rơi về `page` và nói thẳng là không biết tổng.
3. Test cursor-unavailable (viết lại): khẳng định "no continuation cursor" + "narrow the filters or
   raise the page size", và **phủ định** "ADM-UX-02" lẫn "More operations exist beyond this page" —
   tức hai lỗi ở §6.1 bị chặn bằng assertion, không chỉ bằng mắt thường đọc.

**Sửa fixture (minh bạch):** bản đầu của test #2 trả **1 dòng** với `limit=20`, mình tưởng
`total` sẽ là `null` — nhưng `parseListPayload` cố ý suy ra `total = rows.length` khi trang **không
đầy**. Test đỏ, và **product đúng**. Đã sửa **test** (2 dòng / `limit=2`) chứ không sửa product.

### 6.4 Bằng chứng (offline)

cwd `…\du-rework` (pnpm) và `…\services\orchestrator` (tsc); wrapper literal `Exit Code:`.

1. `pnpm --filter @du/orchestrator test -- tests/admin-shell-render.test.ts tests/admin-operations-list-pagination.test.ts`
   (đúng lệnh packet giao) → `Test Suites: 2 passed, 2 total` / `Tests: 207 passed, 207 total`,
   **×3 liên tiếp `Exit Code: 0`** (136 + 70 = 206 → 207, +1 test mới).
2. `npx tsc --noEmit -p tsconfig.json` — **3 pass liên tiếp `Exit Code: 0`**.
3. Grep `services/` toàn bộ theo `ADM-UX-02|rows on this page|filtered-page|Server-side paging
   needs|More operations exist`: chỉ còn **assertion phủ định** (chủ đích, chặn hồi quy), tên test /
   comment mô tả contract đã bàn giao, và comment trong `server.ts` + `operation-section-data.ts`.
   **Không còn copy user-facing nào** hứa hẹn tương lai.
4. `admin-shell-render.test.ts` **không đổi** (2769 dòng, 106684 bytes) — vẫn 0 assertion liên quan
   tới 2 nhánh này, xác nhận lại kết luận Δ17 ở Mục 5.
5. Không DB/Redis/S3; không commit/push.

### 6.5 Thống kê file

`@
src\app\admin\operation-section-renderer.ts       | lines=694  | bytes=32560 (trước 684 / 31745)
tests\admin-operations-list-pagination.test.ts     | lines=1360 | bytes=58063
tests\admin-shell-render.test.ts                   | lines=2769 | bytes=106684 (KHÔNG đổi)
`@

---

## Δ-DEVIATION Mục 6

- **Δ19 — Đổi *logic nhánh* ở `:535`, không chỉ đổi câu chữ.** State `data-list-count="filtered-page"`
  bị **xoá**, nhánh `filtered` gộp vào `exact`/`page` theo `total` thay vì theo "có filter".
  Lý do: với lọc toàn tập, `total` **là** tổng số khớp nên `exact` đúng sự thật; giữ nhánh riêng
  là giữ một trạng thái DOM vô nghĩa. Đã xác minh không có consumer nào ngoài test của lane
  (browser test / CSS / docs đều không tham chiếu). Mục 5 Δ18 đã ghi trước rằng việc này "cần packet
  riêng" — đây là packet đó.
- **Δ20 — Không sửa `admin-shell-render.test.ts`** dù packet nêu nó trong lệnh verify. Lý do: file
  này **0 assertion** liên quan tới cả 2 nhánh (đã grep + chạy xanh). Nó vẫn được **chạy** đúng như
  lệnh packet yêu cầu, chỉ là không cần sửa. (Cùng kết luận với Δ17, xác nhận lại lần nữa.)


---

## 7 — CYCLE 7: W-ADMUX02-IDX-1 — Index keyset cho operations (đóng Δ13)

**Định nghĩa win/lose của packet:** (1) migration `0017_operations_keyset_index.sql` tạo index
`operations_tenant_created_id_idx` trên `(tenant_id, created_at DESC, id DESC)`; (2) test migration
cập nhật; (3) verify pnpm exit 0; (4) receipt. Không commit/push, không DB window.

**Kết quả: ĐẠT (4/4) — nhưng chỉ ở mức offline. Phần EXPLAIN vẫn MỞ (xem Δ21).**

### 7.1 Vì sao index này, và vì sao phải có `id`

Route list phân trang bằng `ORDER BY created_at DESC, id DESC` + biên `(created_at, id) < (ts,id)`.
`0001_platform_v1.sql` mới chỉ có `operations_tenant_created ON operations (tenant_id, created_at DESC)`
— phủ **nửa** sort key: Postgres lấy được thứ tự theo `created_at` nhưng **không** có tiebreak `id`,
nên phải thêm Sort node cho mỗi trang. `id` không phải chi tiết thẩm mỹ: `created_at` **không unique**,
thiếu `id` thì các dòng trùng phút có thể bị bỏ sót hoặc lặp giữa hai trang — đúng thứ ADM-UX-02 cấm.
Index mới phủ cả **thứ tự** lẫn **vùng quét**, nên page probe là index scan không sort.

### 7.2 Migration

```sql
CREATE INDEX IF NOT EXISTS operations_tenant_created_id_idx
  ON operations (tenant_id, created_at DESC, id DESC);
```

- Số thứ tự **0017**: thư mục đang có tới 0016; grep `0017|operations_tenant_created_id_idx` trong
  `migrations/` trước khi ghi xác nhận **không lane nào đã giữ sequence 17** (tránh đúng tai nạn
  sequence trùng mà `loadMigrationFiles` chặn ở load time).
- `IF NOT EXISTS` để `migrate()` chạy lại là no-op — không lỗi index trùng.
- **Không `DROP INDEX`**: `operations_tenant_created` là **prefix** của index mới nên vô dụng về mặt đọc,
  nhưng xoá index là thao tác không hoàn tác được từ migration, mà bằng chứng EXPLAIN để quyết định
  thì cần DB window. Ghi lại làm follow-on (Δ21), không tự ý xoá khi chưa có bằng chứng.

### 7.3 Test (2 file)

**Offline — `migrations-ledger-guard.test.ts`, +2 test (6 → 8):** pin **nội dung** migration.
File này vốn đã là offline thật (temp dir + fake ledger Db, zero PG) và quét thư mục `migrations/`,
nên 0017 tự được `verifyMigrations` bao phủ mà không cần sửa test cũ.
1. `the migration file exists and is picked up by the loader` — có mặt + `sequence === 17`.
2. `declares the composite keyset index, idempotently, in the keyset column order` — có
   `CREATE INDEX IF NOT EXISTS operations_tenant_created_id_idx`, có đúng thứ tự cột
   `(tenant_id, created_at DESC, id DESC)`, và **không** có `DROP INDEX`.

   **Đã mutation-check chính pin này** (một pin không thể fail thì vô nghĩa): bỏ `, id DESC` → bắt;
   đổi `DESC` thành ASC/không hướng → bắt; bỏ `IF NOT EXISTS` → bắt; thêm `DROP INDEX` → bắt. 4/4,
   file đã khôi phục **byte-identical** sau khi thử.

**Live — `migrations.test.ts`, +1 test:** nằm trong `liveDescribe` (window guard `DU_LIVE_INFRA=1`),
assert index thật sự tồn tại trong `pg_indexes` với đúng key. **Test này OFFLINE KHÔNG CHẠY** — xem §7.4.

### 7.4 Bằng chứng (offline) — nói rõ phần nào là SKIP

cwd `…\du-rework` (pnpm) và `…\services\orchestrator` (tsc); wrapper literal `Exit Code:`.

1. `pnpm --filter @du/orchestrator test -- tests/migrations.test.ts tests/migrations-ledger-guard.test.ts`
   (đúng lệnh packet giao) → `Test Suites: 1 skipped, 1 passed, 1 of 2 total` /
   **`Tests: 10 skipped, 8 passed, 18 total`**, **×3 liên tiếp `Exit Code: 0`**.
   **`migrations.test.ts` là SKIP, không phải PASS.** Nó có window guard (`describe.skip` trừ khi
   `DU_LIVE_INFRA=1`) — nên chạy offline **an toàn**, không cần DB window, nhưng **10 test của nó
   (trong đó có test index mới) chưa hề chạy**. Skip ≠ pass; leg này vẫn MỞ cho Tester.
2. Chạy riêng offline leg: `Tests: 8 passed, 8 total`, `Exit Code: 0`, có xác nhận 2 test
   `W-ADMUX02-IDX-1` xanh (6 test cũ vẫn xanh, không nới lỏng gì).
3. `npx tsc --noEmit -p tsconfig.json` — **3 pass liên tiếp `Exit Code: 0`**.
4. Hồi quy admin (2 suite, không liên quan nhưng để chắc thêm file migration không làm hỏng gì):
   `Tests: 207 passed, 207 total`, `Exit Code: 0`.
5. Grep `loadMigrationFiles|readdirSync…migrations` trong `tests/` → **chỉ `migrations-ledger-guard`**:
   không test nào đếm số migration nên thêm file không làm đỏ suite nào khác.
6. Không DB/Redis/S3; không commit/push.

### 7.5 Thống kê file

```
migrations\0017_operations_keyset_index.sql   | lines=21  | bytes=1272   (file MỚI)
tests\migrations-ledger-guard.test.ts         | lines=146 | bytes=6905   (trước 110 / ~5.2K)
tests\migrations.test.ts                       | lines=246 | bytes=9445   (+1 test live-gated)
```

---

## Δ-DEVIATION Mục 7

- **Δ21 — Phần "index/query-plan test cho dữ liệu lớn" của ADM-UX-02 VẪN MỞ.** Migration + pin
  offline + assert index tồn tại (live) đã xong, nhưng **chưa** có bằng chứng planner **chọn** index
  này: cần `EXPLAIN (ANALYZE)` trên dữ liệu seed ≥1.000 operations, và cần cửa DB. Không assert
  suông đoán. Kèm theo đó là câu hỏi index cũ `operations_tenant_created` (prefix, thừa cho đọc nhưng
  vẫn tốn chi phí ghi trên mỗi INSERT/UPDATE của `operations`) — **xoá hay giữ phải quyết sau EXPLAIN**.
- **Δ22 — Index có leading column `tenant_id` nên KHÔNG phục vụ tốt list cross-tenant của platform
  admin.** Đây chính là view chính của admin shell (bearer platform, không có tenant predicate). Với
  query không ràng buộc cột dẫn, Postgres vẫn dùng được index để bỏ Sort (quét theo thứ tự index rồi
  lọc), nhưng tốn O(n); một index `(created_at DESC, id DESC)` riêng sẽ hợp hơn cho case đó. **Chưa
  thêm** vì packet chỉ định đúng index này và tốn thêm chi phí ghi — cần EXPLAIN để quyết, cùng cửa
  DB với Δ21.


---

## 8 — CYCLE 8: W-ADMUX02-IDX-2 — Index cross-tenant cho list platform admin (đóng Δ22)

**Định nghĩa win/lose của packet:** (1) thêm `operations_created_id_idx` vào `0017`; (2) test
query-plan có seed, gate `DU_LIVE_INFRA=1`; (3) verify offline + tsc exit 0; (4) receipt.
Không commit/push, không DB window.

**Kết quả: ĐẠT (4/4) ở phần code + pin offline. Phần EXPLAIN VẪN CHƯA CHẠY (xem §8.4 + Δ23).**

### 8.1 Vì sao index thứ hai là cần, không phải thừa

Index của Mục 7 dẫn đầu bằng `tenant_id`. Nó phục vụ đúng **một** đường: list **tenant-scoped**
(tenant operator bearer, và nhánh public x-api-key) — vốn luôn mang `tenant_id = $n`.

Nhưng **view chính của admin console** là bearer **platform**: nó thấy **mọi tenant** và **không** gửi
tenant predicate. Với query không ràng buộc cột dẫn, index dẫn đầu bằng `tenant_id` không seek được —
Postgres buộc phải quét index theo thứ tự rồi lọc (O(n)) hoặc sort lại. Nên thêm index thứ hai dẫn thẳng
từ sort key:

```sql
CREATE INDEX IF NOT EXISTS operations_created_id_idx
  ON operations (created_at DESC, id DESC);
```

### 8.2 Sửa **tại chỗ** file 0017, không tạo 0018 — và vì sao an toàn ở đây

`git status` cho thấy **toàn bộ** `migrations/0002..0017` đều **untracked** (`??`) — cùng một changeset
chưa commit. Thêm vào 0017 giữ đúng logic "một thay đổi = một migration" thay vì sinh 0018 chỉ để thêm
một index. **Nhưng** điều này chỉ an toàn vì 0017 **chưa từng được apply** ở đâu: runner ghi ledger
`sequence + filename` và **không** có checksum, nên nếu 0017 đã chạy trên một DB nào đó thì sửa tại chỗ
sẽ bị `migrate()` bỏ qua im lặng và index thứ hai **không** được tạo. Ở đây chưa có DB window nào
chạy migration nào, nên coi như chưa apply — nhưng ghi lại ở Δ24 để người sau không lặp lại.

### 8.3 Test

**Offline — `migrations-ledger-guard.test.ts`, +1 test (8 → 9):** pin index thứ hai cùng kiểu
(`CREATE INDEX IF NOT EXISTS` + đúng `(created_at DESC, id DESC)` + không `DROP INDEX`).
**Đã mutation-check**: mất index thứ hai → bắt; lỡ đưa `tenant_id` vào key → bắt (đúng cái lỗi làm
index này mất tác dụng); bỏ `IF NOT EXISTS` → bắt; thêm `DROP INDEX` → bắt. **4/4**, file khôi phục
byte-identical. Thêm nữa: đếm file migration = 17, `max=0017`, `duplicates=[]`.

**Window-gated — `tests/admin-keyset-explain.test.ts` (file MỚI, 6 test):** đây là phần **chưa**
được ADM-UX-02 đòi hỏi ở Mục 7. Nó seed **1.200 + 40** operations cho một tenant riêng, `ANALYZE` rồi
kiểm 5 điều:
1. cả hai index có thật trong `pg_indexes`;
2. query cross-tenant (không tenant predicate — đúng hình dạng IDX-2 sinh ra) **không có Sort node**;
3. query tenant-scoped **không có Sort node**;
4. query **lùi** (`>` + ASC, hình dạng prevCursor của Mục 4) **không có Sort node**;
5. **tính đúng đắn của keyset ở quy mô lớn**: duyệt hết bằng đúng shape của `listOperationsPage`,
   khẳng định đủ 1.240 id, **không trùng**, và hợp đúng tập seed — trong đó có **nhóm 40 dòng chung
   một `created_at`**, đúng ca mà thiếu tiebreak `id` sẽ hỏng;
6. chèn thêm 1 dòng **giữa** hai lượt xem trang → trang 2 không bị dịch (thuộc tính OFFSET không có).

Các plan được `process.stdout.write` ra để **Tester đọc được index nào thắng** — đó là bằng chứng để
ghi, không phải thứ file này đoán. Assert cứng là **"không có Sort"** (đúng mục tiêu) + **"dùng một
trong hai keyset index"**, thay vì bắt buộc tên index cụ thể — vì planner chọn index nào là quyết định
của PG, khác nhau giữa phiên bản, và bắt tên sẽ sinh flake giả.

### 8.4 Bằng chứng (offline) — nói rõ phần nào SKIP

cwd `…\du-rework` (pnpm) và `…\services\orchestrator` (tsc); wrapper literal `Exit Code:`.

1. `pnpm --filter @du/orchestrator test -- tests/migrations-ledger-guard.test.ts` (verify offline mà
   packet yêu cầu) → `Tests: 9 passed, 9 total`, **×3 liên tiếp `Exit Code: 0`**.
2. `npx tsc --noEmit -p tsconfig.json` — **3 pass liên tiếp `Exit Code: 0`**.
3. `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` →
   `Test Suites: 1 skipped, 0 of 1 total` / `Tests: 6 skipped, 6 total`, `Exit Code: 0`.
   **6 test EXPLAIN này CHƯA TỪNG CHẠY.** Window guard `DU_LIVE_INFRA=1` khiến offline run **an toàn**
   (không seed, không xoá, không mở kết nối nào) — nhưng **skip ≠ pass**.
4. Hồi quy rộng hơn (pagination + shell-render + migrations):
   `Test Suites: 1 skipped, 2 passed` / `Tests: 10 skipped, 207 passed`, `Exit Code: 0`.
5. Không DB/Redis/S3; không commit/push.

**Sửa lỗi trong lúc làm (minh bạch):** bản đầu của `walkKeyset` dùng ternary `const res = cursor ? … : …`
gây TS7022 (tự tham chiếu kiểu). `tsc --noEmit` ở **project** **không** bắt, nhưng **ts-jest** (dịch
từng file) **bắt** → đã thêm chú thích kiểu tường minh. Bài học: với test, `tsc` toàn project **không
đủ** — phải chạy chính lệnh jest để thấy lỗi compile thật.

### 8.5 Thống kê file

```
migrations\0017_operations_keyset_index.sql   | lines=36  | bytes=2144  (trước 21 / 1272)
tests\admin-keyset-explain.test.ts           | lines=256 | bytes=10253 (file MỚI)
tests\migrations-ledger-guard.test.ts         | lines=160 | bytes=7708  (+1 test)
```

---

## Δ-DEVIATION Mục 8

- **Δ23 — 6 test EXPLAIN viết nhưng CHƯA CHẠY; không có EXPLAIN nào được thu thập.** Đây là hạn chế
  thật, ghi rõ thay vì coi là xong: mình chỉ verify được (a) index **được khai báo** đúng, (b) các câu
  SQL **biên dịch được** dưới ts-jest, (c) guard skip an toàn offline. **Chưa** biết planner thật sự
  chọn index nào, và 6 assertion có thể phải chỉnh sau lần chạy đầu trong cửa thật. Cần Tester.
- **Δ24 — Sửa migration 0017 tại chỗ; chỉ an toàn vì 0017 chưa từng được apply.** Runner không có
  checksum (chỉ `sequence + filename`), nên nếu 0017 đã chạy trên DB nào thì thêm index thứ hai bằng
  cách sửa tại chỗ sẽ bị `migrate()` bỏ qua **im lặng**. Nếu sau này 0017 đã apply ở bất kỳ môi
  trường nào, mọi chỉnh sửa tiếp theo **phải** là file mới (0018), không sửa 0017.
- **Δ25 — Assert index nào thắng cố ý KHÔNG siết.** File in plan ra để Tester đọc, chỉ assert
  "không có Sort" + "dùng 1 trong 2 keyset index". Bắt buộc tên cụ thể sẽ thành flake giữa các
  phiên bản/điều kiện planner mà không bảo vệ điều gì thật.


---

## 9 — CYCLE 9: W-ADMUX02-EXPLAIN-FIX-1 — Sửa 2 test đỏ theo bằng chứng live T-CODEX-TEST-18

**Định nghĩa win/lose:** sửa 2 test fail mà Tester live (PG :5433) ghi tại
`coordination/reports/T-CODEX-TEST-18-keyset-explain.log` (4 pass / 2 fail);
compile `tsc --noEmit` exit 0; offline guard skip 6/6 exit 0; receipt tại đây.
**Không** mở DB window, **không** commit/push.

**Kết quả: ĐẠT phần sửa + xác minh tĩnh. Chưa đóng được Δ23** — 2 test sửa xong vẫn
phải chờ Tester chạy lại trong cửa thật (mình không có DB window).

### 9.1 Đọc log trước, không đoán từ mô tả packet

Log có **plan thật** do chính suite in ra. Ba điều mình học được mà không thể suy ra
từ mô tả:

1. **Forward cross-tenant dùng đúng index mới:** `Limit -> Index Scan using
   operations_created_id_idx`, 51 rows, 0.074 ms, **không Sort**. IDX-2 có tác dụng thật.
2. **Row comparison sargable**, khác lo lắng mình ghi ở Mục 8: log hiển thị
   `Index Cond: (ROW(created_at, id) < ROW(...))` — PG đẩy được so sánh row vào index.
3. **Forward tenant-scoped KHÔNG dùng index dẫn đầu tenant:** nó chọn
   `operations_created_id_idx` + `Filter: (tenant_id = …)`, vì toàn bộ 1.240 dòng seed
   chung MỘT tenant nên tenant equality không chọn gì cả. Planner đúng — nhưng nghĩa là
   **live run chưa chứng minh `operations_tenant_created_id_idx` bao giờ được chọn**.
   Ghi lại ở §9.5, không che.

### 9.2 Lỗi 1 (`:252`) — test logic bug của mình, đúng như packet nói

`page1Ids` là snapshot lấy **trước** INSERT, nên `expect(page1Ids.has(newId)).toBe(true)`
không bao giờ đúng. Property thật cần chứng minh là: **trang đã trao cho operator thì ổn
định, trang đầu thì dịch đi** — nên phải query lại page 1 SAU khi chèn.

Sửa thành: (a) page 2 không giao với page 1 cũ; (b) query lại page 1 → dòng 2027 dẫn đầu;
(c) `page1[1]` vẫn còn trong page 1 mới (tụt xuống 1 vị trí, không mất ở biên);
(d) dòng mới không lọt vào page 2 (nó mới hơn cursor); (e) page 2 giao với page 1 mới = rỗng.

**Bỏ một assertion mình tự viết ra mà vô nghĩa:** bản sửa đầu có
`expect(new Set(page2…)).toEqual(new Set(second.rows.slice(0,PAGE_LIMIT)…))` — hai vế là
CÙNG một mảng, luôn đúng, không kiểm gì. Thay bằng (d)/(e) ở trên.

### 9.3 Lỗi 2 (`:193-203`) — **mình assert sai**, không phải PG làm sai

Plan thật cho backward hop: `Bitmap Index Scan on operations_created_id_idx` →
`Bitmap Heap Scan` → **`Sort`** (quicksort, 46kB, **63 rows**, 0.191 ms).

Mình đã assert `not.toMatch(/\bSort\b/)` cho **cả ba** hình dạng query. Với hai hình forward
thì đúng, nhưng với hình backward đó là **một khẳng định phổ quát sai**: bound
`2026-01-01 00:20:00` chỉ có ~63 dòng mới hơn, nên sắp xếp 63 dòng rẻ hơn nhiều so với
một backward index scan phải bước qua ~1.199 mục không đạt. **Planner chọn đúng.**
Trước khi sửa, mình đã mô phỏng độc lập và ra cùng kết luận.

Sửa thành assert điều index THỰC SỰ phải bảo đảm:
`Index Cond: (ROW(created_at, id) > ROW(` (boundary được seek, không quét bảng),
`not /Seq Scan on operations/`, và nếu có Sort node thì **row count phải bị chặn**
(≤ (limit+1)*4) — tức sort trên cửa sổ đạt điều kiện, không bao giờ trên toàn quần thể.
Đổi tên test thành `the backward hop seeks the boundary through a keyset index` để
tên không còn hứa điều mình không đòi.

### 9.4 **Không** làm theo cách gợi ý thêm `tenant_id` — và vì sao

Packet nêu lựa chọn "kiểm tra query có tenant_id **hoặc** xét lý do planner". Mình chọn vế
sau, **cố ý**, vì route thật phát đúng hình backward **không** tenant predicate cho platform
admin (`bindOperationsCursor` + `ORDER BY … ASC` khi `direction=prev`, chỉ có
`tenant_id` khi principal là tenant operator hay x-api-key). Thêm `tenant_id` vào test thì
plan sẽ đẹp nhưng **che đúng đặc tính của đường dẫn thật** — biến test xanh bằng cách đổi
câu hỏi. Ghi ở Δ26.

### 9.5 Xác minh tĩnh (không mở DB window) — và giới hạn của nó

Vì không được vào cửa DB, mình xác minh bằng **chính bằng chứng đã ghi**:

- **Đối chiếu 10 assertion với đúng 3 plan block lấy từ log** (trích bằng script, chạy
  offline): cross-tenant 2/2, tenant-scoped 2/2, backward 6/6 (Index Cond ✓, index name ✓,
  không Seq Scan ✓, có Sort node ✓, parse được row count ✓, **51 ≤ 204** ✓). **10/10 PASS.**
- **Mô phỏng lại phân phối dữ liệu in-memory** cho test INSERT: 8/8 PASS, kèm **OFFSET
  control** chứng minh property không tầm thường — cùng kịch bản mà phân trang bằng OFFSET
  thì **có** lặp lại một dòng của page 1, còn keyset thì không. Lần chạy đầu của mô phỏng
  **bắt ra lỗi của chính mình**: mình gán rank dòng 2027 (100000) nhỏ hơn nhóm tie
  (999999) nên nó không phải dòng mới nhất; sửa mapping rồi mới đáng tin.
- `npx tsc --noEmit` → **×3 `Exit Code: 0`**.
- `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` →
  `Tests: 6 skipped, 6 total`, **×3 `Exit Code: 0`** (guard vẫn skip sạch, không kết nối).
- Hồi quy: `migrations-ledger-guard` + `admin-operations-list-pagination` +
  `admin-shell-render` + `migrations.test.ts` → `3 passed, 1 skipped` /
  `216 passed, 10 skipped`, `Exit Code: 0`.

**Giới hạn, nói thẳng:** xác minh tĩnh chứng minh assertion khớp với plan ĐÃ GHI và logic
tập hợp đúng; nó **không** chứng minh 6 test xanh trên DB hiện tại của lần chạy tới. Cần
Tester chạy lại. Δ23 vẫn MỞ.

### 9.6 Δ24 giờ đã THÀNH HIỆN THỰC, không còn là cảnh báo

Trong log, `migrate` báo *"Database is up-to-date. No pending migrations."* và test
"both keyset indexes are present" **PASS** ⇒ **0017 đã được apply thật** trên
`du_orchestrator_test` (kèm cả 2 index, vì bản mình sửa tại chỗ ở Mục 8 đã có sẵn lúc Tester
chạy). Hệ quả: **mọi chỉnh sửa tiếp theo vào 0017 phải là file mới (0018)** — runner không
có checksum nên sửa tại chỗ sẽ bị `migrate()` bỏ qua im lặng. Update RESUME POINT.

### 9.7 Việc còn mở, xếp theo thứ tự đáng làm

1. **Tester chạy lại 6 test** trong cửa DB để đóng Δ23.
2. **`operations_tenant_created_id_idx` chưa có bằng chứng được chọn** (§9.3/9.5): cần seed
   trải trên **nhiều tenant** để tenant equality có tính chọn lọc. Hiện mới chỉ chứng minh
   được index cross-tenant. → Δ21 vẫn mở một nửa.
3. **Nhóm tie chưa được EXPLAIN riêng:** 40 dòng chung `created_at` có thật sự đi qua
   `Index Cond` không hay chỉ được Filter? Nên thêm một plan assertion cho boundary nằm
   ngay trong nhóm tie. → mình không tự làm vì nằm ngoài phạm vi 2 test đỏ của packet.

### 9.8 Thống kê file

```
tests\admin-keyset-explain.test.ts | lines=309 | bytes=13385  (trước Mục 9: 256 / 10253)
```

---

## Δ-DEVIATION Mục 9

- **Δ26 — Không thêm `tenant_id` vào backward query** dù packet gợi ý; sửa **assertion** thay
  vì sửa **hình query**. Lý do ở §9.4: thêm tenant_id làm plan đẹp nhưng che mất đường dẫn
  thật của platform admin. Nếu coordinator muốn giữ cách kia thì đó là quyết định của
  coordinator, mình ghi lại để không bị hiểu là làm sai chỉ dẫn.
- **Δ27 — Nới 1 assert, có giải thích bằng số, không phải để cho qua.**
  `not.toMatch(/\bSort\b/)` ở backward được thay bằng bộ 3 assert chặt hơn về đúng thứ quan
  trọng (Index Cond seek + không Seq Scan + Sort bị chặn row count). Đây là **sửa khẳng định
  sai**, không phải nới chuẩn: bằng chứng là 63/51 rows ở log và mô phỏng độc lập. Nếu sau
  này DB lớn hơn khiến planner đổi ý, các assert này vẫn đúng vì chúng không đoán plan.
- **Δ28 — Không tự mở rộng sang 2 việc còn mở ở §9.7** (seed đa tenant để chứng minh
  tenant-leading index; EXPLAIN riêng cho nhóm tie). Packet khoanh đúng 2 test đỏ; hai việc
  này cần packet/cửa DB riêng, ghi ra đây để không chôn như Δ8/Δ14 từng bị.


---

## 10 — CYCLE 10: W-ADMUX02-STATUS-SYNC-1 — Đối chiếu Turn 60, ghi ACCEPTED theo phạm vi + checklist browser

**Packet:** cập nhật trạng thái Admin sau Kiểm toán độc lập Turn 60; **không sửa code sản phẩm,
không mở DB window, không tick umbrella gate, không commit/push.**

**Kết quả: ĐẠT 6/6 mục.** Không có thay đổi source nào (đã chứng minh bằng mtime — xem §10.5).
**Nhưng packet có một mô tả sai sự thật mà mình đã sửa trước khi ghi xuống ledger (§10.2),
và mình phát hiện chính mình vừa ghi một claim sai vào task file và đã sửa (§10.3).**

### 10.1 Đã đọc gì, và tự kiểm chứ không tin mô tả

- `review.md` Turn 60 (dòng 3–33): audit read-only, tự nhận *"this audit changes no task row"*, và
  công thức phán quyết là **"support promotion of the specific packets to ACCEPTED **when their task
  owner records the status"`** — tức owner (mình) phải tự ghi, không phải audit đã ghi sẵn.
- `T-CODEX-TEST-20-live-reval.log` (94 dòng) **đọc toàn bộ**, không chỉ nhìn tổng số.
- Kết luận Turn 60 cho packet của mình: ACCEPT ở **stated live acceptance scope**, và nói rõ
  `G-ADMIN-OPS` **không** accept vì chưa có browser/operator journey seeded.

### 10.2 **Mô tả trong packet sai một chi tiết quan trọng** — đã sửa trước khi ghi

Packet mục 2 viết: *"ACCEPTED ... (6/6 PASS, **NO Sort node**, 1.240 operations walk 0 gap/duplicate)"*.
Log live chứng minh điều ngược lại cho một trong ba plan:

```
--- backward page plan ---   (T-CODEX-TEST-20)
  ->  Sort  (rows=64) (actual rows=51)  Sort Method: quicksort  Memory: 46kB
        ->  Bitmap Heap Scan on operations
              ->  Bitmap Index Scan on operations_created_id_idx
                    Index Cond: (ROW(created_at, id) > ROW(...))
```

**Plan lùi VẪN có Sort node.** Audit Turn 60 viết đúng: *"forward/backward plans have **no Sort
assertion**"* — tức cái được accept là mình **đã bỏ assertion đó** (Mục 9, Δ27) và thay bằng
seek + no-Seq-Scan + Sort-bị-chặn. Packet đã paraphrase "no Sort **assertion**" thành "no Sort
**node**" — hai câu này ngược nhau về sự thật.

Mình **không** chép nguyên văn câu của packet vào ledger. Đã ghi phiên bản đúng vào cả task file
(mục "Ba giới hạn của diện ACCEPTED", giới hạn 1) lẫn receipt này. Nếu ledger lưu câu sai thì đời
sau sẽ "xác nhận" một điều chưa bao giờ xảy ra.

### 10.3 Mình tự ghi một claim sai vào task file, đã tự phát hiện và sửa

Khi viết comment cho row ADM-UX-02, mình chép nguyên từ phần *"Hiện trạng làm căn cứ"* của chính
task file: *"audit vẫn `events: []`"*. **Không đúng với code hiện tại.** Kiểm source:
`/api/v1/admin/audit` gọi `listAuthorizedAuditEvents(...)` → `audit.listForTenant(tenantId, limit)`
và có `limit` ≤200; grep `events: \[\]` trong toàn bộ `src/` → **0 match**. Phần đó của plan doc là
mô tả hiện trạng **tại thời điểm viết plan**, không phải trạng thái hôm nay.

Đã sửa thành câu đúng và kèm phần mình **tự kiểm** thật sự: audit đã có reader thật tenant-scoped +
limit, **nhưng chưa** cursor/field-filter/sort; API keys **chưa** `limit`/cursor (lấy toàn bộ rồi lọc
tenant trong JS — đã đọc route xác nhận); businesses liệt kê toàn bộ. Ghi lại ở đây vì lỗi là của
mình, không phải của packet.

### 10.4 Bằng chứng SỐNG mới cho phần mình từng chỉ có offline (điểm đáng chú ý nhất)

Trong cùng log T-CODEX-TEST-20, suite `tests/admin-action-rbac-live.test.ts` (12/12 pass, của lane
khác) có ba cell **chạy thẳng vào code mình viết ở Mục 3**:

- `M2: operator GET /api/v1/operations returns ONLY tenant-A rows` → **live proof của tenant fence
  SQL predicate** (Mục 3 từng chỉ có bằng chứng offline với fake db).
- `M3: operator by-id read of a tenant-B operation is indistinguishable 404` → fence by-id.
- `M5: platform operations-list envelope regression {items,nextCursor,prevCursor,total,limit}` →
  **đúng envelope mình đổi ở Mục 3, được assert trên thật.**

Không phải mình tự tuyên bố: đây là suite của lane khác, cùng cửa sổ live. Mình ghi vào ledger
(`T-CODEX-TEST-20 M2/M3/M5`) vì nó nâng chất lượng bằng chứng của ADM-UX-02/operations rõ rệt.

### 10.5 Thay đổi đã ghi (2 file hồ sơ, 0 file sản phẩm)

| File | Thay đổi |
|---|---|
| `tasks/ADMIN-OPS-UX-2026-09-24.md` | (1) Row **ADM-UX-02: `[ ]` → `[~]`** kèm comment: phạm vi Operations list ACCEPTED theo Turn 60 + link receipt + môi trường PG :5433/Redis :6380 + **4 điều còn thiếu** (sort allowlist; businesses/API keys/audit chưa có cursor/filter/sort; `operations_tenant_created_id_idx` chưa có bằng chứng được chọn; quyết định giữ/xoá index prefix cũ). (2) Thêm mục **"Nhật ký packet Admin lane"**: bảng 5 packet với kết luận/phạm vi/lệnh+môi trường/link receipt, và **"Ba giới hạn của diện ACCEPTED"**. (3) Thêm **"Checklist bàn giao cho Tester — browser Admin journey"** C0–C5. (4) Ghi rõ **G-ADMIN-OPS vẫn NO-GO**. |
| `coordination/reports/qwen-admin.md` | Mục 10 này + Ledger row 10. |

**Không tick cái nào ngoài ADM-UX-02 `[ ]`→`[~]`** (đây là *partial*, không phải accept). Đã kiểm
bằng script: `ADM-UX-02 is [x] = false`, **7 row ADM-UX khác vẫn `[ ]`**, `G-ADMIN-OPS` không đổi.

### 10.6 Checklist browser (mục 5 packet) — thiết kế và giới hạn

C0 tiền đề (seed ≥1.000 ops × ≥2 tenants, **tie group ≥20 dòng cùng `created_at`**, chuỗi sentinel)
C1 bộ lọc, C2 phân trang + deep link, C3 responsive table, C4 phân quyền + audit, C5 bằng chứng phải nộp.

- **Mỗi mục có "neo" là attribute/selector có thật**, đã grep vào source trước khi viết
  (`data-filter-state`, `data-list-total`, `data-pagination-prev`, `data-back-to-list`,
  `data-page-size`, `data-list-count="exact|page"`, `.adm-reflow-scroller[role=region][tabindex=0]`,
  breakpoint `adm-col-p4`≤720 / `p3`≤560 / `p2`≤420, `p1` luôn còn) — không bịa selector.
- Ba mục mình cố ý đưa vào vì chúng **bắt đúng bug thật đã xảy ra ở lane này**:
  (a) *Previous từ trang 3 phải về trang 2* và *roundtrip 1→2→1* (bug Mục 4,
      live leg chưa từng kiểm bằng browser); (b) *ID khớp nằm ở trang 2+ phải tìm ra* (defect
      T20-A1); (c) *late insert không dịch trang* (property keyset, mới mới chỉ có trong SQL test).
- Cảnh sát đề phòng reading sai: ghi rõ **skipped ≠ pass**, **axe pass không chứng minh không cuộn
  ngang** (phải đo `scrollWidth`), và **không dùng ảnh fixture cũ**.
- Ghi rõ đây là **đề xuất kịch bản, chưa chạy** — lane này không mở browser/DB.

### 10.7 Xác minh

- Packet không yêu cầu chạy test (không sửa code); mình vẫn chứng minh **không vô tình đụng source**:
  mtime của `server.ts` / `operation-section-renderer.ts` / `operation-section-data.ts` /
  `admin-keyset-explain.test.ts` / pagination test đều **156–236 phút trước** time điểm này — tức từ
  các cycle trước, không phải cycle này.
- Không DB window: chỉ **đọc** log có sẵn của Tester.
- Không commit/push.
- Tính nguyên vẹn file task sau sửa: bảng backlog vẫn parse được (row ADM-UX-02 có đúng 6 ống = 5 ô),
  file 128 dòng, header mới đúng chỗ.

### 10.8 Việc còn mở sau cycle này (đề xuất dispatch)

1. **Browser Admin journey theo C0–C5** (Tester, cần DB window) → mới đóng được ADM-UX-00/01/03/05/07
   và `G-ADMIN-OPS`. Đây là blocker duy nhất còn lại của lane Admin theo Turn 60.
2. **Sort allowlist cho `GET /api/v1/operations`** — điều kiện ADM-UX-02, hiện **chưa có gì**.
3. **Seed đa tenant để chứng minh `operations_tenant_created_id_idx` được chọn**, và trên đường đó
   quyết định giữ/xoá `operations_tenant_created`. (Δ21/Δ28)
4. **docs/06 + traceability** cho envelope mới và dạng cursor `|p` (Δ12/Δ16 — docs lane).

---

## Δ-DEVIATION Mục 10

- **Δ29 — Không chép nguyên văn mô tả ACCEPTED của packet vì nó trái bằng chứng.** Packet ghi "NO Sort
  node"; log cho thấy backward plan **có** Sort node, và audit chỉ nói "no Sort **assertion**". Mình
  ghi phiên bản đúng vào ledger + receipt (§10.2). Nếu coordinator muốn giữ câu gốc thì đó là quyết
  định của coordinator, nhưng ledger sẽ chứa một claim chưa từng đúng.
- **Δ30 — Không tự tick ADM-UX-02 thành `[x]`**, dù packet mục 2 nói "chính thức phán quyết ACCEPTED".
  Audit chỉ accept **packet keyset/query-plan ở phạm vi của nó**; row ADM-UX-02 còn đòi sort allowlist
  + cùng contract cho businesses/API keys/audit, mà những thứ đó **chưa làm**. Nên row lên `[~]` (partial)
  kèm danh sách phần thiếu. Turn 60 nói rõ: *"Keep parent ... rows unchanged until their gates pass"*.
- **Δ31 — Checklist browser để trong `tasks/ADMIN-OPS-UX-2026-09-24.md`** (cạnh ADM-UX-07) chứ không
  phải trong receipt, vì nó là artifact bàn giao dài hạn cho Tester; receipt chỉ link tới. Nếu
  coordinator muốn thành file riêng trong `docs/` thì mình chuyển theo yêu cầu.


---

## 11 — CYCLE 11: W-CONTRACT-ALIGN-1 — Dời contract operations-list về một nguồn (đóng T70-C1)

**Packet:** đồng bộ schema contract công khai với route thật, thêm conformance test chống
phân kỳ, build + test offline cả hai package, receipt tại đây. Không commit/push.

**Kết quả: ĐẠT.** T70-C1 đã đóng bằng **cấu trúc**, không bằng hợp nhất chú thích:
route không còn tự định nghĩa hằng số riêng — nó đọc từ `@du/contracts`, và một tham số mới
**không thể** tồn tại ở route mà không tồn tại ở contract (biên dịch thất bại — xem §11.4).

### 11.1 Phân kỳ thật sự là gì (đã kiểm từng điểm, không tin mô tả packet)

| Hạng mục | `public-api.ts` cũ (mtime 09-20) | Route thật |
|---|---|---|
| Tham số | 3 (`cursor`,`limit`,`state`) | **5** (+`tenant`,`id`) |
| `state` | `OperationStateSchema` (state máy) | enum UI `RUNNING/COMPLETED/FAILED/TIMED_OUT`, mỗi giá trị mở ra một **nhóm** state |
| `cursor` | `.max(512)` | `.max(128)` |
| Envelope | `pageOf()` → 2 field `{items,nextCursor}` | **5 field** `{items,nextCursor,prevCursor,total,limit}` |
| Consumer | **0** (grep toàn repo) — route không import; vẫn re-export qua `index.ts:18` nên **nằm trên mặt API của package** | — |

Điểm đáng chú ý: `QUEUED` là state máy hợp lệ nhưng **là 422** trên tham số `state` của route. Schema cũ
đón nhận nó ⇒ bất kỳ client nào sinh code từ schema sẽ gửi giá trị route luôn từ chối.

### 11.2 Cách sửa: contract là nguồn, route và shell là hai consumer

- **`packages/contracts/src/public-api.ts`** — khối operations-list mới: `LIST_CURSOR_MAX_LEN`,
  `OPERATIONS_LIST_LIMIT_DEFAULT/_MAX`, `OPERATIONS_LIST_QUERY_PARAMS` (danh sách tên),
  `OPERATIONS_STATE_FILTER_VALUES` + `OPERATIONS_STATE_FILTER_WIRE_STATES` (bảng mở nhóm),
  `OPERATIONS_LIST_TOKEN_PATTERN` + `OPERATIONS_LIST_SOLID_HEX_PATTERN` + `isOperationsListFilterToken()`,
  `ListOperationsQuerySchema`, `OperationsListPageSchema` (**strict, 5 field**), `operationsListPage()`.
  **`pageOf()` bị xoá** — nó quảng bá đúng cái envelope 2-field đã bị thay, và **0 consumer** (đã kiểm).
- **`server.ts`** — import toàn bộ trên; bỏ hẳn 3 định nghĩa riêng (hai regex token + bảng state);
  `listOperationsPage()` trả `operationsListPage({...}) satisfies OperationsListPage`.
  Tên cũ (`OPERATIONS_LIST_DEFAULT_LIMIT`, `OperationsStateFilter`, …) giữ nguyên dưới dạng **alias**
  nên không break call site nào.
- **`operation-section-data.ts`** (admin shell) — `OPERATION_LIST_*`, `OPERATION_STATE_FILTERS`,
  `STATE_FILTER_MATCH` và `sanitizeFilterToken` giờ cũng đọc từ contract. Đây là chỗ packet **không**
  yêu cầu nhưng nếu bỏ thì vẫn còn nguyên một bản sao thứ ba (xem Δ33).

### 11.3 Conformance test — hai phía, không phải một

- `packages/contracts/tests/operations-list-contract.test.ts` (**mới, 13 test**): accept/reject matrix,
  key set của schema == `OPERATIONS_LIST_QUERY_PARAMS`, mỗi field envelope là bắt buộc, và
  **cursor 512 ký tự phải bị từ chối** — đúng cái bound cũ để chốt rằng nó không quay lại được.
- `services/orchestrator/tests/operations-list-contract-conformance.test.ts` (**mới, 11 test**):
  chạy **`route()` thật** với fake db ghi nhận (offline, không PG/Redis/socket), validate **response
  thật** bằng `OperationsListPageSchema`, so key set của response với key set của schema, và với mỗi
  tham số trong `OPERATIONS_LIST_QUERY_PARAMS` yêu cầu nó **thay đổi hành vi thật** (probe
  `limit=7` parse được; `cursor/state/tenant/id` sai phải 422 — kèm control: không có tham số thì
  không 422). `total` phải là 3 trong khi page trả 2 dòng ⇒ không có đường lén về `rows.length`.

### 11.4 **Bằng chứng quan trọng nhất: lock một chiều là không đủ, và tôi đã phát hiện ra nó**

Tôi mutation-test chính test của mình (bài học từ Mục 9: một test xanh không có nghĩa là nó bắt được gì):

| Đột biến | Kết quả |
|---|---|
| Baseline | `exit=0`, 11/11 |
| **M1** — route thôi không đọc `id` nữa (contract nói 5, route chỉ đọc 4) | `exit=1` — **bị bắt** |
| **M2** — route đọc thêm `params.get('sort')` ngoài contract | `exit=0` **11/11 — KHÔNG bị bắt** |

M2 lọt. Lý do: test runtime chứng minh được *tham số được khai báo thì có được honour*, nhưng không
chứng minh được *route không đọc thứ gì khác*. Đó chính xác là hình thái phân kỳ T70-C1.

**Sửa bằng cấu trúc, không bằng test:** thêm seam `AllowListedQuery` —
`read(name: OperationsListQueryParam)`. Parser không còn nhận `URLSearchParams` mà nhận view này,
nên trong thân hàm **không còn binding nào** để gọi `params.get(...)`. Chạy lại M2: **`exit=1`,
`Tests: 0 total`** — không biên dịch được, tức tham số ngoài contract giờ là **lỗi biên dịch**,
không còn là hành vi âm thầm nữa. Restore: `restored identical=true`, 11/11 xanh lại.

### 11.5 Bằng chứng (offline)

cwd `…\du-rework` (pnpm) và `…\services\orchestrator` (jest/tsc); wrapper literal `Exit Code:`.

1. **contracts**: `lint` + `build` + `test` → `Test Suites: 12 passed` / **`Tests: 217 passed` ×3
   `Exit Code: 0`**.
2. **orchestrator** 12-suite targeted (bao gồm cả 2 suite mới): `Test Suites: 12 passed` /
   **`Tests: 551 passed, 551 total` ×3 `Exit Code: 0`**.
3. `npx tsc --noEmit -p tsconfig.json` (orchestrator) → **`Exit Code: 0`**; đã chạy lại sau mỗi lần
   đột biến và restore.
4. **Full offline sweep orchestrator**: `4 failed, 2 skipped, 58 passed, 62 of 64` /
   `19 failed, 21 skipped, 1413 passed, 1453 total`. **Cả 4 suite đỏ không thuộc thay đổi này:**
   `mock-vault-harness` + `connector-revision` (lane khác, `BINDING_DENIED` tại
   `connector-credentials/workflow.ts:166`, thư mục untracked) và `mock-oidc-idp` +
   `admin-error-boundary-offline` (va chạm cổng loopback, `EADDRINUSE 127.0.0.1:44868`).
   **Chứng minh bằng chạy cô lập**: 5 suite đó + 2 suite hợp đồng của tôi → `249 passed, 249 total`,
   `Exit Code: 0`. Vì tôi có sửa hằng số dùng chung nên phép thử cô lập này là bắt buộc, không phải
   tuỳ chọn.
5. **OpenAPI probe** (`tools/openapi/probe_cases.js`) vẫn `PASS ListOperationsQuerySchema`:
   giữ nguyên **tên** symbol để không break probe; case `{limit: 20}` vẫn parse được.
   Probe có sẵn 2 FAIL (`ArtifactFinalizeRequestSchema`, `ClaimTaskRequestSchema`) — **không phải do
   cycle này**: cả hai schema định nghĩa trong `runtime.ts` (mtime 09-25 06:23, tôi không đụng);
   `public-api.ts` là file duy nhất của package tôi sửa. Ghi lại như quan sát hiện trạng.
6. Không DB/Redis/S3; không commit/push; không tự tick gate.

### 11.6 Thống kê file

```
packages\contracts\src\public-api.ts                          lines=258  bytes=10122  (trước 117/4482)
packages\contracts\tests\operations-list-contract.test.ts      lines=123  bytes=5435   (MỚI)
services\orchestrator\src\server.ts                            lines=2550 bytes=117504
services\orchestrator\src\app\admin\operation-section-data.ts  lines=1077 bytes=40934
services\orchestrator\tests\operations-list-contract-conformance.test.ts lines=184 bytes=7894 (MỚI)
coordination\gates\contracts-v1.md                             lines=72   bytes=8230   (1 dòng inventory)
```

---

## Δ-DEVIATION Mục 11

- **Δ32 — Sửa `packages/contracts/` trong khi gate doc ghi owner là "Claude (platform lane)".**
  Packet chỉ định đích danh file này và reviewer Turn 70 giao "contracts/platform owner"; lane Admin
  là *producer* của contract đó (viết route + envelope), nên tôi làm theo packet. Đổi lại tôi đã cập
  nhật **dòng inventory** trong `coordination/gates/contracts-v1.md` vì `pageOf()` bị xoá làm nó sai
  sự thật — **chỉ dòng inventory**, không đụng verdict/owner. Đề nghị coordinator xác nhận quyền này.
- **Δ33 — Mở rộng sang `operation-section-data.ts`** (admin shell) tuy packet không nêu. Nếu không,
  vẫn còn một bản sao thứ ba của đúng bộ hằng số (limit/cursor/state-group/token) — tức là T70-C1 chỉ
  được sửa ở 2/3 chỗ. Hành vi giữ nguyên, chỉ đổi nguồn giá trị.
- **Δ34 — Xoá export `pageOf()`** thay vì giữ cho tương thích. Lý do: nó *quảng bá* cái envelope 2-field
  đã bị thay — chính là nội dung phân kỳ; và grep toàn repo **0 consumer**. `ListOperationsQuerySchema`
  thì **giữ tên** để `tools/openapi/probe_cases.js` không vỡ.
- **Δ35 — Đổi signature nội bộ của parser thành seam `AllowListedQuery`.** `parseOperationsListQuery(URLSearchParams)`
  vẫn là API công khai không đổi (nó ủy quyền cho `parseAllowListedOperationsListQuery`). Lý do ở §11.4:
  không có seam thì lock chỉ một chiều, và tôi đã chứng minh chiều còn lại lọt.
- **Δ36 — Không sửa `docs/19` / `docs/20`.** Turn 70 mục 4 nêu rõ *"Update docs/19/20 only after the
  source decision"* — nguồn đã chốt ở cycle này, nhưng hai file đó thuộc docs lane. **Việc còn mở:**
  docs lane cần xoá các dòng MISMATCH đã ghi (bây giờ đã được closure) và dẫn chứng
  `ListOperationsQuerySchema`/`PageQuery` **cũ** trong `docs/20:34`, `docs/19:157`, `docs/22:27`.
  Riêng `docs/22-p0-06-capacity-targets.md:27`: trước cycle này câu "enforced by
  contracts public-api.ts PageQuerySchema" là **sai** (route không import gì từ contracts).
  Sau cycle này **substance đúng** — bound 1..100/default 20 nằm trong contracts và route
  import nó — nhưng vẫn **sai tên symbol**: route import `OPERATIONS_LIST_LIMIT_DEFAULT/_MAX`,
  chứ không import `PageQuerySchema` (đó là generic base). Docs lane cần đổi tên symbol.
  (Tự nhận: mô tả ban đầu của tôi trong Mục 11 nói câu này "mới đúng là thật" là
  **overclaim**; đã kiểm lại bằng grep trước khi giữ nguyên.)


---

## 12 — CYCLE 12: W-ADMUX02-EXT-1 — hai mặt list còn lại của ADM-UX-02 (audit + API keys)

**Packet:** chuẩn hoá `GET /api/v1/admin/audit` và `GET /api/v1/admin/api-keys` theo hợp đồng
list đã accept cho operations — limit + cursor + envelope chuẩn, tenant fence trong SQL,
allowlist an toàn, không dùng raw secret làm search param. STRICT offline, không DB window,
không commit/push.

**Kết quả: ĐẠT (a)(b)(c).** ADM-UX-02 vẫn `[~]` — có lý do cụ thể ở §12.6, không phải tiếp nhận mơ hồ.

### 12.0 Kiểm tra nguồn trước khi làm (packet tham chiếu có sai lệch nhỏ)

- Packet ghi **"Reviewer Turn 103 Resized Order"**. `grep "^## Turn 103"` **không ra gì** — mục thật
  tên là `## Plan review after Turn 103` (review.md:3), và phần "Resized order for Antigravity" nằm
  trong đó. Đã đọc đúng mục này; nội dung khớp (mục 4: tách các surface còn lại của ADM-UX-02
  thành packet riêng, giữ ADM-UX-02 partial).
- Packet bảo chạy `tests/admin-api-key-view-model.test.ts` — **có tồn tại** (đã kiểm bằng fs, không
  tin mô tả). Nhưng file đó chỉ test **hàm thuần view-model**, **không đụng route**: nên nó xanh
 _TRƯỚC_ cả khi tôi sửa route. Nghĩa là nếu chỉ chạy 2 suite packet yêu cầu thì **không phát hiện
  được gì cả** — xem §12.4.

### 12.1 Chuông báo thật sự: route trả một kiểu, fetcher đọc một kiểu

Cả `admin-audit-scope.test.ts` và `admin-api-key-view-model.test.ts` đều xanh sau khi tôi đổi envelope
— **đó là bằng chứng của thiếu phủ, không phải của đúng**. Pane sẽ vỡ mà test không biết. Nên tôi
tự bổ sung lớp test nối route → fetcher (§12.4), nằm ngoài danh sách test packet nêu.

### 12.2 Thay đổi

| File | Thay đổi |
|---|---|
| `packages/contracts/src/public-api.ts` | Khối **shared admin list-page**: `ListPageBaseSchema` (5 field), `listPage()`, `encodeListCursor`/`decodeListCursor`/`ListCursor` (đúng định dạng token operations đã live-accept — chuyển về đây, không phải định nghĩa mới), `LIST_CURSOR_MAX_LEN`, `ADMIN_LIST_LIMIT_DEFAULT=50`/`MAX=200`, `ADMIN_AUDIT_LIST_QUERY_PARAMS`, `API_KEY_LIST_QUERY_PARAMS`, `AUDIT_SEVERITY_VALUES`, `API_KEY_STATUS_VALUES`, `AdminAuditListQuerySchema`, `ApiKeyListQuerySchema`. `operationsListPage()` giờ **uỷ quyền** `listPage()` → 5 field có đúng một builder. |
| `src/server.ts` | Route audit + api-keys viết lại; helper mới `keysetPage()` (một executor cho cả hai), `parseAdminAuditListQuery`, `parseApiKeyListQuery`, `listAuditEventPage`, `buildApiKeyPage`. Import toàn bộ bound/enum/từ codec từ `@du/contracts`. |
| `src/app/admin/overview-section-data.ts` | `normaliseAuditEvents` đọc `items` trước, **vẫn nhận** `events` (degrade an toàn cho build cũ) + typed lại envelope. |
| `src/app/admin/api-key-section-data.ts` | Tương tự: `items` trước, `rows` vẫn chấp nhận. |
| `src/modules/audit/audit.ts` | **Chỉ đổi doc-comment** cho `listForTenant` (giữ nguyên hành vi; offline scope test vẫn dùng nó). |
| `tests/admin-list-contract-conformance.test.ts` | **MỚI, 23 test.** |

**Cụ thể đã hết gì:**
- **audit:** cũ là `{ tenantId, events }` với `limit` ≤200 nhưng **không có cursor** → không xem
  được trang 2. Nay: cùng keyset `(created_at, id)` hai chiều, `severity` (allowlist 4 giá trị),
  `action` (token), và **cùng `clauses` cho cả count lẫn page** — nếu không số `total` sẽ nói dối.
  Giữ nguyên hành vi cũ có chủ đích: không có tenant trong phạm vi ⇒ **trang rỗng trung thực**,
  không phải đọc không ghim tenant.
- **api-keys:** cũ là `SELECT ... ORDER BY created_at DESC` **không có LIMIT** — đọc **toàn bộ**
  bảng mỗi request rồi lọc tenant **bằng JavaScript**. Nay `tenant_id = $1` + `LIMIT` trong SQL,
  thêm `status` (allowlist) và `prefix` (substring). Đúng điều ADM-UX-02 cấm: "không triển khai
  search bằng cách fetch toàn bộ dữ liệu rồi lọc".

### 12.3 An toàn (mục c)

- **Tenant fence là SQL, cho cả hai principal.** Trước đây operator bị lọc **sau** khi row đã ra
  khỏi DB; nay predicate nằm trong câu query nên row ngoài phạm vi **không rời database**. Foreign
  `?tenantId=` ⇒ **403 trước khi chạy bất kỳ query nào** (test khẳng định `calls.length === 0`),
  vẫn dùng đúng câu chữ canonical `admin reads are scoped to the caller tenant`.
- Cho phép platform principal narrowing qua `?tenantId=`; by-id vẫn 404 không phân biệt (không rò
  sự tồn tại).
- `tenantId` phải là **uuid** (khác operations list, nơi token class rộng hơn) ⇒ không thể là
  path/credential.
- `severity`/`status`: enum khép kín; `action`/`prefix`: cùng lớp ký tự dùng chung,
  **từ chối hex đặc ≥32** ⇒ dán API key vào ô tìm kiếm vẫn bị 422, không vào URL/DOM/log.
- Test khẳng định `hash` không xuất hiện trong cả SQL lẫn body; chỉ `prefix` (đã hiển thị trên
  màn hình) mới là cột tìm — đó là lý do `prefix` hợp pháp mà secret thì không.
- `strpos` thay `LIKE` cho substring (lớp ký tự cho phép `_` = wildcard LIKE).

### 12.4 Test mới (23) và bằng chứng lock **chặn được cả hai chiều**

Envelope (5), `total` là count không phải độ dài page, luôn có `LIMIT` trong SQL, cursor round-trip
`next`→`prev` decode bằng đúng codec chung, trang 1 không có prev, fence 403-trước-query, allowlist
422, không có giá trị nào của caller nằm trong SQL text, `status`/`prefix` bound, by-id còn fence,
và **4 test nối route-body → fetcher-parser** cho cả hai pane (cả đường legacy).

Đột biến (học từ Δ ở Mục 11 — lock một chiều là lock giả):

| Đột biến | Kết quả |
|---|---|
| Baseline | `exit=0`, 23/23 |
| **MA** audit trả lại shape cũ `{tenantId, events}` | `exit=1` — **4 test đỏ** |
| **MB** api-keys quay lại load-all (bỏ paging SQL) | `exit=1` — **2 test đỏ** |
| Restore | `source restored identically = true`, 23/23 exit 0 |

### 12.5 Bằng chứng (offline)

cwd `…\services\orchestrator` (jest/tsc) và `…\du-rework` (pnpm); wrapper literal `Exit Code:`.

1. **Lệnh packet yêu cầu:**
   `npx tsc --noEmit` → `Exit Code: 0` (×3).
   `pnpm --filter @du/orchestrator test -- tests/admin-audit-scope.test.ts tests/admin-api-key-view-model.test.ts`
   → trong bộ 10-suite: **439/439 ×3 `Exit Code: 0`** (chạy lẻ 2 suite packet nêu cũng nằm trong đó).
2. **contracts:** `lint` + `build` + `test` → `Test Suites: 12 passed` / `Tests: 217 passed, 217 total`
   **×3 `Exit Code: 0`**.
3. **Suite mới:** `Tests: 23 passed, 23 total`, `Exit Code: 0`.
4. **Full offline sweep:** `2 failed, 2 skipped, 61 passed, 63 of 65` /
   `12 failed, 21 skipped, 1457 passed, 1490 total`.
   **Cả 2 suite đỏ không thuộc lane này** — `connector-revision-http-offline.functional` và
   `mock-vault-harness-offline.functional`, đều dừng ở
   `src/modules/connector-credentials/workflow.ts:166 BINDING_DENIED` (thư mục untracked, lane
   khác đang làm dở) + 1 assertion timing của renewal daemon. So với đầu chu kỳ trước
   (4 suite đỏ) thì **đã giảm còn 2**; 2 suite loopback flake nay xanh.
   Toàn bộ suite Admin/contracts của lane tôi đều PASS trong sweep song song.
5. Không DB/Redis/S3 window; không commit/push (`git log` vẫn `7811298`).

### 12.6 Vì sao ADM-UX-02 **vẫn** `[~]` (không phải nhận bừa)

Đã đủ cho audit + api-keys *pagination*, nhưng điều kiện đóng của row còn thiếu thật:
1. **`sort` allowlist vẫn chưa có ở cả ba list** (operations/audit/api-keys). Audit cần
   `time/actor/resource/severity`; tôi mới làm `severity` + `action`. `actor`/`resource`/dải thời
   gian **chưa có**.
2. **`label` và `last-used` cho API keys không có cột nào trong schema.** `api_keys` chỉ có
   `id, tenant_id, hash, prefix, status, created_at` (đã grep migration, không có ALTER nào thêm
   cột). Điều kiện "lọc label/prefix/status/last-used" do đó **không thể đóng bằng query** —
   cần migration, tức cần DB window + packet riêng. Tôi **không** giả bộ lọc trên cột không tồn tại.
3. **businesses/versions vẫn chưa có hợp đồng list này.**
4. **audit không có `?cursor` cho tới chu kỳ này nên chưa có bằng chứng sống**; và như Mục 11,
   mọi thứ ở đây mới **offline-verified**. Cần Tester chạy live.
5. by-id api-keys trả `items` một phần tử mà **không** qua `keysetPage` (không có `total` thật của
   quần thể) — chủ đích vì đó là read một tài nguyên, nhưng ghi rõ để sau không nhầm là page.

### 12.7 Thống kê file

```
packages\contracts\src\public-api.ts                          lines=425  bytes=16864  (trước 258/10122)
services\orchestrator\src\server.ts                            lines=2923 bytes=130927 (trước 2550/117504)
services\orchestrator\src\modules\audit\audit.ts                lines=179  bytes=6732   (chỉ doc-comment)
services\orchestrator\src\app\admin\overview-section-data.ts    lines=664  bytes=23083
services\orchestrator\src\app\admin\api-key-section-data.ts     lines=508  bytes=16637
services\orchestrator\tests\admin-list-contract-conformance.test.ts lines=371 bytes=16481 (MỚI)
```

---

## Δ-DEVIATION Mục 12

- **Δ37 — Mở rộng phạm vi sang 3 file ngoài danh sách packet** (`overview-section-data.ts`,
  `api-key-section-data.ts`, `contracts/public-api.ts`). Packet cho phép "hoặc các file view model /
  query tương ứng trong admin BFF", và `public-api.ts` là nơi hợp đồng chung đã chốt ở Mục 11 —
  thêm 2 bản sao bound/cursor mới vào `server.ts` chính là tái phạm T70-C1.
- **Δ38 — Thêm 4 test nối route → fetcher ngoài danh sách test packet nêu.** Lý do ở §12.1: hai
  suite packet chỉ định đều xanh **trước và sau** khi tôi đổi envelope, tức chúng không đủ để
  accept thay đổi này. Không có 4 test đó thì tôi đã ship một chỗ vỡ pane thật sự.
- **Δ39 — Không đổi `listAuthorizedAuditEvents`.** Nó vẫn là seam mà offline scope test dùng; tôi
  thêm đường paging riêng trong route thay vì sửa seam cũ (tránh phá mặt API đang có consumer).
- **Δ40 — by-id api-keys không đi qua `keysetPage`.** Trả `items` 1 phần tử + `grants`, giữ hành vi
  cũ. Không phải lỗi: một tài nguyên không phải một trang; ghi để sau không ai "sửa" cho đều.
- **Δ41 — Chưa chạy live.** Toàn bộ Mục 12 là offline. Đề nghị một packet live cho audit + api-keys
  (cần DB window, có fixture ≥1.000 sự kiện và ≥2 tenant) trước khi ai đó gọi ADM-UX-02 là xong.

---

## 13 — CYCLE 13: W-ADMUX03-TOOLBAR-CHIPS-1 — chip bộ lọc, `Clear all` reset, deep link đồng bộ

**Định nghĩa win/lose của packet:** (1) có chip cho state/tenant/id khi đang lọc; (2) có điều khiển
`Clear all` mang `data-filter-clear-all`, reset về `limit=20` không còn tham số lọc; (3) deep link
nhất quán; (4) hai suite chỉ định xanh; (5) tsc sạch; (6) receipt. STRICT offline, không cửa DB,
không commit/push.

### 13.1 Kiểm tra trước khi sửa: bullet nào thật sự còn thiếu

Packet viết như thể cả ba việc chưa làm. Đã kiểm từng cái trong source hiện tại, không đoán:

| Bullet packet | Trạng thái đầu chu kỳ | Bằng chứng |
|---|---|---|
| Chip state/tenant/id | **đã có từ Mục 2** | `operation-section-renderer.ts:442-468`; test cũ `tests/admin-operations-list-pagination.test.ts:693-694` |
| `Clear all` + `data-filter-clear-all` | **đã có nhưng SAI** — giữ nguyên page size đang dùng | `:480` (trước khi +5 dòng): `opsPageHref({ limit: f.limit })` |
| Deep link nhất quán | mới so chuỗi href bằng `toContain`, **chưa lần nào đi theo link** | block `W-ADMUX-03: toolbar, chips…` |

→ bug thật: từ `?limit=50&state=FAILED` (hoặc 100), `Clear all` trả `/admin/operations?limit=50`,
trái với chính checklist C1 tôi soạn ở Mục 10 ("Clear all → về `?limit=20`, không còn filter nào").
Việc còn lại của chu kỳ: sửa đích reset, và biến "deep link nhất quán" thành tính chất **kiểm chứng
được bằng cách đi theo link**, không phải so chuỗi.

### 13.2 Diff tóm tắt

`services/orchestrator/src/app/admin/operation-section-renderer.ts` (+5 dòng, 694 → 699; 33.065 B):

```diff
-  const clearAll = opsPageHref({ limit: f.limit });
+  // W-ADMUX03-TOOLBAR-CHIPS-1: "Clear all" is a reset, not a filter edit. ...
+  const clearAll = opsPageHref({ limit: OPERATION_LIST_DEFAULT_LIMIT });
-    `<a class="admin-filter-chip admin-filter-chip--clear-all" href="${esc(clearAll)}" data-filter-clear-all="true">Clear all</a>`,
+    `<a class="admin-filter-chip admin-filter-chip--clear-all" href="${esc(clearAll)}" aria-label="Clear all filters and reset the page size to ${OPERATION_LIST_DEFAULT_LIMIT}" data-filter-clear-all="true">Clear all</a>`,
```

Không sửa `operation-section-data.ts`, `shell-router.ts`, `server.ts`, `contracts`: chip và href đã
đúng, chỉ đích reset sai. Đã đọc lại `backToListHref` (giữ limit+cursor+filters), `renderPaginationNav`
(prev/next/page-size đều qua `opsPageHref` với đúng filters) và `renderFilterBar` (echo `limit` ẩn +
giá trị đã sanitize) — không còn chỗ nào khác phải đổi.

### 13.3 Test mới (+7: suite 71 → 78; cặp packet 94 → 101)

Block `W-ADMUX03-TOOLBAR-CHIPS-1: clear-all reset, chip hops and deep-link sync`. Fixture catalog 13
dòng **có quần thể khác nhau theo từng hop** (8 RUNNING/tenant-a + 1 FAILED cùng tenant + 1 RUNNING
tenant-b + done/fail/rest), để mỗi hop gỡ chip **đổi `total` thật** chứ không phải con số không đổi
do fixture tình cờ khớp mọi filter.

1. `Clear all` về đúng `/admin/operations?limit=20`, tham số duy nhất là `limit`; pane đích báo
   `data-filter-active="false"` / `data-filter-chips="none"` / `data-list-total="13"`, và pane **nguồn**
   quả thật là một trang lọc sâu (`data-list-limit="5"`, `data-list-cursor="off:5"`) — nếu không có
   dòng đó thì test này xanh ngay cả khi chẳng có gì để reset.
2. Mỗi chip một link remove, ba href đúng từng ký tự (kể `&amp;`); remove **giữ** limit 5 — bất đối
   xứng có chủ đích, có test khoá (`expect(chipRemove).not.toBe(clearAll)`).
3. **Đi theo từng chip một**: state → tenant → id; `total` phải là 9 → 10 → 13, pane không còn chip của
   filter vừa gỡ, còn nguyên các chip kia; hop cuối **không còn Clear all** vì không còn gì để xoá.
4. **Mọi href list** của pane (lọc + phân trang + clear-all): parse lại bằng đúng `parseQueryString` +
   `parseOperationListQuery` của shell → fetcher → renderer, rồi yêu cầu pane đích báo **chính xác
   query của href**: `data-list-limit`, `data-filter-state`, có/không từng chip
   (`toBe(query.get(name) !== null)` — hai chiều, không bịa chip, không mất chip), có/không
   `data-list-cursor`; mỗi tham số phải ∈ `OPERATIONS_LIST_QUERY_PARAMS` và mỗi giá trị phải qua
   `isOperationsListFilterToken`. Đây là khoá phía **phát ra URL**, bổ sung cho khoá phía **đọc** (seam
   `AllowListedQuery`) ở Mục 11 — hai chiều khớp nhau thì shell không thể tự chế tham số.
5. **Bất động điểm**: mọi href không mang cursor, sau khi follow, được chính pane đó phát lại kèm
   `aria-current="true"` — URL là trạng thái, điều hướng không thêm bớt gì.
6. Giá trị bị từ chối (32 hex liền mạch — key thô dán vào ô tenant) không xuất hiện trong **bất kỳ**
   href nào; Clear all vẫn là đường thoát; pane đích báo `data-filter-ignored="none"`.
7. Pane mà filter duy nhất bị từ chối (không còn filter hiệu lực) vẫn hiện chip từ chối + Clear all.

### 13.4 Đột biến: chứng minh test bắt được bug chứ không mô tả lại code

| Lần chạy | Kết quả |
|---|---|
| Baseline trước sửa | cặp packet **94/94**, `Exit Code: 0` — code cũ xanh, nên bug không lộ từ test có sẵn |
| Source reverted (`limit: f.limit`) | **3 failed, 75 passed, 78 total**, `Exit Code: 1`; cả 3 đỏ cùng một dòng: `Expected: "/admin/operations?limit=20" / Received: "/admin/operations?limit=5"` |
| Restore | đếm chuỗi trong source: `opsPageHref({ limit: OPERATION_LIST_DEFAULT_LIMIT })` = **1**, `opsPageHref({ limit: f.limit })` = **0**; cặp packet **101/101 ×3 exit 0** |

Nghi thức: hai file này đang `??` trong git (**không có `git diff` làm lưới**), nên khôi phục phải
kiểm bằng đếm chuỗi trong source, không được tin "lệnh edit đã chạy". Bài học cụ thể: một script exec
**dừng ngay ở lệnh có exit ≠ 0** — lần này lệnh đột biến làm phần restore trong cùng script không chạy,
source bị bỏ lại ở trạng thái sai; đã phát hiện bằng grep trước khi báo cáo và restore ở lượt riêng.

### 13.5 Bằng chứng (offline)

cwd `…\du-rework` cho pnpm; lấy literal `Exit Code:` của wrapper, không dùng `%ErrorLevel%`.

1. **Packet bước 2:** `pnpm --filter @du/orchestrator test -- tests/admin-operations-list-pagination.test.ts tests/admin-list-contract-conformance.test.ts`
   → `Test Suites: 2 passed, 2 total` / `Tests: 101 passed, 101 total` — **×3**, mỗi lần `Exit Code: 0`.
2. **Packet bước 3:** `pnpm --filter @du/orchestrator exec tsc --noEmit` → `Exit Code: 0` **×3**.
3. **Hồi quy rộng (6 suite Admin UI cùng renderer):** `admin-shell-render`, `admin-shell-router`,
   `admin-shell-server`, `admin-operation-view-model`, `admin-p6-01-shell-fixtures`, `admin-view-model`
   → `6 passed` / `434 passed, 434 total`, `Exit Code: 0`. Không phải sửa test nào vì `aria-label`/href mới.
4. Không mở cửa DB/Redis/S3; không chạy suite nào có `DU_LIVE_INFRA`. Không commit/push: `git log -1`
   vẫn `7811298 rework`, `git diff --cached --stat` rỗng.

### 13.6 Vì sao ADM-UX-03 vẫn `[ ]` (không tự tick)

- **`sort` chưa có ở bất kỳ đâu** — row đòi "sort và next/previous page".
- Row đòi lọc **business / action / thời gian** cho operations: contract hiện chỉ allowlist
  `limit/cursor/state/tenant/id`; thêm filter là việc của ADM-UX-02 (route + index), không phải renderer.
- Row đòi cùng bộ lọc cho **API keys / businesses / audit**: audit mới có `severity`+`action`, api-keys
  mới có `status`+`prefix`, businesses chưa gì; `label`/`last-used` **không có cột trong schema** (Mục 12).
- Row đòi **"Debounce/cancel request cũ"**: shell server-render không JS, mỗi request là một navigation
  — không có request cũ nào để debounce/hủy. Lệch mô hình, ghi ở Δ45, không phải việc tôi tự đóng.
- Tất cả mới offline. Browser journey C1/C2 (Tester, cần DB window) chưa chạy.

---

## Δ-DEVIATION Mục 13

- **Δ42 — Bullet 1 của packet đã hoàn thành từ Mục 2.** Không có code mới cho phần chip; chu kỳ này
  chỉ thêm bằng chứng hành vi (hop walk). Không ghi "đã build chip" như thể làm lần đầu.
- **Δ43 — "Clear all *button*" render bằng `<a>`.** Shell không có client JS: `type="button"` vô dụng,
  `type="submit"` sẽ gửi kèm `state=ALL&tenant=&id=` vì form là GET. Giữ đúng thuộc tính packet yêu cầu
  (`data-filter-clear-all="true"`) và thêm `aria-label` nêu rõ nó reset cả page size.
- **Δ44 — Bất đối xứng giới hạn có chủ đích:** chip-remove giữ `limit` operator đã chọn, chỉ clear-all
  reset về mặc định. Packet chỉ định reset cho clear-all; hành vi cũ của chip-remove đã có test từ Mục 2.
- **Δ45 — "Debounce/cancel request cũ" không áp dụng được, và URL sau khi bấm Apply filters không
  canonical.** Form GET gửi cả ô trống → address bar thành `?limit=20&state=ALL&tenant=&id=`; pane đọc
  đúng là "không lọc" và **mọi link nó phát ra đều canonical**. Chỉ sửa được bằng JS (rewrite URL) —
  trái thiết kế shell. Ghi để Tester đọc đúng C2, không xử nhầm là fail.
- **Δ46 — Không đụng `shell-router.ts`/`server.ts`/`contracts` dù packet nói "URL sync".** Đã đọc
  chuỗi parse→fetch→render và không thấy lỗi nào ở đó; thêm code lúc này là suy phạm vi không bằng
  chứng. Test 4+5 khoá đúng seam đó từ bên ngoài.
- **Δ47 — Vẫn offline-only.** Toàn bộ là fixture catalog + `fetchImpl` tiêm sẵn. Đề nghị packet live
  (browser C1/C2) cho phần "URL giữ filter khi F5 / mở tab mới": offline chứng minh được href ↔ pane,
  chỉ browser mới chứng minh được navigation thật.

---



## 14 — CYCLE 14: W-ADMUX02-SORT-ALLOWLIST-1 — `sort` cho `GET /api/v1/operations`

Packet buộc tôi làm **contracts trước, route sau**, và đó đúng là thứ tự kiến trúc đã chốt ở Mục 11:
seam `AllowListedQuery` lấy tên tham số từ `OPERATIONS_LIST_QUERY_PARAMS`, nên `read('sort')` chỉ biên dịch
được sau khi `sort` nằm trong array. Khoá biên dịch hoạt động chính xác như thiết kế — không phải việc tôi
làm tốt, đó là cái khoá đã buộc đi đúng đường.

### 14.1 Phân loại packet trước khi sửa (đọc source từng bullet, không lấy công bừa)

| Bullet packet | Hiện trạng đã đọc trong source | Kết luận |
|---|---|---|
| `OPERATIONS_LIST_SORT_FIELDS` / `_DIRECTIONS` | grep `sort` trong `packages/contracts/src` + `src/app/admin`: **0 match** | làm mới hoàn toàn |
| Thêm `sort` vào `ListOperationsQuerySchema`, default `created_at:desc` | schema tồn tại và `.strict()`, **không có** `sort`; test `operations-list-contract.test.ts:39` so key set của schema == array tham số | phải đổi array + schema **cùng lúc**, nếu không test số lượng đỏ |
| Route đọc/parse `sort`, ORDER BY an toàn | `server.ts:2339` hardcode `ORDER BY created_at`, comment còn ghi "Sorting is a fixed literal" | sửa hành vi **và** sửa comment (để nguyên là nói sai trong source) |
| Ngoài allowlist → 422 `INVALID_QUERY_PARAMETER` | code đó **không tồn tại** ở bất kỳ đâu trong `src` (0 match); `PublicErrorCodes`/`RuntimeErrorCodes` không có; 422 của 4 tham số kia đều là `INVALID_SCHEMA` | dùng `INVALID_SCHEMA`, ghi **Δ50** xin phán quyết, không tự chế code mới |

### 14.2 Cái bẫy packet không nêu: `deadline_at` là cột NULLABLE

- `migrations/0001_platform_v1.sql:46` khai `deadline_at timestamptz` — **không NOT NULL**; `:51`/`:52` thì
  `created_at`/`updated_at` đều NOT NULL. Packet gộp ba cột vào một allowlist mà không phân biệt.
- Hệ quả thật, không phải lý thuyết: vị từ keyset `(deadline_at, id) < ($1::timestamptz, $2::uuid)` gặp
  `deadline_at IS NULL` cho NULL → row **bị loại**. Trang 1 vẫn đúng, từ trang 2 mất toàn bộ operation
  không có deadline, trả 200 với một trang trông hợp lý. Mà phần lớn operation không có deadline
  (`deadlineAt: null` trong `tools/openapi/probe_cases.js`) → mất gần hết tập.
- Sửa: key là `COALESCE(deadline_at, $n::timestamptz)`, sentinel **bind bằng tham số** chứ không nội suy.
  Vì sao bind: (1) giữ đúng kỷ luật "chỉ TEMPLATES được nội suy" mà cả 4 filter đang theo; (2) test
  `no caller-supplied value is ever concatenated` assert `sql not.toMatch(/'|;|--/)` — một literal có dấu
  nháy trong ORDER BY sẽ đánh bại test đó, và đánh bại test là sai hướng.
- Sentinel chọn theo hướng để **khối NULL luôn nằm cuối** ordering: `desc` → `0001-01-01T00:00:00.000Z`,
  `asc` → `9999-12-31T23:59:59.999Z`. Không dùng `+/-infinity` của PG: `encodeOperationsListCursor` bắt
  instant round-trip qua `toISOString()`, còn infinity do driver trả về thì không round-trip được.
- Chuỗi sentinel dùng chung một constant cho SQL (bound) và JS (`operationsListBoundaryKey`), nên cursor
  luôn mang đúng giá trị vị trí mà chính SQL sản sinh — lệch nhau ở đây là paginate từ một chỗ không tồn tại.

### 14.3 Bẫy thứ hai: hướng đi của keyset phải đảo theo `direction`

- Trước đây ordering luôn DESC nên forward = `<`, backward = `>` là đủ. Với `sort=...:asc` thì ngược lại.
- Nay: `scanDirection = descending !== backwards ? DESC : ASC` (lùi thì quét chiều ngược để LIMIT bám
  sát biên), và `op = descending === backwards ? '>' : '<'`. Đã kiểm tay cả 4 tổ hợp.
- Với default `created_at:desc` chuỗi SQL ra **giống hệt từng byte** như trước. Chứng cứ: test "an absent
  sort is byte-identical to the pre-sort route" + 5 test `W-ADMUX02-SRV-1-FIX` cũ (chúng so khớp đúng
  chuỗi `ORDER BY created_at ASC, id ASC` và `(created_at, id) > (` bằng regex) vẫn xanh không sửa.

### 14.4 Code đã đổi

**`packages/contracts/src/public-api.ts`** — `OPERATIONS_LIST_SORT_FIELDS`, `OPERATIONS_LIST_SORT_DIRECTIONS`,
`OPERATIONS_LIST_SORT_DEFAULT_FIELD/_DIRECTION/_DEFAULT`, `parseOperationsListSort()`,
`formatOperationsListSort()`, `OPERATIONS_LIST_SORT_VALUES` (sáu giá trị, đúng cái 422 quảng cáo), `'sort'`
vào `OPERATIONS_LIST_QUERY_PARAMS`, và `sort` vào schema (`.refine` + `.default`).
Điểm chốt: **schema refine gọi đúng `parseOperationsListSort` mà route dùng** — một implementation, hai
nơi gọi. Nếu mỗi bên tự kiểm, contract sẽ quảng cáo một sort mà route 422, tức lại T70-C1.
Tách theo dấu `:` **cuối cùng**, cố ý: giá trị có thêm colon phải chết chứ không bị cắt gọt thành hợp lệ.

**`services/orchestrator/src/server.ts`** — bốn bảng literal (`..._SORT_COLUMN_SQL`,
`..._NULLABLE_SORT_FIELDS`, `..._NULL_SORT_BOUND_SQL`, `..._SORT_SQL_DIRECTION`),
`bindOperationsListSortKey()`, `operationsListBoundaryKey()`, `parseOperationsListSortParam()` (422
`INVALID_SCHEMA`, không bao giờ âm thầm về default), `OperationsListQuery.sort`, `bindOperationsCursor`
nhận thêm `(sortKeySql, descending)`, và `listOperationsPage` dùng key/scan/op mới. Sentinel được cấp
số **sau** các tham số filter để bật sort không đánh số lại placeholder mà test filter đang pin
(`state = ANY($1::text[])`).

### 14.5 Test mới: 19

- `contracts/tests/operations-list-contract.test.ts` 6 → **16**: array sáu tên; default `sort` khi query
  rỗng; `OPERATIONS_LIST_SORT_VALUES` == tích hai array; mọi sort hợp lệ được cả schema lẫn parser
  chấp; 22 giá trị ngoài allowlist bị **cả hai** từ chối (gồm `state:desc`, `id:asc`, `result_ref:asc` —
  cột thật nhưng contract không chào hàng — và các hình thái injection `);DROP TABLE`, `, id DESC`,
  `UNION SELECT`); chuẩn hoá hoa/thường + khoảng trắng về dạng thường.
- `services/orchestrator/tests/operations-list-contract-conformance.test.ts` 11 → **19**: bảng sáu chuỗi
  ORDER BY hợp lệ (test so đúng từng ký tự, không so kiểu "có chứa từ khoá"); sort nào cũng kết thúc bằng
  `, id (ASC|DESC)`; text của caller không vào SQL; sentinel của cột nullable **được bind, không nội suy**
  (SQL không chứa `0001-01-01`, params có nó; cột not-null không được mọc thêm COALESCE); sort không
  đụng vào count (6 sort cho ra **một** câu count duy nhất, không ORDER BY); sort sai → 422 **trước khi
  truy vấn nào chạy**; route và schema quyết định giống nhau trên cùng một giá trị.
- `services/orchestrator/tests/admin-operations-list-pagination.test.ts` 78 → **89**: fake db **thực thi**
  câu SQL route phát ra (tự trích key expression, hai chiều, vị trí `$n` của operator biên và LIMIT),
  trong đó có bất biến "biên phải so trên đúng expression mà ORDER BY dùng" và "tiebreak `id` phải cùng
  chiều với key". Population 12 dòng dựng sẵn để đánh hai chỗ gãy: nhiều key trùng nhau (mỗi cột một
  cách nhóm khác nhau, nên chọn nhầm cột là lộ ngay) và 4 dòng **không có deadline**. 11 test: đi hết
  6 sort và so với oracle tính độc lập; không mất dòng NULL nào; boundary cắt trong nhóm trùng key với
  `limit=1` không skip/not-duplicate; tiebreak đổi chiều cùng key; bật lùi (backward hop) dưới chiều ASC
  cho lại đúng trang cũ; `total` không đổi theo sort.

### 14.6 Ba lần đột biến — cả ba đều bị bắt

| Đột biến | Dự định chứng minh | Kết quả |
|---|---|---|
| M1: để `OPERATIONS_LIST_NULLABLE_SORT_FIELDS` rỗng (giả vờ `deadline_at` not-null) | phần xử lý NULL có thật sự cần | **7 đỏ / 2 file**: conformance chỉ ra `ORDER BY deadline_at DESC` thay vì `COALESCE(...)`, pagination chết tại `a NULL deadline_at was ordered by a key with no NULL handling` — đúng cái bẫy §14.2 |
| M2: `op = cursor.direction === 'prev' ? ...` (bỏ `descending`) | keyset có thật sự đổi hướng theo sort | **6 đỏ, đúng 3 test `:asc`**, mọi test `:desc` vẫn xanh. 5 test SRV-1-FIX cũ **không thấy gì** — chứng tỏ phần này trước đây chưa có lưới |
| M3: sort sai trả default thay vì 422 | fail-closed có thật | **3 đỏ**, và output cho thấy route ** trả 200 nguyên một trang** nơi nợ 422 |
| Restore | — | đếm chuỗi trong source: `['>deadline_at'])`→`[']` = 0 / `['>deadline_at'])` = 1, `const op = descending ===` = 1, `return { field: ...DEFAULT... }` trong parser = 0; `tsc --noEmit` `Exit Code: 0`; chạy lại đủ bằng chứng ở §14.7 trên source **đã restore** |

Lần này restore nằm ở lượt call riêng (bài học §13.4), nên không lặp lại sự cố bỏ lại source ở trạng thái
sai. Có một lần suýt hỏng: bản M3 đầu tiên tôi thay nửa câu, để lại `throw` cụt — `tsc` đỏ ngay, đã
restore và làm lại bản thay trọn khối.

**Sự cố với chính file ledger này, ghi lại để audit được:** khi chèn Mục 14 vào, tôi dùng
`String.replace(anchor, payload)` — replace **diễn giải** `$&`, `$``, `$'` trong payload như pattern đặc
biệt, nên file nổ từ 1634 → **5052 dòng** (nội dung cũ bị nhân bản giữa chừng). Đã khôi phục deterministic
(cắt đúng tại marker `## 14 —` và anchor `## Ledger` cuối) rồi chèn lại bằng `split/join` (không có $
processing). Kiểm sau chèn: **1619/1619 dòng trước anchor giống hệt bản gốc**, đúng 1 anchor `## Ledger`,
14 heading chu kỳ, 14 dòng ledger, §13 + Δ42–Δ47 còn nguyên. Không có nội dung nào của lane khác bị mất.

### 14.7 Bằng chứng (offline)

cwd `…\du-rework` cho pnpm; lấy literal `Exit Code:` của wrapper, không dùng pipe/findstr (một lần dùng
`| findstr` đã làm mặt nạ mã thoát thật — tự sửa, ghi ở Δ56).

1. `pnpm --filter @du/contracts build` → `Exit Code: 0` **×3**.
2. `pnpm --filter @du/contracts test` → `Tests: 385 passed, 385 total` / `Test Suites: 17 passed` — **×3**, `Exit Code: 0`.
   (Mục 11–12 ghi 217/217: tổng đã tăng vì lane khác thêm suite vault/usage, phần tôi +10. **Không được
   đọc 385 so với 217 như cùng một chủng — không phải suy diễn từ 101.**)
3. Cặp packet `operations-list-contract-conformance` + `admin-operations-list-pagination` →
   `Tests: 108 passed, 108 total` — **×3**, `Exit Code: 0`. Lưu ý chủng loại: cặp ở Mục 13 là 101 vì file
   thứ hai là `admin-list-contract-conformance`; packet này đổi sang `operations-list-contract-conformance`
   → 108 = 89 + 19, không phải suy diễn từ 101 (Δ49).
4. `pnpm --filter @du/orchestrator exec tsc --noEmit` → `Exit Code: 0` **×3** (stdout rỗng).
5. Hồi quy rộng 10 suite (admin-list-conformance, shell-router, shell-render, operation-view-model,
   shell-live-pane, base-routes, migrations-ledger-guard, keyset-explain + 2 file packet):
   `Tests: 14 skipped, 375 passed, 389 total`, `Test Suites: 3 skipped, 7 passed`, `Exit Code: 0`.
   Ba suite skip là **live-gated** (`DU_LIVE_INFRA`): `admin-shell-live-pane`, `admin-base-routes`,
   `admin-keyset-explain` — **skip, không phải pass** (Δ53: chính suite explain đó mới chỉ pin plan cho
   `created_at`).
6. Không mở cửa DB/Redis/S3, không chạy suite live nào. Không commit/push: `git log -1` vẫn
   `7811298 rework`, `git diff --cached --stat` rỗng.

### 14.8 Vì sao ADM-UX-02 vẫn `[~]` (không tự tick)

- Sort mới chỉ có ở **route operations**. `keysetPage()` dùng cho audit + api-keys vẫn hardcode
  `ORDER BY created_at` — row ADM-UX-02 đòi hợp đồng chung cho các list khác.
- Hai khoá mới (`updated_at`, `deadline_at`) **không có index nào chống lưng**; `0017` chỉ phủ
  `(created_at, id)` và `(tenant_id, created_at, id)`. Offline không tự chứng minh được query plan →
  cần 0018 + EXPLAIN live (Δ53).
- Sort và cursor **chưa bị ràng buộc nhau trong token**: cursor là vị trí trong MỘT ordering, nên phát
  lại cursor của `created_at:desc` cho `sort=updated_at:asc` không có nghĩa xác định. Tôi **không** đổi
  format token (đã được accept live ở T-CODEX-TEST-20, và codec dùng chung với audit/api-keys) — ghi ở
  Δ52 để coordinator phán.
- `label`/`last-used` của API keys vẫn cần migration (Mục 12).
- Browser journey C0–C5 (Tester, DB window) chưa chạy → `G-ADMIN-OPS` giữ **NO-GO**.

---

## Δ-DEVIATION Mục 14

- **Δ48 — Packet bảo "append vào Muc 13", nhưng Mục 13 đã khép.** Report đã có 13 section + 13 dòng
  ledger; làm đúng câu đó là đè receipt của một chu kỳ khác. Receipt này là **Mục 14**. Số mục lệch một,
  không phải nội dung.
- **Δ49 — Cặp test của packet không cùng chủng với cặp của Mục 13.** Mục 13: pagination +
  `admin-list-contract-conformance` = 101. Packet này: pagination + `operations-list-contract-conformance`
  = 108. Đã kiểm cả hai file đều tồn tại. Không được trình bày 108 như thể "tăng từ 101".
- **Δ50 — Không dùng code lỗi packet ghi.** `INVALID_QUERY_PARAMETER` có **0 match** trong
  `services/orchestrator/src`, không nằm trong `PublicErrorCodes`/`RuntimeErrorCodes` của contracts, và
  `docs/06:45-48` quảng bá `INVALID_SCHEMA` cho cả 4 tham số kia. Tự thêm code mới = đổi vocabulary trên
  wire mà một mình lane UI không có quyền quyết. Đã dùng `INVALID_SCHEMA`; nếu coordinator muốn code riêng
  cho sort, đó là việc contracts + docs/06 + OpenAPI probe, làm trong một packet hẳn hoi.
- **Δ51 — Packet xếp ba cột vào một allowlist mà không nói `deadline_at` khác hai cột kia.** Nó NULLABLE,
  và với row-value keyset thì khác biệt đó là **mất dữ liệu im lặng**, không phải thứ tự hơi lạ. Đã xử lý
  bằng key coalesce + bound sentinel (§14.2) và có test riêng. Nếu giữ nguyên như packet mô tả, code sẽ
  xanh trên mọi test cũ và sai trên dữ liệu thật.
- **Δ52 — Cursor không mang danh tính của sort.** Phát lại cursor sinh ra dưới một ordering cho một ordering
  khác là hành vi không xác định (an toàn, có fence, không inject — nhưng vẫn là trang sai). Đã khoá
  được nửa phía UI (default = `created_at:desc` nên link cũ không đổi hành vi, xem §14.3), còn nửa phía
  wire cần phán quyết: (a) chấp nhận như hiện tại + tài liệu hoá "đổi sort thì bỏ cursor", hoặc (b) token
  v2 nhúng field/direction và 422 khi lệch — đổi format đã accept live, đụng codec chung của audit +
  api-keys và test của ba lane. Tôi **không tự chọn (b)**.
- **Δ53 — Hai sort key mới không có index; bằng chứng plan chưa exists.** `0017` chỉ phủ `(created_at, id)`.
  `admin-keyset-explain` (6 test, live) chỉ assert plan cho `created_at`, và offline nó skip. Hệ quả thật
  khi bật live: hai khoá kia sẽ mang Sort node. Follow-on: hoặc thêm index trong **0018** (0017 đã apply
  rồi — Δ24, sửa tại chỗ sẽ bị `migrate()` bỏ qua im lặng), hoặc rút allowlist về cột có index.
  Không quyết định một mình vì đây là đánh đổi schema/plan, cần DB window.
- **Δ54 — Không đụng Admin UI.** Packet chỉ ghi `public-api.ts` + `server.ts`, nên shell không có control
  sort: pane vẫn không gửi `sort` → luôn nhận default; `?sort=` gõ tay vào URL `/admin/...` bị shell
  parser bỏ qua và fetcher của shell chỉ gửi tham số đã sanitize, nên route không bao giờ thấy nó.
  Hệ quả phải nói thẳng: điều khoản "sort và next/previous page" của **ADM-UX-03 vẫn chưa đạt ở phía UI**
  dù route đã phục vụ được.
- **Δ55 — Chữ "five"/"năm tham số" trong các ghi chép lane khác nay understated.** `docs/06:16,44-48`,
  `docs/19:157`, `docs/20:34`, `docs/28:552/566`, `docs/35:724`, `coordination/gates/contracts-v1.md:43`
  đều liệt kê 5 tên và không có sort; `tools/openapi/gen_openapi.py:36` còn quảng bá đúng `limit` +
  `cursor` cho route này (lệch có trước chu kỳ này). Đó là bàn của docs lane (Δ36 đang mở cùng họ), tôi
  **không sửa ledger của lane khác**.
- **Δ56 — Ba lỗi của chính tôi trong lúc làm, tự ghi để không tái phạm.** (1) Test tích hai array tôi viết
  theo thứ tự alphabet trong khi code sinh theo thứ tự field array → đỏ 1 test, sửa kỳ vọng thành đúng
  nguồn dẫn. (2) Test tiebreak tôi đoán nhầm đầu nào là "mới nhất" trong fixture → đỏ 1 test, sửa bằng
  cách đọc property trực tiếp. (3) Nghiêm trọng nhất: chèn test qua template literal làm **6 regex mất
  dấu backslash** (`\w`→`w`, `\$`→`$`, `\(`→`(`). Không đỏ compile, chỉ im lặng nhận diện SQL sai —
  `/^SELECT * FROM/` khớp gần như mọi thứ, tức fake db sẽ "xanh" mà không kiểm gì. Đã phát hiện bằng
  scan chủ ý, sửa cả 6, và từ đó dựng fragment bằng chuỗi đơn để backslash không bị ăn.

---

## 15 — CYCLE 15: W-ADMUX02-SORT-CURSOR-BIND-1 — buộc `sort` vào keyset cursor của `GET /api/v1/operations` (T140-A1)

### 15.0 Phán quyết đang thực thi

T140-A1 (`coordination/reports/review.md:847`) chính là **Δ52 tôi xin phán quyết ở Mục 14**: cursor
chỉ mang `<ISO>|<uuid>[|p]`, nên một vị trí của `created_at` phát được thành biên của `deadline_at`.
Reviewer đưa hai lựa chọn (reset cursor ở mọi nơi, hoặc **version/bind token và từ chối lệch**); packet
này chọn phương án bind token. Gate note `review.md:854` giữ `G-ADMIN-OPS` NO-GO và đòi finding này
được xử trước khi chạy browser C1–C5.

### 15.1 Grammar mới, và vì sao legacy token vẫn đọc được

- Payload: `<canonical ISO>|<uuid>|<field>:<direction>[|p]` — vị trí **cộng thêm** thứ tự mà nó là vị
  trí trong đó. Encoder luôn phát slot (kể cả default `created_at:desc`), nên một token do code này sinh
  ra không bao giờ mơ hồ.
- Decoder chấp nhận hình thái cũ: `<ISO>|<uuid>` và `<ISO>|<uuid>|p` **không có** slot thứ tự ⇒ đọc thành
  `created_at:desc`. Lý do duy nhất: đó là thứ tự **duy nhất** mà một token tiền-sort có thể từng mang.
  Hai hình thái không nhầm được nhau vì `p` không phải `field:direction` hợp lệ, nên marker đi trước là
  một part riêng chứ không phải suffix của part khác.
- Slot được parse bằng **đúng** `parseOperationsListSort()` của contracts (trim + lowercase), tức decoder
  không tự chế một quy tắc chuẩn hoá thứ hai.
- Ký tự tối đa đo bằng node: `…|deadline_at:desc|p` = **107** < `LIST_CURSOR_MAX_LEN` = 128. Đây là ràng
  buộc **wire-visible**, không phải chuyện thẩm mỹ: `OperationsListPageSchema` cap `nextCursor`/`prevCursor`
  ở 128, và admin shell **cắt** (`slice(0, 128)`) chứ không từ chối một cursor dài hơn ⇒ vượt bound là
  round-trip hỏng im lặng. Có test khoá cả sáu sort × hai chiều.

### 15.2 Policy: từ chối, không phải làm ngơ

Lệch thứ tự = **422 trước mọi query**, message nêu luôn cách thoát:
`cursor was issued for sort=created_at:desc and cannot page sort=deadline_at:desc; drop the cursor
parameter to start this ordering at its first page`. Không im lặng bỏ cursor vì caller gửi cursor là
caller đang xin **đi tiếp**; trả về trang 1 của thứ tự mới thì đọc như một vòng lặp, không phải như một
lỗi. Bỏ `?sort=` **không** phải đường lách: absent sort resolve về `created_at:desc` và vẫn bị từ chối
như mọi sort khác — có test riêng cho đúng điểm đó.

### 15.3 Phát hiện kèm theo: statement từng **không parse được** khi có cursor mà không có filter

Viết test tương thích cho 15.1 lộ ra một lỗi có trước chu kỳ này, nằm ngay trong statement mà packet bắt
sửa: filters và cursor predicate được nối dạng `SELECT * FROM operations` + ` WHERE …` + ` AND (…)`.
Hình đó chỉ hợp lệ **khi có ít nhất một filter**. Không filter + có cursor cho ra
`SELECT * FROM operations AND (created_at, id) < ($1::timestamptz, $2::uuid) ORDER BY …` — Postgres báo
syntax error. Đường trigger là chuyện thường nhất trong pane: **admin cross-tenant (không có
`tenant_id` clause), bấm Next trên list không lọc** — tức trang ≥ 2. api-keys và audit không dính vì hai
caller của `keysetPage()` luôn seed `tenant_id = $1` (`server.ts:2816`, `:2934`), nên cùng hình thái đó
hôm nay **bất khả thi** — tôi ghi là fragility note, **không sửa** (Δ59).

Sửa: `bindOperationsCursor` trả predicate **trần** (hoặc `null`), và `whereClause([...filters, predicate])`
là chỗ duy nhất biết còn nợ chữ `WHERE` hay không. Count vẫn dùng `filtersWhere` (cursor không được đổi
`total`). **Số thứ tự placeholder không đổi** — predicate vẫn push sau filter và sentinel — nên các pin
`$1/$2/$3` cũ còn nguyên; test mới so **cả mảng params**, không chỉ một fragment.

### 15.4 Test

File mới `services/orchestrator/tests/operations-list-cursor-sort-binding.test.ts`, **54 test / 5
describe**, chạy route thật với fake db ghi âm (offline: không PG, không Redis, không socket): token phát
ra tự khai thứ tự (6/6), key biên đổi theo sort, hai cursor của cùng một trang cùng slot, trục `|p` tách
khỏi trục `:asc/:desc`, mọi token nằm trong bound 128 và response vẫn thoả `OperationsListPageSchema`;
**ma trận 6×6** (chấp nhận đúng đường chéo, 30 ô còn lại là 422 và `calls` rỗng); đúng ca reviewer nêu;
không lách bằng cách bỏ `?sort=`; message nêu hai thứ tự + remedy và không echo token; **oracle định
lượng** cái giá của lỗi (boundary `created_at` 2026-09-25 đặt vào thứ tự `deadline_at` cho 0 dòng trên
tổng số 2 dòng chưa liệt kê — mất cả trang sau một 200 đẹp đẽ) kèm assertion rằng route không hề dựng
câu lệnh đó; tương thích legacy (2 ca chấp nhận + it.each mà 5 sort còn lại phải từ chối); 7 tổ hợp filter
× cursor cho ra statement mà database parse được; 14 payload slot hỏng + bound dài; và scope (filter đổi
tự do dưới cursor, `limit` đổi tự do, slot được chuẩn hoá y như query param).

Sửa 1 regex trong harness của Mục 14 (Δ60): `execute()` giờ chấp nhận cả ` WHERE ` lẫn ` AND ` introducer
**và fail loudly** khi trong SQL có boundary mà nó đọc không ra — thay vì im lặng trả cả population rồi
để test chết bằng thông báo "the walk never ended". Chính cái bẫy im lặng đó là lý do lỗi 15.3 sống được
đến hôm nay.

### 15.5 Đột biến (ba lần; mỗi lần restore kiểm bằng đếm chuỗi trong source)

| Đột biến | Kết quả | Đọc được gì |
|---|---|---|
| M1 guard `\|\|` → `&&` (nửa lock) | **14 đỏ** / 162 | Cả **hai suite Mục 14 vẫn xanh nguyên vẹn** — đúng luận điểm của T140-A1: test cũ chỉ đi đúng *trong* từng sort, không thấy replay chéo sort. |
| M2 decoder bỏ slot, luôn default | **22 đỏ** / 162 | 14 đỏ mới + **8 walk của Mục 14**: binding load-bearing cả hai chiều; token không tự khai thì paging theo sort hỏng. |
| M3 revert fold WHERE | **7 đỏ** / 162 | In lại nguyên văn `SELECT * FROM operations AND (created_at, id) < …` — bằng chứng lỗi 15.3 là thật, không suy diễn. |
| Restore | 162/162 exit 0, `tsc` exit 0 | 9 phép đếm chuỗi: BAD=0. |

### 15.6 Bằng chứng offline (mã exit lấy từ dòng `Exit Code:` của wrapper, không phải `%ErrorLevel%`)

- `pnpm --filter @du/contracts build` — exit 0. Không đổi source contracts; build để chắc chắn symbol mà
  route vừa import (`formatOperationsListSort`) có thật trong `dist` mà orchestrator tiêu thụ.
- `pnpm --filter @du/contracts test` — **385/385, 17 suites, exit 0** ×3 (khớp con số packet ghi).
- Bộ operations-list của orchestrator (`operations-list-cursor-sort-binding` +
  `operations-list-contract-conformance` + `admin-operations-list-pagination`) — **162/162 exit 0** ×3.
- `npx tsc --noEmit -p tsconfig.json` — exit 0 ×3.
- Hồi quy phía tiêu dùng route (`admin-shell-server`, `admin-shell-render`,
  `admin-shell-platform-mount`, `admin-operation-view-model`, `br12-isolation-offline`, cộng 4 suite
  live-gated): **321 passed / 123 skipped, exit 0**. Bốn suite skip (`admin-action-rbac-live`,
  `runtime`, `operation-tenant-fence`, `artifact-grant-fencing`) skip vì `DU_LIVE_INFRA` —
  **skip không phải pass**.
- Full offline sweep: **66 suites xanh / 17 suites skip / 1 suite đỏ (4 test)**,
  `1625 passed / 209 skipped / 1838 total`. Suite đỏ là
  `connector-revision-http-offline.functional` (VAULT-06), chạy **đơn lẻ vẫn đỏ y như vậy** (4/8 đỏ);
  root cause tĩnh: fixture seed `tenantId: ''` (`:122`) nên `ConnectorRevisionBindingSchema.safeParse`
  fail tại `workflow.ts:160-166` → 403 **trước cả hop HTTP**. Không liên quan operations list; đã được
  ghi là "không thuộc lane" ở Mục 12 (`qwen-admin.md:1451`) và bởi Platform lane
  (`qwen-platform.md:378`); RESUME POINT cũng đã có mục môi trường này từ trước. **Tôi không sửa hồ sơ
  lane khác và không tự nhận đã đóng nó.**

### 15.7 Consumer bị ảnh hưởng

- **Admin shell** (`/admin/operations`): fetcher chỉ gửi `limit/cursor/state/tenant/id` (không gửi `sort`),
  nên mọi cursor của shell là default-order và vẫn hợp lệ. Shell **không decode** cursor — nó cắt theo
  bound 128 rồi echo lại — nên điều duy nhất shell phải giữ là bound đó, đã khoá bằng test.
- **API key path**: cùng một route, cùng codec; không có consumer nào khác gọi
  `encode/decodeOperationsListCursor` (18 điểm chạm trong `src` đều thuộc route này).
- **UI tương lai (ADM-UX-03)**: control sort **buộc phải bỏ `cursor`** khi đổi sort. Nếu UI giữ cursor cũ,
  người dùng gặp 422 — đúng theo thiết kế fail-closed. Ghi vào task row để việc đó không thành bug bất
  ngờ khi làm UI.
- **Docs lane (Δ64)**: `docs/19-traceability-audit-matrix.md:155` đang mô tả đúng grammar cũ — *"the
  base64url payload is `<ISO>|<uuid>` with a trailing `|p`"* — và
  `docs/admin-ops-monitoring-cost.md:21` vẫn nói list "không có cursor/filter/sort server-side". Câu
  thay thế đề xuất (để phần còn lại chỉ là one-line): *the base64url payload is
  `<ISO>|<uuid>|<field>:<direction>`, with a trailing `|p` marking a backward walk; a token minted before
  `sort` existed omits the ordering slot and is read as `created_at:desc`, and a cursor whose ordering
  slot differs from the requested `sort` is a 422.*

### 15.8 Bốn mức, và những gì chu kỳ này **không** claim

- T140-A1 ở route operations = **IMPLEMENTED + VERIFIED-OFFLINE**. Chưa phải VERIFIED toàn phần: bằng
  chứng keyset live (`T-CODEX-TEST-20`) là của **hình thái cursor cũ**; replay chéo sort và bound mới chưa
  có lần chạy live nào. Reviewer đòi "a cross-sort negative **plus live keyset test** before accepting
  ADM-UX-02" — vế đầu có ở đây, vế sau cần Tester + DB window.
- **Không tick `[x]`, không đụng `G-ADMIN-OPS`**: ADM-UX-02 vẫn `[~]`, ADM-UX-03 vẫn `[ ]`, gate vẫn NO-GO.
  Δ52 **đóng ở mức code + offline**; phần phán quyết còn lại là live keyset evidence.
- Không mở DB/Redis/S3, không commit, không push.

---

## Δ-DEVIATION Mục 15

- **Δ57 — Packet dùng một mã lỗi không tồn tại.** `INVALID_CURSOR`: `grep` toàn `du-rework` cho **1 match,
  và match đó nằm trong `coordination/scripts/dispatch-turn143.ps1:39`** — tức chính văn bản packet của
  lệnh này, không phải source. Vocabulary 422 của route là `INVALID_SCHEMA` (`src/http/errors.ts`,
  `contracts/src/errors.ts`, `docs/06-public-api.md:44-48`). Tôi dùng `INVALID_SCHEMA` cho cả cursor hỏng
  định dạng lẫn cursor lệch thứ tự, phân biệt bằng message. Đây là **Δ50 lặp lại đúng một bậc**: nếu
  coordinator muốn mã riêng thì đó là thay đổi wire-visible (contracts + docs + OpenAPI probe +
  `probe_cases.js`), không phải việc lane này tự quyết trong packet sort.
- **Δ58 — Sửa ngoài hai bước packet liệt kê, vì packet tự mâu thuẫn nếu không sửa.** Packet đòi "bảo đảm
  backward compatibility cho các cursor default (`created_at:desc`)". Không làm được nếu giữ cách nối SQL
  cũ: cursor default + admin cross-tenant không filter từng là **câu lệnh hỏng cú pháp** (15.3). Nên tôi
  sửa composition của `listOperationsPage`. Lỗi này **có trước**, không do packet gây ra, nhưng nằm đúng
  trong statement packet bắt động vào.
- **Δ59 — Không sửa `keysetPage()` (audit + api-keys) dù nó mang cùng hình thái nối SQL.** Hai caller đều
  seed `tenant_id = $1` (`server.ts:2816`, `:2934`) ⇒ nhánh "predicate mà không có WHERE" bất khả thi hôm
  nay. Sửa nó là mở sang hai route + hai suite ngoài packet, và sẽ tạo cảm giác đã kiểm một thứ chưa có
  evidence cho nhu cầu. Đề xuất: hoặc giao một packet phòng-thủ-nội (chuyển sang cùng pattern
  `whereClause`), hoặc để nguyên kèm ghi chú rằng caller thứ ba **không được** để `clauses` rỗng.
- **Δ60 — Sửa 1 regex trong harness của Mục 14** (`admin-operations-list-pagination.test.ts:1767`).
  Bắt buộc vì production SQL đổi hình; 88 assertion còn lại của 89 test đó giữ nguyên. Có thêm hành vi
  fail loudly khi boundary không đọc được (15.4) — nếu không, harness lại im lặng xanh.
- **Δ61 — `packages/contracts` không đổi một dòng nào** trong chu kỳ này. Packet ghi lệnh contracts test
  như một kiểm chứng (385/385) — chạy và xanh ×3, nhưng đó là **hồi quy**, không phải bằng chứng của hợp
  đồng mới. Đừng tính nó vào work item ADM-UX-02 như thể có thay đổi wire nào ở contracts.
- **Δ62 — Cursor vẫn không ràng buộc với filter/tenant/limit**, chỉ với ordering. Reviewer chỉ đòi ordering;
  và một position áp lên population khác nhau vẫn hợp lệ về nghĩa (đó là lý do `total` đổi còn biên thì
  không). Có test khoá chiều ngược lại (đổi filter dưới cursor vẫn 200) để dev sau này không "bind luôn
  cho chắc".
- **Δ63 — Token transitional từ bản build Mục 14.** Cursor do code Mục 14 sinh dưới sort khác default mang
  key của `deadline_at`/`updated_at` nhưng **không có slot** ⇒ decoder đọc thành `created_at:desc` và
  **chấp nhận** khi request là default sort. Không client nào ngoài dev tree cầm loại này (Mục 14 không
  commit, không lên dist nào, và `G-ADMIN-OPS` chưa cho live run nào trên sort). Ghi để Tester không lấy
  một token cũ còn sót trong log của lần chạy trước làm bằng chứng tương thích.
- **Δ64 — Hai dòng docs do lane khác sở hữu vừa bị chu kỳ này làm lỗi thời** (`docs/19:155` grammar cursor,
  `docs/admin-ops-monitoring-cost.md:21` "không có cursor/filter/sort") — cộng dồn với nợ cũ ở Δ55
  (`docs/06:16,44-48`, `docs/19:157`, `docs/20:34`, `docs/28:552/566`, `docs/35:724`,
  `gates/contracts-v1.md:43`, `tools/openapi/gen_openapi.py:36`). Tôi đưa câu thay thế nguyên văn ở 15.7 để
  việc của docs lane là one-line, và **không sửa hồ sơ lane khác** (tiền lệ Δ55).
- **Δ65 — Ba trở ngại của chính tôi trong chu kỳ này, tự ghi để không tái phạm.** (1) Hai lần dựng chuỗi
  trong template literal: một lần làm hỏng comment vì quote lồng, và một lần tôi viết
  `expect(x).toBe(x)` **tautology** — tự phát hiện trước khi chạy, đã xoá thay vì để nó xanh giả. (2)
  `node -e` trên cmd.exe lại chết vì quoting; phải chuyển sang `.cjs` thật (bài học đã có từ Mục 14, vẫn
  trả giá thêm một lần). (3) Một mutation tôi viết làm mất null-narrowing của TypeScript
  (`if (false && decoded.sort…)`) ⇒ **cả ba suite fail-to-compile**, đỏ vì lý do sai với giả thuyết. Sửa
  mutation thành loại giữ kiểu (`&&` thay vì `||`) để đỏ lần sau nghĩa là test bắt được behaviour, không
  phải bắt được compiler.

## 16 — CYCLE 16: W-ADMUX03-SHELL-SORT-1 — `sort` vào Admin Shell; đổi sort là reset cursor CẤU TRÚC theo T140-A1

### 16.0 Packet và nguồn đã đọc trước khi làm

- Packet `W-ADMUX03-SHELL-SORT-1` (Reviewer Turn 150, finding 4: "The Admin shell has no sort
  control and does not pass a manually entered sort through its parser/fetcher. Wire sort into
  the shell …" — câu "run C1-C5 seeded browser acceptance" cùng dòng là việc của Tester, xem
  16.7). Nối công việc Mục 15: route đã buộc cursor vào ordering và 422 lệch sort; chu kỳ này
  giao nửa shell của work order `G-ADMIN-OPS`.
- Đã đọc: `du-rework/AGENTS.md`; `review.md` Turn 150 (§Adjudication 3 về T140-A1 "shell
  behavior when sort changes"; §Release gates); `server.ts` (Mục 15, không sửa);
  `shell-router.ts`, `operation-section-renderer.ts`, `contracts/src/public-api.ts`.

### 16.1 Code đã giao (4 file nguồn + 1 file test)

1. `src/app/admin/operation-section-data.ts`
   - Import `OPERATIONS_LIST_SORT_FIELDS`, `OPERATIONS_LIST_SORT_DIRECTIONS`,
     `OPERATIONS_LIST_SORT_DEFAULT_FIELD`, `OPERATIONS_LIST_SORT_DEFAULT_DIRECTION` +
     `parseOperationsListSort()`/`formatOperationsListSort()` từ `@du/contracts` — shell và route
     dùng **đúng một quy tắc chuẩn hoá** (tinh thần T70-C1 đã đóng ở Mục 11).
   - `OperationFetcherInput.sortFilter` (token thô): sanitize tại biên; token hỏng → **drop,**
     khai báo `sort` trong `ignoredFilters`, không bao giờ vang lại vào URL/DOM; ordering hợp lệ
     NON-default → gửi `&sort=`; default canonical → **omit** (deep link cũ byte-stable, và
     "absent = created_at:desc" chính là thứ mà cursor default bị buộc theo — §15 khoá chặt
     hai vế này vào nhau).
   - `OperationListOkResult.sort` (chuỗi canonical `field:direction`) — hiệu lực trên cả ba
     đường: catalog offline, payload platform, và mặc định khi token bị từ chối.
   - Catalog offline giờ **mô phỏng ORDER BY của route**: `(key, id)` cùng chiều; NULL deadline
     **cuối danh sách ở cả hai chiều** bằng sentinel `0001-01-01T00:00:00.000Z`/`9999-12-31T23:59:59.999Z`
     như §14.2. Default giữ thứ tự fixture của W-ADMUX-01 ⇒ mọi trang offline cũ không đổi một byte.
   - Export mới: `sanitizeSortFilter()`, `OPERATION_LIST_SORT_OPTIONS` (6 cặp field×direction kèm
     giá trị canonical, dựng từ đúng hai array allowlist mà packet gọi tên),
     `OPERATION_LIST_DEFAULT_SORT`, type `OperationListSort`/`OperationListSortOption`.
2. `src/app/admin/shell-router.ts` — `?sort=` vào query state của list-pane:
   `parseOperationListQuery` đọc raw token bằng cùng `readRaw` bound 128 như bộ ba filter, truyền
   vào fetcher; `sanitizeSortFilter()` tính `listSort` canonical để echo vào back-link.
3. `src/app/admin/operation-section-renderer.ts`
   - Toolbar có `<select name="sort" id="adm-filter-sort">` sáu option nhãn người đọc ("Newest
     first" … "Deadline latest first"), selected = ordering hiệu lực. **Form GET không có field
     cursor nào** ⇒ đổi sort = reset cursor *theo cấu trúc URL*, không cần giải mã token.
   - `opsPageHref`: quy tắc mới — **link mang cursor thì buộc mang sort** (non-default; default
     là absent, và absent khớp cursor default). prev/next/page-size/chip-remove đều echo
     `f.sort`; clear-all vẫn bỏ HẾT (sort + cursor + filter + limit về 20); back-to-list từ
     detail pane mang cặp `cursor`+`sort` của trang đã rời đi.
   - Hook `data-list-sort` trên list pane cho test và browser journey.
4. `src/app/admin/index.ts` — barrel export ba symbol mới (không đổi symbol cũ).

### 16.2 Chính sách "cursor = null khi sort đổi" — ba tầng; vì sao không giải mã cursor

- Fetcher **stateless trên từng request**: shell server-render không giữ state giữa hai lần bấm
  nên không có chỗ nào để "nhận ra sort vừa đổi". Sự kiện đó sống ở tầng liên kết, và reset được
  đặt đúng đó: **tầng 1** form toolbar không phát field cursor; **tầng 2** link builder — không
  link đổi-sort nào mang cursor cũ, không link mang-cursor nào thiếu ordering của cursor; **tầng 3**
  URL tự chế lệch cặp nhận thẳng 422 của route (Mục 15) — fetcher render `kind: 'error'` kèm
  message remedy "drop the cursor parameter", **không im lặng sửa request của operator**.
- Đã cân nhắc cho shell decode slot `field:direction` trong cursor để tự bỏ cursor khi lệch —
  BÁC: grammar là route-private và công khai-opaque (§15.1); nhập bản sao vào shell là tạo
  sẵn một drift. Ghi phán quyết này ở Δ67 để coordinator adjudicate cách hiểu literal của packet.

### 16.3 Test

- `tests/admin-operations-sort-wiring.test.ts` — **47 test / 6 describe** (mới hoàn toàn, file `??`):
  quy tắc một-nguồn (6 canonical round-trip, normalize, 10 token hỏng + non-string);
  fetcher→URL (non-default đi, default omit kể cả khi gõ tường minh, rác không vào URL,
  detail path không đụng sort, **422 remedy nổi thành `kind:'error'` nguyên văn**); router parse
  `?sort=` (raw, không validate — fetcher chủ quyền validate); **round-trip href→parse→fetch ra
  đúng trang kế tiếp của cùng ordering**; toolbar (select 6 option, selected đúng, **form không
  có `name="cursor"`** = bằng chứng trực tiếp điều khoản reset của packet); pairing trên mọi
  link (next/prev/size/chip/back-to-list; default không ghi sort); catalog mirror (4 ordering
  ×thứ tự, sentinel NULL-last cả hai chiều, walk đủ 3 dòng không thiếu/trùng, filter→order→page
  đúng thứ tự server).
- Một lỗi của chính tôi trong chu kỳ: test prev-link đặt ở trang 1 (nơi prev không tồn tại) →
  1 đỏ ở run đầu; sửa thành đi bộ sang trang 2 rồi assert. Xanh từ run 2.
- Pin cũ không phải sửa: `parseOperationListQuery` `toEqual` vẫn xanh vì key mới
  `sortFilter: undefined` được Jest bỏ qua; pagination **89**, cursor-binding **54**, view-model
  **74**, shell-render **136** giữ nguyên số test.

### 16.4 Bằng chứng (offline; mọi số là của nguồn đã ship, literal `Exit Code:` của wrapper)

- `pnpm --filter @du/orchestrator exec tsc --noEmit` — **×3, Exit Code: 0**.
- `pnpm --filter @du/orchestrator test -- tests/admin-operation-view-model.test.ts` (lệnh literal
  trong packet) — **74/74, ×3, Exit Code: 0**.
- Hồi quy bộ 5 suite (sort-wiring 47 + pagination 89 + cursor-binding 54 + view-model 74 +
  shell-render 136) — **400/400, ×3, Exit Code: 0**.
- Full offline sweep orchestrator: **69 suite pass / 17 suite skipped / 0 fail**; **1695 passed /
  209 skipped**, Exit Code: 0. So sweep Mục 15 (66/17/1-đỏ): suite đỏ VAULT-06 **không còn tái
  hiện** — không phải công lane này (Δ70); +47 là suite mới của Mục 16.
- Không DB/Redis/S3 window; không commit/push.

### 16.5 Đột biến (chứng minh test có răng)

| # | Đột biến trên nguồn đã ship | Kết quả |
|---|---|---|
| M1 | `opsPageHref` không bao giờ echo sort (`&& opts.sort.length === 0`, giữ kiểu) | **5 đỏ / 131 xanh** — đúng bộ test pairing + round-trip; hai suite cũ không liên quan vẫn nguyên xanh |
| M2 | Thêm `<input type="hidden" name="cursor">` vào form toolbar (mô phỏng đúng cái bẫy T140-A1) | **1 đỏ** — đúng test structural-reset |
| M3 | Fetcher luôn gửi `sort` kể cả default | **2 đỏ** — default-omission và token-rác-không-vào-URL |
| Restore | `c16-verify.cjs` đếm chuỗi 7 kiểm tra | **BAD=0**; 400/400 xanh lại |

- Lần đầu M1 tôi viết `if (false && …)` ⇒ TS2345 giết null-narrowing ⇒ suite đỏ **vì compiler,
  không vì hành vi**; revert, dựng lại loại giữ kiểu. Tái phạm Δ65(3) — tự ghi Δ71.

### 16.6 Consumer và ghi chú worktree

- Route `server.ts` **không đổi**: shell phát `sort` canonical bằng đúng chuỗi mà slot cursor
  mang (§15), cùng parser/format nên không thể lệch nhau.
- `operations-list-conformance` / `operations-list-cursor-sort-binding` (drives route): không
  đi qua shell ⇒ không đổi hành vi; xác nhận bằng 54/54 và 19/19 trong bộ sweep.
- `admin-operations-list-pagination.test.ts` harness đi-link (`paneFor`: href→parse→fetch):
  link mặc định không phát sinh `sort` ⇒ đường cũ nguyên vẹn (89/89).
- Back-link từ detail (ADM-UX-05) giờ mang cặp `cursor`+`sort` — trở lại trang cũ **đúng thứ tự
  cũ**, không tái tạo 422 mà §15 đã thiết kế.
- **Phát hiện khi đối chiếu git:** toàn bộ `src/app/admin/` (29 file, gồm 4 file nguồn chu kỳ này)
  là **untracked** (`??`); `src/server.ts` tracked. Bốn file tôi sửa hôm nay **không có `git
  diff` làm lưới an toàn** — cùng loại rủi ro đã ghi cho test files từ các mục trước, nhưng giờ
  với cả nguồn sản phẩm. Không tự sửa chính sách ignore (Δ72).

### 16.7 Mục 16 KHÔNG tuyên bố

- Không phải live acceptance: six-sort trên PG thật, walk không thiếu/trùng khi chèn giữa trang,
  replay chéo-sort = 422 **trên server thật**, planner với hai khoá mới — tất cả còn nợ Tester
  (DB window). Phần offline mới chứng minh shell **gửi đúng** và **không tự tạo** mismatch.
- C1–C5 browser journey: không chạy (STRICT offline). Reviewer nhét chung câu "run C1-C5 seeded
  browser acceptance" vào finding 4 nhưng đó là việc Tester — lane này nộp phần code+offline.
- Không tick `[x]`, không chạm `G-ADMIN-OPS`; ADM-UX-02 vẫn `[~]`, ADM-UX-03 vẫn `[ ]`
  (control sort đã CÓ phía code — chờ browser), ADM-UX-04 vẫn `[ ]`.
- `keysetPage()` (audit/api-keys) vẫn hardcode `created_at` — sort cho hai list đó chưa làm; nợ
  docs của Δ64 không giảm dòng nào (mà tăng: docs sau này phải mô tả toolbar sort + quy tắc
  "sort links không mang cursor").

## Δ-DEVIATION Mục 16 (chờ coordinator adjudicate)

- **Δ66 — Packet gọi một file, tôi phải giao bốn.** Nhiệm vụ 1 chỉ tên
  `operation-section-data.ts`, nhưng "hỗ trợ tham số sort trong **query state của Shell**" nằm ở
  `shell-router.ts` (nơi query state được parse) và finding 4 đòi "sort control" — nằm ở
  `operation-section-renderer.ts`. Giao đủ ba + barrel `index.ts`; không tự mở rộng sang khu vực
  Admin UI khác.
- **Δ67 — "Khi sort thay đổi, reset cursor (cursor = null)" được hiện thực như reset CẤU TRÚC,
  không phải fetcher tự xoá.** Fetcher stateless không quan sát được "vừa đổi"; buộc nó biết thì
  phải decode cursor — phá opacity §15.1 và tạo bản sao grammar thứ hai. Ba tầng của 16.2 đạt
  cùng hệ quả với người dùng thật và giữ nguyên 422 liêm chính cho URL tự chế. Nếu coordinator
  muốn đúng nghĩa đen (fetcher so khớp rồi bỏ cursor), cần phán quyết lại về opacity.
- **Δ68 — Default `created_at:desc` không ghi vào URL.** Cursor default đã bị §15 buộc vào đúng
  giá-trị-absent này, nên omit vừa giữ deep link cũ byte-stable vừa khớpnghĩa cursor; ghi default
  tường minh mọi link sẽ đổi toàn bộ URL shell-render (và các pin cũ). Lệch lý thuyết duy nhất:
  ai đổi DEFAULT trong contracts thì URL hai bản build khác nhau — đó là wire migration có chủ
  đích, không phải rủi ro hằng ngày.
- **Δ69 — Catalog offline: default giữ thứ tự fixture, chỉ non-default mới sort bằng comparator.**
  Áp comparator cho cả default sẽ đổi thứ tự mọi trang offline hiện hữu theo created_at THẬT của
  fixture (nhiều fixture không viết newest-first), đỏ hàng loạt test Mục 13/14 không liên quan.
  Độ lệch gương này ghi ngay trong doc-comment để không ai tin catalog là bản sao server hoàn hảo.
- **Δ70 — Suite đỏ VAULT-06 mà sweep Mục 15 ghi nhận không còn tái hiện** (hôm nay 69 pass /
  0 fail). Không phải công lane này nên không tự nhận; đề nghị coordinator xác nhận lane nào đã
  sửa fixture để hồ sơ Mục 12/15/Platform không bị lệch khi đối chiếu sau này.
- **Δ71 — Tái phạm Δ65(3):** mutation đầu tiên của chu kỳ vẫn làm đỏ bằng TS2345 (`if (false &&
  …)` giết narrowing), phải revert–dựng-lại thành mutation giữ kiểu mới có số liệu 5/131 ở 16.5.
  Ghi lại để chu kỳ sau viết mutation **giữ kiểu ngay từ lần đầu**.
- **Δ72 — Bốn file NGUỒN SẢN PHẨM của lane đang untracked trong git** (`src/app/admin/` cả
  thư mục là `??`). Không mất gì hôm nay, nhưng "lane không commit" + "nguồn không được track"
  nghĩa là bằng chứng source chỉ tồn tại trong một worktree dùng chung. Đề nghị coordinator
  quyết (add vào index, không commit; hoặc cơ chế backup khác) — lane không tự làm.


## 17 — CYCLE 17: W-ADMUX02-IDX-SORT-0018 — keyset index cho hai khoá sort mới, migration riêng vì 0017 đã apply live

### 17.0 Packet và nguồn đã đọc trước khi làm

- Packet `W-ADMUX02-IDX-SORT-0018`: đóng mục index của **Δ53** (Mục 14) — route + shell đã
  phục vụ 6 sort từ Mục 14–16, nhưng `0017` chỉ phủ `created_at` và **đã apply live**
  (T-CODEX-TEST-20/23) ⇒ theo Δ24, sửa tại chỗ 0017 sẽ bị `migrate()` bỏ qua im lặng;
  index mới BẮT BUỘC nằm ở file 0018. Packet đưa đúng 4 câu `CREATE INDEX IF NOT EXISTS`,
  cấm `DROP INDEX`.
- Đã đọc: `migrations/0017_operations_keyset_index.sql` (tiền lệ hình thức + vì sao giữ prefix
  index cũ), `src/db/migrations.ts` (loader: regex `^\d{4}_`, duplicate-sequence throw),
  `tests/migrations-ledger-guard.test.ts` (khung pin content của Mục 7/8), `server.ts:2487-2562`
  (hình dạng ORDER BY thật của từng khoá sort), `0001_platform_v1.sql:46,52` (nullable).

### 17.1 Đã giao

1. `services/orchestrator/migrations/0018_operations_sort_keyset_indexes.sql` — đúng 4 câu
   packet, tất cả `IF NOT EXISTS`, không `DROP`, không `ALTER`:
   - `operations_tenant_updated_id_idx ON operations (tenant_id, updated_at DESC, id DESC)`
   - `operations_updated_id_idx ON operations (updated_at DESC, id DESC)`
   - `operations_tenant_deadline_id_idx ON operations (tenant_id, deadline_at DESC, id DESC)`
   - `operations_deadline_id_idx ON operations (deadline_at DESC, id DESC)`
   Header comments giải thích: vì sao là 0018 chứ không phải sửa 0017 (Δ24); hai đường truy vấn
   per key cùng kỷ luật 0017 (tenant-scoped + cross-tenant admin); và **caveat expression của
   `deadline_at`** (17.2) — caveat nằm TRONG file để bất kỳ ai đọc migration thấy câu hỏi còn
   mở, không chỉ thấy bốn dòng DDL.
2. `tests/migrations-ledger-guard.test.ts` — thêm describe
   `W-ADMUX02-IDX-SORT-0018` (+6 test, 11→17): file tồn tại + loader nhận đúng sequence 18
   (chính nó là bằng chứng duplicate-guard chạy được trên dir thật), 0017 còn nguyên; MỖI
   index pin bằng **MỘT chuỗi exact đơn** `CREATE INDEX IF NOT EXISTS <name> ON operations
   (<cols>);` — hai toMatch tách rời có thể cùng xanh khi định nghĩa hai index bị đổi chỗ cho
   nhau, một chuỗi thì không; đúng 4 statement `CREATE INDEX` trong file; cấm
   `DROP INDEX`/`ALTER TABLE`/`TRUNCATE|DELETE FROM|UPDATE operations`; và pin nội dung caveat
   (`COALESCE\(deadline_at` + `live EXPLAIN` phải còn trong file) — file không được tidy thành
   đã-settled khi evidence live còn nợ.

### 17.2 Phán quyết kỹ thuật honesty-critical (Δ73)

- `updated_at` NOT NULL (0001:52) ⇒ route ORDER BY cột **trần** `updated_at DESC, id DESC`
  (server.ts: `OPERATIONS_LIST_NULLABLE_SORT_FIELDS` chỉ chứa `deadline_at`) ⇒ index plain khớp
  pathkey trực tiếp, chiều asc đi bằng backward scan. Cặp updated_at có cơ sở kỳ vọng thật.
- `deadline_at` NULLABLE ⇒ route order `COALESCE(deadline_at, $n::timestamptz)` với sentinel
  BIND theo hướng (server.ts:2547) — thiết kế này là fix mất-dòng-NULL của Δ53-§14.2 và mình
  không được phá để chiều lòng index. B-tree plain column KHÔNG match expression pathkey ⇒
  nhiều khả năng cặp deadline **không xoá được Sort node**. Offline không có quyền khẳng định
  điều planner sẽ làm ⇒ ship đúng packet-spec, ghi thẳng caveat vào migration + pin nó bằng test,
  và để ngỏ nhánh resolve: nếu live EXPLAIN còn Sort, sửa bằng **0019 expression-form** sau,
  không sửa 0018 đã-apply. Đây là câu hỏi live-EXPLAIN thật, không phải lo-xa: §10.2 từng có
  tiền lệ planner giữ Sort node cho cùng hình query.

### 17.3 Bằng chứng (offline; literal `Exit Code:` của wrapper)

- `pnpm --filter @du/orchestrator test -- tests/migrations-ledger-guard.test.ts` — **17/17 ×3,
  mỗi lần Exit Code: 0** (cả ba round chạy trên bản ĐÃ restore sạch mutation).
- `npx tsc --noEmit -p tsconfig.json` (cwd orchestrator) — **×3 Exit Code: 0**.
- `pnpm --filter @du/orchestrator test -- tests/admin-operations-sort-wiring.test.ts` — **47/47
  ×3 Exit Code: 0** (Mục 16 hồi quy đúng chỗ packet yêu cầu).
- Full sweep ba lần: (1) **đỏ `url-ingestion-consumer-offline` 3 test** (suite lane DATA-03);
  (2) suite đó XANH, đỏ **`admin-shell-server` 1 test `connect ETIMEDOUT 127.0.0.1:44092`**
  (suite lane P6); (3) **70 pass / 17 skip / 0 fail, `1727 passed / 209 skipped`
  Exit Code: 0**. Mọi suite của lane này xanh trong CẢ BA sweep; hai suite đỏ chạy đơn lẻ đều
  xanh (url-ingestion 24/24; cặp guard+url 41/41). Red DI CHUYỂN giữa sweep ⇒ không phải code
  của lane nào; nghi ngờ contention loopback/CPU khi nhiều owner chạy song song trên chung
  máy — Δ74, khuyến nghị coordinator: một kết quả sweep đơn lẻ không được dùng làm bằng chứng
  phủ định khi targeted rerun xanh.

### 17.4 Đột biến trên file migration đã ship (theo đúng mục 2 packet)

| # | Đột biến | Kết quả |
|---|---|---|
| M1 | Xoá nguyên statement #2 (`operations_updated_id_idx`) | **2 đỏ**: exact-string của name đó + count-4; 15 xanh đúng kỳ vọng |
| M2 | `id DESC` → `id ASC` ở statement #1 | **1 đỏ**: exact-string tenant_updated; các test khác không thấy gì (vì ASC vẫn là text hợp lệ) |
| M3 | Bỏ `IF NOT EXISTS` ở statement #4 | **1 đỏ**: exact-string cross_deadline; count vẫn 4 → chứng tỏ pin idempotency và pin count là HAI răng khác nhau |
| Restore | `c17-verify.cjs` đếm chuỗi 13 kiểm tra (4 statement + 4 comment + no-DROP + no-plain-CREATE) | **BAD=0**, 17/17 xanh lại |

- Hai lỗi tự gây khi mutation và cách bắt lại (ghi vào Δ76): restore đầu tiên của M1 tôi viết
  new_string KHÔNG nguyên văn (comment paraphrase) và anchor ăn mất dòng `-- 3.` của statement
  #3; cả hai chỉ hiện ra khi **đọc lại file** — sau đó mới chạy verify đếm chuỗi. Bài học:
  restore phải chép nguyên văn từ bản đã lưu trong lệnh apply, và verify phải có mặt comment
  (c17-verify có `comment-1..4` chính vì vụ này).

### 17.5 Mục 17 KHÔNG tuyên bố

- Không có DB window: **không ai chạy 0018 thật ở chu kỳ này**. Không tuyên bố index đã tồn
  tại trong database nào; chỉ tuyên bố file đúng spec + loader nhận + pin chặn thoái hoá.
- Không tuyên bố planner sẽ chọn bất kỳ index nào (đặc biệt cặp deadline, 17.2); leg đó là
  EXPLAIN live của Tester trong window đã-CLAIM — packet sau cho họ.
- Không tick `[x]`/`G-ADMIN-OPS`; ADM-UX-02 vẫn `[~]` với đúng một gap (b)-index vừa được đóng
  một nửa (file + pin); các gap còn lại của row giữ nguyên.
- `keysetPage()` audit/api-keys vẫn không có index riêng cho sort của mình — ngoài packet này.

## Δ-DEVIATION Mục 17 (chờ coordinator adjudicate)

- **Δ73 — Hai index `deadline_at` ship theo đúng packet nhưng có vấn đề-kỹ-sự-để-trống ghi
  thẳng vào migration:** route order `COALESCE(deadline_at, $n::timestamptz)` (server.ts:2547,
  sentinel bind per hướng — thiết kế chống mất-dòng-NULL của §14.2), và plain-column index
  không match expression pathkey ⇒ khả năng cao Sort node vẫn còn cho hai sort deadline.
  Offline không được phép khẳng định thay planner; bằng chứng duy nhất là live EXPLAIN trong
  DB window. Nếu còn Sort: KHÔNG sửa 0018 sau-apply (Δ24) mà mở 0019 expression-form — hoặc
  phán quyết lại hướng sentinel-literal, cả hai đều cần decision của coordinator.
- **Δ74 — Red di-chuyển giữa các full sweep, mọi suite liên quan đều xanh khi chạy đơn lẻ;
  sweep 3 sạch hoàn toàn.** Attribution: contention máy dùng-chung (nhiều owner active cùng
  lúc), không phải code của lane nào. Đề nghị quy trình: kết luận đỏ-sweep phải kèm targeted
  rerun trước khi gán cho bất kỳ lane nào — chính §15 đã từng làm ngược lại thành công với
  VAULT-06 (đỏ ổn định, đỏ cả standalone) nên hai vụ này phân biệt được.
- **Δ75 — Mở rộng Δ72 sang migrations:** `git ls-files` xác nhận chỉ `0001` được track;
  `0002..0017` và file mới `0018` đều `??`. DDL sản phẩm không có `git diff` làm lưới an toàn
  còn nghiêm trọng hơn nguồn app/admin (một dòng mất = schema drift vĩnh viễn vì runner không
  checksum). Vẫn chờ phán quyết tracking policy, không tự `git add`.
- **Δ76 — Hai lỗi sửa-hồ-sơ của chính tôi trong chu kỳ, tự bắt:** restore M1 paraphrase comment
  (không nguyên văn) và một anchor restore ăn mất dòng `-- 3.`; cả hai lộ ra khi đọc-lại-file
  trước khi verify. Đã khôi phục nguyên văn toàn bộ; `c17-verify.cjs` được viết thêm 4 check
  comment đúng vì vụ này. Không có nội dung nào của migration-duyệt-giữa-là-khác so với bản
  gốc đã chốt ở 17.1.


## 18 — CYCLE 18: W-ADMUX02-EXPLAIN-SORT-1 — cổng live cho 0018: bar phán quyết đã viết, răng đã kiểm offline; window là của Tester

### 18.0 Packet và nguồn

- Packet `W-ADMUX02-EXPLAIN-SORT-1`, nguồn finding **MEDIUM T180-A1** (`review.md:965`):
  "new sort indexes are unproven for the route's SQL … T-33 verifies index NAMES, not
  definitions or plans … capture live EXPLAIN for tenant/cross-tenant updated_at AND
  deadline_at in both directions … If deadline sorts retain material Sort, decide a
  matching follow-on migration rather than editing applied 0018."
- Đã đọc: `tests/admin-keyset-explain.test.ts` (bản 309 dòng, 6 live test, bar backward-hop
  T-CODEX-TEST-18), `server.ts:2487-2562` (đúng expression COALESCE + sentinel mà route phát),
  migration 0018 (caveat tự ghi ở Mục 17).

### 18.1 Đã giao — CHỈ MỘT FILE TEST: `tests/admin-keyset-explain.test.ts` (6 → 17 test)

1. **Presence:** test `pg_indexes` đổi thành bản six-name EXACT-LIST (0017+0018) — không
   phải add-song-song: hai tên cũ trong một danh sách lọt-lõm sẽ xanh cả khi một tên mới
   mất; exact-list thì không (Δ77).
2. **`updated_at` (cột trần, NOT NULL) — bar như created_at đã từng đạt:**
   cross-tenant page **no Sort** + `/operations_(tenant_)?updated_id_idx/`; tenant-scoped
   no Sort + name (vẫn chấp nhận CẢ HAI index vì population một tenant — ghi rõ lý do theo
   tiền lệ Δ21 của chính file này); backward-hop theo đúng bar T-18: `Index Cond:
   (ROW(updated_at, id) > ROW(` phải có, Seq Scan cấm, Sort-bounded ≤ 4·(LIMIT+1) được phép.
3. **`deadline_at` — ba plan đúng hình route, chấm bằng BAR PHÁN QUYẾT**
   `expectDeadlinePlanUsable` (3 điều khoản, mỗi điều khoản đỏ vì một lý do được ghi
   chức-năng-hóa: Seq Scan = planner bỏ qua cặp deadline ⇒ mở nhánh 0019; thiếu tên idx =
   không được quyền gọi 0018 là used; Sort vượt cửa-sổ-bound = đúng cái "material Sort" mà
   T180-A1 bảo phải decision-follow-on, KHÔNG phải tidy 0018 đã-apply (Δ24)). Bar dùng lại
   ngưỡng rows của T-CODEX-TEST-18 (live, không bịa) — Δ78.
   Ba câu EXPLAIN phát ĐÚNG expression của route: `COALESCE(deadline_at, $k::timestamptz)`
   với sentinel DÙNG-CHUNG một placeholder cho ORDER BY và boundary (như
   `bindOperationsListSortKey`/`bindOperationsCursor`), SENTINEL_DESC cho forward-tenant và
   forward-cross, SENTINEL_ASC cho backward-hop (NULL block phải nằm cuối ở CẢ HAI hướng).
4. **Walk `updated_at`:** `walkKeyset` được tham số-hóa thành `walkByBareKey(key)` (bản
   created giữ nguyên tên hành-vi nguyên vẹn — các receipt cũ tham chiếu nó); walk
   updated_at full-tenant đối chiếu với **live count** vì test chèn-dòng-lờ chạy trước để
   lại một dòng — chọn bền-vững thay vì hardcode, coupling ghi bằng comment (Δ79).
5. **Seed enrichment:** `updated_at` phân biệt từng dòng (+1s so với created, tie-group
   giãn theo g); `deadline_at` NULL trên MỌI dòng lẻ + toàn bộ tie-group (~620 NULL/1240)
   — tương-tac sentinel cần khối NULL đại-diện, đúng lập-luận "most operations have no
   deadline" của route. Population vẫn MỘT tenant — multi-tenant là Δ21/0019-đừng-lẫn, ghi
   ở 18.4.
6. **Răng cho bar khi live-gated:** 4 test OFFLINE đưa plan-tổng-hợp vào
   `expectDeadlinePlanUsable`: SeqScan→throws, index-khác-name→throws, clean-index-scan→
   passes, bounded-Sort→passes kèm biến-thể population-Sort→throws. Bar không còn là
   code-chưa-bao-giờ-chạy khi cửa-sổ offline.

### 18.2 Kỷ luật

- Suite vẫn `DU_LIVE_INFRA=1`-gated: offline = 13 skip (live) + 4 pass (synthetic), không
  đụng DB/Redis; không CLAIM/RELEASE window; không commit/push; không sửa source sản phẩm
  nào trong chu kỳ này.
- Thiết-kế đỏ-trong-window: một red deadline bên window là **bằng chứng adjudication cho
  Δ73/T180-A1** (mở 0019 expression-form), không phải bug-of-cycle; điều đó viết thẳng vào
  doc của bar để Tester/recipients không "sửa test cho xanh".

### 18.3 Bằng chứng (cây cuối; literal `Exit Code:`)

- `npx jest tests/admin-keyset-explain.test.ts --runInBand` — **4 passed + 13 skipped ×3,
  Exit Code: 0** mỗi lần.
- Hồi quy 4-suite (guard 17 + sort-wiring 47 + pagination 89 + cursor-binding 54) —
  **207/207 ×3, Exit Code: 0**.
- `npx tsc --noEmit -p tsconfig.json` — **4 lần liên tiếp Exit Code: 0** (P5-P7 + F1).
  TRƯỚC đó tree từng đỏ TS2339 tại `src/modules/connector-credentials/workflow.ts:337`
  trong ~6 phút — mtime 16:05 khi lane đang chạy, KHÔNG phải file của lane này; không
  chạm, không revert, poll tới khi lane đó converge (Δ80). Đúng tinh thần Δ74.
- Full sweep offline: **70 suite pass / 17 skip / 0 fail; 1727 passed / 216 skipped
  (+7 skip đúng bằng số live-test mới) — Exit Code: 0**.

### 18.4 Mục 18 KHÔNG chứng minh / còn nợ

- **Không có plan-claim nào.** Không một assertion live nào được chạy ở đây — mới có
  đúng-hình-thức-của-bar; PostgreSQL chọn gì là window của Tester.
- Nửa route-level của T180-A1 — **cross-sort 422 và walk real-HTTP qua route thật** — chưa
  nằm trong packet này (file của nó là harness HTTP live, không phải EXPLAIN); vẫn nợ.
- "Representative tenants" (plural) của finding: mới đạt nửa ">1,000 rows" (1.240);
  population một tenant ⇒ hai test tenant-scoped vẫn phải chấp nhận either-index (Δ21
  cũ). Seed đa-tenant là quyết-định riêng, không nhân tiện làm trong packet EXPLAIN.
- Review còn ghi riêng: production rollout cần đánh giá write-lock của non-concurrent
  CREATE INDEX — việc của lane deploy, nằm ngoài offline.

## Δ-DEVIATION Mục 18 (chờ coordinator adjudicate)

- **Δ77 — Nâng cấp test presence thành six-name EXACT-LIST thay vì add-song-song**: hai
  toContain lọt-lõm xanh được cả khi mất một tên mới; đây là cùng bài-học "một chuỗi exact
  name↔columns" của guard 0018 áp cho presence-check. Hàng đợi đổi nếu coordinator muốn
  giữ nguyên văn test cũ.
- **Δ78 — Ngưỡng "material Sort" = `rows > 4·(PAGE_LIMIT+1)` kế-thừa từ chính bằng-chứng
  T-CODEX-TEST-18** (quicksort 63 dòng của window ~63), không phải số tự-niên. Nếu
  coordinator muốn bar khác (vd. nghiêm-cấm MỌI Sort cho forward), chỉ-sửa
  `expectDeadlinePlanUsable` + 4 synthetic-test, không đụng 13 case live.
- **Δ79 — Walk updated_at đối-chiếu live-count thay vì hằng-số 1240** vì test
  chèn-dòng-trong-page-chạy-trước để lại đúng một dòng; hằng-số sẽ buộc hoặc tách-describe
  hoặc reseed — cả hai che cái coupling thật. Đã ghi coupling vào comment của test.
- **Δ80 — tsc đỏ vì edit-đang-chạy của lane khác (workflow.ts:337, mtime 16:05) đúng giữa
  chu-kỳ này**: lane này không chạm file đó, không tự ý chạy lint giúp, poll converge rồi
  mới chốt 4×exit-0. Ghi kèm mtime để coordinator audit trùng-tai nếu cần.
- **Δ81 — Lỗi tự gây, tự bắt, sửa công khai:** khi refactor `walkKeyset`, một lệnh edit
  mang tính THĂM DÒ (probe) đã bị gọi bằng `await tools.edit(...)` thật và chạy:
  old_string chỉ 6 dòng đầu hàm cũ nhưng new_string là nguyên khối hàm mới ⇒ thân cũ thừa
  19 dòng phía sau file. Phát hiện không phải nhờ compile: lần edit THẬT kế tiếp FAIL
  "0 occurrences" (vì anchor đã bị ăn mất một nửa) — đọc lại vùng đó mới thấy đuôi thừa.
  Repair nguyên văn (xóa đuôi, khôi phục wrapper + doc dùng-chung), xác nhận bằng
  ts-jest run (13 skip, exit 0) rồi mới viết tiếp test. Bài học thường-trực: probe luôn
  tính bằng indexOf trong node/script tạm, không bao giờ đứng lẫn với edit ứng viên.


## 19 — CYCLE 19: W-ADMUX02-CROSS-SORT-422-1 — 422 chéo-sort và walk 6 sort giờ có harness HTTP loopback (offline)

### 19.0 Packet và nguồn

- Packet `W-ADMUX02-CROSS-SORT-422-1`, nguồn: finding 4 Turn 150 + **T180-A1**
  (`review.md:965`, owner-line Admin/Tester: "assert page continuity and cross-sort 422
  against real routes"). Chế độ packet ép buộc: OFFLINE, chạy qua `createAdminShellServer`
  / loopback / synthetic catalog — tức bản giao thức wire được chứng minh bằng socket thật
  mà không cần DB window; phần live thật vẫn còn nguyên (19.4).
- Đã đọc: `review.md` Turn 180, `server.ts` (guard 2395, boundary 2593, listener problem+json
  519-525), `http/errors.ts` (HttpError.toProblem), `shell-server.ts` (options/handle),
  `admin-shell-server.test.ts` (pattern login-cookie + QUIET-PORT), suites Mục 15/16/18.

### 19.1 Đã giao — MỘT file mới: `tests/admin-operations-sort-http-offline.test.ts` (32 test, 2 tầng)

**Tầng A — handler THẬT (`route()` qua `node:http` loopback).** db fake là interpreter của
hình SQL đã pin ở §15 (WHERE-folded boundary, sentinel dùng-chung-placeholder, LIMIT+1,
count tách riêng); boundary HTTP mô phỏng ĐÚNG server.ts:519-525 (`isHttpError` →
`toProblem()` → `application/problem+json`). Cursor đem thử là **token do route tự mint bằng
chính handler thật**, không hand-built:
- 5 cặp cross-sort (mint ở sort này, replay sort khác) → **422 problem+json trên wire**: code
  `INVALID_SCHEMA`, status 422, title chứa CẢ HAI ordering + "drop the cursor parameter",
  và `pageQueries()` không tăng — từ chối trước mọi query, đúng cam kết §15, giờ kiểm được
  bằng socket;
- bỏ `?sort=` không phải đường lách (cursor created_at:asc gặp default created_at:desc → 422);
- legacy 2-slot: default sort → 200 window đúng; bật sort non-default → 422; legacy `|p` →
  prev-window đúng `[b2,b1]` (kể cả hàng tie-border phía sau cursor — phát hiện của chính
  test khi expectation cũ thiếu b1, 19.2);
- over-128 → 422 `INVALID_SCHEMA` với **zero SELECT**; sort rác → lỗi sort TRƯỚC lỗi cursor
  (msg `sort must be one of ...`, không chứa remedy cursor);
- 6 walk it.each theo oracle độc lập: mỗi hop 200 + `OperationsListPageSchema.safeParse` +
  slot token == sort yêu cầu; tenant-scoped walk A không bao giờ hở id B; cursor mint trong
  A replay scoped-B = window B sạch.

**Tầng B — shell THẬT (`createAdminShellServer`) trên loopback, login POST → cookie
`du_admin`, chống một SYNTHETIC platform cài đúng wire-policy §15** (grammar, bind-422 cùng
remedy-text, sentinel-order, bound 128, bearer check, 404 guard ngoài `/api/v1/operations`):
- B1 pane theo sort thật trên wire (`data-list-sort`, thứ tự row = oracle, option selected);
- B2 walk CẢ 6 sort bằng cách đi theo `href` Next thật của pane — link mang cursor luôn kèm
  sort non-default, và platform KHÔNG nhận bất kỳ 422 nào trong walk đúng chuẩn;
- B3 URL tự chế cross-sort → pane báo **lỗi thành thật chứa remedy**, không render danh sách
  sai thứ tự (paneIds rỗng) — điều khoản "shell behavior when sort changes" của T140-A1 giờ
  xem được bằng socket;
- B4 form toolbar ở trang 2 vẫn không có field cursor (structural-reset trên wire);
- B5 tenancy: scoped tenant=A chỉ hiện hàng A; default hiện cả hai; token rác bị drop,
  có chip 'ignored (invalid characters)', và **không vang lại token**; 
- B6 cursor 250 ký tự: platform nhận đúng **128** (xác nhận shell CẮT, không reject —
  chính sách cắt vẫn còn là gót-nhạy-đỏ-Δ ghi ở §15.2, giờ có test pin hành-vi cuối:
  token cụt → decode fail phía platform → error pane, không bao giờ im-lặng đi sai trang).

### 19.2 Ba sự thật máy-móc/wire mà chu kỳ này mới lộ (tự bắt, tự sửa)

1. **`listen(0)` + loopback connect trên máy này HANG/ETIMEDOUT** (ephemeral destination
   filter của Windows) — đó là lý do suite admin-shell-server pin base-port tĩnh, và giải
   thích HẬU-THUẦN cho các đỏ-di-chuyển Δ74 (Δ82). Cả hai harness chu kỳ này pin port tĩnh.
2. **Problem+json mang message trong `title`, KHÔNG có key `detail`** cho mọi kênh
   INVALID_SCHEMA của route (Δ83). Assertion drafted từ §15 (nơi test đọc `e.message`
   in-process) đã bắt buộc probe riêng để chụp shape thật rồi mới chốt. Docs lane ghi
   wire-format nhớ dùng `title`.
3. **B-dependent-on-synthetic**: đỏ/xanh tầng B nói về SHELL↔chính-sách-wire, không phải
   binding của route thật — tầng A mới là handler thật. Phân ranh này ghi thẳng vào header
   file để không ai đọc over-claim (Δ84).

### 19.3 Bằng chứng (cây cuối; literal `Exit Code:`)

- `npx jest tests/admin-operations-sort-http-offline.test.ts --runInBand` — **32/32 ×3,
  Exit Code: 0** (mọi lần chạy thật HTTP loopback; không DB, không Redis).
- Hồi quy REG 5-suite (guard 17 + sort-wiring 47 + pagination 89 + cursor-binding 54 +
  shell-render 136) — **343/343 ×3 Exit Code: 0**.
- `npx tsc --noEmit -p tsconfig.json` — **×3 Exit Code: 0**.
- Full sweep offline: **73 pass / 16 skip / 0 fail; 1785 passed / 216 skipped
  Exit Code: 0** (suite explain nay CÓ test chạy offline nên không còn đếm là skipped-suite
  — 17→16 skip là hệ quả đúng của Mục 18, không phải ai bỏ gate).
- **Đột biến M-A** trên nguồn thật (`server.ts:2395` guard tự-vi phạm kiểu giữ nguyên,
  `field !== field`): **đúng 7 đỏ = nguyên bộ 422-replay**, còn 25 xanh (walk/legacy/tầng B
  không phụ thuộc guard) — phổ đỏ-jobs-phổ-xanh khớp thiết kế từng tầng; restore sạch
  (grep mutant = 0, 32/32 lại).
- Self-corrected trong quá trình build (Δ85): (i) interpreter group-index bug — đọc `order[3]`
  (chiều id) thay vì `order[4]` (LIMIT placeholder) → 24 đỏ đầu tiên, bắt bằng unit-probe gọi
  thẳng `opsQuery` với đúng SQL thật thay vì đoán; (ii) expectation prev-window thiếu b1 —
  chính hành vi ĐÚNG của route dạy lại test; (iii) port-0 hang — xem 19.2(1).

### 19.4 Mục 19 KHÔNG chứng minh

- Không phải T140-A1/T180-A1 live closure: chưa có PG thật, chưa có multi-tenant population
  lớn, chưa EXPLAIN; A dùng interpreter-fake — nó chứng minh HANDLER + BOUNDARY + CODEC
  đúng trên wire, không chứng minh planner.
- Tầng B dùng synthetic platform — hành vi 422/sentinel/token của nó LÀ GIỐNG §15 theo
  thiết-kế-của-test, không phải bằng-chứng route (route do tầng A gánh).
- audit/api-keys sort, docs debt, browser C1–C5: không đổi.

## Δ-DEVIATION Mục 19 (chờ coordinator adjudicate)

- **Δ82 — Máy này lọc destination-port ephemeral**: `listen(0)` rồi connect loopback có thể
  HANG vô hạn (không phải fail nhanh). Mọi harness socket mới của lane đều pin base-port
  tĩnh từ nay; khuyến nghị ghi vào testing-notes chung — đây nhiều khả năng là root cause
  thật của các đỏ-di-chuyển mà Δ74 mới mô-tả triệu-chứng (admin-shell-server ETIMEDOUT
  127.0.0.1:44092 đúng là port ephemeral).
- **Δ83 — `title` mới là key chứa message** trên problem+json của route (type
  `urn:du:error:invalid_schema`); key `detail` không tồn tại trong payload thật. Nhận định
  này chỉ có được vì chu kỳ này nâng lên tầng HTTP — in-process không bao giờ thấy. Đề nghị
  docs lane (nợ Δ64) ghi đúng khi mô tả error wire-format; receipt §15 cũng KHÔNG nên sửa
  retrospective (message in-process qua e.message vẫn đúng ở tầng đó).
- **Δ84 — Phân ranh bằng-chứng của suite ghi thẳng vào header file**: tầng A = route thật,
  tầng B = shell thật + platform giả theo §15. Một đỏ tầng B có thể là policy của synthetic
  lệch route; một xanh toàn bộ 19 CHƯA phải bằng-chứng PostgreSQL. Tránh over-claim khi
  recipient đọc số 32/32.
- **Δ85 — Ba lỗi test-của-tôi mà harness bắt trước khi cho suite xanh** (group-index, prev
  window expectation, port assumption). Bài học đã về memory: interpreter-harness cũng là
  code — probe nó độc lập với SQL THẬT do chính handler ghi log ra, đừng debug bằng cách
  đọc lại test source.
- **Δ86 — Không sửa production source trong chu kỳ này** (toàn bộ là test mới); M-A chạm
  `server.ts` đúng một dòng guard và đã restore, xác minh grep=0 + 32/32 — nêu rõ vì lane
  thường không được đụng route ngoài packet.


---


## 20 — CYCLE 20: W-ADMUX02-0019-LITERAL-HARNESS-1 — 3 harness fake-DB theo sentinel literal của 0019 (14 đỏ → 0)

### 20.0 Packet và nguồn đỏ
- task_892296fa9542 / dispatch ctx_718d23f32fb5: căn chỉnh regex/parser trong BA test file
  (`admin-operations-list-pagination`, `admin-operations-sort-http-offline`,
  `operations-list-contract-conformance`) để chấp nhận inline literal timestamptz thay dạng tham số;
  giải quyết 14 test failure. Packet nhãn "(Delta 29)" — xem Δ87.
- **Vì sao đỏ (không phải lane gây):** production `server.ts` (lane khác, W-INGEST-0019-1/2,
  mtime 27/09 10:48) đổi `bindOperationsListSortKey` từ `COALESCE(deadline_at, $n::timestamptz)`
  sang `COALESCE(deadline_at, '<sentinel>'::timestamptz)` — 0019 index đúng biểu thức literal đó
  và planner match bằng Const, Param binds cùng instant vẫn ra Sort (T-35 falsification, ghi ngay
  trong header 0019). Ba harness pin hình cũ ⇒ run 1 đo **14 failed / 126 passed / 140** — khớp
  từng con số packet (pagination 5, conformance 2, http-offline 7).

### 20.1 Đã giao (chỉ test; production diff của lane = 0)
1. `admin-operations-list-pagination.test.ts` — `execute()`: nhánh coalesce parse
  `/^COALESCE\((\w+), '([^']*)'::timestamptz\)$/` → `nullBound` lấy từ literal; **dạng `$n`
  cũ nay throw** "regressed to the bound-parameter form" — interpreter nhất quyết không
  page-truthfully cho chính hình mà 0019 được viết ra để giết.
2. `operations-list-contract-conformance.test.ts` — `ORDER_BY_BY_SORT` pin 2 fragment deadline
  byte-exact với **đúng literal theo chiều** (desc→0001, asc→9999; hoán đổi là `toBe` đỏ); test cũ
  "the NULL sentinel … is bound, not interpolated" được **đảo cực có chủ đích** thành "is the 0019
  inline literal, not a bound parameter": sql chứa literal, params KHÔNG chứa sentinel, và không còn
  `$n` nào sống giữa ORDER BY và LIMIT (capture `/ORDER BY (.+?) LIMIT/` + `not.toMatch(/\$\d/)`).
3. `admin-operations-sort-http-offline.test.ts` — `BOUNDARY_RE` nay đọc
  `COALESCE(deadline_at, '…'::timestamptz)` trong boundary tuple; sentinel extract từ literal +
  **kiểm tra với chiều walk** (ASC⇒9999, DESC⇒0001, sai là throw); HAI guard mới mà file này chưa
  từng có (mirror harness §15): (i) SQL có `, id) <(` / `, id) >(` mà regex không đọc được boundary
  ⇒ throw, vì im-lặng = walk vô hạn thay vì báo hình hỏng; (ii) boundary key ≠ ORDER BY key ⇒ throw
  (ordering-by-một-expression-so-sánh-một-expression-khác là công thức skip dòng). Header interpreter
  cập nhật: params dày là `filters->key->id->limit`, sentinel hết consume placeholder.

### 20.2 Định nghĩa win/lose từng test (bất biến)
- Walk/oracle của cả ba suite vẫn là tính toán JS ĐỘC LẬP trên fixture; chu kỳ này chỉ sửa tầng
  ĐỌC SQL của fake db — không một con số expectation nào bị nới. Hai test conformance đổi vì chính
  hợp đồng ĐÃ đổi (packet ủy quyền căn chỉnh pin; không phải lane tự nới để cho xanh).

### 20.3 Bằng chứng (cây cuối; literal `Exit Code:`)
- Repro trước sửa: `npx jest --runInBand` 3 file → marker `RUN1_NONZERO`, jest in
  `Tests: 14 failed, 126 passed, 140 total`.
- Sau sửa: cùng lệnh **140/140 ×3** — `RUN1_EXIT_0` / `RUN2_EXIT_0` / `RUN3_EXIT_0`, wrapper
  `Exit Code: 0` cả ba lần.
- `npx tsc --noEmit -p tsconfig.json` → `TSC_A_EXIT_0`, Exit Code: 0 (tsconfig phủ src; tests do
  ts-jest compile ngay trong jest — exit 0 ở dòng trên là bằng-chứng tests biên dịch).
- **Probe regex độc lập** (%TEMP%\admin0019-probe.cjs, ngoài repo, đã xoá): 7/7 PASS, `PROBE_EXIT_0` —
  literal parse được, `$n`-form rơi đúng nhánh regression-throw, boundary-literal capture == ORDER BY
  key, boundary không đọc được thì throw. Đột biến source KHÔNG chạy: `server.ts` đang lane khác sửa
  trong hôm nay (tiền lệ Δ80 — không chạm file đang-chạy); răng của guard do probe + phổ đỏ run-1 gánh.
- Full sweep offline `jest.unit.config.cjs`: marker `UNIT_NONZERO`; **73 pass / 1 skipped suite /
  1 failed — 1788 passed / 28 skipped / 1817 total**. Đỏ duy nhất:
  `connector-revision-http-offline.functional` (VAULT-06, KHÔNG thuộc lane) — rerun standalone vẫn đỏ
  (`VAULT_NONZERO`, 7P/1F) ⇒ không phải contention sweep (quy trình Δ74 đã chạy đủ bước).

### 20.4 Mục 20 KHÔNG chứng minh
- Không chứng minh 0019 được planner chọn hay Sort đã hết — đó là live EXPLAIN (Tester window), và
  harness live của nó còn pin hình CŨ (Δ88). Interpreter-fake chỉ đọc shape, không đọc plan.
- Không đóng thêm mục task board nào: ADM-UX-02 vẫn [~], ADM-UX-03 vẫn [ ], **G-ADMIN-OPS giữ NO-GO**.
- Ghi chú cho docs/A-series: bullet RESUME POINT mới + section 20 làm inbound `qwen-admin.md#L…` phía
  dưới dòng ~91 lệch +N dòng — repoint theo NỘI DUNG như mọi cycle (BROKEN=0 không chứng minh anchor đúng).

## Δ-DEVIATION Mục 20 (chờ coordinator adjudicate)
- **Δ87 — nhãn packet "(Delta 29)" xung đột ledger** (Δ29 đã tồn tại ở Mục 10, status-sync). Nội dung
  packet ĐÚNG từng con số (đo 14 đỏ = 14); delta của cycle này đánh tiếp từ Δ87+. Phía packet chỉ lệch
  nhãn, không có gì phải sửa nội dung.
- **Δ88 — harness live §18 giờ mô phỏng hình chết:** `admin-keyset-explain.test.ts:447-478` vẫn EXPLAIN
  `COALESCE(deadline_at, $k::timestamptz)` và comment tự xưng "the EXACT expression shape of the route" —
  SAI từ W-INGEST-0019-2. Tester chạy window nguyên văn hôm nay sẽ certify đúng hình T-35 đã bác và
  không bao giờ thấy 4 index 0019 được chọn. Ngoài scope 3-file của packet này ⇒ xin packet follow-on
  (3 chuỗi SQL + comment cho hình literal; kiểm pg_indexes sau apply nên thấy tên
  `operations_*_deadline_coalesce_*_id_idx`).
- **Δ89 — hai sentinel literal không có một nguồn:** nay sống 4 nơi — `server.ts`
  `OPERATIONS_LIST_NULL_SORT_BOUND_SQL`, bảng pin conformance, `SENTINEL_DESC/ASC` của §14/§19, và SQL
  0019. Đổi format/đổi sentinel tương lai = drift im-lặng 4-file. Đề nghị export một nguồn từ
  source/contracts để test đọc chung; lane không tự làm vì production ngoài scope VÀ lane 0019 đang
  sửa đúng vùng đó hôm nay.
- **Δ90 — VAULT-06 tái phát standalone** (`connector-revision-http-offline.functional`, leg
  restart/reconcile: `revision` nhận `undefined` thay 2, 1/8 đỏ): từng liệt kê ở Mục 15, sạch ở sweep
  16/19, đỏ trở lại ĐỘC LẬP với sweep 27/09 — file của Vault lane, không thuộc Admin, đưa vào queue
  adjudicate.



---


## 21 — CYCLE 21: W-ADMIN-ALIGN-EXPLAIN-0019 — admin-keyset-explain harness theo 0019 inline literal (Δ88 ĐÓNG)

### 21.0 Packet và nguồn đỏ
- task_222653f4cfd2 / dispatch ctx_c3234ad59db5: align `tests/admin-keyset-explain.test.ts`
  với sentinel inline literal `'<ISO>'::timestamptz` mà W-INGEST-0019-1/2 đưa vào
  `bindOperationsListSortKey` (0019 index match Const node, Param bind là hình chết-index T-35).
  Đây chính là Δ88 đã flag ở Mục 20.
- **Trạng thái file khi nhận:** lane khác (Platform, W-INGEST-0019-2) đã thêm header paragraph
  W-ADMIN-ALIGN-EXPLAIN-0019 nhưng để lại `.join('\n')` hỏng syntax (literal newline thay
  escaped `\n`) → TS2554/TS1002 khi compile. Lane này repair.

### 21.1 Đã giao (chỉ test; production diff = 0)
1. **Sentinel comment** (L75-78): cập nhật giải thích inline literal thay bound param.
2. **Decision bar regex** (`expectDeadlinePlanUsable`): nhận CẢ hai họ index:
   `operations_(tenant_)?deadline_(coalesce_(asc|desc)_)?id_idx` — 0018 plain + 0019 expression.
3. **pg_indexes test**: 6 → **10** tên (thêm 4 index 0019: `operations_tenant_deadline_coalesce_desc_id_idx`,
   `operations_deadline_coalesce_desc_id_idx`, `operations_tenant_deadline_coalesce_asc_id_idx`,
   `operations_deadline_coalesce_asc_id_idx`). Test name đổi "six" → "ten".
4. **3 deadline SQL tests**: sentinel từ `$n::timestamptz` (param) sang
   `'${SENTINEL_DESC/ASC}'::timestamptz` (inline literal trong template string);
   placeholder renumber ($2→$1, $3→$2, $4→$3, $5→$4 tương ứng).
   Test names đổi "0018" → "0019".
5. **+1 synthetic test** (offline): "accepts a 0019 coalesce index name" — chứng minh
   widened regex không vacuous (plan có `operations_tenant_deadline_coalesce_desc_id_idx` pass bar).
6. **Repair `.join('\n')` hỏng** do lane khác để lại (literal newline → escaped `\n`).

### 21.2 Bằng chứng (cây cuối; literal `Exit Code:`)
- `npx jest --runInBand tests/admin-keyset-explain.test.ts` — **18/18 ×3**:
  RUN1_EXIT_0, RUN2_EXIT_0, RUN3_EXIT_0 (13 skipped live-gated + 5 synthetic passed).
- `npx tsc --noEmit -p tsconfig.json` — TSC_EXIT_0, Exit Code: 0.
- File 553 → 583 dòng (+30: sentinel comment +3, bar comment +3, pg_indexes +4 names,
  3 deadline tests renumber, +1 synthetic test, repair join).
- Offline only, không DB window, không commit/push.

### 21.3 Mục 21 KHÔNG chứng minh
- Không phải live EXPLAIN: 13 test live-gated vẫn skip (DU_LIVE_INFRA chưa set).
- Không chứng minh planner chọn 0019 index trên population thật — đó là việc Tester window.
- 4 synthetic test chỉ chứng minh bar CÓ RĂNG (nhận đúng tên, reject sai tên), không phải plan thật.

### 21.4 Δ-DEVIATION
- **Δ88 ĐÓNG** (fixture EXPLAIN Mục 18 pin hình cũ → nay đã align).
- **Δ91 — Lane khác để lại syntax error trong file này** (`.join('\n')` literal newline,
  TS2554+TS1002). Lane này repair; không quy trách nhiệm nhưng ghi để coordinator biết
  file đã bị chạm trước khi packet này tới.
- Δ89 (sentinel 4 nơi không một nguồn) và Δ90 (VAULT-06) vẫn mở từ Mục 20.
- ADM-UX-02 [~], ADM-UX-03 [ ], G-ADMIN-OPS giữ NO-GO.


---


## 22 — CYCLE 22: W-ENC-07-DELIVERY-1 — delivery encryption cho public result/download (task_7e489eb6b6d6)

### 22.0 Packet
- task_7e489eb6b6d6 / dispatch ctx_b89fcb76b089 (giao bởi Antigravity): triển khai ENC-07 —
  Orchestrator public result/download API với delivery encryption. Phạm vi file được phép:
  `src/server.ts`, `src/modules/public-api/**`, `tests/delivery-encryption.test.ts`.
- Khác các Mục 20–21: đây là **packet IMPLEMENTATION có sửa production**, không phải sửa harness.

### 22.1 Kiến trúc đã chọn và vì sao
- **Policy là config-injected, không có client override.** `ServerConfig.deliveryEncryption`
  mang `policyByTenant` + registry ENC-06. Không có query param, không header, không chỗ nào
  đọc lựa chọn của caller: suite thử 7 cách hạ chế (`encrypted=0`, `plaintext=1`,
  `x-delivery-mode`, `accept: text/plain`, …) và cả 7 vẫn ra envelope.
- **Một service, hai route.** `modules/public-api/delivery-encryption.ts` (218 dòng) là nơi
  duy nhất quyết định plaintext-vs-encrypted; `/result` và `/download` chỉ gọi nó. Đây là câu
  trả lời trực tiếp cho câu hỏi ENC-07 nêu: bọc `{resultRef}` nhưng để `/download` trả
  plaintext là bảo vệ metadata và rò payload.
- **DEK mới mỗi response.** AES-256-GCM với nonce 12 byte sinh mới, DEK 32 byte sinh mới,
  DEK wrap bằng RSA-OAEP-SHA256 dưới public key từ registry ENC-06. Suite chứng minh hai lần
  gọi cùng plaintext cho nonce/enc/ciphertext khác nhau, cả hai vẫn giải mã đúng.
- **Envelope validate trước khi ra khỏi service** (`RecipientDeliveryEnvelopeSchema.safeParse`,
  schema ENC-01): producer lệch contract thì fail 503 ngay bên ta, không đẩy lỗi parse sang
  client bên ngoài.
- **Version pin.** Envelope mang `recipientKeyId` + `recipientKeyVersion` lấy từ key đang active
  của tenant (test với version 7 → envelope đúng 7).
- **`/download` giữ nguyên đường plaintext.** Khi policy tắt, route vẫn trả `Readable`
  stream như cũ (zero-copy, không đổi hợp đồng cũ). Khi policy bật, mã hóa cần trọn payload
  trong RAM nên đọc **có trần** `maxBlobBytes`; quá trần → **413 TOO_LARGE**, không phải buffer
  không giới hạn và không phải rơi về plaintext.
- **Fail-closed ở tầng wire.** Key thiếu / bị revoke / registry lỗi / chưa wire registry → 503
  problem+json trên **cả hai** route, chữ cố định theo code (ADM-BASE-03: không để raw
  `err.message` ra wire), và test kiểm payload không xuất hiện trong body lỗi.
- **HPKE từ chối chứ không hạ cấp.** ENC-01 liệt kê `hpke-rfc9180` là suite ưu tiên;
  chưa có implementation nên key X25519 nhận `DELIVERY_CRYPTO_FAILURE` thay vì được
  đưa xuống RSA (Δ93).

### 22.2 File đã giao
- **MỚI** `src/modules/public-api/delivery-encryption.ts` (218 dòng): policy, service,
  `DeliveryEncryptionError` (5 code), `createDeliveryEncryptionService` trả `null` khi không
  tenant nào có policy (nền tảng plaintext giữ nguyên hành vi cũ).
- **MỚI** `src/modules/public-api/index.ts`: barrel export.
- **SỬA** `src/server.ts`: `ServerConfig.deliveryEncryption`; `RouteContext.deliveryEncryption`;
  wire trong ctx assembly; 3 helper (`deliveryEncryptionHttpError`, `encryptedDeliveryBody`,
  `readStreamBounded`); `/result` và `/download` gọi policy.
- **MỚI** `tests/delivery-encryption.test.ts` (489 dòng, **22 test**): 10 test service + 12 test
  route qua `route()` thật với fake db ghi lệnh. Fixture: một cặp RSA 2048 sinh 1 lần, private
  key chỉ nằm trong test để đóng vai external recipient (ngoài đời private key không vào app).

### 22.3 Bằng chứng (cây cuối; literal `Exit Code:`)
- `npx jest --runInBand tests/delivery-encryption.test.ts` — **22/22 ×3**, `RUN1/2/3_EXIT_0`,
  wrapper `Exit Code: 0` cả ba lần.
- `npx tsc --noEmit -p tsconfig.json` — `TSC_EXIT_0`, Exit Code: 0.
- Full sweep offline (`jest.unit.config.cjs`): **79 pass / 1 skip / 1 fail — 1854 passed /
  28 skipped / 1883 total**. So với baseline Mục 20 (1788 passed, VAULT-06 đỏ) nay **+66 test
  xanh và VAULT-06 đã xanh** (lane khác sửa). Đỏ duy nhất **KHÔNG thuộc ENC-07** (Δ92).

### 22.4 Tự sửa trong chu kỳ này (ghi công khai)
1. `tsc` lần 1 đỏ: `getBlob` trả `Readable` không phải `Buffer` → viết lại nhánh encrypted
   để đọc stream có trần thay vì giả định bytes.
2. **Tự ghi đè mất 10 service-test**: khi viết nửa route-test tôi dùng lại đúng path
   `tests/delivery-encryption.test.ts`, xoá nửa service đã có. Phát hiện ngay (số test tụt
   22→12) → dựng lại từ 2 fragment rồi ghép, verify 22 test + LF sạch trước khi chạy.
3. Test `foreign tenant 404` **xanh giả** vì harness cho operation thuộc chính tenant của
   x-api-key nên check 404 không kích hoạt → thêm `ownerTenant` tách tenant sở hữu khỏi tenant
   xác thực; giờ 404 là hàng rào cross-tenant thật, kiểm trên cả hai route.
4. Receipt bị chèn **hai** section `## 21` do batch song song → dedup (script có assert số
   section trước/sau) + khôi phục dấu `---` phân cách.
5. **Δ80 lặp lại**: `src/modules/runtime/runtime.ts` của lane khác đang edit giữa lúc tôi
   chạy (TS2339 rồi TS2322 ở hai thời điểm khác nhau, mtime mới hơn thời điểm tôi đo). Không
   chạm file đó, poll chờ họ converge rồi mới chốt. Đây là lần thứ hai trong 2 chu kỳ liên tiếp.

### 22.5 Mục 22 KHÔNG chứng minh
- **Không phải live evidence**: không Vault thật, không PG, không S3, không external client
  thật. Toàn bộ chạy offline với registry stub và khóa fixture. `ENC-INT-01` mới là nơi
  chứng minh bằng hai tenant + Vault thật + external private key.
- **Chưa có nơi lưu policy**: `policyByTenant` là config do composition root đưa vào. Toggle
  bật/tắt theo tenant thuộc ENC-08 (Admin API + RBAC/CSRF/audit) — chu kỳ này không thêm
  bảng DB hay migration, nên policy chưa sống được qua restart (Δ94).
- **Chỉ suite `rsa-oaep-sha256`.** HPKE bị từ chối có chủ đích (Δ93).
- **Không phủi giao của artifact lớn**: trần đọc là `maxBlobBytes` (mặc định 64 MiB); trên
  trần trả 413. Profile chunk cho *delivery* (khác `EncryptedChunkManifest` của at-rest) là
  hợp đồng mới, chưa có trong ENC-01 (Δ95).
- `G-ENC` và `G6` giữ **NO-GO**. ADM-UX-02 `[~]`, ADM-UX-03 `[ ]` không đổi.

## Δ-DEVIATION Mục 22 (chờ coordinator adjudicate)

- **Δ92 — Đỏ sweep không thuộc ENC-07**: `admin-operations-list-pagination.test.ts` fail 1/89
  (và fail cả khi chạy đơn lẻ ⇒ không phải contention theo Δ74). Nguyên nhân: renderer
  `src/app/admin/shell-render.ts:525` (mtime 21:43) phát `aria-label="Scrollable data table 1 of 1"`
  trong khi suite pin chuỗi cũ `aria-label="Scrollable table"`. Tôi không sửa `src/app/admin/**`
  (ngoài 3 path ENC-07 cho phép) và cũng không sửa pin của lane khác — đưa coordinator chuyển
  lane sở hữu renderer.
- **Δ93 — HPKE chưa có, và điều đó là fail-closed**: ENC-01 đặt `hpke-rfc9180` là suite ưu tiên
  nhưng repo chưa có implementation. `resolveSuite` suy ra suite từ **algorithm của key đã
  đăng ký**, không từ ý muốn của policy hay của caller; key X25519 ⇒ 503 chứ không bị đổi
  xuống RSA. Cần gói implementation HPKE + test vector ngoài trước khi tenant nào đăng ký X25519.
- **Δ94 — Policy chưa bền**: `policyByTenant` là config trong memory. ENC-07 cho phép sửa 3 file,
  nên tôi không thêm migration; sau restart là mất policy (mặc định plaintext ⇒ lệch với ý
  định của tenant). Cần ENC-08 sở hữu bảng + API bật/tắt, và tới lúc đó policy phải đọc từ DB
  chứ không phải từ config.
- **Δ95 — Delivery lớn chưa có profile chunk**: xem 22.5. Hiện 413 trên trần đọc.
- **Δ96 — `keyId` của envelope là UUID record của registry**, không phải fingerprint. Hai định
  danh tính khác nhau cùng tồn tại trong hệ (ENC-06 `id` vs `fingerprint` SHA-256); client
  ngoài dùng cái nào để tra registry là quyết định wire-profile của ENC-00, chưa đóng.




---


## 23 — CYCLE 23: W-ENC-08-CONFIG — Admin UI + API cho crypto configuration (task_5b49655d9bbd)

### 23.0 Packet và ràng buộc
- task_5b49655d9bbd / dispatch ctx_584a61ed44c2: ENC-08 — Admin chọn Vault storage key ref trong
  allowlist, toggle delivery encryption, pin/select phiên bản public key theo tenant; RBAC/CSRF,
  audit, preview fingerprint không lộ secret.
- **Phạm vi file được phép: `src/app/admin/**` + `tests/**`.** KHÔNG có `server.ts`, KHÔNG có
  `src/modules/**`. Mọi thứ ở dưới đây nằm trong phạm vi đó; những gì cần chạm ngoài phạm vi
  được ghi thành delta ở 23.5 thay vì tự mở rộng.

### 23.1 Kiến trúc: 3 tầng, không framework
1. `crypto-config-view-models.ts` (167 dòng) — thuần. `buildCryptoConfigView`, `pinInvalidReason`,
  `effectiveRecipientKeyVersion`, `fingerprintPreview`, `CryptoConfigPane` (ready / unauthorized /
  not-found / error) đúng convention pane của các section khác.
2. `crypto-config-renderer.ts` (126 dòng) — HTML thuần, mọi giá trị qua `esc()`. Ba control:
  `<select name="storageKeyRef">`, checkbox `deliveryEncryption`, `<select name="recipientKeyVersion">`
  kèm `data-fingerprint-preview` + `data-key-status` để browser E2E sau này đo được side effect.
3. `crypto-config-api.ts` (350 dòng) — handler nhận principal + 3 port (store / key lister / audit),
  trả về view model. Không biết HTTP, không biết DB ⇒ mọi luật dưới đây test offline được.
4. `crypto-config-index.ts` — barrel, tách riêng để không đụng `index.ts` chung của `app/admin`.

### 23.2 Ba quyết định thiết kế cần biết
- **Pin hỏng được hiện ra, không bị bỏ qua âm thầm.** Pin trỏ version đã revoke hoặc không còn
  tồn tại ⇒ `pinInvalid` + cảnh báo trong pane, `deliveryReady=false`. Một pane trông khỏe trong
  lúc delivery đang fail-closed 503 chính là cách setting này bị bỏ qua.
- **Ref outside allowlist bị từ chối 422, không chỉ vắng mặt khỏi form.** Form chỉ hiện ref được
  allowlist, nên POST tay của ref lạ đúng là trường hợp mà check này sinh ra.
- **Bật delivery khi tenant chưa có key dùng được ⇒ 409 từ chối lúc cấu hình**, thay vì lưu rồi để
  ENC-07 trả 503 cho mọi delivery. Một setting vừa bật là đã hỏng thì tệ hơn là từ chối kèm lý do.
  (Lựa chọn chính sách — xin Δ103.)
- **Chọn Vault storage key ref là hành động PLATFORM-ONLY** (nó quyết định Transit key nào bọc
  DEK của tenant — hạ tầng, không phải sở thích tenant). Toggle + pin thì tenant-scoped.
  (Lựa chọn chính sách — xin Δ103.)

### 23.3 File đã giao
- **MỚI** `src/app/admin/crypto-config-view-models.ts` — 167 dòng.
- **MỚI** `src/app/admin/crypto-config-renderer.ts` — 126 dòng.
- **MỚI** `src/app/admin/crypto-config-api.ts` — 350 dòng, 14 export.
- **MỚI** `src/app/admin/crypto-config-index.ts` — barrel.
- **MỚI** `tests/admin-crypto-config.test.ts` — 458 dòng, **35 test** / 6 describe.
- Không sửa file nào đã tồn tại. Production diff của lane = **file mới trong `app/admin/`**;
  `server.ts` và `src/modules/**` nguyên vẹn (ngoài phạm vi packet).

### 23.4 Bằng chứng (cây cuối; literal `Exit Code:`)
- `npx jest --runInBand tests/admin-crypto-config.test.ts` — **35/35 ×3**, `RUN1/2/3_EXIT_0`,
  wrapper `Exit Code: 0` cả ba lần.
- `npx tsc --noEmit -p tsconfig.json` — `TSC_EXIT_0`, Exit Code: 0.
- Full sweep offline (`jest.unit.config.cjs`): **81 pass / 1 skip / 1 fail — 1912 passed /
  28 skipped / 1941 total**. +58 so với baseline Mục 22 (1854): 35 là của ENC-08, 23 của lane
  khác. Đỏ duy nhất vẫn là `admin-operations-list-pagination` — **cùng Δ92** (renderer
  `shell-render.ts` đổi `aria-label`), đã kiểm lại nội dung đỏ, không đổi so với chu kỳ trước
  và không liên quan file của ENC-08.
- 6 describe phủ đúng 6 điều kiện task row nêu: allowlist, toggle, pin, RBAC/CSRF, audit,
  no-secret-leakage. Test quan trọng nhất: CSRF dùng `deriveCsrfToken` **thật** của rbac.ts, nên
  gate được thử là gate thật chứ không phải bản mô phỏng.

### 23.5 Tự sửa trong chu kỳ này (ghi công khai)
1. **Bug thật trong source của tôi, bắt bởi test:** `effectiveRecipientKeyVersion` trả
   `usable[0]` nên phụ thuộc THỨ TỰ input — gọi trực tiếp với danh sách chưa sort thì trả về
   version 1 thay vì version 2 cao nhất. Sửa trong source (sort tại chính hàm), không sửa test.
2. 4 expectation của tôi sai: đếm chuỗi fingerprint 10 ký tự thay vì 12, và thứ tự attribute
   `checked` trong HTML thật. Sửa expectation theo hành vi đúng, không nới code để khớp.
3. Test "không lộ secret" ban đầu tôi trồng sentinel VÀO tenantId nên nó hiện ra (đã escape) là
   đúng — tôi viết lại thành hai phép riêng: escape script do operator nhập, và fingerprint mang
   secret chỉ hiện preview 12 ký tự.

### 23.6 Mục 23 KHÔNG chứng minh
- **Chưa có route HTTP.** Handler dừng ở tầng hàm; `server.ts` ngoài phạm vi packet nên Admin
  chưa gọi được từ trình duyệt (Δ97). Đây là khoảng cách lớn nhất giữa "có test" và "dùng được".
- **Chưa có persistence.** `CryptoConfigStore` là port; production adapter (bảng + CAS) cần
  migration, cũng ngoài phạm vi (Δ98). Hiện state chỉ sống trong store được inject.
- **Chưa có browser E2E** mà acceptance của ENC-08 yêu cầu (save/reload/rotate/revoke + response
  mode thực sự đổi). Cần route thật + secret cookie + Vault thật; nằm ngoài phạm vi và ngoài offline.
- **Chưa nối vào ENC-07.** Toggle/pin được lưu, nhưng service delivery của ENC-07 đọc policy từ
  `ServerConfig`, không đọc từ store này ⇒ bật toggle ở Admin chưa làm đổi hành vi delivery
  thật. Cần packet nối (Δ99). Nói thẳng: **ENC-08 ở đây là bề mặt quản trị, chưa là đòn cần.
- Không claim browser, live, hay Vault. `G-ENC`/`G6` giữ NO-GO.

## Δ-DEVIATION Mục 23 (chờ coordinator adjudicate)

- **Δ97 — Admin API chưa có route HTTP.** Handler + view model + renderer đã có và đã test, nhưng
  `server.ts` (mount `/api/v1/admin/crypto-config`) và `shell-router.ts` (mở pane) đều ngoài 3 path
  packet cho phép. Cần packet follow-on: **ENC-08 không thể ACCEPTED cho tới khi route thật tồn tại.**
- **Δ98 — Store là port, chưa có bảng.** Không thêm migration (ngoài phạm vi). Cần bảng cấu hình
  per-tenant + CAS để chống hai admin ghi đè nhau, và để policy sống qua restart.
- **Δ99 — Chưa nối ENC-07.** Delivery service đọc `ServerConfig.deliveryEncryption`; toggle + pin ghi
  vào store của ENC-08. Cần một seam để store này là nguồn policy, và để pin version được
  `getKeyVersion` thay vì `getCurrentKey`. **Cho tới khi có Δ99, bật toggle trong Admin KHÔNG đổi
  hành vi giao thật** — ghi rõ để không ai tin nhầm vào UI.
- **Δ100 — Vault allowlist phải truyền vào, chưa tự lấy được.** `VaultTransitProvider` giữ allowlist
  trong private Map, không có getter, và file đó ngoài phạm vi. Nên admin nhận `allowedKeyRefs` từ
  composition root. Rủi ro: hai nơi khai allowlist ⇒ lệch. Đề nghị expose một accessor hoặc khai
  một lần ở composition rồi truyền cả hai.
- **Δ101 — CSRF qua `validateCsrfToken` của rbac.ts, nhưng cổng session OIDC thì sao?** Handler nhận
  `sessionCookie` + `cookieSecret` như `CredentialWorkflow` hiện tại. Với OIDC session store
  (`server.ts` đã dùng cho admin actions) thì CSRF phải đi qua `verifySessionCsrf`; packet này không
  chạm `server.ts` nên chưa ghép được. Cần xác nhận bề mặt nào là chuẩn cho action mới.
- **Δ102 — Không có mutation test trên production.** Tất cả file là MỚI nên không có "revert một
  dòng thấy đỏ" theo kỷ luật các chu kỳ trước; thay vào đó răng đến từ 35 assertion (allowlist,
  CSRF, RBAC, no-op audit, cross-tenant drop, secret sentinel). Ghi rõ để không bị đọc nhầm là
  có mutation coverage.
- **Δ103 — Hai lựa chọn chính sách cần ký:** (a) bật delivery mà chưa có key dùng được ⇒ từ chối 409
  lúc cấu hình, tôi đã chọn phương án này; (b) chọn Vault storage key ref là platform-only. Cả hai
  đều có thể đảo; hiện là quyết định của tôi, chưa phải quyết định đã ký.




---


## 24 — CYCLE 24: W-ENC-08-WIRING — mount crypto-config vào HTTP route + Admin shell (task_4f4ddbfd7e07)

### 24.0 Packet
- task_4f4ddbfd7e07 / dispatch ctx_21c1431d4bf3: đóng **Δ97** (Mục 23 đã ghi là lớp wiring chưa có,
  nên ENC-08 chưa thể ACCEPTED). Phạm vi: `src/server.ts`, `src/app/admin/shell-router.ts`, `tests/**`.
- **Đã đóng Δ97 ở mức route + shell.** Δ98 (bảng), Δ99 (nối ENC-07) **vẫn mở** — xem 24.6.

### 24.1 server.ts — route `/api/v1/admin/crypto-config`
- `ServerConfig.cryptoConfig { allowedKeyRefs, recipientKeyRegistry? }`. Registry mặc định lấy từ
  `deliveryEncryption.recipientKeyRegistry` (ENC-07) ⇒ **một nguồn key**, không hai nơi khai lệch nhau.
- `RouteContext.cryptoConfig`; build **một lần trong `createApp`**, không mỗi request — store state,
  build mỗi request thì "Admin bấm Save xong không có gì xảy ra".
- Route `GET` trả `{schemaVersion, tenantId, crypto: viewModel}`; `POST` nhận `{tenantId?, storageKeyRef?,
  deliveryEncryption?, recipientKeyVersion?}`, gọi **đúng handler** mà unit test Mục 23 điều khiển (một bộ
  luật, hai cửa). Sai kiểu field ⇒ 422 trước khi chạm store.
- **Chưa cấu hình ⇒ 503**, không giả vờ nền tảng không có gì để cấu hình.

### 24.2 Một lỗ hổng thật do chính tôi tạo ra, đã bắt và sửa
- Bản đầu đọc `cookieRole` từ **header `x-admin-role` do caller tự set**. Đó là field do caller chọn —
  trái đúng nguyên tắc ADM-BASE-02 "role đến từ CREDENTIAL". Sửa: role lấy từ claims của cookie
  `du_admin` **đã verify chữ ký** (`verifyCookie`), header bị bỏ hẳn.
- Test bắt được bằng chứng: cookie-less operator + header giả **không** lên được vai admin; và cookie
  thật + `x-csrf-token` đoán ⇒ **403**.
- Chạm thêm một file ngoài phạm vi packet: `src/app/admin/crypto-config-api.ts` (mục 24.4).

### 24.3 shell-router.ts — route `/admin/crypto-config`
- Cố tình **KHÔNG** làm thành section: `AdminSection` là union đóng trong `types.ts`, ngoài phạm vi ⇒
  thêm section mới là sửa file không được phép. Nên nó là route riêng, `requiredRole: 'admin'`.
- `ShellRuntimeConfig.cryptoConfigPane?: (request) => Promise<CryptoConfigPane>` — composition root
  cấu hình; **không có resolver ⇒ pane lỗi `CRYPTO_CONFIG_NOT_WIRED`**, không phải trang trắng.
- Resolver ném ⇒ `CRYPTO_CONFIG_UNAVAILABLE`, **không** rò message lỗi ra HTML.
- Không đụng `shell-render.ts` (ngoài phạm vi): dùng seam `deferredSectionExtras` có sẵn.

### 24.4 Chạm vượt phạm vi packet — ghi công khai
- `src/app/admin/crypto-config-api.ts`: lane khác sửa file này lúc 02:58–03:00 (mtime), làm hỏng
  type-import `CryptoConfigState` (thay bằng re-export ⇒ mất local binding ⇒ 4 lỗi TS2304). Tôi **không
  sửa file họ đang chạy** (Δ80, tiền lệ 3 lần); poll ~90s, họ xong (mtime 03:00:13) thì lỗi tự hết.
  Không cần đụng vào. Ghi lại để ai đó không tưởng tôi đã sửa giúp.

### 24.5 File đã giao
- **SỬA** `src/server.ts` — ServerConfig + RouteContext + `buildCryptoConfigOptions` + route GET/POST.
- **SỬA** `src/app/admin/shell-router.ts` — matcher + handler + dispatch case + config field.
- **MỚI** `tests/admin-crypto-config-wiring.test.ts` — **21 test / 3 describe**, 392 dòng.
- Không sửa file nào khác.

### 24.6 Bằng chứng (cây cuối; literal `Exit Code:`)
- `npx jest --runInBand tests/admin-crypto-config-wiring.test.ts tests/admin-crypto-config.test.ts`
  — **56/56 ×3** (`RUN1/2/3_EXIT_0`), wrapper `Exit Code: 0` cả ba lần.
- `npx tsc --noEmit -p tsconfig.json` — `NO_TS_ERRORS`, Exit Code: 0 (lỗi tạm của lane khác đã hết).
- Full sweep offline (`jest.unit.config.cjs`): **83 pass / 1 skip / 2 fail — 1938 passed /
  28 skipped / 1967 total**. +26 so với baseline Mục 23 (1912): 21 là của ENC-08-WIRING, 5 của lane
  khác. **Cả 2 đỏ đều không thuộc packet này, đều fail độc lập (không phải contention):**
  (1) `admin-operations-list-pagination` — Δ92 cũ, `aria-label` của renderer;
  (2) `public-upload-encryption-gateway` — **ENC-05 upload gateway của lane khác**, đỏ 5/7,
  lỗi nằm trong `src/modules/public-api/upload-encryption-gateway.ts` (session expired + 2 lỗi
  trạng thái), **không liên quan file ENC-08**. Đưa coordinator chuyển lane sở hữu; tôi không chạm.

### 24.7 Mục 24 KHÔNG chứng minh
- **Δ97 đóng ở mức code + offline.** Không có request HTTP thật qua socket, không browser, không Vault.
- **Δ98 vẫn mở**: store là in-memory, cấu hình **mất khi restart** ⇒ tenant về mặc định. Đây là nơi
  packet này KHÔNG thể đi xa hơn (migrations ngoài 3 path được phép).
- **Δ99 vẫn mở**: toggle/pin lưu vào store, còn service delivery của ENC-07 đọc `ServerConfig` ⇒ **bật
  toggle trong Admin CHƯA đổi hành vi giao thật**. Nói thẳng, không tính là xong.
- `G-ENC`/`G6` giữ NO-GO. ENC-08 **chưa ACCEPTED**.

## Δ-DEVIATION Mục 24 (chờ coordinator adjudicate)

- **Δ97 ĐÓNG ở mức route + shell.** Còn lại của ENC-08 vẫn là browser E2E (save/reload/rotate/revoke +
  response mode thực sự đổi) — cần secret cookie + Vault thật, nằm ngoài offline.
- **Δ104 — Route dùng `x-admin-role` ở bản đầu, đã sửa.** Ghi để không ai đọc code cũ; nếu còn bản
  deploy nào đọc header này thì cần audit lại (route hiện chỉ đọc claims đã verify).
- **Δ105 — CSRF trên API route chỉ áp dụng cho tenant-operator bearer.** Platform bearer là machine
  call (shell server gọi server-to-server) nên không cần CSRF. Nhưng điều đó có nghĩa **một browser
  giữ được platform bearer cũng qua được** — chấp nhận được chỉ khi bearer đó thực sự chỉ nằm ở
  server. Cần xác nhận cấu hình triển khai (nếu không, phải bắt CSRF cho cả platform).
- **Δ106 — `ShellRuntimeConfig.cryptoConfigPane` là optional; composition root chưa cấu hình**
  (shell-server mount ngoài phạm vi). Production sẽ thấy error pane cho tới khi wire tiếp.
- **Δ107 — Chạm file ngoài phạm vi để gỡ lỗi compile của lane khác** (Δ80 pattern) — ghi để review
  thấy đúng mức độ can thiệp: tôi CHỈ quan sát, không sửa file họ.




---


## 25 — CYCLE 25: W-ENC-08-WIRE-ENC07 — nối toggle Admin vào delivery của ENC-07 (task_e7c21a0b6c2f)

### 25.0 Packet
- task_e7c21a0b6c2f / dispatch ctx_e918bed8ea4f: đóng **Δ99** — Admin bật `deliveryEncryption` thì
  route public `/result` và `/download` **tự động** mã hóa ngay lượt kế tiếp, không restart.
- Phạm vi: `src/modules/public-api/**`, `src/server.ts`, `tests/**`.

### 25.1 Thay đổi kiến trúc: policy đọc theo request, không phải lúc khởi tạo
- `delivery-encryption.ts` nhận thêm `policySource: { getDeliveryPolicy(tenantId) }` — nguồn policy
  **bất đồng bộ**, đọc **mỗi request**. `policyByTenant` (tĩnh) giữ làm fallback cho nền tảng không có
  bề mặt crypto-config.
- `resolvePolicy()` (async) là API mà các route gọi. `getPolicy()` (sync) **ném lỗi** khi có policy
  động, thay vì trả câu trả lời tĩnh đã cũ — trả stale thì Admin toggle trông như không có tác dụng.
- `buildDeliveryEncryptionConfig(config, cryptoConfig)` trong server.ts nối **cùng một store** mà
  Admin ghi vào, nên một lần bật/tắt/pin có hiệu lực ngay. Registry suy ra từ `cryptoConfig` rồi
  mới tới `deliveryEncryption` ⇒ vẫn **một nguồn key**.
- Service build **một lần** trong `createApp` (trước đây dựng mỗi request), vì nó giờ đọc state.

### 25.2 Pin version được tôn trọng tuyệt đối
- `encryptForDelivery` gọi `registry.getKeyVersion(tenantId, pinned)` khi có pin, thay vì `getCurrentKey`.
  Nghĩa là **rotation sau khi pin không đổi người giải mã** — đúng như lựa chọn của operator.
- Pin không tồn tại hoặc đã revoke ⇒ **fail-closed 503**, KHÔNG lùi về key hiện hành. Lùi lại chính là
  loại downgrade mà cả ENC-07 lẫn ENC-08 đã cấm.
- Unpin (`null`) ⇒ quay về key hiện hành.

### 25.3 File đã giao
- **SỬA** `src/modules/public-api/delivery-encryption.ts` — `TenantDeliveryPolicy.pinnedRecipientKeyVersion`,
  `TenantDeliveryPolicySource`, `resolvePolicy`, pin-aware key resolution.
- **SỬA** `src/server.ts` — `buildDeliveryEncryptionConfig` (exported để test dùng đúng code thật),
  service build 1 lần trong `createApp`, 2 route dùng `await resolvePolicy`.
- **MỚI** `tests/enc08-wire-enc07.test.ts` — **9 test**, 300 dòng.
- Không sửa file nào khác.

### 25.4 Bằng chứng (cây cuối; literal `Exit Code:`)
- 4 suite ENC (`enc08-wire-enc07` + `delivery-encryption` + `admin-crypto-config` + `-wiring`):
  **87/87 ×3** (`RUN1/2/3_EXIT_0`), wrapper `Exit Code: 0`.
- Full sweep offline: **87 pass / 1 skip / 1 fail — 1968 passed /
  28 skipped / 1997 total**. +30 so với Mục 24 (1938): 9 là của ENC-08-WIRE-ENC07, 21 của lane
  khác. **Đỏ duy nhất còn lại là** `admin-operations-list-pagination` — **Δ92 cũ** (`aria-label`
  của renderer, đã fail độc lập từ Mục 20), không liên quan file của packet này. Đỏ
  `public-upload-encryption-gateway` của ENC-05 ở Mục 24 nay **đã xanh.**
- 9 test mới chứng minh đúng thứ ENC-08 còn thiếu: toggle tắt ⇒ plaintext; bật ⇒ `/result` và
  `/download` mã hóa **lượt kế tiếp**, external fixture giải mã đúng payload gốc; pin tôn trọng sau
  rotation; unpin quay về key hiện hành; **pin bị revoke ⇒ 503 chứ không phải plaintext**; tắt lại ⇒
  plaintext; `getPolicy` từ chối trả stale; nền tảng tĩnh vẫn chạy.

### 25.5 Tự sửa trong chu kỳ này
- **Fake db của tôi nuốt mất SQL của `/download`.** Nhánh `/FROM operations o/i` (viết cho `/result`)
  cũng khớp `FROM operations owner_op` trong EXISTS của `/download` ⇒ 0 dòng ⇒ 404. Đã siết thành
  `/FROM operations o\s+LEFT JOIN artifacts/`. Ghi công khai vì đây là loại lỗi mà người đọc khác
  dễ tái phạm khi viết fake db theo regex.
- 3 lỗi compile lần đầu (mất hằng `API_KEY` khi ghép fragment, kiểu `revokedAt` bị suy rộng,
  và dấu `}` thừa do một fragment đóng `describe` sớm) — đều ở test của tôi, đã sửa.
- **Công cụ:** `exec` parser của tôi nhiều lần vấp chuỗi nhiều dòng; chuyển sang viết fragment rồi
  ghép bằng script Node với assert số anchor trước khi ghi (pattern đã dùng ở Mục 20/24).

### 25.6 Mục 25 KHÔNG chứng minh
- **Δ98 vẫn mở**: store vẫn in-memory ⇒ cấu hình **mất khi restart**. Chuyển sang bảng cần migration,
  ngoài phạm vi packet này.
- Không có HTTP qua socket, không Vault thật, không browser: toàn bộ in-process với registry và
  artifact store giả.
- `G-ENC`/`G6` giữ NO-GO; ENC-08 **chưa ACCEPTED**.

## Δ-DEVIATION Mục 25 (chờ coordinator adjudicate)

- **Δ99 ĐÓNG ở mức code + offline.** Toggle/pin của Admin nay thực sự chi phối delivery.
- **Δ108 — `getPolicy` sync nay NÉM khi có policy động.** Đây là breaking change cho bất kỳ caller
  nào đang gọi nó; hiện chỉ có 2 route trong `server.ts` và chúng đã chuyển sang `resolvePolicy`.
  Nếu còn surface nào khác (webhook/cache theo ghi chú ở task row) thì phải rà lại.
- **Δ109 — Pin bị revoke giờ chặn delivery 503.** Đây là hành vi mới, có chủ đích: operator pin rồi
  key bị revoke là tình huống cần được chặn rõ, không phải lùi về key hiện hành. Cần xác nhận với
  Security rằng "key mới đã đăng ký nhưng pin cũ bị revoke" ⇒ 503 là đúng mong muốn, thay vì tự
  chuyển sang key mới.
- **Δ110 — Cache/webhook chưa theo policy.** Task row nhắc "cả hai route, webhook/cache và key
  rotation/revoke tuân cùng policy". Route đã tuân; **webhook dispatcher chưa** (nó ở
  `src/modules/webhooks/**`, ngoài phạm vi packet). Cần packet riêng.



---


## 26 — CYCLE 26: W-ADM-UX-08-SHELL — nối cryptoConfigPane vào composition root (task_ddc3efda9377)

### 26.0 Packet
- task_ddc3efda9377 / dispatch ctx_2ddb0e928684: đóng **Δ106** — wire resolver của shell pane vào
  `createApp`, bảo vệ bằng RBAC + CSRF, không rò token/secret vào DOM hay view-model.
- Phạm vi: `src/app/admin/shell-router.ts`, `src/server.ts` (composition root), `tests/**`.

### 26.1 Vì sao phải qua một registry, không truyền qua ServerConfig
- `attachAdminShell` tự dựng `ShellRuntimeConfig` từ danh sách field CỐ ĐỊNH bên trong
  `shell-server.ts`, và file đó **ngoài phạm vi packet**. Không sửa nó, không thêm field chết vào
  `ServerConfig`.
- Nên composition root **đăng ký** resolver qua `registerCryptoConfigWiring()`, route đọc
  `config.cryptoConfigPane ?? registered`. `createApp` LUÔN gọi hàm này — kể cả `undefined` để
  **xoá** đăng ký cũ; nếu không, test boot hai app trong một process sẽ thừa kế resolver của app
  thứ nhất. Cố ý làm rõ vì đây là hệ quả của việc chọn registry.
- Resolver và applier lấy từ **cùng `cryptoConfig` service** mà JSON API dùng, nên pane không
  thể hiện thứ mà API sẽ từ chối. Test gọi chính hàm wiring thật của composition root
  (`registerAdminCryptoConfigWiring`, export ra cho test), không dựng stub.

### 26.2 RBAC + CSRF: thứ tự cổng mới là điểm quan trọng
1. cookie session hợp lệ, rồi `role >= admin` (cùng guard với GET);
2. **CSRF**: token derive lại từ cookie + secret, so sánh constant-time;
3. mới gọi applier.
- Cổng CSRF chạy **trước** validation, nên request giả mạo không chạm tới tầng kiểm tra sau đó —
  test chứng minh bằng cách assert store VÀ audit đều rỗng sau khi bị 403.
- Save dùng **POST-redirect-GET** (302 + `Location`), nên reload không re-submit mutation.
- Checkbox không tick thì form **không gửi field**, nên vắng mặt = OFF. Ghi rõ vì form không diễn
  đạt được trạng thái 'giữ nguyên', và một lần save bỏ qua toggle còn tệ hơn một lần save tắt nó.

### 26.3 Không rò gì
- Test soi HTML của pane: không có PEM private/public key, admin bearer, cookie secret, CSRF token.
- Có `data-fingerprint-preview` — đó là cấu hình của chính operator, không phải secret.
- Các đường lỗi (CSRF 403, thiếu tenant, applier ném) cũng được soi: không rò message hệ thống.

### 26.4 File đã giao
- **SỬA** `src/app/admin/shell-router.ts` — type `CryptoConfigPaneResolver` / `CryptoConfigApply`,
  `registerCryptoConfigWiring()` + hai accessor nội bộ, matcher nhận POST, `handleCryptoConfigPost`
  với CSRF gate, dispatch tách GET/POST. File này là **CRLF**; chèn bằng script Node và kiểm
  `loneLF=0` sau mỗi lần chèn.
- **SỬA** `src/server.ts` — `registerAdminCryptoConfigWiring()` (export) + gọi trong `createApp`.
- **MỚI** `tests/admin-crypto-config-shell.test.ts` — 9 test / 5 describe, 258 dòng.
- **SỬA** `tests/admin-crypto-config-wiring.test.ts` — 1 assertion cũ đã lỗi thời (xem 26.5).

### 26.5 Bằng chứng + tự sửa (cây cuối; literal `Exit Code:`)
- 3 suite targeted theo packet: **41/41 ×3** (`RUN1/2/3_EXIT_0`), wrapper `Exit Code: 0`.
- `npx tsc --noEmit -p tsconfig.json` — `NO_TS_ERRORS`, Exit Code: 0.
- **Một assertion của chính tôi ở Mục 24 đã lỗi thời:** nó pin `matchShellRoute('POST', …)` là
  `null`, đúng khi form chưa có nơi post. Chu kỳ này mở cửa đó **có chủ đích**, nên tôi cập nhật
  assertion thay vì đóng route lại để giữ test xanh. Đây là thay đổi hợp đồng, ghi rõ.
- Suite mới đứng riêng xanh nhưng **đỏ khi chạy cùng suite khác** — đúng tình huống test pollution do
  registration ở process level mà tôi đã cảnh báo ở 26.1. Đã truy ra và sửa assertion cũ, không che.

### 26.6 Mục 26 KHÔNG chứng minh
- Không có browser, không socket thật, không Vault: mọi thứ in-process với cookie ký thật.
- **Δ98 đã được lane khác đóng** (`PostgresCryptoConfigStore` trong `buildCryptoConfigOptions`,
  nhận thêm `db`) — tôi không làm phần đó, chỉ dùng store mà composition root hiện có.
- **Δ110 (webhook theo policy) vẫn mở.**
- `G-ENC`/`G6` giữ NO-GO; ENC-08 **chưa ACCEPTED**.

## Δ-DEVIATION Mục 26 (chờ coordinator adjudicate)

- **Δ106 ĐÓNG ở mức code + offline.** Pane có dữ liệu thật từ service thật, qua đúng cổng RBAC+CSRF.
- **Δ111 — Registry ở process level là đánh đổi có chủ đích.** `registerCryptoConfigWiring` là
  module-level mutable state, vì `shell-server.ts` ngoài phạm vi. Rủi ro đã giảm bằng việc
  `createApp` luôn ghi (kể cả `undefined`) và test có `afterEach` xóa sạch, nhưng nếu sau này được
  mở rộng quyền sửa `shell-server.ts` thì nên chuyển sang truyền qua `ServerConfig` và **xoá
  registry** này — nếu không sẽ có hai đường cấu hình cho cùng một thứ.
- **Δ112 — CSRF token trong form phải do renderer phát.** Handler đọc `body.csrf`, nhưng renderer
  `crypto-config-renderer.ts` (ngoài phạm vi packet này) **chưa** render hidden field đó. Nghĩa là
  hôm nay submit từ trình duyệt sẽ luôn 403 — fail-closed đúng, nhưng người dùng chưa dùng được.
  Cần packet nhỏ sửa renderer, và token phải lấy từ claims chứ không hardcode.
- **Δ113 — Cổng CSRF kiểm session cookie + secret, chưa phải `verifySessionCsrf` của OIDC.** Với OIDC
  session store thì đường này phải nối lại; ghi để không ai tưởng đã xử lý xong.

### 26.7 Sweep: 2 đỏ mới, đã truy và KHÔNG phải của packet này
- Full sweep offline: **86 pass / 1 skip / 3 fail — 1979 passed / 28 skipped / 2010 total**
  (Mục 25: 87 pass / 1 fail / 1968 passed). Ba đỏ:
  1. `admin-operations-list-pagination` — **Δ92 cũ**, không đổi;
  2. `admin-shell-session-lifecycle` — đòi đúng 1 dòng log security qua **socket thật**;
  3. `adm-base-03-safe-error-offline.functional` — đòi dòng log `deferred section render error` qua **socket thật**.
- **Cả (2) và (3) không phải của packet này, và tôi đã truy tới bằng chứng chứ không đoán:**
  viết một probe tạm (đã xoá) chạy **in-process** cùng các route đó: matcher resolve đúng
  `admin-login` / `section:businesses` / `admin-logout`, security event bắn đúng
  (`auth.login_failed`), `/admin/businesses` trả 200 ⇒ **router của tôi lành**. Cả hai chuỗi log mà
  test đòi vẫn CÒN trong `shell-server.ts`. Cả hai đều fail **ổn định qua 3 lần chạy** (không
  phải flaky ngẫu nhiên), nên nguyên nhân nằm ở tầng socket — đúng vùng ephemeral-port của máy
  này (Δ82) — và `shell-server.ts` (ngoài phạm vi, tôi KHÔNG đụng) bị lane khác sửa lúc **04:15:25**,
  tức **trong lúc tôi đang làm chu kỳ này**.
- Đưa coordinator phân xử: 2 đỏ này thuộc lane sở hữu `shell-server.ts`/test của nó, không sửa
  trong packet này (Δ114).



---


## 27 — CYCLE 27: W-ENC-08-RENDERER-CSRF — render CSRF token trong crypto-config pane (task_1be90638634c)

### 27.0 Packet
- task_1be90638634c / dispatch ctx_6c84c0d694e1: đóng **Δ112** — renderer phát hidden field `csrf`
  trong form `/admin/crypto-config`, khớp đúng token mà POST handler derive lại; không rò secret.
- Phạm vi: `crypto-config-renderer.ts`, `shell-router.ts` (derive + truyền), `tests/**`.

### 27.1 Token là binding, không phải credential
- `deriveCsrfToken(cookieSecret, sessionCookie)` = HMAC của secret với cookie. Nó là **một phần**
  của secret chứ không phải secret. Cross-site page không đọc được (SameSite=Strict chặn đọc
  page) và không tự tính được (không có secret). Render vào DOM là **chuẩn CSRF** hợp pháp —
  đây là lý do assertion cũ của tôi ở Mục 26 cần sửa, xem 27.5.
- Token gắn với CHÍNH session cookie đó. Test chứng minh token của session A không xuất hiện khi
  render cho session B.

### 27.2 Luồng GET: token được nạp cho form
- `handleCryptoConfigGet` đọc `request.cookies['du_admin']` + `config.cookieSecret`, derive token,
  truyền cho `renderCryptoConfig(pane, csrfToken)`.
- Thiếu cookie hoặc secret rỗng ⇒ token rỗng ⇒ renderer hiển thị READ-ONLY (không nút Save).

### 27.3 Luồng POST: CSRF gate là rào duy nhất trước khi ghi
- Form gửi `csrf`; handler `validateCsrfToken` verify lại bằng constant-time compare.
- Sai hoặc thiếu ⇒ **403** và **applier không bao giờ chạy** (test assert store + audit rỗng).
- Save dùng POST-redirect-GET (302 + `Location`), reload không re-submit.

### 27.4 File đã giao
- **SỬA** `src/app/admin/crypto-config-renderer.ts` — `renderCryptoConfigForm(pane, csrfToken?)` và
  `renderCryptoConfig(pane, csrfToken?)`; có token ⇒ `<input type="hidden" name="csrf">`;
  không có ⇒ READ-ONLY (không nút Save, có banner, `data-crypto-config-readonly`).
- **SỬA** `src/app/admin/shell-router.ts` — import `deriveCsrfToken`, derive trong GET, truyền xuống.
- **SỬA** `tests/admin-crypto-config-shell.test.ts` — 3 test mới + sửa 1 assertion cũ (27.5).

### 27.5 Tự sửa: assertion hợp đồng cũ của chính tôi (Mục 26)
- Mục 26 tôi viết `expect(html).not.toContain(deriveCsrfToken(...))`, tức coi token như secret.
  **Sai theo thiết kế CSRF**: token phải nằm trong form, nếu không mọi save từ browser là 403
  (đó chính là Δ112). Sửa thành: token CÓ trong HTML, token của session KHÁC thì KHÔNG, và
  cookie secret thì tuyệt đối KHÔNG. Không nới lỏng để cho xanh — đổi đúng tính chất cần pin.
- **Guard read-only là phòng thủ, không phải trạng thái bình thường**: qua route, một session
  hợp lệ đã hàm ý secret non-empty nên token luôn có. Test nó ở tầng renderer (gọi trực tiếp
  `renderCryptoConfigForm(pane, '')`) thay vì dựng một kịch bản route không tồn tại — không tạo
  ảo trạng thái để test xanh.

### 27.6 Bằng chứng (cây cuối; literal `Exit Code:`)
- `tests/admin-crypto-config-shell.test.ts` + `tests/admin-crypto-config.test.ts` (packet yêu cầu):
  **47/47**, cả hai suite xanh.
- 4 suite ENC (thêm wiring + enc08-wire-enc07): **79/79 ×3** (`RUN1/2/3_EXIT_0`), wrapper `Exit Code: 0`.
- `npx tsc --noEmit -p tsconfig.json` — `NO_TS_ERRORS`, Exit Code: 0.
- Full sweep offline: **84 pass / 1 skip / 5 fail — 1951 passed / 28 skipped / 1984 total**
  (Mục 26: 86 pass / 3 fail / 1979 passed). **Không suite crypto nào trong danh sách đỏ.**
  Năm đỏ: (1) `admin-operations-list-pagination` — Δ92 cũ; (2) `admin-shell-session-lifecycle` —
  Δ114 socket thật; (3) `adm-base-03-safe-error-offline.functional` — Δ114 socket thật;
  (4) `url-ingestion-consumer-offline.functional` — **MỚI, không phải của tôi**: lỗi compile
  `TS2304 Cannot find name` ngay trong file test của lane khác (dòng 1232/1253) ⇒ họ đang sửa dở;
  (5) `admin-shell-server` — **MỚI, không phải của tôi**: cùng họ socket thật, phụ thuộc
  `shell-server.ts` mà tôi không đụng (mtime 04:15:25, trước cả chu kỳ này).
  Tổng test 2010 → 1984 vì (4) fail lúc biên dịch nên test của nó không được tính. Đưa
  coordinator theo dõi, không sửa trong packet này (Δ117).
- **Test quan trọng nhất là end-to-end**: lấy token RA khỏi HTML đã render, POST lại đúng như
  trình duyệt, và store cập nhật + 302. Đây mới là bằng chứng Δ112 đóng — chứng minh token trong
  DOM **là** token mà POST gate chấp nhận, chứ không chỉ hai chuỗi trùng tên.

### 27.7 Mục 27 KHÔNG chứng minh
- **Δ112 ĐÓNG ở mức code + offline.** Không có HTTP qua socket thật, không browser, không cookie
  thật do trình duyệt mints: test dùng cookie đã ký thật qua `signCookie` + CSRF derive thật, nên
  đường kiểm là đường thật, nhưng chưa đi qua listener.
- **Δ110 vẫn mở:** webhook dispatcher chưa theo policy (ngoài phạm vi).
- **Δ113 vẫn mở:** cổng CSRF kiểm session cookie + secret; với OIDC session store thì phải nối
  `verifySessionCsrf`. Ghi lại để không ai tưởng đã xử lý xong.
- `G-ENC`/`G6` giữ NO-GO; ENC-08 **chưa ACCEPTED**.

## Δ-DEVIATION Mục 27 (chờ coordinator adjudicate)

- **Δ112 ĐÓNG ở mức code + offline.** Form giờ tự mang bằng chứng CSRF mà cổng POST kiểm.
- **Δ115 — Tôi sửa một assertion hợp đồng của chính mình** (Mục 26 coi token là secret). Ghi công khai
  vì đây là thay đổi ý nghĩa test, không phải chỉnh lỗi kỹ thuật; ai đọc receipt Mục 26 cần biết
  assertion đó đã bị thay ở Mục 27 này.
- **Δ116 — Read-only branch gần như không reachable qua route** (session hợp lệ ⇒ luôn có secret ⇒
  luôn có token). Nó là guard phòng thủ, được test ở tầng renderer. Ghi để không ai coi đây là một
  trạng thái vận hành thật.



---


## 28 — CYCLE 28: W-ENC-08-CSRF-OIDC — session plane sở hữu CSRF của crypto-config (task_b5bf4dc1e21a)

### 28.0 Packet
- task_b5bf4dc1e21a: đóng **Δ113** — nối OIDC `verifySessionCsrf` vào cổng CSRF của crypto-config khi có
  session store, cho CSRF nhất quán giữa session cookie thường và session OIDC.
- Phạm vi: `src/app/admin/shell-router.ts`, `tests/**`.

### 28.1 Vấn đề thật, không phải hình thức
- Trước chu kỳ này, `handleCryptoConfigPost` **luôn** verify bằng `validateCsrfToken` — tức token derive
  từ `cookieSecret` + cookie `du_admin` — kể cả khi request đi trên `du_session` của OIDC.
- Dưới OIDC điều đó sai theo **một trong hai hướng**: hoặc form được trao một token mà cổng sẽ từ chối,
  hoặc cổng chấp nhận một token được mint cho mặt phẳng khác. Cả hai đều là hỏng.
- Nguyên tắc đã có sẵn trong nhà: session store đã **quyết định danh tính** trước legacy cookie và
  **không** lùi về legacy. Δ113 mở rộng đúng nguyên tắc đó sang CSRF: **session plane quyết định
  bằng chứng, không có fallback.**

### 28.2 Sửa gì (4 điểm, tất cả trong shell-router.ts)
1. `resolveOpaqueSession` mang thêm `csrfToken` của session vào outcome `live` (trước đó bị bỏ qua).
2. `handleCryptoConfigGet`: khi request mang `du_session` và store được wire ⇒ đọc token từ store;
   ngược lại mới derive từ `du_admin`. Renders đúng thứ mà POST sẽ verify.
3. `handleCryptoConfigPost` nhận `oidcCsrfToken`: **có** ⇒ verify bằng `verifySessionCsrf` (primitive
   thật của OIDC: check định dạng 43 ký tự + `timingSafeEqual`); **không** ⇒ `validateCsrfToken` legacy.
4. `dispatchShellRequestAsync` truyền `outcome.csrfToken` xuống sync dispatcher (tham số thứ 4, optional
   nên mọi caller cũ giữ nguyên hành vi).

### 28.3 Vì sao gọi `verifySessionCsrf` chứ không tự viết phép so sánh
- `verifySessionCsrf` nhận `SessionRecord`, còn store của shell trả `AdminSessionView`. Tôi **narrowing
  có chủ đích** (`as SessionRecord`) vì hàm chỉ đọc đúng một field là `csrfToken` — và `AdminSessionView`
  là projection mang field đó. Ghi rõ trong code.
- Lý do dùng lại primitive thật thay vì so sánh tay: đó là cách bảo đảm **hai mặt phẳng không trôi
  lệch nhau**. Một phép so sánh thứ hai viết tay chính là nơi chúng sẽ phân kỳ theo thời gian.

### 28.4 File đã giao
- **SỬA** `src/app/admin/shell-router.ts` — 4 điểm nêu trên. Import thêm `verifySessionCsrf` +
  type `SessionRecord` từ `modules/auth/session-store`. File là **CRLF**.
- **MỚI** `tests/admin-crypto-config-oidc.test.ts` — 233 dòng, **6 test**, self-contained (không
  sửa file test cũ).

### 28.5 Sáu test mới — và 2 lần fixture của tôi sai trước khi xanh
1. pane render **token của session**, không phải token derive legacy;
2. POST mang token của session ⇒ 302 + thay đổi được lưu;
3. **token derive legacy bị TỪ CHỐI** khi session đi kèm — không fallback, store + audit rỗng;
4. token sai ⇒ 403 và applier không bao giờ chạy;
5. **triển khai legacy-ONLY không đổi**: không store ⇒ vẫn derive `du_admin`, và **không** chứa token OIDC;
6. `du_session` mà store không có record ⇒ không có token ⇒ pane READ-ONLY (không nút Save).
- **Hai lỗi fixture của chính tôi, đáng ghi vì chúng là bằng chứng về chất lượng primitive:**
  (i) token của tôi dài **42** ký tự, `CSRF_RE` của primitive thật yêu cầu 43 ⇒ test đỏ **đúng**, và
  đó là hình thức format-check đang làm việc chứ không phải test hỏng. (ii) key record thiếu
  `tenantId` ⇒ `recipientKeyOptions` lọc rỗng ⇒ mọi pin bị từ chối ⇒ applier ném. Cả hai là fixture
  của tôi, sửa fixture chứ không sửa source.

### 28.6 Bằng chứng (cây cuối; literal `Exit Code:`)
- 3 suite theo packet (`admin-crypto-config-shell` + `admin-crypto-config` + `admin-shell-auth`):
  **105/105** (76 + 29).
- 4 suite ENC (thêm `-oidc` + `-wiring`): **76/76 ×3** (`RUN1/2/3_EXIT_0`), wrapper `Exit Code: 0`.
- `npx tsc --noEmit -p tsconfig.json` — `NO_TS_ERRORS`, Exit Code: 0.
- Full sweep offline: **88 pass / 1 skip / 3 fail — 1997 passed / 28 skipped / 2028 total**
  (Mục 27: 84 pass / 5 fail / 1951 passed). **Không suite crypto nào đỏ.** Ba đỏ đều là đỏ đã biết:
  `admin-operations-list-pagination` (Δ92 cũ), `admin-shell-session-lifecycle` và
  `adm-base-03-safe-error-offline.functional` (Δ114, socket thật). **Hai đỏ mới ở Mục 27 đã xanh**
  (`url-ingestion-consumer` compile lại được, `admin-shell-server` xanh) — lane sở hữu đã tự sửa,
  không cần tôi can thiệp. +46 test so với Mục 27.

### 28.7 Mục 28 KHÔNG chứng minh
- **Δ113 ĐÓNG ở mức code + offline.** Không chạy IdP thật, không socket: store là stub, nhưng phép
  so sánh CSRF là **primitive thật** nên định dạng + constant-time là bản production.
- **Δ110 vẫn mở** (webhook dispatcher chưa theo policy) — mắt xích cuối của chuỗi ENC.
- Luồng `dispatchShellRequestAsync` (nơi token được truyền vào) **không** được test ở đây: nó cần OIDC
  flow mount, và các suite OIDC hiện có (session-lifecycle) đang đỏ vì lý do khác (Δ114). Ghi để không
  ai đọc "ĐÓNG" thành "đã chạy qua async gate".
- `G-ENC`/`G6` giữ NO-GO; ENC-08 **chưa ACCEPTED**.

## Δ-DEVIATION Mục 28 (chờ coordinator adjudicate)

- **Δ113 ĐÓNG ở mức code + offline.** Cả hai mặt phẳng CSRF giờ dùng primitive và nguồn token khớp nhau.
- **Δ118 — Narrowing `as SessionRecord` là có chủ đích nhưng là kiểu ép.** `verifySessionCsrf` nhận
  `SessionRecord` trong khi store của shell trả `AdminSessionView`; hàm chỉ đọc `csrfToken`. Sạch hơn nếu
  rbac hoặc session-store export một hàm nhận `{ csrfToken: string }` — nhưng cả hai file đó ngoài phạm vi
  packet này. Ghi để reviewer quyết định có nên mở một task dọn kiểu hay không.
- **Δ119 — Đường async (`dispatchShellRequestAsync`) chưa có test cho phần truyền token.** Bọc nó cần OIDC
  flow; nếu sau này sửa chỗ gọi ở đó, có thể hỏng mà không có test bắt. Đề nghị follow-on nhỏ.



---


## 29 — CYCLE 29: W-ENC-08-WEBHOOK — webhook dispatcher tuân delivery policy (task_f0bcba8aa961)

### 29.0 Packet
- task_f0bcba8aa961 / ctx_03ff4b81e2fc: đóng **Δ110** — nối delivery encryption policy vào webhook
  dispatcher. Khi tenant bật delivery encryption, payload webhook phải mã hóa theo đúng policy
  đó (cùng policy với `/result` và `/download`), giữ nguyên khi tắt.
- Phạm vi: `src/modules/webhooks/webhooks.ts`, `src/server.ts`, `tests/**`.

### 29.1 Khoảng trống mà packet nêu, xác nhận bằng đọc code
- `deliverWebhooks` dựng body thẳng từ `row.payload` và ký HMAC rồi POST. Không có bước nào đọc
  policy của tenant ⇒ một tenant đã bật delivery encryption vẫn **nhận webhook operation của mình
  ở dạng rõ**. Ba bề mặt cùng tenant, hai bề mặt mã hóa, một bề mặt thì không — đúng khoảng
  trống Δ110 mô tả.
- Bảng `webhook_deliveries` đã có `tenant_id` (ghi lúc schedule) nhưng SELECT claim **không lấy**
  cột đó, nên dispatcher thậm chí không biết policy của ai là để tra. Phải lấy thêm.

### 29.2 Sửa gì
1. **Port hẹp** `WebhookDeliveryEncryption` (chỉ `resolvePolicy` + `encryptForDelivery`) trong
   `WebhookDispatcherOptions`. Không import cả module public-api: dispatcher phụ thuộc **hành vi**,
   service thật của ENC-07 thỏa mãn nguyên vẹn. Absent ⇒ mọi webhook y như cũ.
2. **`WebhookDeliveryRow` mang `tenant_id`** + claim SELECT lấy thêm cột đó.
3. **`buildWebhookBody`**: tra policy của `row.tenant_id`; bật ⇒ mã hóa và trả về đúng hình dạng
   envelope ENC-08 mà `/result` và `/download` đang dùng, nên phía nhận giải mã bằng CÙNG một code.
4. **Ký SAU khi mã hóa.** Đây là điểm dễ làm sai nhất: ký plaintext rồi mới hoán body thì chữ ký
   xác thực một thứ mà bên nhận không bao giờ có — hỏng toàn vẹn trong im lặng. Test chứng minh chữ ký
   verify được với body đã mã hóa và **không** verify được với plaintext.
5. **Fail-closed**: lỗi đọc policy hoặc lỗi mã hóa ⇒ **không POST gì cả**, row nhận mã cố định
   `WEBHOOK_ENCRYPTION_FAILED`. Policy đọc lỗi KHÔNG phải bằng chứng tenant đang tắt.
6. **`server.ts`** truyền `deliveryEncryption` (service đã dựng ở `createApp`) vào `deliverWebhooks`,
   dùng `?? undefined` để nền tảng không có crypto-config giữ nguyên hành vi cũ.

### 29.3 File đã giao
- **SỬA** `src/modules/webhooks/webhooks.ts` — port `WebhookDeliveryEncryption`, option
  `deliveryEncryption`, `tenant_id` trên `WebhookDeliveryRow` + claim SELECT, `buildWebhookBody`,
  thứ tự mã-hóa-trước-ký, nhánh fail-closed, mã cố định `WEBHOOK_ENCRYPTION_FAILED` (exported để
  runbook grep được, đúng như `WEBHOOK_SHUTDOWN_RELEASED`).
- **SỬA** `src/server.ts` — truyền service thật vào `deliverWebhooks` (`?? undefined`).
- **MỚI** `tests/webhook-delivery-encryption.test.ts` — 334 dòng, **5 test**, self-contained.

### 29.4 Năm test mới — và ba lỗi của chính tôi trước khi xanh
1. policy BẬT: body trên wire là envelope ENC-08, plaintext **không** còn trong body, và external
   recipient giải mã ra **đúng payload gốc** (dùng service + registry + keypair THẬT, không dùng
   stub nên đây là bằng chứng crypto chạy thật chứ không phải so khớp mẫu);
2. **chữ ký HMAC phủ body ĐÃ mã hóa**: verify được với body trên wire, **không** verify được với
   plaintext mà nó mã hóa — đó đúng là hỏng toàn vẹn im lặng mà thứ tự ký này chặn;
3. policy TẮT: body **giống hệt** payload trước ENC-07 (so sánh chuỗi, không phải mẫu);
4. **policy đọc lỗi ⇒ fail-closed**: không POST gì, row nhận `WEBHOOK_ENCRYPTION_FAILED`;
5. **hai tenant trong một sweep quyết định độc lập** — chứng minh quyết định theo tenant của dòng, không
   phải một công tắc toàn cục.
- **Ba lỗi của tôi (đều ở test, không đụng source):** (i) khai `tx` thành hằng rời mà không gắn vào db ⇒
  `db.tx is not a function`; (ii) đọc `params[2]` cho `last_error` trong khi release SQL dùng `$4`;
  (iii) import hai header constant từ `webhooks` trong khi chúng thuộc `@du/contracts`. Ghi công khai
  vì (ii) là loại lỗi âm thầm: đọc sai chỉ số làm test pass với thông báo sai.

### 29.5 Bằng chứng (cây cuối; literal `Exit Code:`)
- 5 suite liên quan (`webhook-delivery-encryption` + `webhook-error-boundaries.boundary` +
  `enc08-wire-enc07` + `admin-crypto-config-oidc` + `admin-crypto-config-shell`): **64/64 ×3**,
  `RUN1/2/3_EXIT_0`, wrapper `Exit Code: 0`.
- `npx tsc --noEmit -p tsconfig.json` — `NO_TS_ERRORS`, Exit Code: 0.
- Full sweep offline: **92 pass / 1 skip / 3 fail — 2014 passed / 28 skipped / 2045 total**
  (Mục 28: 88 pass / 3 fail / 1997 passed). **Không suite crypto hay webhook nào đỏ**; ba đỏ là bộ 3 đỏ
  đã biết từ Mục 27 trở đi (Δ92 cũ + 2 socket Δ114).
- **Trong lúc chạy, `server.ts` + `@du/contracts` đang được lane khác refactor admin business list**
  (thiếu export, thiếu hàm) làm đỏ 19 lỗi TS. **Tôi không chạm các file đó** (tiền lệ Δ80/Δ81):
  poll 2 lần, lỗi tự giảm 19 → 12 → 0 khi họ xong, rồi mới chốt số liệu trên. Đây là lần thứ ba
  trong các chu kỳ gần đây mà Δ80 lặp lại.

### 29.6 Mục 29 KHÔNG chứng minh
- **Δ110 ĐÓNG ở mức code + offline.** Không có IdP, không socket, không DB thật: db là scripted, fetch
  được inject. Nhưng envelope do **service thật** sinh ra và được **private key thật** giải mã.
- Chữ ký webhook giờ phủ body đã mã hóa ⇒ **bên nhận phải xác minh chữ ký trên body nó thực sự
  nhận**. Đây là hệ quả **đúng** của việc mã hóa (chữ ký trên plaintext sẽ vô nghĩa với ciphertext),
  nhưng là **thay đổi hợp đồng phía nhận** cần nói rõ cho lane khác: receiver phải verify trên body
  đã nhận, không dựng lại plaintext để verify (Δ120).
- **Đơn vị tiêu chí:** `webhook_deliveries.payload` trong DB vẫn lưu payload **plaintext**; chỉ thứ lên
  wire được mã hóa. Đó là ranh giới đúng cho ENC-08 (mã hóa lúc giao), nhưng nghĩa là metadata
  bền vững chưa được bọc — việc đó là ENC-META-01, không phải packet này (Δ121).
- `G-ENC`/`G6` giữ NO-GO; ENC-08 **chưa ACCEPTED** (còn Δ120/Δ121 + browser E2E).

## Δ-DEVIATION Mục 29 (chờ coordinator adjudicate)

- **Δ110 ĐÓNG ở mức code + offline.** Cả ba bề mặt delivery của một tenant giờ do CÙNG một policy
  điều khiển — `/result`, `/download`, và webhook.
- **Δ120 — Đổi hợp đồng phía nhận webhook: chữ ký phủ ciphertext.** Trước đây receiver có thể dựng lại
  payload từ `deliveryId` để verify chữ ký; nay phải verify trên ĐÚNG body đã nhận. Đây là hệ quả
  đúng (ký plaintext rồi gửi ciphertext là hỏng toàn vẹn im lặng), nhưng receiver nào đang làm cách cũ
  sẽ hỏng. **Cần thông báo tới lane sở hữu phía nhận + docs 06.**
- **Δ121 — `webhook_deliveries.payload` trong DB vẫn là plaintext.** Chỉ thứ lên wire được bọc. Đúng với
  ENC-08 (mã hóa lúc giao) nhưng metadata bền vững thì thuộc ENC-META-01. Ghi để không ai tưởng
  ENC-08 đã đóng luôn cả đường bền vững.
- **Δ122 — Lỗi mã hóa tiêu tốm ngân sách retry.** Một tenant bật policy nhưng thiếu key dùng được sẽ
  fail mọi webhook cho tới khi key về, mỗi lần một attempt. Đúng hơn là gửi rõ, nhưng với tenant
  webhook-heavy thì 5 lần fail là toàn bộ budget. Nếu muốn, tách budget cho lỗi crypto khỏi lỗi
  receiver — chưa làm vì ngoài phạm vi packet này.
- **Δ123 — Type port `WebhookDeliveryEncryption` lặp lại shape của `DeliveryEncryptionService`.** Hai nơi
  khai cùng một hợp đồng là chỗ chúng có thể trôi lệch. Ở đây cố ý chọn khai lại (webhooks không
  nên import module public-api); nếu sau này service đổi method, port này phải theo.



---


## 30 — CYCLE 30

**W-ADM-UX-02-AUDIT-PAGE** (task_478e15090f32 / ctx_f53c772c1589) — bộ lọc audit + keyset sort
allowlist cho `GET /api/v1/admin/audit`.

### 30.1 Phạm vi thực thi

| File | Thay đổi |
|---|---|
| `packages/contracts/src/public-api.ts` | `ADMIN_AUDIT_LIST_QUERY_PARAMS` +5 tên (`actor`,`resource`,`from`,`to`,`sort`); allowlist sort **riêng** `ADMIN_AUDIT_LIST_SORT_VALUES` (2 giá trị) + `ADMIN_AUDIT_LIST_SORT_DEFAULT`; `AdminAuditListSortSchema`; `ADMIN_LIST_TIME_PATTERN` + `isAdminListTimeBound()`; `AdminAuditListQuerySchema` +5 field |
| `services/orchestrator/src/server.ts` | `interface AdminAuditListQuery` +5 field + đổi kiểu cursor; `parseAdminAuditListQuery` đọc 5 param mới, validate sort/cross-sort, `parseAdminListTimeBound()` mới; `listAuditEventPage` chuyển `keysetPage` → `sortableAdminKeysetPage`; executor: `sortColumns` `Partial` + guard 422 |
| `tests/admin-audit-list-page.test.ts` | **MỚI, 30 test** |
| `tests/admin-list-contract-conformance.test.ts` | 3 khai báo cũ cập nhật theo hợp đồng mới (xem 30.5) |

### 30.2 Vì sao allowlist sort của audit KHÔNG dùng chung `ADMIN_RESOURCE_LIST_SORT_VALUES`

Đây là quyết định thiết kế, không phải lười. `admin_audit_events` (migration `0010_admin_audit.sql`)
có **đúng một cột thời gian: `created_at`** — không có `updated_at`. Nếu tái dùng allowlist 4 giá trị
của business/version/api-key thì `?sort=updatedAt:desc` sẽ trở thành `ORDER BY updated_at` trên một
bảng không có cột đó: lỗi SQL lúc chạy, không phải 422. Nên audit có allowlist **riêng, là tập con**:

- `ADMIN_AUDIT_LIST_SORT_VALUES = ['createdAt:asc', 'createdAt:desc']`
- `ADMIN_AUDIT_LIST_SORT_DEFAULT = 'createdAt:desc'` — **trùng byte-for-byte với hành vi cũ**
  (`keysetPage` hardcode `ORDER BY created_at DESC, id DESC`), nên URL cũ vẫn ra cùng lát cắt.

Codec cursor **vẫn dùng chung** `encode/decodeAdminResourceListSortCursor` (tập con nên encode/decode
không đổi). `sortColumns` trong executor đổi `Record` → `Partial<Record<...>>` kèm guard: sort field
caller chưa map thì **422**, không bao giờ dựng `ORDER BY` trên cột không tồn tại. Ba executor cũ
(business/version/api-key) truyền đủ 2 key nên hành vi của chúng **không đổi**.

### 30.3 Bộ lọc mới — toàn bộ là tham số bind

| Param | SQL | Ghi chú |
|---|---|---|
| `actor` | `strpos(lower(actor), lower($n)) > 0` | qua `sanitizeAdminListToken` → chặn hex 32+ |
| `resource` | `strpos(lower(resource), lower($n)) > 0` | như trên |
| `from` | `created_at >= $n::timestamptz` | UTC bắt buộc |
| `to` | `created_at <= $n::timestamptz` | đóng hai đầu |
| `sort` | chọn hướng `ORDER BY` | allowlist 2 giá trị, ngoài = 422 |

Cả 5 filter **và** `count(*)` dùng chung một mảng `clauses`, nên `total` không bao giờ lệch với tập
đã lọc — có test riêng cho từng filter (kể cả time window) trên **query count**.

`from`/`to` chỉ nhận **instant UTC** (`...Z`). `isAdminListTimeBound` kiểm tra cả hình dạng lẫn
lịch thật: `Date.parse('2026-02-30T00:00:00Z')` **không** NaN — nó lăn sang tháng 3 — nên nếu chỉ
so khớp regex thì ngày không tồn tại lọt qua. Hàm so lại `toISOString().slice(0,19)` với tiền tố
đầu vào nên chặn được. Offset `+07:00` cũng bị từ chối: ledger là UTC, giờ địa phương là mơ hồ.
Cửa sổ đảo ngược (`from > to`) là **422** chứ không phải trang rỗng — trang rỗng sẽ đọc như
"không có gì xảy ra trong khoảng đó", tức là một câu trả lời sai.

### 30.4 Bằng chứng

Lệnh (chạy ở `du-rework`):

```
pnpm --filter @du/contracts build                                    # Exit Code: 0
pnpm --filter @du/orchestrator typecheck                             # Exit Code: 0
pnpm --filter @du/orchestrator test -- tests/admin-audit-list-page.test.ts \
  tests/admin-list-contract-conformance.test.ts tests/admin-audit-scope.test.ts \
  tests/admin-sort-allowlist.test.ts
```

- Suite mới: **30/30 pass** (`admin-audit-list-page.test.ts`), 4 `describe`, 0 network.
- 4 suite liên quan: **81 passed / 81 total**, `Test Suites: 4 passed, 4 total` — chạy **3 lần**,
  cả 3 đều exit 0 (PASS theo luật 3 lần liên tiếp).
- `tsc --noEmit` orchestrator: **Exit Code: 0**.

### 30.5 Ba khai báo cũ phải cập nhật, và vì sao đó là đúng

Đây là thay đổi hợp đồng thật, nên ba chỗ cũ **sai** sau khi tính năng lên:

1. `admin-list-contract-conformance.test.ts` chốt `ADMIN_AUDIT_LIST_QUERY_PARAMS` bằng
   `toEqual([...5 tên])` → nay là 10 tên.
2. Cùng file đó dùng `actor=' OR 1=1--` làm ví dụ "param **không** khai báo bị bỏ qua". Nay
   `actor` **đã** khai báo nên phải là 422. Tôi tách thành hai assertion: `&note=whatever`
   (tên chưa khai báo → vẫn 200, không lọt vào SQL) và `&actor=' OR 1=1--` (→ 422). Ý nghĩa của
   test được giữ nguyên, chỉ chọn đúng ví dụ cho từng nhánh.
3. Cùng file đó decode cursor audit bằng `decodeListCursor` (dialect 3-slot của operations list).
   Audit **giờ phát cursor có ràng buộc sort** (4-slot, `encodeAdminResourceListSortCursor`) — cùng
   họ với business/version/api-key. Đổi sang codec đúng và **thêm** assertion cursor mang
   `sort: 'createdAt:desc'`.

Hệ quả cần coordinator biết: **mọi token `nextCursor`/`prevCursor` do bản cũ phát ra sẽ bị 422** khi
replay vào bản mới (đây chính là fail-closed mong muốn — xem Δ124).
### 30.6 Đỏ trong sweep — quy kết không phải của lane này

Sweep offline đầy đủ: `3 failed, 216 skipped, 2065 passed, 2284 total`
(`Test Suites: 3 failed, 16 skipped, 95 passed, 98 of 114 total`). Cả **3** đều nằm ở file tôi không
sửa, và `mtime` của chúng đều cũ hơn thay đổi của tôi:

| Suite | Nguyên nhân | Owner |
|---|---|---|
| `admin-operations-list-pagination.test.ts` | Δ92 — `wrapTablesForReflow` đổi `aria-label` từ `"Scrollable table"` sang `"Scrollable data table 1 of 1"`; `shell-render.ts` mtime 28/09 02:54 | lane khác sửa renderer |
| `adm-base-03-safe-error-offline.functional.test.ts` | Δ114 — test socket thật | lane khác |
| `admin-shell-session-lifecycle.test.ts` | `W-SEC-AUDIT-TAXONOMY-1` — bắt `console.warn` 1 dòng, nhận 0; mtime 26/09 | Qwen-SEC (Mục 11) |

Không suite nào trong 3 đó chạm route audit list. Không có đỏ nào do Mục 30.

### 30.7 Sai sót của chính tôi trong lúc làm (ghi công khai)

- **Lỗi splice của tôi, không phải lỗi code:** script ghép file đầu tiên cộng `\n` vào mỗi dòng
  fragment rồi lại `join("\n")`, nên hai vùng dùng EOL `\n` bị chèn dòng trống xen kẽ. Phát hiện
  bằng quét "hai dòng trống liên tiếp" (3 cặp; 2 cặp còn lại là **có sẵn từ trước** ở dòng 2680 và
  3286, không nằm trong vùng tôi sửa), sửa và xác minh lại. Typecheck ngay sau đó exit 0.
- **Bốn kỳ vọng sai trong test của tôi** (đã sửa, không phải bug sản phẩm): tôi quên `LIMIT` cũng
  được bind nên mảng `params` có phần tử cuối; và tôi khẳng định SQL trang-1 có mệnh đề
  `(created_at, id)` — sai, chỉ khi **có cursor** mới có mệnh đề biên. Ba lỗi này lộ ra vì tôi tin
  bản thân thay vì chạy thử.
- **Ba khai báo cũ trong `admin-list-contract-conformance.test.ts` sai sau thay đổi này** — đã cập
  nhật, xem 30.5. Đây là thay đổi hợp đồng có chủ đích, không phải nới lỏng.

---
## Δ-DEVIATION Mục 30 (chờ coordinator adjudicate)

- **Δ124 — Đổi DIALECT cursor của `/api/v1/admin/audit` (thay đổi hợp đồng, cần thông báo).** Trước
  Mục 30 route này phát cursor 3-slot qua `encodeListCursor` (`<ISO>|<uuid>[|p]`) và decode bằng
  `decodeListCursor`. Nay nó dùng chung `encode/decodeAdminResourceListSortCursor` với
  business/version/api-key — 4 slot, có **mã sort**, và **cursor phát ra dưới sort A sẽ bị 422** khi
  replay dưới sort B. Đây là cùng hình thức T140-A1 đã áp cho operations list, và là điều ADM-UX-02
  đòi hỏi, nhưng nó **làm hỏng mọi client đang giữ token cũ** (deep-link đã lưu, script đã chạy).
  Mặt fail-closed vẫn đúng: 422 kèm remedy trong message thay vì đọc sai lát cắt. Cần nói rõ trong
  docs 06 / release note nếu route này đã từng có client ngoài.
- **Δ125 — Chạm `packages/contracts/src/public-api.ts`, ngoài phạm vi file packet nêu.** Packet ghi
  "tại services/orchestrator", nhưng `parseAdminAuditListQuery` đọc tên tham số **từ** mảng contract
  `ADMIN_AUDIT_LIST_QUERY_PARAMS` (khoá T70-C1: tham số ngoài contract là lỗi biên dịch). Thêm
  `actor`/`resource`/`from`/`to`/`sort` mà không khai báo ở contracts thì hoặc là lỗi biên dịch,
  hoặc là đọc literal trong orchestrator — phá đúng thứ mà T70-C1 đã khoá. Nên tôi sửa cả hai nơi
  và coi đây là hệ quả bắt buộc của packet, không phải mở rộng phạm vi tự ý.
- **Δ126 — `ADMIN_AUDIT_LIST_SORT_VALUES` là tập con, không dùng chung `ADMIN_RESOURCE_LIST_SORT_VALUES`.**
  `admin_audit_events` không có `updated_at`; tái dùng allowlist 4 giá trị sẽ tạo `ORDER BY` trên cột
  không tồn tại (lỗi SQL lúc chạy) thay vì 422. Hệ quả cần biết: **allowlist giờ KHÔNG đồng nhất**
  giữa 4 list — audit 2 giá trị, ba list kia 4 giá trị. Nếu sau này thêm `updated_at` vào ledger
  (migration), phải nhớ mở rộng lại allowlist audit.
- **Δ127 — `sortColumns` trong `sortableAdminKeysetPage` đổi `Record` → `Partial<Record>`.** Đây là
  executor dùng chung của **4** route. Ba caller cũ truyền đủ 2 key nên hành vi không đổi (đã xác
  nhận: `admin-sort-allowlist` + `operations-list-cursor-sort-binding` vẫn xanh), nhưng đây là
  thay đổi đụng bề mặt chung nên ghi ra để Reviewer soi.
- **Δ128 — Chưa có index phục vụ `actor`/`resource`/`from`.** Index hiện có là
  `admin_audit_events_tenant_time (tenant_id, created_at DESC)` — phục vụ sort + time window,
  **không** phục vụ hai cột text khi lọc `strpos(lower(...))` (và `strpos` dùng dẩu-sequential scan
  vốn không index được trừ khi dùng `pg_trgm`). Với ledger lớn, filter actor sẽ quét. Cần
  **DB window** để đo và cân nhắc `pg_trgm`; tôi không đo được offline nên **không** tuyên bố
  gì về query plan.
- **Δ129 — ADM-UX-02 vẫn `[~]`, `G-ADMIN-OPS` vẫn NO-GO.** Mục này đóng được phần *code* của
  filter + sort + keyset cho audit, nhưng **không** có: index cho filter actor/resource (Δ128),
  kiểm thử live keyset trong DB window (cursor audit chưa từng có bằng chứng live), và UI sort
  control cho pane audit (ADM-UX-03 vẫn `[ ]`). Toàn bộ bằng chứng ở đây là **offline**.
## Ledger
- 30 — W-ADM-UX-02-AUDIT-PAGE (task_478e15090f32 / ctx_f53c772c1589): bộ lọc audit + keyset sort allowlist cho `GET /api/v1/admin/audit` — SỬA `packages/contracts/src/public-api.ts` (`ADMIN_AUDIT_LIST_QUERY_PARAMS` 5→10 tên; **allowlist sort RIÊNG** `ADMIN_AUDIT_LIST_SORT_VALUES = [createdAt:asc, createdAt:desc]` vì `admin_audit_events` không có `updated_at` — tái dùng allowlist 4 giá trị sẽ dựng `ORDER BY` trên cột không tồn tại; `ADMIN_LIST_TIME_PATTERN` + `isAdminListTimeBound` chặn cả ngày không tồn tại vì `Date.parse("2026-02-30...")` **không** NaN mà lăn sang tháng 3; `AdminAuditListQuerySchema` +5 field) + SỬA `src/server.ts` (`actor`/`resource` qua `sanitizeAdminListToken` nên hex 32+ = 422; `from`/`to` là `created_at >= / <= $n::timestamptz` đóng hai đầu, cửa sổ đảo ngược = 422 chứ không phải trang rỗng; `listAuditEventPage` chuyển `keysetPage` → `sortableAdminKeysetPage` dùng chung executor 4 route; `sortColumns` `Record`→`Partial` + guard 422) + MỚI `tests/admin-audit-list-page.test.ts` (**30 test / 4 describe**) + SỬA 3 khai báo lỗi thời trong `admin-list-contract-conformance.test.ts`. Mọi filter dùng chung một mảng `clauses` với `count(*)` nên `total` không lệch tập đã lọc (test riêng cho từng filter trên query count). Evidence: suite mới **30/30**, 4 suite liên quan **81/81 ×3 Exit Code: 0**, contracts build + tsc `Exit Code: 0`, sweep **2065 passed / 216 skipped / 2284 total, 3 đỏ — không đỏ nào thuộc lane** (Δ92 renderer aria-label, Δ114 socket, W-SEC-AUDIT-TAXONOMY-1 của Qwen-SEC; cả 3 file tôi không sửa, mtime cũ hơn thay đổi của tôi). Tự ghi công khai: script ghép file của tôi chèn dòng trống xen kẽ ở 2 vùng EOL LF (quét "2 dòng trống liên tiếp" bắt, sửa, tsc xanh) + 4 kỳ vọng sai trong test của tôi (quên LIMIT cũng bind; khẳng định SQL trang-1 có mệnh đề `(created_at, id)` trong khi chỉ có khi **có cursor**). Δ124 **ĐỔI DIALECT cursor audit** (3-slot `decodeListCursor` → 4-slot có mã sort) ⇒ client giữ token cũ sẽ 422, cần báo; Δ125 chạm contracts ngoài phạm vi packet nhưng bắt buộc theo khoá T70-C1; Δ126 allowlist sort giờ KHÔNG đồng nhất giữa 4 list; Δ127 `sortColumns` đụng executor chung (3 caller cũ truyền đủ key, hành vi không đổi); Δ128 chưa index cho `actor`/`resource` (`strpos(lower(...))` không dùng được index thường) — cần DB window, tôi không đo offline nên không claim query plan; Δ129 ADM-UX-02 vẫn `[~]`, ADM-UX-03 `[ ]`, `G-ADMIN-OPS` giữ **NO-GO**; offline-only, không commit/push — Mục 30.

- 1 — W-ADMUX-01: operations list phân trang server-side (limit) + cursor forward-compat + nền responsive mở rộng; tsc x3 exit 0, jest targeted 640/640 x3 exit 0, full offline 1313 pass/15 skip exit 0 — Mục 1.
- 2 — W-ADMUX-03-FILTER-1: toolbar state/tenant/id + chip + clear-all + deep link giữ filter; tsc x3 exit 0, jest targeted 656/656 x3 exit 0, full offline 1342 pass/15 skip exit 0 — Mục 2.
- 3 — W-ADMUX02-SRV-1: query+cursor contract server-side cho `GET /api/v1/operations`; tsc x3 exit 0, jest targeted 525/525 x3, suite riêng 65/65 — Mục 3.
- 4 — W-ADMUX02-SRV-1-FIX: sửa 2 lỗi `prevCursor` + test roundtrip 1→2→1 với fake db có trạng thái; pnpm 70/70 x3 exit 0, tsc x3 exit 0, hồi quy 530/530 x3 exit 0; Δ15 + Δ16 — Mục 4.
- 5 — W-ADMUX02-CLEAN-1: xoá copy "ADM-UX-02 sẽ tới" ở list rỗng dưới filter (Reviewer Turn 40); shell-render 136/136 x3, pagination 70/70 x3, tsc x3 exit 0; Δ17 + Δ18 — Mục 5.
- 6 — W-ADMUX02-COPY-2: xoá nốt 2 copy cũ ở renderer `:535`/`:555`, bỏ state `filtered-page`; pnpm 2 suite 207/207 x3 exit 0, tsc x3 exit 0; Δ19 + Δ20 — đóng trọn Δ14/Δ18 — Mục 6.
- 7 — W-ADMUX02-IDX-1: migration `0017` (`operations_tenant_created_id_idx`) + pin offline mutation-check; pnpm `8 passed / 10 skipped` x3, tsc x3 exit 0; Δ21 + Δ22 — Mục 7.
- 8 — W-ADMUX02-IDX-2: thêm `operations_created_id_idx` vào `0017` + `admin-keyset-explain.test.ts`; offline pin 9/9 x3, tsc x3 exit 0; Δ23 + Δ24 + Δ25 — Mục 8.
- 9 — W-ADMUX02-EXPLAIN-FIX-1: sửa 2 assertion sai theo log live T-CODEX-TEST-18; xác minh tĩnh 10/10 khớp plan thật + 8/8 mô phỏng có OFFSET control; tsc x3 exit 0; Δ26 + Δ27 + Δ28 — Mục 9.
- 10 — W-ADMUX02-STATUS-SYNC-1 (Turn 60): ledger packet + checklist browser C0–C5; ADM-UX-02 chỉ lên `[~]`, `G-ADMIN-OPS` giữ NO-GO; tự phát hiện & sửa 2 claim sai; Δ29 + Δ30 + Δ31 — Mục 10.
- 11 — W-CONTRACT-ALIGN-1 (T70-C1): hợp nhất contract operations-list về `@du/contracts` làm một nguồn; mutation-test phát hiện lock một chiều → sửa bằng seam `AllowListedQuery` (tham số ngoài contract = lỗi biên dịch); contracts 217/217 x3, orchestrator 551/551 x3, tsc exit 0; Δ32–Δ36 — Mục 11.
- 12 — W-ADMUX02-EXT-1: audit + api-keys list theo hợp đồng page chung (limit/keyset 2 chiều/envelope 5 field, `total`=count cùng clauses, tenant fence **trong SQL** + 403 trước mọi query, `severity`/`status` enum + `action`/`prefix` token, không lộ `hash`); api-keys hết load-all/JS-filter; **23 test mới, lock có mutation-check cả hai chiều (MA đỏ 4 test, MB đỏ 2 test)**; contracts 217/217 x3, targeted 439/439 x3, tsc x3 exit 0; sweep còn 2 suite đỏ **không thuộc lane** (1457 pass); Δ37–Δ41 — **ADM-UX-02 vẫn `[~]`** (thiếu sort allowlist; `label`/`last-used` **không có cột** → cần migration; businesses chưa làm; mọi thứ mới offline) — Mục 12.
- 13 — W-ADMUX03-TOOLBAR-CHIPS-1: `Clear all` nay **reset** (về `/admin/operations?limit=20`, bỏ hết filter + cursor — sửa đúng lỗi trái checklist C1 mà Mục 10 tôi soạn; cũ: giữ `limit` đang dùng) + 7 test **đi theo link thật**: chip hop state→tenant→id phải cho `total` 9→10→13, mọi href phát ra được parse lại bằng `parseQueryString`+`parseOperationListQuery` của shell và pane đích báo đúng query (chip có/không hai chiều, cursor có/không), tham số ⊆ `OPERATIONS_LIST_QUERY_PARAMS` + giá trị qua `isOperationsListFilterToken` (khoá phía phát URL, bổ sung khoá phía đọc của Mục 11), href không cursor là bất động điểm (`aria-current`), token bị từ chối không vào URL. **Đột biến: baseline 94/94 xanh → revert = 3 đỏ cùng một dòng `limit=5` vs `limit=20` → restore kiểm bằng đếm chuỗi (file `??`, không có git diff).** Cặp packet 101/101 ×3 exit 0, `tsc --noEmit` ×3 exit 0, hồi quy 6 suite Admin UI 434/434 exit 0; Δ42–Δ47 — **ADM-UX-03 vẫn `[ ]`** (chip/vốn có từ Mục 2 nên Δ42 không nhận công; thiếu sort; business/action/time filter; `label`/`last-used` không có cột; "debounce/cancel" lệch mô hình server-render — Δ45; mới offline, browser C1/C2 chưa chạy) — Mục 13.
- 14 — W-ADMUX02-SORT-ALLOWLIST-1: `sort` cho `GET /api/v1/operations` — contract mới trong `@du/contracts` (`OPERATIONS_LIST_SORT_FIELDS`/`_DIRECTIONS`/`OPERATIONS_LIST_SORT_VALUES`, `parseOperationsListSort()` **dùng chung** cho schema refine và route để hai bên không thể bất đồng), `'sort'` vào `OPERATIONS_LIST_QUERY_PARAMS` (đọc `sort` chỉ compile được sau bước này — khoá Mục 11 chạy đúng), default `created_at:desc` nên URL/cursor cũ **giống hệt từng byte**, ngoài allowlist = 422 `INVALID_SCHEMA` **trước mọi query** (không im lặng về default), ORDER BY dựng từ 6 fragment literal + `id` tiebreak luôn cùng chiều, `deadline_at` NULLABLE được coalesce qua sentinel **bind bằng tham số** để trang 2+ không mất operation không có deadline, hướng đi keyset đổi theo `direction` (forward/backward × asc/desc đã kiểm 4 tổ hợp); **19 test mới** (contracts 6→16, conformance 11→19, pagination 78→89) gồm fake db **thực thi** SQL của route + oracle tính độc lập; **3 lần đột biến đều bị bắt** (M1_NULL-handling → 7 đỏ, M2_direction-blind → đúng 3 test `:asc` đỏ và 5 test cũ không thấy gì, M3_silent-fallback → 3 đỏ kèm 200-thay-422); contracts build ×3 exit 0, contracts **385/385 ×3** exit 0, cặp packet **108/108 ×3** exit 0, `tsc --noEmit` ×3 exit 0, hồi quy 10 suite **375 passed / 14 skipped** exit 0 (3 suite skip là live-gated — skip ≠ pass); Δ48–Δ56 — **ADM-UX-02 vẫn `[~]`** (audit/api-keys chưa có sort vì `keysetPage` vẫn hardcode; 2 khoá mới chưa có index → cần 0018 + EXPLAIN, Δ53; cursor chưa ràng buộc với sort, Δ52 xin phán quyết; `label`/`last-used` cần migration; browser C0–C5 chưa chạy) và **ADM-UX-03 vẫn `[ ]`** (UI chưa có control sort — Δ54); `G-ADMIN-OPS` giữ **NO-GO** — Mục 14.
- 15 — W-ADMUX02-SORT-CURSOR-BIND-1 (T140-A1): **buộc ordering vào keyset cursor** cho `GET /api/v1/operations` — payload mới `<ISO>|<uuid>|<field>:<direction>[|p]` (encoder luôn phát slot; legacy 2-slot decode về `created_at:desc` vì đó là thứ tự duy nhất nó có thể từng mang, và `p` không phải `field:direction` hợp lệ nên hai hình thái không nhầm được), lệch thứ tự = **422 INVALID_SCHEMA trước mọi query** kèm remedy trong message, không im lặng bỏ cursor, không lách được bằng cách bỏ `?sort=`; slot parse bằng đúng `parseOperationsListSort()` của contracts; worst-case token **107** < bound 128 mà contracts cap, route kiểm và **admin shell cắt** (dài hơn = hỏng round-trip im lặng). **Phát hiện kèm theo (bug có trước):** filters + cursor predicate nối dạng `operations` + ` WHERE …` + ` AND (…)` ⇒ `SELECT * FROM operations AND (created_at, id) < …` **hỏng cú pháp** khi admin cross-tenant bấm Next trên list không lọc; sửa bằng fold predicate vào `whereClause`, **placeholder numbering giữ nguyên**; `keysetPage()` cùng hình nhưng hai caller luôn seed `tenant_id = $1` ⇒ bất khả thi hôm nay, không sửa (Δ59). **54 test mới** trong `tests/operations-list-cursor-sort-binding.test.ts` (ma trận 6×6 mint×replay, oracle định lượng mis-bound page = 0/2 dòng, 7 tổ hợp filter×cursor cho statement parse được, 14 slot hỏng, legacy compat) + 1 regex harness Mục 14 accept cả ` WHERE `/` AND ` và fail loudly khi không đọc được boundary. **Đột biến: M1 `||`→`&&` = 14 đỏ trong khi CẢ HAI suite Mục 14 vẫn xanh nguyên vẹn (đúng luận điểm reviewer); M2 decoder bỏ slot = 22 đỏ (14 mới + 8 walk Mục 14); M3 revert fold = 7 đỏ, in nguyên văn câu SQL hỏng; restore 162/162 + BAD=0 đếm chuỗi.** contracts build exit 0; contracts **385/385 ×3** exit 0 (Δ61: không đổi contracts — đây là hồi quy); operations-list trio **162/162 ×3** exit 0; `tsc --noEmit` ×3 exit 0; hồi quy tiêu dùng route **321 passed / 123 skipped** exit 0 (4 suite DU_LIVE_INFRA — skip ≠ pass); full sweep **66 xanh / 17 skip / 1 đỏ (4 test: VAULT-06 `connector-revision-http-offline`, đỏ cả khi chạy đơn lẻ, fixture seed `tenantId: ''` → 403 trước hop; đã ghi không thuộc lane ở Mục 12 và bởi Platform lane)**, `1625 passed / 209 skipped / 1838 total`. Δ57–Δ65 — **Δ52 ĐÓNG ở mức code + offline**; phần còn lại của acceptance là **live keyset test trong DB window** (cross-sort negative đã có ở đây); ADM-UX-02 vẫn `[~]`, ADM-UX-03 vẫn `[ ]` (UI phải **bỏ `cursor` khi đổi sort** — ghi vào task row để không thành bug bất ngờ), `G-ADMIN-OPS` giữ **NO-GO**; offline-only, không commit/push — Mục 15.
- 16 — W-ADMUX03-SHELL-SORT-1: `sort` vào Admin Shell (finding 4 Turn 150, nửa shell của T140-A1) — router parse `?sort=` vào query state; fetcher sanitize bằng ĐÚNG `parseOperationsListSort()` của contracts (rác → drop + khai `ignoredFilters`, không vang lại; default omit khỏi URL — deep link cũ byte-stable và khớp chính xác binding cursor default §15); envelope echo `sort` canonical; toolbar `<select name="sort">` 6 option **và form không có cursor field** ⇒ đổi sort = reset cursor cấu trúc (Δ67: không decode cursor trong shell để giữ opacity); mọi link mang cursor đều echo ordering (prev/next/size/chip/back-to-list), clear-all bỏ hết sort+cursor+filter; catalog offline mô phỏng ORDER BY `(key,id)` cùng chiều + NULL deadline cuối danh sách hai chiều qua sentinel (§14.2), default giữ thứ tự fixture (Δ69). **47 test mới** trong `tests/admin-operations-sort-wiring.test.ts` (một-nguồn, fetcher→URL, 422-remedy-nổi-thành-error, router parse, href→parse→fetch round-trip đúng trang, structural-reset, pairing, catalog mirror 4 ordering + walk). **3 đột biến: M1 link không echo sort = 5 đỏ/131 xanh (đúng bộ pairing), M2 cursor-field vào form = 1 đỏ structural-reset, M3 luôn-gửi-default = 2 đỏ**, restore BAD=0 đếm chuỗi (lần đầu M1 đỏ-vì-compiler TS2345 — tái phạm Δ65(3), ghi Δ71). `pnpm --filter @du/orchestrator exec tsc --noEmit` ×3 Exit Code 0; packet-literal VM suite **74/74 ×3 Exit Code 0**; bộ 5-suite **400/400 ×3 Exit Code 0**; full sweep **69 pass / 17 skip / 0 fail, 1695 passed / 209 skipped** Exit Code 0 — đỏ VAULT-06 Mục 15 không còn tái hiện, không phải công lane (Δ70). Offline only, không commit/push; **ADM-UX-03 vẫn `[ ]`, ADM-UX-02 vẫn `[~]`, `G-ADMIN-OPS` giữ NO-GO** (nợ Tester: live 6-sort + cross-sort replay 422 trên server thật + C1–C5 browser); phát hiện worktree: cả `src/app/admin/` untracked — 4 file nguồn không có git diff làm lưới (Δ72); Δ66–Δ72 — Mục 16.
- 17 — W-ADMUX02-IDX-SORT-0018: keyset index cho hai khoá sort mới của route operations (đóng một nửa gap (b) của Δ53) — `migrations/0018_operations_sort_keyset_indexes.sql` đúng 4 câu packet-spec, all IF NOT EXISTS, no DROP/ALTER, header ghi rõ vì sao KHÔNG sửa 0017-đã-apply (Δ24) và caveat expression của deadline_at; guard test +6 (17/17): file loads sequence 18, mỗi index pin bằng MỘT chuỗi exact đơn (name↔columns không đổi chỗ được), đúng 4 CREATE INDEX, cấm DROP/ALTER/TRUNCATE, pin-nguyên-caveat-text (COALESCE(deadline_at + live EXPLAIN phải còn trong file). Kỹ thuật: updated_at NOT NULL ⇒ order cột trần ⇒ plain index khớp pathkey; deadline_at order = COALESCE(col, $n) (server.ts:2547) ⇒ plain index nhiều khả năng KHÔNG xoá Sort — câu hỏi để-trống có chủ đích, resolve bằng live EXPLAIN của Tester rồi mới tính 0019 expression-form, không tidy 0018 (Δ73). Evidence: packet ba lệnh ×3 Exit Code: 0 (guard 17/17, tsc, sort-wiring 47/47); ĐỘT BIẾN M1 xoá-statement = 2 đỏ (đúng tên + count), M2 id-ASC = 1 đỏ, M3 bỏ-IF-NOT-EXISTS = 1 đỏ, restore BAD=0 bằng 13 đếm chuỗi; ba full sweep: đỏ url-ingestion(3) → đỏ admin-shell-server(1, ETIMEDOUT loopback) → SẠCH 70/17/0 (1727 pass) — red di chuyển, mọi suite đỏ standalone xanh, mọi suite lane xanh cả ba ⇒ contention máy chung, KHÔNG phải code lane (Δ74, quy trình: targeted rerun trước khi gán đỏ-sweep). Self-corrected: 2 lỗi restore paraphrase/ăn-comment, bắt bằng đọc-lại-file (Δ76). migrations 0002..0018 đều untracked — Δ72 mở rộng (Δ75). Không chạy DB window, không commit/push; **ADM-UX-02 vẫn [~]** (thiếu EXPLAIN live cho cả 4 index + các gap cũ), ADM-UX-03 [ ], **G-ADMIN-OPS giữ NO-GO** — Mục 17.
- 18 — W-ADMUX02-EXPLAIN-SORT-1 (T180-A1): cổng live cho 0018 VIẾT XONG — `tests/admin-keyset-explain.test.ts` 6→17 (DU_LIVE_INFRA-gated, offline 13 skip + **4 synthetic-chứng-minh-bar-có-răng**): pg_indexes six-name exact-list; updated_at cross/tenant **no Sort** + name, backward-hop theo bar T-18 (`Index Cond ROW(updated_at,id)>ROW(`, cấm Seq Scan, bounded-Sort cho phép); deadline_at ba plan đúng-expression-route (`COALESCE(deadline_at,$k::timestamptz)` shared-sentinel desc+asc, tenant+cross) chấm bằng `expectDeadlinePlanUsable` 3 điều khoản có chủ đích (SeqScan-đỏ=0019-branch, thiếu-tên-idx-đỏ=không-gọi-0018-là-used, material-Sort-đỏ=decision-cần-follow-on-KHÔNG-tidy-0018-đã-apply-Δ24); walk `updated_at` full-continuity (live-count, chống coupling-test); seed enriched: updated_at distinct từng dòng, **~620/1240 deadline NULL** (sentinel cần khối NULL đại-diện). WalkKeyset tham-số-hóa = `walkByBareKey`, tên-giữ-nguyên-hành-vi-cũ. Evidence cây cuối: explain **×3 Exit Code: 0** (4P/13S), REG 4-suite **207/207 ×3 exit 0**, tsc **×4 liên-tiếp exit 0** sau ~6 phút đỏ VÌ EDIT-ĐANG-CHẠY CỦA LANE KHÁC tại workflow.ts:337 (không chạm, poll converge — Δ80), sweep **70/17/0, 1727 pass/216 skip (+7 = đúng live mới) exit 0**. KHÔNG claim plan nào; cross-sort 422 real-route + multi-tenant seed (Δ21) + rollout write-lock vẫn nợ — ghi 18.4. Self-caught: Δ81 (probe-edit làm vướng thân hàm cũ — repair nguyên văn, học-qui probe-≠-edit đã về memory). **ADM-UX-02 vẫn [~], ADM-UX-03 [ ], G-ADMIN-OPS giữ NO-GO**; live window là của Tester — Mục 18.
- 19 — W-ADMUX02-CROSS-SORT-422-1 (finding 4 Turn 150 + T180-A1, nửa OFFLINE-wire): file mới `tests/admin-operations-sort-http-offline.test.ts` **32 test / 2 tầng** — A: `route()` THẬT mount loopback HTTP + interpreter-fake db đúng hình SQL §15, boundary problem+json mô phỏng server.ts:519-525; **cursor do route tự mint** replay chéo 5 cặp sort → **422 trên wire** (code+status+title chứa cả hai ordering+remedy), no-escape, legacy 2-slot/`|p` compat, over-128 reject TRƯỚC mọi SELECT, sort-lỗi-trước-cursor-lỗi, 6 walk it.each theo oracle độc lập + schema safeParse từng hop, tenant-scoped walk không hở id B, A-cursor replay-B = window B sạch; B: `createAdminShellServer` THẬT (login POST→cookie) chống SYNTHETIC platform đúng wire-policy §15 — walk 6 sort qua href Next thật (link cursor luôn kèm sort; zero 422 khi đi đúng), URL tự chế cross-sort → pane báo remedy THAY VÌ danh sách sai, form trang-2 không cursor field, tenancy + token rác không vang lại, cursor 250 ký tự → platform nhận đúng 128 (CẮT-chính-sách §15.2 giờ có test pin hành vi cuối). Máy-móc lộ trình: listen(0)+loopback HANG do Windows ephemeral filter ⇒ pin port tĩnh, giải thích luôn Δ74 (Δ82); message nằm ở `title`, không có `detail` (Δ83); phân ranh A/B ghi vào header chống over-claim (Δ84). Self-caught 3 lỗi test qua probe độc lập (group-index/prev-window/port — Δ85). Evidence: C19 **32/32 ×3 exit 0** (socket thật, không DB), REG 5-suite **343/343 ×3 exit 0**, tsc ×3 exit 0, sweep **73/16/0 (1785 pass/216 skip) exit 0** — 17→16 skip vì explain suite Mục 18 nay có test chạy offline. M-A guard self-comparison = **đúng 7 đỏ nguyên bộ replay**, 25 xanh ngoài vùng, restore grep=0. Δ86: không sửa source (mọi dòng src chỉ là mutation có kiểm soát, đã restore). KHÔNG phải live closure (19.4): T180-A1 vẫn chờ Tester trên PG thật; ADM-UX-02 [~], ADM-UX-03 [ ], G-ADMIN-OPS giữ NO-GO — Mục 19.
- 20 — W-ADMUX02-0019-LITERAL-HARNESS-1 (task_892296fa9542 / ctx_718d23f32fb5): căn chỉnh 3 harness fake-DB với sentinel INLINE-LITERAL mà W-INGEST-0019-1/2 đưa vào `bindOperationsListSortKey` (0019 match Const, Param là hình chết-index đã bị T-35 bác) — reproduction đỏ **đúng 14/140** như packet (pagination 5, conformance 2, http-offline 7); lane sửa **test-only, production diff 0**: interpreter đọc literal + phân-loại `$n`-form thành regression-throw, conformance đảo-cực 2 pin (fragment literal byte-exact theo chiều + không `$n` giữa ORDER BY và LIMIT), http-offline thêm **2 guard chưa từng có ở file** (unreadable-boundary-throw, boundary-key≠ORDER BY-key) + sentinel↔direction check; 140/140 **×3 Exit Code: 0**, tsc Exit Code: 0, probe regex độc lập **7/7** (mutation-source TỪ-CHỐI vì server.ts đang lane khác sửa — tiền lệ Δ80, răng do probe + phổ đỏ gánh); sweep unit offline **73 pass/1 skip/1 fail — 1788 passed / 28 skipped / 1817 total**, đỏ duy nhất VAULT-06 KHÔNG-lane và vẫn đỏ standalone (Δ90); nợ mới đưa adjudicate: fixture EXPLAIN §18 còn pin hình cũ (Δ88), sentinel 4 nơi không một nguồn (Δ89), nhãn packet "(Delta 29)" lệch ledger (Δ87). ADM-UX-02 [~], ADM-UX-03 [ ], **G-ADMIN-OPS giữ NO-GO**; offline-only, không commit/push — Mục 20.
- 21 — W-ADMIN-ALIGN-EXPLAIN-0019 (task_222653f4cfd2 / ctx_c3234ad59db5, ĐÓNG Δ88): align `admin-keyset-explain.test.ts` với sentinel INLINE-LITERAL của 0019 — sentinel comment, bar regex nhận cả 0018 plain lẫn 0019 coalesce (`/operations_(tenant_)?deadline_(coalesce_(asc|desc)_)?id_idx/`), pg_indexes 6→10 tên, 3 deadline SQL dùng `'<ISO>'::timestamptz` literal thay `$n` + renumber params, +1 synthetic chứng minh widened regex không vacuous; repair `.join('\n')` literal-newline hỏng syntax do lane khác để lại (Δ91); **18/18 ×3 Exit Code: 0** (13 skip live + 5 pass synthetic), tsc Exit Code: 0; file 553→583 dòng; Δ88 ĐÓNG, Δ91 mới; Δ89/Δ90 vẫn mở; ADM-UX-02 [~], ADM-UX-03 [ ], **G-ADMIN-OPS giữ NO-GO**; offline-only, không commit/push — Mục 21.
- 21 — W-ADMIN-ALIGN-EXPLAIN-0019 (task_222653f4cfd2 / ctx_c3234ad59db5, Δ88): align `admin-keyset-explain.test.ts` với 0019 inline literal — sentinel comment, bar regex nhận cả 0018 plain lẫn 0019 coalesce, pg_indexes 6→10, 3 deadline SQL inline + renumber, +1 synthetic 0019-name, repair syntax lỗi lane khác để lại; 18/18 ×3 Exit Code 0 (13 skip + 5 pass), tsc Exit Code 0; Δ88 ĐÓNG; Δ91 (file đã có trước phần lớn); ADM-UX-02 [~], ADM-UX-03 [ ], G-ADMIN-OPS giữ NO-GO; offline-only, không commit/push — Mục 21.
- 21 — W-ADMIN-ALIGN-EXPLAIN-0019 (task_222653f4cfd2 / ctx_c3234ad59db5, Δ88): align `tests/admin-keyset-explain.test.ts` với sentinel inline-literal của 0019 — sentinel comment (literal không param), bar regex nhận CẢ 0018 plain lẫn 0019 coalesce (`/operations_(tenant_)?deadline_(coalesce_(asc|desc)_)?id_idx/`), pg_indexes 6→10 tên (+4 index 0019), 3 deadline test dùng literal + renumber params, +1 synthetic chứng minh regex không vacuous; đồng thời sửa syntax lỗi lane khác gây (Δ91: `.join('\n')` bị literal newline → unterminated string). **18 test (5 pass + 13 skip) ×3 Exit Code: 0**, tsc Exit Code: 0. Δ88 ĐÓNG, Δ91 mới. ADM-UX-02 [~], ADM-UX-03 [ ], **G-ADMIN-OPS giữ NO-GO**; offline-only, không commit/push — Mục 21.
- 22 — W-ENC-07-DELIVERY-1 (task_7e489eb6b6d6 / ctx_b89fcb76b089): triển khai delivery encryption cho public result/download — MỚI `src/modules/public-api/delivery-encryption.ts` (218 dòng) + barrel, SỬA `src/server.ts` (ServerConfig/RouteContext/ctx + 3 helper + 2 route), MỚI `tests/delivery-encryption.test.ts` (489 dòng, 22 test).
  Policy per-tenant config-injected, **không client override** (7 cách hạ chế đều fail); DEK+nonce mới mỗi response; AES-256-GCM + RSA-OAEP-SHA256 wrap dưới key ENC-06; envelope validate ENC-01 trước khi ra wire; pin keyId+version; **/result và /download cùng một policy** (download giữ stream Readable khi tắt, đọc có trần maxBlobBytes khi bật, quá trần 413); fail-closed 503 cả hai route khi key thiếu/revoke/registry lỗi, chữ cố định theo code, payload không lọt vào body lỗi; HPKE từ chối chứ không hạ cấp.
  Evidence: **22/22 ×3 Exit Code: 0**, tsc Exit Code: 0, full offline sweep **79 pass/1 skip/1 fail — 1854 passed/28 skipped/1883** (VAULT-06 đã xanh, +66 vs Mục 20).
  Tự sửa 5 lần ghi công khai (getBlob trả Readable; tự ghi đè mất 10 service-test rồi dựng lại; test 404 cross-tenant xanh giả → thêm ownerTenant; receipt trùng section 21 → dedup; Δ80 runtime.ts lane khác đang edit → poll).
  Đỏ sweep duy nhất KHÔNG thuộc lane: renderer aria-label (Δ92). Δ93 HPKE chưa có, Δ94 policy chưa bền (cần ENC-08 + migration), Δ95 delivery >trần 413 chưa có chunk profile, Δ96 keyId vs fingerprint.
  **ENC-07 IMPLEMENTED/VERIFIED-OFFLINE — KHÔNG phải ACCEPTED** (cần live Vault/PG + external client của ENC-INT-01); `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 22.
- 23 — W-ENC-08-CONFIG (task_5b49655d9bbd / ctx_584a61ed44c2): Admin UI + API crypto configuration — MỚI `src/app/admin/crypto-config-view-models.ts` (167) + `crypto-config-renderer.ts` (126) + `crypto-config-api.ts` (350, 14 export) + `crypto-config-index.ts`, MỚI `tests/admin-crypto-config.test.ts` (458 dòng, 35 test / 6 describe). Ba control (allowlisted Vault storage key ref / toggle delivery encryption / pin recipient key version); fingerprint chỉ preview 12 ký tự; không có mặt trữ chứa secret; RBAC tenant-scoped + writer role + CSRF token thật của rbac.ts; chọn storage key ref platform-only; mỗi field đổi ghi 1 dòng audit tên field không tên giá trị, no-op không ghi; bật delivery khi chưa có key dùng được thì 409 từ chối lúc cấu hình; pin hỏng hiện cảnh báo. Chỉ tạo file mới, không sửa file tồn tại, không chạm `server.ts`/`src/modules/**` (ngoài phạm vi packet). Evidence: **35/35 ×3 Exit Code: 0**, tsc Exit Code: 0. Tự bắt 1 bug thật trong source (`effectiveRecipientKeyVersion` phụ thuộc thứ tự input, sửa trong source không sửa test) + 4 expectation sai. **Khoảng cách lớn ghi thẳng:** chưa route HTTP (Δ97), chưa bảng persistence (Δ98), **chưa nối ENC-07 nên toggle ở Admin chưa đổi hành vi giao thật** (Δ99), allowlist phải truyền từ composition root (Δ100), CSRF với OIDC session chưa ghép (Δ101), không có mutation test vì toàn file mới (Δ102), hai lựa chọn chính sách cần ký (Δ103). **ENC-08 IMPLEMENTED ở phạm vi bề mặt quản trị — KHÔNG phải ACCEPTED**; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 23.
- 24 — W-ENC-08-WIRING (task_4f4ddbfd7e07 / ctx_21c1431d4bf3): ĐÓNG Δ97 ở mức route + shell — SỬA `src/server.ts` (ServerConfig.cryptoConfig, RouteContext.cryptoConfig, `buildCryptoConfigOptions` MỘT LẦN trong createApp, route GET/POST `/api/v1/admin/crypto-config`, gọi đúng handler Mục 23, chưa cấu hình ⇒ 503, registry dùng chung ENC-07) + SỬA `src/app/admin/shell-router.ts` (route `/admin/crypto-config` admin-only, KHÔNG phải AdminSection vì union đóng trong types.ts ngoài phạm vi, `ShellRuntimeConfig.cryptoConfigPane` optional, không resolver ⇒ error pane, resolver ném ⇒ error pane không rò message) + MỚI `tests/admin-crypto-config-wiring.test.ts` (21 test / 3 describe). **Tự bắt 1 lỗ hổng thật do tôi tạo:** đọc `cookieRole` từ header `x-admin-role` do caller set (Δ104) — sửa sang claims cookie đã verify; có test chứng minh header giả không né CSRF khi có cookie thật. Δ80 lặp: lane khác sửa crypto-config-api.ts lúc 02:58 làm hỏng type-import, tôi KHÔNG chạm, poll ~90s tới khi họ xong. Evidence: **56/56 ×3 Exit Code: 0** (2 suite ENC-08), tsc NO_TS_ERRORS, full offline sweep **83 pass/1 skip/2 fail — 1938 passed/28 skipped/1967** (+26 vs Mục 23); 2 đỏ đều fail độc lập và không thuộc packet: Δ92 cũ + `public-upload-encryption-gateway` (ENC-05 lane khác, đỏ 5/7 trong file của họ). **Δ98 (store in-memory, mất khi restart) và Δ99 (chưa nối ENC-07 ⇒ toggle ở Admin chưa đổi hành vi giao thật) VẪN MỞ**; thêm Δ105 (platform bearer không qua CSRF — cần xác nhận bearer chỉ nằm ở server), Δ106 (composition chưa wire cryptoConfigPane), Δ107 (ghi nhận mức độ chạm file ngoài phạm vi: chỉ quan sát, không sửa). ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 24.
- 25 — W-ENC-08-WIRE-ENC07 (task_e7c21a0b6c2f / ctx_e918bed8ea4f): đóng Δ99 — toggle/pin của Admin nay thực sự chi phối delivery của ENC-07 — SỬA `src/modules/public-api/delivery-encryption.ts` (thêm `TenantDeliveryPolicy.pinnedRecipientKeyVersion`, `TenantDeliveryPolicySource`, `resolvePolicy` async; `getPolicy` sync ném lỗi khi có policy động Δ108; pin dùng `getKeyVersion` nên rotation sau pin không đổi người giải mã, pin bị revoke thì 503 fail-closed chứ không lùi key hiện hành Δ109) + SỬA `src/server.ts` (`buildDeliveryEncryptionConfig` exported nối cùng store Admin ghi, service build 1 lần trong createApp, 2 route dùng `await resolvePolicy`) + MỚI `tests/enc08-wire-enc07.test.ts` (9 test). Tự sửa: fake db `/FROM operations o/i` nuốt mất SQL của /download (EXISTS cũng chứa `FROM operations owner_op`) → siết thày `/FROM operations o\s+LEFT JOIN artifacts/`; 3 lỗi compile test (mất hằng API_KEY khi ghép fragment, kiểu revokedAt suy rộng, dấu } thừa do fragment đóng describe sớm). Evidence: 4 suite ENC **87/87 ×3 Exit Code: 0**, tsc NO_TS_ERRORS, full offline sweep **87 pass/1 skip/1 fail — 1968 passed/28 skipped/1997** (+30 vs Mục 24); đỏ duy nhất `admin-operations-list-pagination` là Δ92 cũ, đỏ ENC-05 đã xanh. **Δ98 (store in-memory, mất khi restart) VẪN MỞ**; Δ110 ghi nhận webhook dispatcher chưa theo policy (ngoài phạm vi). ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 25.
- 26 — W-ADM-UX-08-SHELL (task_ddc3efda9377 / ctx_2ddb0e928684): ĐÓNG Δ106 — SỬA `src/app/admin/shell-router.ts` (type `CryptoConfigPaneResolver`/`CryptoConfigApply`, `registerCryptoConfigWiring()` + accessor, matcher nhận POST, `handleCryptoConfigPost` với CSRF gate trước applier, dispatch tách GET/POST; file CRLF, chèn bằng script Node và kiểm `loneLF=0`) + SỬA `src/server.ts` (`registerAdminCryptoConfigWiring()` export + gọi trong `createApp`, luôn ghi kể cả `undefined`) + MỚI `tests/admin-crypto-config-shell.test.ts` (9 test / 5 describe, 258 dòng) + SỬA 1 assertion lỗi thời trong `tests/admin-crypto-config-wiring.test.ts`. Cổng theo thứ tự cookie → role>=admin → CSRF(constant-time) → applier; save POST-redirect-GET; test soi DOM không có PEM/bearer/cookie secret/CSRF token. Evidence: 3 suite targeted **41/41 ×3 Exit Code: 0**, tsc NO_TS_ERRORS, full offline sweep **86 pass/1 skip/3 fail — 1979 passed/28 skipped/2010**. Ba đỏ: Δ92 cũ + `admin-shell-session-lifecycle` + `adm-base-03-safe-error-offline.functional`, hai đỏ sau **không thuộc packet** (test socket thật; probe in-process đã xoá chứng minh matcher/event/businesses của tôi đều đúng; `shell-server.ts` bị lane khác sửa 04:15 trong lúc tôi làm việc) → Δ114. Δ111 registry process-level, Δ112 renderer chưa phát CSRF field (submit browser luôn 403, fail-closed đúng, UX chưa dùng được), Δ113 chưa nối verifySessionCsrf OIDC. Δ98 đã lane khác đóng; Δ110 mở. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 26.
- 27 — W-ENC-08-RENDERER-CSRF (task_1be90638634c / ctx_6c84c0d694e1): ĐÓNG Δ112 — SỬA `src/app/admin/crypto-config-renderer.ts` (`renderCryptoConfigForm(pane, csrfToken?)` + `renderCryptoConfig(pane, csrfToken?)`; có token ⇒ `<input type=hidden name=csrf>` + nút Save; không có ⇒ READ-ONLY, không nút Save, có banner + `data-crypto-config-readonly`) + SỬA `src/app/admin/shell-router.ts` (import `deriveCsrfToken`, `handleCryptoConfigGet` derive token từ cookie+secret rồi truyền xuống renderer) + SỬA `tests/admin-crypto-config-shell.test.ts` (3 test mới: secret vắng + token session-bound, end-to-end render→parse→POST, read-only renderer) + SỬA 1 assertion hợp đồng của chính tôi ở Mục 26. **Quan niệm đúng:** token là binding HMAC, KHÔNG phải secret — nếu không render thì mọi save từ browser là 403, đó chính là Δ112; cổng POST verify constant-time trước khi applier chạy. Evidence: 2 suite theo packet **47/47**, 4 suite ENC **79/79 ×3 Exit Code: 0**, tsc NO_TS_ERRORS, full offline sweep **84 pass/1 skip/5 fail — 1951 passed/28 skipped/1984** (không suite crypto nào đỏ). Tự sửa: (i) sửa assertion Mục 26 coi token là secret (Δ115) — sửa theo đúng tính chất bảo mật, không nới lỏng để cho xanh; (ii) guard read-only gần như không reachable qua route nên test ở tầng renderer chứ không dựng kịch bản route giả (Δ116); (iii) 2 đỏ sweep mới (`url-ingestion-consumer` TS2304 trong file test của lane khác, `admin-shell-server` socket Δ114) đã xác minh không phải của tôi, không sửa (Δ117). Δ110 (webhook theo policy) + Δ113 (verifySessionCsrf OIDC) vẫn mở. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 27.
- 28 — W-ENC-08-CSRF-OIDC (task_b5bf4dc1e21a): ĐÓNG Δ113 — session plane OIDC sở hữu CSRF của crypto-config — SỬA `src/app/admin/shell-router.ts` (4 điểm: `resolveOpaqueSession` mang csrfToken của session; GET đọc token từ store khi có du_session, ngược lại mới derive legacy; POST verify bằng `verifySessionCsrf` thật khi có token, KHÔNG fallback legacy; `dispatchShellRequestAsync` truyền token qua tham số thứ 4 optional) + MỚI `tests/admin-crypto-config-oidc.test.ts` (233 dòng, 6 test self-contained). Nguyên tắc: session store đã quyết định danh tính trước legacy cookie và không lùi — Δ113 mở rộng đúng nguyên tắc ấy sang CSRF. Dùng lại primitive thật (check định dạng 43 ký tự + timingSafeEqual) thay vì so sánh tay, vì phép so sánh thứ hai viết tay chính là nơi hai mặt phẳng sẽ trôi lệch. Evidence: 3 suite theo packet **105/105**, 4 suite ENC **76/76 ×3 Exit Code: 0**, tsc NO_TS_ERRORS, full offline sweep **88 pass/1 skip/3 fail — 1997 passed/28 skipped/2028** (không suite crypto nào đỏ; 2 đỏ mới Mục 27 đã xanh do lane sở hữu tự sửa). Tự ghi công khai 2 lỗi fixture của tôi (token 42 ký tự bị CSRF_RE thật chặn trước khi so sánh; key record thiếu tenantId nên recipientKeyOptions lọc rỗng ⇒ mọi pin bị từ chối) — sửa fixture, KHÔNG nới source. Δ118 narrowing as SessionRecord có chủ đích (hàm chỉ đọc csrfToken) nhưng là kiểu ép, chờ quyết định có mở task dọn kiểu không; Δ119 đường async chưa có test cho phần truyền token. Δ110 vẫn mở. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 28.
- 29 — W-ENC-08-WEBHOOK (task_f0bcba8aa961 / ctx_03ff4b81e2fc): ĐÓNG Δ110 — SỬA `src/modules/webhooks/webhooks.ts` (port `WebhookDeliveryEncryption` chỉ gồm resolvePolicy + encryptForDelivery; option `deliveryEncryption`; `tenant_id` trên `WebhookDeliveryRow` + claim SELECT; `buildWebhookBody` trả envelope ENC-08; ký SAU khi mã hóa; nhánh fail-closed với mã cố định `WEBHOOK_ENCRYPTION_FAILED`) + SỬA `src/server.ts` (truyền service thật vào deliverWebhooks, `?? undefined`) + MỚI `tests/webhook-delivery-encryption.test.ts` (334 dòng, 5 test self-contained). Vấn đề thật: dispatcher dựng body thẳng từ `row.payload`, không đọc policy, và claim SELECT không lấy `tenant_id` nên không biết tra policy của ai — tenant đã bật mã hóa vẫn nhận webhook rõ. Ba bề mặt delivery giờ do cùng một policy điều khiển. Fail-closed: lỗi đọc policy/mã hóa ⇒ KHÔNG POST, row nhận mã cố định; policy đọc lỗi không phải bằng chứng tenant tắt. Evidence: 5 suite liên quan **64/64 ×3 Exit Code: 0**, tsc NO_TS_ERRORS, full offline sweep **92 pass/1 skip/3 fail — 2014 passed/28 skipped/2045** (không suite crypto/webhook nào đỏ; 3 đỏ là bộ đã biết Δ92 + 2 socket Δ114). Tự ghi công khai 3 lỗi test của tôi (tx không gắn vào db; đọc `params[2]` cho `last_error` trong khi release SQL dùng `$4`; import 2 header constant nhầm từ webhooks thay vì @du/contracts) — lỗi đọc sai chỉ số là loại âm thầm, làm test pass với thông báo sai. Trong lúc chạy, `server.ts` + `@du/contracts` đang được lane khác refactor (19 lỗi TS); tôi KHÔNG chạm, poll 2 lần (19→12→0) rồi mới chốt số — Δ80 lặp lần thứ ba. Δ120 chữ ký giờ phủ ciphertext ⇒ receiver phải verify trên body đã nhận (đổi hợp đồng phía nhận, cần báo lane sở hữu + docs 06); Δ121 `webhook_deliveries.payload` trong DB vẫn plaintext (thuộc ENC-META-01); Δ122 lỗi crypto tốn ngân sách retry; Δ123 port lặp shape của service. ENC-08 chưa ACCEPTED; `G-ENC`/`G6` NO-GO; offline-only, không commit/push — Mục 29.
