# Example Review Business (`@du/example-review`)

`@du/example-review` is the reference standalone business extension proof for the Document Understanding (DU) worker boundary (P7-01 / P7-02). It implements the complete review workflow specifications defined in `tasks/P7-extension-proof.md` and depends on the public `@du/contracts`, `@du/worker-sdk`, and `@du/document-kit` packages plus Node.js built-ins.

## Proven Scope (P7-01 / P7-02 Baseline)

- **Contract-v1 Manifest**: Action `review` with exact wire contract version `1`, BullMQ queue `du-business-example-review-1.0.0`, and declared handler kinds `['review', 'review-item', 'root']`.
- **Strict 1..10 Artifact Schema**: Operation input schema strictly validates `reviewId` (non-empty string <= 128 chars) and `artifacts` (array between 1 and 10 items, each requiring valid `artifactId`).
- **Optional Reasoning Connector Slot**: Manifest declares optional connector slot `reasoning` with capabilities `['chat-completion', 'structured-output']`; child item reviews invoke `ctx.connector.invoke('reasoning', ...)` when bound in context.
- **Bounded Child Review Plan & Join**: Multi-document reviews plan bounded child tasks for each artifact (`kind: 'review-item'`) and yield with `{ kind: 'waiting-children' }` via `ctx.spawn.spawnAndWait` (join policy `all-success`).
- **Optional Approval Wait/Resume Contract**: When `requireApproval: true`, the root handler yields with `{ kind: 'waiting-input', waitId }` via `ctx.wait.waitForInput('approval-wait', ...)` with `contextRef: review://${reviewId}`. Upon resumption with human approval in `ctx.waitResponse`, it incorporates the decision into the final output.
- **Deterministic Aggregate Output**: Aggregates child reviews sorted by `itemIndex` ascending, collects deduplicated failed checks sorted alphabetically, and emits byte-identical JSON output artifacts.
- **Lease-Loss & Cancellation Fencing**: Evaluates `ctx.signal` and `ctx.cancelRequested` at execution and side-effect boundaries; throws `LeaseLostError` on lease loss and cancellation error on abort.
- **Safe Office Evidence Parsing (R1-E Layer 7)**: DOCX/XLSX evidence is parsed through the public `@du/document-kit` factory, which validates archive structure and executes built-in parsers in a terminable worker before review or reasoning. Parse failures fail closed with a redacted business error.
- **Standalone Container Packaging**: Production `Dockerfile` with an exec-form Node command for independent worker deployment.
- **Public Package Boundary**: Uses public shared contracts, worker SDK, and document-kit packages. It still has zero imports from `@du/orchestrator`, `@du/connector`, `businesses/document-core`, or any internal database.

## Deferred Runtime Proof (P7-03..P7-07)

Live cross-service execution of fan-out (`POST /api/runtime/v1/tasks/:id/children`), HITL wait-input (`POST /api/runtime/v1/tasks/:id/wait-input`), dynamic admin version enablement (`PUT /api/v1/admin/businesses/:id/versions/:version/enable`), and v1/v2 rollover remain deferred pending runtime endpoint closeout by the platform lane (Claude / P2-06). The worker implementation uses the public SDK facades and is ready for live verification once those routes land.

## Operation Input Specification

```json
{
  "reviewId": "review-42",
  "artifacts": [
    { "artifactId": "11111111-1111-4111-8111-111111111111", "fileName": "contract.pdf" },
    { "artifactId": "22222222-2222-4222-8222-222222222222", "fileName": "annex.json" }
  ],
  "checks": {
    "has-valid-owner": true,
    "has-retention-policy": true
  },
  "requireApproval": true,
  "enableReasoning": false
}
```

## Output Artifact Specification

The output artifact `${reviewId}.review.json` emitted with role `output`:

```json
{
  "reviewId": "review-42",
  "approved": true,
  "itemCount": 2,
  "reviewsRef": "artifact://...",
  "failedChecks": [],
  "items": [
    {
      "reviewId": "review-42",
      "itemIndex": 0,
      "artifactId": "11111111-1111-4111-8111-111111111111",
      "fileName": "contract.pdf",
      "passed": true,
      "failedChecks": [],
      "reviewedAt": "2026-09-21T00:00:00.000Z"
    },
    {
      "reviewId": "review-42",
      "itemIndex": 1,
      "artifactId": "22222222-2222-4222-8222-222222222222",
      "fileName": "annex.json",
      "passed": true,
      "failedChecks": [],
      "reviewedAt": "2026-09-21T00:00:00.000Z"
    }
  ],
  "approval": {
    "approved": true,
    "note": "Audited and approved",
    "approver": "compliance-officer"
  },
  "summary": "Review review-42 approved (2 item(s) passed)"
}
```

## Commands

From `businesses/example-review/`:

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm run test:unit
```

This package vendors the current contracts, document-kit, egress, observability, and worker SDK source under `vendor/`. Its upstream source paths and SHA-256 hashes are recorded in `vendor/PROVENANCE.json`. The default unit suite is offline; live Orchestrator continuation and admin tests are available only through the explicit `test:integration:workspace` script from the monorepo.

### Docker Build & Run

The package's Compose entrypoint starts only Example Review and connects it to the externally managed `du-worker-net`. The platform services must already be attached to that network under the DNS names `orchestrator` and `valkey`; Runtime traffic uses the internal port `3002`.

From `businesses/example-review/`, copy `.env.docker.example` to `.env.docker.local`, set the existing `EXAMPLE_REVIEW_RUNTIME_TOKEN`, then run:

```bash
docker compose --env-file .env.docker.local config
docker compose --env-file .env.docker.local up -d --build
```

Compose publishes no worker port and does not start or recreate the platform services. The image is built from this directory and includes the vendored source needed by its standalone pnpm workspace. The worker registers and heartbeats through Runtime, receives `SIGTERM` directly, and drains for 15 seconds before Compose's 30-second stop deadline.
