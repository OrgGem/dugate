
#### Bổ sung — ledger tự sửa (self-report)
- Khi verify ledger sau cycle 17, phát hiện **row 16 bị nhân đôi**: một dòng cũ (số liệu
  385/385, do dùng "StorageEnvelope/ArtifactEncryptionRecord" — tên schema đã bị đổi ở
  bản cuối) còn sót từ cycle 16, cạnh dòng mới. Đã xoá dòng cũ, giữ dòng đúng.
  Ledger giờ: 17 dòng, tuần tự 1..17, verify bằng script đếm trong ĐÚNG section
  `## Ledger` (không đếm toàn file — bullet `- 9 test mới:` ở Mục 9 cũng khớp regex
  `- <digit> ` và làm đếm sai).
- Nguyên nhân: script verify của cycle 16 dùng regex `/^- \d+ —/` viết trong exec;
  backslash bị mất nên regex thành ký tự lạ và luôn trả 0 dòng — tôi đã đọc "0" là
  "không có vấn đề" thay vì để ý mâu thuẫn với việc vừa thêm dòng. Cùng họ với
  bẫy `\d` mất backslash đã ghi ở memory; nay có bằng chứng nó làm hỏng CẢ verify.
