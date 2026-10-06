# Kiểm chứng snapshot trước repo migration

Tool này chỉ đọc inventory PLAT-MIG-00 và hash source trên đĩa. Không copy/move/delete source, không dùng HEAD thay working tree, không tạo repo candidate hoặc flip gate RPK-00.

Từ `du-rework/`:

```powershell
node tools/repo-migration/verify-inventory.test.cjs
node tools/repo-migration/verify-inventory.cjs D:/Git/dugate coordination/reports/plat-mig-00-export-inventory-2026-10-05.tsv coordination/reports/new-snapshot-audit.json
```

Report phải là file mới trong workspace. `SNAPSHOT_MATCH` chỉ chứng minh các file product đã liệt kê khớp hash, không chứng minh inventory đầy đủ hay source ACCEPTED. Source untracked vẫn được kiểm; môi trường/keys, logs, generated output và history không được đưa vào allowlist. `.env.example` cũng bị loại, cần source example đã sanitize được reviewer chấp thuận trước export.

Nếu file drift, refresh inventory qua owner PLAT-MIG-00 và review candidate mới; không đổi expected hash để che mất thay đổi. Worker/Platform repo extraction phải được cấp scope theo plan hoặc chỉ thị người dùng mới và kiểm completeness/producer-consumer riêng.
