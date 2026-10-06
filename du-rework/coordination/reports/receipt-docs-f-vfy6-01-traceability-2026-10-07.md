# Receipt — docs traceability cho F-VFY6-01 (boot policy & profile cipher) — qwen_2 — 2026-10-07

**Task:** Cap nhat `docs/41-persistence-encryption-policy.md` + `docs/12b-deployment-guide.md:107` dong bo voi F-VFY6-01 (Claude Reviewer §13.3; spec `spec-f-vfy6-01-boot-policy-2026-10-06.md` §5/§8).
**Scope:** 2 docs ONLY. **Khong commit, khong push** (code freeze).

## 1. docs/41-persistence-encryption-policy.md — field inventory

Them **dong 21** vao bang §3 (sau dong 20):

```
| 21 | `profile_bindings.file_url_auth_cipher` (profile cipher) | `modules/profiles/file-url-auth.ts` |
  profile upsert/read, file-url download | PG `profile_bindings` |
  profile cipher (SHA-256 cua `ENCRYPTION_KEY` hoac `NEXTAUTH_SECRET`) |
  `ENCRYPTION_KEY` / `NEXTAUTH_SECRET` |
  **ENFORCED** — keyless boot refused in real-data mode khi artifact encryption bat (khong synthetic exemption) |
```

**Diffstat:** `1 +` (append 1 dong).

## 2. docs/12b-deployment-guide.md:107 — ENCRYPTION_KEY

Dong bien `ENCRYPTION_KEY` bo sung ro:

```diff
- | `ENCRYPTION_KEY` | stable profile cipher secret, retain across deployments |
+ | `ENCRYPTION_KEY` | stable profile cipher secret, retain across deployments. **Required when artifact
+   encryption is enabled in real-data mode — boot is refused if absent** (no synthetic exemption);
+   profile cipher key la SHA-256 cua `ENCRYPTION_KEY` **hoac** `NEXTAUTH_SECRET`, ca hai absent la
+   hard error at use. F-VFY6-01 |
```

**Diffstat:** `2 +-` (1 sua 1 dong).

## 3. Kiem tra toan ven (literal)

**OpenAPI validator** — cwd `du-rework`:

```
python tools/openapi/validate_openapi.py
paths=58 x-absent=9
SC-CB-CANONICAL-SCHEMAS-VALIDATED count=37 refs=resolved operationIds=unique
OPENAPI-EXAMPLES-VALIDATED
Exit Code: 0
```

**Diffstat tong:**

```
git diff --stat -- du-rework/docs/41-persistence-encryption-policy.md du-rework/docs/12b-deployment-guide.md
 du-rework/docs/12b-deployment-guide.md             | 2 +-
 du-rework/docs/41-persistence-encryption-policy.md | 1 +
 2 files changed, 2 insertions(+), 1 deletion(-)
```

## 4. Nguon doi chieu

- Spec `spec-f-vfy6-01-boot-policy-2026-10-06.md`:
  - `:29` "Neither blanket warn-only nor unconditional refuse is correct" — HYBRID.
  - `:34` "the seam boundary, not the process boundary, is where fail-closed belongs".
  - `:39` "Only an explicit synthetic-data mode may opt out".
  - `:47` profile key = SHA-256 cua `ENCRYPTION_KEY` **hoac** `NEXTAUTH_SECRET`; ca hai absent = hard Error at use (`file-url-auth.ts:37-46`).
  - `:51` real-data mode da refuse boot voi Vault artifact surface thieu/mot phan (`boot-options.ts:198-235`, `main.ts:242-249`).
- Docs da ghi dung HYBRID: **refuse boot** o real-data mode (artifact seam bat) + **khong** doi process boundary cho dev/offline; khong vuot qua synthetic exemption.

## 5. Gioi han

- **Khong commit, khong push, khong tick.**
- Docs-only; khong sua code. Khong sua `docs/21-openapi.json`.
- Khong xac nhan implementation F-VFY6-01 trong receipt nay — do la viec cua lane implement + verifier (Claude §13.3 / VFY). Receipt nay chi dong bo **tai lieu** voi chinh sach da duoc phe duyet.

## 6. File da ghi

`du-rework/docs/41-persistence-encryption-policy.md`, `du-rework/docs/12b-deployment-guide.md`, receipt nay.
