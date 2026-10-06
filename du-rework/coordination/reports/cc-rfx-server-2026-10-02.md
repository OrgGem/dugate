# CC-RFX-SERVER — RFX-10 + RFX-11 + RFX-12 (server.ts boot/wiring)

**Lane:** command-code (RFX-SERVER, một owner cho `server.ts`). **Ngày:** 2026-10-02 (giờ VN).
**Trạng thái:** implementation + focused tests + tsc xanh; **KHÔNG tick gate, KHÔNG commit** (theo dispatch).
**Lease đã dùng:** `services/orchestrator/src/server.ts` + focused tests trong `services/orchestrator/tests/`.
**Nguồn:** `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` (RFX-10/11/12) — source đã được đọc lại trước khi sửa; số dòng packet đã lệch so với working tree, toàn bộ ref dưới đây là số dòng HIỆN TẠI.

## 1. Thay đổi theo file (hash `git hash-object`)

| File | Hash | Nội dung |
|---|---|---|
| `src/server.ts` | `4ee6d4e4…` | RFX-10/11/12 |
| `tests/rfx10-seed-gate.test.ts` (mới) | `551e580c…` | boot smoke seed-gate |
| `tests/rfx11-12-route-hardening.test.ts` (mới) | `232daf66…` | route-level RFX-11/12 |
| `tests/br12-isolation-offline.test.ts` | `1df76d5c…` | cập nhật 1 assertion heartbeat |
| `tests/artifact-storage-service.test.ts` | `c7c66218…` | cập nhật 1 assertion absoluteGrantUrl |
| `tests/multipart-routes-offline.test.ts` | `857ecfd4…` | CONFIG thêm zero-config signal (xem §4) |

## 2. RFX-10 — dev seed gate

- `server.ts:430-459` — hàm mới `shouldSeedDevFallback(env, { zeroConfigBoot })`:
  - `DU_SEED_DEV_FALLBACK=true` → seed (opt-in, mọi NODE_ENV); `false`/`''` → không seed (veto mọi tín hiệu khác); unset → seed khi `NODE_ENV=development|test` **hoặc** zero-config boot (`autoMigrate:true`); flag sai giá trị → throw lúc boot.
- `server.ts:490-525` — cả 2 INSERT (`tenants …0001`, `api_keys dev-fallback`) nằm trong `if (shouldSeedDevFallback(process.env, { zeroConfigBoot: config.autoMigrate === true }))`. Production boot (`autoMigrate=false`, không flag) **không chèn row nào**.
- **Kiểm tra phụ thuộc (theo yêu cầu packet):** `grep` toàn `src/` — chỉ `server.ts` nhắc 2 row; không code path nào đọc chúng ngoài vai trò FK target cho fixture legacy/dev. `dev-fallback-placeholder` không phải sha256 của bất kỳ raw key nào → `resolveApiKey` (R08-01) không bao giờ khớp; auth vẫn fail-closed trước/sau. Production không còn tenant 0001 → insert legacy tham chiếu nó fail FK rõ ràng (đúng chủ đích "fail rõ" thay vì FK target che lỗi).

## 3. RFX-11 — host-header injection

- `server.ts:333-341` — field mới `publicBaseUrl?: string` (platform config, không phải caller input).
- `server.ts:4297-4360` — `allowHostDerivedGrantUrl` + `GrantUrlOptions` + `absoluteGrantUrl(host, url, options)` + helper `requestGrantUrl(ctx, url)`.
- Call sites (đủ 4 như packet): `:1436` upload grant, `:1458`/`:1459` access grant (download+upload), `:1490` part grant.
- Thứ tự giải: (1) URL http(s) tuyệt đối (provider-signed) giữ nguyên; (2) `publicBaseUrl` cấu hình → host cấu hình, **luôn thắng** kể cả zero-config; (3) dev/test boot (NODE_ENV dev/test hoặc zero-config `autoMigrate:true`) → fallback Host cũ; (4) còn lại (production, không base) → trả **relative path**, không bao giờ dựng URL từ Host.
- Hệ quả production-không-base: response vẫn 200 nhưng relative → client cần URL tuyệt đối sẽ fail-closed tường minh (worker SDK `assertHttpUrl`, packages/worker-sdk/src/artifact-streams.ts:844-855; `ArtifactUploadGrantSchema` yêu cầu `z.string().url()`, packages/contracts/src/runtime.ts:206-208). Đây là lựa chọn có chủ đích: misconfig phải lộ ra, không được mint URL trỏ host attacker.

## 4. RFX-12 — heartbeat stub (có deviation, nêu rõ)

- `server.ts:1634-1657` — comment "STUB COMPAT SURFACE — không dùng cho monitoring", response `health:'DEGRADED'` thay `'HEALTHY'`, giữ nguyên `leaseExpiresAt`/`capacity`; xác nhận không chạm DB/state (route test assert `db.query` không được gọi).
- **Deviation vs packet (có evidence):** packet yêu cầu `'UNKNOWN'`, nhưng `HeartbeatAckSchema` (`packages/contracts/src/runtime.ts:22-26`) chỉ có enum `['HEALTHY','DEGRADED','OFFLINE']`, và worker SDK zod-parse chính ack này (runtime-client.ts:165-169; gọi không bọc tại worker.ts:418-419) → `'UNKNOWN'` làm worker không đăng ký được. Đã chọn `'DEGRADED'` — giá trị in-contract duy nhất không phải HEALTHY. `contracts`/`worker-sdk` ngoài lease nên không sửa. Nếu reviewer muốn đúng literal `'UNKNOWN'` thì cần packet mở rộng contract + SDK (ngoài phạm vi).

## 5. Về định nghĩa "dev/test" (bối cảnh môi trường — quan trọng)

Máy này export `NODE_ENV=production` ở cấp shell (xác minh: `node -e "console.log(process.env.NODE_ENV)"` → `production`; probe trong jest: `JEST_WORKER_ID=1, NODE_ENV=production`). Jest **không** override khi NODE_ENV đã set, nên mọi suite trong repo chạy dưới NODE_ENV=production. Vì vậy gate dùng thêm tín hiệu **zero-config boot (`autoMigrate:true`)** — đúng mode mà chính `server.ts:270-274` mô tả "Development/tests ... zero-config boot", và hầu hết live fixture in-process (runtime.test.ts, admin-*, tests/integration, artifact-grant-fencing…) đều truyền — 2 ngoại lệ ngoài lease liệt kê ở §8. Production compose không set AUTO_MIGRATE (Dockerfile có `ENV NODE_ENV=production`) → không seed, không fallback Host. Một production one-shot `AUTO_MIGRATE=true` sẽ được coi là zero-config boot; có thể veto seed bằng `DU_SEED_DEV_FALLBACK=false` (ghi vào doc-note).

## 6. Kiểm thử (literal command / cwd / exit)

### 6.1 Focused suites (FINAL, sau mọi chỉnh sửa)

```
cwd: D:\Git\dugate
> pnpm --dir du-rework/services/orchestrator exec jest tests/multipart-routes-offline.test.ts tests/rfx10-seed-gate.test.ts tests/rfx11-12-route-hardening.test.ts tests/br12-isolation-offline.test.ts tests/artifact-storage-service.test.ts --runInBand

PASS tests/multipart-routes-offline.test.ts
PASS tests/rfx11-12-route-hardening.test.ts
PASS tests/rfx10-seed-gate.test.ts
PASS tests/artifact-storage-service.test.ts
PASS tests/br12-isolation-offline.test.ts
Test Suites: 5 passed, 5 total
Tests:       79 passed, 79 total
Exit code: 0
```

Coverage chính:
- **RFX-10 (unit-equivalent boot smoke):** boot `createApp()` THẬT với `pg` scripted (pattern webhook-error-boundaries twin): (a) `NODE_ENV=production`, `autoMigrate=false`, không flag → 0 câu INSERT seed, "SELECT api_keys prefix='dev-fallback'" mô phỏng = 0 row; (b) `NODE_ENV=test` + `DU_SEED_DEV_FALLBACK=true` → đủ 2 INSERT, = 1 row; (c) `NODE_ENV=development` không flag → seed; (d) zero-config `autoMigrate=true` → seed; matrix hàm gate + flag sai (`'yes'`) throw.
- **RFX-11:** `route()` thật, `Host: evil.example`, `config.publicBaseUrl='https://api.dugate.example'` → uploadUrl/downloadUrl/partUrl đều host cấu hình (cả 3 route); dev/test không base → host cũ; production không base → relative, không chứa `evil.example`; `absoluteGrantUrl` passthrough URL ký sẵn, base có trailing slash, matrix env/zero-config.
- **RFX-12:** ack `health==='DEGRADED'` (≠ HEALTHY), parse hợp lệ bằng chính `HeartbeatAckSchema`, `db.query` không gọi.

### 6.2 Typecheck

```
cwd: D:\Git\dugate
> pnpm --dir du-rework/services/orchestrator exec tsc --noEmit -p tsconfig.json && echo TSC_EXITCODE=0 || echo TSC_EXITCODE=NONZERO
TSC_EXITCODE=0
```
(tsconfig của package chỉ include `src/**/*.ts`; các file test được ts-jest compile + chạy trong 6.1.)

### 6.3 Full offline unit suite (thông tin + phân loại failure)

```
> pnpm --dir du-rework/services/orchestrator exec jest --runInBand --config jest.unit.config.cjs
Test Suites: 11 failed, 2 skipped, 127 passed, 138 of 140 total
Tests:       68 failed, 29 skipped, 4104 passed, 4201 total
Exit code: 1
```
11 suite fail — **tất cả là pre-existing/không thuộc packet**, chứng minh 2 nguồn:
- 5 suite verify bằng cách swap tạm `server.ts` về bản HEAD (backup/restore an toàn, không đụng file lane khác): `admin-operations-sort-http-offline`, `admin-audit-query`, `admin-error-boundary-offline`, `adm-base-03-safe-error-offline.functional`, `admin-audit-mount` — **fail y hệt với server.ts HEAD** → không phải regression của packet.
- 6 suite còn lại có mặt trong baseline cache `du-rework/.cache/rfx-full.txt` (run baseline: `Test Suites: 11 failed…`): `admin-shell-session-lifecycle`, `admin-shell-server`, `admin-shell-platform-mount`, `admin-shell-router`, `admin-p6-01-shell-fixtures`, `admin-shell-render` (fail do ambient `NODE_ENV=production` + thay đổi của lane khác đang mở, log có `environment:"prod"`).

**Regression do RFX-11 đã phát hiện và sửa trong lease:** `multipart-routes-offline.test.ts` (offline mount suite) assert partUrl tuyệt đối theo Host; dưới rule mới cần khai báo dev/test boot → thêm `autoMigrate: true` vào CONFIG của harness (kèm comment). Trước sửa: FAIL; sau sửa: PASS (nằm trong 5/5 ở §6.1). Không còn regression nào khác do thay đổi này (không suite nào import `shouldSeedDevFallback`/`absoluteGrantUrl` ngoài các file đã xử lý, trừ các suite live nêu ở §8).

## 7. Doc-notes (không sửa docs trong packet này — ghi theo yêu cầu)

1. **Reverse proxy Host allowlist:** fix chính là `publicBaseUrl`; allowlist Host ở ingress là lớp bổ sung nên ghi vào DEPLOY doc.
2. **Wiring `PUBLIC_BASE_URL`:** `main.ts` (ngoài lease) hiện chưa truyền `config.publicBaseUrl`; đề xuất packet/caller nối `PUBLIC_BASE_URL` → `config.publicBaseUrl`. Chưa cấu hình → production trả relative (fail-closed).
3. **Ops monitoring thật:** `/health` (DB/Redis + `queueIntegrity` state) là endpoint giám sát; `PUT /workers/:id/heartbeat` là stub compat, không dùng cho autoscaling.
4. **Caveat AUTO_MIGRATE=true:** một production boot chạy `AUTO_MIGRATE=true` (one-shot) được xem là zero-config dev/test boot → seed + Host fallback; compose mặc định `AUTO_MIGRATE=false`; veto seed bằng `DU_SEED_DEV_FALLBACK=false`.

## 8. Unresolved gaps / what was NOT proven

- Acceptance RFX-10/11 chạy ở **seam unit/offline-equivalent** (createApp thật với pg scripted; `route()` thật; no live PG/Redis/socket). Live boot smoke trên PG thật chưa chạy (không mở DB window trong packet này).
- **2 live suite ngoài lease** boot `createApp` KHÔNG `autoMigrate` và fetch grant URL trực tiếp, sẽ cần follow-up nếu chạy dưới shell `NODE_ENV=production`:
  - `businesses/example-review/tests/example-review-continuation.integration.test.ts:220-223` (fetch `downloadUrl`; seed tenant 0001 ở :81-86).
  - `businesses/document-core/tests/multi-container-e2e.integration.test.ts:699-701` (fetch `downloadUrl`; seed api key tenant 0001 ở :393-398).
  - Đề xuất (không làm vì ngoài lease): thêm `autoMigrate: true` khi boot hoặc set `NODE_ENV=development`/`publicBaseUrl` cho 2 suite.
- RFX-12: không wire DB (hướng (b) tối thiểu theo packet); nếu reviewer muốn heartbeat phản ánh state thật → cần packet mở rộng (DB/lease read + contract).

## 9. Verdict

**ACCEPTED tại seam offline/unit-equivalent** cho RFX-10/11/12: focused 5 suite / 79 test PASS (exit 0), `tsc --noEmit` orchestrator exit 0, full unit suite không phát sinh regression nào (1 regression do RFX-11 được tìm thấy và sửa trong lease; 11 suite fail còn lại là pre-existing, có bằng chứng 2 nguồn). Live E2E/boot smoke **chưa** chạy — liệt kê ở §8. Không tick gate, không commit.
