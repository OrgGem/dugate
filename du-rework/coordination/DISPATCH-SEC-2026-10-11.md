# Dispatch Log — SEC wave 2026-10-11

Coordinator = Claude Code (token owner). Dispatcher = Antigravity.
No commit, no `git add`, no push, no gate tick, no ASCII double-quote chars.

---

## D-SEC-20261011-01 — gui 5 task SPEC cho Antigravity

- **Thoi diem gui:** 2026-10-11 (Asia/Bangkok)
- **Kenh:** `orca terminal send --terminal term_be856c75-900d-474d-8405-ab3f178082b6 --text ... --enter --wait-submit 20 --json`
- **requestId:** `8969022d-3383-4e09-8759-75c2ac7c1112`
- **processIncarnation:** `cd8c9ed7-6d80-4631-a12e-464f6f684ae4`
- **runtimeId:** `103b75ef-947d-4372-80bd-41010d8c6c7e`
- **warnings:** `input was accepted, but this provider cannot report delivery. Inspect the terminal before retrying.`

**Nhan dang quyen giao (runtime that, khong phai ledger):**

| Handle | Agent | Trang thai khi gui |
|---|---|---|
| `term_be856c75-900d-474d-8405-ab3f178082b6` | antigravity | `status: running`, `connected: true` |
| `term_e97ba66f-1196-401d-8e69-5287bd788b9d` | codex | `connected: true`, title `Sửa retry OR10-04 snapshot` |
| `term_cd3c19e4-9328-4f99-bc26-8b87f195a5e4` | codex | `connected: true`, title `Echo READY` |
| `term_19edcad8-d8d8-4930-a6a2-24f5f8be5bd8` | claude | `connected: true` |
| `term_4bca69af`, `term_16fef1c3`, `term_25de3310`, `term_bd1937f8`, `term_c89675a0` | qwen-code | `connected: true` |

**Bang chung:** `8969022d-3383-4e09-8759-75c2ac7c1112`. Co ID nay **la** bang cheng dispatch that.

## Noi dung gui

5 spec, theo thu tu SEC-04V -> SEC-01 -> SEC-01F -> SEC-03 -> SEC-02-COUNT:

```
du-rework/coordination/dispatch-specs/
  2026-10-11-SEC-04V-verify-pinned-fetch.md
  2026-10-11-SEC-01-cutover-legacy-admin.md
  2026-10-11-SEC-01F-tenant-credential-fetchers.md
  2026-10-11-SEC-03-verify-encryption-policy.md
  2026-10-11-SEC-02-COUNT-readonly.md
```

- **The che `2026-10-11-AWEB-ORIGIN-CREDENTIAL-COUNT.md`:** da danh dau `DA BI THEO` o §9 cua no. Khong dispatch lai.
- **Serialize:** SEC-01 + SEC-01F cung cham `tests/sec-or-01-legacy-read-scope-offline.test.ts`; SEC-03 + SEC-02 cung cham `ingestion-consumer.ts`.
- **Owner:** con `PENDING` trong ca 5 file — Antigravity phai inspect runtime that roi gan.

## Quyet dinh kien truc da chot, khong hoi lai (coordinator = system architect)

| # | Quyet dinh |
|---|---|
| 1 | SEC-01F §3.1: `businesses` phai doi endpoint sang `GET /api/v1/admin/tenants/:tenantId/businesses` (`src/http/routes/admin.ts:478`), khong phai doi token |
| 2 | SEC-01F §3.3: viewer mat legacy `businesses` la **dung** — fail-closed, 403; khong phai mat chuc nang vi SPA co man rieng |
| 3 | SEC-01: cutover het be mat legacy admin, **khong port gi**; tieu chi nghiem nhat la portal moi khong bi loi |
| 4 | SEC-03 §2 B1-B4: mot ham `resolveEncryptionRequirement`, ca 4 duong (`create-app.ts:492,508,528,655`) doc no; migration window **khong** ap cho `:655` |
| 5 | SEC-02: buoc do la read-only; **buoc phep duyet khong tu dong** — backfill im lang se lam he thong trong an toan ma that ra khong |

## Phan coordinator khong tu kiem

- Chua doc lai sau khi gui de chac chan Antigravity da hien prompt (read terminal bi block boi classifier, khong do qua duoc khac).
- Chua co nao la dispatcher da nhan hay da bat dau chay. Khi co request/dispatch ID tu phia nguoi nhan, phai ghi vao day.
