# Review bảo mật orchestrator — 2026-10-11

## Kết luận

Phát hiện **4 vấn đề mức High / P1** trong mã hiện tại: đọc dữ liệu vượt tenant qua admin legacy, gửi credential nguồn đến origin chưa được duyệt, bỏ sót mã hóa ở luồng source ingestion, và response HTTP 204 làm tiến trình Node thoát.

**Chưa nên chấp nhận bản mã này cho production nhiều tenant hoặc dữ liệu thật trước khi xử lý các vấn đề trên.** Đây là kết luận về working tree được review; chưa xác minh chúng có trong image đang triển khai.

Các kiểm soát nền đã có nhiều điểm tốt: tách listener public/internal, RBAC theo tenant ở API/BFF, xác thực worker theo business, DNS pinning cho egress và mã hóa có AAD. Những sai lệch ở đường gọi legacy và bootstrap khiến các kiểm soát này chưa bao phủ toàn bộ luồng.

## Phạm vi và phương pháp

- Repository: `D:/Git/dugate`; phạm vi chính: `du-rework/orchestrator`.
- HEAD nền: `d0b22104e3f9fcda095bc75c9588fac8afac38f3`.
- Review **mã trong working tree**, bao gồm nhiều thay đổi chưa commit; HEAD không đại diện cho toàn bộ mã được đọc.
- Đọc các đường ingress, public/admin/runtime API, admin shell/BFF, OIDC/session, source acquisition, egress, storage/encryption, webhook và cấu hình Compose/EKS liên quan.
- Dùng bốn probe cô lập trên source TypeScript hiện tại với session, credential và tài liệu giả; S3 sender/data fetcher được thay bằng dependency giả. Probe crash chạy trong tiến trình Node riêng, upstream chỉ là loopback.
- Node: `v24.21.0`. Không sử dụng dữ liệu hay secret thật, không ghi vào PostgreSQL/Redis/S3/Vault production.
- Không chạy bộ Jest đầy đủ, build, audit CVE/dependency hoặc pentest deployment. Chưa kiểm tra trạng thái ingress, NetworkPolicy, Vault policy và bucket policy thực tế.
- Chỉ thêm báo cáo và metadata bằng chứng; không sửa mã sản phẩm, test, cấu hình hoặc trạng thái kế hoạch.

[Bằng chứng probe và SHA-256 của các source chính](./orchestrator-security-review-2026-10-11.evidence.json).

High / P1 nghĩa là cần ưu tiên xử lý trước khi chấp nhận production trong điều kiện nêu ở từng finding. Không gán CVSS khi chưa xác minh môi trường triển khai.

## SEC-OR-20261011-01 — High: Admin legacy dùng quyền platform cho session operator/viewer

**Vị trí chính**

- [auth-dispatch.ts:293](../../orchestrator/services/orchestrator/src/app/admin/auth-dispatch.ts:293): chuyển session thành claims chỉ giữ role, mất tenant/identity.
- [section-dispatch.ts:421](../../orchestrator/services/orchestrator/src/app/admin/section-dispatch.ts:421): operations fetcher dùng `config.adminToken`, đồng thời nhận tenant filter từ query.
- [shell-server.ts:486](../../orchestrator/services/orchestrator/src/app/admin/shell-server.ts:486): `/admin/legacy/*` vẫn đi qua renderer legacy khi mount admin web.
- [public.ts:468](../../orchestrator/services/orchestrator/src/http/routes/public.ts:468): platform bearer được phép truy vấn nhiều tenant; tenant fence đúng với tenant bearer nhưng không còn biết session gốc.

**Điều kiện và đường gọi**

1. Người dùng có session hợp lệ role `operator` của tenant A; role `viewer` cũng được vào section operations/overview theo nav guard.
2. Admin shell được cấu hình JSON upstream và platform admin token như đường nối mặc định.
3. Gọi `GET /admin/legacy/operations?tenant=<tenant-B>`, hoặc bỏ filter tenant để nhận danh sách toàn hệ thống.
4. Async router lấy session nhưng chỉ chuyển role; section resolver dùng platform token và chuyển filter người gọi.
5. Default fetcher giữ platform token, gọi JSON API; API xử lý chính xác theo quyền platform đã được shell trao cho request.

Section overview có cùng mẫu ở [section-dispatch.ts:459](../../orchestrator/services/orchestrator/src/app/admin/section-dispatch.ts:459) và dòng 480. Việc bật giao diện SPA không đóng đường legacy. BFF mới đã có principal tenant và chọn tenant bearer ở `bff/context.ts:86`, `bff/upstream.ts:67`; legacy chưa sử dụng cùng kiểm soát.

**Tác động**

Người dùng tenant có thể đọc danh sách, chi tiết operation/result của tenant khác theo đường legacy. Đây là lỗi nâng quyền đọc ở shell, có thể làm lộ nội dung và metadata tài liệu; không kết luận có nâng quyền ghi từ finding này.

**Bằng chứng**

Probe qua `createSessionStore` và `dispatchShellRequestAsync`, rồi thực thi deferred section resolver, cho kết quả:

```json
{"probe":"legacy-operator-read","role":"operator","sessionTenant":"tenant-a","status":200,"routeId":"section:operations","usesPlatformToken":true,"forwardedTenantFilter":"tenant-b"}
```

Data fetcher trong probe là dependency giả để quan sát token/filter. Việc default fetcher gửi bearer lên API và API bỏ tenant fence cho platform được xác minh bằng source; chưa truy vấn dữ liệu tenant thật.

**Hướng sửa**

Dùng chung session principal/RBAC với BFF cho mọi đường legacy; lấy tenant từ session, chọn credential theo tenant và từ chối session thiếu scope. Nếu đã hoàn tất cutover, đóng đường legacy dữ liệu. Chỉ kiểm tra role hoặc ẩn liên kết trên UI không đủ.

**Xác minh cần có sau sửa**

Operator A không đọc được operation/overview B qua cả đường SPA và legacy; viewer không được nhận quyền platform; bỏ filter vẫn bị SQL fence theo tenant A; platform admin giữ đúng quyền đã thiết kế.

## SEC-OR-20261011-02 — High: Mặc định warn vẫn gửi credential đến origin ngoài allowlist

**Vị trí chính**

- [ingestion-consumer.ts:180](../../orchestrator/services/orchestrator/src/modules/operations/ingestion-consumer.ts:180): biến môi trường chưa đặt mặc định `warn`.
- [acquisition-ref-resolver.ts:191](../../orchestrator/services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts:191): chỉ `enforce` mới từ chối origin không hợp lệ.
- [acquisition-ref-resolver.ts:352](../../orchestrator/services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts:352): kiểm tra xong vẫn gắn Authorization/header credential vào origin ban đầu trong chế độ warn.
- [orchestrator.yml:63](../../compose/orchestrator.yml:63): Compose cũng mặc định `warn`.

**Điều kiện và đường gọi**

Người gọi có API key/profile cho phép source acquisition sử dụng credential đã lưu; có thể chọn `sourceUrl` HTTPS đến máy chủ bên ngoài do mình kiểm soát. Ingestion resolve credential của profile, cảnh báo khi origin không thuộc allowlist nhưng vẫn tiếp tục fetch.

Bootstrap không ghi đè chế độ này. Allowlist vẫn không ngăn gửi credential trong cấu hình mặc định, kể cả allowlist đã có các origin hợp lệ khác.

**Tác động**

Secret nguồn dạng bearer hoặc header key bị gửi đến máy chủ ngoài chính sách. DNS pinning/chặn IP nội bộ không giải quyết việc gửi credential đến public HTTPS do người gọi chọn. Cross-origin redirect đã có redaction, nhưng lỗi nằm ở request đầu tiên.

**Bằng chứng**

Probe dùng credential giả, origin đã duyệt `https://approved.example`, đích `https://unapproved.example/document.pdf`:

```json
{"probe":"source-credential-origin","defaultModeAttachedToUnapprovedOrigin":true,"explicitEnforceCode":"ORIGIN_NOT_ALLOWLISTED"}
```

Không có network ra các hostname này; fetcher giả ghi nhận header. Chế độ enforce đã từ chối đúng trong cùng probe.

**Hướng sửa**

Đặt `enforce` làm mặc định cho dữ liệu thật ở source và Compose; yêu cầu origin policy hợp lệ trước khi gửi credential. Warn-only chỉ nên là ngoại lệ chuyển đổi có phạm vi, thời hạn rõ ràng. Có thể giảm ngay rủi ro bằng `DU_SOURCE_CREDENTIAL_ORIGIN_MODE=enforce` sau khi khai báo đủ approved origins.

**Xác minh cần có sau sửa**

Origin ngoài allowlist hoặc policy thiếu đều bị từ chối trước khi truyền secret; credential chỉ tới origin đã duyệt; redirect sang origin khác tiếp tục bỏ credential.

## SEC-OR-20261011-03 — High: Bootstrap source ingestion bỏ qua writer mã hóa

**Vị trí chính**

- [create-app.ts:656](../../orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:656): composition thực tế dùng `createS3PinnedSourceStorage`.
- [ingestion-consumer.ts:634](../../orchestrator/services/orchestrator/src/modules/operations/ingestion-consumer.ts:634): chỉ bật encrypted wrapper khi `requireEncryptedSourceWrites` được truyền; bootstrap không truyền flag.
- [ingestion-storage-s3.ts:722](../../orchestrator/services/orchestrator/src/modules/operations/ingestion-storage-s3.ts:722): writer này yield nguyên chunk vào PutObject.
- [boot-options.ts:40](../../orchestrator/services/orchestrator/src/modules/encryption/boot-options.ts:40): chính sách real-data yêu cầu mã hóa persistence của mọi producer.

**Điều kiện và đường gọi**

Ứng dụng chạy storage S3, bật source ingestion từ URL hoặc IAM S3, kể cả khi encryption/Vault và chế độ dữ liệu thật đã được cấu hình. Consumer dùng writer lịch sử; writer mã hóa `createS3EncryptedPinnedSourceStorage` đã tồn tại nhưng không được nối vào bootstrap.

**Tác động**

Tài liệu source được đưa vào S3 dưới dạng nguyên nội dung từ ứng dụng, thiếu Vault envelope/marker/manifest. Quyền đọc object có thể vượt lớp bảo vệ ứng dụng đã dự kiến. Ngoài ra strict reader được cấu hình yêu cầu mã hóa có thể từ chối object này, làm hỏng luồng xử lý.

Bucket có thể có server-side encryption; review không khẳng định mã hóa tại S3 hoặc đĩa đã bị tắt. Finding là thiếu **mã hóa envelope tại ứng dụng**, với ranh giới khóa/quyền khác với S3 SSE.

**Bằng chứng**

Probe writer thật với S3 sender giả đọc PutObject.Body:

```json
{"probe":"ingestion-storage-writer","storedExactlyPlaintext":true,"hasEncryptedWrite":false}
```

Wiring được kiểm tra tĩnh: bootstrap gọi đúng writer này, không truyền flag yêu cầu mã hóa. Chưa chạy một ca ingest end-to-end qua S3/Vault thật.

**Hướng sửa**

Nối encrypted source writer với cùng crypto facade/key reference của artifact pipeline; truyền yêu cầu mã hóa từ policy real-data và từ chối boot khi thiếu capability. Không để writer lịch sử là fallback khi policy yêu cầu mã hóa. Cần kiểm kê source object đã ghi bằng đường này nếu deployment có sử dụng.

**Xác minh cần có sau sửa**

Cả URL và IAM S3 ingestion tạo sealed object với context tenant/artifact/version đúng; manifest/marker tồn tại; strict reader đọc được; lỗi provider không sinh object plaintext; synthetic exemption chỉ áp dụng đúng cấu hình được duyệt.

## SEC-OR-20261011-04 — High: HTTP 204 từ upstream làm tiến trình Node thoát

**Vị trí chính**

- [pinned-fetch.ts:351](../../orchestrator/packages/egress/src/pinned-fetch.ts:351): `fulfillResponse` luôn tạo body stream.
- [pinned-fetch.ts:355](../../orchestrator/packages/egress/src/pinned-fetch.ts:355): gọi `new Response(web, { status })` trong callback HTTP bất đồng bộ, không có try/catch chuyển exception thành Promise rejection.
- [webhooks.ts:533](../../orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts:533): transport webhook mặc định dùng pinned fetch.
- [source-acquisition.ts:201](../../orchestrator/packages/worker-sdk/src/source-acquisition.ts:201): tải source URL cũng mặc định dùng pinned fetch.

**Điều kiện và đường gọi**

Endpoint source/callback hợp lệ trả response 204. Đây có thể là response thành công thông thường của webhook, hoặc response do bên kiểm soát upstream chủ động trả. Caller không cần làm SSRF vào IP nội bộ.

Theo [Fetch Standard](https://fetch.spec.whatwg.org/#initialize-a-response), khởi tạo Response có body khác null với status không cho phép body sẽ ném TypeError. 204, 205 và 304 thuộc nhóm đó. Source hiện luôn tạo body, kể cả upstream thực tế không gửi byte nào.

Exception phát sinh ở callback của ClientRequest sau khi Promise đã được tạo; try/catch quanh `await fetch` không bắt được exception này. Không tìm thấy global uncaught-exception handler trong source production được đọc.

**Tác động**

Một response 204 có thể làm chết tiến trình orchestrator hoặc dịch vụ dùng chung thư viện egress, gây gián đoạn API và xử lý tác vụ. Supervisor restart không sửa nguyên nhân; retry có thể lặp lại lỗi.

**Bằng chứng**

Probe trong tiến trình Node riêng, loopback upstream trả 204, `await` có try/catch:

```text
{"probe":"pinned-fetch-204","runtime":"v24.21.0","upstreamStatus":204,"scope":"isolated node process, loopback only"}
TypeError: Response constructor: Invalid response status code 204
process exit code: 1
```

Nhánh catch của caller không chạy. Probe dùng allowPrivateNetworks để cho phép loopback trong tiến trình cô lập; không chứng minh hay yêu cầu bật tùy chọn đó trong production. Reachability từ webhook/source được xác minh bằng call chain tĩnh; chưa làm crash deployment đang chạy.

**Hướng sửa**

Dùng body null cho null-body status, xử lý HEAD đúng; drain/destroy stream hợp lý. Bọc đoạn dựng Response trong callback và chuyển lỗi thành reject, bảo đảm mọi lỗi transport chỉ kết thúc request/delivery.

**Xác minh cần có sau sửa**

204/205/304/HEAD không làm tiến trình thoát; 204 webhook được ghi nhận thành công; lỗi status/header/giải nén được trả về bằng rejection; timeout/abort không để socket treo.

## Đánh giá các lớp bảo vệ khác

| Lớp | Quan sát từ mã | Giới hạn |
| --- | --- | --- |
| Ingress | Public listener loại admin/runtime/internal trước khi dispatch; audience được bind ở server closure. | Phụ thuộc deployment không expose internal listener qua proxy/service sai. |
| API/tenant | Public API key và tenant admin bearer có tenant fence; BFF mới chọn credential theo principal. | Admin legacy phá ranh giới tenant ở finding 01. |
| Worker | Token runtime gắn business; có kiểm tra task/artifact ownership, tách token admin và worker. | Chưa xác minh token rotation, mạng và policy thực tế. |
| Auth/session | OIDC có signature/issuer/audience/nonce/PKCE/state; opaque session server-side, CSRF và TTL/revoke. | Xác thực đúng chưa bảo đảm mọi downstream giữ tenant principal. |
| Egress | DNS pinning đến địa chỉ đã duyệt, kiểm tra TLS hostname, chặn private/link-local và kiểm tra redirect. | Allowlist credential mặc định warn; response callback có crash path. |
| Mã hóa | Envelope/AES-GCM có AAD tenant/artifact/version, Vault roles và strict read policy. | Composition source writer chưa áp dụng encryption đầy đủ. |
| Lỗi/log | Có structured logging và nhiều đường trả lỗi theo class, redaction nội dung nhạy cảm. | Chưa audit mọi log sink, cấu hình lưu giữ hoặc log production. |

Không phát hiện thêm lỗi SQL injection/XSS có bằng chứng đủ rõ trong các đường đã xem. Điều này không thay thế audit toàn bộ repository hoặc pentest.

## Thứ tự xử lý đề xuất

1. Sửa pinned-fetch để loại crash từ response bình thường.
2. Đóng lỗ tenant ở legacy; hoàn thiện origin enforcement trước khi dùng source credential thật.
3. Nối encrypted source writer và kiểm kê tài liệu đã ghi nếu deployment dùng đường này.
4. Sau các sửa đổi, xác minh từng đường gọi thực tế và exact image/deployment; không dùng sự tồn tại của module hoặc exit code của harness để kết luận toàn hệ thống an toàn.

Nguyên tắc áp dụng cho finding 01 là kiểm tra quyền trên mọi đường request, kể cả đường cũ còn tồn tại; xem [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#validate-the-permissions-on-every-request).
