/**
 * Pure Profile Editor View Models (P6-03 headless foundation).
 *
 * Scope: Pure functions mapping domain/wire profiles and manifests into UI-ready
 * view models, draft validation, schema-to-widget resolution, and revision diffing.
 *
 * Pure and offline: Zero DB activity, zero HTTP I/O, zero framework dependencies,
 * strict TypeScript with zero `any`.
 */

import type {
  ConnectorCapabilityOption,
  DraftActionSpec,
  DraftCapabilityOption,
  DraftDiffEntry,
  DraftDiffReport,
  DraftIssue,
  DraftSlotSpec,
  DraftValidationInput,
  DraftValidationResult,
  FieldWidget,
  ProfileDraft,
  ProfileDraftEntry,
  ProfileFormField,
  ProfileFormModel,
  ProfileSchemaInput,
  ProfileSection,
} from './types';

export * from './types';

export type RevisionCheck =
  | { kind: 'current' }
  | { kind: 'stale'; formRevision: number; serverRevision: number }
  | { kind: 'no-profile' };

// ---------------------------------------------------------------------------
// Widget mapping & schema resolution
// ---------------------------------------------------------------------------

export const KNOWN_WIDGETS: ReadonlySet<FieldWidget> = new Set<FieldWidget>([
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'secret',
  'readonly-hint',
]);

export interface SchemaWidgetDescriptor {
  widget?: string;
  type?: string;
  format?: string;
  enum?: readonly unknown[];
  description?: string;
}

export interface WidgetMappingResult {
  widget: FieldWidget;
  unknown: boolean;
  fallbackReason?: string;
}

/**
 * Maps a manifest slot, property descriptor, or raw widget string to a recognized `FieldWidget`.
 * If an unrecognized widget name or schema shape is supplied, safely falls back to 'text'
 * and flags `unknown: true` with an explanatory fallbackReason so renderers can display
 * a non-blocking fallback indicator rather than crashing.
 */
export function mapSchemaToWidget(
  input: string | SchemaWidgetDescriptor | undefined,
): WidgetMappingResult {
  if (input === undefined) {
    return { widget: 'text', unknown: false };
  }

  if (typeof input === 'string') {
    if ((KNOWN_WIDGETS as ReadonlySet<string>).has(input)) {
      return { widget: input as FieldWidget, unknown: false };
    }
    return {
      widget: 'text',
      unknown: true,
      fallbackReason: `Unknown widget "${input}" fallen back to "text"`,
    };
  }

  // Explicit widget property on descriptor
  if (input.widget !== undefined && input.widget.length > 0) {
    if ((KNOWN_WIDGETS as ReadonlySet<string>).has(input.widget)) {
      return { widget: input.widget as FieldWidget, unknown: false };
    }
    return {
      widget: 'text',
      unknown: true,
      fallbackReason: `Unknown widget "${input.widget}" fallen back to "text"`,
    };
  }

  // Enum constraint -> select
  if (input.enum !== undefined && input.enum.length > 0) {
    return { widget: 'select', unknown: false };
  }

  // Numeric types
  if (input.type === 'number' || input.type === 'integer') {
    return { widget: 'number', unknown: false };
  }

  // Boolean type
  if (input.type === 'boolean') {
    return { widget: 'boolean', unknown: false };
  }

  // Formats indicating secret or multiline
  if (input.format === 'password' || input.format === 'secret') {
    return { widget: 'secret', unknown: false };
  }

  if (input.format === 'textarea' || input.format === 'multiline') {
    return { widget: 'textarea', unknown: false };
  }

  // Generic string
  if (input.type === 'string') {
    return { widget: 'text', unknown: false };
  }

  // Unrecognized schema descriptor
  return {
    widget: 'text',
    unknown: true,
    fallbackReason: 'Unrecognized schema definition fallen back to "text"',
  };
}

/**
 * Coerce a manifest-provided widget name to a known `FieldWidget`.
 * Delegates to `mapSchemaToWidget` for consistency.
 */
export function coerceWidget(raw: string | undefined): { widget: FieldWidget; unknown: boolean } {
  const result = mapSchemaToWidget(raw);
  return { widget: result.widget, unknown: result.unknown };
}

// ---------------------------------------------------------------------------
// Profile form field & model builders
// ---------------------------------------------------------------------------

/**
 * Build one form field from a manifest slot. Select widgets with no explicit
 * options inherit the connector capability options supplied by the server.
 */
export function buildProfileFormField(
  slot: NonNullable<ProfileSchemaInput['manifest']['actions'][number]['slots']>[number],
  capabilityOptions: ConnectorCapabilityOption[],
): ProfileFormField {
  const mapping = mapSchemaToWidget(slot.widget ?? (slot as SchemaWidgetDescriptor));
  const field: ProfileFormField = {
    slotName: slot.name,
    label: slot.name,
    widget: mapping.widget,
    required: slot.required ?? false,
  };
  if (slot.description !== undefined) {
    field.helpText = slot.description;
  }
  if (mapping.widget === 'select') {
    const options =
      slot.options && slot.options.length > 0
        ? slot.options
        : capabilityOptions.map((c) => ({ value: `${c.connectorId}:${c.capability}`, label: c.label }));
    if (options.length > 0) {
      field.options = options;
    }
  }
  if (mapping.unknown) {
    field.unknownFallback = true;
  }
  return field;
}

/**
 * Build the full schema-driven profile form model from a manifest. Sections
 * follow manifest action order; fields follow slot order. The `revisionLabel`
 * is a human-readable staleness marker (e.g. "rev 3").
 */
export function buildProfileFormModel(input: ProfileSchemaInput): ProfileFormModel {
  const sections: ProfileSection[] = input.manifest.actions.map((action) => ({
    actionName: action.name,
    fields: (action.slots ?? []).map((slot) => buildProfileFormField(slot, input.capabilityOptions)),
  }));
  const revision = input.existingProfile ? input.existingProfile.revision : 0;
  return {
    businessId: input.businessId,
    businessVersion: input.businessVersion,
    profileName: input.existingProfile?.name ?? '',
    sections,
    revisionLabel: `rev ${revision}`,
  };
}

/**
 * Compare the revision a form was rendered with against the profile's current
 * server revision. Returns a safe-to-submit verdict.
 */
export function checkProfileRevision(
  formRevision: number,
  serverProfile: { revision: number } | null,
): RevisionCheck {
  if (serverProfile === null) {
    return formRevision === 0 ? { kind: 'no-profile' } : { kind: 'stale', formRevision, serverRevision: 0 };
  }
  if (serverProfile.revision !== formRevision) {
    return { kind: 'stale', formRevision, serverRevision: serverProfile.revision };
  }
  return { kind: 'current' };
}

/**
 * Redact a slot value before displaying. Secret widgets are masked.
 */
export function displayValue(widget: FieldWidget, value: string): string {
  if (widget === 'secret') {
    return value.length > 0 ? '••••••••' : '';
  }
  return value;
}

// ---------------------------------------------------------------------------
// Profile draft validation (P6-03 pure client-side)
// ---------------------------------------------------------------------------

function widgetValueIssue(slot: DraftSlotSpec, value: string): DraftIssue | null {
  const { widget, unknown } = coerceWidget(slot.widget);
  if (unknown) {
    if (value.length === 0) return null;
    return {
      code: 'widget-unknown-fallback',
      slotName: slot.name,
      message: `Unknown widget "${slot.widget ?? ''}" treated as text`,
    };
  }
  if (value.length === 0) return null;
  switch (widget) {
    case 'number':
      if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
        return {
          code: 'widget-invalid-value',
          slotName: slot.name,
          message: 'Expected a numeric value',
        };
      }
      return null;
    case 'boolean':
      if (!/^(true|false)$/i.test(value.trim())) {
        return {
          code: 'widget-invalid-value',
          slotName: slot.name,
          message: 'Expected true or false',
        };
      }
      return null;
    case 'select': {
      if (slot.options && slot.options.length > 0) {
        const ok = slot.options.some((o) => o.value === value);
        if (!ok) {
          return {
            code: 'widget-invalid-value',
            slotName: slot.name,
            message: 'Value not in allowed options',
          };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function isSecretSlot(slot: DraftSlotSpec): boolean {
  return coerceWidget(slot.widget).widget === 'secret';
}

/**
 * Validate a profile draft against the manifest slice and capability catalog.
 * Pure and total: never throws, never performs I/O, strict TypeScript.
 */
export function validateProfileDraft(input: DraftValidationInput): DraftValidationResult {
  const issues: DraftIssue[] = [];
  const { draft, actions, capabilityOptions, serverProfile } = input;

  if (serverProfile === null && draft.formRevision !== 0) {
    issues.push({
      code: 'no-profile-target',
      slotName: '',
      message: 'Draft targets a profile that does not exist on the server',
    });
  } else if (serverProfile !== null && serverProfile.revision !== draft.formRevision) {
    issues.push({
      code: 'stale-revision',
      slotName: '',
      message: `Draft is at revision ${draft.formRevision} but server is at revision ${serverProfile.revision}`,
    });
  }

  const entryBySlot = new Map(draft.entries.map((e) => [e.slotName, e.value]));
  const capabilityValues = new Set(capabilityOptions.map((c) => `${c.connectorId}:${c.capability}`));

  for (const action of actions) {
    for (const slot of action.slots) {
      const value = entryBySlot.get(slot.name) ?? '';
      if (slot.locked) {
        const lockedValue = slot.lockedValue ?? '';
        if (value !== lockedValue) {
          issues.push({
            code: 'locked-unchanged-violation',
            slotName: slot.name,
            message: 'Locked slot must keep its current value',
          });
        }
        continue;
      }
      if ((slot.required ?? false) && value.length === 0) {
        issues.push({
          code: 'required-missing',
          slotName: slot.name,
          message: 'Required slot is empty',
        });
        continue;
      }
      const widgetIssue = widgetValueIssue(slot, value);
      if (widgetIssue) {
        issues.push(widgetIssue);
        if (widgetIssue.code === 'widget-invalid-value') continue;
      }
      if (
        coerceWidget(slot.widget).widget === 'select' &&
        !(slot.options && slot.options.length > 0) &&
        value.length > 0 &&
        !capabilityValues.has(value)
      ) {
        issues.push({
          code: 'capability-mismatch',
          slotName: slot.name,
          message: 'Selected connector capability is not available',
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Profile revision & draft diffing
// ---------------------------------------------------------------------------

export interface RevisionDiffOptions {
  businessId?: string;
  businessVersion?: string;
  profileName?: string;
  secretSlots?: readonly string[] | Set<string>;
}

function isProfileDraft(val: unknown): val is ProfileDraft {
  return (
    typeof val === 'object' &&
    val !== null &&
    'entries' in val &&
    Array.isArray((val as { entries: unknown }).entries)
  );
}

/**
 * Computes a display-safe diff between two profile revisions or between a draft
 * and server state. Secret slots never leak their raw values ('changed-secret' only).
 */
export function diffProfileRevision(
  base: ProfileDraft | Record<string, string>,
  target: { slots: DraftSlotSpec[] }[] | Record<string, string>,
  context?: Record<string, string> | RevisionDiffOptions,
): DraftDiffReport {
  // Case 1: Called with (draft: ProfileDraft, actions: { slots: DraftSlotSpec[] }[], serverValues: Record<string, string>)
  if (isProfileDraft(base) && Array.isArray(target)) {
    const draft: ProfileDraft = base;
    const actions: { slots: DraftSlotSpec[] }[] = target;
    const serverValues: Record<string, string> =
      context && !('secretSlots' in context) ? (context as Record<string, string>) : {};

    const secretNames = new Set<string>();
    const allSlots: DraftSlotSpec[] = [];
    for (const action of actions) {
      for (const slot of action.slots) {
        allSlots.push(slot);
        if (isSecretSlot(slot)) secretNames.add(slot.name);
      }
    }

    const draftBySlot = new Map<string, string>(
      draft.entries.map((e: ProfileDraftEntry): [string, string] => [e.slotName, e.value]),
    );
    const entries: DraftDiffEntry[] = [];

    for (const slot of allSlots) {
      const name = slot.name;
      const hasDraft = draftBySlot.has(name);
      const hasServer = Object.prototype.hasOwnProperty.call(serverValues, name);
      const draftValue: string = draftBySlot.get(name) ?? '';
      const serverValue: string = hasServer ? serverValues[name]! : '';

      if (secretNames.has(name)) {
        if (!hasDraft && !hasServer) {
          entries.push({ kind: 'unchanged', slotName: name });
        } else if (!hasServer && hasDraft && draftValue.length > 0) {
          entries.push({ kind: 'added', slotName: name });
        } else if (hasServer && draftValue.length === 0) {
          // Empty draft value on a secret means "keep existing" — write-only.
          entries.push({ kind: 'unchanged', slotName: name });
        } else if (hasServer && draftValue.length > 0) {
          // New secret submitted over an existing one: report without values.
          entries.push({ kind: 'changed-secret', slotName: name });
        } else {
          entries.push({ kind: 'unchanged', slotName: name });
        }
        continue;
      }

      if (!hasDraft && !hasServer) {
        entries.push({ kind: 'unchanged', slotName: name });
      } else if (hasDraft && !hasServer) {
        entries.push(
          draftValue.length > 0
            ? { kind: 'added', slotName: name }
            : { kind: 'unchanged', slotName: name },
        );
      } else if (!hasDraft && hasServer) {
        entries.push({ kind: 'removed', slotName: name });
      } else if (draftValue === serverValue) {
        entries.push({ kind: 'unchanged', slotName: name });
      } else {
        entries.push({ kind: 'changed', slotName: name, from: serverValue, to: draftValue });
      }
    }

    return {
      businessId: draft.businessId,
      businessVersion: draft.businessVersion,
      profileName: draft.profileName,
      identical: entries.every((e) => e.kind === 'unchanged'),
      entries,
    };
  }

  // Case 2: Called with record snapshots (baseValues: Record<string, string>, targetValues: Record<string, string>, options)
  const baseMap = new Map<string, string>(
    isProfileDraft(base)
      ? base.entries.map((e: ProfileDraftEntry): [string, string] => [e.slotName, e.value])
      : Object.entries(base as Record<string, string>),
  );

  const targetMap = new Map<string, string>(
    Array.isArray(target) ? [] : Object.entries(target as Record<string, string>),
  );
  const opts: RevisionDiffOptions =
    context && 'secretSlots' in context ? (context as RevisionDiffOptions) : {};
  const secretSet = new Set<string>(opts.secretSlots ?? []);

  const allKeys = new Set([...baseMap.keys(), ...targetMap.keys()]);
  const entries: DraftDiffEntry[] = [];

  for (const key of Array.from(allKeys).sort()) {
    const hasBase = baseMap.has(key);
    const hasTarget = targetMap.has(key);
    const baseVal: string = baseMap.get(key) ?? '';
    const targetVal: string = targetMap.get(key) ?? '';

    if (secretSet.has(key)) {
      if (!hasBase && hasTarget && targetVal.length > 0) {
        entries.push({ kind: 'added', slotName: key });
      } else if (hasBase && !hasTarget) {
        entries.push({ kind: 'removed', slotName: key });
      } else if (hasBase && hasTarget && targetVal !== baseVal && targetVal.length > 0) {
        entries.push({ kind: 'changed-secret', slotName: key });
      } else {
        entries.push({ kind: 'unchanged', slotName: key });
      }
      continue;
    }

    if (!hasBase && hasTarget) {
      entries.push({ kind: 'added', slotName: key });
    } else if (hasBase && !hasTarget) {
      entries.push({ kind: 'removed', slotName: key });
    } else if (baseVal === targetVal) {
      entries.push({ kind: 'unchanged', slotName: key });
    } else {
      entries.push({ kind: 'changed', slotName: key, from: baseVal, to: targetVal });
    }
  }

  return {
    businessId: opts.businessId ?? '',
    businessVersion: opts.businessVersion ?? '',
    profileName: opts.profileName ?? '',
    identical: entries.every((e) => e.kind === 'unchanged'),
    entries,
  };
}

/**
 * Backward-compatible alias for `diffProfileRevision`.
 */
export const diffProfileDraft = diffProfileRevision;
