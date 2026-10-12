# ORV15-HA owner checkpoint

Status: the requested offline two-slot package is implemented and owner-checked.
It is an unexecuted deployment template; this report does not claim live Compose,
Nginx, runtime identity, or blue/green acceptance.

The package defines independent blue/green Compose projects with stable
Orchestrator, Connector, and Document Core Worker service keys; digest-invalid
rendering examples; a single fixed ingress; private worker/control paths; and a
root-controlled selector helper. The ingress container mounts only the
ingress-only directory plus the separate TLS directory. The runtime bootstrap
hash-checks service-bound JSON, rejects service identity and Node loader
overrides, and emits a generic failure without echoing configuration values.

The helper has no environment-driven test bypass. Its read-only
`--render-only` mode shares the production renderer and writes no files. The
offline test runs that actual script against temporary selectors, rejects an
invalid slot without altering the selected include, and verifies the
production path rejects a non-root caller. The test also executes the inline
bootstrap code extracted from the actual Compose YAML with a forbidden
`NODE_OPTIONS` override.

The follow-up artifact-grant trace found that Orchestrator constructs absolute
Worker artifact URLs from `ORCHESTRATOR_INTERNAL_BASE_URL`; setting it to
`127.0.0.1:3002` sends a Worker back to its own loopback. The package now uses
`http://du-availability-ingress:8080`, whose `/api/runtime/v1/` route reaches
the selected Orchestrator API listener and remains restricted to the Worker
API subnet. Connector artifact bytes arrive inline, so its network was not
added to the worker-only listener. The fixed-ingress identity listener keeps
its loopback host bind and allows only loopback plus the dedicated control
subnet; Docker DNAT source visibility still requires native deployment
verification.

The follow-up spec review added two bounded corrections. The reload helper now
takes its global lock before reading either service selector, preventing a
stale sibling value from being rendered after an overlapping cutover. Signal
handlers exit with conventional statuses and run lock cleanup once. Nginx now
sets a 64 MiB proxy body ceiling, matching the legacy multipart maximum while
leaving narrower Admin/API handler limits in force. The concurrency regression
executes a private copy of the actual helper with only its root/Docker paths
redirected and harmless command stubs/barriers; it does not invoke Docker or
claim privileged/native proof.

Validation run from `/workspace/dugate/du-rework`:

- `node_modules/.bin/jest --config jest.unit.config.cjs --runInBand tests/orv15-ha-compose-package.test.ts` from `orchestrator/services/orchestrator`: **13/13 passed**, covering the Worker artifact grant origin, body ceiling, deterministic two-process selector interleavings, HUP/INT/TERM exit and one-time cleanup, and host-probe DNAT configuration.
- `sh -n compose/ingress/reload-selector`: passed.
- PyYAML parsed both Compose YAML files; offline topology assertions passed.
- Whitespace validation passed for all eight package/test files.
- No Docker, image, service, network, provider, or deployment command was invoked.

The four new assertions were first run against the prior source and failed for
the missing body limit, both stale-snapshot interleavings, and non-terminating
signal cleanup. They passed after the bounded fixes above.

The runnable raw output is in `coordination/reports/raw/orv15-ha-owner/offline-validation.txt`.

| File | SHA-256 |
| --- | --- |
| `compose/availability.yml` | `97dcdd057026770c1ef7265b2268578f52e0e53c8bb0fde887e6cfa37c7b3014` |
| `compose/availability-slot.env.example` | `a83dbabec7d36a5f94d896cf321e33f50cacc9e9e9e1d88c45c747b9ecccd0f3` |
| `compose/availability/slot-release.example.yml` | `c355ab33b080ed5d0d3c449109ac9941a8c2731c668218c1d22b61901a9fc2e2` |
| `compose/ingress/nginx.conf` | `ce4b77352943f4b12bc64c7f7b9b81c74437eef056b4969b7884534b32f0ed99` |
| `compose/ingress/reload-selector` | `68502564455cde35c2098fbd500c869a6d54a7829a2664b2de17d47da2f684eb` |
| `compose/ingress/selected-upstream.conf` | `594e03f515cf0324893eca68c8f06e145f9b79dcf492cb4b089edd8a015225a3` |
| `docs/55-compose-two-slot-deployment.md` | `15a2cd98c7490a03e4644f14cb89b833ae9681beccfcd078de0f0d189e38fb84` |
| `orchestrator/services/orchestrator/tests/orv15-ha-compose-package.test.ts` | `8aeafb98ec1be572f57320d38502685440e82a99bb341ea8cb09641e8b7f703c` |

The examples retain deliberately invalid images, digests, identities, and secret
paths until an operator renders and root-pins a real release. Independent Host
verification must still check Compose merge behavior, Nginx execution, six live
replicas, actual work counters, and a real serving/drain/cutover cycle.
