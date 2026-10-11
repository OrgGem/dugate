# CR10-02 - usage dispatcher: containment at the scheduler boundary

| Muc | Gia tri |
|---|---|
| Task ID | CR10-02 (P1) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | D:/Git/dugate/du-rework |
| Canonical plan | tasks/CODE-REVIEW-FOLLOWUP-2026-10-10.md muc 2; coordination/PLAN-OPEN-2026-10-09.md muc 9.3 (hang 2) |
| Lease | orchestrator/services/connector/src/usage-dispatcher.ts + test lien quan duoi orchestrator/services/connector/tests |
| Owner lane | Qwen-5R (implement) |
| Trang thai | IMPLEMENTED + offline-verified [PASS]. CHUA ACCEPTED - can independent verifier |
| Receipt | coordination/reports/receipt-cr10-02-usage-dispatcher-2026-10-10.md |

## 1. Loi ke chinh xac (bang chung source, truoc khi sua)

Snapshot doc lai tu working tree, khong phai tai lieu dieu phoi:

- usage-dispatcher.ts:197 (truoc sua):

        void this.dispatchOnce().finally(() => this.schedule(this.options.pollIntervalMs));

- dispatchOnce gan `this.draining = this.processBatch()`, va processBatch await `this.outbox.claimBatch(...)` roi `Promise.all(rows.map(deliver))`.
- deliver co catch rieng, nhung catch do lai `await this.outbox.defer(...)`.

Ket qua: co ba duong rejection tho ra khoi chu ky batch va khong co handler nao bat:

1. `claimBatch()` reject (DB unavailable) - dung luong loi ghi trong packet.
2. `markDelivered()` reject roi `defer()` cung reject.
3. sink fail roi `defer()` reject.

Voi chinh sach mac dinh cua Node, mot promise reject ma khong co handler se sinh `unhandledRejection` va ket thuc process. Callback timer la fire-and-forget nen day la duong tho truc tiep, khong can caller nao.

Mot duong tho thu hai cung ton tai: `drain()` await chinh `this.draining` do, nen shutdown cua Connector cung reject khi DB dang hong. Ca hai deu la mot bien do lon goc.

## 2. Sua

Dung mot bien do lon goc duy nhat. `dispatchOnce()` gan `this.draining = this.runBatchCycle()`, va `runBatchCycle()` boc `processBatch()` trong try/cat:

- rejection khong bao gio con lai o ham, nen `void ... .finally(...)` o scheduler va `Promise.race` o `drain()` deu khong the reject nua;
- `schedule()` giong nguyen nen `.finally(...)` van tai lenh poll tiep theo - giu nguyen retry cadence;
- `running = false` trong `drain()` van chan `schedule()` moi, nen shutdown van dung timer;
- khong doi semantics giao: `markDelivered()` chi chay sau khi sink thanh cong, ack that bai thi event duoc defer va khong bao gio bi danh DELIVERED.

Log dung convention cua service (`src/entrypoint.ts`): `createLogger` + `safeErrorForLog` tu `@du/observability`, `baseFields.subsystem = 'usage-dispatcher'`. `safeErrorForLog` chi tra class-only nen khong lo duong dan, DSN hay secret cua loi DB ra log.

File da doi:

    orchestrator/services/connector/src/usage-dispatcher.ts            | 22 +, 1 -

Test moi:

    orchestrator/services/connector/tests/cr10-02-usage-dispatcher-rejection.test.ts (195 dong)

## 3. Dinh nghia WIN/LOSE tung test

Fault injection: `FaultInjectingOutbox` boc `InMemoryUsageOutbox`, tu dem va nem loi theo so lan con lai cho `claimBatch` / `markDelivered` / `defer`. Khong co DB, khong co Redis, khong co socket.

| Test | WIN (luoi) | LOSE (do) |
|---|---|---|

| claimBatch reject o scheduler boundary | listener `unhandledRejection` rong; poll tiep tuc (>=3 lan claim); event giao DUNG MOT LAN sau khi DB phuc hoi; `markDeliveredCalls = 1`; outbox rong | bat ky unhandled rejection nao, hoac cadence dung lai, hoac mark delivered khi DB chua chap nhan |
| claimBatch reject o chu ky goi truc tiep | `dispatchOnce()` resolve | `dispatchOnce()` reject |
| markDelivered reject + defer reject | `dispatchOnce()` resolve; `markDeliveredCalls = 1`; `size() = 1` (khong danh DELIVERED) | reject lan nua, hoac event bi coi da giao |
| defer reject (sink fail) | `dispatchOnce()` resolve; `size() = 1` (event van con trong outbox) | reject, hoac event bi mat |
| drain khi moi poll deu fail | `claimCalls` khong doi sau drain | timer chay tiep sau shutdown |

Moi test deu assert ca hai kenh: gia tri cua outbox/sink VA `capture.reasons` (mang unhandledRejection phai rong).

## 4. Bang chung chay

CWD cho lenh duoi day: `D:/Git/dugate/du-rework/orchestrator/services/connector`. Node `v24.21.0`.

### 4.1 RED truoc khi sua source

    node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/cr10-02-usage-dispatcher-rejection.test.ts

Ket qua literal:

    Test Suites: 1 failed, 1 total
    Tests:       5 failed, 5 total

Lý do fail đúng như kỳ vọng, không phải vì lý do khác:

- 3 test có `Received promise rejected instead of resolved` voi `Error: database unavailable` - rejection tho ra tu `dispatchOnce`.
- 2 test (scheduler + drain) bị chính Jest report unhandled rejection, stack tro ve `at Timeout._onTimeout (src/usage-dispatcher.ts:197:17)` - dung dong timer bi loi.

### 4.2 Mutation check tren ban test CUOI CUNG

De khong chay RED 'may tinh' chay truoc khi sua source, da giu source o trang thai chua sua voi chinh file test cuoi cung:

    this.draining = this.processBatch();   // tam bo runBatchCycle

    Test Suites: 1 failed, 1 total
    Tests:       5 failed, 5 total

Stack tro ve `at Timeout._onTimeout (src/usage-dispatcher.ts:218:17)` (dong timer, so da lech do file da them dong). Sau do khoi phuc nguyen ban sua va chay lai: 5 passed, exit 0.

### 4.3 GREEN - 3 lan lien tiep

    for %i in (1 2 3) do @(node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/cr10-02-usage-dispatcher-rejection.test.ts tests/reliability-security.test.ts tests/r1-d-lifecycle-offline.test.ts > '%TEMP%/cr10-02-final-run%i.txt' 2>&1 && echo FINAL_RUN%i_EXIT=0 || echo FINAL_RUN%i_EXIT!=0)

Exit code tuong minh:

    FINAL_RUN1_EXIT=0
    FINAL_RUN2_EXIT=0
    FINAL_RUN3_EXIT=0

Literal summary cho ca 3 lan:

    Test Suites: 3 passed, 3 total
    Tests:       30 passed, 30 total

Hai suite dispatcher co san (`reliability-security.test.ts`, `r1-d-lifecycle-offline.test.ts`) chay kem de chung minh khong regression.

### 4.4 Full offline unit suite cua connector

    node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --runInBand --forceExit

Exit: `UNIT=PASS` (exit 0). Literal:

    Test Suites: 37 passed, 37 total
    Tests:       1 skipped, 453 passed, 454 total

`jest.unit.config.cjs` loai `black-box-durable.test.ts` va `durable-integration.test.ts` - hai suite can DB that, khong chay.

### 4.5 Typecheck

    node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

Exit: `TYPECHECK=PASS` (exit 0), khong output. Day cung la lenh `lint` cua package nay.

### 4.6 Luu y ve bang chung exit code

Tren Windows cmd, `cmd.exe` khai trien `%ERRORLEVEL%` luc parse dong nen `... & echo EXIT=%ERRORLEVEL%` bao mot gia tri cu. Nen moi lenh verify trong receipt nay dung `&& echo ... || echo ...`, va exit code duoc in ra chinh khong phai suy tu exit code cua wrapper.

## 5. Lech so voi phong dap - can coordinator xet

**Lech 1 - message cua log bi redact.** `packages/observability/src/log-events.ts` chi cho phep message trong `SAFE_LOG_MESSAGES`; nhan `usage dispatch cycle failed` chua co trong danh sach nen `message` ra sink duoi dang `[REDACTED]`. File do NGOAI lease nay nen lane khong sua. Nhan dang su co lai: `subsystem=usage-dispatcher`, `level=error`, `service=connector`, `error.kind` - ca nhung deu di qua bo loc. De khong dung nhan sai, lane khong mua hien `handler failed` hay `unhandled listener error` de lai cho su kien nay. Follow-up de xuat: them `'usage dispatch cycle failed'` vao `SAFE_LOG_MESSAGES`, can mo lease `packages/observability/src/log-events.ts`.

  Follow-up da duoc viet thanh packet tai `coordination/dispatch-specs/2026-10-10-CR10-02D1-safe-log-messages.md` (Status SPECIFIED/OPEN, assignee PENDING - dispatcher can inspect live roster). Diem do do them trong packet: `@du/observability` resolve ve `dist/index.js`, nen **phai rebuild `packages/observability`** roi moi chung minh duoc o tang connector.

**Lech 2 - vi tri containment.** Packet yeu cau `bat loi o scheduler boundary`. Lane dat containment tai `runBatchCycle()` - bien do lon goc ma scheduler, `drain()` va moi caller truc tiep deu chung. Day la tap hop rong hon yeu cau, khong phai nho hon. Lane KHONG them `.catch()` thu hai trong `schedule()`: hien tai promise do khong the reject nen catch do se la dead code; neu sau nay co lane nao lam `dispatchOnce()` reject lai, boundary se lai mo.

## 6. Phan gioi va trang thai

- Chi sua `src/usage-dispatcher.ts` va them 1 file test trong `tests/`. `git status --porcelain` tren `du-rework/orchestrator/services/connector`:

        M du-rework/orchestrator/services/connector/src/usage-dispatcher.ts
       ?? du-rework/orchestrator/services/connector/tests/cr10-02-usage-dispatcher-rejection.test.ts

- KHONG `git add`, KHONG `git commit`, KHONG push. Khong mo cua so DB/Redis/S3 nao.
- Khong tick gate, khong cap nhat trang thai CR10-02 trong task hay plan.
- Acceptance bullet 4 (verifier chay fault/recovery test + integration voi DB disposable) CHUA duoc chung minh boi receipt nay: lane chi verify offline. Do la viec cua verifier doc lap, khong phai implementer tu accept.
- Khong co su thay doi nao o CR10-01 / CR10-03 / CR10-04.
