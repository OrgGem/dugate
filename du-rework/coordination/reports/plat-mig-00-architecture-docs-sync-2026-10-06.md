# PLAT-MIG-00 — architecture/deployment docs sync receipt (2026-10-06)

- Dispatched by: Coordinator message "THONG BAO TU COORDINATOR … OpenCode (oc_2): Nhan write lease doc quyen docs/**"
- Owner: OpenCode (oc_2), docs write lease `du-rework/docs/**`
- Date: 2026-10-06
- Constraints honored: **docs only — no source code, test, Compose, config or spec edits; no commit.** Only the four dispatched files were modified; no other `docs/` file touched by this session.
- Status: **handoff ready for coordinator intake.** No acceptance tick, no `DONE`/`ACCEPTED` claim.

## 1. Changed paths and hashes

| File | SHA-256 after sync | Delta vs pre-sync |
|---|---|---|
| `docs/40-du-platform-architecture.md` | `92B017F37A264DBE9FC393745051B38C4C4442D16C669D722320F2C7DB684D3F` | Naming (DU Platform / Orchestrator Portal / Orchestrator Backend / Connector Service / Business Workers), diagram + port labels, listener table, PM-M02 status, live Docker status |
| `docs/02-architecture.md` | `0120FA685E673EB2BFE7C77DE4012931401C0A885BAF465C163CFF0EDFDBEBBF` | Standard names + header note, 3-tier diagram with ports, Orchestrator Portal bullet, live Docker flow table, historical-section note |
| `docs/09-system-architecture.md` | `C02BE067A3F46383F39981156189CFEEFBBA1E6DB5078A3F70634D8EDAB6816E` | Header/status refresh, diagram labels, §2 live Docker Ingest/Extract evidence (Δ53 closed as scoped live), matrix row, removed corrupted duplicated paragraph |
| `docs/12b-deployment-guide.md` | `6A7DB25BF1BA931443D8679158DEEA3D596242C889B73D0F7B7E9888C6162209` | Standard names, topology table, PM-M02 working-tree status, §1.2 overlay actual state, new §2.1 Ingest/Extract PASS, env-table updates, §3.2 Compose forwarding update, §9 links |

## 2. What was updated (dispatch items 1–4)

1. **Four dispatched files updated** exactly as listed; no other file.
2. **Standard names** — DU Platform, Orchestrator Portal, Orchestrator Backend, Connector Service, Business Workers — applied to product naming across all four. Kept identifiers unchanged by design: `/admin/*`, `/api/v1/admin/*`, `DU_ADMIN_WEB*`, `ADMIN_SHELL_*`, session/CSRF/RBAC; "admin" remains where it names a role/permission.
3. **Ports / listeners** — Public 3000, Internal 3002 (no host publish by default), Orchestrator Portal 3001, Connector Service 8080 (no host publish by default) in diagrams, tables and cross-links. Docs now match the working tree: `compose/orchestrator.yml` (3000/3001 via `${BIND_ADDRESS:-127.0.0.1}`, no 3002), `compose/connector.yml` (no `ports:`), `compose/local-debug.yml` (opt-in loopback 3002/8080), worker fragments default `RUNTIME_URL=http://orchestrator:3002/api/runtime/v1`.
4. **Ingest/Extract PASS 100% on Docker (2026-10-06)** documented with exact operations on isolated namespace `arch-phase-b-20261006`:
   - Ingest `64edc168-c736-4e9f-aebb-71b5aed722cd` — 202 → SUCCEEDED, 1 task / 2 checkpoints, `/result` + download 200, replay 200 same operation ID (`coordination/reports/phase-b-live-summary-2026-10-06.json`).
   - Extract `3191692e-ff4b-479d-9b7b-686e530ba45b` — 202 → SUCCEEDED, 1 task / 3 checkpoints, 1 mock provider call, `/result` + download 200 matching fixture (`coordination/reports/raw/phase-b-extract-resume-prep-2026-10-06/run-summary.json`; `coordination/reports/live-stack-deploy-e2e-2026-10-06.md` follow-up).
   - Both are recorded as **scoped live-local PASS**, not production cutover/VFY; mock provider and absence of MinIO/Vault stated.

## 3. Evidence inputs used (read-only)

- `tasks/DU-PLATFORM-MIGRATION-2026-10-05.md` (plan/name decision/MIG-08 boundary, consolidated live intake).
- `coordination/reports/plat-mig-00-topology-inventory-2026-10-05.md` (frozen topology + prior docs alignment).
- `coordination/reports/live-stack-deploy-e2e-2026-10-06.md`, `phase-b-live-summary-2026-10-06.json`, `raw/phase-b-extract-resume-prep-2026-10-06/run-summary.json`.
- Current working tree: `compose/orchestrator.yml`, `compose/connector.yml`, `compose/local-debug.yml`, root `docker-compose.yml`, `.env.docker.example`, worker fragments.
- Ledger check `coordinator-state.json`: docs/40, 02/03/09/12b are PLAT-MIG-00 scope and other lanes were explicitly excluded — no overlapping writer found.

## 4. Verification performed

- Code-fence balance even in all four files (no broken mermaid/markdown blocks).
- Stale product-name scan: 0 matches for "Admin Portal"/"Admin shell" product labels except the intentional historical row `Admin shell (Orchestrator Portal)` in docs/02; 0 remaining "approved PM-M02 target"/"Compose gap" stale claims.
- Cross-link anchors referenced from docs/40, docs/09 remain valid (`#11-pm-m02-ingress-matrix`, `#1-deployment-topology`).
- `git status` confirms this session touched only the four docs files (other pre-existing working-tree modifications are unrelated and untouched).

## 5. Remaining open items (not closed by docs)

- PM-M02 full acceptance: host TCP check collision (`nginx-ui` owns host 8080) and separate-client firewall probe; Compose/listener materialization alone is not acceptance.
- Extract used a mock `json-http` provider; real-provider, negative and compatibility cases OPEN; Δ48 (Connector fetch artifact bytes for provider) still unproven.
- Connector management end-to-end on Compose (live list/capabilities, credential workflow) still requires PLAT-MIG-01/03/VFY verification.
- Node 24 LTS parity across all workers/template and security scans OPEN.
- MIG-08C folder rename `apps/admin-web` → `apps/orchestrator-portal` and Portal UI labels are a separate portal/build lane; docs use the target name with the current path noted.
- No checklist row ticked; coordinator owns intake and next dispatch.
