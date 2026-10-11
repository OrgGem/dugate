# Dispatch Spec: CR10-02-D1 - them label SAFE_LOG_MESSAGES cho usage dispatcher

- Date: 2026-10-10
- Role: Coordinator (chi viet packet metadata; khong implement, khong tu accept)
- Assignee: PENDING - dispatcher phai inspect live roster truoc khi chon owner (UNVERIFIED tai thoi diem viet packet; xem muc 4)
- Repo scope: du-rework (khong dung legacy root, khong dung DB production/legacy)
- Canonical plan: tasks/CODE-REVIEW-FOLLOWUP-2026-10-10.md muc 2 (CR10-02) + receipt coordination/reports/receipt-cr10-02-usage-dispatcher-2026-10-10.md muc 5 Delta 1
- Status: SPECIFIED / OPEN (chua dispatch, chua co owner ca nhan)
- Lease conflict: khong. packages/observability clean tai thoi diem viet packet (git status --porcelain rong).

---

## 1. Van de

CR10-02 (da land trong working tree, chua commit) them containment tai orchestrator/services/connector/src/usage-dispatcher.ts:167:

    logger.error('usage dispatch cycle failed', { error: safeErrorForLog(error) });

metadataLogRecord chi cho truong message di qua khi chuoi nam trong SAFE_LOG_MESSAGES (orchestrator/packages/observability/src/log-events.ts), nen dong log ra sink mat nhan:

    {"subsystem":"usage-dispatcher","error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},"level":"error","message":"[REDACTED]"}

Su co van phat hien duoc qua subsystem=usage-dispatcher, level=error va error.kind, nhung nhan su co bi mat. File allowlist nam ngoai lease CR10-02 nen lane da khong sua, va cung khong muon mot nhan co san nao khac de cho dung nghia (receipt muc 5, Delta 1).

## 2. Muc tieu

1. Them dung mot label tinh: usage dispatch cycle failed.
2. KHONG noi long co che: khong wildcard, khong prefix, khong regex, khong bo kiem tra - message la van phai ra [REDACTED].
3. Them positive control test cho label moi, theo dung pattern test hien co.
4. Rebuild packages/observability dist de thay doi thuc su toi duoc consumer (xem ghi chu build o muc 3).
5. Chung minh end-to-end o tang connector rang dong log cua CR10-02 gio giu duoc nhan.

## 3. Lease (exact paths)

- du-rework/orchestrator/packages/observability/src/log-events.ts
- du-rework/orchestrator/packages/observability/tests/payload-privacy.test.ts (hoac file test observability phu hop)
- du-rework/orchestrator/packages/observability/dist/** (build artifact - BAT BUOC rebuild, xem ghi chu)
- du-rework/coordination/reports/cr10-02d1-safe-log-messages-2026-10-10.md (receipt)

**Read-only (khong sua):** toan bo orchestrator/services/connector/**, dac biet src/usage-dispatcher.ts. Nhan tai :167 la INPUT cua packet nay, khong phai thu de sua. Neu implementer thay chuoi khong khop thi bao lai, khong tu doi.

**Ghi chu build (da do, load-bearing):** @du/observability resolve ve packages/observability/dist/index.js, KHONG phai src/. Connector test load dist. Vi vay sua src/log-events.ts ma khong rebuild thi acceptance tang connector se khong doi. Script build: packages/observability/package.json -> build = tsc -p tsconfig.json.

## 4. Dependencies / owner

- Phu thuoc CR10-02 da land trong working tree (chua commit). Khong chay song song tren lease connector.
- Khong dung CR10-01, CR10-03, CR10-04.
- Owner: dispatcher chon SAU khi inspect live roster (terminal identity/handle + assignment hien tai). Khong suy owner tu packet CR10-02 - packet do nguoi dung giao truc tiep, khong phai dispatch proof.
- Dispatch proof: ghi request/dispatch ID + acceptance vao receipt. Packet viet ra khong phai bang chung dispatch.

## 5. Acceptance

- [ ] usage dispatch cycle failed co trong SAFE_LOG_MESSAGES.
- [ ] Positive control: metadataLogRecord({ message: 'usage dispatch cycle failed', ... }) giu nguyen nhan.
- [ ] Negative control con xanh: message dong/khong nam allowlist van REDACTED; suite privacy hien co khong regression.
- [ ] Khong them wildcard/prefix/regex; SAFE_LOG_MESSAGES van la Set<string> cac nhan tinh.
- [ ] packages/observability build lai; dist chua label moi.
- [ ] End-to-end connector: chay lai suite CR10-02 va chi ra dong log giu nhan (khong con [REDACTED]), kem literal output + exit code.
- [ ] Offline: khong mo cua so DB/Redis/S3 nao.
- [ ] Khong commit, khong push, khong git add. Khong sua ngoai lease.
- [ ] Receipt ghi: file nao doi, literal + exit code, va xac nhan dist da rebuild (vi du git status cua dist hoac hash file).
- [ ] Independent verifier doc lap voi implementer moi tinh ACCEPTED.

## 6. Receipt path

du-rework/coordination/reports/cr10-02d1-safe-log-messages-2026-10-10.md

## 7. Ngoai pham vi

- Audit toan bo label bi redact o cac service khac (neu vo tinh thay thi ghi nhan; can packet rieng, khong gop vao day).
- Sua usage-dispatcher.ts hay bat ky file nao cua connector.

---

Tuan thu COORDINATOR-CONTRACT: coordinator khong implement product code, khong chay product build/test; packet nay chi la coordination metadata.
