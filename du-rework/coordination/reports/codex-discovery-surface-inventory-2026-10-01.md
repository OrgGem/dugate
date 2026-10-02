# Discovery Surface Inventory: Legacy `GET /api/v1/services` vs Rework

**Scope:** Read-only source characterization for COMP discovery. This is a source-derived inventory, not a live HTTP observation. No tests were run. No gate or COMP row was changed.

## Findings at a glance

- Legacy source defines six core action groups with **31 sub-cases**. The same `SERVICE_REGISTRY` object also has a seventh `workflows` group with three cases. Since `getAllEndpointSlugs()` flattens every top-level group, the unfiltered legacy catalog has **7 service groups / 34 cases**.
- Rework's `document-core` manifest defines six actions and **28 quoted enum values**.
- The core 31-to-28 inventory delta consists exactly of `extract:type=id-card`, `analyze:task=fact-check`, and `analyze:task=summarize-eval`. The document-core input normalizer rejects these three values. This records the observed source mismatch only; it is not a COMP-00 decision.
- Legacy `GET /api/v1/services` returns an API-key-filtered list with per-case labels, descriptions, and parameter schemas. It does not return connection chains, explicit lock flags, or an enabled field.
- Rework `server.ts` has no public `GET /api/v1/services` or public manifest/list route. It has a manifest-backed profile GET under admin authorization; that response is not key-filtered discovery.

## 1. Legacy `GET /api/v1/services` wire shape

Source: `app/api/v1/services/route.ts:8-83`.

A request without `x-api-key-id` returns HTTP 401 with the following keys and value types (the localized detail is a string):

```json
{
  "type": "https://dugate.vn/errors/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "<string>"
}
```

For a request that reaches the catalog query, the HTTP 200 JSON shape is:

```json
{
  "status": 200,
  "message": "<string>",
  "services": [
    {
      "serviceId": "<service slug>",
      "serviceName": "<service display name>",
      "discriminatorKey": "<service discriminator name>",
      "subCases": [
        {
          "id": "<case key, or _default>",
          "displayName": "<case display name>",
          "description": "<case description>",
          "clientParameters": {
            "<parameter name>": {
              "type": "<string | number | boolean | array | object>",
              "description": "<parameter description>"
            }
          }
        }
      ]
    }
  ]
}
```

The route's fixed success message is `Lấy danh sách các dịch vụ AI khả dụng thành công.` (`app/api/v1/services/route.ts:68-75`). The parameter schema may additionally contain `required`, `options`, and `default` properties as defined by `ParamSchema` (`lib/endpoints/registry.ts:7-15`). The route copies the schema value and does not construct an enabled/locked/connection property. Its catch path is HTTP 500 with `{ "type": string, "title": string, "status": 500, "detail": string }` (`route.ts:76-82`).

### How the catalog varies by API key

- The handler reads `x-api-key-id` directly (`app/api/v1/services/route.ts:8-22`) and queries that ID's `ProfileEndpoint` rows (`:24-28`).
- For each registry case it looks up both the compound case slug and the generic service slug (`:33-38`). If either matching row has `enabled === false`, that case is omitted (`:40-42`). A generic service row set false therefore omits every case under that service. Missing rows and rows not explicitly false remain listed.
- A service object is created only when the first surviving case is added (`:44-50`); a service with every case disabled is absent. The response does not return an `enabled` boolean.
- `clientParameters` excludes schema entries whose `defaultLocked` is truthy (`:53-58`). The current registry's parameter definitions do not set `defaultLocked` (the only occurrence in `registry.ts` is the optional interface member at line 14), so current definitions pass this filter. In particular, the catalog does not consult `ProfileEndpoint.parameters[*].isLocked`.
- At execution, `runner.ts:187-198` loads per-key profile values and calls `mergeParameters`; `profile-resolver.ts:70-89` gives a stored `isLocked` value precedence over schema `defaultLocked`, and returns HTTP 400 if the client submits a locked field (`:74-87`). Thus a profile-only lock on a normally visible field is not represented by the discovery response.
- The registry helper includes `connections` in its internal flattened records (`lib/endpoints/registry.ts:408-425`), but the route's response projection does not copy it. The route also does not read or project `connectionsOverride`.
- At submission, `loadProfileEndpoint` resolves the exact (API key, case slug) row with a service-level fallback (`lib/endpoints/profile-resolver.ts:24-45`); `runner.ts:210-215` passes its `connectionsOverride` to `parseConnectionSteps`. No override selects the registry's defaults; an override is decoded into steps, with the legacy string-array form converted to `{slug}` records (`profile-resolver.ts:121-141`). This per-key routing choice is execution configuration, not a field in `GET /services`.

## 2. Legacy registry catalog, counted by sub-case property key

Count method: enumerate the keys inside each `subCases` object in `SERVICE_REGISTRY`; quoted keys such as `'id-card'`, `'fact-check'`, and `'summarize-eval'` each count as one property. The service discriminator is `discriminatorName` on the enclosing group. Default connection chains below come from the corresponding `SubCaseDef.connections` literals.

| Registry group | Discriminator | Sub-case keys, parameter keys, and registry default connection chain | Count |
|---|---|---|---:|
| `ingest` / Document Ingestion (`registry.ts:70-109`) | `mode` | `parse` params `output_format, language` → `ext-doc-layout`; `ocr` param `language` → `ext-doc-layout`; `digitize` no params → `ext-vision-reader`; `split` param `pages` → `ext-pdf-tools` | 4 |
| `extract` / Data Extraction (`:112-168`) | `type` | `invoice`, `contract`, `'id-card'`, `receipt`, `table`: no params → each `ext-data-extractor`; `custom` params `fields, schema` → `ext-data-extractor` | 6 |
| `analyze` / Document Analysis (`:171-235`) | `task` | `classify` param `categories` → `ext-classifier`; `sentiment` no params → `ext-sentiment`; `compliance` param `criteria` → `ext-compliance`; `'fact-check'` params `reference_data, extract_fields` → `ext-data-extractor`, `ext-fact-verifier`; `quality` param `criteria` → `ext-quality-eval`; `risk` no params → `ext-quality-eval`; `'summarize-eval'` no params → `ext-content-gen` | 7 |
| `transform` / Document Transformation (`:238-281`) | `action` | `convert` param `output_format` → `ext-doc-layout`; `translate` no params → `ext-translator`; `rewrite` params `style, tone` → `ext-rewriter`; `redact` no params → `ext-redactor`; `template` param `template` → `ext-redactor` | 5 |
| `generate` / Content Generation (`:284-335`) | `task` | `summary`, `report` no params → `ext-content-gen`; `outline`, `minutes` param `format` → `ext-content-gen`; `email` param `tone` → `ext-content-gen`; `qa` param `questions` → `ext-qa-engine` | 6 |
| `compare` / Document Comparison (`:338-370`) | `mode` | `diff`, `version` param `output_format` → each `ext-comparator`; `semantic` param `focus` → `ext-comparator` | 3 |
| **Six core groups subtotal** |  |  | **31** |
| `workflows` / Business Workflows (`:373-403`) | `process` | `'disbursement'` param `resolution_data`, `'lc-checker'` and `'doc-compare'` no params → empty connection arrays; source comments identify these as code-driven workflow cases | 3 |
| **Full `SERVICE_REGISTRY` / flattened catalog universe** |  | Six core groups plus `workflows` | **7 groups / 34 cases** |

The registry file header calls this a “6-service architecture” (`registry.ts:1-3`), but the object has a seventh top-level `workflows` property. `getAllEndpointSlugs()` iterates every entry of that object (`:408-425`), and `GET /services` uses that flattened result (`route.ts:28-29`). Therefore workflow cases are in the legacy discovery universe too, subject to the same per-key filtering.

### Legacy extract presets

`lib/endpoints/presets.ts:11-41` defines six `EXTRACT_PRESETS` keys: `invoice`, `contract`, `id-card`, `receipt`, `po`, and `payslip`. These do not equal the six `extract:type` cases: `po` and `payslip` are presets without registry cases, while `table` and `custom` are cases without entries in this preset map. The runner injects a selected preset's fields/schema only when the merged fields/schema are unset (`lib/endpoints/runner.ts:200-206`).

## 3. Rework manifest and the 31-to-28 reconciliation

Source: `du-rework/businesses/document-core/src/manifest/document-core.manifest.ts`. Count method: enumerate the quoted strings in each action discriminator's `enum`, rather than counting mentions or descriptions.

| Manifest action | Discriminator enum | Quoted values | Count |
|---|---|---|---:|
| `ingest` (`:29-40`) | `mode` | `parse`, `ocr`, `digitize`, `split` | 4 |
| `extract` (`:73-85`) | `type` | `invoice`, `contract`, `receipt`, `table`, `custom` | 5 |
| `analyze` (`:106-118`) | `task` | `classify`, `sentiment`, `compliance`, `quality`, `risk` | 5 |
| `transform` (`:139-154`) | `variant` | `convert`, `translate`, `rewrite`, `redact`, `template` | 5 |
| `generate` (`:175-188`) | `task` | `summary`, `outline`, `report`, `email`, `minutes`, `qa` | 6 |
| `compare` (`:210-222`) | `mode` | `diff`, `semantic`, `version` | 3 |
| **Manifest total** |  |  | **28** |

For `transform`, the manifest's enumerated field is `variant`; it also declares an un-enumerated `action` string as a legacy alias (`document-core.manifest.ts:145-146`). The normalizer uses `variant ?? action` and applies the same five-value allowlist (`validation/input-normalizer.ts:183-193`).

The exact three core registry keys absent from the manifest are:

| Legacy registry key | Manifest absence | Normalizer evidence |
|---|---|---|
| `extract:type=id-card` | `extract.type` enum is the other five values (`document-core.manifest.ts:79`) | `normalizeExtract` rejects values outside its five-value list (`businesses/document-core/src/validation/input-normalizer.ts:94-101`; rejection at 99-100) |
| `analyze:task=fact-check` | `analyze.task` enum contains five values (`document-core.manifest.ts:112`) | `normalizeAnalyze` rejects values outside its five-value list (`.../input-normalizer.ts:144-151`; rejection at 149-150) |
| `analyze:task=summarize-eval` | Same absent `analyze.task` enum (`document-core.manifest.ts:112`) | Same rejecting allowlist at `.../input-normalizer.ts:149-150` |

The separate legacy wire decoder still lists these strings in its accepted legacy variant sets (`services/orchestrator/src/compat/legacy-wire-decoders.ts:32-39`). That decoder inventory does not add values to the document-core manifest or its action normalizer allowlists. This is a source-level compatibility boundary to characterize, not a resolution of the 31-to-28 mismatch. The manifest's description itself says “across 28 variants” (`document-core.manifest.ts:15`).

### Rework extract presets

No `EXTRACT_PRESETS`-style per-type field map is present in `businesses/document-core/src/`. The manifest exposes `fields` and `schema` as caller inputs for extract (`document-core.manifest.ts:76-85`), but has no type-to-default-fields mapping. This differs from the legacy preset map above. The rework manifest also has no per-variant `displayName` / `description` entries; its labels and descriptions are action-level.

## 4. Discovery delta and profile visibility

### Route surface

- The rework public submission matcher is `POST /api/v1/businesses/:id/actions/:action` (`services/orchestrator/src/server.ts:1730-1763`). In the server route implementation, there is no `GET /api/v1/services`, public business-list, or public manifest GET matcher.
- The manifest projection found in the router is `GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName` (`server.ts:2466-2508`). It calls `assertAdminAuth` (`:2473-2475`) and returns manifest actions and empty `currentValues` (`:2497-2507`). This is an admin profile-editor surface, not public, per-API-key discovery.
- `GET /api/v1/admin/businesses` is also admin-gated (`server.ts:2395-2405`); it lists businesses, not a public action catalog.

### What the legacy client learns that the public rework API does not provide

| Discovery item | Legacy `GET /services` | Rework public surface |
|---|---|---|
| Available service groups/cases for this API key | Yes: currently enabled registry cases are returned after exact-case and generic-service filtering (`app/api/v1/services/route.ts:24-50`, `:60-65`) | No public list route; the server exposes action submission, not catalog GET (`server.ts:1730-1763`) |
| Per-case discriminator name/value | Yes: group has `discriminatorKey`; case has `id` (`route.ts:44-64`) | Static action schemas exist in source/manifest, but no public discovery response. Transform also names its canonical enum field `variant`, unlike legacy `action` (`document-core.manifest.ts:145-146`); the admin manifest projection is protected. |
| Per-case display name and description | Yes (`route.ts:60-64`) | No variant-level labels/descriptions in the manifest; descriptions are at action level (`document-core.manifest.ts:29-31, 73-75, 106-108, 139-141, 175-177, 210-212`). |
| Client parameter schema / options | Yes, as `clientParameters` (`route.ts:53-65`) | Action-level `inputSchema` exists in the manifest, but is not returned on a public GET; the admin profile route returns manifest actions (`server.ts:2497-2507`). |
| API-key-specific enabled subset | Yes, via `ProfileEndpoint.enabled` filtering (`route.ts:24-42`) | No equivalent public catalog projection. Rework resolves connector profile bindings during submission; a matching binding is selected at `profiles.ts:132-160`, with an unmatched action denied when the key has bindings. |
| Per-key lock flags and effective routing chain | Not returned by legacy discovery either. The listing only removes schema-default-locked fields and omits connections; runtime separately applies profile locks/connection overrides. | Not discoverable through a public catalog route. |

### J03 ProfileEndpoint fields versus rework profile model

Legacy `GET /services` does not itself surface `ProfileEndpoint.parameters[*].isLocked` or `connectionsOverride`; they are applied during runner execution as described above. Rework does not expose those same ProfileEndpoint semantics through discovery:

- Each document-core action has an empty `profileSchema` (`document-core.manifest.ts:53, 91, 124, 160, 195, 228`); the manifest declares connector slots instead (for example ingest OCR/vision at `:54-65`, extract reasoning at `:92-98`).
- Rework's profile service models immutable API-key bindings to (business, version, action) and slot-to-`{connectorId, revision}` pins (`services/orchestrator/src/modules/profiles/profiles.ts:9-18, 21-30`). Its typed input is `connectorBindings` (`:65-72`); it does not contain legacy per-parameter `isLocked` or ordered `connectionsOverride` fields.
- Binding resolution is submission-time behavior (`profiles.ts:132-160`). The admin write route accepts `connectorBindings` (`server.ts:2200-2255`); the admin manifest GET returns `currentValues: {}` and the manifest, not resolved per-key connector bindings (`server.ts:2497-2507`).
- Therefore manifest connector slots may describe static integration points to an administrator, but they do not make the legacy lock flags, per-key enabled catalog, or `connectionsOverride` chain discoverable to a public rework client.

**Boundary:** this report records source inventory and the resulting discovery delta only. It makes no change request and assigns no decision on the 31-to-28 catalog mismatch.
