# VFY-PM-M02-INGRESS — 2026-10-06

## Kết luận

**Chưa đạt acceptance toàn phần.** Lượt đầu phát hiện hai lỗi IF-06 cleanup; sau rollback fix của qwen_1, verifier chạy lại harness live ba lần liên tiếp và cả 8/8 assertion đều pass, bao gồm hai ca bind/remount failure. IF-04 và IF-05 vẫn mới được kiểm tra một phần; các phần còn lại được nêu rõ bên dưới, không tính là pass.

Không sửa product source hoặc Compose, không commit. Harness kiểm chứng riêng của tester có một chỉnh sửa test-only sau lần chạy đầu: IF-03 giờ chấp nhận phản hồi 404 thông thường cho alias path mà router không chuẩn hóa thành protected path, trong khi exact protected paths vẫn bắt buộc problem 404; lần chạy đầu bị đỏ do assertion harness quá hẹp. Lần chạy cuối được ghi ở attempt3.

## Môi trường và snapshot

- Repo: `D:\Git\dugate`; package: `du-rework/services/orchestrator`; HEAD: `b088eec`.
- Live tests dùng PostgreSQL 16.11 (`du_orchestrator_test`, loopback `127.0.0.1:5433`) và Redis 7 (loopback `127.0.0.1:6380`). Route fence suite dùng schema riêng `pmm02_vfy_1ade3421d7ef4d049cbafbf137343628` và Redis DB 12; schema đã được drop sau test, không còn schema theo prefix kiểm thử. Harness tạo credential ngẫu nhiên cho test; không dùng dịch vụ/key production.
- Các file source/Compose dưới đây là snapshot mà verifier đọc; shared worktree đã có thay đổi từ các lane triển khai, nên hash là nhận dạng snapshot chứ không phải khẳng định chúng sạch so với HEAD.

| File | SHA-256 |
|---|---|
| `services/orchestrator/src/http/ingress-guard.ts` | `814F46633FC0C3B7C0A435DA487BA24199ED9B0AB97CE78C06A715459394F446` |
| `services/orchestrator/src/app/bootstrap/create-app.ts` | `B55BEB9A4AD3394903C0C7455679EA95E8B7F3AB7848C3B86BA527BB22D94520` |
| `services/orchestrator/src/main.ts` | `B894EBC7C2F149DDE0E97D41E749CABE408A82CAB5109AC7AEF0189DD45E28B9` |
| `services/orchestrator/src/server.ts` | `7EC07CB29840FEC9801437B1A8E9A04EBA905082B10A23C67F0E1BBE34219AC7` |
| `services/orchestrator/tests/pm-m02-ingress-fence.test.ts` | `2853D362F6B76F12EB428131EE4F3BE98F514894BAB9792834E9E1A2D4D1842D` |
| `services/orchestrator/tests/pm-m02-ingress-verification.test.ts` | `E13CCB796E2D897C6CF2A2D15829F7819F8CBBF6B61ADBA89FA9ABA78ADED6C8` |
| `compose/orchestrator.yml` | `2DBA358D954E1BDD4FDD14086EA426BDEF338B440AB31DCF26F099753B8F4906` |
| `compose/connector.yml` | `B84C8F7105149B7622DBD61738451C76D520EC95AA7ED1172F999DF85111117E` |
| `compose/local-debug.yml` | `7EB32FB49D3683305ABE893510B9F3CA7B0F40B06C87F3BB701925A1A2DA60BC` |
| `compose/document-core.yml` | `16161604F8055055D109412D7421B23E96667D1705CF59DD68A7D706B545F822` |
| `compose/lc-checker.yml` | `ADFCA389BA3312AD3FAFDBCCCF46E4901ADB6E50D40780575EA9104D6F697178` |
| `compose/example-review.yml` | `26586587850341844911BEEC0585DB991272233325E7E25A1CD92714585E805F` |

## Kết quả IF-01..IF-06

| IF | Kết quả | Bằng chứng độc lập / giới hạn |
|---|---|---|
| IF-01 | **PASS** | Harness gọi public listener thật trên ma trận protected path (runtime, admin, internal; exact/descendant), 5 methods GET/POST/PUT/DELETE/OPTIONS và 4 tình trạng credential (absent, invalid, runtime-valid, admin-valid). Protected requests bị từ chối bằng 404; health/public control được kiểm tra. Route-owner live suite cũng pass 11/11. |
| IF-02 | **PASS** | Gửi runtime blob PUT với chunked body vẫn mở; public listener trả lời trước khi client kết thúc body. Harness xác nhận không có `db.query`, queue access (`getQueue`) hay `global fetch` phát sinh từ request đó. Guard ở `create-app.ts` chạy sau URL parse và trước body reader/route work. |
| IF-03 | **PASS** | Host, Forwarded, X-Forwarded-Host/For/Proto/Port và X-Ingress-Audience không chọn được internal dispatch. Exact protected paths giữ generic problem 404; alias/encoded/dot/repeated/trailing variants chỉ cho generic route/guard 404 hoặc controlled 400; malformed absolute target trả 400. Không quan sát bypass. |
| IF-04 | **PARTIAL** | Internal listener với platform runtime token hợp lệ trả 200 ở heartbeat; token sai trả 401. Admin credential hợp lệ truy cập được admin audit control trên internal. Chưa chạy các identity/route đầy đủ của spec: business claim/get/cancel/artifact, usage identity, wrong-business/tenant và chứng minh admin bearer không cấp worker authority. |
| IF-05 | **PARTIAL** | 2 BFF suites pass 13/13 cho operations/security. Static inspection xác nhận finite route allowlist, session/RBAC/tenant/CSRF checks và JSON base URL được tạo từ địa chỉ internal listener thực tế. Chưa chạy end-to-end Portal session/CSRF qua BFF đến internal operations/usage/admin; PM-M03 readiness zero-outbound và signed Connector management flow cũng chưa được xác minh trong lượt này. |
| IF-06 | **PASS sau re-verify** | Lượt đầu trước fix fail ở hai startup rollback. Sau fix qwen_1, ba lần chạy live đều pass; JSON assertion report xác nhận happy path, internal bind failure và shell remount failure đều pass, hai socket được đóng sau startup failure. Xem mục re-verify ở cuối receipt. |

### Chi tiết IF-06 thất bại ở lượt trước fix (lịch sử)

Harness `tests/pm-m02-ingress-verification.test.ts` dùng EADDRINUSE được dựng có chủ ý và kiểm tra listener state ngay sau khi `listen()` thất bại, trước `finally` cleanup của test:

1. Lỗi bind listener thứ hai: expected `{ publicListening: false, internalListening: false }`, actual `{ publicListening: true, internalListening: false }`.
2. Lỗi remount Admin shell: expected `{ publicListening: false, internalListening: false }`, actual `{ publicListening: true, internalListening: true }`.

Test `finally` sau đó gọi `app.close()` để dọn tài nguyên của harness; việc cleanup muộn này không làm thay đổi kết quả quan sát lúc startup trả lỗi. Đây là lỗi startup rollback trên snapshot trước fix. Re-verify sau fix được ghi ở cuối receipt và xác nhận cả hai rollback assertions pass.

## Lệnh và literal kết quả

Tất cả lệnh Jest chạy từ `du-rework` qua pnpm workspace:

- `pnpm --filter @du/orchestrator exec jest --runInBand tests/pm-m02-ingress-verification.test.ts` với `DU_LIVE_INFRA=1`, `DU_PM_M02_INGRESS_VERIFY=1`, PostgreSQL và Redis loopback ở trên. Attempt cuối: `Test Suites: 1 failed, 1 total`; `Tests: 2 failed, 6 passed, 8 total`; Jest exit **1**. Raw: `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-attempt3.log`.
- `pnpm --filter @du/orchestrator exec jest --runInBand tests/pm-m02-ingress-fence.test.ts` với `DU_LIVE_INFRA=1` và isolated PG schema/Redis DB. `Test Suites: 1 passed, 1 total`; `Tests: 11 passed, 11 total`; exit **0**. Raw: `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-fence.log`.
- `pnpm --filter @du/orchestrator exec jest --runInBand tests/aweb06-bff-operations.test.ts tests/aweb07-bff-security.test.ts`. `Test Suites: 2 passed, 2 total`; `Tests: 13 passed, 13 total`; exit **0**. Raw: `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-bff.log`.
- `pnpm --filter @du/orchestrator typecheck` (`tsc --noEmit -p tsconfig.json`): exit **0**, no diagnostics. Raw: `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-typecheck.log`.
- Compose config-only render with sanitized test env: default and debug overlay each exit **0**. Default resolved Orchestrator host mappings to 3000/3001 only, Connector had none, and all three worker `RUNTIME_URL`s targeted `http://orchestrator:3002/api/runtime/v1`; debug overlay added loopback-only 13002→3002 and 18080→8080. No Compose containers were started. Raw summary: `coordination/reports/raw-vfy-pm-m02-compose-2026-10-06-summary.log`.

The initial harness attempt also exposed an overly strict IF-03 assertion for an unnormalized alias path; after correcting that tester-only assertion, attempt2 and attempt3 both retained exactly the two IF-06 cleanup failures. Attempt1 raw output is retained at `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-attempt1.log`; attempt2 at `...attempt2.log`.

## Trạng thái live và việc còn mở

Offline/live-local evidence: listener HTTP matrix, body-order probe, header spoof cases, BFF unit suites, typecheck, and Compose effective-config rendering ran in this environment. Not verified here: complete IF-04 identity matrix, live Portal-to-BFF flow and PM-M03 readiness, actual deployment/reverse-proxy/firewall behavior, and IF-08 combined worker/Connector/runtime stack. No claim is made that the owner receipts' 45/45 suite total closes these gaps. PM-M02 remains **open** because partial/live-only IF-04/IF-05 requirements, IF-08 and deployment verification are still outstanding; current IF-06 rollback re-verification passes.

## Re-verify IF-06 after qwen_1 rollback cleanup — 2026-10-06

Re-ran the requested live harness after `coordination/reports/if-06-startup-rollback-cleanup-2026-10-06.md`. PostgreSQL 16.11 and Redis 7 loopback endpoints were reachable; both harness gates were set to `1`. No source or test file was changed during this re-verification.

| Invocation | Literal result | Evidence |
|---|---|---|
| `pnpm --filter @du/orchestrator exec jest --runInBand tests/pm-m02-ingress-verification.test.ts` | 1 suite passed; 8 passed, 0 failed; exit **0** | `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-attempt4.log` |
| Same suite with `--verbose` | 1 suite passed; 8 passed, 0 failed; exit **0** | `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-verbose.log` |
| Same suite with `--json --outputFile=.../vfy-pm-m02-ingress-2026-10-06-jest.json` | 1 suite passed; 8 passed, 0 failed; exit **0**; JSON `success=true`, `numPassedTests=8`, `numFailedTests=0` | `coordination/reports/raw-vfy-pm-m02-ingress-2026-10-06-json.log` and `coordination/reports/vfy-pm-m02-ingress-2026-10-06-jest.json` |

The assertion-level JSON lists both rollback tests as `passed`:

- `IF-06 failure cleanup: a failed second listener bind preserves EADDRINUSE and closes the first listener`
- `IF-06 failure cleanup: a failed shell remount closes both JSON listeners and preserves EADDRINUSE`

The original EADDRINUSE remains the surfaced startup error while the listener cleanup assertions pass. `create-app.ts` current SHA-256: `FF717BE202BF63B21E1AAB6FCEB785ACD28AB2FD7BE8DDB0725074DB42372AED`; independent harness SHA-256 remains `E13CCB796E2D897C6CF2A2D15829F7819F8CBBF6B61ADBA89FA9ABA78ADED6C8`. JSON result SHA-256: `97EC66558710E1F4AF1A5C75F27DFD0C952E4F3525EFA1D8710D1233755DDB44`.

**Current IF-06 disposition: PASS on the post-fix snapshot.** Overall PM-M02 acceptance remains open because IF-04 and IF-05 have the partial coverage documented above; this rerun does not cover IF-08 or a deployed live stack.

