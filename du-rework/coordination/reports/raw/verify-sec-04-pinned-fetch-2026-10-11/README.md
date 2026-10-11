# Raw evidence - SEC-04V probes - 2026-10-11

Both probes are standalone Node scripts run as separate processes so an uncaught throw takes
the process down. Neither writes inside the repo.

PROBE-A/01-probe-a-dist.cjs
  Loads orchestrator/packages/egress/dist/index.js (the shipped artifact).
  Loopback server emits an EMPTY 204/205/304 with Content-Length 0 and no payload.
  RESULT: status=1, signal=null, stderr 928 bytes,
          TypeError: Response constructor: Invalid response status code 204
          at dist/pinned-fetch.js:252 fulfillResponse.

PROBE-B/02-probe-b-src.cjs
  Registers require.extensions[.ts] to transpile src in memory, then requires
  packages/egress/src/pinned-fetch.ts. Nothing on disk is written.
  RESULT: 14/14 checks passed, status=0, signal=null, stderr empty,
          PROCESS_SURVIVED_REACHED_END.

Run either with:  node <script>    from du-rework as cwd.

Environment: Node v24.21.0, Windows, offline loopback only.
