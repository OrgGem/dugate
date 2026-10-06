# PORTAL-IDENTITY-NETWORK-CONFIG-20261006 ? plan review

Date: 2026-10-06. User requested inventory and missing work added to the shared plan. Read-only source review plus plan/report changes; no OIDC/network runtime configuration changed.

| Area | Current evidence | Gap |
|---|---|---|
| OIDC Portal | apps/admin-web/src/features/identity/identity-screen.tsx:249-268: explicit read-only OIDC metadata, issuer/clientId/callback/scopes | No OIDC editor/test/activation writer |
| OIDC runtime | services/orchestrator/src/app/admin/oidc-boot.ts: required DU_ADMIN_OIDC_ISSUER/CLIENT_ID/REDIRECT_URI and secret file/input; main.ts:232 boot composition | Needs durable config reader and activation/restart/session semantics |
| Settings writer | services/orchestrator/src/app/admin/bff/settings.ts:124 returns SETTINGS_WRITER_DISABLED | Existing Settings is not a working persistence path for OIDC/egress |
| Shared outbound protection | packages/egress/src/pinned-fetch.ts:31-37; contracts/src/ip-policy.ts:245-280 | DNS/SSRF fencing exists, but allowHosts is an IP exception seam, not a strict domain allowlist |
| Connector provider | services/connector/src/adapters/transport.ts:8-27; composition.ts:97 | Existing transport integration, no central Portal-managed domain inventory/policy |
| Source fetch | packages/worker-sdk/src/source-acquisition.ts:100-105,201 | Uses shared pinned default fetch; no system-wide deny-by-default domain policy proven |

Added SPECIFIED/OPEN packets PORTAL-OIDC-CONFIG-20261006 and PORTAL-EGRESS-POLICY-20261006 to tasks/DU-PLATFORM-MIGRATION-2026-10-05.md. Acceptance includes real persistence + consumer application, admin/CSRF/CAS/audit/secret protection, configured vs applied revision, safe OIDC recovery and real login tests; egress inventory/enforcement across Backend/Connector/Worker/server app, purpose/tenant/profile scopes, DNS/redirect handling and deployment proxy/firewall for arbitrary direct Worker traffic. Browser CSP and inbound CORS are separate from outbound allowlisting. S3 IAM bucket/prefix policies and trusted workload credential resolution are preserved.

No source implementation, dispatch, commit, push or cutover for these new plan packets. Existing independent review/gates remain unchanged.
