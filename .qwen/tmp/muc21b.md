
#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ48 — chỉ SỬA phía document-core + test. Phía Connector không được sửa (ngoài
  scope của task này): hiện connector nhận `artifacts: [{artifactId}]` nhưng chưa
  được chứng minh là nó FETCH ĐƯỢC artifact đó và truyền bytes thật cho provider.
  Spec yêu cầu "Connector/provider fixture xác nhận đúng bytes/hash/MIME,
  tenant/grant/size/timeout/foreign denial" — phần đó thuộc lane Connector.
  Với phía tôi đã chứng minh: worker gửi đúng reference, và bytes sau reference
  khớp digest/MIME (test ingest-wire).
- Δ49 — chưa có test live multi-container với file scan + handwriting thật (spec yêu
  cầu). Các test ở đây là unit với PNG 1x1 hợp lệ; chứng minh end-to-end qua
  grant thật + provider thật cần DB/Redis/S3/connector thật ⇒ thuộc ENC-INT-01/
  P5-04 window, không phải offline gate.
- Δ50 — `all-variants-e2e`/`corpus-regression`/`ingest.test.ts` vừa được sửa để
  dùng artifact thật. Đây là các test từng "chứng minh" OCR/digitize chạy được mà
  không có tài liệu nào; sửa chúng là điều spec yêu cầu, nhưng cần Reviewer xác
  nhận vì nó thay đổi hành vi của 3 file test thuộc traceability matrix.
- Δ51 — `hasBuffer` vẫn còn trong một COMMENT tại ingest/index.ts:206 (giải thích vì
  sao bỏ nó). Không còn call site thực thi nào dùng `hasBuffer`.

#### Tự phân loại 4 tầng
- SPECIFIED: rõ — truyền nội dung thật qua artifact reference/protocol đã freeze.
- IMPLEMENTED: 1 file src + 1 test mới + 3 test cũ cập nhật (PNG thật thay placeholder).
- VERIFIED (offline): tsc 0; 5 targeted suite 88/88; FULL 45/45 537/537 Exit 0; 2
  mutation probe đúng từng nhánh + restore byte-exact.
- ACCEPTED: không thuộc quyền lane. P5-04/P5-10 "đã truyền tài liệu" chỉ đóng được
  khi Δ48 (connector fetch + verify bytes ở phía provider) và Δ49 (live multi-container
  với scan/handwriting thật) hoàn tất. Offline unit chỉ chứng minh phía worker.
