# CONV-01/02/03 — Independent verification của `server.ts` extraction (cc_2, READ-ONLY)

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Dispatch:** 2026-10-03T12:45+07:00 (coordinator command-code).
- **Mode: READ-ONLY.** Không sửa source/test; không chạm `server.ts`; **không tick gate; không commit; không chạm `nocobase-10`**.
- **Before:** `git show HEAD:du-rework/services/orchestrator/src/server.ts` — **4299 dòng** (HEAD `b088eec`).
- **After:** worktree `server.ts` **375 dòng** + các module được tách:

| Module | Dòng |
|---|---|
| `src/http/routes/runtime.ts` | 480 |
| `src/http/routes/public.ts` | 585 |
| `src/http/routes/public-bounded-body.ts` | 27 |
| `src/http/routes/admin.ts` | 675 |
| `src/http/routes/api-key-auth.ts` | 24 |
| `src/http/route-context.ts` | 75 |
| `src/app/bootstrap/create-app.ts` | 795 |
| `src/app/bootstrap/crypto-wiring.ts` | 164 |
| `src/modules/admin-read/{api-key-list,audit-list,business-list,keyset}.ts` | 173/165/95/250 |
| `src/modules/operations/{list-query,mappers}.ts` | 580/95 |

**TL;DR (VI):** **INVENTORY-IDENTICAL.** Hai rule trích xuất độc lập đều cho multiset matcher giống hệt trước/sau: rule A (regex-on-pathname + string compare + method window) **54 = 54, 0 drift**; rule B (đếm guard/occurrence) `method ===` **58=58**, `.exec(pathname)` **34=34**, `.test(pathname)` **1=1**, `pathname ===` **16=16**, `startsWith` **1=1**. Line-move probe: **3340/3441 (97.1%)** dòng non-trivial của HEAD xuất hiện verbatim trong AFTER; phần dư đã phân loại hết (import/comment + 2 declared transform + CONV-13 dedup + edit có trước của lane khác RFX-05/11/12 + re-wrap thuần). `pnpm exec tsc --noEmit` **exit 0**; batch 14 suite offline: **11 PASS, 1 fail EADDRINUSE (flake, isolation PASS), 2 skip `DU_LIVE_INFRA`** (không có window → đúng, không chạy). Không phát hiện drift.

## 1. Frozen behavioral inventory — route matcher

**Rule A** — script `conv010203-verify.js`: trích mọi regex literal bắt đầu `^\/` + `pathname ===/!==/startsWith/endsWith '…'`, gán method bằng cửa sổ ±250 ký tự (`method === 'X'`), so multiset `kind::matcher::methods`.

```
> node <scratchpad>\conv010203-verify.js
HEAD server.ts lines: 4300
AFTER files: 15, total lines: 4754
BEFORE matchers: 54  |  AFTER matchers: 54
MATCHER-MULTISET: IDENTICAL
MATCHER-TEXT (methodless): IDENTICAL
```

**Rule B** — script `conv010203-lines.js` (đếm độc lập, không dùng window):

```
method === : HEAD= 58  AFTER= 58
method !== : HEAD= 0   AFTER= 0
.exec(pathname : HEAD= 34  AFTER= 34
.test(pathname : HEAD= 1   AFTER= 1
pathname ===  : HEAD= 16  AFTER= 16
pathname.startsWith: HEAD= 1  AFTER= 1
```

- **0 dòng lệch** → không có matcher nào thêm/bớt/đổi method; không cần liệt kê drift.
- Phân bố form (rule A): 35 regex `^\/…` (34 `.exec(pathname)` + 1 `.test(pathname)` trực tiếp — heartbeat PUT) + 16 `pathname ===` + 1 `startsWith` + 2 regex không kèm method trong window (guard helper). Tổng khớp 54.
- Ghi chú minh bạch: receipt code-lane ghi `before=93 after=93` bằng script riêng so `server.conv02.bak.ts` ↔ module tại thời điểm CONV-02; tôi **không reproduce đúng con số 93** (rule khác — họ gộp cả guard/route-entry), nhưng **cả hai rule độc lập của tôi đều cho IDENTITY**; con số tuyệt đối phụ thuộc định nghĩa "matcher", tính đồng nhất mới là acceptance.

## 2. Line-move spot-check

**Line probe** (mỗi dòng non-trivial của HEAD tìm trong AFTER, tolerant `export ` prefix):

```
LINE PROBE: 3340/3441 non-trivial HEAD lines found verbatim in AFTER set
unmatched: import=39 comment=22 export-ish=2 other=38 → sau phân loại: 101 dòng
```

**Window probe** (6 dòng trim, ≥4 dòng non-empty) — coverage theo file:

```
server.ts 258/371 = 69.5% | routes/runtime 319/508 = 62.8% | routes/public 536/601 = 89.2%
routes/admin 644/690 = 93.3% | api-key-auth 8/22 | public-bounded-body 13/25 | route-context 37/73
create-app 579/816 = 71.0% | crypto-wiring 138/162 = 85.2% | admin-read 63–69% mỗi file
list-query 571/611 = 93.5% | mappers 64/94 = 68.1%
```

**Phân loại toàn bộ phần dư (101 dòng)** — không có dòng logic route nào "lạ":

| Nhóm | Số dòng | Kết luận |
|---|---|---|
| Import/import-continuation (server.ts cũ) | 39 + 17 | Import được viết lại theo module mới — bản chất của extraction, không phải logic |
| Comment | 22 | Comment re-wrap/đổi chỗ; vài comment bị lane khác sửa lời (CRX-01/RFX ghi chú) |
| Export-ish | 2 | `export async function route(...)` → trả `RouteResult`; `export function absoluteGrantUrl(...)` → thêm tham số (RFX-11) |
| **Declared transform (CONV)** | 2 | `const result = await route({` → `await deps.route({` (`create-app.ts:581`); chữ ký `assembleApp(config, deps: AppDeps)` (`:185`) — đúng như cc-conv03 §1 khai báo |
| **CONV-13 dedup có chủ đích** | 5 | `interface AuditDbRow` / `function toAuditWire(row: AuditDbRow)` / `interface AuditWireRow` / `sortableAdminKeysetPage<AuditDbRow>` / comment "Mirrors audit.ts toWire" — bản sao cục bộ bị xoá, route import `toAuditWire` từ `modules/audit/audit.ts` (`git diff` audit.ts = `-function toWire` → `+export function toAuditWire`, đúng cam kết cc-conv02 §3; pin test `conv13-audit-wire-single-source` PASS) |
| **Edit có trước của lane khác** | 7 | RFX-11: `absoluteGrantUrl(host,url)` → 3 tham số (`runtime.ts:146,163`, 4 call site trong probe); RFX-12: heartbeat `HEALTHY` → `DEGRADED` (`runtime.ts:349-367` comment ghi rõ RFX-12); RFX-05: `readManifest(manifestKey, versionId?)` + 2 dòng thân |
| Re-wrap formatting thuần | ~9 | SELECT string/type union/ternary `artifactDecryptDeps` bị xuống dòng khi move (whitespace-normalized probe: 9 dòng "wrap-only") |

Không tìm thấy block nào bị **viết lại logic** nhân dịp move ngoài 2 declared transform; 5 dòng audit là **dedup CONV-13 có chủ đích**; 7 dòng còn lại thuộc lane khác (RFX-05/11/12) đã khai báo trước đó.

## 3. Compile + focused run (literal)

**3.1 Typecheck** — cwd `D:\Git\dugate\du-rework\services\orchestrator`:

```
> pnpm exec tsc --noEmit -p tsconfig.json
TSC_EXIT=0   (không có error TS)
```

**3.2 Batch focused route/facade (offline, `NODE_ENV=test`, `--runInBand`):** 14 suite = 3 family routes + bootstrap seam + auth/facade pins:

```
> pnpm exec jest --runInBand tests/rv01-loopback-http-offline.test.ts tests/crx01-creatapp-metadata-seam.test.ts \
    tests/crx01-metadata-wiring.test.ts tests/rfx10-seed-gate.test.ts tests/blob-wire-binary.test.ts \
    tests/ingress-bounded.test.ts tests/webhook-error-boundaries.boundary.test.ts \
    tests/conv13-audit-wire-single-source.test.ts tests/connector-credentials-offline.functional.test.ts \
    tests/admin-crypto-config-wiring.test.ts tests/enc08-wire-enc07.test.ts \
    tests/admin-error-boundary-offline.test.ts tests/adm-base-03-safe-error-offline.functional.test.ts \
    tests/multipart-routes-offline.test.ts
JEST_EXIT=1
Test Suites: 1 failed, 2 skipped, 11 passed, 12 of 14 total
Tests:       1 failed, 16 skipped, 340 passed, 357 total
```

- PASS (11): rv01-loopback-http-offline (real listener 45/45), enc08-wire-enc07, admin-crypto-config-wiring, crx01-creatapp-metadata-seam, rfx10-seed-gate, multipart-routes-offline, crx01-metadata-wiring, **adm-base-03-safe-error-offline.functional (PASS toàn bộ)**, connector-credentials-offline.functional, conv13-audit-wire-single-source, admin-error-boundary-offline (theo log).
- FAIL (1): `webhook-error-boundaries.boundary.test.ts` — test `STRETCH: ADM-BASE-03 error boundary … pg rejection carrying a sentinel -> 500` lỗi **`connect EADDRINUSE 127.0.0.1:55812`** (va chạm port loopback giữa các suite chạy chung batch — không phải assertion).
- SKIP (2): `blob-wire-binary` + `ingress-bounded` — `describe.skip` khi thiếu `DU_LIVE_INFRA=1` (window-gated; **không có lease → đúng là không chạy**).

**3.3 Isolation các suite fail/skip** (cùng cwd):

```
> pnpm exec jest --runInBand tests/webhook-error-boundaries.boundary.test.ts \
    tests/blob-wire-binary.test.ts tests/ingress-bounded.test.ts tests/admin-error-boundary-offline.test.ts
ISO_EXIT=0
Test Suites: 2 skipped, 2 passed, 2 of 4 total
Tests:       16 skipped, 74 passed, 90 total
```

→ webhook suite **PASS khi cô lập** (cùng lớp flake cổng loopback như cc-conv02 §4 đã ghi: `EADDRINUSE`/`ETIMEDOUT` theo tải batch); 2 suite live vẫn skip đúng.

## 4. Kết luận

- **Verdict: `INVENTORY-IDENTICAL`** — route matcher multiset (method + path + regex) giống hệt trước/sau theo 2 rule độc lập, 0 drift. Không có danh sách drift cần liệt kê.
- **Line-move: PASS có phân loại** — 97.1% dòng HEAD verbatim; phần dư giải thích 100% (import/comment/2 declared transform/CONV-13 dedup/RFX-05/11/12/formatting). Không có logic viết lại lén.
- **Compile + offline suites: PASS** — tsc exit 0; 11/14 suite xanh trong batch, 1 flake cổng loopback đã chứng minh PASS khi cô lập, 2 suite live-gated skip có lý do.
- **Chưa chứng minh được offline (nói rõ):** (a) hành vi trên hạ tầng thật — 2 suite `DU_LIVE_INFRA` (blob wire, ingress bounded) + live EXPLAIN; (b) browser/trace end-to-end; (c) các thay đổi non-matcher do lane khác (RFX-11 grant-url, RFX-12 heartbeat, RFX-05 manifest version) chỉ được ghi nhận là "có trước, đã khai báo", **không** được verify bởi receipt này; (d) route matrix không bao gồm status/body/header per-cell — chỉ matcher; status/body đã ngăn cách bởi các suite focused (fixtures) chứ chưa phải một ma trận route-level đầy đủ.

## 5. Ranh giới

- **Read-only**: không file nào bị sửa; chỉ ghi receipt này. `server.ts` không bị chạm.
- Không tick gate, không commit; HEAD vẫn `b088eec`. Script verify nằm trong scratchpad phiên (`conv010203-verify.js`, `conv010203-lines.js`), không phải deliverable trong repo.
