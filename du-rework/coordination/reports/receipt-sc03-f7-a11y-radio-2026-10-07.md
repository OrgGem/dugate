# SC-03 F7 - ValueSourceSelector radio keyboard accessibility

Date: 2026-10-07. Owner: codex_arch, WORKER. Scope: du-rework only, `apps/admin-web/src/features/secrets/value-source-selector.tsx`.
Source finding: `coordination/reports/ui-frontend-audit-lane1-2026-10-06.md` F7.
Status: IMPLEMENTED; owner typecheck/build passed. Independent browser verification/acceptance pending. No git commit or git push. Existing concurrent source hunks preserved.

## Scoped diff

- Added two `React.useRef<HTMLButtonElement>(null)` refs and attached each to its radio Button.
- Text value: `tabIndex={kind === 'literal' ? 0 : -1}`.
- Secret: `tabIndex={kind === 'secret_ref' ? 0 : -1}`.
- Group: `onKeyDown={handleRadioKeyDown}`.
- New handler ignores disabled controls/unrelated keys, prevents default scrolling for ArrowLeft/Right/Up/Down, switches to the other of the two radios with wraparound, and focuses the destination button. Native button Space/Enter click activation remains available. Existing switchKind handles clearing inactive values and notifying the parent.
- Both refs are unconditional hooks before the stored-value early return. Stored-value display and literalOnly/secretOnly modes remain unchanged.

Key handler added:

```tsx
function handleRadioKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const next: ValueSourceKind = event.target === literalRadioRef.current ? 'secret_ref' : 'literal';
  switchKind(next);
  (next === 'literal' ? literalRadioRef : secretRadioRef).current?.focus();
}
```

## Commands and results

Node: **v24.21.0**. Cwd for both commands: `D:/Git/dugate/du-rework/apps/admin-web`.

| command | exit | result |
|---|---:|---|
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | passed, no diagnostics |
| `node node_modules/vite/bin/vite.js build` | 0 | production build passed, 12.66 s |

The two commands match the existing package build pipeline (tsc then vite). Vite reports a non-failing chunk-size warning (>500 kB). Raw logs/exit codes and current source SHA-256: `coordination/reports/raw/sc03-f7-a11y-radio-2026-10-07/`. PowerShell may wrap stderr as NativeCommandError; process exit codes above are authoritative.

`git diff --check -- du-rework/apps/admin-web/src/features/secrets/value-source-selector.tsx` from `D:/Git/dugate`: exit 0.

No new unit/browser test or screen-reader certification is claimed. Independent UI verification should check one Tab entry at the checked radio, both horizontal/vertical arrow directions including wraparound, focus/aria-checked updates, Space activation, disabled state, and fenced/stored modes. No plan checkbox or acceptance state was changed.
