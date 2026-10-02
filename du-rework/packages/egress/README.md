# `@du/egress`

Shared pinned egress: DNS-rebinding-safe `fetch`. One resolution feeds both the policy
decision and the socket that is actually dialed.

## Why this package exists

The pre-fix path (global `fetch`) resolved the host **once** at policy adjudication and
**again** inside connect. A DNS that answered public first and loopback seconds later
slipped a credentialed request past the SSRF policy (TOCTOU). Here the adjudicated answer
IS the address dialed, so the two can never disagree.

HTTPS keeps SNI and certificate verification on the **original hostname**
(`tls servername`), so pinning does not weaken transport security. Even with
`allowPrivateNetworks`, the resolver is called exactly once and its answer is what gets
dialed.

## API

| Export | Role |
|---|---|
| `createPinnedFetch(options?)` | Returns a `fetch`-shaped function with the pinning guarantee |
| `buildDialOptions(spec)` | Builds `node:https`/`node:http` request options |
| `DestinationDeniedError` | Thrown when adjudication denies a destination |
| `PinnedFetchOptions` | `allowPrivateNetworks`, `allowHosts`, `resolve`, `timeoutMs` |

Options:

- `allowPrivateNetworks`: narrow local-mesh opt-in (RFC1918 / loopback / ULA only, per
  contracts semantics) - never metadata, CGNAT or multicast.
- `allowHosts`: exact IP-literal opt-ins. A listed **name** never skips answer
  adjudication.
- `resolve`: resolver seam for tests and callers holding a pre-adjudicated answer cache.
  Defaults to `dns.promises.lookup(host, { all: true })`.
- `timeoutMs`: hard deadline for the **headers phase**. On fire the socket is destroyed
  and the promise rejects with a named timeout error, distinct from a caller abort.
  Body-phase bounding stays with the caller.

## Scope guards

- **No `globalThis.fetch` fallback for any body shape.** `FormData` is serialized to
  `multipart/form-data` over the *same* pinned connection (the in-repo multipart adapter
  uses text fields only); `ReadableStream` bodies are piped; `string`/`Buffer`/
  `ArrayBuffer`/`URLSearchParams` are written directly. Unknown shapes (Blob parts,
  exotic objects) are **rejected fail-closed** - routing a credentialed body through an
  unpinned resolver is exactly the bypass this package exists to prevent.
- **Response bodies are decompressed here** (gzip/deflate/br), because Node core has no
  undici `fetch` to do it. Callers' streaming caps therefore measure **decoded** bytes.
- TLS-only options are emitted **only for https**; passing `rejectUnauthorized` to a plain
  `http.request` caused `ETIMEDOUT` on loopback under Node 22/Windows. That split is
  asserted by unit test rather than living in an inline spread.
- Public 3xx hops are returned **unfollowed** - re-adjudication is the caller's decision.

## Boundary

Depends only on `@du/contracts` (for `adjudicateUrlDestination` /
`isDestinationAddressAllowed`). No business or service internals.

## Build & Test

```bash
pnpm --filter @du/egress build
pnpm --filter @du/egress lint
pnpm --filter @du/egress test
```

Offline boundary suite: 34 tests across 3 suites, all networking stubbed
(`egress-boundaries`, `egress-ssrf-deny-matrix`, `egress-ssrf-redirect-matrix`).

Note: the redirect-matrix suite binds a loopback listener and has been observed to fail
with `connect ETIMEDOUT 127.0.0.1:<port>` on Windows under load, then pass on re-run.
Re-run before treating a single failure as a regression.

## Read first

- [08-connector-api](../../docs/08-connector-api.md)
- [12-operations](../../docs/12-operations.md)
