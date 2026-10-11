# VERIFY ĐỘC LẬP (dsh-TUI) — RED của `tests/artifact-read-authorization.test.ts` — 2026-10-09

**Vai trò:** verifier độc lập (dsh-TUI), tái phần lập + đặc trưng phát hiện RED của `tests/artifact-read-authorization.test.ts`. **Không** sản phẩm fix này và **không** được fix.
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG sửa source/test/config/docs, KHÔNG commit/`git add`/push, KHÔNG tick gate, KHÔNG hand-edit `docs/21-openapi.json`, KHÔNG đọc `.env.live`. **OFFLINE** — không PostgreSQL, không Redis, **không claim DB window**. Chỉ `du-rework`.
**Môi trường đo trước khi chạy:** `node -v` = **v22.23.3** · HEAD = **`72e225ae5465e5a648c34bf31fbabbd182763233`** · branch `codex/fix-workflow-builder` · `AMBIENT_NODE_ENV=[production]`.
**Digest nội dung đã kiểm (SHA-256):** test file `3deb94faa3e78c039af9ffd1687e212efea5f354a2c92447bcbf12fcd1ca60b5` (` M`, uncommitted) · `src/modules/artifacts/artifacts.ts` `1fa4d876450463cce1c2979a4ce15c11b34c966ac89be911260f7b1791eae5f2` (**HEAD, sạch**) · `docs/28-test-inventory.md` `2de0fdf5a0469135f897bfa2a90c4f1d8532169ee8298e99832446f42b69855d` (**HEAD, sạch**) · `jest.unit.config.cjs` `027032b21948140175b7880769addeaec51ca68623bb277133c9f207b45c92a0`.
**Raw log:** `du-rework/coordination/reports/raw/verify-artifact-read-auth-2026-10-09/DSH/` (`runA-ambient-production.log`, `runB-node-env-unset.log`, `runC-rv01-unrelated.log`, `SHA256SUMS.txt`).

## 1. Bảng lệnh × exit code × dòng literal

| # | Lệnh (cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`) | Exit | Dòng literal |
|---|---|---:|---|
| A | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts` (ambient `NODE_ENV=production`, output `*>` vào file, **không** pipe qua tail) | **1** (`REAL_EXIT=1`) | `Test Suites: 1 failed, 1 total` · **`Tests: 5 failed, 85 passed, 90 total`** · 2.431 s |
| B | `Remove-Item Env:\NODE_ENV; node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts` (`NODE_ENV` unset) | **1** (`REAL_EXIT=1`) | `Test Suites: 1 failed, 1 total` · **`Tests: 5 failed, 85 passed, 90 total`** · 2.535 s |
| C | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts` (suite offline không sờ tới) | **0** (`REAL_EXIT=0`) | `Test Suites: 1 passed, 1 total` · **`Tests: 48 passed, 48 total`** |
| D | `git diff --stat -- tests/artifact-read-authorization.test.ts` | 0 | `1 file changed, **5 insertions(+)**` — fix đang được verify = thêm 4 dòng comment + `lease_active: task.leaseActive,` vào nhánh fake `assertLease` |

*Ghi chú shell:* packet yêu cầu `echo REAL_EXIT=$?`; đây là PowerShell nên `$?` là boolean — tôi ghi **`REAL_EXIT=$LASTEXITCODE`** (giá trị thật) và nhúng luôn dòng đó vào cuối mỗi log.

**Khớp với phát hiện của Codex:** **đúng 5 assertion mismatch, và giống nhau ở cả `NODE_ENV=production` lẫn unset** (A ≡ B, exit 1 cả hai). Không có sai lệch để báo.

## 2. Năm case fail (tên nguyên văn + dòng trong test + literal Expected/Received)

| # | Tên test case (nguyên văn) | `it()` tại | Assertion | Expected → Received (literal) |
|---|---|---|---:|---|
| 1 | `R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation` | `:371` | `:375` | `{"code":"STATE_CONFLICT"}` → **`{"code":"PERMISSION_DENIED"}`** |
| 2 | `R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant` | `:381` | `:386` | `{"code":"PERMISSION_DENIED","status":403}` → **`{"code":"LEASE_LOST","status":409}`** |
| 3 | `CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact` | `:588` | `:597` | `{"code":"STATE_CONFLICT"}` → **`{"code":"PERMISSION_DENIED"}`** |
| 4 | `CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong` | `:724` | `:732` | `{"code":"PERMISSION_DENIED","status":403}` → **`{"code":"LEASE_LOST","status":409}`** |
| 5 | `CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one` | `:736` | `:742` | `{"code":"PERMISSION_DENIED","status":403}` → **`{"code":"LEASE_LOST","status":409}`** |

Cả 5 block đều là `expect(received).rejects.toMatchObject(expected)` — tức **throw của service** khác mã/kỳ vọng, không phải lỗi hạ tầng; mỗi case còn assert `expect(db.grantUpdates).toBe(0)` (không mint grant) và các case đó **không** chạy tới vì throw đã fail trước.

## 3. Docs vs code — lệch ở đâu (file:line)

**Code đang thực thi (`src/modules/artifacts/artifacts.ts`, HEAD, digest `1fa4d876…`):**
- `:707` `if (!task.lease_active) throw conflict('LEASE_LOST', 'requester lease has expired');` ⇒ **409 `LEASE_LOST`** cho requester có lease hết hạn (sau check epoch `:704-706`).
- `:753-755` `if (art.taskId !== req.taskId && art.state !== 'READY') { throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact'); }` ⇒ **403 `PERMISSION_DENIED`** khi task khác đọc artifact chưa READY (STAGING); nhánh `:756` `if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY')` chỉ tới được khi requester **chính là** task sản xuất.
- Hệ quả khớp 5 case: case 2/4/5 → 409 `LEASE_LOST`; case 1/3 → 403 `PERMISSION_DENIED`.

**Docs contract:**
- `docs/28-test-inventory.md:1399` (row của chính suite này): *"cross-operation plus declared plus `STAGING` returns **409 `STATE_CONFLICT`**, not `PERMISSION_DENIED`. For leases, a wrong epoch plus an expired lease yields `LEASE_LOST`, whereas **expiry plus a wrong state yields 403**, and a live lease with the correct epoch still grants."* ⇒ docs nói **403 `PERMISSION_DENIED`** cho expiry, và **409 `STATE_CONFLICT`** cho declared cross-operation STAGING — **đúng bằng kỳ vọng của 5 assertion**.
- `docs/28-test-inventory.md:1323` (row suite fencing, cùng domain): *"expired task lease (lease chết ⇒ grant upload mới bị từ chối **409 `LEASE_LOST`**; grant cấp khi lease còn sống rồi lease chết ⇒ read grant **409**)"* ⇒ row này **khớp code**.
- `docs/07-internal-api.md:49,51` liệt kê `409 LEASE_LOST` cho các route multipart (không phủ trực tiếp read-grant `requestAccess`).

**Kết luận đối chiếu (không nhận xét fix):**
| Nhóm case | Docs nói | Code đang thực thi | Ai lệch |
|---|---|---|---|
| Lease hết hạn (case 2, 4, 5) | **403 `PERMISSION_DENIED`** (`docs/28:1399`) | **409 `LEASE_LOST`** (`artifacts.ts:707`) | **docs `28:1399` lệch code** (và lệch luôn `docs/28:1323` — bản thân docs đang chia hai) |
| STAGING do task khác/cross-op đã khai báo (case 1, 3) | **409 `STATE_CONFLICT`** (`docs/28:1399`) | **403 `PERMISSION_DENIED`** (`artifacts.ts:753-755`) | **docs `28:1399` lệch code** (không có row docs nào khác phủ rule "foreign task + unready") |

Nói ngắn: **docs (28:1399) nói 403/STATE_CONFLICT; code đang thực thi 409-LEASE_LOST/403-PERMISSION_DENIED**; 5 assertion của test bám theo docs.

## 4. RED này là finding mới hay đã tồn tại? → **ĐÃ TỒN TẠI (pre-existing), không phải mới**

Bằng chứng:
1. **Cả 5 assertion là nội dung HEAD**: file test chỉ có **1 thay đổi chưa commit là 5 dòng** trong nhánh fake `assertLease` (comment + `lease_active: task.leaseActive`) — **không dòng nào** trong 5 assertion hay vùng `requestAccess` bị đụng.
2. **Code mà 5 case chạy qua là HEAD**: `src/modules/artifacts/artifacts.ts` **sạch so với HEAD** (`git status` rỗng, digest `1fa4d876…`).
3. **Nhánh fake bị sửa không được 5 case này đi qua**: case 2/4/5 đọc `lease_active` từ **requester query** (nhánh `T.STATE` của fake — không đổi), case 1/3 đi qua nhánh authorization/STAGING — không case nào chạm `assertLease` (nhánh fake vừa được thêm `lease_active`).
4. **Đã được ghi nhận trước đó**: receipt `coordination/reports/triage-artifact-read-authorization-2026-10-08.md` (2026-10-08) đã liệt kê **đúng 5 mismatch này** (6 đỏ ban đầu, 1 đỏ thuộc test-double đã được sửa, còn lại 5 MISMATCH docs↔code).
⇒ Không phải regression mới; cũng không phải do fix 5 dòng đang chờ.

**Disclosure độc lập (bắt buộc nêu):** fix đang được verify (thêm `lease_active` vào shape fake của `assertLease`) **trùng nội dung** với thay đổi mà receipt triage 2026-10-08 của chính lane này đã ghi (cùng digest test file `3deb94fa…`). Nghĩa là **lượt này không phải tác giả độc lập của fix đó** — tôi chỉ tái lập kết quả, không sửa gì; coordinator cần cân nhắc khi tính "independent verification" cho riêng phần double-fix này.

## 5. Ghi nhận trạng thái bắt buộc

- `tests/migrations.test.ts` **bị live-gate loại** khỏi unit lane: `jest.unit.config.cjs:18` `'migrations\\.test\\.ts$',` trong `liveSuites` ⇒ **không tính là pass** (không chạy trong lượt này, và cũng không nằm trong phạm vi).
- **Không sửa gì để xanh**, không bỏ qua test đỏ, không retry để lấy xanh: run A/B đều đỏ và được giữ nguyên; run C chỉ là suite khác (rv01) để xác nhận không đỏ lây.
- Suite không sờ tới `rv01-loopback-http-offline.test.ts`: **exit 0 · 48/48** (` M` do lane khác, digest `9de6511b24794ea321e742d43e4a51ce60c54c90d5681d00492fbc8594af331f`) ⇒ không có đỏ lan sang suite lân cận.

## 6. Giới hạn

- **Chưa có live window nào được claim**: toàn bộ chạy **offline** bằng `jest.unit.config.cjs` với fake `Db`/scripted `pg`; không PostgreSQL, không Redis, không S3, không browser/deployment gate.
- Chỉ đọc + chạy test: **không sửa** source/test/config/docs, không commit/add/push, không tick gate, không đọc `.env.live`.
- Kết luận "pre-existing" dựa trên: assertion/code đều là nội dung HEAD + delta uncommitted không đi qua 5 đường đó + receipt 2026-10-08 trùng khớp; **không** chạy `git checkout HEAD` (bị cấm sửa cây) nên không có A/B checkout trực tiếp.
- Ghi chú ngoài phạm vi: `docs/19-traceability-audit-matrix.md:494` còn ghi suite này trong cụm "3 suites / 35 tests" trong khi `docs/28-test-inventory.md:1473` ghi **90 executed** — chênh số liệu tài liệu, không thuộc câu hỏi 403/409, chỉ báo cáo.
