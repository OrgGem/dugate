# P745-SESSION-CONSUME (qwen_2) — capture/inject sessionRef — 2026-10-04

**Lease:** document-core src/worker.ts + actions/* + test moi p745-session-*. Read-only: contracts, submission, orchestrator runtime, worker-sdk (khong cham).
**Khong commit/push/reset. Offline. Khong tick gate.**

## 1. Da doi (4 file)

- `businesses/document-core/src/types/context.ts` — `ConnectorInvocationOptions.sessionRef?: string | null` (continuation session) + `ConnectorInvocationResult.sessionRef?: string | null` (session provider OFFERED). **XEM Δ-1: file nay NGOAI lease spec.**
- `businesses/document-core/src/worker.ts` — trong `toInternalContext.connector.invoke`: (1) gui `options.sessionRef` thanh SDK `invokeOpts` (arg thu 4) => lenh WIRE + nam trong canonical inputHash; (2) bo `res.result?.sessionRef ?? null` vao ket qua tra ve. **Chi khi caller truyen sessionRef moi tao invokeOpts** => direct single-shot khong doi byte-for-byte.
- `businesses/document-core/src/actions/session-seam.ts` (MOI, trong lease actions/*) — 4 ham: `findStepSessionConfig` (doc config capture/inject cua step tu PINNED policy), `resolveInjectSessionRef` (explicit > checkpoint fallback > null), `awaitCheckpointSessionRef` (doc session tren checkpoint, SDK qua step.peek / internal qua getCheckpoint), `captureSessionRef` (chi lay khi step khai bao capture).
- `businesses/document-core/tests/p745-session-capture-inject.test.ts` (MOI) — 10 test.

`git diff --stat` vs HEAD: worker.ts +33, types/context.ts +28 — **CONG CHUA ca thay doi W1b (pin forwarding) o chinh 2 file do o packet truoc**, khong phai 33 dong cua rieng P745.

## 2. Adjudication da ap dung (dung chi dao)

- **KHONG chuyen sang runConnectorStep** — giu `ctx.connector.invoke`; session di qua `ConnectorInvokeOptions.sessionRef` co san.
- **Fallback doc sessionRef tu checkpoint truoc khi goi** — `resolveInjectSessionRef` (explicit > checkpoint > null).
- **Capture tu response luu checkpoint** — `captureSessionRef` tra gia tri de caller persist vao checkpoint output cua step (durable qua yield); `awaitCheckpointSessionRef` doc lai.
- **Khong raw credential** — chi khu session string; khong co gi lien quan credential trong seam nay.

## 3. Bang chung (literal Exit Codes)

- `npx jest tests/p745-session-capture-inject.test.ts` — **Exit Code: 0**, 10/10 (8 seam + 2 toInternalContext forwarding).
- Focused x3 (p745 + execution-pin + p730-sdk-consume-forwarding): `Test Suites: 3 passed` / `Tests: 23 passed` — **Exit Code: 0** ca 3 lan.
- **DELTA-A GIU:** `tests/execution-pin.functional.test.ts` xanh trong ca 3 lan focused (khong sua 1 dong test nao).
- `npx tsc --noEmit -p tsconfig.json` — **Exit Code: 0**, khong loi.
- Regression toan package: `Test Suites: 4 failed, 57 passed, 61 total` / `Tests: 1 failed, 1 skipped, 931 passed, 933 total`. **4 suite do IDENTICAL voi lan do baseline o packet truoc** (config, sdk-consumer, provider-backed-variant, bullmq-smoke) — pre-existing, thuoc W1/W2, khong phai slice nay. Trong +27 test so voi baseline: **+10 la cua toi**, **+17 thuoc suite `tests/p730-prefconsume.test.ts` cua lane khac** (PREFCONSUME reassigned) — khong phai cua toi, khong cham.

## 4. Δ-DEVIATION / can coordinator phan xu

- **Δ-1 (bat buoc, NGOAI lease):** de lam requirement #1 (business truyen sessionRef) thi phai co truong tren `ConnectorInvocationOptions` — khai bao no o `types/context.ts`, file **khong nam trong lease** (spec: worker.ts + actions/*). Da sua **2 truong optional + doc** (~14 dong), khong doi gi existing. Hoac: coordinator duyet de chinh thuc, hoac noi revert (1 buoc).
- **Δ-2 (mapping stepId — CHUA quyet, da ghi vao code de tranh bia):** `connectionsOverride` step legacy dung stepId `ocr`/`extract` (fixture W2), con step key cua document-core la `ingest:execute-ocr`/`extract:connector-inference`. `findStepSessionConfig` match **EXACT stepId**; mapping stepId legacy -> step key document-core **chua co quy tac duyet** nen toi KHONG tu do (gia doai se binding sai session). Can coordinator chot (theo slot? theo connector slug? theo index?).
- **Δ-3 (do ben cua capture):** session duoc luu trong **checkpoint output cua step** (durable qua yield/restart). Doc lai phu thuoc checkpoint do con ton tai — khi step da finalize/settled va checkpoint bi don dep, gia tri mat; lan inject sau do phai lai inject tu provider side. Do la gioi han that cua kenh hien tai, da ghi trong doc comment cua module.
- **Δ-4 (wire carrier — van mo):** sessionRef len wire qua `InvocationRequest.sessionRef` (contract da co) nhung **provider co that su doc/gan no hay khong la quyet dinh phia Connector**; offline chi chung minh SDK/dat do, khong chung minh provider ton tai session. Can leg Connector (P745-ACQ/connector lane) xac nhan.

## 5. Trang thai chua duoc tuyen bo

- Seam capture/inject: **IMPLEMENTED + VERIFIED-OFFLINE** tren existing invoke path, offline.
- CHUA ACCEPTED: Δ-2 (mapping) chua chot nen chua action consumer nao goi seam; Δ-4 (provider that) chua co bang chung; full capture→inject end-to-end tren mock-provider chua chay (can buoc wiring action + Δ-2).
- Khong co file nao ngoai 4 file da liet ke; khong cham worker-sdk/contracts/orchestrator.

## 6. ADJUDICATION (coordinator 2026-10-05 00:03) — GHI NHAN

- **Δ-1 (types/context.ts): DUYET — giu** 2 truong optional + doc (~14 dong). Additive, khong doi hanh vi existing; requirement #1 can. Ghi nhan la da duyet, khong can revert.
- **Δ-2 (mapping stepId legacy): CHOT conservative** — khi KHONG match chac chan thi **SKIP capture/inject** (fail-la-nhed, giu hanh vi cu), **KHONG doan binding**. `findStepSessionConfig` da dung exact-match va tra null khi khong match => nhánh skip. Da them test chung minh: legacy stepId 'ocr'/'extract' khong match step key document-core nen skip; null/absent policy cung skip. Mapping table tuong minh (neu can) = packet rieng khi co nguon du lieu quyet dinh.
- **Δ-3/Δ-4: ghi nhan dung** — checkpoint durability + provider-side sessionRef semantics thuoc live/connector leg, chua chung minh.
- Bang chung sau khi them test Δ-2: focused `Test Suites: 2 passed` / `Tests: 21 passed` — **Exit Code: 0** ca 3 lan (p745 11 + execution-pin 10). Suite p745 rieng: 11/11, exit 0.
- Trang thai: **STAND-BY** cho packet B2. Chua co wire consumer nao cho seam (Δ-2 chot mapping); khi B2+adjudication den, se wire vao cac site build-prompt dung mapping da chot.
