# TEMPLATE RUNTIME MODULE RESOLUTION FIX (qwen_2) — 2026-10-06

**Nguon:** Codex Arch NO-GO — `node dist/src/main.js` trong container doc lap gap `MODULE_NOT_FOUND: @du/worker-sdk` vi `tsconfig.paths` khong rewrite `require` trong output CJS.
**Lease:** `businesses/document-core/template/**`. **Khong sua shared contracts.** Khong commit, khong tick.

## 1. Nguyen nhan

`tsconfig.json` dung `compilerOptions.paths` de map `@du/*` -> `vendor/*/src/index.ts`. `paths` chi hoat dung cho **type resolution**; `tsc` **khong** rewrite `require('@du/worker-sdk')` trong JS emit. Node CJS resolution tim `node_modules/@du/worker-sdk` — khong co → `MODULE_NOT_FOUND`.

## 2. Fix — shim packages trong `template/node_modules/@du/*`

Tao 5 shim package, moi shim co `package.json` tro vao **output da compile** (khong tro vao source):

```json
{"name":"@du/worker-sdk","version":"0.1.0","main":"../../../dist/vendor/worker-sdk/src/index.js","types":"../../../dist/vendor/worker-sdk/src/index.js"}
```

**Do sau 3 cap** (khong phai 2): `template/node_modules/@du/worker-sdk/` → `../../../dist/` = `template/dist/`.

| Shim | main |
|---|---|
| `@du/contracts` | `../../../dist/vendor/contracts/src/index.js` |
| `@du/document-kit` | `../../../dist/vendor/document-kit/src/index.js` |
| `@du/worker-sdk` | `../../../dist/vendor/worker-sdk/src/index.js` |
| `@du/observability` | `../../../dist/vendor/observability/src/index.js` |
| `@du/egress` | `../../../dist/vendor/egress/src/index.js` |

**Dep that that (khong phai shim):** `zod`, `pdf-lib`, `bullmq` — dep npm that, can `npm install` trong container.

## 3. Bang chung (literal)

### Boot khong env (trang thai cu: MODULE_NOT_FOUND)

```
BOOT_EXIT=1
stdout: {"error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},...,"message":"Failed to parse worker environment configuration"}
```

**`MODULE_NOT_FOUND` da bien mat.** Loi con lai la **config** (thieu `RUNTIME_URL`/`RUNTIME_TOKEN`/`REDIS_URL`) — dung, khong phai loi module.

### Boot co env day du

```
BOOT_ENV_EXIT=1
stdout: {"concurrency":1,"heartbeatIntervalMs":5000,"workerInstanceId":"worker-document-core-5446408f-fe7f-4f00-b0b4-5fc54f15f337","shutdownGraceMs":15000,...,"message":"Starting Document Core Worker service"}
stdout: {...,"message":"Worker failed to start"}
```

**Chung minh module resolution chay trọn vien:**
1. `parseWorkerConfig` **thanh cong** — in du `concurrency`, `heartbeatIntervalMs`, `workerInstanceId`, `shutdownGraceMs` tu `getRedactedConfig`.
2. Log `"Starting Document Core Worker service"` — tuc `DocumentCoreProcess.start` da chay qua import chain.
3. `"Worker failed to start"` — dung tai **khong co runtime live** (`http://localhost:3000` khong co trong container doc lap). Day la **trang thai ket thuc dung** cho mot boot co lap, khong phai loi module.

## 4. Gioi han (ghi trung thuc)

- **Chua chay duoc worker that su** — khong co orchestrator/redis live trong container doc lap. Boot dung la bang chung cho **module resolution**, khong phai bang chung cho **hanh vi worker**.
- **Chua co `node_modules` that** cho `zod`/`pdf-lib`/`bullmq` — can `npm install` trong container. Shim chi cho 5 package `@du/*`.
- **Chua chay test** — chi typecheck + boot.
- Khong sua shared contracts. Khong commit, khong tick.

## 5. File da ghi

`businesses/document-core/template/node_modules/@du/{contracts,document-kit,worker-sdk,observability,egress}/package.json` (5 shim), receipt nay.
