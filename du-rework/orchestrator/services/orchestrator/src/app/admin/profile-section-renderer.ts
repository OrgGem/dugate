/**
 * P6-03 Profile section renderer.
 *
 * Pure HTML renderer for the schema-driven profile editor pane.
 * Consumes the view-model layer (`profile-view-models.ts`) and the
 * fetcher's `ProfileFetchResult`. The renderer turns a manifest's
 * actions + slots into a fully-escaped form with one section per
 * action and one field per slot.
 *
 * Design:
 * - Per-action section header (action name + manifest title).
 * - Per-slot field with the widget type rendered as the
 *   appropriate `<input>` / `<select>` / `<textarea>` element.
 * - Locked slots render `readonly` and carry `data-locked="true"`
 *   so the renderer never needs a re-fetch to know whether to
 *   allow editing. The locked value is shown verbatim — the
 *   renderer never invents a new value for a locked slot.
 * - Secret slots render `type="password"` and are never echoed.
 *   Existing secret values surface only as `••••••••` via the
 *   view-model's `displayValue` helper.
 * - Unknown widgets fall back to `text` and are flagged with
 *   `data-unknown-widget="<name>"` + a `unknown-fallback-banner`
 *   for the renderer / a11y tooling to highlight. The renderer
 *   never crashes on an unrecognised widget name.
 * - Prompt-catalog column: when the fetcher supplies
 *   `promptCatalog`, each slot with a known prompt entry renders
 *   a non-editable hint listing the prompt-config keys. Empty
 *   prompt-catalog → column omitted.
 *
 * - Failure fallbacks: empty / not-found / unauthorized / error
 *   panes map onto the existing screen states. The `isReady`
 *   flag flips for the success (form) pane only.
 *
 * Strict TypeScript, zero `any`. Every value flowing into HTML
 * goes through `esc()`.
 */

import { esc } from './shell-render';
import type { ProfileFetchResult } from './profile-section-data';
import {
  displayValue,
} from './profile-view-models';
import type {
  FieldWidget,
  ProfileFormField,
  ProfileFormModel,
  ProfileSection,
} from './types';

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

/**
 * The renderer's input. `fetch` is the full discriminated
 * `ProfileFetchResult` so the renderer can map every transport
 * outcome (ok / empty / unauthorized / not-found / error) onto a
 * stable HTML pane. The renderer never throws.
 */
export interface ProfileSectionRenderInput {
  fetch: ProfileFetchResult;
  /** Optional profile manifest from another business version for schema comparison. */
  compareFetch?: ProfileFetchResult;
  compareVersion?: string;
  /**
   * Optional canonical list of business ids the shell recognises.
   * Drives the business picker at the top of the pane (mirrors the
   * P6-02 business-section picker). When omitted, the renderer
   * omits the picker and relies on the path's `?businessId=`.
   */
  knownBusinessIds?: readonly string[];
  /** Currently selected business id; drives the picker active state. */
  selectedBusinessId?: string;
}

/** Re-export the renderer-specific bit of the fetcher result. */
export type ProfileSectionOkResult = ProfileFetchResult & { kind: 'ok' };

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ProfileSectionRenderOutput {
  /** The full section HTML (form / fallback pane). */
  html: string;
  /**
   * True iff the rendered HTML represents the editable form (the
   * `ok` pane). When false, the body pane is one of the fallback
   * states.
   */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldId(sectionIndex: number, slotName: string): string {
  return `slot-${sectionIndex}-${slotName}`;
}

function renderLabel(sectionIndex: number, field: ProfileFormField, locked: boolean): string {
  const requiredMark = field.required
    ? '<span class="field-required" aria-hidden="true">*</span>'
    : '';
  const lockedMark = locked
    ? '<span class="field-locked-mark" aria-hidden="true">🔒</span>'
    : '';
  const help =
    field.helpText !== undefined && field.helpText.length > 0
      ? `<small class="field-help" id="${esc(fieldId(sectionIndex, field.slotName))}-help">${esc(field.helpText)}</small>`
      : '';
  return [
    `<label class="field-label" for="${esc(fieldId(sectionIndex, field.slotName))}">`,
    esc(field.label),
    requiredMark,
    lockedMark,
    '</label>',
    help,
  ].join('');
}

/**
 * Per-request bundle of the metadata the renderer needs to render a
 * slot, carried from the fetcher result so the renderer never
 * re-parses the wire payload.
 */
interface SlotRenderContext {
  promptCatalog: ReadonlyMap<string, ReadonlyArray<string>>;
  unknownWidgetBySlot: ReadonlyMap<string, string>;
  /** Slot names the server marked locked. */
  lockedBySlot: ReadonlySet<string>;
  /** For locked slots: the server-owned value shown verbatim. */
  lockedValueBySlot: ReadonlyMap<string, string>;
}

function isLocked(field: ProfileFormField, ctx: SlotRenderContext): boolean {
  // `unknownFallback` is independent of locking. Locked slots are
  // server-owned: the fetcher surfaces the lock set on the result
  // (`lockedBySlot`) and the renderer marks those inputs
  // `readonly`/`disabled` + `data-locked="true"`. The server
  // re-validates on submit — this only drives display.
  return ctx.lockedBySlot.has(field.slotName);
}

/** Server-owned value for a locked slot; `undefined` for editable slots. */
function lockedValueFor(
  field: ProfileFormField,
  ctx: SlotRenderContext,
): string | undefined {
  return ctx.lockedBySlot.has(field.slotName)
    ? ctx.lockedValueBySlot.get(field.slotName) ?? ''
    : undefined;
}

function renderInput(
  sectionIndex: number,
  field: ProfileFormField,
  currentValue: string,
  unknownSource: string | undefined,
  ctx: SlotRenderContext,
): string {
  const id = esc(fieldId(sectionIndex, field.slotName));
  const name = `slot.${esc(field.slotName)}`;
  const locked = isLocked(field, ctx);
  const readonlyAttr = locked ? ' readonly' : '';
  const disabledAttr = locked ? ' disabled' : '';
  const commonAttrs = `id="${id}" name="${name}" data-slot="${esc(field.slotName)}" data-widget="${esc(field.widget)}"${disabledAttr}`;
  // A locked slot shows the server-owned value verbatim; an editable
  // slot shows the current (possibly draft) value through the
  // widget-aware masking (secret → ••••••••).
  const lockedSource = lockedValueFor(field, ctx);
  const value = displayValue(field.widget, lockedSource !== undefined ? lockedSource : currentValue);
  const valueAttr = ` value="${esc(value)}"`;
  const aria = ` aria-describedby="${id}-help"`;

  if (field.widget === 'textarea') {
    return [
      `<textarea class="field-input field-input--textarea" rows="4"${readonlyAttr}${aria}${commonAttrs}>${esc(value)}</textarea>`,
    ].join('');
  }
  if (field.widget === 'boolean') {
    // Render as a tri-state select to avoid HTML checkbox state
    // surprises on locked fields.
    const options: Array<[string, string]> = [
      ['true', 'true'],
      ['false', 'false'],
    ];
    const opts = options
      .map(
        ([v, l]) =>
          `<option value="${esc(v)}"${value === v ? ' selected' : ''}>${esc(l)}</option>`,
      )
      .join('');
    return [
      `<select class="field-input field-input--boolean"${disabledAttr}${aria}${commonAttrs}>${opts}</select>`,
    ].join('');
  }
  if (field.widget === 'select') {
    const options = field.options ?? [];
    const opts = options
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${value === o.value ? ' selected' : ''}>${esc(o.label)}</option>`,
      )
      .join('');
    return [
      `<select class="field-input field-input--select"${disabledAttr}${aria}${commonAttrs}>${opts}</select>`,
    ].join('');
  }
  if (field.widget === 'number') {
    return [
      `<input class="field-input field-input--number" type="number"${readonlyAttr}${valueAttr}${aria}${commonAttrs}>`,
    ].join('');
  }
  if (field.widget === 'secret') {
    return [
      `<input class="field-input field-input--secret" type="password" autocomplete="off"${readonlyAttr}${valueAttr}${aria}${commonAttrs}>`,
    ].join('');
  }
  if (field.widget === 'readonly-hint') {
    return [
      `<input class="field-input field-input--readonly-hint" type="text" readonly tabindex="-1"${valueAttr}${aria}${commonAttrs}>`,
    ].join('');
  }
  // Default + fallback: text
  const unknownAttr = unknownSource !== undefined && unknownSource.length > 0
    ? ` data-unknown-widget="${esc(unknownSource)}"`
    : '';
  return [
    `<input class="field-input field-input--text" type="text"${readonlyAttr}${valueAttr}${aria}${commonAttrs}${unknownAttr}>`,
  ].join('');
}

function renderPromptCatalogHint(
  field: ProfileFormField,
  promptCatalog: ReadonlyMap<string, ReadonlyArray<string>>,
): string {
  const keys = promptCatalog.get(field.slotName);
  if (!keys || keys.length === 0) return '';
  const items = keys.map((k) => `<li><code>${esc(k)}</code></li>`).join('');
  return [
    '<aside class="field-prompt-catalog" aria-label="Prompt catalog">',
    '<header>Prompt catalog</header>',
    `<ul class="field-prompt-catalog__list">${items}</ul>`,
    '</aside>',
  ].join('');
}

function renderUnknownBanner(count: number): string {
  if (count === 0) return '';
  return [
    `<section class="profile-section__unknown-banner" role="status">`,
    `<strong>Unknown widget${count === 1 ? '' : 's'} detected.</strong> `,
    `These fields fell back to a text input; the renderer is not breaking — review the manifest.`,
    '</section>',
  ].join('');
}

function renderField(
  sectionIndex: number,
  field: ProfileFormField,
  currentValue: string,
  unknownSource: string | undefined,
  ctx: SlotRenderContext,
): string {
  const classes = [
    'field',
    `field--${esc(field.widget)}`,
  ];
  if (field.required) classes.push('field--required');
  if (isLocked(field, ctx)) classes.push('field--locked');
  if (field.unknownFallback === true) classes.push('field--unknown-fallback');
  const lockAttr = isLocked(field, ctx) ? ' data-locked="true"' : '';
  const fallbackAttr = field.unknownFallback === true ? ' data-unknown-fallback="true"' : '';
  return [
    `<div class="${classes.join(' ')}" data-slot="${esc(field.slotName)}" data-widget="${esc(field.widget)}"${lockAttr}${fallbackAttr}>`,
    renderLabel(sectionIndex, field, isLocked(field, ctx)),
    renderInput(sectionIndex, field, currentValue, unknownSource, ctx),
    renderPromptCatalogHint(field, ctx.promptCatalog),
    '</div>',
  ].join('');
}

function renderSection(
  sectionIndex: number,
  section: ProfileSection,
  currentValues: Readonly<Record<string, string>>,
  ctx: SlotRenderContext,
): string {
  const fields = section.fields
    .map((f) =>
      renderField(
        sectionIndex,
        f,
        currentValues[f.slotName] ?? '',
        ctx.unknownWidgetBySlot.get(f.slotName),
        ctx,
      ),
    )
    .join('');
  return [
    `<details class="profile-section__action" id="profile-action-${sectionIndex}" data-action="${esc(section.actionName)}" open>`,
    `<summary class="profile-section__action-header"><h3>${esc(section.actionName)}</h3></summary>`,
    `<div class="profile-section__fields">${fields}</div>`,
    '</details>',
  ].join('');
}

function renderForm(
  model: ProfileFormModel,
  currentValues: Readonly<Record<string, string>>,
  ctx: SlotRenderContext,
): string {
  let unknownCount = 0;
  for (const s of model.sections) {
    for (const f of s.fields) {
      if (f.unknownFallback === true) unknownCount += 1;
    }
  }
  const sections = model.sections
    .map((s, idx) => renderSection(idx, s, currentValues, ctx))
    .join('');
  const actionLinks = model.sections.map((section, idx) =>
    `<li><a href="#profile-action-${idx}">${esc(section.actionName)}</a></li>`,
  ).join('');
  const isDraft = model.revisionLabel === 'rev 0';
  const submitAction = '/admin/profiles';
  return [
    '<form method="POST" action="' + esc(submitAction) + '" class="profile-section__form">',
    '<header class="profile-section__form-header">',
    `<h2>Profile <code>${esc(model.profileName.length > 0 ? model.profileName : '(new)')}</code></h2>`,
    `<p class="profile-section__revision" data-revision="${esc(model.revisionLabel)}" data-lifecycle="${isDraft ? 'draft' : 'active'}"><strong>${isDraft ? 'Draft' : 'Active'}</strong> · ${esc(model.revisionLabel)}</p>`,
    '</header>',
    renderUnknownBanner(unknownCount),
    actionLinks.length > 0 ? `<nav class="profile-section__action-list" aria-label="Profile action list"><ul>${actionLinks}</ul></nav>` : '',
    `<div class="profile-section__sections">${sections}</div>`,
    '<footer class="profile-section__form-footer">',
    '<button type="submit" class="profile-section__submit">Save draft</button>',
    '</footer>',
    '</form>',
  ].join('');
}

function renderBusinessPicker(
  knownIds: readonly string[],
  selected: string,
  businessVersion: string,
  profileName: string,
  compareVersion: string,
): string {
  if (knownIds.length === 0) {
    return '<p class="profile-section__picker-empty">No businesses are registered on this shell yet.</p>';
  }
  const options = knownIds
    .map(
      (id) =>
        `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(id)}</option>`,
    )
    .join('');
  return [
    '<form method="GET" action="/admin/profiles" class="profile-section__picker">',
    '<label for="profileBusinessId">Business</label>',
    `<select id="profileBusinessId" name="businessId">${options}</select>`,
    '<label for="profileBusinessVersion">Business version</label>',
    `<input id="profileBusinessVersion" name="businessVersion" value="${esc(businessVersion)}" required>`,
    '<label for="profileName">Profile</label>',
    `<input id="profileName" name="profile" value="${esc(profileName)}" placeholder="new profile">`,
    '<label for="profileCompareVersion">Compare with version</label>',
    `<input id="profileCompareVersion" name="compareVersion" value="${esc(compareVersion)}" placeholder="optional">`,
    '<button type="submit">Open profile</button>',
    '</form>',
  ].join('');
}

function profileSchemaFields(model: ProfileFormModel): Array<{ key: string; description: string }> {
  return model.sections.flatMap((section) => section.fields.map((field) => ({
    key: `${section.actionName}.${field.slotName}`,
    description: `${field.widget}; ${field.required ? 'required' : 'optional'}`,
  })));
}

function renderProfileCompare(
  current: ProfileFormModel,
  comparison: ProfileFetchResult | undefined,
  compareVersion: string,
): string {
  if (!compareVersion) return '';
  if (!comparison || comparison.kind !== 'ok') {
    return `<p class="profile-section__compare-missing" role="status">Version ${esc(compareVersion)} could not be loaded for comparison.</p>`;
  }
  const currentFields = profileSchemaFields(current);
  const otherFields = profileSchemaFields(comparison.model);
  const otherByKey = new Map(otherFields.map((field) => [field.key, field.description]));
  const currentByKey = new Map(currentFields.map((field) => [field.key, field.description]));
  const keys = [...new Set([...currentByKey.keys(), ...otherByKey.keys()])].sort();
  const rows = keys.map((key) => {
    const left = currentByKey.get(key);
    const right = otherByKey.get(key);
    const status = left === undefined ? 'Added in comparison' : right === undefined ? 'Missing in comparison' : left === right ? 'Same' : 'Changed';
    return `<tr data-diff="${esc(status.toLowerCase().replace(/\s+/g, '-'))}"><th scope="row">${esc(key)}</th><td>${esc(left ?? '—')}</td><td>${esc(right ?? '—')}</td><td>${esc(status)}</td></tr>`;
  }).join('');
  return [
    `<section class="profile-section__compare" aria-label="Profile schema comparison" data-compare-version="${esc(comparison.businessVersion)}">`,
    `<h3>Schema comparison: ${esc(current.businessVersion)} and ${esc(comparison.businessVersion)}</h3>`,
    '<table><thead><tr><th scope="col">Action and field</th><th scope="col">Selected version</th><th scope="col">Compared version</th><th scope="col">Change</th></tr></thead>',
    `<tbody>${rows || '<tr><td colspan="4">No schema fields are available to compare.</td></tr>'}</tbody></table>`,
    '<p>Only field names and schema settings are compared; configured values and secrets are not shown.</p>',
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the Profile editor pane from a `ProfileFetchResult`. Pure:
 * same input → same output, no I/O. Never throws.
 */
export function renderProfileSection(input: ProfileSectionRenderInput): ProfileSectionRenderOutput {
  const f = input.fetch;

  if (f.kind === 'ok') {
    const picker = input.knownBusinessIds
      ? renderBusinessPicker(
          input.knownBusinessIds,
          input.selectedBusinessId ?? f.businessId,
          f.businessVersion,
          f.profileName,
          input.compareVersion ?? '',
        )
      : '';
    const ctx: SlotRenderContext = {
      promptCatalog: f.promptCatalog,
      unknownWidgetBySlot: f.originalWidgetBySlot,
      lockedBySlot: f.lockedBySlot,
      lockedValueBySlot: f.lockedValueBySlot,
    };
    return {
      html: [
        '<section class="profile-section" data-business-id="' + esc(f.businessId) + '" data-business-version="' + esc(f.businessVersion) + '" data-revision="' + esc(String(f.revision)) + '">',
        picker,
        `<p class="profile-section__lifecycle" data-lifecycle="${f.revision === 0 ? 'draft' : 'active'}">${f.revision === 0 ? 'Draft' : `Active revision ${esc(String(f.revision))}`}</p>`,
        renderForm(f.model, f.currentValues, ctx),
        renderProfileCompare(f.model, input.compareFetch, input.compareVersion ?? ''),
        '</section>',
      ].join(''),
      isReady: true,
    };
  }

  if (f.kind === 'empty') {
    return {
      html: [
        '<section class="profile-section profile-section--empty" role="status">',
        '<h2>Profile editor</h2>',
        `<p>${esc(f.message)}</p>`,
        '</section>',
      ].join(''),
      isReady: false,
    };
  }

  if (f.kind === 'unauthorized') {
    return {
      html: [
        '<section class="profile-section profile-section--unauthorized" role="alert">',
        '<h2>Admin token rejected</h2>',
        `<p>${esc(f.message)}</p>`,
        '<p>The shell reuses the orchestrator admin bearer token. Update the platform config and reload.</p>',
        '</section>',
      ].join(''),
      isReady: false,
    };
  }

  if (f.kind === 'not-found') {
    return {
      html: [
        '<section class="profile-section profile-section--not-found" role="status">',
        '<h2>No manifest registered</h2>',
        `<p>${esc(f.message)}</p>`,
        '<p>The shell cannot render a profile editor without a registered manifest. The platform exposes <code>POST /api/v1/admin/profile-bindings</code> for new bindings — until that ships, use the in-process catalog fixture for headless tests.</p>',
        '</section>',
      ].join(''),
      isReady: false,
    };
  }

  // kind === 'error'
  return {
    html: [
      '<section class="profile-section profile-section--error" role="alert">',
      '<h2>Could not load profile schema</h2>',
      `<p>${esc(f.message)}</p>`,
      '</section>',
    ].join(''),
    isReady: false,
  };
}

// ---------------------------------------------------------------------------
// Standalone helpers re-exported for tests
// ---------------------------------------------------------------------------

/** Count of fields rendered with the `unknownFallback` flag set. */
export function countUnknownFallbacks(model: ProfileFormModel): number {
  let n = 0;
  for (const s of model.sections) {
    for (const f of s.fields) {
      if (f.unknownFallback === true) n += 1;
    }
  }
  return n;
}

/** Public so tests can assert the renderer's discriminator mapping. */
export function isOkResult(f: ProfileFetchResult): f is ProfileFetchResult & { kind: 'ok' } {
  return f.kind === 'ok';
}

/** Re-export for the sectionExtras dispatch path. */
export type { FieldWidget };
