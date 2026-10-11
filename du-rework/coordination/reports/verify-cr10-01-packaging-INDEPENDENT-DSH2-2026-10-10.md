# Verify độc lập (DSH2) — CR10-01 Docker runtime packaging — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY**: `scripts/docker/build-runtime.cjs`, `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:157` (mở rộng đọc sang các artifact mà hai file này chạm: provider, Dockerfile, main.ts, migrations, shell-server, `tests/deployment/**`).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** build image, **KHÔNG** chạy Docker daemon; **KHÔNG** DB/Redis; **KHÔNG** đọc `.env.live`.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`) · ambient `NODE_ENV=production`.
**Raw:** `coordination/reports/raw/verify-cr10-01-packaging-2026-10-10/DSH2/` — `01-cr10-01-test.log`, `02-docker-test.log`, `03-dsh2-probe.log`, `04-dsh2-probe.cjs` (probe độc lập của tôi), `05-lockfile-delta.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-cr10-01-packaging-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| **CR10-01 packaging fix** (`RUNTIME_EXTRA_FILES` + `copyRuntimeExtraFiles`) | **PASS** — suite gốc `7/7` exit 0; probe độc lập của tôi `17/17` exit 0 |
| **Bounds allowlist** | **PASS có đính chính** — allowlist `files: [dist, migrations]` nguyên vẹn + đúng **1** file ngoài bounds cho **1** service; nhưng câu trong receipt *không còn file ngoài `dist/` nào cùng kiểu bẫy* là **quá rộng**: còn **2** escape `__dirname` khác, 1 cái được allowlist che, 1 cái chỉ sống nhờ ENV của Dockerfile (§3) |
| **Provider loadability** | **PASS** — chỉ `node:crypto/fs/path`, 7 callback, ship nguyên bản `.cjs`, seam metadata env-gated fail-closed (§4) |
| **Boot thật trên layout image** | **PASS độc lập** — tôi tự dựng image mô phỏng và chạy `dist/app/bootstrap/create-app.js`: đăng ký đúng provider trong image; thiếu provider thì từ chối boot đúng câu (§4) |
| **6 đỏ của `docker.test.cjs`** | **Xác nhận CÓ SẴN, không do CR10-01** — chứng minh bằng transform HEAD ≡ worktree + input sạch (§5) |
| **Phán định của receipt về 6 đỏ** | **ĐÚNG về kết luận**, có 1 lỗi số nhỏ (219115/219091 so với thực tế 229115/229091, delta 24 như nhau) |

**Một dòng cho coordinator:** CR10-01 packaging **đạt verify độc lập ở phạm vi offline** (17/17 probe + 7/7 suite + boot thật); 6 đỏ `docker.test.cjs` là drift lockfile/compose có sẵn, đã chứng minh không thuộc CR10-01; cần đính chính câu quá rộng về `__dirname` trong receipt.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs` (`du-rework`) | **0** | `✔` 7 test CR10-01 · `ℹ tests 7` · `ℹ pass 7` · `ℹ fail 0` · `duration_ms 7605.9` |
| 2 | `node --test tests/deployment/docker.test.cjs` (`du-rework`) | **1** | `ℹ tests 20` · `ℹ pass 14` · `ℹ fail 6` — đúng 6 tên như receipt §3-B |
| 3 | `node <probe độc lập của DSH2>` (`du-rework`) | **0** | `PROBE_RESULT 17/17 checks passed` |
| 4 | `git diff -U0 scripts/docker/build-runtime.cjs` | 0 | **+25/−1**: 3 hunk (khối mới 23 dòng, call tại `:119`, dòng `module.exports`) — `files:`, `buildPlan`, `deploymentLockfile` **không đổi một ký tự** |

Artifact đã kiểm (sha256 · mtime · git):

| File | sha256 | mtime | git |
|---|---|---|---|
| `scripts/docker/build-runtime.cjs` | `453a3a5f…9de8` | 13:20:26 | ` M` |
| `tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs` | `12bdca2b…1f64` | 13:18:56 | `??` |
| `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts` | `0dc655c2…3082` | 10-09 17:34:40 | ` M` |
| `orchestrator/services/orchestrator/src/main.ts` | `9772b77a…83d3` | 10-09 17:35:48 | ` M` |
| `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` | `89c6ec07…ff57` | 17:47:44 | `??` |
| `orchestrator/services/orchestrator/src/db/migrations.ts` | `519fd207…5eed` | 10-08 12:44:01 | sạch |
| `orchestrator/services/orchestrator/src/app/admin/shell-server.ts` | `5e3c4aae…134f` | 10-09 02:18:34 | sạch |
| `orchestrator/services/orchestrator/Dockerfile` | `f53150ea…c61ea` | 10-07 10:47:45 | sạch |
| `tests/deployment/docker.test.cjs` | `2af49912…2c89` | 10-05 13:14:04 | sạch |
| `dist/app/bootstrap/create-app.js` (build artifact) | mtime 13:13:55 | — | gitignored |

---

## 2. Đối chiếu từng claim của receipt

| # | Claim | Verdict | Bằng chứng độc lập |
|---|---|---|---|
| 1 | `main.ts:19` import + `:233` gọi `registerLdb03ContextProvider(process.env)` | **ĐÚNG** | grep `main.ts`: `L19` import, `L233` call |
| 2 | `create-app.ts:157` default `resolve(__dirname, '../../../scripts/ldba-context-provider.cjs')` | **ĐÚNG** | đọc trực tiếp `:151-157`; nhánh ENV `LDBA03_CONTEXT_MODULE` ưu tiên (`:154-156`) |
| 3 | `:160-162` fail-closed khi `require()` lỗi | **ĐÚNG** | `:159-163` catch → `throw new Error('refusing to boot: LDBA03 context provider module could not be loaded')`; probe D2 khớp **nguyên văn** |
| 4 | `build-runtime.cjs:105` `files: ['dist','migrations']` là nguyên nhân gốc | **ĐÚNG** | literal xuất hiện **đúng 1 lần** (probe A2); `package.json` hiện **không** có `files` ⇒ allowlist được **tiêm lúc build**, đúng như mô tả |
| 5 | `:56-58` `RUNTIME_EXTRA_FILES` | **ĐÚNG** | `:56-58`; probe A1: **đúng 1 service** (`orchestrator`) × **đúng 1 file** |
| 6 | `:60-70` `copyRuntimeExtraFiles` ném `Missing runtime artifact for <service>` | **ĐÚNG** | probe A5: throw với **đúng câu** `Missing runtime artifact for orchestrator: scripts/ldba-context-provider.cjs` |
| 7 | `:119` copy **sau** `pnpm deploy` (`:117`… thực tế deploy ở `:114`) và sau copy admin-web (`:117`) | **ĐÚNG** | probe A3 so chỉ số: deploy@5331 < admin-web@5528 < copy@5597 (thứ tự thực thi đúng). *Nit:* receipt ghi deploy ở `:117`, thực tế `:114`; `:117` là dòng copy admin-web |
| 8 | Đường copy khớp đường bootstrap giải | **ĐÚNG** | probe B1: từ `<image>/dist/app/bootstrap` resolve `../../../scripts/…` → `<image>/orchestrator/scripts/ldba-context-provider.cjs`, **file tồn tại** |
| 9 | Provider chỉ cần node builtin, seam metadata do env inject | **ĐÚNG** | probe C2: 3 `require` literal đều `node:*`; **đúng 1** require động là `require(modulePath)` nằm **sau** guard `!== 'true'`. *Nit:* receipt ghi tên biến khái quát (`METADATA_SEAM_MODULE`/`METADATA_ENABLED`/`METADATA_KEY_REF`), tên thật là `LDBA03_METADATA_SEAM_MODULE` / `DU_ENCRYPTION_METADATA_ENABLED` / `LDBA03_METADATA_KEY_REF` |
| 10 | `__dirname` trong `create-app.ts` chỉ 1 hit tại `:157` | **ĐÚNG (trong file đó)** | grep `create-app.ts` = 1 hit |
| 11 | Suy ra: *không còn file ngoài `dist/` nào cùng kiểu bẫy đang chờ nổ* | **QUÁ RỘNG — đính chính** | grep toàn `src/**`: **3** hit `__dirname` — thêm `db/migrations.ts:24` và `app/admin/shell-server.ts:416`; xem §3 |
| 12 | Chỉ `orchestrator` cần extras; service khác copy 0 file | **ĐÚNG** | probe A4: `orchestrator:['scripts/ldba-context-provider.cjs']`, 4 service còn lại `[]` |
| 13 | Test 6 chạy entrypoint biên dịch thật, test tự assert dist tồn tại | **ĐÚNG** | `test:42-46` assert `dist/app/bootstrap/create-app.js` tồn tại; probe D1 chạy lại **độc lập** cùng kết quả |
| 14 | Test 7 là negative control | **ĐÚNG** | `test:137-146`; probe D2 dựng layout thiếu provider và nhận đúng câu từ chối |
| 15 | 6 FAIL của `docker.test.cjs` không do CR10-01 | **ĐÚNG** | §5: transform HEAD ≡ worktree, input sạch, cơ chế lỗi nằm ở lockfile/compose |
| 16 | Số liệu lockfile `actual 219115 vs expected 219091` | **SAI CHỮ SỐ, đúng delta** | đo thật từ cwd `du-rework`: `prepared_slice_len=229115`, `original_slice_len=229091`, `delta=24` — khớp delta 24, lệch chữ số đầu |

---

## 3. Bounds allowlist — kiểm độc lập (và đính chính)

### 3.1 Bounds thật của image
- Allowlist do build tiêm cho **mọi** manifest workspace: `files: ['dist', 'migrations']` (`build-runtime.cjs:105`) + extras copy thêm (`:119`).
- Probe A4 chứng minh extras **không** nới allowlist: chỉ `scripts/ldba-context-provider.cjs` được thêm, cho đúng 1 service.
- Probe A6: file ship **byte-identical** nguồn (`sha256 89c6ec07…`, 48 281 byte).

### 3.2 Ba escape `__dirname` của runtime, đối chiếu bounds
| # | Vị trí | Đích trong image | Nằm trong bounds? |
|---|---|---|---|
| 1 | `create-app.ts:157` → `<root>/scripts/ldba-context-provider.cjs` | `/app/scripts/ldba-context-provider.cjs` | **CÓ** — do CR10-01 ship (probe B1) |
| 2 | `db/migrations.ts:24` → `join(__dirname,'../../migrations')` | `/app/migrations` | **CÓ** — `migrations/` ở package root (probe B2: **40 file `.sql`**), nằm trong allowlist |
| 3 | `app/admin/shell-server.ts:416` → `resolvePath(__dirname,'../../../../../apps/admin-web/dist')` | tính ra `/apps/admin-web/dist` | **KHÔNG khớp layout image** — xem 3.3 |

### 3.3 Phát hiện độc lập: SPA chỉ mount được nhờ ENV của Dockerfile
`resolveAdminWebDist` (`shell-server.ts:411-424`) thử theo thứ tự:
1. `DU_ADMIN_WEB_DIST` (`:462` → `:413`) — **ưu tiên**;
2. `resolvePath(process.cwd(),'apps/admin-web/dist')` → trong image (`WORKDIR /app`) = `/app/apps/admin-web/dist` — **trượt**, vì script copy vào `/app/admin-web` (`build-runtime.cjs:117`);
3. `resolvePath(__dirname,'../../../../../apps/admin-web/dist')` → từ `/app/dist/app/admin` lên 5 cấp = `/apps/admin-web/dist` — **trượt**.

Ảnh hưởng thật: **không có**, vì `orchestrator/services/orchestrator/Dockerfile:42,65,66` đặt `WORKDIR /app`, copy `/deploy/orchestrator` → `./`, và `ENV DU_ADMIN_WEB_DIST=/app/admin-web` — khớp đúng thư mục đã ship (probe B3). Nhưng nếu một deployment khác chạy đúng layout `/app` mà **thiếu** ENV đó, SPA sẽ 503 dù file đã nằm trong image. Đây là **cùng một lớp lỗi** với CR10-01 (đường runtime resolve ≠ đường packaging ship), chỉ khác là được ENV che; đề nghị ghi thành open item, không gán cho CR10-01.

**Đính chính câu trong receipt:** *không còn file ngoài `dist/` nào cùng kiểu bẫy đang chờ nổ* là **không đúng** — có 2 escape khác; 1 cái an toàn nhờ allowlist `migrations`, 1 cái an toàn nhờ ENV Dockerfile (không nhờ allowlist).

---

## 4. Provider loadability + boot thật (kiểm độc lập, không dùng test của tác giả)

- **C1:** provider sau khi ship export **đủ 7** callback (`prepareConnector`, `resolveProfileName`, `normalizeConnectionsOverride`, `prepareWorkflowSchema`, `readFileCacheBytes`, `artifactTokenFor`, `artifactPurposeFor`) và là object (không phải array).
- **C2:** chỉ 3 require literal (`node:crypto`, `node:fs`, `node:path`); require động duy nhất là seam metadata, nằm sau guard `DU_ENCRYPTION_METADATA_ENABLED !== 'true'`, với các mã lỗi riêng `METADATA_SEAM_DISABLED/_MODULE_REQUIRED/_KEY_REF_REQUIRED/_LOAD_FAILED/_INVALID` ⇒ thiếu seam là fail-closed **có tên**, không phải `MODULE_NOT_FOUND` mơ hồ.
- **C3:** file `.cjs` ship nguyên bản, **không** có bản `dist/` nào để phụ thuộc ⇒ không cần bước build cho provider.
- **D1 (boot thật, độc lập):** tôi tự dựng layout `.dsh2-cr10-01-image/orchestrator/{dist,scripts}` rồi `require` **chính** `dist/app/bootstrap/create-app.js` và gọi `registerLdb03ContextProvider({})`: `env.LDBA03_CONTEXT_MODULE === registration.modulePath === <image>/scripts/ldba-context-provider.cjs`, 7 callback đăng ký được, đường dẫn **nằm trong image** (không trỏ về source tree).
- **D2 (negative control):** layout thiếu provider → throw **đúng nguyên văn** `refusing to boot: LDBA03 context provider module could not be loaded`.
- **D3:** `dist/app/bootstrap/create-app.js` (13:13:55) **mới hơn** nguồn `create-app.ts` (10-09 17:34:40) ⇒ bằng chứng boot gắn với artifact biên dịch **sau** nguồn; `dist` cũng chứa đủ 3 câu từ chối (grep L114/121/125).
- Dọn dẹp: 2 thư mục image mô phỏng đã bị xoá trong `finally`; kiểm lại sau khi chạy: **không** còn `.dsh2-*`/`.cr10-01-*` trong package.

---

## 5. Sáu đỏ `docker.test.cjs` — phân định (đồng kết luận với receipt, chứng minh độc lập)

| Test đỏ | Cơ chế (đo được) | Vì sao không do CR10-01 |
|---|---|---|
| `portable deployment preserves every locked version and importer` (`:42`) | `deploymentLockfile(lock)` mặc định `root = process.cwd()`; nó rewrite `tarball: file:orchestrator/vendor/xlsx-0.20.3.tgz` → `tarball: file:D:/Git/dugate/du-rework/orchestrator/vendor/…` ⇒ slice sau `overrides:` dài hơn **24** ký tự (`229115` vs `229091`, `first_diff_at=150888`) | **E1:** bản `build-runtime.cjs` ở **HEAD** cho ra transform **giống hệt** bản worktree (cùng `len 229241`), và HEAD **không** có extras ⇒ CR10-01 không chạm hàm này |
| 5 test `docker-compose.yml: model resolves…` (`:97`) | `compose/orchestrator.yml:26` đặt `ORCHESTRATOR_PORT: '3000'` trong env của service, test cấm biến đó | **E2:** `compose/orchestrator.yml`, `docker-compose.yml`, `compose/`, `pnpm-lock.yaml`, `docker.test.cjs` đều **sạch vs HEAD** ⇒ đỏ có sẵn trong cây |

Ghi chú: `deploymentLockfile` là **idempotent** (`deploymentLockfile(prepared) === prepared` = true) và việc rewrite tarball là **có chủ đích** cho `pnpm deploy` offline; test `:45` kỳ vọng slice bằng bản gốc nên **không thể xanh** khi lockfile còn ref vendor tương đối phía sau `overrides:`. Đây là drift test/lockfile, ngoài phạm vi CR10-01.

---

## 6. GAP / open items

1. **Đính chính receipt CR10-01** (mục §2 #11 và số liệu #16) — câu về `__dirname` quá rộng và 2 chữ số đầu của 219115/219091 sai; cả hai không đổi kết luận PASS nhưng sẽ gây hiểu sai phạm vi đã kiểm.
2. **`shell-server.ts:411-424` là open item lớp CR10-01**: 2 fallback tự dò đều trượt trong layout image; image hiện sống nhờ `ENV DU_ADMIN_WEB_DIST=/app/admin-web` của Dockerfile. Nên có test pin **ENV + đường copy** như CR10-01 đã làm cho provider (hiện chưa có).
3. **Chưa có bằng chứng build image thật**: cả receipt và lượt này chỉ chạy offline (`node --test`); `docker build`/`docker run` chưa ai chạy trong phạm vi này ⇒ **offline pass không thay gate build/deploy**.
4. **`create-app.ts` đang ` M`** (sha `0dc655c2…`) — phần CR10-01 nằm trong cây làm việc, không ở HEAD; kết luận gắn với revision này.
5. **6 đỏ `docker.test.cjs`** cần owner lockfile/compose xử lý (ngoài lease này) — nếu coordinator đóng CR10-01, nên tách hai đỏ đó thành task riêng thay vì để lẫn trong báo cáo CR10-01.
6. `dist/` là build artifact (gitignored) — bằng chứng boot phụ thuộc nó; nếu ai đó build lại `dist` sau lượt này, cần chạy lại suite 1 để giữ hiệu lực.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy lệnh offline; **không** sửa file nguồn/test/config nào; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-cr10-01-packaging-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe và script đo nằm trong raw để tái lập.
- Probe ghi tạm vào `%TEMP%` và 2 thư mục `.dsh2-*` trong package (đã xoá trong `finally`, đã kiểm lại trống).
- Không build image, không chạy Docker daemon (chỉ `docker compose config` do chính suite `docker.test.cjs` gọi), không DB/Redis, không claim DB window.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
