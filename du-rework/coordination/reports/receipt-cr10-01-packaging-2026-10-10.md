# CR10-01 offline check — Docker runtime packaging (build-runtime.cjs + create-app.ts:157) — 2026-10-10

> **Kết luận: PASS.** Bộ packaging đã đóng đúng lỗi CR10-01, provider **đủ dependencies để boot** (chỉ cần node builtin), và có negative control. Chạy offline, không sửa source, không commit.

- **Kiểm tra:** `du-rework/scripts/docker/build-runtime.cjs` + `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:157`.
- **Lưu ý đường dẫn:** task ghi `services/orchestrator/scripts/docker/build-runtime.cjs` — đường đó **không tồn tại**. File thật là `du-rework/scripts/docker/build-runtime.cjs` (đã xác nhận bằng glob toàn repo).
- **Receipt này chỉ đọc + chạy test**: không sửa file nào ngoài chính receipt này.

## 1. Chuỗi boot (đối chiếu code, đọc trực tiếp)

| Bước | File:line | Nội dung |
|---|---|---|
| 1 | `src/main.ts:19`, `:233` | `import { registerLdb03ContextProvider }` và gọi `registerLdb03ContextProvider(process.env)` |
| 2 | `src/app/bootstrap/create-app.ts:157` | mặc định `resolve(__dirname, '../../../scripts/ldba-context-provider.cjs')` — từ `<deploy>/dist/app/bootstrap` → `<deploy>/scripts/...` |
| 3 | `create-app.ts:160-162` | `require()` lỗi → throw `refusing to boot: LDBA03 context provider module could not be loaded` (fail-closed) |
| 4 | `scripts/docker/build-runtime.cjs:105` | `files: ['dist', 'migrations']` — **nguyên nhân gốc**: allowlist không pack `scripts/` |
| 5 | `build-runtime.cjs:56-58` | `RUNTIME_EXTRA_FILES = { orchestrator: ['scripts/ldba-context-provider.cjs'] }` |
| 6 | `build-runtime.cjs:60-70` | `copyRuntimeExtraFiles` — ném `Missing runtime artifact for <service>` nếu source thiếu (fail-loud, không image hỏng âm thầm) |
| 7 | `build-runtime.cjs:119` | gọi **sau** `pnpm deploy` (sau `:117`) → copy vào `<output>/<service>/scripts/...` |

**Khớp đường dẫn:** copy ghi `<output>/orchestrator/scripts/ldba-context-provider.cjs`; bootstrap giải `<deploy-root>/../../../scripts/...` = `<deploy-root>/scripts/...`. Cùng một đích → boot tìm thấy.

## 2. "Đầy đủ dependencies" — provider cần gì khi load?

**Không cần gói thêm gì ngoài chính file.** Đọc `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs`:

- `:3-5` chỉ `require('node:crypto')`, `require('node:fs')`, `require('node:path')` → **toàn là node builtin**, không có package third-party nào để lọt khỏi allowlist.
- `:824` (`require(modulePath)` trong `requireMetadataSeam`) là **seam do env inject** (`METADATA_SEAM_MODULE` + `METADATA_ENABLED` + `METADATA_KEY_REF`, `:811-827`) — chỉ chạy khi bật metadata và do deployment cung cấp, **không phải** dependency lúc boot; thiếu nó fail-closed với lỗi rõ (`METADATA_SEAM_*`), không phải MODULE_NOT_FOUND mơ hồ.
- `__dirname` escape trong `create-app.ts` **chỉ có 1 chỗ duy nhất** (grep = 1 hit tại `:157`) → không còn file ngoài `dist/` nào cùng kiểu bẫy đang chờ nổ.
- Chỉ `orchestrator` cần extras; `copyRuntimeExtraFiles` với service khác (`connector`, `document-core`…) copy 0 file (được test pin, §3-A test 5).

## 3. Test offline (cwd `D:/Git/dugate/du-rework`, Node v24.21.0)

### A. Test CR10-01

```
node --test tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs
✔ CR10-01: the orchestrator declares the context provider as a runtime artifact (0.7641ms)
✔ CR10-01: the shipped path is exactly what the compiled bootstrap module resolves (3.6213ms)
✔ CR10-01: the shipped provider loads and exposes every required callback (34.0215ms)
✔ CR10-01: packaging fails loudly when the provider is missing instead of shipping a broken image (1.5111ms)
✔ CR10-01: services without declared extras ship nothing extra (3.1658ms)
✔ CR10-01: the packaged image layout lets the compiled entrypoint register the provider (2894.1592ms)
✔ CR10-01: an image built without the provider still refuses to boot loudly (1703.7839ms)
ℹ tests 7   ℹ pass 7   ℹ fail 0
REAL_EXIT: 0
```

**7/7 pass, exit 0.** Test 6 chạy **entrypoint biên dịch thật** (`dist/app/bootstrap/create-app.js` đã tồn tại, test tự assert điều đó) trên layout image mô phỏng — bằng chứng boot thật, không chỉ đường dẫn tính tay. Test 7 là **negative control**: bỏ provider thì vẫn từ chối boot (đúng fail-closed).

### B. Cross-check suite packaging cũ

```
node --test tests/deployment/docker.test.cjs
ℹ tests 20   ℹ pass 14   ℹ fail 6
REAL_EXIT: 1
```

**6 FAIL (ghi rõ, không bỏ qua):**

| # | Test | Lỗi |
|---|---|---|
| 1 | `portable deployment preserves every locked version and importer` (`docker.test.cjs:42`) | `deploymentLockfile(pnpm-lock.yaml)` lệch ~24 ký tự so với chính lockfile (`actual 219115` vs `expected 219091`) |
| 2-6 | 5 test `docker-compose.yml: model resolves...` | `actual '3000'` vs `expected undefined` tại `docker.test.cjs:97` — compose model set một biến mà test cấm (kiểu `ORCHESTRATOR_PORT=3000`) |

### Phân định: 6 FAIL này **không phải do CR10-01**

Bằng chứng, không phỏng đoán:

1. **Diff CR10-01 trong `build-runtime.cjs` chỉ 3 mảnh**: +23 dòng (`RUNTIME_EXTRA_FILES` + `copyRuntimeExtraFiles`), +1 dòng call tại `:119`, +1 dòng exports. `deploymentLockfile`, `buildPlan` và `files: ['dist', 'migrations']` **không đổi một chữ nào** (`git diff -U0` đã xem).
2. **Input của 6 test đó sạch so với HEAD**: `git status --porcelain` trên `pnpm-lock.yaml`, `docker-compose.yml` (root + orchestrator), `compose/*`, `tests/deployment/docker.test.cjs` → **không file nào modified**. Test đỏ trên file sạch + code không bị đụng = đỏ có sẵn trong cây, không phải hồi quy CR10-01.
3. Các test **có** chạm code `build-runtime.cjs` (build order, Dockerfile sync, build planner cycles) đều **xanh**.

**Đề nghị (ngoài phạm vi, không tự sửa):** 6 đỏ này nên gán cho owner của lockfile/compose drift. Tôi không sửa vì ngoài phạm vi packet.

## 4. Xác nhận ranh giới

- **Không sửa file nào**: không `src/`, không test, không `build-runtime.cjs`, không `create-app.ts`, không `pnpm-lock.yaml`. File duy nhất tôi ghi là receipt này.
- **Không** `git commit` / `git add` / `git push`.
- Offline hoàn toàn: chỉ chạy `node --test` (test tự tạo và tự dọn thư mục tạm), không build image, không chạy Docker daemon, không mở DB, không claim DB window.
- Không tick gate, không viết VERIFIED/ACCEPTED — CR10-01 vẫn là **IMPLEMENTED, offline-verified, NOT accepted** (coordinator/Reviewer mới chốt).
- Test CR10-01 (`?? tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs`) là file của lane fix, tôi chỉ **chạy** nó.