# Legacy Ops-Admin, Settings, and Observability Journeys

**Date:** 2026-10-01  
**Scope:** Read-only characterization of the legacy app, with the requested rework counterpart check. No source, contract, gate, or OpenAPI files were changed, and no tests were run.  
**Reference format:** paths below are repository-relative and every behavior claim includes file and line references. “Not found” means no matching implementation or UI callsite was found in the inspected route/rendering surface.

## 1. Stalled-job recovery

- `POST /api/internal/recover-stalled` is the scan trigger. Its comment says a Kubernetes CronJob is intended to call it every five minutes or an admin may invoke it manually; the route itself performs the scan on each POST. The five-minute schedule is documented as an intention, not implemented by an in-process scheduler in this route (`app/api/internal/recover-stalled/route.ts:9-11,24-41`).
- The threshold defaults to 900,000 ms (15 minutes), configurable through `STALL_THRESHOLD_MS`. Selection is `state = RUNNING`, `done = false`, and `createdAt` older than the threshold; the predicate does not use a last-progress timestamp (`app/api/internal/recover-stalled/route.ts:21-22,33-41`).
- The route itself has no retry-count check and does not enqueue a retry or move a BullMQ job. It changes the selected **operation rows** to `FAILED`, sets `done = true`, records `errorCode = STALLED`, and clears `progressMessage` (`app/api/internal/recover-stalled/route.ts:48-58`).
- BullMQ’s separate queue defaults set `attempts: 3`, exponential backoff with a 5,000 ms base delay, and `removeOnFail: false` so failed jobs remain for DLQ inspection. The source does not show a separate DLQ queue transfer or say “three retries”; the configured value is the maximum attempts (`lib/queue/pipeline-queue.ts:26-34,56-64`).
- A successful POST returns `{ recovered: count, operations: [{ id, endpointSlug, createdAt }] }`; when none match it returns `{ recovered: 0, operations: [] }`. `GET` is a status count and returns `{ stalled, thresholdMs }` (`app/api/internal/recover-stalled/route.ts:43-46,62-69,72-78`).
- The route comments describe it as internal and the middleware bypasses all `/api/internal/*`; its bearer-token comparison rejects only when `INTERNAL_API_SECRET` is configured (`app/api/internal/recover-stalled/route.ts:24-31`; `middleware.ts:8-15,24-26`).

## 2. Retention cleanup

- The manual `GET /api/cleanup` calls `cleanupExpiredFiles()` and returns its result; its comment says cron or monitoring calls it. The handler does not invoke cache cleanup (`app/api/cleanup/route.ts:1-17`).
- The application scheduler is wired from the root layout. It waits 10 seconds after startup, then runs file cleanup and cache cleanup once every six hours (`app/layout.tsx:41-44`; `lib/cleanup-scheduler.ts:11-32`).
- File cleanup selects operation rows where `createdAt` is more than 24 hours old, `filesDeleted = false`, and `deletedAt IS NULL`; there is no operation-state predicate. It removes local outputs, stored output files, and associated uploaded-file objects/paths, then sets `filesDeleted = true`. The operation row itself is retained (`lib/cleanup.ts:17,40-54,59-82,84-113`).
- Cache cleanup selects `FileCache` rows with `refCount <= 0` and `lastAccessedAt` older than the `s3_cache_ttl_hours` setting (default 168 hours), deletes their stored objects, then deletes those cache rows (`lib/cleanup.ts:127-150`).
- The admin Settings cache API also has manual controls: `target=outputs` calls file cleanup; the default DELETE removes unreferenced cache rows, while `expired=true` applies the configured cache TTL (`app/api/settings/cache/route.ts:65-94`). `SettingsForm` exposes “Clear Expired”, “Clear All”, and “Clean Expired Outputs” actions (`components/SettingsForm.tsx:362-430`).

## 3. Queue dashboard

- The catch-all route exposes Bull Board through `GET`, `POST`, `PUT`, and `DELETE` under `/api/bull-board`. It mounts two BullMQ adapters: the `pipeline` queue and `workflow-steps` queue (`app/api/bull-board/[[...slug]]/route.ts:34-50,55-63`; queue names at `lib/queue/pipeline-queue.ts:13-14`).
- The Hono middleware requires a NextAuth session and `ADMIN` role before passing requests to the board (`app/api/bull-board/[[...slug]]/route.ts:22-32`). The board is mounted directly at its API path, not through a separate Next page. A HeaderNav link to it was not found; the source comment names `/api/bull-board` as the access path (`app/api/bull-board/[[...slug]]/route.ts:1-5`; `components/HeaderNav.tsx:123-131`).

## 4. Analytics

- `GET /api/internal/analytics` requires a session with `canMutate` permission (`ADMIN` or `USER`), and accepts `timeRange` (`24h`, `7d`, or `30d`; default `24h`) and `resolution` (`hour` or `day`; default `hour`) (`app/api/internal/analytics/route.ts:11-25`; `lib/rbac.ts:10-15`).
- It groups operation counts by time bucket and state, summarizes request totals and success rate, and produces API-key/profile and endpoint breakdowns (`app/api/internal/analytics/route.ts:27-53,62-108,135-151`). These queries filter by creation time without a tenant predicate, so this is an instance-wide aggregate rather than tenant-scoped output (`app/api/internal/analytics/route.ts:27-53,62-108`).
- The screen is `/dashboard`, guarded by the same `canMutate` role rule. `DashboardView` fetches the analytics route and supplies 24-hour, 7-day, and 30-day controls (`app/dashboard/page.tsx:15-31`; `components/DashboardView.tsx:40-65`).

## 5. Settings

- `AppSetting` is a key/value table with a unique key and text value (`lib/db/schema.ts:140-147`). `GET` and `PUT /api/settings` require an admin session; GET masks the configured credential fields in its response, and PUT accepts a fixed allow-list (`app/api/settings/route.ts:17-40,47-78`). The writable surface includes provider/model, prompt keys, OpenAI base URL, API secret, S3 endpoint/bucket/credentials/region, and cache TTL (`app/api/settings/route.ts:54-72`).
- Encryption is selected by a server-owned key set: non-empty values for `ai_api_key`, `openai_api_key`, `api_secret_key`, `s3_access_key`, and `s3_secret_key` are encrypted before the AppSetting upsert. Reads decrypt only those keys; decryption failure returns an empty string, with no plaintext fallback. No decrypted secret value is reproduced here (`lib/settings.ts:111,115-145,149-155`).
- The built-in AI provider selector offers Gemini, OpenAI-compatible, and an Anthropic option labeled as not yet supported; the tested provider branches are Gemini and OpenAI (`components/SettingsForm.tsx:46-50`; `app/api/settings/test/route.ts:8-42`). Model suggestions are grouped by provider in the form (`components/SettingsForm.tsx:52-74`); stored defaults select Gemini and the Gemini 1.5 Flash model (`lib/settings.ts:88-100`).
- Prompt presets are English and Vietnamese. Selecting a preset fills the image, PDF, DOCX, and compare prompt fields; the generate prompt is separately editable and has a stored default (`lib/settings.ts:13-87,92-96`; `components/SettingsForm.tsx:620-637,641-698`).
- `/settings` is an admin-only page containing `SettingsForm` (`app/settings/page.tsx:8-22`). The form loads/saves settings, tests the configured provider, shows storage/cache controls, and tests S3 connectivity (`components/SettingsForm.tsx:111-170,362-430,460-462`). `GET/DELETE /api/settings/cache` and `POST /api/settings/s3-test` have explicit admin guards (`app/api/settings/cache/route.ts:18-20,58-68`; `app/api/settings/s3-test/route.ts:8-12`). `POST /api/settings/test` has no role check in the handler itself (`app/api/settings/test/route.ts:1-8`).

## 6. Docs and health

- Legacy `GET /api/swagger` constructs the OpenAPI document at request time. Service paths are assembled from `getAllEndpointSlugs()` and `SERVICE_REGISTRY`-derived fields; generic operation paths and the surrounding OpenAPI metadata are authored inline in the route (`app/api/swagger/route.ts:1-18,72-96,98-122`). This is runtime-built from registry data plus inline definitions, rather than a separately generated checked-in spec.
- `/api-docs` renders client-side Swagger UI pointed at `/api/swagger`; HeaderNav links to that page (`app/api-docs/page.tsx:1-15`; `components/HeaderNav.tsx:123-131`).
- Legacy `GET /api/health` returns only `{ status: "ok", timestamp }`; the handler does not probe DB, Redis, queue, or workers (`app/api/health/route.ts:1-6`).

## 7. Legacy UI trace map

| Journey | Screen / component path |
|---|---|
| Stalled-job recovery | The route comment says “manually by Admin via Dashboard,” but a UI caller for `/api/internal/recover-stalled` was **not found**. The dashboard component fetches analytics and links to history; it does not call recovery (`app/api/internal/recover-stalled/route.ts:9-11`; `components/DashboardView.tsx:46-65,75-83`). |
| Retention cleanup | `/settings` → `SettingsForm` cache/output controls; automatic scheduler is started by `RootLayout` (`app/settings/page.tsx:8-22`; `components/SettingsForm.tsx:362-430`; `app/layout.tsx:41-44`). |
| Queue dashboard | Direct `/api/bull-board` Hono/Bull Board route; no separate page or HeaderNav entry found (`app/api/bull-board/[[...slug]]/route.ts:34-63`; `components/HeaderNav.tsx:123-131`). |
| Analytics | `/dashboard` → `DashboardView` → `/api/internal/analytics` (`app/dashboard/page.tsx:15-31`; `components/DashboardView.tsx:40-65`). |
| Settings | `/settings` → `SettingsForm`; the settings link is in the signed-in admin menu (`app/settings/page.tsx:8-22`; `components/SettingsForm.tsx:76-120`; `components/HeaderNav.tsx:163-174`). |
| Docs | `/api-docs` → Swagger UI → `/api/swagger` (`app/api-docs/page.tsx:6-15`; `app/api/swagger/route.ts:3-4,122`). |
| Health | Direct `/api/health`; a separate UI screen/caller was not found (`app/api/health/route.ts:1-6`). |

## 8. Rework counterparts

- **Admin surface:** Orchestrator mounts its server-rendered Admin shell during app creation (`du-rework/services/orchestrator/src/server.ts:704-714`). Its navigation includes Businesses, Operations, Overview, Profiles, Connectors, Grants, and API keys (`du-rework/services/orchestrator/src/app/admin/p6-01-shell-fixtures.ts:223-232`); audit and crypto-config have their own shell paths (`du-rework/services/orchestrator/src/app/admin/shell-router.ts:488-506`). Its Overview composes usage, audit, and health panes, and operation detail is an admin section (`du-rework/services/orchestrator/src/app/admin/shell-router.ts:651-676`).
- **Stalled recovery:** A matching `POST /api/internal/recover-stalled` operation-row state repair was **not found** in the orchestrator request dispatcher. Rework instead periodically sweeps expired leases, queue integrity, and expired multipart sessions; the default recovery timer is five seconds when auto-dispatch is enabled (`du-rework/services/orchestrator/src/server.ts:688-690,890-903`). Queue integrity records `OK`, `RECONSTRUCTING`, or `SUSPECT` health and a latest sweep summary (`du-rework/services/orchestrator/src/server.ts:646-684`). The separate admin deadline sweep is `POST /api/v1/admin/operations/sweep-deadlines`, not the legacy stalled-operation scan (`du-rework/services/orchestrator/src/server.ts:2314-2329`).
- **Retention cleanup:** A rework equivalent to legacy 24-hour operation-file cleanup and `FileCache` TTL deletion was **not found** in the server/admin routes. The adjacent automated cleanup found is expired multipart-session sweeping, which marks sessions `ABORTED` and cleans their storage (`du-rework/services/orchestrator/src/server.ts:899-901`; scheduler hook at `du-rework/services/orchestrator/src/server.ts:4206-4223`).
- **Queue dashboard:** A Bull Board/job-browser route was **not found** in the orchestrator dispatcher (`du-rework/services/orchestrator/src/server.ts:1205-2719`). The closest operator-facing equivalent is queue-integrity status in health and the Admin Overview health pane, not a per-queue job UI (`du-rework/services/orchestrator/src/server.ts:646-684,1205-1240`; `du-rework/services/orchestrator/src/app/admin/shell-router.ts:665-676`).
- **Analytics:** Rework has a tenant-scoped `GET /api/v1/usage` projection for the admin overview and key-authenticated clients (`du-rework/services/orchestrator/src/server.ts:1321-1348`). The overview fetcher requests usage, audit, health, and operation-state counts using its selected tenant/time window (`du-rework/services/orchestrator/src/app/admin/overview-section-data.ts:630-645`). Its OpenAPI artifact documents usage summary and events (`du-rework/docs/21-openapi.json:1056-1090`). This differs from the legacy instance-wide, unscoped analytics query.
- **Settings:** A global AppSetting/AI provider/model/prompt settings route was **not found** in the rework dispatcher (`du-rework/services/orchestrator/src/server.ts:1205-2719`). The similarly named admin surface is crypto configuration, backed by the crypto configuration handler and returning configuration references/previews rather than a general provider/prompt key/value form (`du-rework/services/orchestrator/src/server.ts:2613-2658`; `du-rework/services/orchestrator/src/app/admin/shell-router.ts:488-499`). Profile/business and connector configuration are separately represented in the Admin shell and should not be read as the legacy global SettingsForm (`du-rework/services/orchestrator/src/app/admin/p6-01-shell-fixtures.ts:223-228`).
- **Docs:** `du-rework/docs/21-openapi.json` is the checked-in serialized OpenAPI artifact and identifies itself as code-derived from the orchestrator and connector (`du-rework/docs/21-openapi.json:1-6`). It contains health, usage, operation, and selected admin paths (`du-rework/docs/21-openapi.json:707-731,767-926,1056-1090,1261-1285,1367-1454`). A Swagger UI page or `/api/swagger` serving route was **not found** in the orchestrator dispatcher (`du-rework/services/orchestrator/src/server.ts:1205-2719`).
- **Health:** Rework implements `GET /health` and `GET /api/v1/health`. It probes PostgreSQL and Redis, reports active leases, and optionally includes queue-integrity state; connectivity failures produce HTTP 503, while a `SUSPECT` queue state changes the body status to degraded (`du-rework/services/orchestrator/src/server.ts:1205-1240`). The API health paths are also present in the OpenAPI artifact (`du-rework/docs/21-openapi.json:707-731`).

## 9. Security annotation

- **MUST-NOT-REPLICATE** — legacy client-directed credential-identity selection and fallback behavior: `app/api/internal/profile-endpoints/route.ts:21-27,110-120`; `app/api/internal/ext-overrides/route.ts:19-35,58-72`; `app/api/internal/test-profile-endpoint/route.ts:17-29,61-64`; `app/api/v1/docs/workflows/route.ts:49-85`; `app/api/v1/docs/workflows/schema/route.ts:59-78`.

## 10. Journey classification

This table classifies the existing journey’s operational role; it does not select a route, design, or implementation.

| Journey | Classification | Basis |
|---|---|---|
| Stalled-job recovery | **Cutover-required** | It reconciles stale `RUNNING` operation records into a visible failed result, while the rework sweeps leases/queue integrity but has no matching stalled-operation repair route (`app/api/internal/recover-stalled/route.ts:33-58`; `du-rework/services/orchestrator/src/server.ts:646-684,890-903`). |
| Retention cleanup | **Cutover-required** | It enforces file/cache lifecycle by age and reference state; the rework cleanup found here is limited to expired multipart sessions (`lib/cleanup.ts:40-54,127-150`; `du-rework/services/orchestrator/src/server.ts:899-901,4206-4223`). |
| Queue dashboard | **Post-cutover** | It is a separate admin-only BullMQ diagnostic UI. Rework exposes queue-integrity health in its health/overview path, but no job-browser route (`app/api/bull-board/[[...slug]]/route.ts:22-50`; `du-rework/services/orchestrator/src/server.ts:646-684,1205-1240`). |
| Analytics | **Cutover-required** | The operator has a selectable-window dashboard today; rework has a tenant-scoped usage/audit/health overview, with different scope and aggregation (`app/api/internal/analytics/route.ts:11-25,27-108`; `du-rework/services/orchestrator/src/app/admin/overview-section-data.ts:630-645`). |
| Global Settings and cache controls | **Cutover-required** | The global provider/model/prompt settings and storage configuration are directly editable in the legacy admin screen; the rework crypto-config pane is a narrower, separate surface (`app/api/settings/route.ts:54-72`; `components/SettingsForm.tsx:484-610,613-698`; `du-rework/services/orchestrator/src/server.ts:2613-2658`). |
| Interactive API Docs | **Post-cutover** | Legacy serves a Swagger UI page; rework has the serialized OpenAPI document but no matching Swagger UI route found (`app/api-docs/page.tsx:6-15`; `du-rework/docs/21-openapi.json:1-6`; `du-rework/services/orchestrator/src/server.ts:1205-2719`). |
| Health endpoint | **Cutover-required** | It is a deployment probe: legacy exposes a simple health response and rework already has the corresponding health routes with dependency checks (`app/api/health/route.ts:1-6`; `du-rework/services/orchestrator/src/server.ts:1205-1240`). |

### Legacy ops-admin surfaces without a like-for-like rework counterpart found

- Database-level stalled-operation recovery and its stalled-count endpoint (`app/api/internal/recover-stalled/route.ts:24-78`; rework dispatcher inventory: `du-rework/services/orchestrator/src/server.ts:1205-2719`).
- Legacy operation-file and FileCache retention routines as a whole (`lib/cleanup.ts:40-54,127-150`; rework expired multipart-session sweep: `du-rework/services/orchestrator/src/server.ts:899-901,4206-4223`).
- Bull Board’s per-queue/job browser (`app/api/bull-board/[[...slug]]/route.ts:34-63`; rework health-only queue-integrity view: `du-rework/services/orchestrator/src/server.ts:646-684,1205-1240`).
- The legacy global `AppSetting` provider/model/prompt form and its S3/cache controls (`app/api/settings/route.ts:54-72`; `components/SettingsForm.tsx:362-430,484-698`). Rework crypto configuration is a different surface (`du-rework/services/orchestrator/src/server.ts:2613-2658`).
- The interactive Swagger UI page and runtime `/api/swagger` endpoint; the serialized OpenAPI artifact itself does exist in rework (`app/api-docs/page.tsx:6-15`; `app/api/swagger/route.ts:1-18,72-122`; `du-rework/docs/21-openapi.json:1-6`).
