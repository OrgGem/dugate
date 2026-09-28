# Test catalog và acceptance gates

Đây là catalog acceptance tổng thể: một phần đã executable, phần còn lại vẫn là test design. Snapshot và mapping phase/task hiện tại nằm trong [`coordination/IMPLEMENTATION-STATUS.md`](../coordination/IMPLEMENTATION-STATUS.md). Jest/TypeScript đang phủ unit/contract và một số integration với PostgreSQL/Redis/mock provider; multi-service E2E đầy đủ, object storage, browser UI, load/soak và production drills vẫn chưa có. Mỗi task phải ghi command/result evidence khi hoàn thành.

## Catalog

| ID | Scenario | Expected result | Level |
|---|---|---|---|
| REG-01 | Register cùng version/hash hai lần | Một registry record; replay 200 | Contract/integration |
| REG-02 | Same version khác hash hoặc unknown contract | 409/422; registry không đổi | Contract |
| REG-03 | New manifest, offline worker, profile chưa cấp | Disabled mặc định; health độc lập; call bị chặn | E2E |
| REG-04 | Unauthorized business registration/handler kind | Không register/claim được | Security |
| PRF-01 | Client đổi locked prompt/model/parameter | 403/422; không enqueue | API |
| PRF-02 | Profile revise trong lúc task retry | Task dùng snapshot cũ, credential revoke vẫn hiệu lực | Integration |
| PRF-03 | Missing/incompatible connector slot | Profile publish bị từ chối | API/UI |
| OPS-01 | Concurrent submit cùng idempotency key | Một operation/root task; khác body 409 | Integration |
| OPS-02 | Crash DB commit→enqueue và enqueue→ACK | Outbox replay không mất/nhân operation | Fault |
| OPS-03 | Backpressure/admission limit | 429/503 đúng scope; không orphan runnable task | Load |
| OPS-04 | Cross-tenant operation/artifact/key spoof headers | Không đọc/claim/download được | Security |
| OPS-05 | sync window hết khi provider còn chạy | 202 same operation; không cancel | E2E |
| OPS-06 | Webhook receiver fail/replay/SSRF | Retry cùng deliveryId, signed, operation không đổi | Integration |
| RUN-01 | Hai workers claim một task | Chỉ một lease hợp lệ; duplicate delivery an toàn | Integration |
| RUN-02 | Cancel và completion đồng thời | Một thứ tự CAS hợp lệ; terminal không hồi sinh | Fault |
| RUN-03 | Worker chết, old worker report sau lease recovery | Stale report 409; retry budget không nhân | Fault |
| RUN-04 | Step output >500 chars, crash trước bước sau | Resume full output, không inference lại step success | Integration |
| RUN-05 | Concurrency=1, parent fanout rồi join | Parent nhường slot; child chạy; một continuation | E2E |
| RUN-06 | Human wait, restart, duplicate/stale resume | Một response accepted; đúng next step | E2E |
| RUN-07 | Failed child + sibling chạy + deadline | Policy all-success nhất quán; late result fenced | Fault |
| CON-01 | Same invocation request concurrent/replay | Một dispatch khi outcome biết; same ID khác hash 409 | Integration |
| CON-02 | 2 Connector replicas dùng quota chung | Aggregate không vượt rate/in-flight cap | Load |
| CON-03 | Provider nhận call rồi Connector/worker mất response | UNKNOWN/reconcile; không blind duplicate | Fault |
| CON-04 | Credential rotation/revoke, grant tamper/expired | Scope/hash checked; secret không lộ | Security |
| CON-05 | Provider malformed payload, 429, 5xx, timeout | Error taxonomy đúng; retry budget bounded | Contract |
| ART-01 | Upload/finalize/download/access ownership | MIME/size/hash/tenant verified | Integration |
| ART-02 | Artifact staging orphan, task giữ ref, TTL | Orphan xóa; active checkpoint không mất file | Integration |
| ART-03 | Zip traversal/bomb, oversized file, SSRF redirect | Bị chặn, temp files cleanup | Security |
| USE-01 | Child/parent completion và usage replay | Debit mỗi usage event một lần | Integration |
| USE-02 | Late usage sau cancel hoặc mất usage ACK | Ledger/projection hội tụ; measured/estimated rõ | Fault |
| DOC-01 | Ingest native parse/OCR/digitize/split fixtures | Expected content/artifacts và provenance | Unit/E2E |
| DOC-02 | Extract 5 variants, custom invalid schema | Schema đúng; invalid không dispatch | Unit/E2E |
| DOC-03 | Analyze 5 variants | Findings theo schema; invalid categories/criteria reject | Unit/E2E |
| DOC-04 | Transform 5 variants, unsupported format | Correct artifact/schema hoặc explicit error | Unit/E2E |
| DOC-05 | Generate 6 variants, text-only, missing questions | Defined output và validation | Unit/E2E |
| DOC-06 | Compare 3 variants, missing source/target | Evidence refs đúng; missing inputs reject | Unit/E2E |
| UI-01 | Register business mới rồi mở profile editor | Dynamic actions/fields không code branch | Browser |
| UI-02 | Secret copy-once, form conflict, human input | Redacted GET, draft giữ, resume CAS | Browser |
| EXT-01 | Deploy example-review sau platform freeze | Chạy được, platform image digests không đổi | E2E |
| VER-01 | v1 in-flight/HITL và v2 new requests, rollback | Đúng queue/version; v1 tiếp tục được | Integration |
| OPS-07 | Redis mất queue data, DB còn task | Reconcile phục hồi, no lost accepted operation | Fault |
| OPS-08 | Clean deployment, migration, backup restore | Healthy services, persisted state recovery | Deployment |

## Test design rules

- Table-driven cases cho mọi subcase, không chỉ một happy path/action. P0 làm fixture dictionary và expected results trước code.
- Mock provider có controllable latency/status/invalid JSON/async submit-poll/call counters/idempotency/unknown outcome hooks.
- Fault injection đặt ở transactional boundaries và trước/sau provider response, không chỉ random process kill.
- Assertions theo DB/runtime/public contract và actual provider call count; không chỉ BullMQ completed count.
- Tests không dùng production credential/provider trả phí. Live model evaluation opt-in, ngân sách và corpus riêng.
- Sau thay đổi contract chạy provider/consumer tests; sau UI thay đổi lưu screenshot evidence, accessibility smoke.
- Stress/soak có bounded duration và cleanup; báo hardware, versions, concurrency, input distribution và failure counts.

## Gates

G0: scope, variants, assumptions và cases traceable.

G1: contracts compile/validate, schemas/API descriptions/lint compatible; queue/runtime algorithm spike pass.

G2: registry→profile→mock task→operation vertical slice với fault replay pass.

G3: connector+SDK safety tests pass; không cần real LLM.

G4: sáu action + UI + 28 variant matrix pass.

G5: extension, HITL/fanout/versioning/no-platform-rebuild pass.

G6: reliability/security/load/deployment evidence đạt target đã ghi; remaining risks có owner.
