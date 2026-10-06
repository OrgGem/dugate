# ADM-BASE-03-CAPTURE — sua capture de khop logger that (TEST-ONLY)

## RESUME POINT — 2026-10-03

- **Ket luan 1 dong:** suite xanh — capture da chuyen sang **kenhh logger that la** (`process.stdout.write`) thay vi patch `console.error` vo dung.
- **Trang thai:** `adm-base-03-safe-error-offline.functional.test.ts` **19/19 exit 0** (truoc: 18/19 exit 1). Typecheck **exit 0**. Khong sua production source.

- **Phat hien quan trong:** 3 assertion `not.toContain(SENTINEL_*)` truoc do **vacuous** — `logText` la chuoi rong nen `not.toContain` luon xanh. Bay capture that, chung **co that** va **khong co sentinel**.
- **Canh bao dong tac:** mot lane khac (CONV-02) **ghi vao chinh file test dang thue lease** giua chung (them 3 structural pin cho `src/http/routes/*.ts`). Mu 9.
- **Buoc ke tiep:** Reviewer xac nhan mu 5; khong can gi them cho lane nay.

## 1 — Chan doan (khong doan, doc code)

| Buoc | Do duoc |
|---|---|
| Baseline fail | `adm-base-03-safe-error-offline.functional.test.ts:210` — `expect(logText).toContain('deferred section render error')`, nhan duoc `""` |
| Code that | `src/app/admin/shell-server.ts:196` goi `logger.error('[admin-shell] deferred section render error', { correlationId, errorClass: errorClassOf(err) })` |
| Logger tai do | `shell-server.ts:44` `createLogger({ service: 'orchestrator', baseFields: { subsystem: 'admin-shell' } })` — **khong truyen `sink`** |
| Sink mac dinh | `packages/observability/src/logger.ts` `consoleSink.write()` -> `process.stdout.write(line + '\n')`. **Khong co** `console.error` trong duong di nay |
| Ket luan | test patch kenhh ma code **khong ghi vao**. Khong phai bug production, khong phai regression — **capture sai kenhh**. |

## 2 — Sua gi (chi test)

- Capture them `process.stdout.write` (ghi vao `logged`, khong forward) **va giu** patch `console.error` + **them** `console.warn`; `finally` khoi phuc ca 3.
- **Giu nguyen moi assertion hành vi** — 3 `not.toContain(SENTINEL_*)`, `toContain('deferred section render error')`, `toMatch(/errorClass/)`, `toBe(200)`, `toBe(1)`, 3 assertion tren response: **khong sua, khong noi long, khong xoa**.
- Ghep ca hai kenhh chi **mo rong** tap duoc kiem sentinel-zero (superset), nen assertion co chuc nang **manh hon** chu khong yeu di.
- Dung dung idiom co san cua repo: `tests/admin-error-boundary-offline.test.ts:131` (`captureLogs()`) — save/assign `process.stdout.write` roi khoi phuc trong `finally`. Khong phat minh cach moi.
- Comment ghi ro **vi sao** (kenh that + test truoc do fail vi ly do sai) de nguoi sau khong sua nguoc lai patch `console.error`.

## 3 — Bang chung chay (cwd `D:\Git\dugate\du-rework\services\orchestrator`)

| Run | Command | Ket qua | Exit |
|---|---|---|---:|
| Truoc | `npx jest --runInBand --runTestsByPath tests/adm-base-03-safe-error-offline.functional.test.ts` | 19 test: 18 pass, **1 fail** (capture rong) | **1** |
| Sau (lan 1) | `npx jest --runInBand --runTestsByPath tests/adm-base-03-safe-error-offline.functional.test.ts` | **19/19 pass** | **0** |
| Negative control | cung lenh, tam thay 1 assertion thanh chuoi khong ton tai | **1 fail, 18 pass** — chung minh assertion co that chay | **1** |
| Revert probe + chay lai | cung lenh | 22/22 pass (xem mu 5: con 3 pin cua lane khac) | **0** |
| Aggregate lien quan | `npx jest --runInBand --runTestsByPath tests/admin-error-boundary.test.ts tests/admin-error-boundary-offline.test.ts tests/webhook-error-boundaries.boundary.test.ts tests/adm-base-03-safe-error-offline.functional.test.ts` | 4 suite; 95 test: **94 pass, 0 fail, 1 skip** | **0** |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | log 0 byte, khong diagnostic | **0** |

**SKIP ≠ PASS:** `admin-error-boundary.test.ts` **khong chay** — `tests/admin-error-boundary.test.ts:40-41` `const LIVE = process.env.DU_LIVE_INFRA === '1'; const liveDescribe = LIVE ? describe : describe.skip;`. Day la suite **live-gated**, khong phai bang chung xanh.

## 4 — Negative control: capture khong vacuous

Tam doi `expect(logText).toContain('deferred section render error')` -> `toContain('__PROBE_MUST_FAIL__')`, chay, **thay do lai ngay** (da kiem tra: file hien **khong con** chuoi `__PROBE_MUST_FAIL__`, 270 dong).

Test di **do** va in ra **dung record logger that**:

```json
{"subsystem":"admin-shell","errorClass":"Error","timestamp":"2026-10-02T18:57:36.836Z","level":"error","service":"orchestrator","version":"unknown","environment":"test","correlationId":"a7d765a6-bd18-41d7-9f45-afee0764231d","operationId":null,"taskId":null,"invocationId":null,"message":"[admin-shell] deferred section render error"}
```

- Record **co** `errorClass` va `deferred section render error` => 2 assertion positive **that** khong rong.
- Record **khong co** sentinel secret / path / DSN => 3 assertion `not.toContain` **co hieu luc that** (truoc do chung luon xanh tren chuoi rong).
- `"errorClass":"Error"` = **chi class, khong co message** => xac nhan fix product cua ADM-BASE-03 van con nguyen; lane nay khong sua gi.

## 5 — Dong tac ghi vao file dang thue lease (bat buoc bao cao)

`git diff` cuoi cung file test nay **co 3 hunk, trong do 1 hunk khong phai cua lane nay**:

```diff
+    // CONV-02: the route families moved out of server.ts - keep the pin over
+    // the code that now owns the request boundary.
+    ...['runtime.ts', 'public.ts', 'admin.ts'].map((f) => join(SRC, 'http', 'routes', f)),
```

- Luc bat dau: file **249 dong, `git status` sach**, structural pins **khong co** `src/http/routes/*`.
- Giua chung, lane CONV-02 tach route family khoi `server.ts` (`src/http/routes/{runtime,public,admin}.ts` — da xac nhan ton tai) va **them pin vao dung file test dang thue**.
- Hieu ung do: so test cua suite **19 -> 22** (them 3 `it.each` target). Run 19/19 o muc 3 la **cua rieng fix cua lane nay**; run 22/22 la **khi ca pin cua lane khac da co**.
- Lane nay **khong revert, khong sua, khong ghi de** hunk do; chi doc de bao cao. Hai thay doi **khong xung dot** (khac vung) va cung xanh.

## 6 — Acceptance + ranh gioti

| Tieu chi | Ket luan | Bang chung |
|---|---|---|
| Suite xanh | **MET** | 19/19 exit 0 (truoc 18/19 exit 1) — Muc 3 |
| Capture khop kenhh that | **MET** | `consoleSink` -> `process.stdout.write`; negative control in ra record that — Muc 1, 4 |
| Giu nguyen assertion hành vi | **MET** | khong sua assertion nao; chi them kenhh capture — Muc 2 |
| Suite lien quan | **MET co caveat** | 94 pass / 0 fail / **1 skip live-gated** — Muc 3 |
| Neu code co bug -> dung, khong sua source | **khong ap dung** | dieu tra **khong** cho thay bug code; capture sai kenhh — Muc 1 |
| Khong tick / khong commit | **MET** | khong chay gate lenh nao, khong `git commit`/`push` |
| Khong sua production source | **MET** | chi 1 file test trong lease; `git diff` khong co file `.ts` cua `src/` nao cua lane nay |

- File duy nhat bi sua: `services/orchestrator/tests/adm-base-03-safe-error-offline.functional.test.ts` (trong lease). Khong tao file phu tro gi.
- Khong mo DB/Redis/S3/Vault; suite thuan offline (loopback `127.0.0.1`, port `45000 + pid%100` — giu duoi 49152, khong dung port 0).

## 7 — Ledger

- 1 — Chuan doan: logger -> `consoleSink` -> `process.stdout.write`, khong phai `console.error` — Muc 1.
- 2 — Sua capture trong test (stdout + console.error + console.warn), giu nguyen assertion — Muc 2.
- 3 — Bang chung chay truoc/sau + aggregate 4 suite + typecheck exit 0, ghi ro SKIP ≠ PASS — Muc 3.
- 4 — Negative control: capture khong vacuous; in record that; revert probe sach — Muc 4.
- 5 — Bao cao hunk cua lane CONV-02 trong file thue lease; giai thich 19 -> 22 test — Muc 5.