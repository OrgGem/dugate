/**
 * Unit tests for P6-03 pure Profile Editor View Models.
 *
 * Validates:
 * - buildProfileFormModel: deterministic sections, fields, revision labels, options resolution.
 * - mapSchemaToWidget: known widgets, schema descriptors (type, format, enum), unknown fallback with reason.
 * - validateProfileDraft: required, numbers, booleans, select options, capability mismatch, locked, staleness.
 * - diffProfileRevision: safe diffing across revisions and drafts, strict secret masking (never echoes raw values).
 * - checkProfileRevision & displayValue: revision staleness checks and UI masking.
 *
 * Pure offline tests: Zero database activity, zero HTTP calls, strict TypeScript without any.
 */

import {
  buildProfileFormField,
  buildProfileFormModel,
  checkProfileRevision,
  coerceWidget,
  diffProfileDraft,
  diffProfileRevision,
  displayValue,
  KNOWN_WIDGETS,
  mapSchemaToWidget,
  validateProfileDraft,
  type DraftActionSpec,
  type DraftCapabilityOption,
  type DraftValidationInput,
  type FieldWidget,
  type ProfileDraft,
  type ProfileSchemaInput,
  type SchemaWidgetDescriptor,
} from '../src/app/admin/profile-view-models';

describe('P6-03: mapSchemaToWidget & coerceWidget', () => {
  test('maps all known string widgets directly', () => {
    const knownList: FieldWidget[] = [
      'text',
      'textarea',
      'number',
      'boolean',
      'select',
      'secret',
      'readonly-hint',
    ];

    for (const w of knownList) {
      expect(KNOWN_WIDGETS.has(w)).toBe(true);
      const res = mapSchemaToWidget(w);
      expect(res.widget).toBe(w);
      expect(res.unknown).toBe(false);
      expect(res.fallbackReason).toBeUndefined();
    }
  });

  test('falls back to "text" with unknown flag for unrecognized string widget names', () => {
    const unknownWidgets = ['color-picker', 'slider', 'date-time', 'markdown-editor', 'random_widget'];
    for (const raw of unknownWidgets) {
      const res = mapSchemaToWidget(raw);
      expect(res.widget).toBe('text');
      expect(res.unknown).toBe(true);
      expect(res.fallbackReason).toBe(`Unknown widget "${raw}" fallen back to "text"`);

      // coerceWidget parity
      const coerced = coerceWidget(raw);
      expect(coerced.widget).toBe('text');
      expect(coerced.unknown).toBe(true);
    }
  });

  test('handles undefined input gracefully', () => {
    const res = mapSchemaToWidget(undefined);
    expect(res.widget).toBe('text');
    expect(res.unknown).toBe(false);

    const coerced = coerceWidget(undefined);
    expect(coerced.widget).toBe('text');
    expect(coerced.unknown).toBe(false);
  });

  test('resolves schema descriptors with explicit widget', () => {
    const desc: SchemaWidgetDescriptor = { widget: 'textarea', description: 'Large input' };
    const res = mapSchemaToWidget(desc);
    expect(res.widget).toBe('textarea');
    expect(res.unknown).toBe(false);

    const unknownDesc: SchemaWidgetDescriptor = { widget: 'vector-input' };
    const unknownRes = mapSchemaToWidget(unknownDesc);
    expect(unknownRes.widget).toBe('text');
    expect(unknownRes.unknown).toBe(true);
    expect(unknownRes.fallbackReason).toContain('vector-input');
  });

  test('resolves schema descriptors based on standard JSON Schema keywords', () => {
    // enum -> select
    expect(mapSchemaToWidget({ enum: ['a', 'b', 'c'] })).toEqual({
      widget: 'select',
      unknown: false,
    });

    // number / integer -> number
    expect(mapSchemaToWidget({ type: 'number' })).toEqual({
      widget: 'number',
      unknown: false,
    });
    expect(mapSchemaToWidget({ type: 'integer' })).toEqual({
      widget: 'number',
      unknown: false,
    });

    // boolean -> boolean
    expect(mapSchemaToWidget({ type: 'boolean' })).toEqual({
      widget: 'boolean',
      unknown: false,
    });

    // format: password / secret -> secret
    expect(mapSchemaToWidget({ type: 'string', format: 'password' })).toEqual({
      widget: 'secret',
      unknown: false,
    });
    expect(mapSchemaToWidget({ format: 'secret' })).toEqual({
      widget: 'secret',
      unknown: false,
    });

    // format: textarea / multiline -> textarea
    expect(mapSchemaToWidget({ type: 'string', format: 'textarea' })).toEqual({
      widget: 'textarea',
      unknown: false,
    });
    expect(mapSchemaToWidget({ type: 'string', format: 'multiline' })).toEqual({
      widget: 'textarea',
      unknown: false,
    });

    // type: string -> text
    expect(mapSchemaToWidget({ type: 'string' })).toEqual({
      widget: 'text',
      unknown: false,
    });

    // unrecognized object shape -> fallback
    expect(mapSchemaToWidget({ type: 'custom_unrecognized_type' })).toEqual({
      widget: 'text',
      unknown: true,
      fallbackReason: 'Unrecognized schema definition fallen back to "text"',
    });
  });
});

describe('P6-03: buildProfileFormField & buildProfileFormModel', () => {
  const capabilityOptions = [
    { connectorId: 'conn-openai', capability: 'reasoning_fast', label: 'OpenAI GPT-4o-mini' },
    { connectorId: 'conn-anthropic', capability: 'reasoning_deep', label: 'Anthropic Claude 3.5 Sonnet' },
  ];

  test('builds single field with correct mapping and options', () => {
    // Select field inheriting capability options
    const selectSlot = { name: 'reasoning_fast', widget: 'select', required: true, description: 'Fast slot' };
    const field = buildProfileFormField(selectSlot, capabilityOptions);
    expect(field.slotName).toBe('reasoning_fast');
    expect(field.label).toBe('reasoning_fast');
    expect(field.widget).toBe('select');
    expect(field.required).toBe(true);
    expect(field.helpText).toBe('Fast slot');
    expect(field.options).toEqual([
      { value: 'conn-openai:reasoning_fast', label: 'OpenAI GPT-4o-mini' },
      { value: 'conn-anthropic:reasoning_deep', label: 'Anthropic Claude 3.5 Sonnet' },
    ]);
    expect(field.unknownFallback).toBeUndefined();

    // Field with explicit options preserves explicit options
    const explicitSlot = {
      name: 'model_tier',
      widget: 'select',
      options: [{ value: 'tier1', label: 'Tier 1' }, { value: 'tier2', label: 'Tier 2' }],
    };
    const explicitField = buildProfileFormField(explicitSlot, capabilityOptions);
    expect(explicitField.options).toEqual([
      { value: 'tier1', label: 'Tier 1' },
      { value: 'tier2', label: 'Tier 2' },
    ]);

    // Unknown widget receives fallback flag
    const unknownSlot = { name: 'custom_slider', widget: 'slider' };
    const unknownField = buildProfileFormField(unknownSlot, capabilityOptions);
    expect(unknownField.widget).toBe('text');
    expect(unknownField.unknownFallback).toBe(true);
  });

  test('builds full profile form model preserving manifest ordering and revision label', () => {
    const input: ProfileSchemaInput = {
      businessId: 'doc-review',
      businessVersion: '1.2.0',
      manifest: {
        actions: [
          {
            name: 'extract',
            title: 'Extract Action',
            slots: [
              { name: 'ocr_engine', widget: 'select', required: true },
              { name: 'temperature', widget: 'number', required: false },
            ],
          },
          {
            name: 'analyze',
            title: 'Analyze Action',
            slots: [
              { name: 'reasoning_slot', widget: 'select', required: true },
              { name: 'api_token', widget: 'secret', required: true },
            ],
          },
        ],
      },
      capabilityOptions,
      existingProfile: { name: 'finance-prod', revision: 4 },
    };

    const model = buildProfileFormModel(input);
    expect(model.businessId).toBe('doc-review');
    expect(model.businessVersion).toBe('1.2.0');
    expect(model.profileName).toBe('finance-prod');
    expect(model.revisionLabel).toBe('rev 4');
    expect(model.sections).toHaveLength(2);

    expect(model.sections[0]!.actionName).toBe('extract');
    expect(model.sections[0]!.fields).toHaveLength(2);
    expect(model.sections[0]!.fields[0]!.slotName).toBe('ocr_engine');
    expect(model.sections[0]!.fields[1]!.slotName).toBe('temperature');

    expect(model.sections[1]!.actionName).toBe('analyze');
    expect(model.sections[1]!.fields).toHaveLength(2);
    expect(model.sections[1]!.fields[0]!.slotName).toBe('reasoning_slot');
    expect(model.sections[1]!.fields[1]!.slotName).toBe('api_token');
    expect(model.sections[1]!.fields[1]!.widget).toBe('secret');
  });

  test('builds model with defaults when existingProfile is null', () => {
    const input: ProfileSchemaInput = {
      businessId: 'example-review',
      businessVersion: '2.0.0',
      manifest: { actions: [{ name: 'review', slots: [] }] },
      capabilityOptions: [],
      existingProfile: null,
    };

    const model = buildProfileFormModel(input);
    expect(model.profileName).toBe('');
    expect(model.revisionLabel).toBe('rev 0');
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]!.fields).toEqual([]);
  });
});

describe('P6-03: checkProfileRevision & displayValue', () => {
  test('checkProfileRevision correctly detects current, stale, and no-profile', () => {
    // Current revision
    expect(checkProfileRevision(3, { revision: 3 })).toEqual({ kind: 'current' });

    // Stale revision
    expect(checkProfileRevision(2, { revision: 5 })).toEqual({
      kind: 'stale',
      formRevision: 2,
      serverRevision: 5,
    });

    // No profile exists on server
    expect(checkProfileRevision(0, null)).toEqual({ kind: 'no-profile' });
    expect(checkProfileRevision(1, null)).toEqual({
      kind: 'stale',
      formRevision: 1,
      serverRevision: 0,
    });
  });

  test('displayValue redacts secret values without exposing characters', () => {
    expect(displayValue('secret', 'sk-super-secret-key')).toBe('••••••••');
    expect(displayValue('secret', '')).toBe('');
    expect(displayValue('text', 'plain-text-value')).toBe('plain-text-value');
    expect(displayValue('number', '42')).toBe('42');
  });
});

describe('P6-03: validateProfileDraft (pure validation)', () => {
  const actions: DraftActionSpec[] = [
    {
      actionName: 'ingest',
      slots: [
        { name: 'chunk_size', widget: 'number', required: true },
        { name: 'enable_ocr', widget: 'boolean', required: true },
        {
          name: 'preset',
          widget: 'select',
          required: false,
          options: [{ value: 'fast', label: 'Fast' }, { value: 'deep', label: 'Deep' }],
        },
        { name: 'reasoning_slot', widget: 'select', required: true }, // capability-backed
        { name: 'locked_tenant_tag', widget: 'text', locked: true, lockedValue: 'tenant-acme' },
        { name: 'future_widget_slot', widget: 'unknown_gauge', required: false },
      ],
    },
  ];

  const capabilityOptions: DraftCapabilityOption[] = [
    { connectorId: 'conn-1', capability: 'reasoning_fast' },
    { connectorId: 'conn-2', capability: 'reasoning_deep' },
  ];

  test('valid draft passes with zero issues', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: '1024' },
        { slotName: 'enable_ocr', value: 'true' },
        { slotName: 'preset', value: 'fast' },
        { slotName: 'reasoning_slot', value: 'conn-1:reasoning_fast' },
        { slotName: 'locked_tenant_tag', value: 'tenant-acme' },
      ],
    };

    const input: DraftValidationInput = {
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    };

    const result = validateProfileDraft(input);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('detects required-missing for empty required slots', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: '' }, // empty required
        { slotName: 'locked_tenant_tag', value: 'tenant-acme' },
      ],
    };

    const result = validateProfileDraft({
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    });

    expect(result.ok).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('required-missing');
  });

  test('detects invalid numeric and boolean values', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: 'not-a-number' },
        { slotName: 'enable_ocr', value: 'maybe' },
        { slotName: 'locked_tenant_tag', value: 'tenant-acme' },
      ],
    };

    const result = validateProfileDraft({
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    });

    expect(result.ok).toBe(false);
    const invalidIssues = result.issues.filter((i) => i.code === 'widget-invalid-value');
    expect(invalidIssues).toHaveLength(2);
    expect(invalidIssues[0]!.slotName).toBe('chunk_size');
    expect(invalidIssues[1]!.slotName).toBe('enable_ocr');
  });

  test('detects select option violation when value not in explicit options', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: '512' },
        { slotName: 'enable_ocr', value: 'false' },
        { slotName: 'preset', value: 'invalid-preset-choice' },
        { slotName: 'locked_tenant_tag', value: 'tenant-acme' },
      ],
    };

    const result = validateProfileDraft({
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    });

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.slotName === 'preset');
    expect(issue?.code).toBe('widget-invalid-value');
  });

  test('detects capability-mismatch when connector capability is not available', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: '512' },
        { slotName: 'enable_ocr', value: 'true' },
        { slotName: 'reasoning_slot', value: 'conn-missing:reasoning_none' },
        { slotName: 'locked_tenant_tag', value: 'tenant-acme' },
      ],
    };

    const result = validateProfileDraft({
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    });

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.slotName === 'reasoning_slot');
    expect(issue?.code).toBe('capability-mismatch');
  });

  test('detects locked-unchanged-violation when locked slot is modified', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: '512' },
        { slotName: 'enable_ocr', value: 'true' },
        { slotName: 'reasoning_slot', value: 'conn-1:reasoning_fast' },
        { slotName: 'locked_tenant_tag', value: 'tenant-tampered' },
      ],
    };

    const result = validateProfileDraft({
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    });

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.slotName === 'locked_tenant_tag');
    expect(issue?.code).toBe('locked-unchanged-violation');
  });

  test('detects stale-revision and no-profile-target', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 2,
      entries: [],
    };

    // Stale: form is rev 2, server is rev 3
    const staleResult = validateProfileDraft({
      draft,
      actions: [],
      capabilityOptions: [],
      serverProfile: { revision: 3 },
    });
    expect(staleResult.ok).toBe(false);
    expect(staleResult.issues[0]!.code).toBe('stale-revision');

    // No profile on server
    const noProfileResult = validateProfileDraft({
      draft,
      actions: [],
      capabilityOptions: [],
      serverProfile: null,
    });
    expect(noProfileResult.ok).toBe(false);
    expect(noProfileResult.issues[0]!.code).toBe('no-profile-target');
  });

  test('flags unknown widget with non-blocking fallback issue', () => {
    const draft: ProfileDraft = {
      businessId: 'doc-core',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'chunk_size', value: '1024' },
        { slotName: 'enable_ocr', value: 'true' },
        { slotName: 'reasoning_slot', value: 'conn-1:reasoning_fast' },
        { slotName: 'locked_tenant_tag', value: 'tenant-acme' },
        { slotName: 'future_widget_slot', value: 'some-value' },
      ],
    };

    const result = validateProfileDraft({
      draft,
      actions,
      capabilityOptions,
      serverProfile: { revision: 1 },
    });

    // Unknown fallback is flagged but non-blocking
    const issue = result.issues.find((i) => i.slotName === 'future_widget_slot');
    expect(issue?.code).toBe('widget-unknown-fallback');
  });
});

describe('P6-03: diffProfileRevision & diffProfileDraft', () => {
  const actions: DraftActionSpec[] = [
    {
      actionName: 'review',
      slots: [
        { name: 'model', widget: 'text' },
        { name: 'temperature', widget: 'number' },
        { name: 'api_key', widget: 'secret' },
        { name: 'optional_notes', widget: 'text' },
      ],
    },
  ];

  test('reports identical when draft matches server values', () => {
    const draft: ProfileDraft = {
      businessId: 'review-biz',
      businessVersion: '1.0.0',
      profileName: 'prod',
      formRevision: 1,
      entries: [
        { slotName: 'model', value: 'gpt-4o' },
        { slotName: 'temperature', value: '0.7' },
        { slotName: 'api_key', value: '' }, // empty secret draft means "keep existing"
        { slotName: 'optional_notes', value: 'standard' },
      ],
    };

    const serverValues = {
      model: 'gpt-4o',
      temperature: '0.7',
      api_key: 'encrypted-token-handle',
      optional_notes: 'standard',
    };

    const diff = diffProfileRevision(draft, actions, serverValues);
    expect(diff.identical).toBe(true);
    expect(diff.entries.every((e) => e.kind === 'unchanged')).toBe(true);

    // diffProfileDraft alias parity
    const aliasDiff = diffProfileDraft(draft, actions, serverValues);
    expect(aliasDiff.identical).toBe(true);
  });

  test('reports plain changes with from and to values', () => {
    const draft: ProfileDraft = {
      businessId: 'review-biz',
      businessVersion: '1.0.0',
      profileName: 'prod',
      formRevision: 1,
      entries: [
        { slotName: 'model', value: 'claude-3-5-sonnet' },
        { slotName: 'temperature', value: '0.7' },
      ],
    };

    const serverValues = {
      model: 'gpt-4o',
      temperature: '0.7',
    };

    const diff = diffProfileRevision(draft, actions, serverValues);
    expect(diff.identical).toBe(false);

    const modelDiff = diff.entries.find((e) => e.slotName === 'model');
    expect(modelDiff).toEqual({
      kind: 'changed',
      slotName: 'model',
      from: 'gpt-4o',
      to: 'claude-3-5-sonnet',
    });
  });

  test('reports secret change as changed-secret without echoing values', () => {
    const draft: ProfileDraft = {
      businessId: 'review-biz',
      businessVersion: '1.0.0',
      profileName: 'prod',
      formRevision: 1,
      entries: [
        { slotName: 'api_key', value: 'sk-new-super-secret-key-12345' },
      ],
    };

    const serverValues = {
      api_key: 'old-secret-handle-99999',
    };

    const diff = diffProfileRevision(draft, actions, serverValues);
    expect(diff.identical).toBe(false);

    const secretDiff = diff.entries.find((e) => e.slotName === 'api_key');
    expect(secretDiff).toEqual({
      kind: 'changed-secret',
      slotName: 'api_key',
    });

    // Verify secret values are not leaked into the serialized report
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain('sk-new-super-secret-key-12345');
    expect(serialized).not.toContain('old-secret-handle-99999');
  });

  test('reports added and removed slots', () => {
    const draft: ProfileDraft = {
      businessId: 'review-biz',
      businessVersion: '1.0.0',
      profileName: 'prod',
      formRevision: 1,
      entries: [
        { slotName: 'model', value: 'gpt-4o' },
        { slotName: 'new_slot_in_draft', value: 'new-value' },
      ],
    };

    const serverValues = {
      model: 'gpt-4o',
      deleted_slot_on_server: 'old-value',
    };

    // Include new_slot_in_draft and deleted_slot_on_server in action spec
    const extendedActions: DraftActionSpec[] = [
      {
        actionName: 'review',
        slots: [
          { name: 'model', widget: 'text' },
          { name: 'new_slot_in_draft', widget: 'text' },
          { name: 'deleted_slot_on_server', widget: 'text' },
        ],
      },
    ];

    const diff = diffProfileRevision(draft, extendedActions, serverValues);
    expect(diff.identical).toBe(false);

    const added = diff.entries.find((e) => e.slotName === 'new_slot_in_draft');
    expect(added).toEqual({ kind: 'added', slotName: 'new_slot_in_draft' });

    const removed = diff.entries.find((e) => e.slotName === 'deleted_slot_on_server');
    expect(removed).toEqual({ kind: 'removed', slotName: 'deleted_slot_on_server' });
  });

  test('diffProfileRevision directly compares two key-value record snapshots', () => {
    const baseRevision = {
      model: 'gpt-4o',
      timeout: '30s',
      api_key: 'old-secret',
      deprecated_feature: 'true',
    };

    const targetRevision = {
      model: 'claude-3-5-sonnet',
      timeout: '30s',
      api_key: 'new-secret',
      new_feature: 'enabled',
    };

    const diff = diffProfileRevision(baseRevision, targetRevision, {
      businessId: 'example-review',
      businessVersion: '1.0.0',
      profileName: 'prod',
      secretSlots: ['api_key'],
    });

    expect(diff.identical).toBe(false);
    expect(diff.businessId).toBe('example-review');
    expect(diff.profileName).toBe('prod');

    // model changed
    expect(diff.entries.find((e) => e.slotName === 'model')).toEqual({
      kind: 'changed',
      slotName: 'model',
      from: 'gpt-4o',
      to: 'claude-3-5-sonnet',
    });

    // timeout unchanged
    expect(diff.entries.find((e) => e.slotName === 'timeout')).toEqual({
      kind: 'unchanged',
      slotName: 'timeout',
    });

    // api_key changed-secret (masked)
    expect(diff.entries.find((e) => e.slotName === 'api_key')).toEqual({
      kind: 'changed-secret',
      slotName: 'api_key',
    });

    // new_feature added
    expect(diff.entries.find((e) => e.slotName === 'new_feature')).toEqual({
      kind: 'added',
      slotName: 'new_feature',
    });

    // deprecated_feature removed
    expect(diff.entries.find((e) => e.slotName === 'deprecated_feature')).toEqual({
      kind: 'removed',
      slotName: 'deprecated_feature',
    });
  });
});
