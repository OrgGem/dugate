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
- **Token Compliance**: Primary button text uses `--on-action` (`#ffffff`) rather than hardcoded `text-white` (F1).
- **Keyboard/A11y**: Standard Enter / Space activation, visible focus outline with `--focus-ring`.

### 2. `Input` (`./input.tsx`)
Accessible text input built on Base UI `Input`.
- **Props**:
  - `isError`: `boolean` — renders danger border, sets `aria-invalid="true"`.
  - `leftIcon`, `rightIcon`: `React.ReactNode` — decorative icon adornments.
  - Standard input HTML attributes (`placeholder`, `value`, `onChange`, `disabled`, `type`, `aria-describedby`).
- **Reflow**: `w-full min-w-0` prevents grid/flex overflow at 320px.

### 3. `Field` & `FormField` (`./field.tsx`)
Accessible form field composition using Base UI `Field`.
- **Primitives**:
  - `FieldRoot`: Form field container (`BaseField.Root`).
  - `FieldLabel`: Accessible `<label>` with optional `required` asterisk indicator.
  - `FieldDescription`: Helper explanation text linked via `aria-describedby`.
  - `FieldError`: Error message block with `role="alert"` and `aria-live="polite"`.
- **Composite `FormField` (F3)**:
  - Pre-assembled container accepting `id`, `label`, `description`, `error`, `required`, and `children`.
  - Automatically clones single-element children and wires `id`, `aria-describedby`, `aria-errormessage`, and `aria-invalid` directly to the input element for complete accessibility without manual binding.

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
- **Composites**:
  - `Modal`: High-level wrapper with title, description, body, footer, and close button.
  - `ConfirmDialog`: Replaces `window.confirm` for destructive/critical admin operations (with loading state).

### 6. `Table` (`./table.tsx`)
Responsive data tables with semantic HTML markup.
- **Primitives**: `TableContainer` (overflow-x auto, styled with `--shadow-card` [F2]), `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow` (hover highlight), `TableHead`, `TableCell`, `TableEmpty` (empty state row spanning columns).
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
- **Production Barrel** (`@/components/ui` via `./index.ts`): Exports only production UI primitives. Demo components and fixtures are excluded to keep bundle size minimal.
- **Fixtures & Demo**: Available via explicit subpaths `@/components/ui/fixtures` and `@/components/ui/demo`.
- **Subpath Imports**: Integrators may continue importing components via subpaths (e.g. `@/components/ui/button`) or from the root barrel.

- `ComponentDemo`: Interactive showcase component demonstrating all primitives, light/dark mode toggling, long text handling, and all 5 screen states.
