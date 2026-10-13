# Frontend configuration UI receipt — Businesses and Profiles

Date: 2026-10-12  
Scope: Businesses and Profiles files assigned to the configuration-pages worker. A later compile repair also removed one unused React import from the Secrets screen at the coordinator's request. The separate Connectors and Settings slice is handled by its owner.

## Changes

- Business list uses cursor-backed 20-row pages with Previous/Next history. A requested page index and cursor history are committed only after a successful read; Retry reuses the failed cursor. Business detail remains in Versions & workers, Profiles, and Workflow schemas tabs, with worker rows nested under their version and its status/intake context.
- Business profile catalog uses 50-row server-cursor pages. Tenant/business scope changes invalidate pending profile reads. The selected workflow profile persists across catalog pages and stays visible as a scoped pinned option; workflow responses are guarded against stale selection/scope requests.
- Profile catalog uses 50-row server-cursor pages and resets on tenant/business filter changes and Refresh. Request generations and captured scope guard stale results, errors, and loading finalizers. Assigned-profile pages retain their role-sensitive tenant/query cursor path and 50-row local cursor history, with stale reads invalidated on tenant changes; selected records and drafts remain independent of page state. Assigned-profile cursor history normalizes a server null cursor to `undefined` while keeping the same first/next/previous behavior.
- Catalog/assigned search and filter actions align with control rows at responsive widths, keeping dynamic messages below their fields. Tables use compact density, bounded scroll regions, and sticky headers where useful. Profile editor mutation actions remain outside mounted editor panels.
- Compile follow-up: removed only the unused `useEffect` import from the existing Secrets screen; no Secrets behavior changed.
- No endpoint, DTO, router, backend, auth-key scope, shared component, or global style changes were made in this slice.

## Validation

- `node --test tests/orv15-business-profiles-config-ui-owner.test.mjs` — passed, 4/4.
- `npm run typecheck` — passed for the admin-web package after the cursor normalization and unused-import removal.
- `git diff --check` over the leased source and test files — passed.
- TypeScript `transpileModule` syntax checks for `businesses-screen.tsx`, `business-detail-cockpit.tsx`, and `profiles-screen.tsx` — passed.
- Browser verification and package build are pending the coordinator's combined pass.

Raw focused-test output: `rawfrontend-config-business-profiles-focused-test.txt`.  
Raw package typecheck output: `rawfrontend-config-business-profiles-typecheck.txt`.

## SHA-256

| File | SHA-256 |
|---|---|
| `src/features/businesses/businesses-screen.tsx` | `0AD415E1F70DFD45779F49248DFF6E2CDE5A240512C689E22BCD981A4F5843F4` |
| `src/features/businesses/business-detail-cockpit.tsx` | `E6356D9BE1F921F0A07526B0812D167B0BE0AABEA6DC6F6F0A4BDFCE383FF1F5` |
| `src/features/profiles/profiles-screen.tsx` | `63F8CED7B13F26867935271A4B393E26B531ED99D7567AA53D1E9987158D647B` |
| `src/features/profiles/initial-bindings.tsx` | `77C97083B705D9D6036FEB495EC64B51F01BB24DA176D8C00FC5C45419CD4181` |
| `src/features/profiles/callback-policy-editor.tsx` | `566681C46B265076CF1964E2FC4960258A1E0F21253338BAD200ED5CFA7D29B7` |
| `src/features/profiles/request-redaction-editor.tsx` | `584A6C8666E024DAC3993E9B9C2C3E1B3698DD933B75BB407C2928C5326BD47D` |
| `src/features/profiles/profile-group-editor.tsx` | `C81CA578DB1276823A35CAAE56455F31851F2E7E78185F1A41EFA0C3E87E2992` |
| `src/features/secrets/secrets-screen.tsx` | `77891849AC0F5EE2CBD4AB59CB5922A130B271C1D1B37F8F815E50EF9BAEA525` |
| `tests/orv15-business-profiles-config-ui-owner.test.mjs` | `9C08B887793299DBD7A726AC2205820659FDF14B5DA663A71F7B112D8D98CF60` |
