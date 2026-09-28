
## 14 — CYCLE 14: W-VAULT-06-DELTA31 (fixture f3 sends the binding the route requires)

#### Bối cảnh + kiểm chứng chẩn đoán của packet (TRƯỚC khi sửa)
- Packet W-VAULT-06-DELTA31 (task_52ef79278fe6, dispatch ctx_ae5178a4b764) nói: đỏ
  ở connector-revision-http-offline.functional.test.ts do typo 'vault-kv-v2' ở
  341/355, sửa thành 'vault-kv2' là khớp check dòng 202 và 8/8 xanh.
- READ-ONLY probe bác bỏ ngay tầng hợp đồng: packages/contracts/src/vault.ts:170-191
  định nghĩa 'vault-kv-v2' là READ ALIAS có chủ đích cho snapshot VAULT-05, và
  ConnectorCredentialSourceSchema.transform canonicalize nó về 'vault-kv2'.
  parseCredentialSource (connector/src/vault/resolver.ts:48-49) dùng đúng schema đó.
- Probe trên artifact THẬT mà test require (connector/dist/vault/resolver.js, dist
  mtime 2026-09-26T18:25 fresh hơn src): parseCredentialSource({kind:'vault-kv-v2',
  ...}) -> OK, kind trả về = 'vault-kv2'. Không throw. Nên check dòng 202
  (source.kind !== 'vault-kv2') vốn ĐÃ pass sẵn với alias.
- Nguyên nhân thật đọc từ route: services/connector/src/http/server.ts:195-208 —
  POST /connectors/:id/revisions CHẶN trước mọi parse nếu body thiếu tenantId hoặc
  accountId (typeof !== 'string') => ConnectorError INVALID_INPUT => 400. Test gọi
  raw POST chỉ với { credentialSource } nên nhận 400, .json() không có field
  revision => expect(stranded.revision).toBe(2) nhận undefined. Đây là rot của
  fixture lane mình (f3, cycle 8, SHA pristine 012183af/18537) sau khi route mang
  binding bắt buộc (W-VAULT01-BIND-1R) — không phải lỗi lane khác.

#### Thực nghiệm có kiểm soát (mỗi bước một biến, revert byte-exact giữa bước)
- Baseline pristine: Tests: 1 failed, 7 passed — Exit Code: 1.
- A = đúng thay đổi packet (341/355 'vault-kv-v2' -> 'vault-kv2', không thêm gì):
  1 failed, 7 passed — Exit Code: 1. => CHẨN ĐOÁN CỦA PACKET BÁC BỎ bằng chạy thật,
  không bằng lý luận. Revert: SHA khớp 012183af/18537 byte-exact.
- B = chỉ thêm tenantId:'tenant-a', accountId:'du-conn-openai-main' vào hai body
  (giữ nguyên alias): 8 passed, 8 total — Exit Code: 0. => ĐÓ là root cause.
- A+B = trạng thái chốt (sửa đúng 2 dòng packet chỉ định, theo cả hướng canonical
  write lẫn binding): 8/8 — Exit Code: 0, ba lượt liên tiếp (run1/run2/run3).
- Full unit offline SAU sửa: Test Suites: 1 skipped, 74 passed, 74 of 75 total;
  Tests: 28 skipped, 1789 passed, 1817 total — 0 failed. Typecheck
  (pnpm run typecheck / tsc --noEmit -p tsconfig.json) Exit Code: 0.
- Δ31 trong Mục 13 ĐÓNG. Không sửa source sản phẩm, không sửa contracts, không
  migration, không window DB/Redis/S3, không commit/push.
- File chốt: tests/connector-revision-http-offline.functional.test.ts
  671603bf/18645/398 dòng (từ 012183af/18537; +108 bytes, số dòng không đổi).
- Ghi nhận cross-lane: 3 suite Δ29 (Admin) ĐÃ được lane Admin align lúc
  07:29:49Z / 07:29:21Z / 07:30:23Z — verified by CONTENT, không đoán: conformance
  giờ assert "COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)" và
  params NOT toContain sentinel; pagination parser:1743 nhận cả literal lẫn dạng
  legacy $n; BOUNDARY_RE:168 accepts the inline form. Full 74/74 xanh là vì vậy.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ32 — test 'invalid credential source at the HTTP edge' (dòng 377-383) là test
  ĐỎ VÌ LÝ DO SAI (vacuous): nó POST kind alias + path '../etc' nhưng cũng không gửi
  tenantId/accountId, nên 400 đến từ chặn binding (http/server.ts:195-208) TRƯỚC khi
  parseCredentialSource (:211) kịp chạy — ràng buộc path '../etc' chưa từng được
  thực thi ở route này. Đã ĐO chứ không suy: thêm binding vào đúng body đó => vẫn
  8/8 Exit Code: 0, tức 400 lúc đó mới thật sự đến từ vaultKv2Refine. Lane KHÔNG sửa
  vì packet chỉ định dòng 341/355. Đề xuất: hoặc cho lane này mở 1 dòng, hoặc giao
  Ai-That-Owns-Vault-Edge. Lưu ý đây là覆盖面 assertion an toàn (path traversal) nên
  không nên để trạng thái vacuous thêm nhiều cycle.
- Δ33 — hai chi tiết packet lệch source: (a) 'buildManagement check tại dòng 202'
  là `source.kind !== 'vault-kv2'` chạy SAU normalization, nên nó không phải chỗ
  'khớp' mà alias rớt; (b) packet không nhắc dòng 379 dù cùng dùng 'vault-kv-v2'.
  Lane vẫn đổi 341/355 sang 'vault-kv2' vì contracts ghi rõ new WRITES dùng
  'vault-kv2' (alias chỉ để READ snapshot cũ) — hướng đúng, nhưng không phải
  nguyên nhân; bằng chứng là cột A ở bảng thực nghiệm.
- Δ34 — cập nhật cho Mục 13: Δ29 (14 test Admin) đã được closure bởi lane Admin
  trước cycle này; lane không đụng file Admin nào trong cycle 14.

#### Tự phân loại 4 tầng
- SPECIFIED: packet rõ ràng về file/dòng/acceptance, nhưng nguyên nhân đưa ra sai.
- IMPLEMENTED: fixture 341/355 gửi đủ independent binding + dùng kind canonical.
- VERIFIED (offline): 8/8 x3 literal Exit Code: 0; full 74/74 suites + 1789 test
  xanh, 0 failed; typecheck 0; A/B isolation chứng minh nguyên nhân; revert
  byte-exact đã kiểm bằng SHA; không để lại probe residue (dòng 379 đã restore,
  alias_remaining=1 đúng pristine).
- ACCEPTED: không thuộc quyền lane. Δ31 đóng ở mức bằng chứng; Δ32 (test vacuous)
  cần adjudicate. Gate live của VAULT-06 (nếu có) vẫn thuộc Tester window.
