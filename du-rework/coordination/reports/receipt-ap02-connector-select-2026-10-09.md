# AP-02 connector ID selection

Updated `orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx` within the AP-02 lease. Revision lookup now uses the shared `NativeSelect` populated from `connectorSuggestions` instead of a free-text input with a datalist. The screen keeps an explicit custom-ID mode for IDs outside the advertised list; lookup trims leading and trailing whitespace as before.

The suggestions are derived at [connectors-screen.tsx:284](../../orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx#L284). `connectorIdSuggestions` uses connector rows when management is composed and `knownConnectorIds` otherwise ([state.ts:169](../../orchestrator/apps/admin-web/src/features/connectors/state.ts#L169)). The dropdown and custom fallback are at [connectors-screen.tsx:485](../../orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx#L485); the lookup continues to trim the selected/typed ID at [connectors-screen.tsx:540](../../orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx#L540).

## Verification

Working directory: `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`.

The requested command was run as written:

```text
node ../../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
REAL_EXIT=1
```

It could not resolve TypeScript at `D:\Git\dugate\du-rework\node_modules\typescript\bin\tsc` (`MODULE_NOT_FOUND`). TypeScript is installed in the admin-web package, so I ran the equivalent typecheck using that local executable:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
REAL_EXIT=0
```

The successful typecheck produced no output. No separate test suite was run for this UI-only change.

## Scope notes

The existing `connectorIdSuggestions(caps, listRows)` source was reused. When the suggestions list is empty, the select says `No connector IDs available`; the explicit custom-ID action remains available. No backend file was changed. The target file already contained unrelated edits before this task (tenant display/import changes in `ManageRevisionFacts`); those edits were preserved. No file outside the leased screen and this requested receipt was edited. No commit, staging, or push was performed.
