# COMP01-G34 — binary side-by-side + per-route error matrix

**Task:** `task_3488ceb038ab` · **Date:** 2026-10-02 · **Status:** receipts-first synthesis, read-only. No gate ticked, no commit, no public wire touched.

Closes **G-3** (binary surfaces never compared) and **G-4** (no per-route error matrix) from my COMP01-CONSOLIDATE receipt. Method follows the spec: **synthesise from the 8 slice receipts first, and read source only where a citation is genuinely missing** — §3 records exactly what I had to open.

## 1. What the 8 receipts already carried (no source read needed)

| Matrix cell group | Source receipt | What it gave |
|---|---|---|
| Binary: rework side | C §2 (L21) | `writeEnvelopeArtifact` writes `application/json` purpose `output`; six `<action>_result.json` artifacts; `/result` projects `data.resultRef` + READY metadata + download links; `/artifacts/{id}/download` serves bytes, **encrypted JSON body when delivery encryption is on**, otherwise streams with the **stored MIME type** |
| Binary: legacy side | D §2 (L36) | preconditions, the two branches (`outputContent` inline vs `outputFilePath` stream), and the status codes 404 / 403 / 409 / 404 |
| Binary: storage backend | H §3.1 | backend chosen **only** by whether `s3_bucket` is set; empty bucket silently falls back to local |
| Errors: lifecycle 5 routes | D §2 (L32–36) | per-route preconditions **and** per-route status codes, plus the explicit note that resume returns a *different envelope* |
| Errors: the two-envelope fact | D §5 `M4` | lifecycle errors mix problem+json and bare `{error}`; resume is the bare one |
| Errors: 404 asymmetry | D §5 `M6` | GET 404 carries `detail` + `requested_id`; DELETE/cancel/download 404s carry neither |
| Errors: list 400 | D §4 (L63) | invalid state filter → `400` with `{error: ...}` |
| Errors: success codes | A §1, A §4 | core async `202` + `Operation-Location`, sync/idempotent `200`; DELETE `204` |
| Errors: schema CRUD | G §1 | all four ops with success and error codes |

## 2. What the 8 receipts did **not** carry (measured, not assumed)

I counted occurrences of each token across all eight receipt files before opening anything:

| Token | A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|---|
| `401` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Content-Type` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Invalid Parameter` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Missing Parameter` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Endpoint Disabled` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Forbidden Field` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Service Not Found` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `problem+json` | 0 | 0 | 0 | **1** | 0 | 0 | 0 | 0 |

**Two consequences worth stating plainly.** First, **no receipt names a single problem+json `title`** — the enum a consumer would actually branch on is absent from all eight, so G-4 could not be closed from receipts alone. Second, `401` and `Content-Type` are absent entirely. The receipts were excellent on *preconditions and status codes* and silent on *envelope shape and response headers*, which is exactly the boundary of the gap they were scoped to.

## 3. Source reads performed, and why each was necessary

The spec permits a read only to fill a missing citation. Four were needed; each is named, and none touched a banned path.

| # | File read | Which missing cell it filled |
|---|---|---|
| R1 | `lib/endpoints/runner.ts:18-26` | the problem+json envelope shape and how `type` is derived from `title` |
| R2 | `lib/endpoints/runner.ts:77,118-122,136-152,180-184,283` | the title/status inventory for the six core submit routes |
| R3 | `app/api/v1/services/route.ts:14-20,80` · `billing/balance/route.ts:20,32` · `billing/usage/route.ts:27,38` | the `401` codes and which of the three use problem+json vs bare `{error}` |
| R4 | `app/api/v1/operations/[id]/download/route.ts:45-55,61-105` | legacy `Content-Type`, `Content-Disposition` and the format→extension mapping |
| R5 | `app/api/v1/docs/workflows/route.ts:23-118` · `.../schema/route.ts:21-112` | workflow + schema-route titles, which no receipt carried |

**Not read, and therefore still open:** `server.ts` (banned), `contracts/src` (banned), `businesses/document-core/**` (banned), and any live/infra suite.

## 4. G-3 — binary surfaces, side by side

One row per binary surface. `R` marks a cell that came from a **source read** because no receipt carried it (§3).

| Aspect | Legacy `GET /api/v1/operations/{id}/download` | Rework `GET /api/v1/artifacts/{id}/download` |
|---|---|---|
| Precondition | row exists, `deletedAt IS NULL`, **`op.done` and `state === SUCCEEDED`** (D §2) | artifact READY; exposed on `/result` alongside metadata (C §2) |
| Success | `200`, streams bytes (D §2) | `200`, streams bytes (C §2) |
| Branch 1 — inline | `op.outputContent` served directly (`:45-55`, **R4**) | none — rework always stores an artifact |
| Branch 2 — file | `op.outputFilePath`; local backend resolves under `OUTPUT_DIR` and returns **404** if the path escapes it; otherwise streams (D §2, `:61-105` **R4**) | storage backend (C §2) |
| `Content-Type` | `` `${contentType}; charset=utf-8` `` (`:54,86,101` **R4**) | **stored MIME type** (C §2) |
| `Content-Disposition` | `attachment; filename="<base>.<ext>"` (`:55,88,103` **R4**) | **not stated in any receipt** — remains open, §6 M-2 |
| Filename derivation | branch 1: `basename(first input file name)` + ext; branches 2/3: `basename(outputFilePath)` (`:50,88,103` **R4**) | unknown |
| Format → extension | `html`→`html`, `json`→`json`, **everything else → `md`** (`:46` **R4**) | n/a — envelope is JSON |
| Encryption envelope | **none** | **delivery encryption on → encrypted JSON body; off → raw bytes with stored MIME** (C §2) |
| Backend selection | S3 iff `s3_bucket` set, else local **silently** (H §3.1) | n/a |
| Errors | `404` missing/deleted · `403` fence mismatch · `409` Not Ready if not SUCCEEDED · `404` No Output if neither branch applies (D §2) | **no status codes recorded in any receipt** — §6 M-1 |

**Two asymmetries a consumer must not discover by experiment:**

1. **`output_format: csv` is served as Markdown.** The legacy mapping at `:46` has branches for `html` and `json` and falls through to `md`, so a CSV result leaves the server as `Content-Type: text/markdown` with a `.md` filename (`:46,:54-55` **R4**). This is the download-surface instance of the format-vocabulary mismatch already registered as `CM-C1` / `CM-G1`-adjacent; it is worth a separate line here because here it is observable in a response header, not only in a declaration.
2. **The filename is derived from different sources in the two branches** — branch 1 from the *input* file name, branches 2/3 from the *output* path. A client that relies on `Content-Disposition` gets a different name depending on which storage shape the operation happened to produce.

## 5. G-4 — per-route error matrix

Three envelopes are in play. Naming them is the point of this table, because **no receipt named a single `title`** and `401`/`Content-Type` were absent everywhere (§2).

| Envelope | Shape | Where it is produced |
|---|---|---|
| **E1 — problem+json** | `{ type, title, status, detail }`, `type` = `https://dugate.vn/errors/<title lowercased, spaces→hyphens>`, overridable per call (R1 `runner.ts:18-26`) | core runner, workflow routes, services |
| **E2 — bare** | `{ error: string }` | resume, billing/balance, billing/usage (D §5 M4; R3) |
| **E3 — bare + fields** | `{ error: string }` plus route-specific extra keys | operations list `400`; operations GET `404` adds `requested_id` (D §4, §5 M6; R1) |

| Route | Envelope | Error codes and titles | Extra fields |
|---|---|---|---|
| 6 × `POST /docs/{ingest,extract,analyze,transform,generate,compare}` | E1 | `404 Service Not Found` (R2 `:77`) · `400 Invalid Parameter` — bad discriminator, which lists the valid values (R2 `:118-122`), and 5 `file_urls` rejections (R2 `:136-152`) · `403 Endpoint Disabled` when the profile disables the endpoint (R2 `:180-184`) · `500 Internal Error` (R2 `:283`) | `detail` is human-readable; the discriminator 400 embeds the valid-value list |
| `POST /docs/workflows` | E1 | `400 Missing Parameter` (`process`) · `404 Workflow Not Found` · `400 Missing Files` · `400 Invalid Profile API Key` · `500 Internal Workflow Error` (R5 `:23-118`) | success is `202` + `Operation-Location`, **not** `formatOperationResponse` (A §3) |
| `POST /docs/workflows/schema` | E1 | `400 Missing Parameter` (`schemaSlug`) · `404 Schema Not Found` · `400 Invalid Schema` · `400 Invalid Input` (unparseable `input`) · `400 Invalid Profile API Key` · `500 Internal Workflow Error` (R5 `:21-112`) | `202` + `Operation-Location` |
| `GET /operations` | E3 | `400` invalid `state` filter (D §4 `:48`) | `{error}` only |
| `GET /operations/{id}` | E1 | `404` missing/deleted · `403` fence mismatch (D §2) | 404 adds **`requested_id`**; the only route that does (D §5 M6) |
| `DELETE /operations/{id}` | E1 | `404` missing/deleted — **no `detail`** · `403` (D §2 `:47,55`) | success `204`, empty body |
| `POST /operations/{id}/cancel` | E1 | `404` · `403` · **`409 Already Completed`** when `op.done` (D §2 `:32-37`) | success returns a formatted envelope |
| `POST /operations/{id}/resume` | **E2** | `404` `{error}` · `400` `{error}` for any non-paused state · `500` `{error: err.message}` (D §2 `:27,31-33,101`) | success `{success, message}` — **not** an operation envelope (D §2, A §4) |
| `GET /operations/{id}/download` | E1 | `404` missing/deleted · `403` · `409 Not Ready` if not SUCCEEDED · `404 No Output` if neither branch (D §2 `:37-42,116`) | path-escape case returns 404 rather than 403 (H/D) |
| `GET /services` | E1 | **`401 Unauthorized`** (R3 `:14-20`) · `500 Internal Server Error` (R3 `:80`) | 404 absent — the catalog is registry-derived, so there is nothing to 404 |
| `GET /billing/balance` | **E2** | **`401` `{error:"Unauthorized"}`** · `404` `{error:"API key not found"}` (R3 `:20,32`) | — |
| `GET /billing/usage` | **E2** | **`401` `{error:"Unauthorized"}`** · `400` `{error:"Invalid date format. Use YYYY-MM-DD."}` (R3 `:27,38`) | — |
| `/internal/workflow-schemas` (4 ops) | E2 | `400` slug required / neither field supplied / validation list · `404 Schema not found` (G §1) | success `201 {ok,schema}`; delete is idempotent — a missing slug still returns `{ok:true}` (G §1.2) |

**The headline for a consumer: the 401 is not one shape.** `/services` returns E1 problem+json with `title: "Unauthorized"`; `/billing/balance` and `/billing/usage` return E2 bare `{error: "Unauthorized"}` for the same class of condition. A single error parser cannot cover all three.

## 6. Missing citations — what remains open

Listed because the acceptance asks for it, and because two of these are the residue of G-3/G-4 rather than something I could close from any source I am permitted to read.

| # | Missing | Why I could not close it |
|---|---|---|
| M-1 | ~~**Status codes on the rework `/artifacts/{id}/download`** — 403/404/409 conditions~~ **CLOSED 2026-10-02 — see §7.1**: 401 (auth), 404 (indistinguishable foreign/missing, anti-leak by design), 409 (not READY / bytes unverified), 200 | closed by the owner-delegated scope extension (§7 preamble); `contracts/src` still unread |
| M-2 | ~~**Rework `Content-Disposition`** on the artifact download~~ **CLOSED 2026-10-02 — see §7.2**: there is **no** `Content-Disposition` anywhere in `server.ts`, and the response is `application/octet-stream` for every artifact. This is a substantive parity gap, not missing data | same authority basis; whole-file grep for Content-Disposition in server.ts returned 0 hits |
| M-3 | **Partially closed 2026-10-02 — see §7.3**: `/artifacts/{id}/download` is now pinned (`HttpError(status, code, detail)`). `/operations` and `/result` remain unread and this row stays **open** | /operations and /result were deliberately not read (§7.3) |
| M-4 | **`400 Forbidden Field`** title on a locked profile parameter during core submit | B §1 states the 400 and the lock precedence, but the title is not in any receipt; I did not open `profile-resolver.ts` because the cell belongs to a route whose error set B already characterises, and one more read would have been scope creep rather than gap-closing |
| M-5 | **Trailing behaviour of the 6 core routes on 202** beyond the `Operation-Location` header | A §1 pins status + header. Whether any other header is set is not recorded anywhere in the receipts and is not needed to close G-3/G-4 |

## 7. What this receipt does and does not establish

- **G-3 is closed on the legacy side and shaped on the rework side.** The two binary contracts are now comparable field by field, and the two asymmetries that matter (`csv` served as Markdown; filename derived from different sources per branch) are pinned to lines rather than inferred.
- **G-4 is closed for the legacy wire**: 13 routes, three envelopes, per-route codes and titles. The rework wire remains partial by design, because the files that would complete it are the ones this spec bans.
- **No new mismatch is asserted as a finding.** The `csv`→`md` observation and the two-401-shapes observation are the same underlying facts already registered as `CM-C1` and `CM-D4`; here they are re-expressed at the response-header level, which is where a consumer meets them. I have not opened new register ids.
- **Read-only held.** Five source reads, all in `app/` and `lib/`, none in a banned path; no file modified; no gate ticked; no commit; no message to `nocobase-10`.
- **No live run, no DB window, no `npm install`** — zero infra was needed, and no behaviour here is execution-verified. Every row is a source-read or a receipt citation.
- **Layer separation preserved.** The `!`-flagged items from the parent slices are referenced where they touch this matrix (fence-mismatch `403`s, the advisory cancel write) and are not re-analysed or reproduced.

## 7. Update 2026-10-02 — M-1 and M-2 closed (authorised scope extension)

> **Authority note.** The G34 spec banned reading `server.ts`. I flagged that ban as the reason M-1/M-2/M-3 stayed open (§6) and left them open rather than routing around it. On the owner's explicit delegation of the judgement ("suggest và tự quyết định phì hợp") I have now read `server.ts` **narrowly** — the single artifact-download route and its error sites — to close them. I am recording the supersession rather than quietly widening scope. §1–§6 are unchanged; only the status of three ledger rows changes.

### 7.1 M-1 — status codes on the rework artifact download: **CLOSED**

| Condition | Code | Detail | Citation |
|---|---|---|---|
| Missing or invalid API key | **401** | thrown by `resolveApiKey` before any row lookup | `server.ts:2053` |
| Foreign, missing, or not-owned artifact | **404** `NOT_FOUND` | **deliberately indistinguishable** — the SQL is tenant-scoped, so a foreign id returns no row and the same 404 is raised as for a nonexistent one; the source comment states this as an anti-leak property | `:2051-2074` |
| Artifact not `READY`, or bytes not integrity-verified | **409** `STATE_CONFLICT` | | `:2080` |
| Success | **200**, bytes streamed raw | | `:2049`, `:2094` |

### 7.2 M-2 — rework `Content-Disposition`: **CLOSED, and it is a real asymmetry**

**There is no `Content-Disposition` anywhere in `server.ts`** (whole-file grep, 0 hits), and the route serves `application/octet-stream` for everything — the stored `mime_type` is selected (`:2055`) but the bytes are **not** re-encoded and the stored type is not used to set the response header (`:2048-2049`).

So the two binary contracts are now comparable, and they differ in a way a client will feel:

| Aspect | Legacy download | Rework artifact download |
|---|---|---|
| `Content-Type` | **derived from the output format** — `html`, `json`, else `md`; sent as `<type>; charset=utf-8` | **`application/octet-stream` for every artifact** |
| `Content-Disposition` | `attachment; filename="<base>.<ext>"` | **absent** — no filename offered |
| Filename source | input file name (inline branch) or output path (file branch) | none |
| Integrity | none at this layer | row must be `READY`; 409 otherwise |
| Tenant fence | **opt-in header** — absent header means no check (MUST-NOT-REPLICATE, `CM-D13`) | **mandatory** — `a.tenant_id = $2` from the resolved key |
| Encryption | none | delivery-encryption policy resolved per request (`:2099`), bounded read then encrypt (`:2106-2107`) |

The legacy side sets a type and a filename; the rework side sets neither. A consumer that relied on the filename to name a downloaded result gets nothing from rework.

### 7.3 M-3 — partially closed

For `/artifacts/{id}/download` the envelope is now pinned: `HttpError(status, code, detail)` at `:2074` and `:2080`, against the 401 from `resolveApiKey`. **`/operations` and `/result` remain unread** — the ban I extended past was scoped to the artifact route, and I did not use it as a licence to sweep the file. M-3 stays open for those two.

### 7.4 Net effect on the §4 table

The binary side-by-side in §4 is no longer asymmetric on headers. Rows **Errors**, **`Content-Disposition`**, and **`Filename derivation`** for the rework column were "not stated in any receipt" — they are now filled, and two of them turned out to be **substantive differences rather than missing data**. The one row I did **not** fill is the rework-side error envelope for `/operations` and `/result`.
