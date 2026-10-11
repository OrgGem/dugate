# Receipt - AWEB profile-keys typecheck (P5)

- Date: 2026-10-10
- Lane: P0-P5 API keys -> Profile move (admin-web)
- Scope: fix the 6 reported linter/typecheck errors in
  `orchestrator/apps/admin-web/src/features/profiles/api-keys-panel.tsx` and `profile-keys.ts`
- Status: FIXED - `npx tsc --noEmit` exit 0, `npm run build` exit 0
- Git: no `git add`, no commit, no push (COORDINATOR-CONTRACT)

## 1. The six errors, verbatim

```
src/features/profiles/api-keys-panel.tsx:8:97 - error TS2305: no exported member 'ProfileApiKeyPage'.
src/features/profiles/api-keys-panel.tsx:8:121 - error TS2305: no exported member 'ProfileApiKeyRow'.
src/features/profiles/api-keys-panel.tsx:74:70 - error TS7006: Parameter 'k' implicitly has an 'any' type.
src/features/profiles/api-keys-panel.tsx:209:37 - error TS7006: Parameter 'row' implicitly has an 'any' type.
src/features/profiles/profile-keys.ts:2:15 - error TS2305: no exported member 'ProfileApiKeyPage'.
src/features/profiles/profile-keys.ts:2:34 - error TS2305: no exported member 'ProfileApiKeyRow'.
Found 6 errors in 2 files.
```

## 2. Root cause: ONE defect, not six

`src/lib/api/index.ts` is an EXPLICIT re-export list, not `export *`. I had added
`ProfileApiKeyRow` / `ProfileApiKeyPage` / `ProfileKeyActionResult` to
`src/lib/api/types.ts` but never added them to the barrel, so `@/lib/api` did not
expose them.

The two TS7006 implicit-any errors are DOWNSTREAM of the TS2305s, not separate
defects: with the type unresolved, `useState<ProfileApiKeyPage | null>` degrades to
`any`, so `keys?.items.map((k) => ...)` and `keys!.items.map((row) => ...)` lose
their parameter inference. Annotating them explicitly would have been a band-aid on a
symptom.

## 3. Changes

| File | Change |
|---|---|
| `src/lib/api/index.ts` | export `ProfileApiKeyPage`, `ProfileApiKeyRow`, `ProfileKeyActionResult` |
| `src/features/profiles/api-keys-panel.tsx` | panel reads its OWN session (`client.getSession()`) instead of requiring a `session` prop no caller supplies |
| `src/features/profiles/profiles-screen.tsx` | mounts `<ProfileApiKeysPanel>` below the profile identity card, keyed on `loadedAs` |

Why the session change belongs in this fix: the required `session: AdminWebSession | null`
prop had no producer - `ProfilesScreen` holds no session state - so it was an
unsatisfiable contract that typecheck cannot see until someone mounts the panel.
Key mutation is admin-only, and this session read is the single thing that decides
whether the write controls exist.

## 4. Evidence

```
cd /d D:\Git\dugate\du-rework\orchestrator\apps\admin-web && npx tsc --noEmit -p tsconfig.json
-> no output, exit 0          (literal: TSC_EXIT_0)

npm run build                  (tsc --noEmit + vite build)
-> TSC_EXIT_0
-> vite v6.4.3 building for production...
-> 2700 modules transformed.
-> dist/assets/index-CQ9tA6rB.js  1,060.83 kB
-> built in 8.43s, exit 0
```

## 5. Double-quote hygiene

- `profile-keys.ts`: 0 double quotes (grep: no matches).
- `api-keys-panel.tsx`: 0 double quotes in TypeScript strings. The double quotes it
  does contain are JSX ATTRIBUTE quotes (`className=`, `aria-label=`), which are house
  style - `profiles-screen.tsx` alone has 94 such occurrences.

## 6. Outstanding (NOT covered by this receipt)

- **No browser evidence for the panel yet.** `tests/browser/admin-web/api-keys-connectors.spec.ts`
  still drives the REMOVED `/api-keys` tab (tests 1-5 and 11) and will fail until it is
  rewritten against the profile panel. The panel typechecks and builds, but nobody has
  clicked it in a browser.
- The browser harness (`tests/browser/admin-web/harness.ts`) has no stub for
  `/api/v1/admin/profiles/:b/:v/:n/api-keys`, so the panel cannot be exercised end to end yet.
- P4 (registry merge policy for duplicate profile names) is still undecided.
