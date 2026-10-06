# SWAGGER-ORIGIN-DOCS-ALIGNMENT — receipt

Task: `task_e3ac2ee91d2e` (ctx_8c442a0af8e4). Date: 2026-10-06.
Mode: generator + regenerated artifact only; `docs/21-openapi.json` was **not** hand-edited (every write was a
`python du-rework/tools/openapi/gen_openapi.py` run). No commit, no tick, no push.

## 1. Outcome

- `tools/openapi/gen_openapi.py` now stamps every operation with the origin of its **PM-M02 ingress family**:
  Public JSON `http://localhost:3000`, internal JSON (admin/management and runtime) `http://localhost:3002`,
  Connector service `http://localhost:8080`. The previous single legacy default `http://localhost:2023` is gone
  from the artifact (0 occurrences).
- Origins are deployment-configurable at generation time through
  `DU_OPENAPI_PUBLIC_ORIGIN` / `DU_OPENAPI_INTERNAL_ORIGIN` / `DU_OPENAPI_CONNECTOR_ORIGIN`
  (`http(s)`-validated, trailing slash stripped).
- Every operation also carries `tags: [<family>]` and `x-api-family: <family>`, plus a root `tags` list, so a
  Portal Swagger UI can filter Public / Admin / Runtime / Connector and resolve the correct origin per group
  instead of inheriting one global default.
- `info.version` 1.2.0 → **1.3.0**; the info description records the family-origin model and states that
  Try-it-out stays disabled by default in any Portal rendering.
- **Swagger UI status (item 2):** there is no Swagger UI source in the current Portal (`apps/admin-web`) or in the
  Orchestrator source that could hold a separate origin configuration (search evidence in §5). The generated
  artifact's `servers` is the single origin source any future Swagger UI consumes; this packet aligned it
  per family and added the machine-readable family metadata. The `/admin/web/api-docs` UI slice remains open and
  must not hardcode origins (see §5).

## 2. Changed paths and hashes

| File | Before | After |
|---|---|---|
| `docs/21-openapi.json` | `346A30FA7F7A502127AD36BDA2D350A440BA3EDD42A481F142FCD70A8F3D3268` (pinned by VERIFY-PLAT-MIG-03-905) | `BB6875EC39013DC4D99D6078734FD212DE6A9267366184F12F9287392630CA8D` |
| `tools/openapi/gen_openapi.py` | `13BCCB0638E0F3894859569AD3C17282B7EAE00672BA4AD1D91054CDECBBE0CB` (pinned by PLAT-MIG-03 / its verification) | `4794C87B35EF6EEA389E7649D06BBDAE2AA5D7B531A8D7BDA62D9BFD3D2AE66B` |

Artifact size 90,056 → 107,349 bytes. `git status` for this packet shows exactly these two tracked files modified
plus the new untracked receipt/evidence paths; no other product file was touched.

Generator change anchors (current file):
`PUBLIC_ORIGIN/INTERNAL_ORIGIN/CONNECTOR_ORIGIN` at :55-57, family stamping (`CONNECTOR_PATHS`, `_family_of`,
servers/tags/x-api-family) at :752-770, version/origins/tags literal at :771, post-write origin guard at :805-824,
print now includes origins at :870.

## 3. API family → origin matrix (regenerated artifact)

| Family | Origin | Operations | Examples |
|---|---|---|---|
| `public` | `http://localhost:3000` | 12 | `GET /health`, `GET /api/v1/health`, `GET /api/v1/operations`, `GET /api/v1/operations/{id}`, `GET /api/v1/usage/events`, `GET /api/v1/connectors/{id}/test`, `GET /api/v1/artifacts/{id}/download`, `POST /api/v1/businesses/{id}/actions/{action}` |
| `admin` (management) | `http://localhost:3002` | 10 | `POST /api/v1/admin/actions`, `GET /api/v1/admin/connectors`, `GET /api/v1/admin/connectors/capabilities`, `GET /api/v1/admin/audit`, `POST /api/v1/admin/profile-bindings` |
| `runtime` | `http://localhost:3002` | 18 | `POST /api/runtime/v1/tasks/{id}/claim`, `PUT /api/runtime/v1/tasks/{id}/steps/{step}`, `POST /api/runtime/v1/usage-events` |
| `connector` | `http://localhost:8080` | 17 | `GET /capabilities`, `GET/POST /connectors`, `POST /invocations`, `GET /invocations/{id}`, revision lifecycle |

Full per-operation lists are in `evidence/family-matrix-check.log`. Before the change, 40 of 57 operations had no
`servers` entry at all and inherited the top-level `http://localhost:2023`; only the 17 Connector operations
carried the correct 8080 origin.

## 4. Verification (real commands, real exit codes)

Cwd `D:/Git/dugate` unless noted; raw logs under `coordination/reports/raw/swagger-origin-docs-alignment/`.

| Command | Exit | Observed | Evidence |
|---|---|---|---|
| `python du-rework/tools/openapi/gen_openapi.py` (run 1) | 0 | `path-count=54 … dropped-paths=0 schemas=14 origins=public:http://localhost:3000\|internal:http://localhost:3002\|connector:http://localhost:8080` | `gen-run1.log` |
| same (run 2, determinism) | 0 | identical output line; artifact SHA-256 identical both runs | `gen-run2.log` |
| `python du-rework/tools/openapi/validate_openapi.py` | 0 | `paths=54 x-absent=7` … `OPENAPI-EXAMPLES-VALIDATED` | `validate.log` |
| `python …/check_families.py` | 0 | 0 failures: top-level servers 3000 + 4 tags; every operation's `servers`/`tags`/`x-api-family` matches its family; same 54 paths, same 57 operations, same `components.schemas`, same `x-absent`; no `localhost:2023`; after histogram `{3000:12, 3002:28, 8080:17}` | `family-matrix-check.log` |
| override run: `set DU_OPENAPI_PUBLIC_ORIGIN=https://api.du.example && set DU_OPENAPI_INTERNAL_ORIGIN=https://internal.du.example && set DU_OPENAPI_CONNECTOR_ORIGIN=https://connector.du.example && python …` | 0 | output reports the three override origins; artifact carries 58 override URL sites (12 + 28 + 17 + top-level) | `gen-override.log` |
| restore: plain generator run | 0 | artifact SHA-256 back to `BB6875EC…` | `gen-restore-default.log` |
| `pnpm --filter @du/connector exec jest --runTestsByPath tests/plat-mig-03-root-contract.test.ts …` (4 suites, cwd `du-rework`) | 0 | **40 passed, 40 total**, 0 failed, 0 skipped; includes the root-contract suite that parses `docs/21-openapi.json` and asserts the Connector origin stays `http://localhost:8080` | `connector-40.log`, `connector-40-jest.json` |
| `findstr /S /I /M "swagger SwaggerUI swagger-ui tryItOut try_it_out" apps\admin-web\src\*.* services\orchestrator\src\*.ts` (cwd `du-rework`) | 1 (no match) | no Swagger UI source / no hardcoded Try-it-out config found | `swagger-ui-search.log` (empty) |

## 5. Swagger UI configuration mapping (item 2)

- **No Swagger UI implementation exists yet.** The only "docs" screen is
  `apps/admin-web/src/features/docs/docs-screen.tsx` (CFGADM-11): a hand-built endpoint catalog + profile-test
  workbench over the same-origin `/admin/api` BFF; it does not read `docs/21-openapi.json` and holds no API-family
  origins. The findstr search over Portal and Orchestrator sources returned zero matches for any Swagger UI or
  Try-it-out configuration. There is therefore no UI-side origin config that could point at the wrong listener
  today; the artifact is the config surface.
- **What this packet guarantees for the UI slice:** each operation already declares (a) its family origin in
  `servers`, (b) `tags` + `x-api-family` for Public/Admin/Runtime/Connector grouping and filtering, and (c) a root
  `tags` list with family descriptions. A view derived from this artifact needs no origin guessing and no second
  inventory.
- **What the future `/admin/web/api-docs` slice must still do (left open, per MIG-03 Swagger slice):** serve this
  generated spec via the authenticated shell/BFF path with offline assets; group/filter by `tags`/`x-api-family`;
  keep **Try-it-out disabled by default** (the spec description states this; the UI must enforce it, not publish
  3002/8080 or add BFF proxy/CORS just to make calls); and read origins from the artifact instead of hardcoding
  them. If the Portal wants to rewrite origins per deployment at serve time, that must be a deterministic transform
  over the same artifact (same inventory, no hand-edit), not a second spec.
- Deployment generation-time overrides are named in §1. Defaults use `localhost` because the PM-M02 host mapping is
  loopback-first; deployments set their real front-door origins when generating/packaging.

## 6. Current vs target, limitations

- PM-M02 target says internal 3002 and Connector 8080 are **unpublished by default** and internal access is
  opt-in via the loopback debug overlay (`docs/12b` §1.2). This packet only labels origins in the spec; it does
  not publish any port, change Compose/listeners, or enable Try-it-out.
- The internal listener also serves public handlers because BFF operations/usage reads use them (`docs/12b` §1.1);
  the spec labels each public handler with its canonical public family origin 3000 as instructed, while BFF/admin
  callers may still use 3002. A Swagger UI must not present 3002 as a public front door.
- Prior PLAT-MIG-03 verification pinned docs21 `346a30fa…`; that hash is **superseded** by `BB6875EC…`. The 4-suite
  Connector regression (40/40) passes on the new artifact, but independent VFY/Claude review should re-confirm on
  the new hash before any acceptance decision.
- Validation scope: the existing example validator (zod contract probe) ran; no `redocly lint`/spectral run was
  performed. Jest printed a workspace dependency engine WARN (`wanted node>=24.21.0`, current v22.16.0) during the
  test run; exit code 0 and unrelated to this change.

## 7. Evidence index (`coordination/reports/raw/swagger-origin-docs-alignment/`)

| File | SHA-256 |
|---|---|
| `21-openapi.before.json` (pre-change artifact) | `346A30FA7F7A502127AD36BDA2D350A440BA3EDD42A481F142FCD70A8F3D3268` |
| `gen-run1.log` / `gen-run2.log` / `gen-restore-default.log` | `205FC1F3603B0C4F1BF54F80E3107EEC0A3D9E9EBC7BF840DBC308EFAC352A20` (each) |
| `gen-override.log` | `9205255D41513E55B9DAFBB2D0E37BABE7B15FB342CCBE5C10C74A395CD046D9` |
| `validate.log` | `284D37FFCBFD37A050541CF4FE31260FDFC15D8092F2BB2CFBEB4164F26B88B1` |
| `family-matrix-check.log` | `1184E39A0C2E99CE4DDD341AF441AAC7ED41AA23C2142BAC4AC235D34F4CF1E7` |
| `artifact-samples.log` | `CE7E35C6A5FBBABFF19381AB016C7BF932F1E26F5437FF487D8097E209B34EF7` |
| `connector-40.log` | `761565B556944F81F06D2AE96AAD926FE602023A5F0009590F2E483C7CA9AC62` |
| `connector-40-jest.json` | `3F4AE85FD58F03A9C0D3FEAE2010B0DCECAC2EEEE05AA30DECA535321D135735` |
| `connector-root-contract.log` | `B5AD2595ECFFBDE7C5ACB6D2E0E5918AC914A6EE97E458D67EBDA36B38A9C6EA` |
| `connector-root-contract-jest.json` | `144F9044179E72EA97822AF53A1306B48EFAAA463985558DC4F1A345587077DE` |
| `swagger-ui-search.log` (empty = zero matches) | `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |
| `check_families.py` | `0FC6B77D922B84F6B1F0B43B775359A2C926D655375650F1A4C8DA0A0A1986FE` |
| `show_samples.py` | `F98C65F6D42C30D2A44CB841A83CDDDA044BC7FAE0D80A5D0CAE7FB56B0DB900` |

## 8. Dispatch checklist

1. Review `docs/21-openapi.json` + generator for PM-M02 origins — done; legacy global 2023 and 40 unset operations
   found and fixed in the generator (§2-§3).
2. Swagger UI per-family origin — spec-level config aligned per family with filter metadata; no Swagger UI source
   exists to mispoint (search evidence §5); remaining UI slice stated. This packet does not claim the UI slice.
3. Generator only, no hand-edit — docs21 written exclusively by generator runs (determinism + hashes §2/§4).
4. Receipt — this file.
