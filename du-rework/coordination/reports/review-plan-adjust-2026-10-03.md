# Receipt — review-plan-markers-features (lane b103836b) — 2026-10-03

**Packet:** review-plan-markers-features · **Dispatch:** 2026-10-03T12:45+07:00 (coordinator command-code)
**Lane:** b103836b (Claude Code) · **Boundary:** chỉ sửa `du-rework/tasks/*.md` + ghi receipt này.
Không sửa code/source/test; không commit; không tick gate; không chạm nocobase-10.
**Trạng thái:** marker S1/S2/S5/S6/S7 xong; S3/S4 xác minh nhưng ngoài phạm vi lane (handoff); feature-gap quét xong,
**không thêm row mới** (lý do ở §4); `tasks/README.md` đang `M` từ trước dispatch — giữ nguyên, không đụng.

## 1. File tasks/*.md đã sửa (5 file) + tóm tắt thay đổi từng file

| # | File | Thay đổi |
|---|---|---|
| 1 | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` | **S5** — 2 chỗ: (a) matrix row API key (~line 17): `dispatcher.ts:95 chỉ có apikey.bind-profile` → `dispatcher.ts:100-106 đã có apikey.issue/revoke (implement :540/:619, tenant fence, hash-only store, copy-once — S5 2026-10-03)`; MISMATCH còn lại thu hẹp thành **UI-wiring + rotate/disable**. (b) `PAR-M01` (~line 34): cùng nội dung, thêm `Còn thiếu: rotate/note-update/disable; UI form create/revoke chưa chứng minh nối handler thật`. Giữ nguyên marker status `[ ]`, chỉ sửa prose stale + file:line. |
| 2 | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` | **S5** — 1 chỗ: `PAR00-M01` (~line 56): `dispatcher :95-114 không có create/revoke` → `dispatcher :100-106 đã có apikey.issue/revoke (:540/:619, tenant fence, hash-only, copy-once — S5 2026-10-03)` + còn thiếu rotate/note-update/disable + UI form chưa chứng minh nối handler. Giữ nguyên marker status. |
| 3 | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md` | **S1/S2** — 4 chỗ: (a) header §trạng thái: thêm câu implementation đã có trên disk (`migrations/0023_admin_local_users.sql`, `admin-local/`, `local-primitives/`, `migrations-local-users-cli.ts` — S1/S2 2026-10-03) nhưng **acceptance chưa có receipt VFY-LOCAL**. (b) `LOCAL-R01`: `Rework không có DB local-user/password identity` → `đã có migration + repository + CLI (S1 2026-10-03); acceptance chưa có receipt nên row vẫn [ ]`. (c) `LOCAL-01` row: thêm cùng ghi chú S1, giữ `[ ]`. (d) `LOCAL-02` row: thêm ghi chú implementation `local-primitives/ + admin-local/credential-reader.ts` (S2), giữ `[ ]`. |
| 4 | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` | **S6/S7** — 1 chỗ (header §trạng thái): thêm đoạn snapshot `adec19e` đã stale giữa CONV wave (`server.ts` đang split dở, `runtime.test.ts` đã split xong 1785 + 8 file mới) — **KHÔNG đổi số baseline hay guard khi wave chưa chốt**; đo lại + re-baseline một lần sau khi CONV wave đóng. |
| 5 | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` | **Stale-offset serialize (§b dưới)** — 1 chỗ: serialize list `server.ts` → `http/routes/admin.ts + app/bootstrap/create-app.ts` (kế thừa sau CONV-01/02/03, `server.ts` còn 375 dòng re-export/entry); `shell-router.ts` → 4 module dispatch (kế thừa sau CONV-12). |

**Không sửa:** `tasks/README.md` (đang `M` từ trước dispatch — giữ nguyên theo lệnh).

## 2. Ghi chú stale-offset đã thêm vào serialize row (file #5)

Nội dung đã ghi (nguyên văn ý): sau CONV-01/02/03, `server.ts` chỉ còn 375 dòng re-export/entry,
route table đã tách sang `src/http/routes/*`; sau CONV-12, `shell-router.ts` đã tách thành
`{auth,section,mutation,crypto-config}-dispatch.ts`. Serialize list trong plan PAR-11..17 do đó
được chuyển tương ứng sang `routes/admin.ts + app/bootstrap/create-app.ts + dispatcher.ts + 4 module dispatch`.
Căn cứ đo trực tiếp: `server.ts` worktree 375 dòng vs HEAD 4299; `mutation-dispatch.ts`,
`section-dispatch.ts`, `auth-dispatch.ts`, `crypto-config-dispatch.ts`, `shell-router-shared.ts` tồn tại trên disk;
independent verify `conv010203-independent-verify-2026-10-03.md` kết luận INVENTORY-IDENTICAL + tsc exit 0.
**Không đổi số baseline/guard** (thuộc S6/S7, chờ wave chốt).

## 3. Feature-gap đã phát hiện — không thêm row mới / còn bỏ ngỏ

Quét theo lệnh dispatch: chỉ thêm row khi capability/invariant **chưa có trong bất kỳ plan nào**
(PAR/COMP/ACUI/RFX/CONV) và đủ file:line. Kết quả: **0 row mới được thêm**. Chi tiết:

### G1. Form `POST /admin/api-keys/new` — ĐÃ NỐI, không phải gap (bác bỏ nghi ngờ ban đầu)
- Nghi ngờ: form create (`api-key-section-renderer.ts:259`) POST `/admin/api-keys/new` trong khi platform
  chỉ có admin-actions dispatcher → tưởng chưa nối handler.
- Xác minh: `mutation-dispatch.ts:38,70-77` (`handleAdminMutationPost`, đã có ở HEAD — `git show HEAD`
  grep `api-keys/new|handleAdminMutationPost` = 4 hit) match path + role admin + CSRF, rồi gọi
  `config.adminAction('apikey.issue', {tenantId})`; `shell-server.ts:365-387` wire `adminAction` →
  `POST /api/v1/admin/actions` với `apiKey: du_<32 bytes base64url>` sinh tại BFF (`:375`).
  Dispatcher `apikey.issue` (`:540-617`): tenant fence `:556`, `hashApiKey` `:560`, prefix `:563-566`,
  `INSERT INTO api_keys (tenant_id, hash, prefix)` `:573`, audit `apikey.create`, raw trả **một lần** trong 201.
  Revoke form (`renderer :184`) tương tự qua `apikey.revoke` (`:619-669`, flip status ACTIVE→REVOKED,
  request path chỉ resolve `status='ACTIVE'`).
- Kết luận: wiring form→dispatcher **có thật**. Claim "chưa nối handler thật" trong S5 nay thu hẹp còn:
  **chưa có browser/HTTP live receipt** chứng minh (thuộc PAR-10/ACUI-10, đã có owner) — không cần row mới.

### G2. Stale reference `POST /api/v1/admin/api-keys` — gap DOC, chưa đủ chuẩn thêm row
- `api-key-section-data.ts:262` (empty message) và comment `api-key-section-renderer.ts:252-253` dẫn tới
  `POST /api/v1/admin/api-keys`, nhưng `http/routes/admin.ts` chỉ match `GET /api/v1/admin/api-keys(/:keyId)`
  (`:505,513`) — **không có POST route** (grep `api-keys` trong admin.ts chỉ 2 hit GET).
  Create thật đi đường BFF `POST /admin/api-keys/new` → `POST /api/v1/admin/actions` (G1).
- Chưa thêm row vì: chỉ là comment/message stale, fix thuộc về lane sở hữu renderer (sửa 2 dòng text),
  không phải capability mới. Ghi ở đây để owner renderer dọn khi chạm file. Không tick, không sửa (ngoài boundary).

### G3. Form `POST /admin/api-keys/:id/acknowledge` — NGHI NGỜ, chưa đủ căn cứ kết luận
- Renderer có form acknowledge (`api-key-section-renderer.ts:163-164`), nhưng `handleAdminMutationPost`
  chỉ match `new | revoke | connectors/.../(test|rotate-secret)` (`mutation-dispatch.ts:38-41`) —
  path acknowledge **không match → return null** → rơi xuống `dispatchShellRequest`.
- Chưa kết luận là gap vì: (a) copy-once window thật được trả inline trong response 201 của `issue`
  (`mutation-dispatch.ts:102-114`, `no-store` + `referrer-policy: no-referrer`), không qua GET
  (`buildApiKeyPage` luôn `createCopyOnce: null` — `api-key-list.ts:181`); (b) chưa đọc hết
  `dispatchShellRequest` để biết POST acknowledge rơi vào đâu (GET handler? 405? silent?).
- Để ngỏ cho lane sở hữu shell-router: xác minh `POST /admin/api-keys/:id/acknowledge` trả gì
  (status/body/DB side effect) rồi mới quyết định row. Không thêm row suy đoán.

### G4. Prefix `du_` (BFF) vs `dg_` (legacy) — divergence đã ghi nhận, không thêm row
- Legacy: `dg_` + 32 bytes base64url, sha256 `keyHash`, `prefix='dg_'`. Rework BFF sinh
  `du_<32 bytes base64url>` (`shell-server.ts:375`); dispatcher prefix default 4 ký tự đầu (`:563-566`);
  hash `sha256 hex` (`api-key-auth.ts:24-26`, inject làm `hashApiKey` tại `admin.ts:333`) — khớp contract hash.
- Prefix khác legacy là divergence có chủ ý hay drift chưa được plan nào chốt. Thuộc quyết định PAR-01
  (prefix/hash contract + migration), đã có owner — không thêm row trùng.

### G5. S3/S4 — ngoài phạm vi lane, handoff (không sửa)
- S3 (comment manifest disbursement "dispatch pending" stale): xác minh manifest HEAD
  `document-core.manifest.ts:333-337` ghi `Dispatch is already wired` — comment **không còn stale** ở dòng
  được dẫn; stale note của recon-h §2/P9-01 trỏ comment cũ đã được sửa bởi commit `b088eec`.
  File manifest thuộc lane document-core — lane này **không sửa**, ghi handoff.
- S4 (tester-p9-03 "not mounted or registered" stale): recon-h §2/P9-03 + tick-proposal S4 đã nêu anchor mới
  (manifest `:110,431`, worker handler, recipe `:448-450` trong HEAD). File receipt thuộc tester lane —
  lane này **không sửa**, ghi handoff.
- Nếu coordinator muốn đóng S3/S4: owner manifest/tester tự sửa + receipt; không thuộc tasks/*.md của lane này.

## 4. Mục còn treo (không thuộc boundary lane này)

1. `tasks/README.md` đang `M` từ trước dispatch — giữ nguyên, chờ user quyết riêng (commit đang chờ user quyết;
   lane này không commit theo lệnh).
2. G3 cần lane shell-router xác minh `POST .../acknowledge` rồi quyết định row (đủ căn cứ mới thêm).
3. G2 (2 dòng comment/message stale) chờ owner renderer dọn khi chạm file.
4. S3/S4 chờ owner manifest/tester sửa file của họ.
5. Mọi acceptance live (PAR-10/ACUI-10/VFY-LOCAL, 2-replica/browser receipt) vẫn NO-GO, giữ nguyên gate.
6. Không amend commit đã push; không stage/commit debris (`.qwen/`, `.openclaude/`, `__probe-*`, v.v. —
   secret-scan trước push khi user cho phép commit).

*Receipt này là deliverable bắt buộc duy nhất của packet; không tick gate, không commit.*
