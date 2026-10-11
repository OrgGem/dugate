# REVIEW-809 / A11 / A17 — data-state document check

**Scope result: final requested wording is already present in the working tree. This lane made no document edits.** The full `du-rework/docs/04-data-state.md` was read before any action. No source/test/config files were touched; no tests or live infrastructure were run. No commit, push, or gate tick.

The Git top-level is `D:/Git/dugate`; commands were scoped to `du-rework/docs/04-data-state.md`.

## Both requested locations

The “before” values below are the committed HEAD text, compared with the working tree at the start of this lane. The working-tree corrections predated this lane.

**(1) Line 93 — backfill-window plaintext state**

Before (HEAD, line 93):

> - Metadata DB (`operations.input_ref`, `tasks.payload_ref`, outbox, queue, log) không chứa inline plaintext nội dung tài liệu; chỉ chứa encrypted reference, hash và metadata không nhạy cảm.

After/current working tree (line 93):

> - Trong backfill window hiện tại, Metadata DB vẫn có thể chứa nội dung legacy ở dạng plaintext-readable theo backfill best-effort; chỉ sau khi window switch và backfill hoàn tất mới chỉ chứa sealed envelope, hash và metadata không nhạy cảm.

**(2) Line 100 — sealed slot count**

At the start of this lane, line 100 was already correct in both HEAD and the working tree; it already says 8 and includes `step_checkpoints.session_ref`. No edit was made. The before/current line is:

> Metadata/control-plane encryption giờ có **8 slot** được seal (`METADATA_SLOTS`, `orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts`): `operations.input_ref`, `tasks.payload_ref`, `human_waits.response_ref`, `step_checkpoints.output_ref`, **`step_checkpoints.session_ref`**, `operations.prompt_overrides_ref` (carrier Δ-PC-1) và **`tasks.result_ref` + `operations.result_ref`** (ENCMETA-RESULTREF, Option A — hai slot vì cùng một chuỗi nằm ở HAI row; AAD bind `(tenant, slot, refId)` nên replay chéo row ⇒ `CONTEXT_MISMATCH`).

## Verification commands

All document commands ran from `D:/Git/dugate`.

| Command | Exit | Literal result |
|---|---:|---|
| `git diff -- du-rework/docs/04-data-state.md` | 0 | One hunk replaces line 93 only; line 100 is not in the diff. Raw output: `coordination/reports/raw/review809-data-state-2026-10-09/02-doc-diff.txt`. |
| `git diff --numstat -- du-rework/docs/04-data-state.md` | 0 | `1\t1\tdu-rework/docs/04-data-state.md` |
| `rg -n -i '7\s+slot|Metadata DB.*không chứa inline plaintext|Metadata DB.*chỉ chứa encrypted reference' du-rework/docs/04-data-state.md` | 1 | No matches; recorded as `RESULT=NO_MATCHES` (exit 1 is the expected “no matches” result). |
| `rg -n 'Trong backfill window hiện tại|8 slot|step_checkpoints.session_ref|AAD bind' du-rework/docs/04-data-state.md` | 0 | Lines 93 and 100 matched. Full literal output is in `coordination/reports/raw/review809-data-state-2026-10-09/04-current-claims-grep.txt`. |
| HEAD/current line comparison from `git show HEAD:du-rework/docs/04-data-state.md` | 0 | Line 100: `DOC_LINE100_EQUAL_HEAD=True`; line 93 differs between HEAD and the already-correct working tree. |

Git emitted a CRLF-to-LF normalization warning while reading the diff; this lane did not rewrite or normalize the document.

## Other statements reviewed

No other unconditional claim that metadata references imply plaintext is absent was found in the full file. Lines 90-91 describe plaintext **DEK** exclusion and encrypted artifact payloads, not the metadata row’s legacy content state. Line 96 describes ciphertext sent to the artifact storage backends. Lines 102 and 106-111 explicitly preserve the backfill-window plaintext-readable status and distinguish shape from completed protection. No out-of-scope wording was changed.

`tests/migrations.test.ts` was not run and is not counted as passed; `jest.unit.config.cjs:18` excludes it. No test suite was run in this documentation-only lane.

Raw evidence directory: `du-rework/coordination/reports/raw/review809-data-state-2026-10-09/`.

