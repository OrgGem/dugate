# Verify độc lập (DSH) — BIZ-01 Business Services offline integration — 2026-10-11

**Vai trò:** Independent Verifier (term_8bfe6adc), READ-ONLY lease.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa product code; **KHÔNG** tick gate; receipt **0 ký tự nháy kép** (đã tự quét).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-biz-01-cockpit-2026-10-11/DSH/` (`biz01-mjs.log`, `biz01-jest.log`, `SHA256SUMS.txt`).

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | REAL_EXIT | Literal |
|---|---|---:|---|
| A | `node --test tests/business-services-integration.test.mjs` — cwd `orchestrator/apps/admin-web` | **0** | `# tests 3` · `# suites 1` · `# pass 3` · `# fail 0` |
| B | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb-14-workflow-business-offline.test.ts` — cwd `orchestrator/services/orchestrator` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 8 passed, 8 total` |

Ca có tên trong lệnh A (nguyên văn): `ok 1 - Business Services offline integration harness` (nhóm này gồm 3 test, tất cả pass).

**Đối chiếu theo thời gian:** ở lượt verify AWEB-14 trước đó tôi đo suite B là **7/7**; nay **8/8** ⇒ đã có thêm một ca — không mâu thuẫn, chỉ là suite lớn lên.

## 2. Bound ownership business ↔ workflow — đọc test

**Suite A** (`apps/admin-web/tests/business-services-integration.test.mjs`, 146 dòng) — harness ngoại tuyến dựng từ **wire shape thật** qua parser của màn Businesses:
- `:5` import `parseBusinessPage`, `parseBusinessVersions` từ `../src/features/businesses/state.ts` ⇒ test đi qua đúng lớp parse mà UI dùng, không tự chế object.
- Fixture mang đủ **tuple sở hữu**: `:13-15` `businessId: document-core`, `activeVersion: 3.2.1`, `version: 3.2.1`; `:23-28` `businessVersionsWire` có **hai** version với trạng thái phân biệt rõ — `3.2.1 ENABLED isActive: true` và `3.1.0 RETIRED isActive: false` ⇒ kiểm được cả nhánh đang hoạt động lẫn nhánh đã nghỉ.
- `:33-37` hàng profile/binding mang `businessId` + `businessVersion` + `revision` ⇒ **workflow/profile gắn với (business, version, revision)**, tức bound sở hữu được biểu diễn ngay trong dữ liệu test.

**Suite B** (`services/orchestrator/tests/aweb-14-workflow-business-offline.test.ts`) — các ca đã được tôi verify độc lập ở lượt riêng và vẫn xanh nay:
- `:46` *ships an additive migration with nullable legacy ownership and profile bindings*, `:50` assert **đúng chuỗi** `ADD COLUMN IF NOT EXISTS business_id text NULL` ⇒ cột sở hữu **nullable + additive**;
- `:56` *filters the workflow catalog by tenant, business, and version in SQL* với `:76-77` assert `tenant_id = $1 AND business_id = $2 AND business_version = $3` và tham số đúng thứ tự ⇒ **ownership áp trong SQL**, không lọc ở tầng ứng dụng;
- `:87` *lists only owned workflow revisions and keeps a selected retired revision visible* với `:108-111` assert **cả hai** nhánh truy vấn đều mang bộ lọc tenant/business/version ⇒ không rò revision của business khác, và lựa chọn revision đã RETIRED không bị làm biến mất khỏi UI.

| Bound theo packet | Kết quả |
|---|---|
| Tất cả test pass | **ĐẠT** — 3/3 (A) + 8/8 (B), cả hai exit 0 |
| Catalog workflow lọc theo tenant + business + version | **ĐẠT** — suite B `:56`, `:76-77`, `:108-111` |
| Chỉ liệt kê revision thuộc sở hữu | **ĐẠT** — suite B `:87` |
| Migration sở hữu additive, cột cũ nullable | **ĐẠT** — suite B `:46`, `:50` |
| Harness UI dùng parser thật + tuple (business, version, revision) | **ĐẠT** — suite A `:5`, `:13-15`, `:23-28`, `:33-37` |

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| BIZ-01 harness admin-web | **PASS** — 3/3, exit 0 |
| AWEB-14 workflow business offline | **PASS** — 8/8, exit 0 |
| Bound ownership business-workflow | **ĐẠT** — 3 lớp: SQL filter (B), ownership nullable/additive (B), tuple wire qua parser thật (A) |

⇒ **BIZ-01 Business Services offline integration: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 4. GAP / ghi chú

1. **Offline hoàn toàn:** suite A là harness đọc parser + fixture; suite B dùng DB giả để bắt SQL ⇒ **không** chứng minh migration 0040 chạy thật trên PostgreSQL, cũng không chứng minh truy vấn trả đúng hàng trên dữ liệu thật — muốn chốt cần gate live/rehearsal.
2. **Chưa kiểm đường ghi binding:** cả hai suite xoay quanh đọc/lọc; phần ghi `profile_workflow_bindings` (và xoá/đổi enabled) **chưa** được tôi kiểm trong lượt này.
3. **Chưa đọc hết** hai file test (146 dòng + 238 dòng) — tôi đọc các vùng assertion chính và tên ca, chưa đọc từng dòng.
4. **Không có bằng chứng browser:** màn Businesses/cockpit chưa được render trong lượt này.
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 5. Xác nhận

- Không `git add`, không commit, không push; không sửa product code; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép** (đúng ràng buộc lượt này), **0 dòng trailing whitespace**.
