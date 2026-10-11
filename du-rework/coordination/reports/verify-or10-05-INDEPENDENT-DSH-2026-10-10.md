# Verify độc lập (DSH) — OR10-05 artifact download route decode segment — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY trên `src/http/routes/runtime.ts` và `tests/or10-05-artifact-download-route.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-or10-05-2026-10-10/DSH/` (`or10-05.log`, `tsc.log`).

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-05-artifact-download-route.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 3 passed, 3 total` |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |

Suite 1 file / 3 test, không FAIL, không skip. `runtime.ts` sha256 (16 ký tự đầu) = `549e1d967a5b24d8`.

## 2. Logic decode trong route (đọc trực tiếp)

- Route khớp **đúng một segment**: `src/http/routes/runtime.ts:272` — `/^\/api\/runtime\/v1\/artifacts\/blob\/([^/]+)$/`; `[^/]+` nghĩa là `%2F` phải được mã hoá trong URL chứ không thể tạo thêm cấp đường dẫn.
- Decode **một lần duy nhất, có bọc lỗi**: `:275-281`
  - `:276-277` comment nêu rõ ý định: blob URL mã hoá **toàn bộ** storage key trong một segment, **decode once** rồi giữ nguyên giá trị đó cho mọi thao tác storage/decrypt;
  - `:278` `storageKey = decodeURIComponent(m[1]!);`
  - `:279-280` catch → `throw new HttpError(400, 'INVALID_ARGUMENT', 'artifact storage key has invalid URL encoding')` ⇒ **fail-closed TRƯỚC** mọi truy vấn DB.
- Tra cứu xảy ra **sau** decode: `:282` `resolveArtifactByStorageKey(ctx, storageKey)` (hàm này 404 khi không có hàng, `:86`).
- Encode một lần, decode một lần ⇒ key chứa **literal `%2F`** đi qua đúng một vòng giải mã, không bị double-decode thành `/` (đây chính là lớp lỗi OR10-05 mô tả).
- Ghi chú phạm vi: `decodeURIComponent` thứ hai tại `:420` thuộc route `saveStep`, **ngoài** phạm vi OR10-05.

## 3. Kiểm bounds theo packet (đối chiếu test)

Fixture cố tình hiểm: `tests/or10-05-artifact-download-route.test.ts:11`
`STORAGE_KEY = 'du/tenants/tenant-a/operations/operation-a/source 100% café 漢字 %2F'`

| Bound | Có được kiểm? | Bằng chứng |
|---|---|---|
| **Slash** trong key | **CÓ** | key chứa nhiều `/` (cấp thư mục giả) nhưng URL chỉ còn 1 segment ⇒ chứng minh không tách cấp đường dẫn |
| **Percent escape** (`100%`) | **CÓ** | `%` trần trong key phải round-trip; nếu decode/encode lệch sẽ hỏng lookup |
| **Literal `%2F`** | **CÓ** | cuối key có `%2F` ⇒ nếu bị decode hai lần sẽ biến thành `/` và lookup sai (test `:120`, `:142` dùng **once-decoded key** cho lookup/decrypt/read và cho blob write) |
| **Unicode** | **CÓ** | `café`, `漢字` trong key ⇒ kiểm encode/decode UTF-8 đúng |
| **Invalid escape** | **CÓ** | test `:158` `rejects malformed percent escapes before looking up an artifact`, URL `:164` `/api/runtime/v1/artifacts/blob/invalid%2?grant=bad-escape` ⇒ 400 `INVALID_ARGUMENT` **trước** khi tra artifact |

Ba test: (1) `:120` dùng key đã decode một lần cho lookup + decrypt + đọc; (2) `:142` dùng key đã decode một lần cho lookup + ghi blob; (3) `:158` từ chối percent escape hỏng trước khi tra cứu.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite OR10-05 | **PASS** — exit 0, `3 passed, 3 total` |
| Typecheck | **PASS** — exit 0 |
| Decode một lần + fail-closed | **ĐẠT** — `:272` một segment; `:275-281` decode-once có catch → 400; lookup sau decode `:282` |
| Bounds slash / percent / literal `%2F` / unicode / invalid escape | **ĐẠT** — đủ 5 nhóm, có case âm tính cho escape hỏng |

⇒ **OR10-05: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Không có bằng chứng live/HTTP thật** trong lượt này: suite là offline (`jest.unit.config.cjs`), tôi không dựng server/không gọi endpoint thật, không DB/Redis ⇒ hành vi qua network stack thật (proxy, `%` bị chuẩn hoá bởi tầng trung gian) **chưa** được chứng minh.
2. **`decodeURIComponent` tại `:420`** (route `saveStep`) không thuộc phạm vi OR10-05; nếu nó nhận key tương tự thì nên có packet kiểm riêng — tôi chỉ **ghi nhận**, không kết luận.
3. Test chỉ 3 ca; các ca như `%00`, chuỗi quá dài, hoặc key chứa `%` đứng cuối chuỗi chưa thấy trong file (không phải lỗi, chỉ là giới hạn độ phủ).
4. Không commit: file test là `??` (mới), `runtime.ts` có thể ` M` từ lane khác ⇒ kết quả gắn digest ở §1.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
