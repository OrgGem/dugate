# DISPATCH — LDBA-04 — Adapter identity: bcrypt → scrypt re-hash

**Task ID:** `LDBA-04`
**Repo scope:** `D:/Git/dugate` — đọc `lib/db/schema.ts` (root, bảng `User`) + `du-rework/orchestrator/services/orchestrator/migrations/0023_admin_local_users.sql` + `0024_legacy_parity_columns.sql` (dòng 24-30) + `0026_profile_policy.sql` (dòng 172-180) + `du-rework/orchestrator/services/orchestrator/src/**` (auth/login hiện hữu). **VIẾT DUY NHẤT:** module identity mới (path do bạn tự chọn) + test riêng của module đó + receipt `du-rework/coordination/reports/ldba-04-identity-adapter.md`
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (§4.3, §6.1, §7 R3, §8 dòng LDBA-04)
**Owner:** terminal `term_6bd1346d-2135-4b91-9fd8-0df7570e1b90` (đã đọc màn hình: **IDLE tại prompt**; trước đó làm tenant selection + màn hình profiles/api-keys — đúng domain identity).
**Dependencies:** LDBA-01 **ACCEPTED** (verdict L1..L7) + LDBA-02 **ACCEPTED** (gate đã mở) + LDBA-00 **VERIFIED** (bảng `User` mapping)
**Mode:** thiết kế + viết module + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-04-identity-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

Legacy `User.password` là **bcrypt**. Rework `admin_local_users.password_hash` có CHECK chỉ nhận **scrypt** (`0023_admin_local_users.sql`, regex `^scrypt\$32768\$8\$1\$...`). Bcrypt không thể thỏa CHECK đó — nên không thể copy hash cũ nguyên trạng vào.

§4.3 đã chốt cách xử lý: **verify bcrypt ở lần login đầu, re-hash scrypt, ghi đè**. Không nới CHECK, không thêm cột bcrypt song song.

**Điểm cần đảo ngược trước khi viết bất kỳ hàng nào:** `0024:24-30` và `0026:172-180` đều ghi rõ **Deliberately NOT backfilled** với lý do `docs/14-reference-compatibility.md` tuyên bố rework là project mới, không migrate dữ liệu/credential từ deployment cũ. Packet này **là** việc migrate credential — nên tiền đề đó phải được đảo có chủ đích, không lặng lẽ bị vi phạm.

Lưu ý: `0023_admin_local_users.sql` chứa **chỉ schema + CHECK**, không có chính sách backfill. Chính sách nằm ở tầng deploy (`0024`, `0026`). Bạn phải đọc cả ba file trước khi kết luận.

## 1. Việc cần làm

### 1.1. Đảo tiền đề no-backfill cho credential

- Đọc `0024:24-30` và `0026:172-180` nguyên văn. Ghi lại **chính xác** câu tuyên bố không backfill và lý do đi kèm.
- Xác nhận `0023` không chứa chính sách backfill nào (chỉ schema + CHECK).
- Trong receipt, **tuyên bố rõ** packet này là chỗ credential legacy được nhập, và nêu hệ quả: mọi hàng `admin_local_users` tạo trong packet này là dữ liệu migrate, không phải dữ liệu mới. Đây là bằng chứng để coordinator cập nhật plan, không phải lý do để bạn tự sửa migration.

### 1.2. Không nới CHECK, không thêm cột song song

- **Không** sửa regex CHECK trong `0023`.
- **Không** thêm cột `password_hash_legacy` hay cột bcrypt song song.
- Nếu bạn kết luận cần một trong hai điều đó → **dừng và ghi `Open items for coordinator`**, không tự quyết.

### 1.3. Re-hash tại điểm login

- Legacy `User.password` (bcrypt) → verify bằng bcrypt ở lần login đầu tiên.
- Verify đúng → hash lại bằng scrypt theo đúng tham số CHECK trong `0023` → ghi vào `password_hash`.
- Verify sai → từ chối bình thường, không ghi gì.
- **Không** hash sẵn toàn bộ bảng `User` một lược. Hash phải xảy ra tại điểm login, vì bcrypt verify cần mật khẩu người dùng nhập.

### 1.4. User chưa từng login

§4.3: user chưa từng login thì không có cách nào verify bcrypt → cần reset. Bạn phải:

- Đếm **chính xác** số user trong legacy `User` (từ dữ liệu bạn tự dựng trong test, không từ DB thật).
- Nêu rõ: user chưa login sẽ bị **khoá** (`is_locked = true`) hay **reset mật khẩu**? Chốt một hướng duy nhất.
- **Không** ước lượng. Số phải đếm được từ dữ liệu test.

### 1.5. Cột MISSING trên `admin_local_users`

LDBA-00 ghi rõ: `provider`, `providerSub`, `email`, `displayName` của legacy `User` là **MISSING** trên `admin_local_users`. Bạn phải:

- Xác nhận bằng cách đọc `0023` — các cột đó có không.
- Nếu không có: **không thêm cột**. Ghi `Open items for coordinator` nếu bạn kết luận chúng cần thiết.
- `role` legacy (PARTIAL) sang `admin_local_users.role` — cần bảng map tường minh, validate miền giá trị.
- `tenant_id` là cột mới (legacy không có tenant) — mọi user migrate trỏ về tenant `legacy-default` (§4.1).

### 1.6. `UserProfileAssignment` → `user_profile_assignments`

LDBA-00: bảng này **không có cột id**, PK là `(user_id, api_key_id)`, **không có cột tenant**. Bạn phải:

- Xác minh bằng cách đọc migration `user_profile_assignments` hiện hữn.
- Chốt cách gán `tenant_id` cho các hàng migrate (mặc định `legacy-default`).
- Chốt cách sinh `user_id` từ legacy `User` — cần validate uuid trước khi ghi (§4.2).

## 2. Ranh giới (bắt buộc)

- **KHÔNG** chạy migration lên DB thật. Chỉ test offline với dữ liệu tự dựng.
- **KHÔNG** đọc DB production/legacy để lấy fixture.
- **KHÔNG** sửa `0023`, `0024`, `0026` hoặc bất kỳ file migration nào.
- **KHÔNG** sửa source auth hiện hữu trừ khi bạn **chủ động** đề xuất và chờ coordinator duyệt lease.
- **KHÔNG** commit, `git add`, push, không tick gate.
- **KHÔNG** nới CHECK, **KHÔNG** thêm cột bcrypt song song.

## 3. Acceptance criteria

- [ ] Đã đọc `0023`, `0024:24-30`, `0026:172-180` nguyên văn; trích **chính xác** câu tuyên bố no-backfill
- [ ] Receipt tuyên bố rõ packet này là chỗ credential legacy được nhập — đây là bằng chứng để coordinator cập nhật plan
- [ ] `0023` xác nhận **không** chứa chính sách backfill
- [ ] Verify bcrypt → re-hash scrypt tại điểm login; **không** hash sẵn toàn bộ bảng
- [ ] CHECK trong `0023` **không** bị sửa; **không** có cột bcrypt song song
- [ ] Số user chưa login được **đếm** từ dữ liệu test, không ước lượng; hướng xử lý (khoá hay reset) được chốt
- [ ] `provider`/`providerSub`/`email`/`displayName` xác nhận MISSING trên `0023`; **không** thêm cột
- [ ] `role` legacy → `admin_local_users.role` có bảng map tường minh + validate miền
- [ ] `user_profile_assignments`: xác nhận không có `id`, PK `(user_id, api_key_id)`, không có `tenant`; chốt cách gán tenant + validate uuid
- [ ] Test chứng minh: bcrypt verify đúng → scrypt ghi đè; verify sai → từ chối; CHECK không bị vi phạm
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số user test, số verify đúng/sai, mọi `Open items`

## 4. Dispatch proof

- **Request ID:** `LDBA-04-2026-10-09`
- **Owner:** `term_6bd1346d-2135-4b91-9fd8-0df7570e1b90` — đã đọc màn hình trước khi chọn, **IDLE tại prompt** (trước đó: tenant selection + profiles/api-keys screens)
- **Dependency evidence:** LDBA-01 ACCEPTED (L1..L7) + LDBA-02 ACCEPTED (gate đã mở) + LDBA-00 VERIFIED (bảng `User` mapping, `0023` CHECK scrypt)
- **Acceptance:** đảo tiền đề no-backfill có chủ đích + re-hash tại login + không nới CHECK + không thêm cột + test offline
