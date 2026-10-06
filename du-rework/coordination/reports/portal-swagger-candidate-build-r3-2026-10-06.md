# Portal Swagger candidate build r3

- Date: 2026-10-06 (Asia/Bangkok)
- Candidate tag: `candidate-portal-swagger-20261006-r3`
- Scope: local Docker candidate package only; no Compose services were started, no registry push was performed, and no Git commit was made.

## Build

Command executed from the repository root:

```powershell
$env:DU_IMAGE_TAG = 'candidate-portal-swagger-20261006-r3'
docker buildx bake --load --progress=plain --file scripts/docker/candidate-build.hcl candidate
```

`scripts/docker/candidate-build.hcl:11-49` sets `pull = true` and `no-cache = true` for the candidate targets and includes Orchestrator, Connector, Document Core, LC Checker, and Example Review. Bake exit code: **0**. The build log and exit code are preserved at `coordination/reports/raw/portal-swagger-candidate-build-2026-10-06/candidate-bake-r3.log` and `candidate-bake-r3.exit.txt`.

The build ran the workspace/package build steps and Admin Web's `tsc --noEmit` plus Vite production build. The package downloads encountered slow responses and retries, but all 654 locked packages were fetched and all five targets completed. Vite emitted its existing advisory that the minified JavaScript chunk exceeds 500 kB (638.62 kB; gzip 175.37 kB).

## Candidate images

All image tags were loaded locally by `--load`; the listed SHA-256 values are the resulting image manifest/image IDs reported by Docker inspection.

| Image | Tag | Image digest |
|---|---|---|
| Orchestrator | `du-orchestrator:candidate-portal-swagger-20261006-r3` | `sha256:0cc216643c94da8af6b06c1bd6529204ac86cc3700dbba92862b1aae8d062176` |
| Connector | `du-connector:candidate-portal-swagger-20261006-r3` | `sha256:93af9433cc2fd274cc7f9c9502d5eeaccdda6ec3852bdad984a825079431db78` |
| Document Core | `du-document-core:candidate-portal-swagger-20261006-r3` | `sha256:a54e2ee00ad777216e9209c74dbfa338d9343adcfe981987ed077e1361ad1740` |
| LC Checker | `du-lc-checker:candidate-portal-swagger-20261006-r3` | `sha256:b7ea0f462c86e3f58edbf703af61d6e50a49bb8dde75d4ef6f29a1789c0cd601` |
| Example Review | `du-example-review:candidate-portal-swagger-20261006-r3` | `sha256:d8a0d9c0782ec37476a118b81f137b9f303df020f1f2f2921bbf629655b4f608` |

## Payload verification

A read-only, one-shot `node` process ran inside the Orchestrator image; it did not start the application service.

- `apps/admin-web/src/features/api-docs/api-docs-screen.tsx:216-220` gives the scrollable operations list `tabIndex={0}`; `:455-463` does the same for the scrollable JSON `<pre>`. The built bundle contains the API docs route and rendering/filter copy, both scrollable style markers, and three `tabIndex:0` markers.
- `services/orchestrator/src/app/admin/shell-server.ts:334-343` includes `api-docs` in `ADMIN_WEB_ROUTE_NAMES`. The compiled `/app/dist/app/admin/shell-server.js` in the candidate image contains the same route name.
- `scripts/docker/build-runtime.cjs:92-93` builds `@du/admin-web` and copies the newly generated `apps/admin-web/dist` into the Orchestrator deployment. The Orchestrator image contains the `Orchestrator Portal` index and fresh hashed assets.
- Image asset hashes match the host `apps/admin-web/dist` files byte-for-byte:

| Embedded file | Bytes | SHA-256 |
|---|---:|---|
| `/app/admin-web/index.html` | 478 | `88560a1648198a6c057c39bf6ede8bcb227e33be2afa5a94a925912053d7b981` |
| `/app/admin-web/assets/index-BE9ORI5P.css` | 43,611 | `24461a565eab38338769a3fd71e54c233cc47ee167f6e218ad0752274905029a` |
| `/app/admin-web/assets/index-DtNby8hm.js` | 638,622 | `1f0ef150894f8ea674386ec929cd89bf7a57f13599e7c19ccb5abb7bce926ca2` |

The compiled server file `/app/dist/app/admin/shell-server.js` is 32,117 bytes with SHA-256 `d1dcd4c9cc36519feb42514c2a116392602833a9ec31c337d2548009c6c4ac7b`.

## Caveat

`apps/admin-web/README.md:93-100` still says the backend allow-list does not contain `api-docs`; that prose is stale relative to the current source and compiled candidate image. It was not changed as part of this packaging task. This receipt proves clean image builds and inspected payload contents, not browser/runtime acceptance or deployment readiness.
