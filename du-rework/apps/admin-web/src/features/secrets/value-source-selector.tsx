import * as React from 'react';
import { Badge, Button, FormField, Input, NativeSelect } from '@/components/ui';
import type { SecretState } from '@/lib/api';

/**
 * SC-03 — shared ValueSource selector.
 *
 * One control for fields that accept either a write-only literal ("Text") or a
 * catalog secret reference ("Secret"). Security rules encoded here:
 *
 *  - a plaintext value is NEVER read back: an already-configured literal shows
 *    a configured marker with explicit Replace/Clear, never the stored value;
 *  - switching type is an intentional replacement: the inactive side is reset
 *    on every switch, so a typed literal can never ride along with a secret
 *    selection (or a stale selection with a new literal);
 *  - the literal input is password-style and write-only (`autocomplete=off`),
 *    with a hint that it is encrypted before persistence and never displayed;
 *  - a secret selection renders metadata only (name + "Secret" badge + masked
 *    id + state); the value itself is resolved server-side, never here;
 *  - `literalOnly` / `secretOnly` let a caller reflect the frozen contract of
 *    each field (e.g. callback credentials are always secret refs).
 */

export interface SecretOption {
  secretId: string;
  name: string;
  state: SecretState;
  purpose?: string;
}

export type ValueSourceKind = 'literal' | 'secret_ref';

export interface ValueSourceSelectorProps {
  /** Unique prefix for input ids; the field label is appended. */
  idPrefix: string;
  label: string;
  kind: ValueSourceKind;
  onKindChange: (kind: ValueSourceKind) => void;
  /** Draft literal; write-only, cleared by the parent after a successful save. */
  literalValue: string;
  onLiteralChange: (value: string) => void;
  secretId: string | null;
  onSecretChange: (secretId: string | null) => void;
  secrets: readonly SecretOption[];
  /**
   * Metadata for `secretId` when it is not in `secrets` (disabled/revoked or
   * outside the selectable filter). Lets a configured reference stay visible
   * instead of masquerading as "not selected".
   */
  currentSecret?: SecretOption | null;
  secretsLoading?: boolean;
  secretsProblem?: string | null;
  /** Server read metadata for this field; never carries a value. */
  stored?: { kind: ValueSourceKind } | null;
  /** Operator is intentionally replacing a stored value. */
  replacing?: boolean;
  onRequestReplace?: () => void;
  onClear?: () => void;
  /** Contract fences: exactly one mode is allowed when set. */
  literalOnly?: boolean;
  secretOnly?: boolean;
  disabled?: boolean;
  required?: boolean;
  description?: React.ReactNode;
  /** Shown when the catalog has no selectable entries. */
  emptyHint?: React.ReactNode;
}

function maskSecretId(secretId: string): string {
  if (secretId.length <= 8) return '••••';
  return '••••••' + secretId.slice(-8);
}

function stateVariant(state: SecretState): 'success' | 'warning' | 'danger' {
  if (state === 'ACTIVE') return 'success';
  if (state === 'DISABLED') return 'warning';
  return 'danger';
}

export function ValueSourceSelector(props: ValueSourceSelectorProps): React.JSX.Element {
  const {
    idPrefix,
    label,
    kind,
    onKindChange,
    literalValue,
    onLiteralChange,
    secretId,
    onSecretChange,
    secrets,
    currentSecret = null,
    secretsLoading = false,
    secretsProblem = null,
    stored = null,
    replacing = false,
    onRequestReplace,
    onClear,
    literalOnly = false,
    secretOnly = false,
    disabled = false,
    required = false,
    description,
    emptyHint,
  } = props;

  const [filter, setFilter] = React.useState('');
  const literalRadioRef = React.useRef<HTMLButtonElement>(null);
  const secretRadioRef = React.useRef<HTMLButtonElement>(null);
  const showStored = stored !== null && !replacing;
  const selected = secrets.find((secret) => secret.secretId === secretId)
    ?? (currentSecret !== null && currentSecret.secretId === secretId ? currentSecret : null);
  const filtered = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return secrets;
    return secrets.filter(
      (secret) =>
        secret.name.toLowerCase().includes(needle) || secret.secretId.toLowerCase().includes(needle),
    );
  }, [filter, secrets]);
  // A configured reference the selectable list does not contain (disabled or
  // outside the filter) still needs an option, or the control renders blank.
  const currentOptionMissing = secretId !== null && !filtered.some((secret) => secret.secretId === secretId);
  const currentOptionLabel = selected !== null
    ? `${selected.name} — Secret (${selected.state})`
    : 'Current reference (not in the selectable list)';

  function switchKind(next: ValueSourceKind): void {
    if (next === kind) return;
    // Intentional replacement: never carry the inactive side across a switch.
    if (next === 'literal') onSecretChange(null);
    else onLiteralChange('');
    onKindChange(next);
  }

  function handleRadioKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    // With two options, either direction wraps to the other radio.
    // Follow actual focus so repeated keys also work before a parent rerender.
    const next: ValueSourceKind = event.target === literalRadioRef.current ? 'secret_ref' : 'literal';
    switchKind(next);
    (next === 'literal' ? literalRadioRef : secretRadioRef).current?.focus();
  }

  if (showStored) {
    return (
      <FormField id={`${idPrefix}-stored`} label={label} required={required} description={description}>
        <div
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/60 px-3 py-2"
          data-value-source-stored={stored.kind}
        >
          {stored.kind === 'secret_ref' ? (
            <>
              <Badge variant="info">Secret</Badge>
              {selected !== null ? (
                <span className="text-sm text-[var(--text-main)]">{selected.name}</span>
              ) : null}
              <span className="font-mono text-xs text-[var(--text-sub)]">
                {secretId !== null ? maskSecretId(secretId) : 'reference configured'}
              </span>
              {selected !== null ? (
                <Badge variant={stateVariant(selected.state)} dot>{selected.state}</Badge>
              ) : null}
            </>
          ) : (
            <span className="text-sm text-[var(--text-main)]">
              A write-only value is configured. It is never displayed again.
            </span>
          )}
          {onRequestReplace !== undefined ? (
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRequestReplace}>
              Replace
            </Button>
          ) : null}
          {onClear !== undefined ? (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </div>
      </FormField>
    );
  }

  const showToggle = !literalOnly && !secretOnly;

  return (
    <FormField id={`${idPrefix}-control`} label={label} required={required} description={description}>
      <div className="flex flex-col gap-2">
        {showToggle ? (
          <div role="radiogroup" aria-label={`${label} source type`} className="flex flex-wrap gap-2" onKeyDown={handleRadioKeyDown}>
            <Button
              ref={literalRadioRef}
              type="button"
              size="sm"
              variant={kind === 'literal' ? 'primary' : 'outline'}
              role="radio"
              aria-checked={kind === 'literal'}
              tabIndex={kind === 'literal' ? 0 : -1}
              disabled={disabled}
              onClick={() => switchKind('literal')}
            >
              Text value
            </Button>
            <Button
              ref={secretRadioRef}
              type="button"
              size="sm"
              variant={kind === 'secret_ref' ? 'primary' : 'outline'}
              role="radio"
              aria-checked={kind === 'secret_ref'}
              tabIndex={kind === 'secret_ref' ? 0 : -1}
              disabled={disabled}
              onClick={() => switchKind('secret_ref')}
            >
              Secret
            </Button>
          </div>
        ) : null}

        {kind === 'literal' ? (
          <Input
            id={`${idPrefix}-literal`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={literalValue}
            disabled={disabled}
            aria-label={`${label} write-only value`}
            placeholder="Write-only value"
            onChange={(event) => onLiteralChange(event.target.value)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {secretsLoading ? (
              <p className="text-xs text-[var(--text-sub)]" role="status">Loading secret catalog…</p>
            ) : null}
            {secretsProblem !== null ? (
              <p className="text-xs text-[var(--badge-danger-text)]" role="alert">{secretsProblem}</p>
            ) : null}
            {!secretsLoading && secretsProblem === null && secrets.length === 0 && secretId === null ? (
              <p className="text-xs text-[var(--text-sub)]">{emptyHint ?? 'No secrets in the catalog yet.'}</p>
            ) : null}
            {!secretsLoading && secrets.length > 8 ? (
              <Input
                id={`${idPrefix}-secret-filter`}
                type="search"
                value={filter}
                disabled={disabled}
                aria-label={`Filter ${label} secrets`}
                placeholder="Filter secrets"
                onChange={(event) => setFilter(event.target.value)}
              />
            ) : null}
            {secrets.length > 0 || secretId !== null ? (
              <NativeSelect
                id={`${idPrefix}-secret`}
                value={secretId ?? ''}
                disabled={disabled}
                aria-label={`${label} secret reference`}
                onChange={(event) => {
                  const next = event.target.value;
                  onSecretChange(next.length > 0 ? next : null);
                }}
              >
                <option value="">Select a secret…</option>
                {currentOptionMissing ? (
                  <option value={secretId ?? ''}>{currentOptionLabel}</option>
                ) : null}
                {filtered.map((secret) => (
                  <option key={secret.secretId} value={secret.secretId}>
                    {secret.name} — Secret ({secret.state})
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            {selected !== null ? (
              <div
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/60 px-3 py-2"
                data-value-source-selected="secret_ref"
                data-secret-state={selected.state}
              >
                <Badge variant="info">Secret</Badge>
                <span className="text-sm text-[var(--text-main)]">{selected.name}</span>
                <span className="font-mono text-xs text-[var(--text-sub)]">{maskSecretId(selected.secretId)}</span>
                <Badge variant={stateVariant(selected.state)} dot>{selected.state}</Badge>
              </div>
            ) : secretId !== null ? (
              <div
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)]/40 px-3 py-2"
                data-value-source-selected="secret_ref"
                data-secret-state="unavailable"
              >
                <Badge variant="warning">Secret</Badge>
                <span className="text-sm text-[var(--text-main)]">Configured reference is no longer available</span>
                <span className="font-mono text-xs text-[var(--text-sub)]">{maskSecretId(secretId)}</span>
              </div>
            ) : null}
            {secretId !== null && onClear !== undefined ? (
              <div>
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClear}>
                  Clear reference
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </FormField>
  );
}
