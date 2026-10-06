# Điều phối implementation-first — 2026-10-01

**Hiệu lực:** overlay thực thi cho `RV01`, `COMP`, `LOCAL`, `P9` và các parent liên quan. Tài liệu này đổi **cách phân bổ và mốc bàn giao**, không đổi public wire, security invariant, acceptance cuối hay release gate. Các snapshot roster/checkbox trước ngày này là lịch sử; trạng thái active phải kiểm tra từ terminal, Task/Dispatch và receipt hiện tại. `G-ENC`, `G-DATA`, `G-SEC`, `G-COMP`, `G-LOCAL-ADMIN`, `G-ADMIN-OPS`, `P8-08` và `G6` vẫn **NO-GO**.

## 1. Hai luồng công việc, không chờ test sâu để bắt đầu code

| Luồng | Điều kiện bàn giao | Không được suy ra |
|---|---|---|
| **Implementation** | Owner hoàn thành hành vi được giao trong file lease, tự chạy typecheck/lint và focused unit/contract smoke phù hợp, ghi diff + command/exit + giới hạn còn mở. Ghi `IMPLEMENTED`, không tick parent `[x]`. | Không phải `VERIFIED`, `ACCEPTED` hay release-ready. Không bỏ qua fail-closed, tenant fence, auth, dữ liệu thật và regression cơ bản. |
| **Detailed verification** | Tester độc lập nhận packet riêng sau khi producer/consumer chạy được; chạy golden 31 variants, ba workflow, browser journeys, fault injection, live S3/Vault/DB và cross-system comparison theo từng gate. | Không được làm hàng chờ mặc định chặn **dispatch implementation độc lập**. Test đỏ/finding HIGH vẫn chặn acceptance, merge vào release và cutover. |

Các [packet test riêng](DETAILED-BUSINESS-VERIFICATION-2026-10-01.md), không nhân đôi parent: `VFY-ENC` → `ENC-INT-01`/`RV01-01..03`; `VFY-COMP` → `COMP-10`/`RV01-04..06`; `VFY-P9` → `P9-01..05`/`RV01-06`; `VFY-LOCAL` → `LOCAL-05`/`RV01-07`; `VFY-REG` → full document-core/Worker SDK regression của `RV01-08`. Mỗi packet có owner Tester, môi trường, fixture, build digest, raw output và trạng thái riêng. Test tập trung trong implementation packet không thay packet này. Không tick parent cho tới khi test chi tiết + review `APPROVED` đầy đủ.

## 2. Phân bổ song song ngay, giới hạn bằng write path thực

| Lane implementation | Có thể bắt đầu | Write lease / ranh giới |
|---|---|---|
| `RV01-01` → `RV01-02` | Giữ owner đang làm boot crypto; giao metadata wiring ngay khi lease `server.ts` được trả, hoặc cho **cùng owner** làm tiếp nếu nhanh hơn handoff. | Một integrator sở hữu `main.ts`/`server.ts` tại một thời điểm. Không giữ lease khi idle; các owner khác xây module/adapter riêng. |
| `RV01-03` | Tiếp tục worker artifact crypto và manifest contract song song với boot. | Worker SDK, artifact/encryption modules; thay đổi shared contract qua một owner đã chỉ định. Không đợi live S3 suite để viết code. |
| `RV01-06` / `COMP-04` | Giao document-core ba variant còn thiếu và recipe/output thật; tách ba P9 workflow theo business directory nếu file không giao nhau. | Không sửa public router, `server.ts` hay OpenAPI. `COMP-00` chỉ chặn quyết định public wire, không chặn business implementation sau khi input/output interface tạm khóa. |
| `RV01-07` / `LOCAL-01/02` | Giao DB identity, password/session/auth primitives trong module và migration riêng; coordinator lấy security decision `LOCAL-00` có thời hạn. | Không mount production login hoặc đổi auth mode khi role/session/machine-token policy chưa chốt. Không dùng static token làm local user. |
| `RV01-04/05` / `COMP-02..07` | Giao decoder/serializer/operation projection trong file riêng với fixture đã biết; integrator mount public route sau khi `COMP-00` chốt URL/result/lifecycle bounds và lease `server.ts` trống. | Không đổi method/path legacy mặc định, không đưa 202 giả, không phát output plaintext khi ENC bật; OpenAPI chỉ có owner `COMP-02/11`. |

`COMP-00` và `LOCAL-00` là **decision packet**, không phải lý do để mọi agent đọc thêm source vô hạn. Coordinator tổng hợp 2–3 lựa chọn có trade-off, chỉ hỏi Product/Security về điểm chưa thể tự quyết; timebox một chu kỳ điều phối để nêu blocker cụ thể. Không tự coi im lặng là approval. Dừng characterization mới nếu nó không tháo một decision blocker hoặc không đổi một implementation packet.

## 3. Cơ sở dữ liệu và hạ tầng phát triển song song

- Nhiều agent được chạy PostgreSQL/Redis/S3/Vault **đồng thời** trên cùng máy/dịch vụ khi mỗi lane có **database riêng** (schema riêng chỉ nếu migration/search path được chứng minh), Redis DB/prefix riêng **nếu client/BullMQ thực sự hỗ trợ** (nếu không dùng Redis instance riêng), S3 bucket/prefix riêng **nếu backend cấu hình được** (nếu không dùng bucket riêng), Vault path/key test riêng và tenant/test-ID riêng. Dùng env file riêng không commit; ghi resource namespace vào packet/receipt. Migrations chạy trong database/schema của lane, không chạy trên namespace của lane khác.
- Nếu bắt buộc dùng **cùng database/schema**, chỉ cho test không phá hủy với ID/tenant duy nhất, cleanup đúng dữ liệu của mình và không đổi global config. `TRUNCATE`, reset, DDL/migration, seed global, `FLUSHDB`, bucket purge hoặc test cố ý làm chết shared service vẫn phải có lease độc quyền ngắn và xác nhận không còn process dùng resource đó.
- Tester có thể chạy live song song với owner khi namespace tách biệt; không cần chờ một DB window toàn cục. Tester phải ghi rõ namespace và không dùng dữ liệu fixture của owner khác. Chưa có isolation thì dùng focused offline smoke và ghi `VFY-*` pending, không để agent đứng chờ.
- Bộ test nghiệp vụ chi tiết chạy trên build digest đã đóng băng. Nếu code đổi sau test, chỉ re-run phần bị ảnh hưởng; không nhân bản full-suite cho mọi packet. Không dùng test trên shared DB không cô lập làm bằng chứng acceptance.

## 4. Một coordinator, một active ledger

1. **Cập nhật handoff 2026-10-02:** Command Code coordinator là **single dispatcher** theo `coordination/coordinator-state.json`; Claude Code không còn quyền dispatch (vẫn có thể nhận việc trực tiếp từ người dùng), Antigravity không tự dispatch. Không tạo scheduler/terminal điều phối thứ hai khi chưa xác minh cơ chế reuse-session và không có lịch trùng. Nhịp mục tiêu 10 phút chỉ được báo là tự động khi Orca/Task Scheduler thực sự có một lịch hoạt động.
2. Mỗi lượt: đối chiếu `orca terminal list` + Task/Dispatch + receipt; mỗi agent có tối đa một **packet thực thi active**; row cũ không có active attempt được chuyển `historical/stale` kèm bằng chứng, không xóa audit. `ready` trong registry không đồng nghĩa đang làm. Nếu terminal đã nhận prompt thủ công, ledger phải ghi `manual` và owner, tránh dispatch Orca lần hai.
3. Báo cáo ngắn theo `IMPLEMENTED / VFY pending / ACCEPTED`, file lease, decision blocker, next owner. Ưu tiên giao code cho agent idle trước khi giao khảo sát hoặc viết thêm plan. Sau ba lượt không tiến triển, đọc log thật và nudge đúng packet theo `AGENTS.md`; không suy ra stuck chỉ từ thiếu receipt.
4. Hai Codex Tester ưu tiên smoke cho diff vừa xong và chuẩn bị `VFY-*`. Command Code coordinator gọi Antigravity review UI khi một chức năng hoặc nhóm chức năng `AWEB-*` đã có build/browser evidence; Claude Code review module/backend hoặc rủi ro cao theo yêu cầu. Không dùng reviewer/coordinator để thay implementation capacity. Đóng/giải phóng lease ngay khi owner giao patch, không chờ VFY sâu.

## 5. Exit của đợt tối ưu

- Active ledger khớp terminal thật, không còn nhiều row `running` lịch sử trên cùng handle; một coordinator được xác nhận, không có lịch điều phối trùng.
- Có implementation owner cho các lane độc lập ở §2, quyết định `COMP-00`/`LOCAL-00` có owner và deadline; shared-file handoff rõ ràng.
- Mỗi lane có namespace dev hoặc ghi blocker cô lập cụ thể; focused smoke không bị chặn bởi global DB window.
- `VFY-*` được tạo riêng, chưa test thì ghi pending; release gates giữ NO-GO tới khi đủ bằng chứng.
