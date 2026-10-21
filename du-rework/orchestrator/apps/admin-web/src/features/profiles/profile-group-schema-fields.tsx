/**
 * PC-08 / PC-R06 — schema-driven field renderer used by the Profile Group
 * configuration pane for BOTH sources of a V2 function binding:
 *   - `profileSchema`  → profileSettings (`policy.parameters`)
 *   - `inputSchema`    → requestDefaults (a V2 sibling of `policy`)
 * Keeping one renderer means the two sources can never drift in control type.
 *
 * PC-R06: a value edit is a VALUE edit. Lock metadata (`isLocked`) is never
 * written from here, the displayed value never substitutes a schema default for
 * a stored `null`/`false`/`0`, and the effective lock is displayed so an
 * operator can see that editing a value did not unlock the field.
 */
import { useState } from 'react';
import type { ProfileParameterValue } from '@du/contracts';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { parameterLockDisplay, type ParameterLockDisplay } from './profile-group-state';

function lockDescription(display: ParameterLockDisplay): string {
  switch (display) {
    case 'locked':
      return 'Locked: clients cannot override this value.';
    case 'unlocked-explicitly':
      return 'Explicitly unlocked: overrides a schema default lock.';
    case 'locked-by-schema':
      return 'Locked by the schema default; no explicit override is stored.';
    case 'unlocked':
      return 'Unlocked.';
  }
}

export function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties'];
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface JsonFieldProps {
  ariaLabel: string;
  definition: Record<string, unknown>;
  value: unknown;
  disabled: boolean;
  error: string | null;
  onError: (message: string | null) => void;
  onChange: (value: unknown) => void;
}

function JsonField({ ariaLabel, definition, value, disabled, error, onError, onChange }: JsonFieldProps) {
  const type = definition['type'] === 'array' ? 'array' : 'object';
  const [text, setText] = useState(() => JSON.stringify(value ?? (type === 'array' ? [] : {}), null, 2));
  return (
    <FormField
      label={ariaLabel}
      description={typeof definition['description'] === 'string' ? definition['description'] : undefined}
      error={error ?? undefined}
    >
      <textarea
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        className="min-h-24 w-full min-w-0 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 font-mono text-xs"
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            if (type === 'array' ? !Array.isArray(parsed) : (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
              onError(`Enter a JSON ${type}.`);
              return;
            }
            onError(null);
            onChange(parsed);
          } catch {
            onError('Enter valid JSON.');
          }
        }}
      />
    </FormField>
  );
}

export interface ProfileGroupSchemaFieldsProps {
  schema: Record<string, unknown>;
  values: Record<string, ProfileParameterValue>;
  onChange: (parameter: string, value: unknown) => void;
  disabled?: boolean;
  /** Prefix for accessible labels, e.g. `Profile settings for extract.invoice`. */
  labelPrefix: string;
  /** Keys the caller renders itself (already display-only) are skipped. */
  skip?: (parameter: string) => boolean;
  emptyMessage: string;
  /**
   * PC-R06: when provided, each field renders its lock state from the STORED
   * entry plus the schema `defaultLocked` annotation. Read-only on purpose: a
   * value edit must never change the lock, and a silent unlock control is
   * exactly the defect being fixed.
   */
  lockMeta?: (parameter: string) => {
    entry: ProfileParameterValue | undefined;
    schemaDefaultLocked: boolean | undefined;
  };
}

export function ProfileGroupSchemaFields({
  schema,
  values,
  onChange,
  disabled = false,
  labelPrefix,
  skip,
  emptyMessage,
  lockMeta,
}: ProfileGroupSchemaFieldsProps) {
  const properties = schemaProperties(schema);
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((field): field is string => typeof field === 'string')
    : [];
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const entries = Object.entries(properties).filter(([parameter]) => !(skip?.(parameter) ?? false));

  if (entries.length === 0) {
    return <p className="text-xs text-[var(--text-sub)]">{emptyMessage}</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map(([parameter, rawDefinition]) => {
        const definition = asRecord(rawDefinition);
        const isRequired = required.includes(parameter);
        const label = `${typeof definition['title'] === 'string' ? definition['title'] : parameter}${isRequired ? ' *' : ''}`;
        const ariaLabel = `${labelPrefix}: ${label}`;
        // PC-R06: a stored entry wins even when its value is null/false/0/''.
        // Only an ABSENT entry may fall back to the schema default for display.
        const stored = Object.prototype.hasOwnProperty.call(values, parameter) ? values[parameter] : undefined;
        const current = stored !== undefined ? stored.value : definition['default'] ?? '';
        const enumValues = Array.isArray(definition['enum']) ? definition['enum'] : null;
        const type = Array.isArray(enumValues) ? 'enum' : definition['type'];
        const setError = (message: string | null): void => setErrors((currentErrors) => ({ ...currentErrors, [parameter]: message }));
        const lock = lockMeta?.(parameter);
        const lockDisplay = lock ? parameterLockDisplay(lock.entry, lock.schemaDefaultLocked) : null;

        let control: React.ReactNode;
        if (type === 'object' || type === 'array') {
          control = (
            <JsonField
              ariaLabel={ariaLabel}
              definition={definition}
              value={stored?.value}
              disabled={disabled}
              error={errors[parameter] ?? null}
              onError={setError}
              onChange={(value) => onChange(parameter, value)}
            />
          );
        } else if (type === 'boolean') {
          control = (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={ariaLabel}
                checked={current === true}
                disabled={disabled}
                onChange={(event) => onChange(parameter, event.target.checked)}
              />
              {label}
            </label>
          );
        } else if (type === 'enum' && enumValues) {
          control = (
            <FormField label={label}>
              <select
                aria-label={ariaLabel}
                className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                value={String(current)}
                disabled={disabled}
                onChange={(event) => {
                  const next = enumValues.find((item) => String(item) === event.target.value);
                  onChange(parameter, next ?? event.target.value);
                }}
              >
                <option value="">Select…</option>
                {enumValues
                  .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
                  .map((item) => (
                    <option key={String(item)} value={String(item)}>
                      {String(item)}
                    </option>
                  ))}
              </select>
            </FormField>
          );
        } else {
          const numeric = type === 'number' || type === 'integer';
          control = (
            <FormField
              label={label}
              description={typeof definition['description'] === 'string' ? definition['description'] : undefined}
            >
              <Input
                aria-label={ariaLabel}
                type={numeric ? 'number' : 'text'}
                step={type === 'integer' ? '1' : type === 'number' ? 'any' : undefined}
                value={String(current ?? '')}
                disabled={disabled}
                onChange={(event) => {
                  if (!numeric) {
                    onChange(parameter, event.target.value);
                    return;
                  }
                  onChange(parameter, event.target.value === '' ? '' : Number(event.target.value));
                }}
              />
            </FormField>
          );
        }

        return (
          <div key={parameter} className="min-w-0" data-parameter={parameter}>
            {control}
            {lockDisplay ? (
              <p
                className="mt-1 text-xs text-[var(--text-sub)]"
                data-lock-state={lockDisplay}
                data-testid={`lock-state-${parameter}`}
              >
                {lockDescription(lockDisplay)}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
