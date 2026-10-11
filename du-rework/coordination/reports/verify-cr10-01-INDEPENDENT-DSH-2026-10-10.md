# Verify độc lập (DSH) — CR10-01 Docker runtime boot / LDBA03 context provider — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet CR10-01 do lane Qwen implement.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code; **KHÔNG** tick gate; **KHÔNG** chạy `buildRuntime` trên host (xem GAP 3); artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `du-rework` (test deployment) và `orchestrator/services/orchestrator` (jest/tsc).
**Node:** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-cr10-01-2026-10-10/DSH/` (`test-run1..3.log`, `mdb01.log`, `orch-tsc.log`, `docker-packaging.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest khớp receipt gốc)

| File | Dòng | sha256 (16 ký tự đầu) | Git |
|---|---:|---|---|
| `du-rework/scripts/docker/build-runtime.cjs` | 126 | `453a3a5f317327e1` | ` M` |
| `du-rework/tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs` | 146 | `12bdca2bebc7dfbb` | `??` |
| `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (file được ship) | — | tồn tại | `??` |

Digest 2 file đầu **khớp chính xác** con số receipt §7 khai. Ghi chú nhỏ: receipt ghi test 147 dòng, trên đĩa `Get-Content` đếm **146** (khác quy ước dòng cuối, không phải thiếu nội dung).

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs` (cwd `du-rework`, lần 1) | **0** | `# tests 7` · `# pass 7` · `# fail 0` |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `# tests 7` · `# pass 7` · `# fail 0` |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `# tests 7` · `# pass 7` · `# fail 0` |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mdb-01-composition-provider.test.ts` (cwd orchestrator) | **0** | `Tests: 2 passed, 2 total` |
| 5 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (cwd orchestrator) | **0** | không output · `error_lines=0` |
| 6 | `node --test tests/deployment/docker.test.cjs` (regression packaging, cwd `du-rework`) | **1** | `# tests 20` · `# pass 14` · `# fail 6` — **đúng baseline receipt khai (14/6)**, 6 tên fail trùng khớp mô tả: `portable deployment preserves every locked version and importer` + 5 test compose model |

⇒ CR10-01 test **7/7 xanh, 3/3 lượt exit 0**; không có test nào bị bỏ qua; số liệu trùng khớp receipt §5.2/§5.3/§5.4.

## 2. Kiểm source — `build-runtime.cjs`

- `RUNTIME_EXTRA_FILES` (`du-rework/scripts/docker/build-runtime.cjs:56`) là bảng khai artifact runtime mà allowlist `files` không biểu diễn được.
- `copyRuntimeExtraFiles(service, packageDirectory, output)` (`:60-64`): mỗi entry **thiếu thì throw** `Missing runtime artifact for <service>: <relative>` ⇒ **fail-closed khi đóng gói**, không tạo image thiếu file trong im lặng.
- Gọi cho từng service ở cuối `buildRuntime` (`:119`), export tại `:122` (để test import được).
- `files: ['dist', 'migrations']` vẫn ghi vào manifest workspace tại `:105` — nguyên nhân gốc (chỉ 2 thuộc tính được pack) không đổi, nhưng nay được bù bằng bước copy tường minh.
- Điều kiện tiên quyết của boot test tôi tự kiểm: `orchestrator/services/orchestrator/dist/app/bootstrap/create-app.js` **tồn tại** (mtime 10-10 13:13) và có **3 hit** cho `registerLdb03ContextProvider|ldba-context-provider` ⇒ module compiled đã chứa hunks MDB-01; file ship `scripts/ldba-context-provider.cjs` **tồn tại**.

## 3. Kiểm test — boot trên layout image giả lập (không phải tính đường dẫn)

- `COMPILED_BOOTSTRAP_RELATIVE = 'dist/app/bootstrap'` (`tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs:19`); helper `imageLayout()` copy `dist` thật vào `<deployRoot>/orchestrator/dist` (`:48-53`) rồi `require(<imageRoot>/dist/app/bootstrap/create-app.js)` (`:122`).
- **Positive boot** (`:120-131`): `registerLdb03ContextProvider(env)` trả `registration`; assert `env.LDBA03_CONTEXT_MODULE === registration.modulePath` (`:125`) và `registration.modulePath.startsWith(imageRoot)` (`:130`) ⇒ provider được resolve **từ bên trong image**, đúng vị trí `create-app.ts` sẽ resolve khi chạy `dist/app/bootstrap`.
- **Negative control** (`:138-142`): layout KHÔNG có provider ⇒ assert.throws khớp **chính xác** `/refusing to boot: LDBA03 context provider module could not be loaded/` ⇒ hành vi fail-closed của MDB-01 giữ nguyên.
- 7 test còn lại phủ: khai báo `RUNTIME_EXTRA_FILES.orchestrator`, đường ship trùng đường compiled bootstrap resolve, provider nạp được đủ 7 callback, thiếu file thì packaging ném lỗi, service không khai thì output rỗng.
- Vì 2 test boot chạy **module compiled thật** (không phải suy luận đường dẫn), đây là bằng chứng gần mức image nhất có thể làm offline.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| CR10-01 test (7 test) | **PASS** — 3/3 lượt exit 0, `7/7`, `fail 0` |
| `copyRuntimeExtraFiles` (bounds + fail-closed) | **ĐẠT** — thiếu file thì throw, không bỏ qua; gọi cho mọi service; export cho test |
| Compile dist | **ĐẠT** — `dist/app/bootstrap/create-app.js` tồn tại, chứa hunks MDB-01 (3 hit), boot test require trực tiếp |
| Boot test (positive + negative) | **ĐẠT** — modulePath nằm trong imageRoot; thiếu provider thì throw đúng message |
| Regression MDB-01 | **PASS** — exit 0, 2/2 |
| Regression docker packaging | **BASELINE KHÔNG ĐỔI** — 14 pass / 6 fail, 6 tên fail đúng như receipt mô tả (pre-existing) |
| Typecheck orchestrator | **PASS** — exit 0, 0 lỗi |

⇒ **CR10-01: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (VERIFIED/ACCEPTED thuộc coordinator).

## 5. GAP / open items

1. **Build image thật + boot + health CHƯA được chứng minh** (acceptance bullet 1/2) — receipt tự khai (deviation 1) và lượt của tôi cũng **offline** (node:test + mô phỏng image bằng layout + `dist` compiled). Muốn đóng bullet này cần một cửa sổ build: 3 lệnh receipt §6 liệt kê (`docker build --target orchestrator …`, `docker run --rm --entrypoint ls … /app/scripts/ldba-context-provider.cjs`, boot `registerLdb03ContextProvider({})` trong image) **kèm image digest + boot log**. Tôi không chạy để tránh ghi đè/đốt cache build khi có writer đồng thời trên cùng service.
2. **Provider đang UNTRACKED** (`scripts/ldba-context-provider.cjs` là `??` của MDB-01) ⇒ build từ checkout sạch sẽ ném `Missing runtime artifact for orchestrator`. CR10-01 **phụ thuộc MDB-01 commit provider**; điều kiện này chưa đóng.
3. **Không được gọi `buildRuntime()` trên host** (receipt deviation 3): hàm ghi `files: ['dist','migrations']` vào mọi manifest workspace và **ghi đè `pnpm-lock.yaml`** không restore. Tôi **không** gọi; đề nghị lane build/cicd làm rõ comment hoặc làm nó bất biến.
4. **`scripts/ldba-03-production-adapter.cjs` cũng không được ship** (deviation 5) ⇒ nếu operator chạy migration CLI trong container sẽ thiếu file; không phải boot dependency, cần packet riêng nếu muốn.
5. **Baseline 6 fail của `docker.test.cjs` là pre-existing** (1 lockfile drift + 5 compose model) — tôi tái lập đúng 6 tên; không quy cho CR10-01, nhưng nghĩa là suite packaging đó **không xanh** ở trạng thái hiện tại.
6. **Chưa commit:** `build-runtime.cjs` là ` M`, test là `??` ⇒ kết quả gắn digest §0.

## 6. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test/docs; không chạy `buildRuntime` trên host; artifact duy nhất: receipt này + raw log.
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
