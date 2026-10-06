# W1 CLOSURE REVIEW — Part 3 (P2-FIX + SDK-CONSUME verdicts) — 2026-10-04

**Packet:** W-CLOSURE-P2-SDK (run `run_069ecd6957cd`). **Owner:** Claude Code — REVIEW-ONLY.
READ-ONLY: khong sua source/test, khong tick/commit.
**Evidence:** qwen4.md §W2B-P2 FIX + tester.md §P2-VERIFY (:12588) + receipt
`p730-sdk-consume-2026-10-04.md` + doc lap doc code (`runtime.ts`, `worker.ts`,
`task-context.ts`, `git diff`/`status`).

---

## VERDICT 1 — P2-FIX (tuple check): APPROVED (offline)

Dieu kien HARD (1) tu Part 2 — "P2-FIX land + Tester rerun 3 negative cells +
valid-ref/DD03 controls xanh" — **DA DONG o muc offline**. Du de W1c dung
`credentialRef` ve mat logic.

**Xac minh doc lap tren code:**
- `parsePinnedProfilePolicy(raw, identity)` (`runtime.ts:208-244`): strict
  shape-parse truoc, sau do compare ca 3 thanh phan tuple; mismatch => 422
  `INVALID_SCHEMA`, static message, khong dua gia tri len wire (`:235-241`).
- Identity truyen tu chinh row tai call site (`:1646-1650`:
  `t.tenant_id/profile_id/profile_revision`); SELECT projection co du 3 cot
  (`:332-335`).
- Thu tu tx dung: lease UPDATE (`:391-396`) + op-state UPDATE (`:397-401`) chay
  truoc, `buildClaimResult` sau (`:406`), tat ca trong cung `db.tx` (`:330`) —
  throw se rollback ca hai writes theo co che tx hien co. Khong them co che moi,
  dung nhu receipt mo ta.
- Q1 Part 2 duoc giu: **khong doi DTO** — fix la runtime comparison, khong
  re-freeze checkpoint (a). MEDIUM-2 (tenantId uuid) van la hardening optional
  rieng, khong gan P2.

**Evidence chay (tin theo receipts, nhat quan cheo):**
- Owner (qwen_4): `p730-profile-snapshot` 11/11 (3 case do cu) x3 lan + 4 suite
  lien quan + tsc 0; khong sua test lane khac; Δ-DEVIATION: khong.
- Tester P2-VERIFY doc lap: 2×11/11 exit 0 + DD03 2/2 exit 0; test SHA-256 khop
  Phase B (khong sua test); source review truc tiep `runtime.ts:208-243` +
  `db.ts:24-34` (rollback branch).

**Dieu kien con lai (live, khong phai defect):** live PG proof — chen row lech
tuple, claim phai 422 + lease/state khong doi sau rollback that. Da co san trong
receipt qwen_4 §4 (mo, khong phai bang chung). Thuoc live acceptance, khong chan
W1c o muc logic.

## VERDICT 2 — P730-SDK-CONSUME (W1b seam): APPROVED-WITH-CONDITIONS

Seam claim→context→internal-context **IMPLEMENTED + VERIFIED-OFFLINE**.
Chua the tuyen bo pin-to-prompt ACCEPTED (chinh receipt cung khong claim).

**Xac minh doc lap:** `worker.ts:335-343` truyen du 3 fields tu
`snapshot.pinned` voi comment pin semantics; `task-context.ts:157-159,179-181,302-304`
optional fields + `?? null` giu null semantics (khong gop unmanaged thanh empty).
Semantics "claim la sole authority, khong doc live profile, khong merge lan 2"
co code ung ho.

**Evidence:** focused x3 exit 0 (SDK 32+1todo / document-core 28); full worker-sdk
28 suites / 683 + tsc 0 ca hai phia; 2 test moi co null/absent/retry cases.

**Δ-1 attribution — DONG Y voi receipt (da verify bang git):**
- `config.ts` diff (+1/-1: RUNTIME_TOKEN merge) va `crypto-storage.ts` diff (+chunk)
  la cua lane khac (working-copy, khong thuoc slice W1b). Khong sua la dung.
- `contracts/dist/runtime.d.ts` stale (mtime 18:21, build cua lane producer) gay
  4 suite document-core do bien dich — fix thuoc lease W1 (contracts rebuild) + W2
  (test files), khong phai W1b.

**Dieu kien con lai:**
- (a) **Δ-2 (producer gap):** `runtime.ts:1634` van `promptRevisions: {}` hardcode —
  consumer that se thay `{}` cho toi khi producer dien bucket T-PROM-02 (submit-pin).
  Thuoc lease W1/producer, can packet tiep.
- (b) **Δ-3/Δ-4 (business consumers):** `pickPromptOverride`/precedence van 0 caller;
  resolve Code>Profile>Connector thuoc document-core action consumers + co the can
  contract seam (quyet dinh contracts lane). Can packet tiep, qwen_2 da xong seam
  den TaskContext.
- (c) Δ-1 fix (contracts rebuild + W1/W2 test files) de green lai default jest
  document-core.
- (d) Δ-5 ghi nhan: business giu `ctx.connector.invoke`, khong doi sang
  runConnectorStep trong packet nay — dung chi dao, khong phai gap.

## NOTE — runtime.ts working tree + de xuat commit plan

`git status`/`diff` do truc tiep (working-copy hien tai):

| File | Trang thai | Cua ai |
|---|---|---|
| `services/.../runtime/runtime.ts` | **M +72** (41 dong T-SUB-04 base + tuple fix) | W1 T-SUB-04 + qwen_4 P2-FIX |
| `packages/contracts/src/runtime.ts` | M (re-export PinnedProfilePolicy) | W1 DTO freeze (a) |
| `packages/contracts/src/profile-policy.ts` | **?? untracked** (file moi chua add) | W1 DTO freeze (a) |
| `businesses/document-core/src/config.ts` | M (+1/-1 RUNTIME_TOKEN) | lane khac — KHONG gop |
| `packages/worker-sdk/src/crypto-storage.ts` | M (+chunk) | lane RFX/ENC — KHONG gop |

**De xuat commit plan (coordinator/lane owner thuc hien, toi khong commit):**
1. Commit 1 — frozen DTO (a): `profile-policy.ts` (new) + `contracts/runtime.ts`
   (re-export). Nen co tag/freeze note de W1b lock digest.
2. Commit 2 — W1 producer: `submission.ts` builder + gate + 2 test w1-*.
3. Commit 3 — claim + P2-FIX: `runtime.ts` T-SUB-04 + tuple check (Part 3 verdict nay).
4. Rieng biet: `config.ts` + `crypto-storage.ts` cho dung lane owner — khong bao gio
   gop vao 1-3 ke ca tien tay.
5. Thu tu 1→2→3 giu `git bisect` sach (contract truoc, producer giua, consumer cuoi).
6. Truoc commit 3: chay lai focused P2 (`p730-profile-snapshot` 11/11) tren dung
   tree se commit de digest khop receipt.

## Ngoai pham vi (lap lai, khong doi)

W1c acquisition, live PG/Redis/S3/Vault, browser/Admin-Web mount, MEDIUM-1 parameters
packet (Part 2-Q2 van mo), `.passthrough()` ngoai duong W1 (`connector.ts`,
`usage-metrics.ts`), F-3 dead-404 disposition, DD-06 client type, stale comment
`:227/:260`.

**Khong commit, khong tick. DB window: FREE (lane nay khong giu).**
