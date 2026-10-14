# `components/ui` — Owned by AWEB-03 (Antigravity)

Shared UI primitives for the Orchestrator Portal (`du-rework/orchestrator/apps/admin-web`), built with **Base UI** (`@base-ui/react`), Tailwind CSS v4, and the single-source token system in `src/styles/tokens.css`.

All components strictly adhere to the UI Contract (`docs/admin-ui-development-contract.md` §2–3):
- **Pure props/callback**: No `fetch`, no cookies, no knowledge of API endpoints, role, or tenant logic.
- **Single design token source**: Colors, borders, radii, and focus rings resolve to CSS variables (`--cf-*`, `--badge-*`, `--bg-*`, `--border-*`).
- **Accessibility & Focus**: ARIA attributes (`aria-invalid`, `aria-describedby`, `aria-busy`), visible focus rings (`--focus-ring`), keyboard navigation (Dialog focus trap, Tabs roving tabindex).
- **Responsive reflow**: Designed to reflow down to 320 CSS px without horizontal overflow.
- **Theme support**: Full light and dark mode support via CSS variables and media query / `[data-theme='dark']` / `.dark`.

---

## Component Index & Prop Contracts

### 1. `Button` (`./button.tsx`)
Headless Base UI `Button` with styled variants and accessible loading states.
- **Props**:
  - `variant`: `'primary' | 'secondary' | 'outline' | 'destructive' | 'ghost' | 'link'` (default: `'primary'`)
  - `size`: `'sm' | 'md' | 'lg' | 'icon'` (default: `'md'`)
  - `isLoading`: `boolean` — renders spinning `Loader2`, sets `aria-busy="true"`, disables click.
  - `leftIcon`, `rightIcon`: `React.ReactNode`
  - Standard button HTML attributes (`disabled`, `type="button" | "submit"`, `onClick`, `aria-label`).
- **Touch targets**: Below 640px, `sm`/`md` buttons are 40px high and `lg`/`icon` buttons are 44px high. At 640px and wider, heights are 32px, 36px, 40px, and 36px respectively. Tailwind height/size utilities passed through `className` override these defaults.
- **Token Compliance**: Primary button text uses `--on-action` (`#ffffff`) rather than hardcoded `text-white` (F1).
- **Keyboard/A11y**: Standard Enter / Space activation, visible focus outline with `--focus-ring`.

### 2. `Input` (`./input.tsx`)
Accessible text input built on Base UI `Input`.
- **Props**:
  - `isError`: `boolean` — renders danger border, sets `aria-invalid="true"`.
  - `leftIcon`, `rightIcon`: `React.ReactNode` — decorative icon adornments.
  - Standard input HTML attributes (`placeholder`, `value`, `onChange`, `disabled`, `type`, `aria-describedby`).
- **Reflow**: `w-full min-w-0` prevents grid/flex overflow at 320px.
- **Content row**: Children render in a non-wrapping inline-flex row, including an icon supplied as part of `children`; `leftIcon` and `rightIcon` remain decorative.

### 3. `Field` & `FormField` (`./field.tsx`)
Accessible form field composition using Base UI `Field`.
- **Primitives**:
  - `FieldRoot`: Form field container (`BaseField.Root`).
  - `FieldLabel`: Accessible `<label>` with optional `required` asterisk indicator.
  - `FieldDescription`: Helper explanation text linked via `aria-describedby`.
  - `FieldError`: Error message block with `role="alert"` and `aria-live="polite"`.
- **Composite `FormField` (F3)**:
  - Pre-assembled container accepting `id`, `primaryControlId`, `label`, `description`, `error`, `required`, `reserveErrorSpace`, and `children`.
  - Wires help and error text to supported controls in direct children, arrays, and fragments while preserving each control's id and existing ARIA labels. A single control receives the visible label; a multi-control field uses a fieldset and legend unless `id` or `primaryControlId` names the intended label target. Give each control in a group its own accessible name.
  - `reserveErrorSpace` keeps one validation-message line open for fields where showing an error should not move nearby controls.
  - Descriptions and errors stay visibly below the control. In a side-by-side form toolbar, align actions with the control row and keep dynamic messages below that row. Aligning the whole `FormField` at the bottom can move actions when a message appears; aligning the field at the top aligns actions with its label, not the control.

### 4. `Select` & `NativeSelect` (`./select.tsx`)
- **Base UI Primitives**: `SelectRoot`, `SelectTrigger`, `SelectValue`, `SelectPortal`, `SelectPositioner`, `SelectPopup`, `SelectItem`, `SelectItemText`, `SelectGroup`, `SelectGroupLabel`, `SelectSeparator`.
- **`NativeSelect`**: Styled native HTML `<select>` with ChevronDown indicator for fast rendering and reliable mobile UX.
  - `isError`: `boolean`
  - Standard select HTML attributes (`disabled`, `value`, `onChange`, `children`).

### 5. `Dialog`, `Modal`, `ConfirmDialog` (`./dialog.tsx`)
Accessible modal dialogs built on Base UI `Dialog`.
- **Primitives**: `DialogRoot`, `DialogTrigger`, `DialogPortal`, `DialogBackdrop`, `DialogPopup`, `DialogTitle`, `DialogDescription`, `DialogClose`, `DialogHeader`, `DialogBody`, `DialogFooter`.
- **Features**:
  - **Focus Trap**: Automatically traps Tab / Shift+Tab navigation within the active modal.
  - **Focus Restoration**: Returns keyboard focus to the triggering element upon dismissal.
  - **Escape Dismissal**: Closes on Escape key press.
  - **Backdrop Dimming**: Dimmed backdrop with blur using `--bg-backdrop`.
  - **Close control**: The close target is 44px on narrow screens and 40px on larger screens.
- **Composites**:
  - `Modal`: High-level wrapper with title, description, body, footer, and close button.
  - `ConfirmDialog`: Replaces `window.confirm` for destructive/critical admin operations (with loading state).

### 6. `Table` (`./table.tsx`)
Responsive data tables with semantic HTML markup.
- **Primitives**: `TableContainer` (horizontal scrolling by default; optional `maxHeight` enables bounded vertical scrolling and keyboard focus), `Table`, `TableHeader` (optional `sticky`), `TableBody`, `TableFooter`, `TableRow` (hover highlight), `TableHead`, `TableCell`, `TableEmpty` (empty state row spanning columns), and `TablePagination`.
- **Narrow screens**: Header labels stay on one line so wide tables scroll horizontally instead of stacking words vertically.
- **Scroll accessibility**: A bounded `TableContainer` receives `tabIndex=0`; provide `aria-label` to expose it as a named region for assistive technology.
- **Density**: `Table density="compact"` reduces header and cell spacing for data-dense views.
- **Pagination**: `TablePagination` accepts previous/next availability and callbacks plus an optional status message. It only invokes the supplied callbacks; consumers retain server cursor/offset behavior and should not infer full totals from a loaded subset.
- **Reflow**: TableContainer ensures wide tables scroll horizontally without breaking screen layout on narrow screens (320px).

### 7. `Badge` (`./badge.tsx`)
Status badges mapped to `--badge-*` tokens.
- **Props**:
  - `variant`: `'success' | 'info' | 'warning' | 'danger' | 'neutral'`
  - `size`: `'sm' | 'md'`
  - `dot`: `boolean` — status indicator dot.
  - `icon`: `React.ReactNode`

### 8. `Card` (`./card.tsx`)
Standard surface container.
- **Primitives**: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.
- Follows `--bg-card`, `--border-subtle`, and `--shadow-card`.

### 9. `Tabs` (`./tabs.tsx`)
Keyboard-accessible tabs built on Base UI `Tabs`.
- **Primitives**: `TabsRoot`, `TabsList`, `TabsTab`, `TabsPanel`.
- **Features**: Roving tabindex and Left/Right Arrow keyboard navigation built-in.
- Tabs keep their label width in horizontally scrollable lists; a thin token-colored scrollbar shows when more tabs are off-screen.

### 10. `StatePanel` & Feedback States (`./state-panel.tsx`)
Standardized screen state representations required by contract §3:
- **States**:
  1. `LoadingState` (spinner + title + description + optional `Skeleton` pulse)
  2. `ReadyState` (main content rendered)
  3. `EmptyState` (icon + message + optional action button)
  4. `ErrorState` (alert icon + error description + status code badge [401/403/409/422/500] + retry button)
     - **Convention (F5)**: Callers must pass sanitized, bounded messages or standard problem codes (e.g. `problem.code`), avoiding raw unvetted stack traces or server internals.
  5. `DeniedState` (lock icon + 403 Forbidden message + tenant/role boundary info)
- `AlertBanner`: Inline notifications (`info`, `success`, `warning`, `error`).
- `Skeleton`: Pulsing placeholder block.

### 11. `AppShell` Primitives (`./app-shell-primitives.tsx`)
Header, layout, navigation, brand, and footer primitives for application framing.
- `AppShellLayout`, `AppShellHeader`, `AppShellBrand`, `AppShellNav`, `AppShellNavItem`, `AppShellMain`, `AppShellFooter`, `AppShellStatusBadge`.
- Used in `src/app-shell/app-shell.tsx` with navigation links to `Overview` (`/overview`) and `Bootstrap` (`/`) (F6).

### 12. Barrel Exports & Subpaths (F4)
- **Production Barrel** (`@/components/ui` via `./index.ts`): Exports only production UI primitives. The demo component and its fixtures were removed as dead code (they had no importer); nothing ships them anymore.
- **Subpath Imports**: Integrators may continue importing components via subpaths (e.g. `@/components/ui/button`) or from the root barrel.
