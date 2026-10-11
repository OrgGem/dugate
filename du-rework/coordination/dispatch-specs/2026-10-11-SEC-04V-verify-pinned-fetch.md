# Dispatch Spec: SEC-04V — Verify doc lap ban sua HTTP 204 (read-only)

| Muc | Gia tri |
|---|---|
| Task ID | SEC-04V |
| Ngay | 2026-10-11 (Asia/Bangkok) |
| Repo scope | du-rework |
| Owner | PENDING — chon sau khi inspect runtime (xem §4) |
| Lease | **READ-ONLY**. Khong sua file nao |
| Canonical plan | `coordination/PLAN-SECURITY-ORCHESTRATOR-2026-10-11.md` §2 SEC-04V |
| Receipt | `coordination/reports/verify-sec-04-pinned-fetch-2026-10-11.md` |

## 1. Vi sao

Review `orchestrator-security-review-2026-10-11.md` bao HTTP 204 khong co body giet tien trinh Node.
Verify doc lap `verify-orchestrator-security-INDEPENDENT-DSH2-2026-10-11.md` xac nhan 4/4 finding.
Ban sua da co san tren dia: `receipt-sec-04-pinned-fetch-impl-2026-10-11.md` (3 suites / 35 test pass).
Task nay **khong sua gi**, chi can doc lap lai.

## 2. Lease va rang buoc

- **Doc lap tuyet doi.** Khong sua code, khong sua test, khong sua migration, khong sua compose.
- **Khong chay build/product test cua lane khac.** Chay suite egress cua ban sua.
- **Khong `git add` / `commit` / `push`.** Khong tick gate.
- **Verifier phai khac implementer** — nguoi khong phai `term_cd3c19e4` (Codex, da implement).
- Khong in ciphertext, khong in secret.

## 3. Bang chung file:line (da verify 2026-10-11)

```
packages/egress/src/pinned-fetch.ts
  :126        if (body === null || body === undefined) return {};
  :358        hasNoBody = requestMethod === 'HEAD' || [204, 205, 304].includes(responseStatus)
  :370        fulfill(new Response(null, responseInit))
```

Receipt implementer cu: `coordination/reports/receipt-sec-04-pinned-fetch-impl-2026-10-11.md`.
Receipt verify cu (da co, 4/4): `verify-sec-04-pinned-fetch-INDEPENDENT-DSH2-2026-10-11.md` — **can chay lai doc lap**, khong tin receipt.

## 4. Bang chung dispatch

Runtime: `orca terminal list --json` (live, khong dung ledger `DISPATCH-LIVE-2026-10-10.md` la `term_ae2d7e42` da `exited`).
Antigravity (`term_be856c75-900d-474d-8405-ab3f178082b6`) la dispatcher duy nhat.

**Owner de xuong:** PENDING. Phep giao: **khong co ID khong co bang chung dispatch.** Ghi request/dispatch ID vao receipt.

## 5. Tieu chi hoan thanh

- [ ] Chay lai suite `packages/egress` toan bo, ghi so pass/fail thuc te.
- [ ] Xac minh 204 khong crash: co probe 204 loopback mo phong, exit code khong phai signal.
- [ ] Xac minh HEAD/204/304 duoc xu ly dung, va body rong khong phai crash.
- [ ] Khong sua file nao. Receipt: 0 ky tu nhay kep ASCII, co command + exit code.

## 6. Hanh dung dung

Khong sua file san pham. Khong `git add`/`commit`/`push`. Khong tick gate. Khong tu nhan task nay da ACCEPTED.
Neu tim thay finding moi: ghi nhan vao receipt, **khong** sua — task nay la verify.
