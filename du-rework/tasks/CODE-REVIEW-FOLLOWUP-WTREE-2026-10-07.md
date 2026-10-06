# Code review follow-up — working tree 2026-10-07 (đối chiếu trực tiếp, reviewer read-only)

Trạng thái: **9 finding SPECIFIED (WT‑01..WT‑09) · 0 IMPLEMENTED (cho finding) · 0 VERIFIED · 0 ACCEPTED**.

Nguồn: review đọc trực tiếp từng dòng trên **working tree dirty tại HEAD `4308cc5`** (change set đang chờ duyệt trong du‑rework: CB‑02/B3 admission writer + migration 0036, CB‑03 seams, CB‑04 Portal fixes, SC‑04‑M02 BFF dispatch, F‑VFY6‑01 boot policy). Không suy từ receipt cũ; reviewer **không sửa source/test**. File này là **plan-only** theo [COORDINATOR-CONTRACT.md](../coordination/COORDINATOR-CONTRACT.md): coordinator chỉ ghi plan/receipt/spec, owner nhận lease, Tester chạy lệnh, Claude Code review trước ACCEPTED. Lệnh mang tính kê đơn: **owner/Tester tự chạy lại trên cây hiện tại**; số liệu dưới đây là baseline lịch sử, `file:line` có thể lệch sau rebase.

**Scope: chỉ `du-rework/`.** Ba finding legacy root ở bản đầu (WT‑10..WT‑12) đã được **loại khỏi plan này** để tránh nhầm lane/gate; ID không tái sử dụng, vết tách ghi ở §7.

> **Code freeze giữ nguyên.** Mọi packet: **không commit, không push**, không tick parent, không tạo gate mới.

## 0. Cách đọc và dùng file này

Ba cột trạng thái bắt buộc khi báo cáo (AGENTS.md): **đã code / đã verify / đã accept**. Mỗi finding có sẵn: lệnh repro (kiểm tra finding còn tồn tại), acceptance + bằng chứng, test phải viết (**failing‑first**), lease path, dependency, đường dẫn receipt.

Evidence hợp lệ cho một receipt: `task ID` + `command` + `cwd` + `SHA/build digest` (nếu có) + `exit code` + `passed/failed/skipped` + đường dẫn raw output + namespace nếu dùng DB/Redis/S3/Vault thật. **Không** lấy “focus suite xanh” suy cho toàn bộ suite; receipt đỏ mới hơn hoặc finding HIGH/MEDIUM còn mở giữ gate.

## 1. Baseline evidence (reviewer, read‑only — lịch sử, Tester chạy lại)

| # | Lệnh / cwd | Kết quả ghi nhận được |
|---|---|---|
| B1 | `cd du-rework/services/orchestrator` · `node node_modules/jest/bin/jest.js --runInBand` | **9 suites failed / 27 skipped / 204 passed (213 of 240)** · **63 failed / 245 skipped / 4933 passed** · 131 s |
| B2 | cùng cwd · `--silent cb02-admission-writer.test.ts encryption-boot-options.test.ts bff-secrets-method-dispatch.test.ts` | 3 suites · **66/66 pass** |
| B3 | cùng cwd · `--silent v1-boot-typed-denial.test.ts vfy-cb01-dispatch-matrix.test.ts cb-02-webhook-result-delivery.test.ts cb-03-outbound-auth.test.ts sec-enc-05-boot-wiring.test.ts multipart-routes-offline.test.ts` | 6 suites · **98/98 pass** |
| B4 | `cd du-rework/packages/contracts` · `node node_modules/jest/bin/jest.js --runInBand --silent` | 30 suites · **567/567 pass** |
| B5 | `cd du-rework/apps/admin-web` · `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| B6 | `cd du-rework` · `python tools/openapi/validate_openapi.py` | **exit 0**, `paths=58 x-absent=9` |
| B7 | `node -v` | **v22.16.0** — lệch `engines: >=24.21.0 <25`; ghi vào mọi receipt như deviation môi trường |

**9 suite đỏ ở B1 và phân loại nguyên nhân (tránh đổ lỗi sai cho change set hiện tại):**

| Suite đỏ | Nguyên nhân hiện trường | Do change set này? |
|---|---|---|
| `tapi01-closure-offline.test.ts` | `EMPTY_PROFILE_POLICY_READ` thêm `callbackPolicy: null` → assert shape tại `:331` vỡ | **CÓ → WT‑02** |
| `admin-operations-sort.test.ts`, `admin-operations-sort-http-offline.test.ts`, `admin-operations-sql.test.ts`, `rv01-loopback-http-offline.test.ts` | harness fake‑pg reject SQL thật do `list-query.ts` phát ra (`SELECT *, to_char(...) AS __cursor_sort_key`); `list-query.ts` không nằm trong change set | KHÔNG (đỏ từ trước) |
| `artifact-read-authorization.test.ts` | có case tên `FINDING:` mô tả defect đã biết (`lease_active` collapse) | KHÔNG |
| `admin-shell-session-lifecycle.test.ts` | taxonomy log sink | KHÔNG |
| `migration-verify-trap-fix.test.ts:77`, `migration-0032-rollback.test.ts:113` | expect cứng 33 ledger rows / chỉ 0032 applied; thư mục đã có **36** migration (0001→0036, sequence duy nhất, **không trùng**) | Đỏ từ khi có 0033; 0036 làm đỏ thêm → WT‑08 |

## 2. Findings

### 2.1 Bảng tổng hợp

| ID | Mức | Chủ đề | Scope repo | Owner lane gợi ý | Block |
|---|---|---|---|---|---|
| WT‑01 | HIGH | `resolveCallbackSecret` không bao giờ được dựng ở composition | `du-rework` | Auth/secret/egress + webhook owner | VERIFIED + VFY‑CB‑01 |
| WT‑02 | MEDIUM | Read DTO profile detail đổi shape → vỡ contract test T‑API‑01 | `du-rework` | admin‑read + contracts owner | VERIFIED |
| WT‑03 | MEDIUM | CB‑02 write/retry path chưa có test | `du-rework` | profiles/submission owner | ACCEPTED |
| WT‑04 | MEDIUM | Stored policy hỏng: admission 500 vs Portal im lặng `null` | `du-rework` | admin‑read + Portal owner | ACCEPTED |
| WT‑05 | LOW | Docs `08` sai với code hiện tại (2 chỗ) | `du-rework` | CB‑05 docs owner | CB‑05 row |
| WT‑06 | LOW | Comment/code lệch ở purpose filter Portal | `du-rework` | Portal owner | — |
| WT‑07 | LOW | Generator OpenAPI assert trên text source | `du-rework` | docs/build integrator | — |
| WT‑08 | LOW | Test đếm cứng số migration | `du-rework` | migration owner | — |
| WT‑09 | LOW | `du-rework/.gitattributes` thiếu rule eol (CRLF drift) | `du-rework` | build integrator | provenance claim |

### 2.2 Chi tiết từng finding

---

**WT‑01 / HIGH — callback secret resolver: seam được khai báo nhưng không bao giờ được nối**

- **Parent:** `CB-03` (`tasks/PROFILE-CALLBACK-2026-10-06.md`), parent gate `VFY-CB-01`.
- **MISMATCH (expected → actual):**
  - Expected: production trả lời `{kind:'managed-secret', ref}` để callback có credential gửi được.
  - Actual: `du-rework/services/orchestrator/src/server.ts:300-304` khai `resolveCallbackSecret?` / `callbackOAuth2Options?` trên `ServerConfig`; `src/app/bootstrap/create-app.ts:1046-1048` forward hai optional sang sweep; nhưng **không có phép gán nào ngoài test** → sweep luôn nhận `undefined` → `webhooks.ts:653-656` đẩy `WEBHOOK_AUTH_UNAVAILABLE`, `:669-673` và `:714-717` biến mọi lỗi auth thành cùng mã. Hậu quả: delivery có credential **burn retry budget rồi chết** với lỗi trông như sự cố upstream, trong khi gốc là thiếu cấu hình.
- **Repro (kiểm tra finding còn tồn tại):** `rg -n "resolveCallbackSecret|callbackOAuth2Options" du-rework --glob '!**/node_modules/**'` → chỉ `server.ts`, `create-app.ts`, `webhooks.ts` + 3 file test. `rg -n "resolveCallbackSecret" du-rework/services/orchestrator/src/main.ts` → rỗng.
- **Hướng xử lý (owner chọn, coordinator chốt):** (a) dựng resolver thật ở composition từ SC‑02 Vault resolver (đòi SC‑01 backend đã bị descope → cần quyết định scope), **hoặc** (b) công khai degraded như SC‑01 Option A.
- **Acceptance + bằng chứng:** Nếu (a): 1 call‑site gán thật + test offline chứng minh `createApp` nhận resolver và delivery dùng được secret ref (mock receiver + mock token server), no‑plaintext (giá trị secret không xuất hiện trong log/payload/audit). Nếu (b): thêm **mã lỗi terminal riêng, không retry** cho “chưa cấu hình resolver” (tách khỏi `WEBHOOK_AUTH_UNAVAILABLE` transient) + row không tiêu hao attempt; cập nhật `docs/08-connector-api.md` + OpenAPI.
- **Test bắt buộc (failing‑first):** `tests/cb03-composition-resolver.test.ts` — (1) composition hiện tại không truyền resolver → fail; (2) sau fix truyền → pass; (3) thiếu resolver mà policy có credential → terminal error đúng mã, `attempts` không tăng.
- **Lease (write):** `services/orchestrator/src/main.ts`, `src/app/bootstrap/create-app.ts`, `src/server.ts`, `src/modules/webhooks/webhooks.ts`, tests tương ứng. **Read‑only:** `src/modules/secrets/vault-resolver.ts`, `packages/contracts/src/profile-callback.ts`.
- **Dependency:** SC‑01 backend descope (Option A). Đụng lease của webhook owner → lấy lease trước khi sửa.

---

**WT‑02 / MEDIUM — read DTO profile detail đổi shape, đang làm đỏ contract test**

- **Parent:** `CB-02` (B3) / `T-API-01`.
- **MISMATCH:** Expected: `/new` blank editor trả shape policy không đổi. Actual: `profile-detail.ts:73-81` thêm `callbackPolicy: null` vào `EMPTY_PROFILE_POLICY_READ` (dòng `:80`) → `tests/tapi01-closure-offline.test.ts:328-340` (assert tại `:331`) fail, diff `+ "callbackPolicy": null`.
- **Repro:** `cd du-rework/services/orchestrator` · `node node_modules/jest/bin/jest.js --runInBand tests/tapi01-closure-offline.test.ts` → 1 failed / 6 passed.
- **Quyết định cần chốt (contracts owner):** giữ `null` là có chủ ý (Portal phân biệt `undefined` vs `null` tại `profiles-screen.tsx:941` để quyết định gửi clear) → **cập nhật test + ghi vào DoD của read contract**; hoặc bỏ key khi null để giữ byte‑compat. **Không** sửa behavior bằng cách xóa sự phân biệt tri‑state.
- **Acceptance:** test được update và **fail trước / pass sau**; mọi consumer của `ProfileEndpointPolicyRead` được liệt kê (admin‑web details/local storage, `docs/19`, `docs/35`); `packages/contracts` test vẫn xanh (B4).
- **Lease:** `services/orchestrator/src/modules/admin-read/profile-detail.ts`, `services/orchestrator/tests/tapi01-closure-offline.test.ts` (+ cùng lease WT‑04).

---

**WT‑03 / MEDIUM — CB‑02 write/retry path chưa có test**

- **Parent:** `CB-02` (B1 publish/write + retry carry‑forward).
- **MISMATCH:** Expected (AGENTS.md §4): code mới có focused unit/contract smoke. Actual: chỉ builder thuần `buildCallbackPolicySnapshot` (`submission.ts:651`) được cover bởi `tests/cb02-admission-writer.test.ts`. Chưa có test cho **write boundary** (`profiles.ts:174-193` parse stored/write, `:211`, `:270-275` tri‑state absent/null/client‑value, `:313` decode policy, `:352-356` SELECT + `:440-456` INSERT với cột `callback_policy`) và **retry carry‑forward** (`retry.ts:73-88`).
- **Repro:** `rg -n "callbackPolicy|callback_policy" du-rework/services/orchestrator/tests` → chỉ `cb-02-webhook-result-delivery.test.ts` và `cb02-admission-writer.test.ts`.
- **Acceptance:** test mới fail trước khi chủ động làm lệch hành vi (ví dụ xóa `callbackPolicy` khỏi INSERT) và pass sau; có guard chống lệch cột/tham số (assert thứ tự cột `profile_policy_snapshot → callback_policy → prompt_revisions_pin`).
- **Test bắt buộc:** `tests/cb02b-profile-publish-callback.test.ts` với stub `PoolClient` capture SQL: (1) absent → kế thừa revision trước; (2) `null` tường minh → ghi NULL; (3) client value sai → 422 với `pointer: '/callbackPolicy/...'`; (4) stored hợp lệ → chép nguyên refs, không có value. `tests/cb02c-retry-callback-pin.test.ts`: retry copy `callback_policy` đúng vị trí cột.
- **Lease:** `services/orchestrator/tests/cb02b-*.test.ts`, `cb02c-*.test.ts`; source tương ứng chỉ sửa khi test chứng minh bug thật.

---

**WT‑04 / MEDIUM — stored callback policy hỏng: hai surface xử lý ngược nhau**

- **Parent:** `CB-02` + `CB-04`.
- **MISMATCH:** cùng một giá trị lưu trong DB nhưng `profiles.ts:174-182` **throw 500** còn `profile-detail.ts:125-131` **âm thầm project `null`**; hệ quả Portal (`profiles-screen.tsx:941`, `:680-690`) coi như “chưa cấu hình” → uncheck không sinh `callbackPolicy: null` → pin hỏng **không thể xóa**, mọi delivery tiếp theo fail‑closed mãi mãi.
- **Expected:** Portal nhìn thấy policy đang ở trạng thái invalid và có đường Replace/Clear rõ ràng; admission vẫn fail‑closed.
- **Acceptance:** read DTO phơi marker tường minh (ví dụ `callbackPolicy: null` + flag/`x-` tương đương được contracts duyệt) thay vì ẩn; test offline: stored jsonb sai → read trả marker, admission vẫn fail‑closed, Portal gửi được clear.
- **Lease:** cùng lease WT‑02 (`profile-detail.ts`), phối hợp Portal owner (`apps/admin-web/src/features/**`).
- **Dependency:** làm liền WT‑02 (cùng file/contract read shape).

---

**WT‑05 / LOW — docs `08` sai với code hiện tại**

- **MISMATCH:** `docs/08-connector-api.md:7` vẫn ghi “POST `/admin/api/secrets` hiện trả 405 … nhánh create unreachable” (đã sửa tại `src/app/admin/bff/secrets.ts:79-100`); `:9` ghi “`policy.callbackPolicy` chưa có trong canonical schema; production callback secret resolver **và** admission pin writer còn thiếu” — pin writer đã có (`submission.ts:400-409`, giá trị tại `:511`), resolver vẫn thiếu (đúng, giữ lại, nối WT‑01).
- **Acceptance:** hai đoạn được cập nhật đúng hiện trạng; không hand‑edit `21-openapi.json`; chạy lại B6 exit 0.
- **Lease:** `du-rework/docs/08-connector-api.md` (CB‑05).

---

**WT‑06 / LOW — Portal purpose filter: comment nói một đằng, code một nẻo**

- **MISMATCH:** `apps/admin-web/src/features/profiles/callback-policy-editor.tsx:48-50` `purposeMatches` chỉ nhận exact purpose hoặc `undefined`, trong khi comment vùng `:66-71` khẳng định “`generic` (hoặc thiếu purpose) vẫn chọn được”. `apps/admin-web/src/lib/api/types.ts:356-365` có `'generic'` (`:363`) → generic bị lọc mất.
- **Acceptance:** chọn một: cho phép `generic` (có test ràng buộc) **hoặc** sửa comment; typecheck B5 vẫn exit 0.
- **Lease:** `apps/admin-web/src/features/profiles/callback-policy-editor.tsx`, `callback-policy.ts`.

---

**WT‑07 / LOW — generator OpenAPI assert trên text source**

- **MISMATCH:** `tools/openapi/gen_openapi.py:775-784` khóa behaviour bằng cách quét chuỗi nguồn của `bff/secrets.ts` (kể cả fragment `effectiveRoute = route;`). Reformat là gãy tool với thông báo không liên quan nguyên nhân thật.
- **Acceptance:** export helper `resolveSecretsRoute(method, route)` từ BFF và cho generator/projection assert qua helper (hoặc test riêng) thay vì text scan; B6 vẫn exit 0.
- **Lease:** `services/orchestrator/src/app/admin/bff/secrets.ts`, `tools/openapi/*`, `du-rework/docs/21-openapi.json` (sinh lại, không sửa tay).

---

**WT‑08 / LOW — test đếm cứng số migration**

- **MISMATCH:** `tests/migration-verify-trap-fix.test.ts:77` expect 33 ledger rows (thư mục hiện có **36** file 0001→0036); `tests/migration-0032-rollback.test.ts:113` expect chỉ `0032` được apply (thực tế 0032→0036). Đã đỏ trước 0036 nhưng mỗi migration mới làm đỏ thêm.
- **Acceptance:** derive số lượng từ thư mục thay vì pin hằng số (giữ nguyên ý đồ phát hiện duplicate/collapsed sequence); test mới fail khi cố tình thêm file sequence trùng.
- **Lease:** `services/orchestrator/tests/migration-verify-trap-fix.test.ts`, `tests/migration-0032-rollback.test.ts`.

---

**WT‑09 / LOW — line ending drift trong du‑rework**

- **MISMATCH:** `du-rework/.gitattributes` hiện chỉ phủ Dockerfile/yml/scripts; mọi file `.ts` trong du‑rework khi chạm tới đều cảnh báo “LF will be replaced by CRLF”, trong khi các bake receipt của du‑rework khẳng định so sánh byte‑for‑byte.
- **Acceptance:** thêm quy tắc `text eol=lf` cho `.ts/.tsx/.js/.json/.sql` vào `du-rework/.gitattributes`; chứng minh một file round‑trip trong du‑rework không đổi byte. (Quyết định tương tự cho repo root nằm ngoài scope plan này.)
- **Lease:** `du-rework/.gitattributes`.

## 3. Thứ tự wave, lease và tác động gate

| Wave | Task | Vì sao | Lease chính |
|---|---|---|---|
| **W1** | WT‑01, WT‑02 (+ quyết định DTO chung với WT‑04) | Chặn VERIFIED của change set hiện tại: một seam chết làm CB‑03 không giao hàng; một contract test đang đỏ | `orchestrator/src/{main.ts,server.ts,app/bootstrap/create-app.ts,modules/webhooks/webhooks.ts}`; `modules/admin-read/profile-detail.ts` |
| **W2** | WT‑03, WT‑04 | Điều kiện trước ACCEPTED: code mới phải có test và không được để đường fail‑closed không thể thao tác | `orchestrator/tests/**`; `profiles.ts`/`retry.ts` chỉ khi test chứng minh bug |
| **W3** | WT‑05, WT‑06, WT‑07, WT‑08, WT‑09 | Docs/tooling, lease không giao nhau với W1/W2 nên chạy song song | `docs/**`, `tools/openapi/**`, `apps/admin-web/src/features/profiles/**`, `.gitattributes` |

- WT‑02 và WT‑04 **cùng một lease** (`profile-detail.ts` + consumer Portal) → giao một owner, không hai writer.
- WT‑01 đụng lease của webhook owner (CB‑02) và có thể đụng `main.ts` (đang có hunk F‑VFY6‑01) → lấy lease trước khi sửa.
- Gate giữ mở: `VFY-CB-01`, `CB-05`, `T-API-01` row liên quan WT‑02. **Không tick parent** bằng smoke offline.

## 4. Những gì đã đúng — regression lock (không được làm gãy khi sửa)

1. Căn lề cột/tham số đúng ở cả hai INSERT mới: `submission.ts:453-511` (20 cột ↔ 19 params + literal `state_version=1`) và `retry.ts:73-88`.
2. `migrations/0036_profile_callback_policy.sql`: additive, nullable `jsonb`, `IF NOT EXISTS`; 36 sequence duy nhất, không trùng.
3. Subquery `(SELECT n.profile_name … LIMIT 1)` (`profiles.ts:352-356`) an toàn vì `profile_names.profile_id` là PK (`migrations/0028_profile_name.sql:22-31`).
4. Fail‑closed chain: invalid pin → `WEBHOOK_POLICY_INVALID`; destination không duyệt → `DESTINATION_DENIED`; pin copy tenant/profile/revision nên publish/rollback sau không đổi hướng callback đã admit.
5. SC‑04‑M02 giữ nguyên fence: `app/admin/bff/secrets.ts:148-158` vẫn ép platform‑admin + `x-csrf-token` trên nhánh create mới reachable; method khác vẫn 405 trước auth.
6. F‑VFY6‑01 (`boot-options.ts:487-520`): đọc `dataMode` từ cùng summary mà `/health` dùng, nội dung thông điệp content‑safe, matrix 7 case khớp D‑BOOT‑01 hybrid; image có `NODE_ENV=production` nên predicate có hiệu lực trong container.
7. Purpose value single‑source tại `packages/contracts/src/secret-catalog.ts:40-41`; Portal mirror (`lib/api/types.ts:356-365`).

## 5. Nghĩa vụ docs/inventory khi đóng từng packet

- Mỗi packet cập nhật contract/flow docs tương ứng; owner tài liệu đồng bộ `docs/19-traceability-audit-matrix.md`, `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md` (thuộc WT‑05 hoặc WT‑03 tùy lane). Không cộng số liệu tiến độ; đếm lại từ task rows.
- WT‑02/WT‑04 là thay đổi **wire read DTO** → phải liệt kê consumer và ghi vào docs read contract, không chỉ sửa test.

## 6. Dispatch skeleton (coordinator điền owner thật khi dispatch)

Mỗi packet cần: task ID · canonical plan (file này) · lease path chính xác (chỉ trong `du-rework/`) · owner (chọn theo roster/terminal **thật**, không suy từ ledger) · dependency (WT‑02↔WT‑04 cùng lease; WT‑01 đụng lease webhook) · acceptance/evidence (mục 2.2) · đường receipt.

| Packet | Receipt path gợi ý | Điều kiện đóng |
|---|---|---|
| W1 | `du-rework/coordination/reports/wt01-callback-resolver-2026-10-07.md`, `wt02-read-dto-2026-10-07.md` | test fail‑trước/pass‑sau + Tester độc lập + Claude Code `APPROVED` |
| W2 | `.../wt03-cb02-write-tests-2026-10-07.md`, `wt04-invalid-pin-2026-10-07.md` | Tester độc lập đọc vị trí dòng mới; orchestrator focus suite |
| W3 | `.../wt05-09-docs-tooling-2026-10-07.md` | B5/B6 exit 0, không hand‑edit `21-openapi.json` |

Receipt raw output để tại `du-rework/coordination/reports/raw/wt-2026-10-07/`. Toàn bộ packet: **không commit, không push**, giữ code freeze cho tới khi batch pending Section 13 được reviewer thẩm định độc lập.

## 7. Cập nhật 2026-10-07 ~00:45 — tách scope và sự kiện sau khi file này được viết (00:05)

1. **Tách scope (theo yêu cầu tránh nhầm lane):** bản đầu của file này có 3 finding legacy root (WT‑10 semaphore chưa nối, WT‑11 rolling‑lease/fail‑open + F‑P1‑01, WT‑12 thiếu test/cast thừa). Ba finding đó **đã bị loại khỏi plan du‑rework** và bàn giao cho legacy lane ở repo root (`coordination/reports/wt-legacy-fairshare-findings-2026-10-07.md` — file ngoài du‑rework, chỉ ghi để truy vết, không thuộc plan này). ID WT‑10..WT‑12 không tái sử dụng.
2. **Plan đã được dispatcher tiếp nhận:** `scratch/prompt-qwen1-wt01.txt`, `prompt-qwen5-wt02-wt04.txt`, `prompt-qwen2-wt05-wt08-wt09.txt` (00:12). Prompt tồn tại ≠ delivery; owner/tester vẫn phải nộp receipt theo §6. Kiểm `scratch/` trước khi giao trùng.
3. **Đã sửa lỗi đường dẫn trong spec:** wave1/wave2 từng ghi receipt tương đối `coordination/reports/...`; repo root cũng có thư mục `coordination/reports/` đang hoạt động → đã đổi thành `du-rework/coordination/reports/...` tường minh để receipt không rơi ra ngoài du‑rework.
