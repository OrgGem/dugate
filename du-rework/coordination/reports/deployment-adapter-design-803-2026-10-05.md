# DEPLOYMENT-ADAPTER-DESIGN-803 - receipt (ACUI-M06 connectorBaseUrls)

> **RESUME POINT (qwen_5, 2026-10-05)** - task DEPLOYMENT-ADAPTER-DESIGN-803 (task_b8e6af746947),
> dispatch ctx_4865988a0a76. **DOC-ONLY**: grep + read only. 0 source edits, 0 commits, no tests run.

---

## 1. Where the connector base URL is read, and why there is no adapter

**Three read sites, all off one boot-time object.**

| Site | file:line | What it does |
|---|---|---|
| Boot composition | `app/bootstrap/create-app.ts:408` | `const connectorBaseUrls = config.connectorBaseUrls ?? {}` - the ONLY place the map is materialised |
| Live connector proxy | `create-app.ts:410-416` | `baseUrlFor` -> 404 `NOT_FOUND` when the id is unconfigured (never an open proxy) |
| Management store | `create-app.ts:421-434` | `Object.values(...)` -> `createConnectorManagementStore`; **empty map => `undefined`** => management surface absent, capabilities report false |
| Credential workflow boot | `create-app.ts:441-444` | Refuses boot if the workflow is requested with no base URL |
| Per-request read | `http/routes/admin.ts:574` | `ctx.config.connectorBaseUrls ?? {}` - **looks runtime, is not**: `ctx.config` is the boot snapshot |
| Type + doc | `server.ts:87-90`, `http/route-context.ts:74-77` | "platform configuration, never caller input"; "Absent = the management surface fails closed (503)" |

**Why there is no adapter - three independent facts, all verified:**

1. `main.ts` **never passes** `connectorBaseUrls`. Its `createApp({...})` call (`main.ts:161`) sets
   `artifactStorage` and friends; grep for `connectorBaseUrls` in `main.ts` returns **0 matches**.
2. **No env/compose key exists.** grep `CONNECTOR_BASE` / `connectorBase` over `.env.example`,
   `docker-compose.yml`, `infra/docker-compose.yml` = **0 matches**.
3. The value is declared **platform config, not caller input** (`server.ts:87-90`), so it cannot be
   derived from a request - it has to come from the deployment surface.

Consequence: on every deployment today the map is `{}`, so the management surface is absent,
`/connectors/:id/test` fails closed 404, and the credential workflow cannot boot. That is exactly the
ACUI-M06 finding, now located to three lines.

**Related honesty gap found while tracing (not in the packet brief):** `admin.ts:580-600` synthesises
a projection (`adapter: "unknown"`, `state: "disabled"`, `capabilities: []`) from the configured base URL
alone instead of calling the connector. So even a *configured* deployment shows a degraded projection
on that legacy-shaped route. The real path is `ctx.connectorManagement` (`admin.ts:560-568`). This is
the ACUI-M03 "fake projection" note, now with a file:line.

---

## 2. Boot-time vs runtime - the distinction that decides the design

**Today it is boot-time only, and the one apparent runtime read is a snapshot.**

- `create-app.ts:408` materialises the map **once**, at boot.
- `admin.ts:574` reads `ctx.config.connectorBaseUrls` - `ctx.config` is the `ServerConfig` object built at
  boot, so this is a **per-request read of a boot-time value**, not a runtime lookup.

That matters because a runtime adapter must be **injected into the request context**, not read from
`ctx.config`. Reading `ctx.config` in a route would silently keep serving the boot snapshot and make the
adapter look wired when it is not.

---

## 3. Minimal contract

New module: `services/orchestrator/src/modules/connectors/connector-base-url-source.ts`

```ts
export interface ConnectorBaseUrlSource {
  /** All configured connector base URLs, keyed by connector id. */
  list(): Promise<Record<string, string>> | Record<string, string>;
  /** One connector base URL; undefined when not configured (fail-closed 404 upstream). */
  resolve(connectorId: string): Promise<string | undefined> | string | undefined;
}
```

Implementations, in rollout order:

| # | Implementation | Reads | Notes |
|---|---|---|---|
| S1 | `StaticConnectorBaseUrlSource` | `config.connectorBaseUrls` | Zero behaviour change; the default |
| S2 | `EnvConnectorBaseUrlSource` | `DU_CONNECTOR_BASE_URLS` (JSON map) | Boot-time, additive, reversible |
| S3 | `DbConnectorBaseUrlSource` | versioned PG table | Runtime; behind a flag |

**Boot wiring** (`create-app.ts:408` becomes):

```ts
const source = connectorBaseUrlSourceFor(config, process.env);
const connectorBaseUrls = await source.list();
```

Everything downstream (`createConnectorProxy`, `createConnectorManagementStore`, the credential-workflow
boot check) is unchanged - they already consume the resolved map.

---

## 4. Rollout order that cannot break a running deployment

Each step is independently deployable and reversible by turning a flag off.

1. **Land S1 + the module.** Boot still reads `config.connectorBaseUrls`; behaviour byte-identical.
   No flag. This is the safe floor.
2. **Land S2 (env).** `DU_CONNECTOR_BASE_URLS` absent => S1. Additive; a deployment that never sets the
   key is unaffected.
3. **Land S3 (DB) behind `DU_CONNECTOR_BASE_URLS_SOURCE=db`.** Default `static`. Only this step changes
   behaviour for anyone who opts in.
4. **Switch `admin.ts:574` to the injected source** - only after S3 exists, and only for requests whose
   tenant scope is resolved. Until then the route keeps reading the boot snapshot.
5. **Flip the UI gate last** (the Connectors pane stops reporting `management:false`).

Ordering rationale: 1-2-3 are pure additions with a default-off path; 4 is the first behaviour change
and must not precede 3; 5 is a UI consequence of 4, not a prerequisite.

---

## 5. What needs user gating

**The base URL is not a secret** (`server.ts:87-90`: "platform configuration, never caller input"), so no
secret handling is required and none should be invented.

But **writing** the map is security-relevant: it decides where a tenant connector traffic goes. So:

- **Read** - not gated beyond the existing admin session/tenant fence.
- **Write** (S3) - must be **user-gated to the platform-admin role** and **audited** (`admin.connector.*`
  audit kind, matching the existing `admin.connector.rotate_credential` pattern).

---

## 6. Packet split (implement-ready)

### Packet 1 - the source module + boot wiring (no behaviour change)

- **Lease:** `modules/connectors/connector-base-url-source.ts` (new), `app/bootstrap/create-app.ts` (one
  hunk at :408), `tests/connector-base-url-source.test.ts` (new).
- **Offline test conditions:** fake source, no DB/Redis/Vault. Assert (i) S1 returns the config map,
  (ii) an empty map yields `{}` and the management store is `undefined`, (iii) `resolve` returns
  `undefined` for an unknown id and the boot check still refuses, (iv) **with the module present but no
  flag set, boot output is byte-identical to today** - that last assertion is the one that proves the
  rollout cannot break a running deployment.

### Packet 2 - runtime source + the route switch

- **Lease:** same module (S3), `http/routes/admin.ts` (the :574 hunk), a contracts DTO for the versioned
  table, a migration, and the admin write action.
- **Offline test conditions:** fake PG store; assert the route reads the **injected source**, not
  `ctx.config`; assert the write action is role-gated and audited; assert the flag-off path still serves
  the boot snapshot.

---

## 7. Ledger

- DEPLOYMENT-ADAPTER-DESIGN-803 - Muc 1 - located ACUI-M06 to three read sites (create-app.ts:408 boot
  composition, :410-416 proxy, :421-434 management store) and proved the absence of an adapter by three
  independent facts (main.ts never passes it, no env/compose key exists, it is declared platform config);
  distinguished boot-time from the snapshot read at admin.ts:574; designed a 3-implementation source
  contract with a 5-step default-off rollout; gated writes to platform admin + audit; split into 2
  implement-ready packets with leases and offline test conditions. DOC-ONLY: no source edit, no commit.
