# Báo cáo lane Qwen-SEC (OIDC / session store)

## LEDGER
- 1 — W-OIDC02-REPLICA-1: offline revoke/restart/expiry pack cho oidc02-process-replicas-offline.test.ts — Muc 1.
- 2 — W-OIDC03-RBAC-1: assertRoleActionTenant (SEC-00 triple gate) + suite offline 13 test + wiring dispatcher, regressions xanh 3× — Muc 2.
- 3 — W-ADMBASE03-ERR-1: browser-tier 500 boundary có code+correlationId (shell-server.ts) + suite offline sentinel 21 test, chuỗi 5 suite 137/137 xanh 3× — Muc 3.
- 4 — W-OIDC04-FLOW-1: verify 7 suite của packet (xanh ngay) + đóng seam claim→session→gate chưa có test (suite mới 11 test) + Δ8/Δ9/Δ10 — Muc 4.
- 5 — W-SEC-CLAIM-ASSERT-1: contract assertion claim-shape browser vs bearer ở packages/contracts + ràng vào 2 mapper thật (14 + 8 test mới) + negative control 5/8 đỏ + siết 1 lỗ hổng shape tenantIds + Δ12/Δ13/Δ14/Δ15/Δ16 — Muc 5.
- 6 — W-SEC-RBAC-SYNC-1: đồng bộ envelope ADM-UX-02 cho 3 cell live M2/M3/M5 của admin-action-rbac-live.test.ts (test-only, 0 production diff, giữ nguyên M4 vì route khác) + guard skip offline + chuỗi 5 suite 3× exit 0 + Δ17/Δ18/Δ19/Δ20 — Muc 6.
- 7 — W-SEC-STATUS-SYNC-1: ghi packet ledger vào tasks/README.md + tasks/SEC-OIDC-VAULT (OIDC-03 `[ ]`→`[~]`, journal 6 packet, 4 giới hạn, checklist browser OIDC-04 B0–B5); xác minh T-CODEX-TEST-20 12/12; **Δ21** 12 cell không chạm mapper claim→principal + Δ22 không có `refresh_token` + Δ23 neo `data-csrf` sai chỗ; 0 product diff, 0 test chạy, G-SEC giữ NO-GO — Muc 7.
- 8 — W-OIDC04-SESSION-FLOW: +14 test vào `admin-shell-session-lifecycle.test.ts` (176→395 dòng) — cờ Secure trên nhánh https **chưa từng được test nào chạy**, CSRF phủ **toàn bảng ADMIN_ACTIONS** (danh sách lấy từ table), forged identity header fail-closed; **0 production diff**; negative control secure=false → 2/24 đỏ rồi revert; Δ24–Δ29 (Δ26 Secure phụ thuộc env công khai, Δ27 du_admin không Secure thuộc lane Admin) — Muc 8.
- 9 — W-SEC-OIDC04-PROXY-1: chính sách Secure sau TLS-terminating proxy — 2 env knob mới (`DU_ADMIN_TRUST_PROXY_PROTOCOL`, `DU_ADMIN_COOKIE_SECURE`) + boot refusal production-origin-http + denial TRƯỚC exchange khi TLS chưa chứng minh + nâng một chiều qua router đã mount; +19 test (suite mới 13 + boot 6), 2 negative control đỏ đặc hiệu (6/35, 5/35) rồi đếm lại toàn chuỗi sau revert; Δ30 (3 dòng transport ở shell-types/shell-server/shell-router ngoài chữ packet), Δ32 breaking-boot-change cần runbook, Δ33 = Δ27 mới đóng một nửa (primitive có, wiring du_admin thuộc Admin), Δ31/Δ34/Δ35 — Muc 9.
- 10 — W-SEC-COOKIE-CONFIG-1: nối legacy du_admin vào cùng policy Secure DU_ADMIN_* (đóng Δ27/Δ33 trong đúng 2 file packet mở quyền): mount-parse MỘT lần → `cookiePolicy`, strict-XFP nâng MỘT chiều, requireSecure + unproven → 503 denial SAU credential check (0 Set-Cookie), logout clear mang posture không deny; +12 test (24→36, 3 leg REAL socket), 2 NC đỏ đặc hiệu (4/36, 1/36), packet×3 + rộng 151+7skip ×3 + lint/tsc đều 0 sau revert; Δ36–Δ40 — Muc 10.
- 11 — W-SEC-AUDIT-TAXONOMY-1: từ vựng audit an ninh ĐÓNG 5 kind ở rbac.ts + emit tại 3 nơi thật (router login/tls/session-gate; dispatcher CSRF leg qua tham số audit? optional — Δ41); zero-leak bằng CẤU TRÚC đóng + 5 họ sentinel (token/adminToken/cookieSecret/sid/csrf stored+provided qua resolver THẬT); classify đọc-không-đổi tách expired/revoked cho audit, one-null-path wire giữ nguyên (Δ43); default console sink tại mount — production ghi ngay, JSON-plane chờ Platform một dòng (Δ42); +19 test (36→51 lifecycle, 13→17 oidc03); NC: v1 compile-dead không tính, v2 10/68, B 2/68, C 3/68 đặc hiệu rồi ĐẾM LẠI packet×3 68/68 + rộng 170+7skip ×3 + lint/tsc 0; Δ41–Δ45 — Muc 11.

## RESUME POINT
- Packet gần nhất: **W-SEC-AUDIT-TAXONOMY-1** (Muc 11 — xem §11). Lịch sử: §10 W-SEC-COOKIE-CONFIG-1, §9 W-SEC-OIDC04-PROXY-1, §8 W-OIDC04-SESSION-FLOW, §7 W-SEC-STATUS-SYNC-1, §6 W-SEC-RBAC-SYNC-1, §5 W-SEC-CLAIM-ASSERT-1, §4 W-OIDC04-FLOW-1, §3 ADM-BASE-03, §2 W-OIDC03-RBAC-1, §1 W-OIDC02-REPLICA-1.
- Chu kỳ 11 (Muc 11 — xem §11) đóng 2026-09-26: W-SEC-AUDIT-TAXONOMY-1 — audit taxonomy ĐÓNG 5 kind: auth.login_failed (emit TRƯỚC render 401; sai token KHÔNG bao giờ sinh tls_required — pin thứ tự), auth.tls_required (validated + unproven under requireSecure → trước render 503), auth.session_expired/expired_absolute|expired_idle và auth.session_revoked/absent_or_revoked (gate OIDC: classify ĐỌC-KHÔNG-ĐỔI chạy TRƯỚC get — eviction không xóa được bằng chứng expired; one-null-path wire giữ nguyên), auth.csrf_denied (gate dispatcher leg CSRF qua tham số audit? thứ 4 — router không chứa mutation, Δ41). Zero-leak = CẤU TRÚC: event chỉ kind+reason(enum)+method+pathname+action; 5 họ sentinel vô hình trong mọi JSON (kể cả đường resolver THẬT). shell-server default sink console tại mount ⇒ production ghi ngay, attachAdminShell 0 đổi; invalid_shape không ghi — gap chủ đích (Δ44). +19 test (36→51, 13→17); 3 NC đặc hiệu (v1 TS2873 compile-dead KHÔNG tính; v2 10/68 đúng 10 test mới; B 2/68 đúng cặp expired; C 3/68 đúng nhóm csrf — 2 đỏ thừa = loopback flake, hardened Δ45); packet ×3 68/68 + rộng 170+7skip ×3 + lint/tsc 0 ĐẾM LẠI fresh sau revert. Δ41–Δ45 chờ adjudicate. G-SEC vẫn NO-GO.
- Chu kỳ 10 (Muc 10 — xem §10) đóng 2026-09-26: W-SEC-COOKIE-CONFIG-1 — đóng Δ27/Δ33: du_admin giờ dùng CÙNG policy với OIDC plane. shell-server đọc `parseCookieSecurePolicy(process.env)` MỘT lần tại mount → field optional `ShellRuntimeConfig.cookiePolicy` (vắng = legacy từng byte); router `legacyCookiePosture`: trust+strict-XFP chỉ NÂNG Secure một chiều, clear logout cũng mang posture nhưng KHÔNG bao giờ deny; requireSecure + unproven → 503 'Secure connection required' SAU credential check (401 shape còn nguyên — pin thứ tự), 0 Set-Cookie; env rác → throw tại mount cho cả hai bề mặt. +12 test (24→36; 9 unit + 3 leg qua REAL listener loopback socket), 2 negative control đỏ đặc hiệu (4/36 mint-secure, 1/36 denial) rồi ĐẾM LẠI packet×3 + rộng 151+7skip ×3 + lint/tsc = 0 trên cây revert. Δ36–Δ40 chờ adjudicate. G-SEC vẫn NO-GO.
- Chu kỳ 9 (Muc 9 — xem §9) đóng 2026-09-26: W-SEC-OIDC04-PROXY-1 (địa chỉ Δ26/Δ27). Policy mới: `x-forwarded-proto` chỉ được đọc khi operator bật `DU_ADMIN_TRUST_PROXY_PROTOCOL` (proof = MỘT token https, chuỗi phẩy/http/vắng = fail-closed); `DU_ADMIN_COOKIE_SECURE=enforce` hoặc `NODE_ENV=production` ⇒ requireSecure: origin http + trust off thì TỪ CHỐI BOOT; callback TLS-unproven bị 403 trước consume/exchange (không session, không Set-Cookie, con đường phục hồi sau proxy lỗi XFP vẫn còn — test challenge-đếm-pin); XFP chỉ NÂNG Secure một chiều, không hạ; logout không bao giờ deny. 6 file production (oidc-flow/oidc-boot + 3 dòng transport mount — Δ30), +19 test, mọi test cũ xanh không sửa. Chuỗi: packet x3 + rộng 11-suite 139+7skip x3 exit 0 SAU 2 negative control (6/35 đỏ, 5/35 đỏ) + lint/tsc 0. Δ27 mới đóng MỘT NỬA: primitive `parseCookieSecurePolicy` export rồi nhưng wiring du_admin cần `ShellRuntimeConfig` field — Δ33 chờ Admin. G-SEC vẫn NO-GO.
- Chu kỳ 8 (Muc 8 — xem §8) đóng 2026-09-26: W-OIDC04-SESSION-FLOW. **Chỉ sửa 1 test file** (`admin-shell-session-lifecycle.test.ts` 176→395, +14 test), **0 production diff** dù packet mở quyền sửa `shell-router.ts`: đo ra cả 4 yêu cầu đã đúng trong source. Hở thật tìm ra toàn là **thiếu bằng chứng**: (a) cờ `Secure` trên nhánh https **chưa từng có test nào chạy** (mọi publicOrigin trong cây test đều http); (b) CSRF chưa từng được phủ **toàn bảng** `ADMIN_ACTIONS`; (c) forged identity header **0 test**. Negative control: set `secure=false` cứng → đúng 2/24 đỏ rồi revert. `npx tsc --noEmit` đỏ lần đầu vì lane Admin đang refactor `server.ts` (2530→2920 dòng giữa phiên) — không sửa file người khác, đợi, đếm lại chuỗi 3 lần trên cây sạch, tsc cuối exit 0. Δ26: `Secure` dẫn từ `DU_ADMIN_OIDC_PUBLIC_ORIGIN`/redirect_uri, không đối chiếu protocol request → mục SEC-00/SEC-INT-02. Δ27: `du_admin` không Secure (shell-router.ts:916) nhưng không mint được khi flow mounted → việc lane Admin.
- Chu kỳ 7 (Muc 7 — xem §7) đóng 2026-09-26: W-SEC-STATUS-SYNC-1. Packet tài liệu thuần: `tasks/README.md` + `tasks/SEC-OIDC-VAULT-2026-09-24.md` (row `OIDC-03` `[ ]`→`[~]`, packet journal 6 dòng kèm mức khác nhau, 4 giới hạn của diện ACCEPTED, checklist browser OIDC-04 B0–B5 neo vào source hiện tại). **0 product diff, 0 DB window, 0 lệnh test** — mọi khẳng định là đối chiếu nguồn, không phải kết quả chạy. **Δ21**: 12 cell OIDC-03 xác thực bằng static `adminToken`/`tenantAdminTokens` nên **không** chạm `mapOidcClaimsToPrincipal` ⇒ claim path chỉ có bằng chứng offline, kể cả Δ13.
- Chu kỳ 6 (Muc 6 — xem §6) đóng 2026-09-26: W-SEC-RBAC-SYNC-1. Test-only: 3 cell live (M2/M3/M5) của `admin-action-rbac-live.test.ts` còn đọc `body.rows` trong khi ADM-UX-02 đã đổi sang envelope `items` → sửa theo nguồn thật (`server.ts:1179` + `listOperationsPage`), **không dùng fallback** (Δ17), **không đụng M4** vì route `/api/v1/admin/api-keys` vẫn trả `rows`. 0 production diff, 0 DB window (guard skip 12/12 exit 0, chuỗi 5 suite 3× exit 0, lint/tsc 0). Lane KHÔNG tuyên bố 12/12 — cần Tester live re-run (Δ19).
- Chu kỳ 5 (Muc 5 — xem §5) đóng 2026-09-26: W-SEC-CLAIM-ASSERT-1 (đóng finding Reviewer Turn 40). Luật đặt ở `packages/contracts/src/oidc-claim-shapes.ts` (thang đặc quyền + bảng 12 shape + `assertOidcClaimShapeContract`), ràng vào **hai mapper thật** ở orchestrator. ADR: bề mặt bearer **không bao giờ** cấp nhiều hơn bề mặt browser; chiều ngược (multi-tenant → viewer vs null) là cố ý. 14 test contracts + 8 test orchestrator mới. **Negative control**: tạm revert phần siết → 5/8 đỏ ⇒ suite thật sự bắt được nới rộng chứ không xanh giả. Phát hiện thêm 1 lỗ hổng shape: `tenantIds` có phần tử không phải string vẫn sinh principal (đã siết, Δ13 chờ quyết).
- Kết luận 4 mức: cycle 7 (ledger sync) = **VERIFIED bằng đối chiếu nguồn** — packet tài liệu thuần, **không có exit code nào** để báo. **OIDC-03 matrix = ACCEPTED** (Reviewer Turn 60 phán, Turn 70 xác nhận lại; Tester T-CODEX-TEST-20 đo 12/12 trên PG :5433 + Redis :6380, literal exit 0) nhưng **claim path chưa hề có bằng chứng sống** (Δ21). Cycle 6 = VERIFIED offline (guard skip, chuỗi 5 suite 3× exit 0); runtime 3 cell đã do Tester đo 12/12. Cycle 5 claim-shape contract = **VERIFIED (offline)** — contracts 14 test ×3 exit 0, orchestrator 10 suite 167/167 ×3 exit 0, contracts build + lint 0, orchestrator lint 0, **có negative control** chứng minh bắt được nới rộng. OIDC-02/03/04 tổng thể vẫn `[~]`: OIDC-02 chờ live legs của Tester-1; OIDC-03 đã có 12/12 live + ACCEPTED nhưng còn **claim path sống** (Δ21) và SEC-00 sign-off; OIDC-04 chờ **browser thật** (Δ11, task row đòi browser driver, loopback fetch chưa đủ) + SEC-00 sign-off. Siết `mapOidcClaimsToPrincipal` = IMPLEMENTED + VERIFIED offline nhưng **chưa ACCEPTED** (Δ13 chờ quyết). 3 skip `DU_LIVE_INFRA` = `[SKIP-QUALIFIED]` (skip ≠ pass). Lane KHÔNG tick task row.
- Việc còn lại (ngoài quyền lane): **coordinator/Reviewer quyết Δ13** (giữ hay bỏ phần siết 2 dòng trong `rbac.ts`; nếu bỏ thì phải xoá 2 dòng shape tương ứng khỏi bảng contract và ghi rõ đó là divergence không cố ý); Reviewer adjudicate Δ1–Δ45 (mới nhất cần quyết (cycle 11): **Δ41** — csrf_denied ghi ở gate dispatcher vì router không chứa mutation (đường revert: bỏ tham số audit? + dòng emit + 4 test oidc03; 4 kind router vẫn nguyên); **Δ42** — wiring JSON-plane chờ Platform MỘT dòng ở server.ts (lane không sửa file đó); **Δ43** — Redis-SETEX hòa tan expired vào absent_or_revoked (muốn chính xác cả Redis = đổi ngữ nghĩa repo, ngoài packet); **Δ44** — invalid_shape gap chủ đích (cần thì mở kind MỚI, lane không tự); **Δ45** — socket connect-retry, test-only, chỉ khi SYN chưa tới server. Quyết cũ: **Δ30** — 3 dòng transport mount ngoài chữ packet (cycle 9), revert path đã viết; **Δ32** — boot refusal là breaking cho deployment cấu hình http-origin trong production, runbook cần owner; **Δ33/Δ27 — cycle 10 đã ĐÓNG** theo packet W-SEC-COOKIE-CONFIG-1, chờ adjudicate **Δ36–Δ40** — placement env parse, shape denial 503, signature logout, không boot-refusal ở legacy plane, runbook nối dài); Tester chạy 3 live block (7 process + 3 Redis của OIDC-02, 10 ô D/X/M của OIDC-03 — `admin-action-rbac-live.test.ts` **đã chốt 12/12** bằng T-CODEX-TEST-20 và đã ACCEPTED; 7 live legs OIDC-02 vẫn chờ) và chạy **kịch bản browser OIDC-04 B0–B5** đã soạn trong `tasks/SEC-OIDC-VAULT-2026-09-24.md` và lấy **browser thật** cho OIDC-04 (Δ11); coordinator sửa danh sách file packet OIDC-04 (Δ8); `docs/28-test-inventory.md` + mục ADR trong docs của contracts cần owner được packet ủy quyền (contract mới chưa được đăng ký trong inventory) + 2 env mới của chính sách proxy (`DU_ADMIN_TRUST_PROXY_PROTOCOL`, `DU_ADMIN_COOKIE_SECURE`) chưa có trong `docs/runbooks/vault-oidc-operations.md` (Δ32/Δ34).
- Blocker tại thời điểm đóng chu kỳ 11: **không có gì new** — HEAD vẫn 7811298, không commit/push; 2 lần loopback-flake vận-hành (SYN nuốt trên port OS-chọn — s11-firstrun2 1 đỏ, s11-negc 2 đỏ THỪA) đã hardened test-only (Δ45) và ĐẾM LẠI fresh; nhiễm compile src/server.ts từ lane Platform (thiếu field sort trong OperationsListQuery) đỏ giữa chu kỳ rồi TỰ SẠCH — LINT_FINAL_EXIT=0/TSC_FINAL_EXIT=0 tính sau mọi revert và sau khi cây sạch.
- Blocker (lịch sử) tại thời điểm đóng chu kỳ 10: **không có gì new** — cây sạch suốt phiên (chu kỳ 8 nhiễm → 9–10 sạch liên tiếp), HEAD vẫn 7811298, không commit/push; footnote §10: echo exit của packet-×3-trước-NC nằm chung cfg-PKG.log (lỗi template replace, log từng run vẫn đúng). Chuỗi evidence cycle 10 sau 2 negative control (4/36, 1/36) được **đếm lại toàn bộ trên cây đã revert** (PACKET_F1/2/3, FINAL_R1/2/3, LINT_FINAL, TSC_FINAL — tất cả 0; cycle 9 cũng đã đếm lại tương tự). Keep-the-warning (cycle 8): nhiễm compile lane khác từng làm đỏ `npx tsc --noEmit` rơi `TSC_EXIT=2` với 4 lỗi chỉ trong `src/server.ts` khi lane Admin đang refactor (file lớn 2530 → 2920 dòng giữa phiên). Lane không sửa file người khác; đã đợi, chạy lại tới `TSC_FINAL_EXIT=0` và **đếm lại chuỗi 3 lần** trên cây sạch (`CLEAN_R1/2/3_EXIT=0`). Lần gần nhất bị nhiễm là cycle 2 (app/admin renderer TS1128), đã tự khỏi từ cycle 3. Cảnh báo vận hành (Δ14): **wrapper ngoài trả `Exit Code: 0` cả khi lệnh trong chuỗi đỏ** (lệnh cuối là `echo`) — phải đọc dòng `*_EXIT=` trong log thô; background shell của harness cycle này không khởi tạo được (không log, không file status) nên chain chạy foreground theo batch.
- Source of truth: `src/modules/admin-actions/rbac.ts` + `src/modules/admin-actions/dispatcher.ts` + `src/modules/auth/session-store.ts` + `src/app/admin/shell-router.ts` + `src/app/admin/shell-server.ts` + `tests/admin-shell-session-lifecycle.test.ts` + `tests/oidc03-role-action-tenant-offline.test.ts` (cycle 11 — audit taxonomy closed-form, classify seam, default sink tại mount), `services/orchestrator/src/app/admin/shell-router.ts` + `shell-server.ts` + `tests/admin-shell-session-lifecycle.test.ts` (cycle 10 — wiring du_admin Secure vào `ShellRuntimeConfig.cookiePolicy`, đóng Δ33; docblock Δ33-trước-đây trong `oidc-boot.ts` đã cập nhật), `services/orchestrator/src/app/admin/oidc-flow.ts` + `oidc-boot.ts` + `tests/oidc-cookie-secure-proxy-offline.test.ts` + `tests/oidc-boot.test.ts` (cycle 9 — policy proxy Secure; phần transport mount ở `shell-types.ts`/`shell-server.ts`/`shell-router.ts`, Δ30), `services/orchestrator/tests/admin-shell-session-lifecycle.test.ts` (cycle 8 — cookie posture https/http pair, CSRF toàn bảng action, forged header), `tasks/SEC-OIDC-VAULT-2026-09-24.md` (row OIDC-03 `[~]`, journal, 4 giới hạn, checklist B0–B5) + `tasks/README.md` (dòng SEC packet ledger) (cycle 7), `services/orchestrator/tests/admin-action-rbac-live.test.ts` (cycle 6), `packages/contracts/src/oidc-claim-shapes.ts` + `packages/contracts/tests/oidc-claim-shapes.test.ts` + `services/orchestrator/tests/oidc-claim-shape-contract-offline.test.ts` + `src/modules/admin-actions/rbac.ts` (cycle 5), `tests/admin-oidc04-claims-tenant-offline.test.ts` + `tests/stubs/mock-oidc-idp.ts` (cycle 4), `src/app/admin/shell-server.ts` + `tests/admin-error-boundary-offline.test.ts` (§3), `src/modules/admin-actions/dispatcher.ts` + `tests/oidc03-role-action-tenant-offline.test.ts` (§2), `tests/oidc02-process-replicas-offline.test.ts` (§1), receipt này. Log thô: `coordination/evidence/qwen-sec/*.log`. Không báo lại cái đã PASS; chỉ mở khi có packet.

## 1 — CYCLE 1: W-OIDC02-REPLICA-1 — offline revoke + restart/expiry giữa các replica

**File sửa:** `services/orchestrator/tests/oidc02-process-replicas-offline.test.ts` (451 → 551 dòng; 5 test mới + ghi chú header). **Production code: 0 diff** — `src/modules/auth/` không cần đổi; harness `tests/fixtures/oidc02-replica-harness.ts` + mock IdP (`setPrincipal`) đủ seam. Không commit/push. Không DB/Redis/S3 live — chỉ fake gateway in-process + mock IdP loopback (đúng chuẩn offline của suite này).

**Bối cảnh:** block live của file (Tester-1, gated) đã có các leg nuclear-revoke-at-A / RESTART / KILL+RESPAWN cross-TTL (reviewer audit 150-155 + W-OIDC02-LIVE-1R), nhưng phía offline chưa có bản mirror. Packet yêu cầu bổ sung offline cho revoke + restart/expiry → 5 test mới mirror từng leg, cộng 2 slice revoke còn thiếu (destroy đơn lẻ, principal isolation).

### Định nghĩa win/lose từng test mới
1. `destroy AT A bounces B on the browser surface and stays dead across a restart` — WIN: logout-surface 200 trước; `destroy` trả `true` rồi `false` (idempotent); `visit` → 302 trên CẢ replica thực thi lẫn foreign; graph restarted mới: `store.get` = null VÀ visit 302. LOSE nếu bất kỳ hop nào còn 200 hoặc destroy lần 2 trả true. → 6 assertions.
2. `a RESTARTED replica revokes sessions it never minted; re-login serves everywhere` — WIN: replica mới (chưa từng mint) `revokePrincipal` = 2 đúng đếm DEL thật; cả 3 replica × 2 sid đều 302; re-revoke = 0 (index đã xoá, không đếm bóng); principal re-login bình thường (revoke ≠ ban) và graph đã revoke phục vụ sid mới = 200. LOSE: count lệch, sót 302/200 nào. → 10 assertions.
3. `nuclear revoke is principal-surgical: mock-user-2 sessions survive on BOTH replicas` — WIN: revoke `mock-user-1` (1 session) giết đúng sid đó trên cả A/B; session `mock-user-2` (mint bằng `idp.setPrincipal`, role admin qua claim `platformAdmin`) vẫn 200 trên cả hai; revoke user-2 AT B giết trên A (browser surface). LOSE: bất kỳ casualty lầm lẫn nào giữa 2 principal. → 8 assertions.
4. `absolute deadline rides the SHARED record: no long-TTL replica resurrects a short-TTL session` — WIN (real clock, abs=1.6s): veteran 8h/30min phục vụ 200 giữa đời (deadline nằm trong record, reader tuning không đổi được); sau ~1.8s: veteran 302, RESTART-graph 302, short 302, `store.get` = null. Chứng minh death do deadline đã bake, KHÔNG do idle (1.8s ≪ 30min idle của reader dài). LOSE: bất kỳ 302 sớm / 200 muộn nào. → 6 assertions. Timeout 20s.
5. `idle clock is storage state: a restarted replica keeps alive what B touched` — WIN: B touch ở ~0.7s; graph A-mới ở ~1.4s vẫn 200 (đọc lastSeenAt CHUNG, không eviction lầm, không resurrection — touch chỉ gia hạn idle); im lặng >1.2s kể từ touch cuối → 302 trên restarted graph, B, lẫn graph lạ mới. LOSE: a2 mất session sớm (false eviction) hoặc mọi nơi còn 200 (idle không shared). → 6 assertions. Timeout 20s.

### Bảng chứng chạy (literal, wrapper của lenh)
cwd dispatch: `D:\Git\dugate`; pnpm trỏ workspace `du-rework` qua `-C`.
- Typecheck `pnpm -C D:\Git\dugate\du-rework --filter @du/orchestrator lint` (= `tsc --noEmit -p tsconfig.json`) TRƯỚC chuỗi test: `Exit Code: 0`.
- **Nhiễm bẩn ngoài lane (trước chuỗi chính thức):** run thử đầu `Exit Code: 0`; run thử thứ hai FAIL `Exit Code: 1` với lỗi TS compile `src/app/admin/operation-section-renderer.ts:342:4 error TS2366` — **file KHÔNG thuộc lane** (untracked, lane khác đang sửa; chính file đó làm `lint` rơi `Exit Code: 2` tại thời điểm kiểm tra). Lane KHÔNG sửa file người khác; đợi, lane kia tự khắc phục; `lint` green lại `Exit Code: 0`. Chuỗi 3-lan được ĐẾM LẠI TỪ ĐẦU sau hết nhiễm (run đỏ cũ không tính, run xanh trước nhiễm cũng không tính — bảo thủ).
- Chuỗi chính thức 3× `pnpm -C D:\Git\dugate\du-rework --filter @du/orchestrator test -- tests/oidc02-process-replicas-offline.test.ts tests/session-store.test.ts` (jest `--runInBand`, config gốc `jest.config.cjs`):
  - Lần 1: `PASS tests/session-store.test.ts` + `PASS tests/oidc02-process-replicas-offline.test.ts (11.287 s)`; `Test Suites: 2 passed, 2 total`; `Tests: 7 skipped, 28 passed, 35 total`; `Exit Code: 0`.
  - Lần 2: `PASS …oidc02-process-replicas-offline.test.ts (12.213 s)`; `Tests: 7 skipped, 28 passed, 35 total`; `Exit Code: 0`.
  - Lần 3: `PASS … (12.411 s)`, `Time: 12.753 s`; `Tests: 7 skipped, 28 passed, 35 total`; `Exit Code: 0`.
- Typecheck lại SAU chuỗi: `Exit Code: 0`.
- Phân phổ 28 passed = 10 offline process-replicas (5 cũ + 5 mới) + 18 session-store.test.ts. 7 skipped = đúng 7 live-gated `DU_LIVE_INFRA` (mint / logout-at-B / rotation / idle-expiry / nuclear-revoke / RESTART / KILL+RESPAWN) → gắn nhãn **[SKIP-QUALIFIED]**, chờ cửa sổ Tester-1, không tính vào pass.

### Δ-DEVIATION (đề nghị coordinator adjudicate)
- **Δ1:** Packet hàm ý có thể phải sửa `src/modules/auth/`; thực tế **0 production diff** — toàn bộ 5 kịch bản đi qua seam có sẵn (harness expose `store.destroy/revokePrincipal`, mock IdP expose `setPrincipal`). Không file nào trong `src/modules/auth/` được đụng.
- **Δ2:** Trong lúc lane chạy, `services/orchestrator/src/app/admin/operation-section-renderer.ts` (file ngoài phạm vi, untracked) tạm hỏng compile TS2366 làm ĐỎ một run thử của suite này (suite import shell-router → renderer qua dependency graph ts-jest). Lane không sửa; chủ file đã sửa; chuỗi bằng chứng được đếm lại từ đầu. Ghi để coordinator nắm: **khi nhiều lane cùng chạy jest trên một checkout, compile break của file shared = nguồn đỏ lẫn nhau** — kiến nghị chốt ownership hoặc chạy targeted theo worktree khi đang có sửa song song.

### Status trung thực 4 mức
- Lát test mới: SPECIFIED → IMPLEMENTED → **VERIFIED (offline, 3× exit 0, build hiện tại)**.
- ACCEPTED: KHÔNG tuyên bố — thuộc quyền Reviewer/Tester; OIDC-02 còn gates: live 7 legs (Tester-1 window) + các acceptance khác của task (cookie posture đã có sẵn test, không đổi).
- Test inventory docs (`docs/28-test-inventory.md`): lane này chưa được packet uy quyền sửa → ghi nhận là việc follow-on cho coordinator xếp owner.

— Qwen-SEC, 2026-09-26. Khuyến nghị /compress trước chu kỳ sau.


## 2 — CYCLE 2: W-OIDC03-RBAC-1 — assertRoleActionTenant (SEC-00 role × action × tenant + CSRF)

**File sửa (3):**
- `src/modules/admin-actions/dispatcher.ts` — THÊM gate thuần `assertRoleActionTenant(auth, action, resourceTenantId?)` (thứ tự bất biến: auth 401 → table 404 → CSRF trước role → role → operator-cần-tenant-server-side → **tenant binding** khi `resourceTenantId` là tenant ĐÃ LƯU của row được đưa vào); mismatch/tenant-lệch/rỗng/null → 403 `PERMISSION_DENIED` CÙNG MỘT message `mutations are scoped to the caller tenant` (no existence leak). `authorizeAdminAction` giờ là delegate byte-identical (thiếu `resourceTenantId` = quyết định lịch sử). Wiring: entry gate + bind-profile (thay `authorizeBindingTenant` trực tiếp, giữ nguyên wording) + cancel/resume re-assert trong tx với tenant vừa resolve (belt-and-braces, fail-closed, 0 đổi hành vi public).
- `tests/oidc03-role-action-tenant-offline.test.ts` — MỚI, 13 tests, zero DB/Redis/S3/socket.
- `rbac.ts` / `src/app/admin/*` / `server.ts`: **0 diff** (roster: không sửa Admin layout; Public API-key/runtime identity không đụng).
Không commit/push.

### Định nghĩa win/lose (13 tests)
**Group A — pure triple (6):**
1. Parity: `assertRoleActionTenant(auth, a)` ≡ `authorizeAdminAction(auth, a)` với 8 auth shapes × 10 actions + 1 action lạ (`toEqual` từng ô) — chứng minh không drift hành vi. LOSE: bất kỳ ô lệch.
2. Tenant ALLOW: bearer tenant_operator A & cookie operator(session-A)+CSRF trên 2 action admitted (cancel/resume) với resourceTenant=A → `{ok:true}` đúng shape.
3. Tenant DENY no-leak: caller A × resource ∈ {B, null, ''} → toàn 403/PERMISSION_DENIED, Set(messages).size=1, message đúng bản authorizeBindingTenant.
4. Unscoped (bearer platform, cookie admin+CSRF): mọi action × mọi resource tenant (kể cả null/'') → allow — đúng ma trận SEC-00 (platform toàn quyền action, không phải ô "đọc/mutate tenant khác" nào cho caller tenant-scoped).
5. Thứ tự-guard: null+tenant-arg vẫn 401; action lạ 404; CSRF-sai 403 CSRF (không cho probe tenant); viewer 403 role; operator-không-tenant 403 'server-side tenant' TRƯỚC binding-guard.
6. Scoped bearer KHÔNG phải chìa khóa toàn quyền: 8 action admin-only 403 'platform' dù truyền resourceTenant đúng của nó.
**Group B — wiring + zero side effect, counter-fakes (6):**
7. bearer operator × business.enable qua dispatch → 403, cả 9 counter = 0 (kể cả opSelects: không select vô ích).
8. bind-profile: operator 403 TRƯỚC key lookup (keyLookups 0, createRevision 0, audit 0).
9. **Forged browser identity không bao giờ tới triple**: store session operator@A + headers giả `x-du-tenant: B`+`x-du-role: admin` → resolver trả đúng {role operator, tenant A, csrfOk}; triple với resourceTenant=B → 403 'scoped'; dispatch cancel thật → 200, service nhận tenant A, audit tenant A. (Ô "direct HTTP header-forgery" bản offline; bản live thuộc M-group.)
10. Operator session cancel foreign op: service fence 404 không echo, audit 0 (in-tx triple không thêm audit thứ hai).
11. Platform cancel row của tenant khác: resolve SELECT 1 lần, unscoped allow → 200, cancelTenants[0]=tenant row.
12. Platform + cookie-admin bind key thuộc TENANT_B → 201/201, createRevision=2 (chiều tenant chỉ bind caller tenant-scoped).
**Group C — closure (1 test, 8 shapes × 10 actions × 3 resource tenants = 240 ô):**
13. Kỳ vọng tính LẠI từ luật (không chép fixture) khớp verdict từng ô; đếm cells = 240 assert. LOSE: 1 ô sai allow/deny hoặc sai họ message.

### Bảng chứng chạy (literal)
cwd `D:\Git\dugate`, pnpm `-C ...\du-rework`. Chuỗi 3× chính thức: `pnpm -C D:\Git\dugate\du-rework --filter @du/orchestrator test -- tests/oidc03-role-action-tenant-offline.test.ts tests/admin-action-dispatcher.test.ts tests/admin-actions-vault04-offline.functional.test.ts`:
- Lần 1: `PASS` cả 3; `Test Suites: 3 passed, 3 total`; `Tests: 88 passed, 88 total`; `Exit Code: 0`.
- Lần 2: idem 88/88; `Exit Code: 0`.
- Lần 3: idem 88/88, `Time: 2.853 s`; `Exit Code: 0`.
- Verbose riêng suite mới: `Tests: 13 passed, 13 total`; `Exit Code: 0`. (88 = 13 mới + 75 từ 2 suite regression — 2 suite cũ có loop-expanded its nên tổng jest > tổng it() tĩnh.)
- `lint` (tsc) toàn package: `Exit Code: 0` TRƯỚC khi file ngoài lane đỏ (chụp lúc dispatcher.ts+suite mới đã vào). Sau đó đỏ do `src/app/admin/operation-section-renderer.ts:500:1 error TS1128` (TS1128 persist ≥5 phút, chủ file đang sửa dở) → `Exit Code: 2`. Blast radius của lane (dispatcher + 3 suite) không import `app/admin` → ts-jest compile xanh độc lập trong cả 3 lần chạy (suite không chạy được nếu type sai).

### Δ-DEVIATION (đề nghị coordinator adjudicate)
- **Δ3:** Packet nguyên văn "Chạy typecheck và unit tests" như chu kỳ 1 nhưng không đưa lệnh cụ thể; lane dùng `pnpm --filter @du/orchestrator lint` (= tsc --noEmit, cùng lệnh chu kỳ 1) + jest packet-style. Package tsc tại thời điểm ĐÓNG receipt đang `Exit Code: 2` vì file NGOÀI lane (Δ4) — bằng chứng typecheck của lane là per-suite-graph xanh (ts-jest) + 1 lần tsc xanh giữa-chuỗi. Không tính package-tsc-red là đỏ của OIDC-03.
- **Δ4 (chuyển lane Admin):** `services/orchestrator/src/app/admin/shell-router.ts:799` từng truyền `listFilters` vào `OperationSectionRenderInput` (TS2353), hiện `operation-section-renderer.ts:500` TS1128 — chuỗi sửa dở của Admin lane làm đỏ `lint` + suite `admin-audit-scope.test.ts` (nó import shell-router). Lane SEC không sửa; kiến nghị coordinator nhắc lane Admin khóa file trước khi fleet chạy jest, và Tester cân nhắc chạy lại `admin-audit-scope` sau khi lane Admin xong (suite này KHÔNG nằm trong dependency graph của diff lane).

### Status trung thực 4 mức
- Triple gate + 13 test offline: SPECIFIED → IMPLEMENTED → **VERIFIED (offline, 3× exit 0)**.
- ACCEPTED: KHÔNG — OIDC-03 còn: 10 ô live D1–D4/X1–X2/M1–M6 (`admin-action-rbac-live.test.ts), cần DB window), role×action×tenant matrix chính thức từ SEC-00 (row SEC-00 vẫn `[ ]` — lane đọc ADR-17/docs-15 làm căn cứ, nếu SEC-00 chốt khác, adjudicate lại), docs traceability/inventory (chưa ủy quyền). Task row không tick.

— Qwen-SEC, 2026-09-26 (cycle 2). Khuyến nghị /compress.

## 3 — CYCLE 3: W-ADMBASE03-ERR-1 — ADM-BASE-03 error boundary + sentinel leak defense (offline)

**File sửa (2):**
- `src/app/admin/shell-server.ts` (đúng file packet cấp phép) — 3 điểm biên browser-tier giờ trả **đủ contract ADM-BASE-03** (code ổn định + correlationId nối được wire↔log, vẫn KHÔNG raw text):
  1. catch unhandled của `createServer`: 500 HTML = `safeTransportErrorText('Internal error')` + `Code: TEMPORARY_UNAVAILABLE` + `Correlation ID: <uuid>`; header `x-correlation-id`; log `[admin-shell] unhandled request error` nay mang `{correlationId, errorClass, routeId}` (class-only, không message/stack).
  2. catch deferred-render trong `writeResponseAsync` (đường degrade 200): log `deferred section render error` + `correlationId`; header `x-correlation-id` để nối wire↔log.
  3. catch deferred-render ngoài của `writeResponse`: log `deferred render error` + `correlationId`; header `x-correlation-id`.
  Không đổi status/content-type/status-code path cũ; tag log cũ giữ nguyên (webhook suite pin `'unhandled request error'` vẫn xanh).
- `tests/admin-error-boundary-offline.test.ts` — MỚI, 21 tests.
Không đụng `errors.ts`, `ingress.ts`, `server.ts`, `oidc-flow.ts`, `oidc-client.ts`, Admin layout khác, DB/Redis/S3. Không commit/push. Không mở DB window.

### Khoảng trống đã lấp (vì sao cần code change, không chỉ test)
Cycle 90 (Qwen-2) đã phủ errors.ts helpers, ingress stream, pane 'businesses' và structural pins cũ — nhưng **bề mặt lỗi browser-tier 500 chưa có test nào chạm** và **không có correlationId** (HTML chỉ có câu "Details redacted (see server log)" không có id để tra). ADM-BASE-03 đòi "vẫn có stable error code/correlation ID" ⇒ vá ở trên, test bên dưới pin lại.

### Định nghĩa win/lose (21 tests)
**Helpers (1):** sentinel `SENTINEL-SECRET-9999` + path `C:/du/vault/master.key` + DSN `postgres://du:S3cr3t@db.internal:5432/prod` đi qua `errorClassOf/safeTransportErrorText/safeInternalErrorProblem`: zero sentinel, `errorClass='QueryFailedError'`, problem đúng 6 key + `TEMPORARY_UNAVAILABLE` + correlationId. LOSE: 1 sentinel lọt hoặc shape lệch.
**Browser-tier unhandled (3, HTTP thật loopback, không DB):** stub OIDC flow nổ ở CẢ login+callback với Error(`Authorization=Bearer <SENT> file=<path> dsn=<dsn>`, name=`VaultError`):
1. callback 500: body zero sentinel, có câu fixed + `TEMPORARY_UNAVAILABLE`, header `x-correlation-id` = UUID và **cùng id xuất hiện trong HTML**; log error có tag + `"errorClass":"VaultError"` + cùng id; warn/info/log zero sentinel. LOSE: sentinel ở wire/log bất kỳ sink nào, hoặc thiếu id/code.
2. login 500: cùng contract (bề mặt thứ hai).
3. pane connectors (Vault-adjacent) nổ → degrade **200**, zero sentinel, `x-correlation-id` UUID = id trong log, `"errorClass":"Error"`.
**OIDC denial shape (3, pure inline):** exchangeAuthorizationCode nổ sentinel → đúng MỘT 403, zero sentinel, **không set-cookie**, challenge đã consume (1), `sessions.create` **0**; `?error=access_denied&error_description=<sentinel>` → 403 zero sentinel + challenge **không** bị burn (0); `handleLogin` upstream fail → **reject** (flow không dựng body) — boundary mới render.
**Structural pins (12 + 2):** 12 file (errors.ts, ingress.ts, server.ts, shell-server.ts, oidc-flow.ts, oidc-client.ts, 5× *-section-data.ts) không có `String(err)` / `err.message` / `err.stack` / `${err…}` trong **dòng code thực thi** (comment được phép nêu idiom); `server.ts` unhandled catch đi qua `sanitizedInternalError(`+`errorNameOf(`; `shell-server.ts` unhandled catch có `x-correlation-id`+code+`errorClassOf(err)` (pin hợp đồng mới).

### Bằng chứng chạy (literal)
cwd `D:\Git\dugate`, pnpm `-C ...\du-rework`.
- `pnpm -C D:\Git\dugate\du-rework --filter @du/orchestrator lint` (tsc --noEmit toàn package, SAU code+test): `Exit Code: 0`.
- Chuỗi 3× `pnpm -C D:\Git\dugate\du-rework --filter @du/orchestrator test -- tests/admin-error-boundary-offline.test.ts tests/adm-base-03-safe-error-offline.functional.test.ts tests/webhook-error-boundaries.boundary.test.ts tests/admin-shell-server.test.ts tests/admin-shell-session-lifecycle.test.ts`:
  - Lần 1: `PASS` cả 5; `Test Suites: 5 passed, 5 total`; `Tests: 137 passed, 137 total`; `Exit Code: 0`.
  - Lần 2: idem 137/137; `Exit Code: 0`.
  - Lần 3: idem 137/137, `Time: 6.59 s`; `Exit Code: 0`.
- Verbose suite mới: `Tests: 21 passed, 21 total`; `Exit Code: 0`.
- 4 suite regression trong chuỗi là regression THẬT cho diff này: `admin-shell-server.test.ts` + `admin-shell-session-lifecycle.test.ts` (driv `shell-server.ts`), `webhook-error-boundaries.boundary.test.ts` (pin tag log `'unhandled request error'` + problem+json API plane), `adm-base-03-safe-error-offline.functional.test.ts` (pin cũ vẫn xanh ⇒ không đụng bề mặt đã đóng). Suite live `admin-error-boundary.test.ts` **không chạy** (nằm trong `jest.unit.config.cjs` liveSuites — cần DB window, ngoài phạm vi offline).

### Δ-DEVIATION / ghi chú cho Reviewer
- **Δ5 (không sửa, chỉ minh bạch):** `src/modules/queue/dispatcher.ts:60` có `String(err)` — ĐÃ kiểm tra: chỉ dùng `msg.includes('already exists')` để rẽ nhánh dedup trong bộ nhớ, **không** persist/log/webhook. Đây là control-flow, không phải rò dữ liệu; lane không sửa (ngoài phạm vi), ghi để Reviewer khỏi re-flag.
- **Δ6:** ADM-BASE-03 evidence còn gọi "trace" sink (structured trace/Elasticsearch/browser trace). Trace/observability schema thuộc LOG-01/`@du/observability` (ngoài phạm vi packet này) — lane chỉ chứng minh được zero sentinel ở **wire + HTML + mọi console sink** + pin cấm raw echo. Gate trace thuộc SEC-INT-01 sink-scan matrix.
- **Δ7 (contract, đề nghị coordinator chốt):** correlationId mới sinh bằng `randomUUID()` ngay tại biên shell (không dùng `ctx.correlationId` của API plane vì sub-server không có request context). Nếu SEC-00/observability muốn shell dùng chung id với API plane thì cần một packet sửa `attachAdminShell`/config để truyền id xuống — **không tự mở**.

### Status trung thực 4 mức
- Biên browser-tier + IdP/Vault legs + pins: SPECIFIED → IMPLEMENTED → **VERIFIED (offline, 3× exit 0, 137/137)**.
- ACCEPTED: KHÔNG — ADM-BASE-03 còn: sink "trace" (Δ6), correlationId dùng chung (Δ7), và evidence live/sentinel-scan toàn hệ thống thuộc SEC-INT-01. Task row không tick.

— Qwen-SEC, 2026-09-26 (cycle 3). Khuyến nghị /compress.

## 4 — CYCLE 4: W-OIDC04-FLOW-1 — OIDC-04 full flow + multi-replica (verify, rồi đóng seam thiếu bằng chứng)

**File sửa (2, đều là test):**
- `tests/admin-oidc04-claims-tenant-offline.test.ts` — MỚI, 11 tests.
- `tests/stubs/mock-oidc-idp.ts` — thêm `platformAdminClaim?: unknown` (default-identical, xem Δ9).

**Production code: 0 diff.** `oidc-flow.ts`, `oidc-client.ts`, `rbac.ts`, `dispatcher.ts` **không đổi** — đo thì ra seam đó fail-closed ĐÚNG, chỉ là chưa có bằng chứng. Không commit/push, không DB/Redis/S3 live.

### Bước 1 — verify đúng như packet yêu cầu (không sửa gì)
Cả 7 file trong packet đều tồn tại. Chạy verbatim lệnh của packet: `Test Suites: 7 passed, 7 total`; `Tests: 3 skipped, 79 passed, 82 total`; `Exit Code: 0`. `pnpm --filter @du/contracts build` → `CONTRACTS_BUILD_EXIT=0`; `pnpm --filter @du/orchestrator lint` → `LINT_EXIT=0`. Xanh ngay từ đầu, nên packet KHÔNG cần code change.

### Bước 2 — đo coverage thật thay vì tin là đủ, và tìm ra 1 seam chưa ai chạm
Đối chiếu từng mục tiêu packet với test đang có (grep toàn `tests/`):
- **Auth Code + PKCE / loopback callback / cookie minting**: đã phủ (`admin-shell-oidc-flow-integration` chứng minh PKCE S256 với verifier server-side, `du_session` HttpOnly+SameSite=Lax+Path+Max-Age, ES256, code single-use, unknown-state 403).
- **`redirect_uri` loopback binding**: đã có sẵn pin ở **cả hai hop** — `admin-shell-oidc-flow-integration.test.ts:160` (authorize URL mang đúng REDIRECT_URI) và `oidc-client.test.ts:392` (form /token mang đúng REDIRECT). **KHÔNG phải gap** — đã xác nhận, không sửa gì.
- **Role claims injection**: đây là chỗ hở. Nhánh `operator` của `roleFor` chỉ được test qua **stub client** (`admin-oidc-flow.test.ts:147,151` dùng `st.overrides`); nhánh `platformAdmin` thì có test qua id_token thật nhưng **mặc định của mock IdP là `platformAdmin:true`** nên các shape tenant không bao giờ đi qua đường xác thực thật. `admin-action-dispatcher.test.ts` phủ `mapOidcClaimsToPrincipal` — một hàm **khác**, trên bề mặt bearer. `oidc03-role-action-tenant-offline.test.ts` chứng minh gate từ auth **tổng hợp**.
⇒ Hệ quả: **không test nào trong repo chứng minh** một claim `tenantIds` đã ký và xác thực thật biến thành `role=operator` + `tenantId=<đúng>` trong session record, và rằng gate đọc **đúng tenant đó**. Một regression ở đó (sai tên claim, `roleFor` trả viewer) sẽ chặn **mọi** write của operator, hoặc tệ hơn là mint admin — mà không test nào đỏ.

### Định nghĩa win/lose (11 tests)
Chuỗi thật trong cả 11 test: mock IdP loopback RS256 → `OidcClient` thật (sig/nonce/aud/iss) → `createOidcFlow` thật → `SessionStore` thật (memory repo) → `resolveAdminActionAuthAsync` thật → `assertRoleActionTenant` thật. Không fake counter, không DB.

**Nhóm A — claim → session record (6):**
1. `platformAdmin:true` → `{role:'admin', tenantId:null}` + sub/issuer khớp (control chống hồi quy).
2. `tenantIds:[TENANT_A]` → `{role:'operator', tenantId:TENANT_A}` ← **seam bị thiếu**.
3. `tenantIds:[A,B]` → viewer + tenantId null (default-deny).
4. `tenantIds:[]` → viewer + tenantId null.
5. claim thô `platformAdmin:"true"` (string) → **không** admin, rơi về viewer.
6. claim thô `tenantIds:"TENANT_A"` (string, không phải mảng) → không thành tenant, viewer + null.
LOSE nếu bất kỳ shape nào lên admin/operator sai, hoặc tenant rò ra record.

**Nhóm B — record → auth context → gate (5):**
7. Cookie thật resolve ra đúng `toEqual({kind:'cookie', role:'operator', tenantId:TENANT_A, csrfOk:true})`.
8. Session đó `operations.cancel`/`operations.resume` trong tenant của mình → `{ok:true}`; tenant lạ **và** `null` → 403 `PERMISSION_DENIED` đúng wording `mutations are scoped to the caller tenant`.
9. Thiếu csrf → bị chặn ở **chân CSRF**; csrf tự chọn (`attacker-chosen`) cũng `csrfOk:false` → cùng 403 (header không tự phúc vụ).
10. Operator bị chặn `apikey.bind-profile` (admin-only) **ngay trên tenant của mình**.
11. Viewer (multi-tenant) không chạm được action operator nào, nhưng `GET /admin` vẫn 200 — session hợp lệ, chỉ không có quyền mutate.

### Bằng chứng chạy (literal)
cwd `D:\Git\dugate`, pnpm trỏ workspace `du-rework` qua `-C`. Log thô: `du-rework/coordination/evidence/qwen-sec/`.
- Lệnh packet verbatim (7 suite): `Test Suites: 7 passed, 7 total`; `Tests: 3 skipped, 79 passed, 82 total`; `Exit Code: 0` → `oidc04-run1.log`.
- `@du/contracts build`: `CONTRACTS_BUILD_EXIT=0`; `@du/orchestrator lint`: `LINT_EXIT=0` → `oidc04-build-lint.log`.
- Suite mới chạy riêng: `Tests: 11 passed, 11 total`; `Exit Code: 0` → `oidc04-new-suite.log`.
- **Chuỗi 3×** trên **9 suite** (7 của packet + `admin-oidc04-claims-tenant-offline` mới + `oidc02-process-replicas-offline` — xem Δ8): mỗi lần `Test Suites: 9 passed, 9 total`; `Tests: 10 skipped, 101 passed, 111 total`; `CHAIN_RUN1_EXIT=0`, `CHAIN_RUN2_EXIT=0`, `CHAIN_RUN3_EXIT=0`, `CHAIN_LINT_EXIT=0` → `oidc04-chain.log`.
- **10 skip = `[SKIP-QUALIFIED]`, KHÔNG tính là pass**: 7 leg `DU_LIVE_INFRA` hai process thật + Redis thật (`oidc02-process-replicas-offline.test.ts:391-511`) và 3 leg real Redis (`oidc02-multi-replica-offline.test.ts:341-365`). Cần `REDIS_URL` :6380 + cửa sổ Tester; ngoài phạm vi offline.
- 3 suite dùng chung `tests/stubs/mock-oidc-idp.ts` đều nằm trong chuỗi và xanh ⇒ Δ9 không đổi hành vi ai.

### Δ-DEVIATION / ghi chú cho Reviewer
- **Δ8 (packet bỏ sót file — đề nghị coordinator sửa danh sách):** mục tiêu "multi-replica session invalidation" nhưng danh sách 7 file **không có** `tests/oidc02-process-replicas-offline.test.ts` — file duy nhất phủ multi-replica ở **bề mặt browser** (cookie 302 trên từng router, destroy/revoke/restart/rotation qua các process). `oidc02-multi-replica-offline` chỉ phủ tầng store/dispatcher. Lane tự thêm vào chuỗi; packet sau nên chứa nó.
- **Δ9 (sửa fixture dùng chung, nêu rõ vì sao bắt buộc):** `tests/stubs/mock-oidc-idp.ts` ép `if (principal.platformAdmin) idClaims.platformAdmin = true` — tức **tự coerce thành boolean trước khi ký**, nên không có cách nào giao claim thô (string/number) cho `OidcClient` xác thực mà không sửa stub. Đã thêm `platformAdminClaim?: unknown`: khi field có mặt thì ký **đúng giá trị thô**, vắng thì giữ nguyên hành vi cũ. Không đụng production, không đổi semantics của bất kỳ test hiện có.
- **Δ10 (quan sát, KHÔNG tự sửa):** hai bề mặt xử lý claim multi-tenant **khác shape nhau** — browser (`roleFor`) sinh session `viewer` (hợp lệ, least privilege) còn bearer API (`mapOidcClaimsToPrincipal`) trả **null** (không có principal). Cả hai đều default-deny, nhưng một refactor "hợp nhất hai bên" sai sẽ đổi hành vi của một trong hai mà không có test nào bắt. Giao Reviewer quyết.
- **Δ11:** OIDC-04 theo task row cần **browser thật** qua fake IdP ("Không nhận DOM-only test là bằng chứng mutation"). Chuỗi này dùng HTTP loopback thật + router thật nhưng **không** có browser driver ⇒ chưa đủ để ACCEPT. Thuộc SEC-INT-01/Tester; lane không tự mở.

### Status trung thực 4 mức
- 5 mục tiêu packet ở lát offline: SPECIFIED → IMPLEMENTED → **VERIFIED (3× exit 0, 9 suite 101/101, thêm 11 test mới)**.
- `redirect_uri` loopback binding: đã VERIFIED sẵn từ trước (2 hop), không cần thay đổi.
- **ACCEPTED: KHÔNG.** Còn: browser thật (Δ11), 10 leg `DU_LIVE_INFRA` (OIDC-02), 10 ô live D/X/M (OIDC-03), SEC-00 sign-off. Task row OIDC-04 **không tick**.

— Qwen-SEC, 2026-09-26 (cycle 4). Khuyến nghị /compress.

## 5 — CYCLE 5: W-SEC-CLAIM-ASSERT-1 — contract assertion claim-shape: browser `roleFor` vs bearer `mapOidcClaimsToPrincipal`

**File sửa (5):**
- `packages/contracts/src/oidc-claim-shapes.ts` — MỚI. Luật (thang đặc quyền `none < read-only < tenant-write(tenant) < platform-write`), bảng 12 shape claim → đặc quyền của **hai** bề mặt, và `assertOidcClaimShapeContract()` — assertion thuần, zero dependency, đặt trong package hợp đồng nên mọi peer import được. ADR rationale nằm trong docblock.
- `packages/contracts/src/index.ts` — +1 dòng export.
- `packages/contracts/tests/oidc-claim-shapes.test.ts` — MỚI, 14 test: bảng tự thỏa + **6 ca âm tính** chứng minh assertion có răng.
- `services/orchestrator/tests/oidc-claim-shape-contract-offline.test.ts` — MỚI, 8 test: **ràng bảng vào mapper thật** của cả hai bề mặt.
- `services/orchestrator/src/modules/admin-actions/rbac.ts` — siết 2 dòng (xem Δ13).

Không commit/push. Không DB/Redis/S3/Vault live: bề mặt browser đi qua `OidcClient` thật + cặp RSA thật ký id_token RS256 thật (chỉ inject `FetchLike` — signature, iss allowlist, aud, exp, nonce đều chạy thật); bề mặt bearer gọi thẳng hàm thật.

**Audit yêu cầu gì.** Reviewer Turn 40 (`review.md:24`): hai bề mặt cố ý khác nhau nhưng chỉ được mô tả bằng văn xuôi, nên cần ADR/contract assertion để refactor sau **không thể âm thầm nới rộng bearer access**. Đây chính là Δ10 cycle 4 ghi nhận.

**ADR — luật được máy kiểm.** Với **mọi** claim shape, bề mặt bearer **không bao giờ cấp nhiều hơn** bề mặt browser (`dominatesOidcPrivilege(adminShell, platformApi)`). Browser là mỏc least-privilege: thứ nó cấp cho con người thì API server-to-server cũng được phép làm — nên đây là neo của invariant. Chiều ngược lại thì **cố ý cho phép**: multi-tenant sinh session `viewer` chỉ-đọc ở browser còn bearer trả `null`. Hai thứ đó không thể thay nhau (một session đã mint vs. không có principal), và API không cần phát quyền đọc shell ra token. Vì vậy lane **không** ép hai bề mặt bằng nhau, chỉ ép một chiều. Ngoài ra: shape hostile (sai kiểu) phải vô quyền trên **cả hai**; và có **sàn bao phủ** (≥1 platform, ≥1 tenant, ≥1 read-only, ≥1 hostile) để bảng không thể bị làm nghẽo bằng cách xoá dòng.

**Shape thô mới tìm ra (Δ13 — cần adjudicate).** Khi đo từng shape qua mapper thật, phát hiện một chỗ **không cố ý**: `mapOidcClaimsToPrincipal` trả principal với `tenantId` là phần tử 0 khi `tenantIds.length === 1` mà **không kiểm tra kiểu phần tử**. Nên `tenantIds: [42]` và `tenantIds: [""]` đều **có principal**, trong khi `roleFor` bên browser deny cả hai. `OidcAdminClaims.tenantIds?: string[]` chỉ là hư cấu compile-time: giá trị là JSON ra từ id_token đã verify, shape runtime không được tin. Đã siết thành `typeof tenantId === "string" && tenantId.length > 0` — fail-closed, **đúng y như `roleFor`**. Hành vi ở gate **không đổi**: principal mang tenantId không khớp row nào vốn đã bị `assertRoleActionTenant` chặn 403, nên đây là bỏ một principal chết chứ không phải đổi quyền. Đây là **production diff ngoài chữ add test của packet** → giao coordinator/Reviewer; lane ghi Δ13, không tự coi là ACCEPTED.

### Định nghĩa win/lose

**Contracts (14 test).** Bảng thỏa assertion của chính nó; mỗi dòng có id ổn định + lý do viết ra; lớp hostile vô quyền cả hai bề mặt; 6 ca âm tính phải **đều đỏ**: bearer mạnh hơn shell, hostile được cấp quyền (cả hai hướng, kèm ca API mạnh hơn bị chặn đúng rule), hai bề mặt ràng vào **hai tenant khác nhau**, bảng rỗng, bảng bị cắt còn một dòng lành mạnh (vi phạm sàn bao phủ), id trùng hoặc rỗng. Thang đặc quyền: platform > tenant > read-only > none, hai tenant chỉ bằng nhau khi **cùng id**.

**Orchestrator (8 test), ràng vào mapper thật.** Mỗi dòng của bảng chạy qua **cả hai** mapper thật rồi so với giá trị pin. Phía browser đọc lại privilege từ `SessionRecord` phía server (đúng thứ gate sẽ dùng sau này), không đọc giá trị `roleFor` trả về. Invariant ADR được **tính lại từ output quan sát được**, không đọc từ bảng — nên sửa bảng cho khớp với mapper đã bị nới rộng vẫn đỏ. Ba test khóa riêng: không có API write nào mà thiếu write tương ứng ở shell; các dòng well-formatted mà shell cấp nhiều hơn API đúng **hai** dòng đã tài liệu hoá; `tenantIds` là `[42]`, `[""]`, `[null]`, `[{}]`, `[[]]` thì không sinh principal nào, còn single-tenant hợp lệ **vẫn** map (siết không overshoot).

**Negative control (bằng chứng mạnh nhất của cycle này).** Không tin xanh là đúng, nên đã **tạm revert** đúng phần siết của `rbac.ts` rồi chạy lại suite mới: `Tests: 5 failed, 3 passed, 8 total`, `NEGCONTROL_EXIT=1`, và log chỉ ra đúng đường leo thang: `tenant-member-not-a-string: api {"kind":"tenant-write","tenantId":42} != contract {"kind":"none"}` cùng `tenant-member-empty-string: api {"kind":"tenant-write","tenantId":""}`. Tức suite **bắt được** việc nới rộng bearer, không xanh giả. Đã revert ngay sau đó và chạy lại chuỗi chính thức từ đầu.

### Bảng chứng chạy (literal)

cwd dispatch `D:\Git\dugate`, pnpm trỏ workspace `du-rework` qua `-C`.
- `@du/contracts lint` (tsc --noEmit): `CONTRACTS_LINT_EXIT=0`.
- `@du/orchestrator lint` (tsc --noEmit -p tsconfig.json): `ORCH_LINT_EXIT=0`.
- `@du/contracts build` (tsc -p): `CONTRACTS_BUILD_EXIT=0` (log `claim-orch-build.log`, build **sau** khi đã đảo thứ tự hai nhánh assert — orchestrator import `@du/contracts` qua `dist`, build cũ sẽ ra bằng chứng sai).
- Suite contracts 3×: `Tests: 14 passed, 14 total` ×3; `CRUN1=0 CRUN2=0 CRUN3=0`.
- Chuỗi orchestrator 10 suite 3×: `Test Suites: 10 passed, 10 total` / `Tests: 3 skipped, 167 passed, 170 total` ×3; `CHAIN_RUN1_EXIT=0 CHAIN_RUN2_EXIT=0 CHAIN_RUN3_EXIT=0`.
- Negative control: `Tests: 5 failed, 3 passed, 8 total`, `NEGCONTROL_EXIT=1` (đỏ **có chủ đích**, giữ nguyên log làm bằng chứng).

**Chuỗi 10 suite gồm gì và vì sao.** Một suite mới + mọi test file import `admin-actions/rbac` (grep 17 match → 6 file test) + các suite đi qua `roleFor`: `oidc-claim-shape-contract-offline` (mới), `admin-action-dispatcher`, `oidc03-role-action-tenant-offline`, `admin-oidc04-claims-tenant-offline`, `admin-oidc-flow`, `admin-shell-oidc-flow-integration`, `oidc-client`, `oidc02-multi-replica-offline`, `gsec-sentinel-rbac.boundary`, `admin-actions-vault04-offline.functional`. Không kèm `admin-action-rbac-live.test.ts` (`DU_LIVE_INFRA` + cửa sổ DB — packet cấm).

**Ba skip là [SKIP-QUALIFIED], không tính pass.** `oidc02-multi-replica-offline.test.ts:305` — block `DU_LIVE_INFRA=1` real Redis, cần `REDIS_URL` :6380 thật, thuộc cửa sổ Tester-1; không liên quan thay đổi này.

### Δ-DEVIATION / ghi chú cho Reviewer

- **Δ12 (packet nói packages/contracts **hoặc** services/orchestrator — lane làm cả hai, chia vai):** luật đặt ở `packages/contracts` (đúng nơi hợp đồng dùng chung thuộc về, và Reviewer soát nói contract assertion), còn **ràng buộc** đặt ở orchestrator vì hai mapper ở đó. Nếu coordinator muốn luật ở contracts thì phần ràng buộc vẫn phải ở orchestrator — package contracts không import được code của service. Hai package, một luật, không nhân bản.
- **Δ13 (production diff, cần quyết):** xem mục "Shape thô mới tìm ra". Siết fail-closed, gate không đổi hành vi, nhưng packet viết "add contract assertion and offline test" nên lane **tự sửa hai dòng production** rồi giao Reviewer/coordinator adjudicate. Nếu quyết định là chỉ được thêm test thì hướng sửa là **giữ** nguyên `rbac.ts` và **xoá** hai dòng shape `tenant-member-not-a-string` / `tenant-member-empty-string` khỏi bảng và khỏi test ràng buộc, thay bằng ghi rõ trong ADR rằng đây là divergence không cố ý. Lane không tự chọn.
- **Δ14 (bẫy bằng chứng, áp dụng cho lane sau — KHÔNG phải lỗi code):** khi nối nhiều lệnh trong một `cmd /v:on /c` để ghi exit code vào log, **wrapper ngoài trả Exit Code 0 bất kể lệnh trong chuỗi có đỏ hay không**, vì lệnh cuối là `echo`. Cycle này suýt ghi nhầm exit 0 cho một run contracts thực sự đỏ (`CONTRACTS_TEST_EXIT=1` trong log, wrapper vẫn 0). Luật: **exit code lấy từ dòng `*_EXIT=` trong log thô, không lấy từ wrapper** khi lệnh đã bị gộp. Cùng bẫy đó xuất hiện lần nữa ở **chiều ngược lại**: script chain viết ra `.cmd` rồi launch bằng background shell đã không chạy (không log, không file status), nhưng harness vẫn báo `completed, exit-code 0` khi tiến trình kết thúc — tức **một "thành công" ảo cho công việc chưa từng chạy**. Đã kiểm bằng cách đối chiếu mốc sửa và nội dung log: `claim-summary.txt` không tồn tại, các log mà script kia lẽ ra phải ghi (`claim-build2.log`, `claim-contracts-run*.log`) không hề có, còn `claim-chain-run1/2/3.log` của chuỗi chính thức vẫn nguyên (10 suite, `CHAIN_RUN*_EXIT=0`). Bài học: **không tin wrapper theo cả hai chiều** — đỏ bị báo xanh, và không chạy bị báo xong; chỉ tin dòng `*_EXIT=` trong log thô. Script `.cmd` đó đã xoá khỏi thư mục evidence vì tên nó gợi sai nguồn gốc của chuỗi test.

- **Δ15 (tự bắt lỗi trong việc của chính mình, đáng ghi vì nó là lý do cần ca âm tính):** assertion ban đầu kiểm tra bearer mạnh hơn shell **trước** ràng buộc khác tenant, nên nhánh thứ hai **không bao giờ chạy được** (cùng bậc nhưng khác tenant đã fail luật thứ tự trước rồi). Đã đảo thứ tự để nhánh đặc thù bắt trước, ca test tương ứng xanh lại. Nếu chỉ viết ca dương thì lỗi này lọt.
- **Δ16 (phạm vi, nói rõ để không ai tưởng đã phủ):** contract này phủ **shape claim → đặc quyền**. KHÔNG phủ issuer allowlist, thuật toán/signature, nonce/exp (thuộc `oidc-client.ts`), không phủ storage session (OIDC-02) và không phủ hành vi gate (OIDC-03 — đã có suite riêng). Nó cũng không thay bằng chứng browser thật của OIDC-04 (Δ11).

### Status trung thực 4 mức
- Contract assertion + bảng + ràng buộc hai mapper: SPECIFIED → IMPLEMENTED → **VERIFIED (offline)** — contracts 14 test 3× exit 0, orchestrator 10 suite 167/167 3× exit 0, lint + build 0, **có negative control chứng minh bắt được nới rộng**.
- Siết `mapOidcClaimsToPrincipal` (Δ13): **IMPLEMENTED + VERIFIED offline**, chưa ACCEPTED — chờ coordinator/Reviewer quyết có giữ hay không.
- **ACCEPTED: KHÔNG.** Reviewer Turn 40 chỉ đóng được khi có quyết Δ13; SEC-00 sign-off, browser thật (Δ11), 10 leg `DU_LIVE_INFRA` và 10 ô live D/X/M vẫn mở. Lane KHÔNG tick task row, KHÔNG sửa `docs/28-test-inventory.md` (chưa được uy quyền).

— Qwen-SEC, 2026-09-26 (cycle 5). Khuyến nghị /compress.

## 6 — CYCLE 6: W-SEC-RBAC-SYNC-1 — đồng bộ contract envelope cho `admin-action-rbac-live.test.ts` (M2/M3/M5)

**File sửa (1):** `services/orchestrator/tests/admin-action-rbac-live.test.ts` — 3 assertion (M2, M3, M5) + 2 dòng docblock header của chính M2/M5 + 2 comment. **0 production diff.** Không commit/push. Không mở DB window (suite vẫn `describe.skip` offline).

**Bối cảnh:** T-CODEX-TEST-19 chạy live trên PG :5433 / Redis :6380 đưa 9/12 pass (D1-D4, M1, M4, M6, X1, X2), 3 cell M2/M3/M5 đỏ vì test còn đọc `res.body.rows` của hợp đồng cũ.

**Kiểm chứng độc lập trước khi sửa (không tin packet mù).** Đọc nguồn thật của `GET /api/v1/operations`:
- `server.ts:1179` và `listOperationsPage` trả về **`{ items, nextCursor, prevCursor, total, limit }`** — comment ghi rõ ADM-UX-02 đã thay hai envelope cũ bằng MỘT query contract và **`total = rows.length` không còn tồn tại**.
- `opAHeaders()` và `platformHeaders()` đều là **bearer** (`authorization: Bearer ...`, không có `x-api-key`) ⇒ cả M2/M3/M5 đi nhánh `resolveAdminPrincipal` với `project = toOperationDetailWire`.
- Item có `tenantId` (do `toOperationDetailWire` thêm từ `r.tenant_id`) và có `id` (do `toOperationView`) ⇒ assertion theo-tenant của M2 và `rowsB[0].id` của M3 hợp lệ trên key mới.
- `nextCursor` và `prevCursor` là shorthand property **luôn hiện diện** (giá trị có thể null), nên M5 so key SET chính xác chứ không phải subset.

**Quyết định: KHÔNG dùng fallback.** Packet cho phép `res.body.items` hoặc fallback. Lane chọn **`res.body.items` thuần, không fallback về `rows`**: fallback sẽ khiến đúng cái regression này (ai đó revert về envelope cũ) **pass âm thầm**, tức vô hiệu hoá lý do tồn tại của M5. Ghi ở Δ17.

**Cụ thể đã sửa.** M2: `res.body.rows` → `res.body.items`. M3: `listB.body.rows` → `listB.body.items`. M5: tiêu đề test + `Object.keys(res.body).sort()` → 5 khóa mới, kèm `Array.isArray(items)` và `limit === 20` (packet nói cập nhật key assertion ở M5 — lane thêm 2 assertion vì chỉ so key set thì chưa đủ bắt `total` kiểu cũ). Docblock header của M2/M5 cũng mang hợp đồng cũ nên được sửa theo.

**M4 KHÔNG đụng — và đó là chủ đích.** M4 vẫn đọc `list.body.rows` cho `/api/v1/admin/api-keys`; route đó **vẫn trả** `rows` (`server.ts:1889`, `1907`), khớp với việc Tester báo M4 pass. Đồng bộ luôn M4 sẽ làm một test đang xanh thành đỏ.

### Bảng chứng chạy (literal)

- Guard offline `pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts`: `Test Suites: 1 skipped, 0 of 1 total` / `Tests: 12 skipped, 12 total`, `GUARD_EXIT=0`, kèm đúng dòng cảnh báo `SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window` — tức **không có kết nối DB nào được mở**.
- Chuỗi offline 5 suite 3×: `Test Suites: 1 skipped, 4 passed, 4 of 5 total` / `Tests: 12 skipped, 147 passed, 159 total`; `RUN1_EXIT=0 RUN2_EXIT=0 RUN3_EXIT=0` (live-guard + `admin-operations-list-pagination` + `admin-action-dispatcher` + `oidc03-role-action-tenant-offline` + `oidc-claim-shape-contract-offline`).
- `@du/orchestrator lint` (= `tsc --noEmit -p tsconfig.json`): `LINT_EXIT=0` trước chuỗi, `LINT2_EXIT=0` sau chuỗi; `npx tsc --noEmit -p tsconfig.json` chạy độc lập: `TSC_SRC_EXIT=0`.

**Bằng chứng offline mạnh nhất cho M5 (vì lane không được mở DB).** Không cần tin lời lane: `tests/admin-operations-list-pagination.test.ts:972` **đã pin đúng key set đó offline** với 5 khóa items/limit/nextCursor/prevCursor/total, và suite đó drive **chính route handler thật** (`route(ctx)` với db giả) — kèm test riêng chứng minh `total` là COUNT của quần thể được lọc (`total` = 42 trong khi page chỉ có 1 row). Lane không tự mở production để tạo bằng chứng mới; lane khớp assertion live vào hợp đồng đã được kiểm offline.

### Δ-DEVIATION / ghi chú cho Reviewer

- **Δ17 (quyết định trong phạm vi packet, nêu rõ để không bị sửa lại):** không dùng fallback, dù packet cho phép. Lý do: fallback làm M5 mất khả năng phát hiện revert envelope — đúng cái regression mà cell này sinh ra để bắt.
- **Δ18 (giới hạn của chính bài kiểm tra này, cần biết khi đọc bằng chứng):** `tsc --noEmit` **không thể** bắt lớp lỗi này, vì helper `call()` trả `body: Record<string, unknown>` và test **tự cast** — nên `body.rows` cũ vẫn compile sạch. Bằng chứng offline của lane do đó chỉ chứng minh *compile + skip guard*; **đúng/sai runtime của M2/M3/M5 chỉ live re-run mới kết luận được**. Hướng sửa lâu dài (không làm trong packet này): cho `call()` trả envelope có kiểu để hết cast. Ghi để lane khác đừng tưởng lint xanh là contract đúng.
- **Δ19 (phạm vi tuyên bố):** lane **không** tuyên bố 12/12. Trạng thái trung thực của 3 cell sau thay đổi là *đã đồng bộ theo hợp đồng đã kiểm offline, chờ live re-run*; nếu Tester vẫn đỏ thì nguyên nhân không còn là `rows` nữa (đã loại trừ bằng nguồn + test offline ở trên).
- **Δ20 (khách quan về công cụ):** chuỗi 3× và guard chạy **foreground theo batch**; mọi exit code lấy từ dòng `*_EXIT=` trong log thô theo đúng bài học Δ14, không tin wrapper.

### Status trung thực 4 mức
- Đồng bộ M2/M3/M5 + docblock: SPECIFIED → IMPLEMENTED → **VERIFIED (offline)** — compile sạch, guard skip 12/12 exit 0, chuỗi 5 suite 3× exit 0, key set khớp hợp đồng đã pin offline.
- **ACCEPTED: KHÔNG.** Cần Tester chạy lại `admin-action-rbac-live.test.ts` trong cửa sổ DB/Redis thật để xác nhận **12/12**; đó vẫn là gate của OIDC-03/SEC-00. Lane không tick task row, không sửa docs.


— Qwen-SEC, 2026-09-26 (cycle 6). Khuyến nghị /compress.

## 7 — CYCLE 7: W-SEC-STATUS-SYNC-1 — đồng bộ trạng thái SEC sau kiểm toán Turn 60

**File sửa (2, đều là tài liệu ledger):** `tasks/README.md` (thêm 1 dòng packet ledger) + `tasks/SEC-OIDC-VAULT-2026-09-24.md` (row `OIDC-03` `[ ]` → `[~]`, thêm mục *Nhật ký packet SEC lane*, *Bốn giới hạn của diện ACCEPTED*, *Checklist bàn giao cho Tester — browser OIDC-04* B0–B5). **0 product code diff.** Không commit/push. **Không mở DB window.** **Không chạy test nào trong cycle này** — không có code sản phẩm nào đổi nên không có exit code nào để báo; mọi khẳng định dưới đây là **đọc nguồn và đối chiếu receipt**, không phải kết quả chạy của lane.

### 7.1 Kiểm toán Turn 60 — đã đọc, và Turn 70 đã xác nhận lại

Turn 60 nằm ở `coordination/reports/review.md:132` (mục Turn 60 independent audit). **Có thêm Turn 70** ở `review.md:100` — re-validation, xác nhận lại 5 packet của Turn 60 và kết luận *packet-level ACCEPTED status from Turn 60 stands*, đồng thời giữ nguyên `G-ADMIN-OPS`/`G-SEC`/`G-DATA`/`G6` là NO-GO. Nói về SEC, audit chốt: OIDC-03 HTTP matrix có re-validation sống 100% và được ACCEPT **đúng phạm vi**; `G-SEC` còn Vault migration/policies + browser OIDC-04 + SEC-INT; và yêu cầu giữ receipt đỏ cũ làm lịch sử.

### 7.2 Xác minh receipt T-CODEX-TEST-20 trước khi ghi vào ledger

Đọc `coordination/reports/tester.md:7408` (không chỉ tin lời packet): `CLAIM_DB_WINDOW` 2026-09-26 05:16:16 +07 → `RELEASE` 05:17:24 +07; cwd `D:\Git\dugate\du-rework`; HEAD `7811298844450f373687c478d08d1edfa53ae124`; `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@localhost:5433/du_orchestrator_test`, `REDIS_URL=redis://localhost:6380`; lệnh `pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts`; literal ExitCode `0`; **tests 12 passed, 0 failed, 0 skipped (12 total)**; không sửa source/commit/push. Log thô `coordination/reports/T-CODEX-TEST-20-live-reval.log` — **đã kiểm file tồn tại**, nhưng `du-rework/.gitignore:9` có `*.log` nên link đó **không portable sang clone mới**; đã ghi chú ngay trong ledger thay vì để người đọc tưởng là link bền.

### 7.3 Δ-DEVIATION / phát hiện

- **Δ21 (quan trọng nhất của cycle này, đã ghi vào cả hai ledger): 12 cell ACCEPTED KHÔNG chạm tới mapper claim → principal.** Suite live xác thực bằng `adminToken` + `tenantAdminTokens` qua `resolveAdminPrincipal` (`src/modules/admin-actions/rbac.ts:30-44` chỉ tra config, không đọc id_token), và `createApp` trong suite truyền đúng `tenantAdminTokens: { [OP_A_TOKEN]: TENANT_A }`. Hệ quả: (a) nhánh `mapOidcClaimsToPrincipal` — kể cả phần siết Δ13 của cycle 5 — **chỉ có bằng chứng offline**, chưa từng được matrix sống nào chạm tới; (b) đừng đọc dòng OIDC-03 `[~]` là đã live-verify claim path. Đây không phải lỗi của ai, là **giới hạn phạm vi cần ghi**, và chính nó là lý do OIDC-04 browser vẫn cần.
- **Δ22 (packet nói "token refresh/revoke" — hiệu chỉnh để Tester không viết test sai):** hệ thống **không có** grant `refresh_token`; grep `refresh_token|refreshToken` trong `services/orchestrator/src` cho **0 kết quả**. Luồng là session opaque với rotate + idle/absolute TTL, revoke qua logout hoặc `revokePrincipal`. Checklist B5 vì thế nói về **vòng đời session**, không đòi response có `refresh_token`.
- **Δ23 (đã tự kiểm để tránh neo sai trong checklist):** `data-csrf` nằm trên input token của form **login local** (`shell-render.ts:247`), **không** phải form mutation. Nếu đưa `data-csrf` làm neo cho kiểm tra CSRF thì sẽ bị bắt sai chỗ; checklist dùng thay bằng wording 403 của dispatcher. Đồng thời xác nhận logout là **form POST** (`form[action="/admin/logout"] button[type=submit]`, `shell-render.ts:340`) ⇒ `GET /admin/logout` phải 405, đã ghi rõ trong B4 để Tester không điều hướng bằng GET.
### 7.4 `G-SEC` giữ nguyên NO-GO — lý do nêu tên, không mời

Umbrella gate **không** tick, theo mục 4 của packet và theo chính Turn 60/Turn 70. Còn lại, theo thứ tự phụ thuộc:

1. **SEC-00 sign-off** — cổng trước cả nhánh OIDC lẫn Vault; ADR-17 mới chỉ được ACCEPT ở phạm vi tài liệu.
2. **OIDC-04 browser evidence** — chưa có. Chuỗi offline của lane (loopback IdP + RSA thật) **không** thay được browser driver theo yêu cầu task row. Kịch bản B0–B5 đã sẵn sàng.
3. **Vault live chain** — migration 008 + policy writer/reader đã deploy + rotation/revoke/reconcile + negative tenant/account xuyên Admin → Orchestrator → Connector.
4. **SEC-INT-01/02** — full-flow, fault/security matrix, sentinel sink, deploy/runbook.

Ngoài ra OIDC-02 còn 7 live legs hai process của Tester-1 mà chưa có receipt, và OIDC-03 vẫn thiếu **claim path** sống (Δ21).

### Status trung thực 4 mức
- Ledger sync + packet journal + giới hạn + checklist B0–B5: SPECIFIED → IMPLEMENTED → **VERIFIED bằng đối chiếu nguồn** (đọc `review.md` Turn 60/70, `tester.md` T-CODEX-TEST-20, `server.ts`, `rbac.ts`, `shell-render.ts`, `shell-router.ts`, `oidc-flow.ts`; link target đã kiểm tồn tại; không sửa product code). **Không có exit code nào** vì cycle này không chạy test.
- `W-SEC-RBAC-SYNC-1` / OIDC-03 matrix: **ACCEPTED** (do Reviewer Turn 60 phán, Turn 70 xác nhận, Tester T-CODEX-TEST-20 đo) — **không phải** do lane tự kết luận.
- **ACCEPTED cho lane: KHÔNG.** OIDC-03 vẫn `[~]`, `G-SEC` vẫn NO-GO, Δ13 vẫn chờ quyết, OIDC-04 vẫn chờ browser. Lane không tick row nào, không sửa `docs/`.

— Qwen-SEC, 2026-09-26 (cycle 7). Khuyến nghị /compress.

## 8 — CYCLE 8: W-OIDC04-SESSION-FLOW — cookie posture, CSRF phủ toàn bộ mutation, forged identity header

**File sửa (1):** `tests/admin-shell-session-lifecycle.test.ts` — 176 → 395 dòng, **+14 test** (10 test cũ giữ nguyên, không sửa assertion nào của họ). Harness `world()` nhận thêm `publicOrigin` (mặc định = giá trị cũ nên 10 test cũ chạy y nguyên). **0 production diff.** Không commit/push. Không DB window. Offline, không socket.

Packet cho phép sửa `shell-router.ts` hoặc auth/session handler tương ứng. **Đo trước đã:** cả 4 yêu cầu 2a-2d đều ĐÃ được implement đúng trong source, nên không có gì để sửa mà không làm loãng diff. Thứ tìm ra là **2 vấn đề cấu hình/triển khai**, không phải lỗi code -> ghi Δ26/Δ27, KHÔNG tự sửa.

### Kết quả từng yêu cầu, kèm attribution trung thực

**2a. Callback Authorization Code + PKCE.** ĐÃ có trước khi lane chạm vào và lane **không thêm gì** cho phần này: `admin-oidc-flow.test.ts` chứng minh exchange dùng verifier thật với S256 (`b64u(sha256(verifier)) === code_challenge`), `code_verifier` không xuất hiện trên URL, state/nonce one-shot, và toàn bộ callback hostile (state lạ / dùng lại / hết hạn / thiếu / IdP error) trả **một** shape 403. `admin-shell-oidc-mount` + suite lifecycle cũ chứng minh router gọi đúng handler. Lane chỉ đo lại và báo xanh.

**2b. Cookie posture (Secure khi HTTPS, HttpOnly, SameSite=Lax).** Đây là **hở thật, nay mới kín**. `oidc-flow.ts:108` quyết `secure = origin.protocol === https:`, nhưng **mọi publicOrigin trong toàn bộ cây test đều là http://localhost:2023** (grep publicOrigin ra 10 match, không một dòng https) nên nhánh https **chưa từng được chạy ở bất kỳ đâu**. Đã thêm 4 test: https mint `du_session` có đủ `Secure` + `HttpOnly` + `SameSite=Lax` + `Path=/` + `Max-Age`; https logout clear-cookie mang **đúng cùng posture** và record bị destroy thật; http thì **không** `Secure` nhưng vẫn đủ 3 cái còn lại — cặp test https/http tự chứng minh cờ là **DERIVED** vì một hằng số cứng phía nào cũng làm một trong hai đỏ; và value trên wire là opaque id 43 ký tự, không chứa csrfToken/subject/platformAdmin.

**2c. CSRF guard trên MỌI action mutation (`POST /api/v1/admin/actions`).** Route (`server.ts:1659`) gọi `resolveAdminActionAuthAsync` rồi `dispatchAdminAction`; CSRF quyết trong `assertRoleActionTenant`. Chưa từng có test nào phủ **toàn bộ bảng**. Đã thêm 5 test, và **danh sách action lấy trực tiếp từ `ADMIN_ACTIONS`** (thêm action mới là tự động bị phủ, không phải sửa test):
- bảng thật sự expose mutation cho cookie (≥8, gồm `operations.cancel` và `apikey.bind-profile`) — không có test này thì cả nhóm xanh kiểu vacuous;
- thiếu hoặc sai token → 403 `cookie-authenticated admin actions require a valid CSRF token` cho **mọi** action × **mọi** role cookie (admin, operator, viewer);
- **CSRF chạy TRƯỚC role table**: viewer (không được phép gì) vẫn bị từ chối bằng message CSRF, tức một POST không token không dò được permissions;
- token khớp → admit đúng cái bảng cho phép; operator vẫn 403 role trên `apikey.bind-profile`;
- **bearer KHÔNG bị leg CSRF** — pin này chặn một refactor siết cho đều làm gãy server-to-server.

**2d. Negative cases.** Expired / revoked / forged sid / anonymous đã có sẵn trong 10 test cũ. Lane thêm 5 test **forged identity header** — trước đây **0 test** trong cây orchestrator động tới `x-tenant-id` hay `x-admin-role` (grep = không match):
- header giả đơn độc kèm bearer rác → resolver trả `null`, gate trả **401 UNAUTHENTICATED**;
- operator session + `x-tenant-id: tenant-b` → auth vẫn mang **tenant của STORE** (tenant-a); cancel đúng tenant thì `{ok: true}`, cancel tenant khác vẫn 403 `mutations are scoped to the caller tenant`;
- viewer session + `x-admin-role: platform` → vẫn viewer, mutation 403 message role;
- session đã destroy thì forged header **không hồi sinh** được;
- pin cấu trúc: `AdminShellRequest` **không có kênh header nào** (`body, cookies, method, pathname`) — nếu ai thêm field headers vào tier shell, forged identity sẽ chạm tới browser surface và test này đỏ.

### Bảng chứng chạy (literal, đọc từ dòng *_EXIT= trong log — xem Δ14)

- **Baseline trước khi sửa**, lệnh của packet trên 3 suite: `Test Suites: 3 passed, 3 total` / `Tests: 28 passed, 28 total`, `BASELINE_EXIT=0`.
- **Lệnh của packet sau khi sửa**, chạy 2 lần (một lần trước và một lần sau khi nhiễm lane khác khỏi): `Tests: 42 passed, 42 total` = 28 cũ + 14 mới; `PACKET_CMD_EXIT=0`, `PACKET_CLEAN_EXIT=0`.
- Chuỗi rộng 10 suite (3 suite packet + `admin-shell-oidc-mount`, `admin-shell-oidc-flow-integration`, `session-store`, `admin-action-dispatcher`, `oidc03-role-action-tenant-offline`, `oidc-claim-shape-contract-offline`, `admin-shell-auth`):
  - 3 lần **trên cây đang nhiễm lỗi file khác**: `177 passed, 177 total` x3, `CHAIN1_EXIT=0 CHAIN2_EXIT=0 CHAIN3_EXIT=0`.
  - **Đếm lại từ đầu** sau khi nhiễm sạch: `177 passed, 177 total` x3, `CLEAN_R1_EXIT=0 CLEAN_R2_EXIT=0 CLEAN_R3_EXIT=0`. Hai bộ 3 trùng số liệu, chứng kiến nhiễm không ảnh hưởng kết quả (đã kiểm: grep cho thấy **không suite nào trong 10 suite import `src/server.ts`**).
- `npx tsc --noEmit` (mục 3 packet): lần đầu **`TSC_EXIT=2`** với 4 lỗi **toàn bộ trong `src/server.ts`** (TS2300 duplicate `isOperationsListFilterToken` dòng 72 và 86; TS2352 cast `ApiKeyDbRow[]`; TS2304 `AdminPrincipal`) — **không lỗi nào thuộc file lane chạm**. Đây là nhiễm lane khác: `server.ts` lớn từ **2530 lên 2920 dòng ngay trong phiên này** (lane Admin đang refactor sang `W-ADMUX02-EXT-1`), lane không sửa file người khác. Sau khi họ xong: `TSC2_EXIT=0` và chạy lại lần cuối `TSC_FINAL_EXIT=0`.

### Negative control

Không tin xanh là đủ. Đã **tạm sửa production** `oidc-flow.ts:108` thành `const secure = false` (hằng số) rồi chạy suite: `Test Suites: 1 failed` / `Tests: 2 failed, 22 passed, 24 total`, `NEGCONTROL_EXIT=1`, và log chỉ đúng chỗ: `Expected substring: Secure` / `Received: du_session=n2Z0...; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` — cả callback lẫn logout clear đều đỏ, **22 test còn vẫn xanh** nên đỏ này đặc hiệu, không phải sập hệ thống. Rồi **revert về đúng dòng gốc** (`const secure = origin.protocol === ...`) và chạy lại toàn bộ chuỗi sạch. Kết luận: nhóm 2b thật sự ràng buộc vào production, không tự sinh tự tiêu.

### Δ-DEVIATION / ghi chú cho Reviewer và coordinator

- **Δ24 (packet mở đường sửa production, lane trả về 0 production diff):** 4 yêu cầu đều đã đúng trong source. Thứ lane làm là **đo** và thêm bằng chứng; hai chỗ thật sự hở (2b, 2c-toàn-bảng, 2d-forged header) đều là **thiếu test**, không phải thiếu code.
- **Δ25 (nhiễm lane khác, đã xử lý đúng nghi thức):** `src/server.ts` đỏ `tsc` giữa chừng phiên do lane Admin refactor (2530 → 2920 dòng). Lane không sửa file người khác; đã **đếm lại chuỗi 3 lần từ đầu** trên cây sạch và chạy lại `tsc` tới khi exit 0.
- **Δ26 (cấu hình triển khai, KHÔNG phải lỗi code — đề nghị đưa vào SEC-00 sign-off):** cờ `Secure` đến từ **protocol của `DU_ADMIN_OIDC_PUBLIC_ORIGIN`**, hoặc fallback `new URL(redirectUri).origin` (`oidc-boot.ts:179-184`); không có chỗ nào đối chiếu với protocol thật của request. Sau TLS-terminating proxy, nếu operator đặt env khai `http://...` (hoặc để trống trong khi redirect_uri là http) thì cookie **vẫn không Secure** dù người dùng đang browsing https — đúng cái kịch bản mà ADR-17 ghi là phải chốt reverse-proxy trust. 4 test mới chỉ chứng minh **hàm dẫn xuất đúng**, không chứng minh **cấu hình đúng**. Cần một check deployment/runbook (SEC-INT-02), lane không tự thêm.
- **Δ27 (legacy plane, cần quyết định của lane Admin):** cookie `du_admin` tự mint ở `shell-router.ts:916` (và clear ở `936`) mang `HttpOnly` + `SameSite=Strict` nhưng **không có `Secure`**. Không tự sửa vì: (a) khi OIDC flow được mount thì `POST /admin/login` bị intercept (shell-router.ts:1104) nên **không còn đường mint du_admin** trong deployment OIDC-04 — tức không phải hở của plane này; (b) sửa đúng cần thêm field cấu hình vào `ShellRuntimeConfig` (Admin lane sở hữu) và đặt `secure: true` cứng sẽ **gãy deployment http nội bộ**. Ghi để coordinator xếp packet riêng nếu muốn bịt cho non-OIDC deployments.
- **Δ28 (chông gai lặp lại của lane, lần thứ hai):** `AdminActionAuth` là discriminated union nên `auth.role` trên phần tử bị annotate `AdminActionAuth[]` rơi `TS2339` y như cycle 4 (`Property code does not exist`). Nghi thức: annotate mảng `{label, auth}` hoặc narrow bằng `kind === ...` trước khi đọc field.
- **Δ29 (giới hạn phạm vi, nói thẳng):** 14 test mới chạy ở tầng **handler/router thuần túy**, không phải browser driver. Task row OIDC-04 đòi browser thật qua fake IdP và **không nhận DOM-only/loopback làm bằng chứng mutation**. Chuỗi này **không** đóng OIDC-04; nó chuẩn bị đúng các bất biến mà kịch bản B0-B5 (cycle 7) sẽ phải quan sát được từ trình duyệt.

### Status trung thực 4 mức
- Cookie posture trên nhánh https, CSRF phủ toàn bảng action, forged-header fail-closed: SPECIFIED → IMPLEMENTED → **VERIFIED (offline)** — packet command 42/42, chuỗi 10 suite 177/177 đếm lại 3x exit 0, `npx tsc --noEmit` exit 0, **negative control 2/24 đỏ có chủ đích rồi revert**.
- 2a (PKCE callback) và các negative cũ: **đã VERIFIED từ trước**, lane chỉ đo lại; không nhận công.
- **ACCEPTED: KHÔNG.** OIDC-04 vẫn `[ ]` pending browser driver; `G-SEC` vẫn NO-GO; Δ13 vẫn chờ quyết; Δ26/Δ27 là việc của SEC-00/SEC-INT-02 và lane Admin. Lane không tick task row, không sửa docs.

— Qwen-SEC, 2026-09-26 (cycle 8). Khuyến nghị /compress.


## 9 — CYCLE 9: W-SEC-OIDC04-PROXY-1 — Secure cookie sau reverse-proxy TLS + fail-closed khi protocol không chứng minh được

**File sửa (production):** `oidc-flow.ts` (chính sách cookie per-request: check ngặt một-token XFP, denial trước exchange, logout không bao giờ deny), `oidc-boot.ts` (parse `DU_ADMIN_TRUST_PROXY_PROTOCOL` + `DU_ADMIN_COOKIE_SECURE`, boot-refusal, export `parseCookieSecurePolicy`, wire vào flow), và 3 dòng vận chuyển XFP ở mount path: `shell-types.ts` (field optional), `shell-server.ts` (capture header), `shell-router.ts` (toFlowRequest transport-only) — xem **Δ30** vì packet chỉ ghi "contracts or oidc-boot". **Test:** suite mới `tests/oidc-cookie-secure-proxy-offline.test.ts` (13 test, drive qua MOUNTED router) + `tests/oidc-boot.test.ts` (+6 test env-leg). Tổng **+19 test**. Không commit/push, không DB/Redis window — RSA chữ ký thật qua fetch loopback, store in-process.

**Bối cảnh:** Δ26/Δ27 của cycle 8. Đe dọa: deployment đứng sau TLS-terminating proxy mà public origin khai http (hoặc fallback từ redirect_uri http) → du_session mint KHÔNG Secure dù người dùng browsing https; trước chu kỳ này không có knob nào để bịt, và cũng không có đường nào để operator khai "proxy của tôi đáng tin".

**Chính sách cài đặt (đúng mục 2 packet):**
- requireSecure = `DU_ADMIN_COOKIE_SECURE=enforce` HOẶC `NODE_ENV=production`. `auto` giữ mặc định derive — production **không có cách opt-out** qua env surface này.
- `x-forwarded-proto` **chỉ được đọc khi** `DU_ADMIN_TRUST_PROXY_PROTOCOL=true`: proof = một token duy nhất, trim + casefold, đúng bằng https; chuỗi nhiều hop có dấu phẩy, http, rỗng, vắng mặt = KHÔNG proof. Giá trị rác của cả hai knob = boot error (sánh luật PKCE S256), không bao giờ default thầm.
- Boot refusal: requireSecure + origin http + trust off → từ chối boot, vì tổ hợp đó mint ra chỉ có thể là cookie không Secure — chạy tiếp là tự lừa.
- Callback denial: requireSecure + TLS chưa chứng minh → đúng 403 hostile-callback shape, **trước** consume challenge và **trước** token exchange: không session, không Set-Cookie, không oracle; proxy phục hồi XFP thì cùng một login chạy tiếp được (challenge/code còn nguyên).
- Nâng một chiều: XFP tin được chỉ có thể THÊM Secure trên origin http; chiều ngược không bao giờ — origin https giữ Secure kể cả khi header xúi http.
- Logout không bao giờ deny (không được nhốt user ở lại); cookie clear mang đúng posture hiện hành.
- knob unset + ngoài production → hành vi **byte-for-byte** như cũ (mọi suite cũ xanh không sửa một test nào).

**Bảng chứng literal (read từ dòng *_EXIT= trong log thô, không tin wrapper — Δ14):**
| Bước | Log | Literal |
|---|---|---|
| Baseline packet command (trước sửa) | proxy-baseline-packet.log | PACKET_BASE_EXIT=0, 37/37 |
| Baseline rộng 10 suite | proxy-baseline-wide.log | WIDE_BASE_EXIT=0, 120 passed + 7 skipped |
| lint src sau production edits | proxy-lint1.log | LINT1_EXIT=0 |
| Run đầu 3 suite liên-hệ | proxy-first-run.log | FIRST_RUN_EXIT=0, 42/42 |
| Packet command ×3 (pre-NC) | proxy-packet-r1/2/3.log | PACKET_R1/2/3_EXIT=0 |
| Chuỗi rộng 11 suite ×3 (pre-NC) | proxy-wide-r1/2/3.log | WIDE_R1/2/3_EXIT=0, 139 passed + 7 skipped mỗi lần |
| npx tsc --noEmit | proxy-tsc1.log | TSC1_EXIT=0 |
| Negative control A | proxy-negA.log | NEGA_EXIT=1 — 6 failed, 29 passed |
| Negative control B | proxy-negB.log | NEGB_EXIT=1 — 5 failed, 30 passed |
| Đếm lại SAU revert — packet ×3 | proxy-packet-f1/2/3.log | PACKET_F1/2/3_EXIT=0 |
| Đếm lại SAU revert — rộng ×3 | proxy-final-r1/2/3.log | FINAL_R1/2/3_EXIT=0, 139+7 mỗi lần |
| lint + tsc cuối | proxy-lint-final.log / proxy-tsc-final.log | LINT_FINAL_EXIT=0 / TSC_FINAL_EXIT=0 |

Không có nhiễm lane khác trong chu kỳ này (khác cycle 8): `server.ts` đã ổn định, mọi run xanh/đỏ đúng dự kiến ngay từ đầu. 7 skipped = các leg `DU_LIVE_INFRA` cũ của suite replica (skip ≠ pass).

### Win/lose từng nhóm test (+19)
- **Thuần (2):** `forwardedProtoProvesHttps` — WIN khi đúng một token https (case/trim tolerant) trả true; MỌI thứ khác (http, chuỗi phẩy, rỗng, `javascript:https`, vắng mặt) trả false.
- **Enforcement qua router đã mount (5):** origin http + trust + requireSecure + XFP https → 302 mint du_session mang ĐỦ Secure+HttpOnly+SameSite=Lax+Path=/, sid 43 ký tự resolve được trong store; normalization ` HTTPS ` cũng satisfay; dev sau proxy (không requireSecure) vẫn NÂNG Secure khi XFP tin được; trust OFF + header forged https → cookie KHÔNG Secure như cũ byte-for-byte (header không đọc); origin https + XFP xúi http → giữ Secure (không hạ cấp).
- **Fail-closed (5):** requireSecure + XFP http / vắng mặt / chuỗi `https, http` / trust-off + forged → 403 đúng shape hostile-callback, headers KHÔNG có set-cookie, store không thêm session, và challenge.size() vẫn còn nguyên (denial chạy TRƯỚC consume — chứng minh bằng assertion đếm challenge); test thứ năm so sánh byte body/status/content-type của posture-denial với unknown-state-denial (leg so sánh phải đi qua posture bằng XFP https, nếu không là tự so hai denial giống nhau).
- **Logout (1):** sau mint https, logout với XFP http vẫn 302 + clear Max-Age=0 + store destroy (không nhốt user); logout với XFP https thì clear mang Secure.
- **Boot (6):** production + origin http + không knob → throw `WITHOUT the Secure flag`; production + trust → boot; production + https origin → boot; enforce dựng rào ngoài production, auto KHÔNG tắt được trong production; giá trị rác của hai knob → boot error naming var; leg cuối dựng components THẬT rồi gọi flow trực tiếp: unproven → 403 không cookie, proven cùng state/code (còn nguyên vì denial trước consume) → 302 cookie Secure + record resolve. Leg này chứng minh env reaches the mounted flow, không chỉ parser đúng.

### Negative control (không tin xanh suông)
- **NC-A** — chèn `if (false && posture.denied)` trong callback: `NEGA_EXIT=1`, đúng 6 failed / 29 passed trên 2 suite liên quan (4 denial + indistinguishable + boot REACHES); 29 ca còn lại vẫn xanh nên đỏ ĐẶC HIỆU.
- **NC-B** — bỏ chân-trị XFP khỏi `proven` (chỉ còn configSecure): `NEGB_EXIT=1`, 5 failed / 30 passed (cả nhóm upgrade + boot REACHES).
- Cả hai revert; grep `TEMP NEGATIVE` trong src = 0 hit; findstr xác nhận nguyên dòng 162/202. TOÀN BỘ chuỗi chứng cứ (packet x3, rộng x3, lint, tsc) được ĐẾM LẠI sau revert: PACKET_F1/2/3_EXIT=0, FINAL_R1/2/3_EXIT=0, LINT_FINAL_EXIT=0, TSC_FINAL_EXIT=0.

### Δ-DEVIATION / ghi chú cho Reviewer và coordinator
- **Δ30 (sửa production ngoài phạm vi chữ của packet — cần adjudicate):** mục 2 packet ghi "in contracts or oidc-boot", nhưng header request KHÔNG về tới oidc-boot: `AdminShellRequest` không có kênh header (chính cái lane pin ở cycle 8). Để fulfil test 1 của mục 3, lane thêm đúng 3 chỗ vận chuyển, tất cả optional-key, unset = byte-identical: `shell-types.ts` (field `forwardedProto?`), `shell-server.ts` (capture header, array thì join dấu phẩy để fail-closed), `shell-router.ts` toFlowRequest (transport-only, không decision). Đây là file lane Admin từng được packet cycle 8 mở quyền (shell-router) hoặc lane này từng sửa có ủy quyền (shell-server, cycle 3); shell-types là lần đầu lane chạm → flag. Revert path: xóa 3 mẩu + bỏ các test drive-qua-router (chuyển sang gọi flow trực tiếp) — chính sách vẫn chứng minh được ở tầng oidc-flow.
- **Δ31 (vì sao policy KHÔNG nằm ở packages/contracts):** theo packet "contracts OR oidc-boot" — lane chọn oidc-boot: `packages/contracts` là home của wire-shapes xuyên service; TLS-posture là quan tâm runtime của orchestrator, phụ thuộc process env, và consumer duy nhất là boot/flow ở chính file đó (cycle 5 đặt ở contracts vì nó ràng hai mapper ở hai bề mặt — case khác). Nếu Reviewer muốn đăng ký hợp đồng ở contracts + docs ADR, đường move đã vẽ sẵn (chuyển `parseCookieSecurePolicy` + `forwardedProtoProvesHttps`, rebuild dist), không đổi test nào.
- **Δ32 (breaking-change cho deployment cấu hình sai — cần runbook):** production + public origin http + trust off trước đây BOOT bình thường và mint cookie không Secure; từ chu kỳ này refuse boot. Đó đúng là nghĩa "strictly enforced" của packet, nhưng `docs/runbooks/vault-oidc-operations.md` chưa có hai biến mới → docs cần owner được ủy quyền (lane không sửa docs, lệ cũ). Đề nghị SEC-INT-02 thêm bước kiểm tra env trước deploy.
- **Δ33 (Δ27 đóng MỘT NỬA, nói thẳng):** primitive chung `parseCookieSecurePolicy(env)` đã export để plane legacy dùng lại, và xem-lại-kỹ xác nhận `buildSetCookieHeader` vốn đã nhận `secure?` — tức phần thiếu chỉ là WIRING: thêm field vào `ShellRuntimeConfig` + truyền từ main.ts, cả hai thuộc lane Admin/Platform, packet này không mở. nên du_admin VẪN mint không Secure. Exposure vẫn giới hạn ở deployment non-OIDC (khi flow mounted thì POST /admin/login bị intercept, không còn đường mint).
- **Δ34 (giới hạn model proxy tin cậy, cài có chủ đích):** check ngặt MỘT token — deployment có chuỗi proxy mà hop trung gian append thay vì overwrite sẽ luôn unproven → deny kể cả khi client thật đi https. Fail-closed là chủ đích (không đoán header), operator phải cấu hình proxy ngoài cùng tự ghi `X-Forwarded-Proto: $scheme` đè giá trị vào — mặc định ALB/nginx). belong về runbook của Δ32.
- **Δ35 (phạm vi bằng chứng, lặp lại Δ29):** mọi thứ trên là handler-level: không cookie-jar thật, không TLS thật. Browser OIDC-04 (B0–B5) vẫn là việc của Tester; khi chạy B2 nên bật sẵn trust knob để quan sát cả hai posture. OIDC-04 vẫn [ ], G-SEC vẫn NO-GO.

### Status trung thực 4 mức
- Boot policy parse + refusal; per-request XFP enforcement + pre-exchange denial; upgrade một chiều; logout không deny: SPECIFIED → IMPLEMENTED → **VERIFIED (offline)** — packet command ×3 exit 0, chuỗi rộng 11 suite 139+7skip ×3 exit 0 sau revert, lint + `npx tsc --noEmit` exit 0, HAI negative control đỏ đặc hiệu rồi revert.
- Δ27 legacy du_admin: **chưa đóng** — primitive có, wiring thuộc Admin (Δ33).
- **ACCEPTED: KHÔNG.** Không tick task row, không umbrella gate. `G-SEC` giữ NO-GO (browser OIDC-04 + Vault live). Δ13 và giờ thêm Δ30–Δ35 chờ coordinator/Reviewer adjudicate. Không commit/push, không DB/Redis/S3/Vault window; HEAD vẫn 7811298.

— Qwen-SEC, 2026-09-26 (cycle 9). Khuyến nghị /compress.

---

## 10 — CYCLE 10: W-SEC-COOKIE-CONFIG-1 — nối policy Secure vào legacy du_admin (đóng nắA còn lại của Δ27/Δ33)

**File sửa (4):** src/app/admin/shell-router.ts (ShellRuntimeConfig thêm field optional cookiePolicy; helper legacyCookiePosture; mint du_admin mang cờ Secure + denial 503 SAU credential check; handleLogout đổi signature thành (request, config) — clear mang posture, không bao giờ deny), src/app/admin/shell-server.ts (parseCookieSecurePolicy(process.env) đọc MỘT lần tại mount qua default của CreateAdminShellServerOptions.cookiePolicy — tests inject trực tiếp thay vì mutate env), src/app/admin/oidc-boot.ts (CHỈ docblock: dòng "once the Admin lane wires" → đã wired; 0 code change), tests/admin-shell-session-lifecycle.test.ts (395→560 dòng; +12 test: 9 unit qua router thuần + 3 qua REAL shell listener loopback socket). 0 file lane khác. Không commit/push. Không DB/Redis/S3/Vault — offline thuần (socket loopback tự bind, không phải infra ngoài).

**Bối cảnh:** NỬA còn lại của Δ33 do cycle 9 để mở: primitive parseCookieSecurePolicy đã export nhưng chỉ OIDC plane dùng. Packet W-SEC-COOKIE-CONFIG-1 mở quyền đúng 2 file shell-router.ts + shell-server.ts nên lane này tự nối — không cần Admin lane nữa. Legacy plane KHÔNG có publicOrigin để dẫn cờ: shell listener là plain node:http ⇒ bằng chứng TLS duy nhất có thể quan sát là x-forwarded-proto, và chỉ khi operator bật DU_ADMIN_TRUST_PROXY_PROTOCOL.

**Chính sách (cùng gia đình luật Δ26, áp lên bề mặt du_admin):**
1. Không wired policy (cookiePolicy undefined — deployment cũ, test cũ): mint y hệt từng byte — HttpOnly, SameSite=Strict, Path=/, Max-Age>0, KHÔNG Secure, không bao giờ deny.
2. trustProxyProtocol=true + header CHỨNG MINH được (một token https sau trim+casefold; chuỗi phẩy/http/rỗng/absent = không chứng minh): mint mang Secure. Chỉ NÂNG một chiều — không có đường hạ.
3. trust OFF: header hoàn toàn không được đọc — forged https cũng không nâng.
4. requireSecure (DU_ADMIN_COOKIE_SECURE=enforce hoặc NODE_ENV=production): mint khi TLS chưa chứng minh → 503 "Secure connection required" + KHÔNG có Set-Cookie; chạy SAU credential check nên 401 "Invalid token." giữ nguyên shape (pin thứ tự trong test).
5. requireSecure + proven: login thường vẫn chạy với cookie Secure — không restart, không đổi config giữa chừng.
6. Logout: clear du_admin MANG posture khi proven nhưng KHÔNG bao giờ deny — dọn cookie vẫn phải chạy khi mint path đang cấu hình sai (luật Δ26 thừa kế).
7. Env knob rác → parseCookieSecurePolicy throw ngay tại mount → shell-server từ chối tạo (fail-closed cả HAI bề mặt bằng MỘT luật parse, mirroring DU_ADMIN_OIDC_PKCE_METHOD).

**Bảng chứng literal (dòng *_EXIT= đọc từ log thô — Δ14; cwd du-rework):**
| Bước | Lệnh | Log | Kết quả |
|---|---|---|---|
| Baseline TRƯỚC sửa | packet command | cfg-baseline.log | BASELINE_EXIT=0 (24/24) |
| Lint src sau production edit | pnpm --filter @du/orchestrator lint | cfg-lint1.log | LINT1_EXIT=0, 0 "error TS" |
| Run đầu sau +12 test | packet command | cfg-first-run.log | FIRST_RUN_EXIT=0 (36/36) |
| Packet ×3 (trước NC) | packet command | cfg-packet-r1..3.log + cfg-PKG.log | PACKET_R1/R2/R3_EXIT=0, 36/36 ×3 |
| Rộng 11-suite ×3 (trước NC) | cùng danh sách cycle 9 | cfg-wide-r1..3.log | WIDE_R1/R2/R3_EXIT=0 (151 passed + 7 skipped) |
| tsc theo packet | pnpm --filter @du/orchestrator exec tsc --noEmit | cfg-tsc1.log | TSC1_EXIT=0 |
| NC-A (mint hardcode secure:false) | packet command | cfg-negA.log | NEGA_EXIT=1 — 4 failed/32 passed, đúng nhóm mong Secure (kể cả leg socket) |
| NC-B v1 (if (false && …)) | packet command | cfg-negB.log | NEGB_EXIT=1 vì TS18048 — compile fail, KHÔNG phải control; ghi trung thực |
| NC-B v2 (denied ép false) | packet command | cfg-negB2.log | NEGB2_EXIT=1 — 1 failed/35 passed, đúng test requireSecure-deny |
| Revert + residue | grep "TEMP NEGATIVE" shell-router.ts | (trong phiên) | 0 match |
| Packet ×3 SAU revert | packet command | cfg-packet-f1..3.log | PACKET_F1/F2/F3_EXIT=0 |
| Rộng ×3 + lint + tsc SAU revert | như trên | cfg-final-r1..3.log, cfg-lint-final.log, cfg-tsc-final.log | FINAL_R1/R2/R3_EXIT=0 (151+7), LINT_FINAL_EXIT=0, TSC_FINAL_EXIT=0 |

Ghi chú bằng chứng: 3 dòng exit của packet-×3-trước-NC nằm trong cfg-PKG.log (nhầm template: replace() chỉ thay lần đầu nên echo ">>" trỏ file gốc — các run log cfg-packet-r1..3.log vẫn đúng, exit literal vẫn đọc từ file thô, không có gì bị sửa hoặc suy diễn).

**Win-lose 12 test mới:** (1) no-policy mặc định legacy — nếu BẤT KỲ attribute mới xuất hiện thì đỏ; (2) trust+https → Secure (chữ packet step 2); (3) " HTTPS " normalize; (4) bảng auto ["http","https, http","",absent] → 302 cookie thường — fail-closed ≠ phá deployment; (5) trust OFF + https xịn → không đọc, không nâng; (6) bảng requireSecure 4 hình-unproven (kể cả trust-off-forged) → 503 + set-cookie undefined + msg; (7) requireSecure + proven → 302 Secure (đường phục hồi không restart); (8) pin thứ tự: sai token + unproven → 401 "Invalid token." — denial không thành oracle thăm dò; (9) logout hai leg: proven → clear+Secure, unproven → vẫn 302 clear; (10-12) qua REAL listener: cookiePolicy override tới mint qua socket (header https thật → Secure), chuỗi phẩy trên wire không chứng minh gì, mount default env-sạch → legacy. Env được snapshot/restore quanh group socket vì mount đọc process.env tại creation.

**Δ-DEVIATION (Δ36–Δ40, đề nghị coordinator/Reviewer adjudicate):**
- **Δ36 — vị trí parse env:** packet ghi "use parseCookieSecurePolicy" trong cả hai file; lane đặt LỜI GỌI parse một chỗ duy nhất là shell-server (mount-time, một lần), router chỉ tiêu thụ config + helper forwardedProtoProvesHttps từ oidc-flow — router là hàm thuần trên config; đọc env mỗi lượt request khiến knob quay giữa đời áp dụng không xác định theo handler. Import giá trị oidc-boot vào shell-server kéo ioredis vào graph mount (không cycle — đã verify; nếu Reviewer muốn module trung lập hơn, đường chuyển là move parser sang shell-types + re-export ở boot, 3 file).
- **Δ37 — shape denial legacy:** 503 + message "Secure connection required" chẩn đoán được cho operator, KHÔNG giống denial 403 bất khả phân của OIDC plane — vì denial chạy SAU credential check (chỉ caller có token hợp lệ mới thấy), surface login vốn public và message không leak identity; đã pin bằng test 8. Reviewer quyết có muốn gộp về một shape không.
- **Δ38 — handleLogout signature:** internal function, call-site sync duy nhất; nhưng đường OIDC-joined logout (flow mounted) cũng route local clear qua đây ⇒ du_admin clear trong OIDC logout giờ mang Secure khi proven. Không đổi behavior khi knob unset.
- **Δ39 — không đụng main.ts:** NỬA còn lại của Δ33 đóng MÀ không cần field platform mới — env vẫn là interface duy nhất (DU_ADMIN_TRUST_PROXY_PROTOCOL / DU_ADMIN_COOKIE_SECURE / NODE_ENV); attachAdminShell giữ nguyên.
- **Δ40 — legacy plane không có boot-refusal:** OIDC plane từ chối boot khi production+origin-http+trust-off; legacy plane không có origin để soi lúc boot ⇒ requireSecure+trust-off nghĩa là MỌI login bị 503 — đó chính là strictly enforced của packet; message 503 chỉ đường cấu hình. Runbook (docs/runbooks/vault-oidc-operations.md) vẫn chưa có 2 env + 503 này — Δ32/Δ34 nối dài, cần docs owner.

**Status trung thực 4 mức:**
- Wiring legacy plane: SPECIFIED → IMPLEMENTED → **VERIFIED (offline)** — packet command ×3, rộng 151+7skip ×3, lint 0, packet tsc 0, HAI negative control đỏ đặc hiệu (4/36, 1/36) rồi đếm lại TOÀN bộ sau revert.
- **Δ27/Δ33: ĐÓNG (chờ adjudicate Δ36–Δ40).** du_admin giờ mint/clear WITH Secure khi TLS chứng minh được, và KHÔNG BAO GIỜ mint được khi enforce mà TLS chưa chứng minh.
- **ACCEPTED: KHÔNG.** G-SEC vẫn NO-GO (bằng chứng browser Δ11/Δ35 + live windows chưa chạy); OIDC-04 vẫn "[~]", không tick; Δ13, Δ30–Δ40 chờ Reviewer.
- Không commit/push; không DB/Redis/S3/Vault window. HEAD 7811298.

— Qwen-SEC, 2026-09-26 (cycle 10). Khuyến nghị /compress.

---

## 11 — CYCLE 11: W-SEC-AUDIT-TAXONOMY-1 — audit taxonomy chuẩn cho sự kiện an ninh Admin shell + phân quyền

**File sửa (6):** src/modules/admin-actions/rbac.ts (từ vựng ở auth-root: AdminSecurityEventKind 5 kind, AdminSecurityEventReason, AdminSecurityEvent CLOSED-form, AdminSecurityAuditSink; AdminSessionStore thêm phương thức TUỲ CHỌN classify(sessionId) — đọc-không-đổi, không eviction/touch), src/modules/auth/session-store.ts (implement classify: invalid_shape / absent_or_revoked / expired_absolute / expired_idle / live; thêm vào return), src/modules/admin-actions/dispatcher.ts (assertRoleActionTenant thêm tham số audit? thứ 4; đúng nhịp CSRF emit đúng MỘT auth.csrf_denied; authorizeAdminAction delegate xuyên tham số — 0 đổi decision/message/status), src/app/admin/shell-router.ts (field optional securityAudit trên ShellRuntimeConfig; emit login_failed trước render 401 + tls_required trước render 503 trong handleLoginPost; liveSessionClaims tái cấu trúc thành resolveOpaqueSession (classify TRƯỚC get) + sessionAuditEventFor; gate phát session_expired/session_revoked khi dead — wire giữ nguyên từng byte), src/app/admin/shell-server.ts (option securityAudit + default sink cấu trúc tại mount: console.warn một dòng [admin-shell] security event + JSON — production ghi nhận NGAY không cần sửa server.ts), tests: admin-shell-session-lifecycle.test.ts (562→798 dòng, +15 test: 36→51) và oidc03-role-action-tenant-offline.test.ts (428→512 dòng, +4 test: 13→17). 0 file lane khác. Không commit/push. Offline thuần (socket loopback tự bind; 0 DB/Redis/S3/Vault window).

**Bối cảnh:** packet đòi ghi 5 kind sự kiện + payload tuyệt đối không token/secret + verify đúng 2 suite chỉ tên. Ledger DB hiện có (modules/audit, bảng admin_audit_events) phụ thuộc pg — gắn vào plane shell thuần offline sẽ phá luật offline-only; hình đúng là SINK TIÊM ĐƯỢC kiểu đóng, default console. Hai mạch ngầm phải đo trước khi code (→ Δ41): router shell KHÔNG chứa mutation nào — csrf_denied vật lý không thể ghi trong shell-router, nó ở gate dispatcher assertRoleActionTenant (nơi suite oidc03 chạy, đúng ý đồ packet step 3); và revoked-vs-expired PHÍA WIRE là cố ý không tồn tại (SEC-02 one-null-path) — muốn biết thật phải đọc store TRƯỚC khi eviction xoá dấu ⇒ classify là đọc-không-đổi, phục vụ audit, không phục vụ response.

**Chính sách (closed-form — zero-leak là cấu trúc, không chỉ lời thề):**
1. AdminSecurityEvent chỉ có kind + reason (enum đóng) + method + pathname + action; KHÔNG có field tự do nào — token/cookie-value/session-id/csrf-secret không có chỗ đáp. Kiểm chứng sentinel là bằng cấp dưới của chính này: planted 5 họ giá trị bí mật (token sai, adminToken đang dùng, cookieSecret, sid sống, csrf STORED + PROVIDED qua resolver THẬT) — không họ nào xuất hiện trong JSON đã serialize của mọi event.
2. auth.login_failed: emit tại nhịp sai token, TRƯỚC khi render 401; sai token KHÔNG sinh ra auth.tls_required (nhịp deny chạy sau credential check) — pin thứ tự bằng test.
3. auth.tls_required: chỉ khi credential ĐÃ hợp lệ + requireSecure + TLS chưa chứng minh → 503 (thừa kế Δ37: shape 401 giữ nguyên, deny không thành oracle thăm dò).
4. session_expired vs session_revoked: classify đọc-không-đổi chạy TRƯỚC get() — chết vì absolute deadline/idle được báo là EXPIRED, không bị eviction biến thành absent; backend có storage-TTL riêng (Redis SETEX) báo expired dạng hòa tan absent_or_revoked — chính tả thật, không bịa phân biệt.
5. invalid_shape (sid rác sai cú pháp) KHÔNG ghi gì — id chưa từng sống thì chưa bị chấm dứt; gap có chủ đích, khai trong docblock từ vựng.
6. auth.csrf_denied: emit tại nhịp CSRF của gate dispatcher qua tham số optional — gate vẫn THUẦN (tự nó không I/O; sink là observer do caller tiêm), decision byte-identical, không sink = im lặng.
7. Không wired securityAudit (config cũ, test cũ): hành vi y hệt từng byte — bằng chứng REGRESS2_EXIT=0 (49/49) chạy NGAY sau production edit, TRƯỚC khi test mới tồn tại.
8. Default tại mount = một dòng console cấu trúc (kỷ luật class-only của ADM-BASE-03 dẫn đường); attachAdminShell giữ nguyên, server.ts 0 dòng mới; Platform có thể tiêm sink ghi ledger admin_audit_events bằng MỘT tham số (Δ42 — ngoài quyền lane).
9. Thành công không ghi: mint 302, logout tự nguyện, anonymous, cookie chết trên trang login (UX restart) — im lặng hết. Taxonomy là sự kiện an ninh, không phải traffic.

**Bảng chứng literal (mọi *_EXIT= đọc từ dòng thô trong log — Δ14; cwd du-rework):**
| Bước | Log | Kết quả |
|---|---|---|
| Baseline TRƯỚC sửa (packet command) | s11-baseline.log | BASELINE_EXIT=0 (49/49) |
| Lint lần 1 sau production edit | s11-lint1.log | LINT1_EXIT=2 — TS2322 của CHÍNH lane (helper chưa narrow reason) |
| Jest lần 1 sau production edit | s11-regress.log | REGRESS_EXIT=1 (suite lifecycle chết vì cùng lỗi compile) |
| Lint sau sửa narrowing | s11-lint2.log | LINT2_EXIT=2 — CHỈ CÒN src/server.ts (lane Platform đang sửa dở, thiếu field sort); 0 lỗi trên file lane |
| Run regression cây sạch lỗi lane | s11-regress2.log | REGRESS2_EXIT=0 (49/49) — wire KHÔNG đổi trước khi test mới tồn tại |
| First run sau +19 test | s11-firstrun.log | FIRSTRUN_EXIT=1 — 2 lỗi TS2532 strict-indexed của test mới (self, sửa ngay) |
| Run lại | s11-firstrun2.log | FIRSTRUN2_EXIT=1 — 1 đỏ KHÔNG phải logic: TypeError fetch failed / connect ETIMEDOUT trên port loopback mới-OS-chọn (SYN bị host nuốt) |
| Run lại tiếp | s11-firstrun3.log | FIRSTRUN3_EXIT=0 (68/68) |
| NC-A v1 (void 0 && trước emit) | s11-nega.log | NEGA_EXIT=1 vì TS2873 compile-dead — KHÔNG phải control; ghi trung thực, làm lại v2 |
| NC-A v2 (3 emit → void no-op) | s11-nega2.log | NEGA2_EXIT=1 — 10 failed/58 passed, ĐÚNG 10 test lifecycle nhóm mới (danh sách literal: s11-nega2-names.txt) |
| NC-B (classify dối expired→absent) | s11-negb.log | NEGB_EXIT=1 — 2 failed/66 passed, đúng 2 test session_expired (s11-negb-names.txt) |
| NC-C (xóa emit csrf ở dispatcher) | s11-negc.log | NEGC_EXIT=1 — 5 failed/63 passed: ĐÚNG 3 test csrf_denied + 2 đỏ THỪA là 2 leg socket loopback (flake transport như firstrun2, không liên quan mutation; s11-negc-names.txt) |
| Hardening sau flake | (test file) | postLoginWithConnectRetry: 3 attempt/250ms, CHỈ retry khi SYN không tới server ⇒ không thể mint/event nhân đôi; assertion giữ nguyên (Δ45) |
| Packet ×3 SAU revert | s11-packet-f1..3.log | PACKET_F1/F2/F3_EXIT=0 (68/68 ×3) |
| Rộng 11-suite ×3 SAU revert | s11-final-r1..3.log | FINAL_R1/R2/R3_EXIT=0 (170 passed + 7 skipped ×3; 151+19=170 khớp từng test mới; 7 skip = DU_LIVE_INFRA [SKIP-QUALIFIED]) |
| lint + packet tsc SAU revert | s11-lint-final.log, s11-tsc-final.log | LINT_FINAL_EXIT=0, TSC_FINAL_EXIT=0 — nhiễm ngoài (server.ts lane Platform) đã tự sạch giữa chu kỳ; mọi con tính cuối ĐẾM LẠI fresh trên cây revert |

Residue sau 3 NC: grep void 0 &&, void config.securityAudit, void audit = 0 match; classify expired_* đứng đúng chỗ (2 dòng). File s11-*-names.txt giữ làm bằng danh sách đỏ; script node tạm để trích dòng đã xoá.

**Win-lose 19 test mới:** lifecycle (15): L1 login_failed closed-form + sentinel token vô hình — đỏ nếu event thêm BẤT KỲ field giá trị; L2 không-sink 401 từng byte; L3 tls_required ĐÚNG 1 event + sentinel adminToken/cookieSecret vô hình; L4 pin thứ tự (sai token + unproven → CHỈ login_failed); L5 mint thành công im lặng; L6 logout tự nguyện im lặng; L7 absolute → session_expired/expired_absolute + sid sống vô hình trong payload; L8 idle → expired_idle (reason khác, wire giống); L9 destroy → session_revoked/absent_or_revoked + sweep 302 y hệt; L10 forged well-formed → lớp hòa tan thành thật; L11 sai-cú-pháp → không ghi gì; L12 store không classify → fallback absent_or_revoked; L13 anonymous + trang-login-cookie-chết → im lặng; L14 từ-vựng-đóng (mọi key trong allow-list, mọi kind trong bảng) — đỏ nếu ai đó thêm field tự do; L15 REAL listener: default sink tại mount ghi ĐÚNG 1 dòng parse-được JSON, sentinel-free. oidc03 (4): một csrf_denied closed mang action; 7 hình denial/allow khác im lặng tuyệt đối (csrf_denied NHÁNH ĐƠN ĐIỆU); delegate mang sink qua tên ổn định; resolver THẬT + sentinel csrf STORED/PROVIDED/sid không vào event.

**Δ-DEVIATION (Δ41–Δ45, đề nghị coordinator/Reviewer adjudicate):**
- **Δ41 — vị trí csrf_denied:** packet ghi nhận cả 5 kind "trong shell-router.ts"; router không dispatch mutation nào ⇒ csrf_denied vật lý không tồn tại ở đó. Lane ghi tại gate dispatcher (chỗ thật xảy ra denial) với từ vựng đóng, KHÔNG thêm emit giả trong router. Đường revert nếu Reviewer muốn đúng chữ packet: xóa tham số audit? + dòng emit + 4 test oidc03 (4 kind router vẫn nguyên).
- **Δ42 — wiring JSON-plane chờ Platform:** authorizeAdminAction/assertRoleActionTenant được gọi ở server.ts (file lane Platform) KHÔNG truyền audit ⇒ csrf_denied sản xuất trên mặt API CHƯA được ghi cho tới khi call-site truyền sink (một dòng, ngoài quyền lane). Mặt shell (4 kind router) đã ghi NGAY tại mount qua default console — độc lập server.ts.
- **Δ43 — one-null-path SEC-02 giữ nguyên:** classify chỉ phục vụ audit, không nhánh response nào đọc nó; Redis-SETEX báo expired dạng hòa tan absent_or_revoked vì record đã bị storage xoá — nếu Reviewer muốn expired chính xác cả trên Redis, cần thay đổi ngữ nghĩa repository (ra ngoài packet, cần quyết riêng).
- **Δ44 — invalid_shape không ghi (gap chủ đích):** nếu operator cần tín hiệu id rác, đó là kind MỚI (chưa có trong bảng packet) — lane không tự mở rộng từ vựng.
- **Δ45 — socket test hardening:** postLoginWithConnectRetry vì 2 lần loopback flake ĐÚNG Type cùng triệu chứng trong phiên (s11-firstrun2, s11-negc) — host nuốt SYN trên port mới; assertion và cách đếm event không đổi, chỉ transport được retry khi chắc chắn yêu cầu chưa tới server. Test-infrastructure, không production.

**Status trung thực 4 mức:**
- Taxonomy + emitters (4 kind router + 1 kind dispatcher, closed-form, default sink tại mount): SPECIFIED → IMPLEMENTED → **VERIFIED (offline)** — packet command ×3 exit 0, chuỗi rộng 170+7skip ×3 exit 0, lint 0, packet tsc 0; BA negative control đỏ đặc hiệu (v1 compile-dead KHÔNG tính; v2 10/68, NC-B 2/68, NC-C 3/68 đúng nhóm — 2 đỏ thừa ở negc là flake transport đã khai) rồi ĐẾM LẠI toàn chuỗi sau revert.
- Zero-leak: VERIFIED (offline) — cấu trúc đóng + 5 họ sentinel + resolver thật; lưu ý: đường ghi hiện tại là default console tại mount; khi Platform nối sink ghi ledger DB (Δ42) thì payload phải được kiểm lại qua đường đó.
- **ACCEPTED: KHÔNG.** G-SEC vẫn NO-GO (bằng chứng browser Δ11/Δ35, live windows, SEC-00 sign-off chưa chạy); không tick dòng task nào; Δ13, Δ30–Δ45 chờ Reviewer adjudicate.
- Không commit/push; không DB/Redis/S3/Vault window. HEAD 7811298.

— Qwen-SEC, 2026-09-26 (cycle 11). Khuyến nghị /compress trước chu kỳ sau.
















