# Codex implementation cho kết nối business worker với orchestrator

Canonical plan: [PLAN-WORKER-ORCHESTRATOR-2026-10-12.md](PLAN-WORKER-ORCHESTRATOR-2026-10-12.md). Repo scope `du-rework`; baseline `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`, branch `codex/fix-workflow-builder`.

Người dùng đã cho phép implementation và thay luồng điều phối cũ bằng Codex ngày 2026-10-12. Yêu cầu qua mailbox Orca của lượt trước được superseded; không dùng Claude/Orca cho execution này. Root AGENTS, rework AGENTS và model policy có backup trước thay đổi. Giữ nguyên auth key dùng chung và checkpoint/grant key format. Không commit/push/deploy production.

## Ownership hiện tại

| Agent thực | Model | Task | Phạm vi ghi | Trạng thái |
| --- | --- | --- | --- | --- |
| `/root/codex_instructions` | gpt-6-luna max, fork none | Backup và thay instructions | Root/rework AGENTS và backup; agent-model-policy.json và backup | Hoàn tất, backup hashes đã đối chiếu |
| `/root/woc_backend` | gpt-6-luna max, fork none | WOC-00 backend, 02, 03, 04 server, 07 contracts/server; WOC-09/10 và core review repairs | Runtime/queue/contracts, registry, migration 0066, enable/counter admission/read, core repair files | Frozen; 129 expanded focused tests và 48 repair tests, build/typecheck pass; core source repair APPROVED, live pending |
| `/root/woc_sdk` | gpt-6-luna max, fork none | WOC-00 SDK, 01, 04 SDK, 06, 07 SDK; WOC-09 và single-flight; WOC-08 | Core/startup frozen; active template vendor/lock và affected SDK tests lease | 168 core / 140 startup / 16 guard owner tests; core source repair APPROVED; template packet active |
| `/root/woc_transport` | gpt-6-luna max, fork none | WOC-05 | SDK runtime-client.ts và woc-runtime-client tests; receipt riêng | Bàn giao, 14/14 typed tests + lint đạt; scope đã release |
| `/root/verify_worker_orchestrator` | gpt-6-luna max, fork none | VFY-WOC-01/02 | New independent tests/scripts và receipt/raw vfy-woc; chỉ đọc product source | Active; independent builds và 190 SDK / 134 backend tests pass; fresh PG/Redis migration applied; service cases pending |
| `/root/requirements_alignment` | gpt-6.1-sol high, fork none | Audit yêu cầu và independent source review | Read-only product source/plan/receipts | Phase2 complete: core repairs APPROVED source-only; profile 2 P1/2 P2 CHANGES NEEDED; final re-review pending |
| `/root/profile_groups_backend` | gpt-6-luna max, fork none | WOC-10 aggregate profile + function catalog và phase2 repair | New group/catalog contracts/schema/routes; shared profiles/admin/actions serialized after core freeze | First handoff 22 tests/build/typecheck pass; active repair selector locks/ownership/availability/rotation, no local write widening |
| `/root/business_profile_ui` | gpt-6-luna max, fork none | WOC-11 business/version/worker + multi-business profile editor | `orchestrator/apps/admin-web` businesses/profiles/API client/types và focused UI/state tests; không backend/contracts | Frozen; 9 tests/build/typecheck and built-SPA mock browser smoke pass; receipt-woc-ui.md; final independent review pending |

Agent IDs lấy từ spawn_agent và phản hồi trực tiếp, không suy từ ledger lịch sử. Backend độc quyền contracts và build dependencies dùng chung, thông báo handoff trước SDK tests. Template chưa có writer; giao sau canonical handoff. Primary chỉ sửa plan/execution metadata và inspect evidence.

Backup root AGENTS SHA256 `32493FA5A92485E478C09992F8D1F36D3B64B522C85A47B94267D191C6D38713`; rework AGENTS `EB877FF551E74980CD1FB9FC95EBF7018CA0B3CD1BC2EA6B323D258EFE463032`; model policy `2F9776B9FF87A34E693704AD6CF82652FBF442419D30DA802E46C24CCA638964`. Backups có hậu tố `.backup-2026-10-12-codex` bên cạnh file gốc; original hashes do worker ghi trước edit khớp backup hashes primary đọc lại.

## Contract handoff

Heartbeat `backupEffectFence` là extension optional của wire v1; thiếu field phải UNKNOWN/fail-closed, không OPEN hoặc tự ACK. Backend và SDK owner phải thống nhất delay/refusal codes và durable retry trước tích hợp. Shared auth key design không thay.

## Core review đang chạy

Registry/enable/SDK startup source đã freeze cho Sol reviewer `/root/requirements_alignment`. Backend final owner result 12 suites/129 tests, typecheck/build pass; SDK registration 7 suites/140 tests, typecheck pass. Early independent P1: recovery replacement row ID mới nhưng payload deliveryId cũ, có race same-owner replay tạo duplicate handler; cần owner sửa và regression trước acceptance. Reviewer tiếp tục kiểm SDK same-instance duplicate handling. Profile/UI vẫn có writer riêng, chưa là finalized review scope.

Reviewer xác nhận P1 thứ hai: SDK thiếu task/lease single-flight guard, original delivery cùng ID có thể replay về cùng instance concurrency > 1 và gọi handler lần hai dù Runtime heartbeat còn khỏe. Cần SDK owner sửa riêng, giữ lost-ACK claim replay. UI focused tests/typecheck/build đã đạt; browser smoke đang được yêu cầu, full test failures chưa có baseline comparison.

Final [core review](reports/review-woc-core-2026-10-12.md): CHANGES NEEDED, 2 P1 trên và P2 lock cycle catalog→version→worker→catalog giữa registration/heartbeat/claim. Backend đã nhận packet sửa delivery authority + lock order; SDK single-flight queued theo slot/file lease. Không gán APPROVED cho core trước sửa/re-review.

SDK single-flight packet đã dispatch sau profile backend handoff. [Profile groups receipt](reports/receipt-woc-profile-groups.md): 22 focused/local-workbench tests, typecheck/build pass, source frozen; real PostgreSQL migration/CAS chưa chạy. UI focused 8 tests/typecheck/build pass; built SPA mock fixture đang chạy headless bằng bundled Playwright+Chrome trong profile cô lập, chưa có browser verdict. Vite crypto/chunk warnings và full UI test failures vẫn được ghi, không coi fixture HTTP smoke là browser/E2E.

## Evidence và các bước còn lại

### Phase 2 checkpoint

[Independent phase 2 review](reports/review-woc-phase2-2026-10-12.md) approves backend recovery/lock and SDK single-flight repairs at source level. Profile changes need four repairs: selector serialization across group/legacy writers, direct binding child-ownership guard, business availability lock, existing key rotation compatibility. `/root/profile_groups_backend` owns this repair packet; shared auth design stays unchanged.

Independent verifier rebuilt contracts/SDK/orchestrator and passed SDK lint/orchestrator typecheck, 10 SDK suites/190 tests and 12 backend suites/134 tests with normal diagnostics. Fresh labelled disposable PostgreSQL/Redis harness applied all 64 discovered migrations, including sequences 66/67; profile tables exist. Service-level functional/race cases are still running. Raw locator: `reports/raw/vfy-woc-20261012-1505/`.

UI built-SPA headless Chrome smoke passed against an isolated mock API: exact 2 v1 / 1 v2 workers, enable/default separation, unavailable function, multi-business endpoint/workflow save/reload, disabled-business save prevention and CAS conflict preserving draft. Browser exposed schema default persistence; owner fixed it and repeated focused tests/typecheck/build. This is UI smoke, not live PostgreSQL/Connector E2E. Final receipt/source hashes pending.

UI final receipt: [receipt-woc-ui.md](reports/receipt-woc-ui.md), 9 focused tests; detached hashes and screenshots linked there. Full UI suite 96/122 pass, 26 failures unresolved without baseline attribution.

Independent real PostgreSQL functional run reproduced overlap (two active bindings), disable-before-paused-group-commit and historical-key rollback failures. Raw: `reports/raw/vfy-woc-20261012-1505/profile-pg-independent-jest-20261012-1803.log`. Earlier boot/type fixture failures remain raw harness diagnostics, not product findings. Direct child route probe returned 404 and is being corrected before a functional verdict. Repair handoff/rerun pending.

Direct child probe correction used `app.internalServer` instead of the public listener. The real route returned 201 and moved the group-owned child pointer from revision 1 to 2; the group snapshot then failed read. Raw: `reports/raw/vfy-woc-20261012-1505/profile-pg-direct-child-internal-20261012-1924.log`. All four phase2 profile findings have real-PG reproductions. Retest after owner freeze is required.

Independent runtime checkpoint: `woc-independent-runtime-pg.test.ts` 2/2 PASS against real disposable PG/Redis, two in-process createApp service instances with separate listener ports, three SDK workers sharing one scoped business token (v1 two, v2 one). Exact-version Redis queues, pinned completion and one accepted claim per instance verified. Disable retains READY backlog and denies a fresh app-B worker claim without epoch/attempt mutation; CAS re-enable completes backlog and increases v2 acceptance once. Real BullMQ adapter delayed/token/DelayedError and pause/resume tests 2/2 PASS. Raw logs `runtime-pg-independent-jest-20261012-2100.log` and `bullmq-independent-jest-20261012-1950.log`. No deployed images, separate process crash or network partition proof.

Partial profile repair rerun: direct child guard PASS; availability ordering still FAILS (disable finishes while group save paused after FOR SHARE catalog validation). Raw `profile-pg-owner-handoff-targeted-20261012-2120.log`. Owner is investigating real transaction scope; focused mock green does not close this finding.

Availability evidence correction: verifier found the helper auto-releases when hits reach targetHits; targetHits=1 released on the only group query instead of holding a pause. pg_stat_activity showed COMMIT by the alleged paused observation. Earlier availability-red interpretations (including the actual-commit read) therefore do not prove a live paused transaction. Raw runs retained as harness diagnostics. Corrected barrier waits for explicit release (second-hit threshold with one participant), with 20-second safety timeout/30-second test and PID/XID/pg_locks/SQL order capture; reruns current explicit root-row FOR SHARE. Earlier claim that all four findings have valid functional repro is superseded for availability only; original source review finding still requires correct ordering verification.

Corrected availability/direct-child run now PASS 2/2: group PID15555/XID3139 holds catalog FOR SHARE; separate read during pause shows enabled=true; disable PID15570 waits on transactionid3139 until explicit release. Group commits before disable. Raw `profile-pg-lock-diagnostics-20261012-1750.log`, business-functions hash `F5A0D43E2C638FD219EBD7DAC1E99B418833A712CBF807B0785838C79A85C398` unchanged through run. Group owner now 18 focused tests, source freeze/typecheck/build and final overlap/rotation real-PG run pending.

WOC08 independent cross-check matches all 11 source hashes and re-verifies 61 vendor files. Copied isolated compiled tree passes five conformance vectors; @du package resolutions remain inside isolated temp root. Third-party NODE_PATH dependency note preserved; initial missing-zod environment attempt recorded separately. Raw `woc08-independent-crosscheck-final-20261012-1720.txt`, `woc08-independent-isolation-test-20261012-1735.txt`. Phase3 template source APPROVED; UI connector navigation P2 repair and receipt correction active.

Implementation đang chạy, chưa có independently VERIFIED/ACCEPTED task. [Transport owner receipt](reports/receipt-woc-transport.md) có 14/14 normal typed tests và SDK lint pass sau khi sửa TS2722 tại file worker của owner khác; raw log đỏ tạm thời vẫn được giữ. Owner receipts không thay independent verification. Sau canonical handoff: template conformance, independent normal build/typecheck/unit và isolated PostgreSQL/Redis fault cases, rồi read-only code review. Raw evidence phải có exact commands/cwd và source hashes cho working tree chưa commit; image/live proof ghi riêng nếu chạy.

[Backend owner receipt](reports/receipt-woc-backend.md) bàn giao 7 suites/67 tests pass và build/typecheck pass. Full contracts có 5 failures; full orchestrator unit đã bị dừng sau failures/timeouts, không có full-suite verdict. SDK checkpoint mới có 8 focused suites/168 tests và typecheck pass; full-suite receipt còn chờ. Không dùng các kết quả này để ghi VERIFIED.

## Điều chỉnh theo yêu cầu business/profile/connector

### Final publish checkpoint (supersedes earlier pending evidence)

Final rotation repair is source APPROVED at dispatcher `CEC786D147913B598A347F8159FCEBC352DF9FE13C0C525CB6B84749FE687327` and focused-test `A8AD929C1FA035B32D9B6209E51E4DF0E0DFB073E54F8782F31E4206A186329C`. Owner 22/22, typecheck/build pass. Independent final PostgreSQL run is 8/8 including blocked-key/new-membership rejection, actual group K1→K2 save, rotation retry and readable group GET/rollback without resurrected membership. Verifier receipt/raw contain exact snapshots and backend blocking evidence. Earlier pending statuses in this document are historical and superseded by this final checkpoint.

Independent runtime PostgreSQL/Redis run now passes 3/3, including concurrent sweep replacement of a missing delivery with one durable replacement ID. Profile targeted PostgreSQL run passes 7/7 at the prior freeze; the scoped settings integration fixture passes 12/12 after assigning a separate test API key and adding dedicated-database/owned-schema guards. These are bounded results, not production readiness.

Template independent isolated conformance passes 5/5 and matches all 11 selected source hashes / 61 vendor files. Corrected UI connector links pass actual browser clicks against the built SPA with a mock API, and read-only UI source review approves the narrow repair. Baseline comparison reproduces the 26 full-UI failures and five contracts failures on the baseline; SDK snapshot case passes on both trees, while the RSS case remains hash-only and has no behavioral attribution. The isolated baseline archive was safely removed without deleting junction targets.

Final source reviewer closes the prior publish/rollback and retained-membership P1s, but finds a new rotation membership-expansion race; see [phase4 review](reports/review-woc-phase4-2026-10-12.md). `/root/profile_groups_backend` owns dispatcher-only repair plus focused regression; `/root/verify_worker_orchestrator` owns an independent real-PG barrier case. Core/template/UI approvals remain; profile acceptance awaits this repair and re-review.

User requested commit and push. `/root/git_publish` (gpt-6-luna max, fork none) owns Git inventory, secret/generated checks and eventual normal commit/push after coordinator GO. The remote branch has one new commit; integrate it normally and validate affected overlap before publishing. Preserve unrelated preexisting untracked receipt. Disposable verification containers remain owned and retained until final tests/review finish, then must be cleaned by the executor with exact ownership checks.

Audit read-only xác nhận queue business+exact-version và Connector screen/service boundary đã có. Gap được thêm tại canonical plan §9: SDK self-registration, concurrent first registration/catalog root, logical business-enable, profile nhiều business/function, manifest-derived Document Core endpoint catalog và UI version→workers/intake. Không bỏ unique active-version default index và không mở public listener mới cho worker.

Primary đã giao backend follow-up WOC-09/10 phần registry/enable/counter (migration 0066); SDK startup đã bàn giao packet riêng sau core handoff và DTO agreement: 7 suites/140 tests + typecheck pass, full run incomplete với failures ghi receipt. Read-only design xác nhận additive aggregate container với legacy child bindings/public resolution giữ nguyên; profile_groups_backend nhận migration 0067, group API/functions catalog. UI writer đã nhận agreed DTO và đang thực thi. Template và independent tests sẽ nhận lease sau source freeze phù hợp.

Auth limitation có điều kiện: source worker-identity hiện reject cùng token trong nhiều business mappings hoặc reserved credentials; replicas cùng business vẫn có thể dùng chung một mapping/token. Chưa xác nhận cấu hình thực tế bị reject. Yêu cầu giữ thiết kế shared key được tôn trọng bằng việc không sửa key/config/helper validation; không tạo auth scheme hoặc âm thầm tuyên bố across-business shared-key acceptance đạt.

Design handoff xác nhận same runtimeToken gọi existing PUT registration, route thêm existing scoped-business authorization nếu helper resolve được business. Heartbeat manifestDigest additive optional: explicit digest phải khớp registry/task pin; absent legacy digest vẫn đối chiếu registered instance version + immutable server registry digest, không silently phá old-SDK admission. SDK startupSignal optional chỉ dùng hủy startup, không là credential mới. Core SDK receipt [receipt-woc-sdk.md](reports/receipt-woc-sdk.md) giữ raw full-suite failures/incomplete run; focused pass không thay full verdict.
