import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SETTINGS_PROMPT_SLOTS,
  SettingsPromptDefaultsSchema,
  SettingsUpdateParamsSchema,
} from '../src/settings';

// The approved legacy mapping is the authority, not the endpoint inventory.
const reworkRoot = resolve(__dirname, '../../../..');
const spec = readFileSync(resolve(reworkRoot, 'tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md'), 'utf8');
const catalog = readFileSync(resolve(reworkRoot, 'orchestrator/apps/admin-web/src/features/settings/catalog.ts'), 'utf8');
const mappingSection = spec.split('## 3. Mapping toàn bộ 17 legacy settings')[1]?.split('\n## ')[0] ?? '';
const mappings = [...mappingSection.matchAll(/\|\s*`(ai_[a-z]+_prompt)`\s*\|\s*`promptDefaults\.([a-z]+)`/g)]
  .map((match) => ({ legacyKey: match[1] ?? '', slot: match[2] ?? '' }));
const expectedSlots = mappings.map((mapping) => mapping.slot);
const specDefaults = Object.fromEntries(expectedSlots.map((slot) => [slot, `fixture-${slot}`]));

describe('FIX-PROMPT-SLOTS-811: prompt contract follows the approved spec', () => {
  test('reads exactly five unique legacy prompt mappings from the spec', () => {
    expect(mappings).toHaveLength(5);
    expect(new Set(expectedSlots).size).toBe(5);
    for (const mapping of mappings) expect(mapping.legacyKey).toBe(`ai_${mapping.slot}_prompt`);
  });

  test('tuple names and order match the spec, rather than service names', () => {
    expect([...SETTINGS_PROMPT_SLOTS]).toEqual(expectedSlots);
  });

  test('read schema has exactly the spec keys and preserves each slot value', () => {
    expect(Object.keys(SettingsPromptDefaultsSchema.shape)).toEqual(expectedSlots);
    expect(SettingsPromptDefaultsSchema.parse(specDefaults)).toEqual(specDefaults);
    for (const missingSlot of expectedSlots) {
      const incomplete = { ...specDefaults };
      delete incomplete[missingSlot];
      expect(SettingsPromptDefaultsSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  test('partial writes accept every spec slot and reject service-name substitutions', () => {
    for (const slot of expectedSlots) {
      const body = { promptDefaults: { [slot]: `fixture-${slot}` } };
      expect(SettingsUpdateParamsSchema.parse(body)).toEqual(body);
    }
    for (const obsoleteSlot of ['extract', 'analyze', 'transform']) {
      expect(SettingsUpdateParamsSchema.safeParse({ promptDefaults: { [obsoleteSlot]: 'wrong-slot' } }).success).toBe(false);
    }
  });

  test('the unchanged UI catalog maps the same legacy keys to the spec slots', () => {
    const uiMappings = [...catalog.matchAll(/legacyKey:\s*'(ai_[a-z]+_prompt)'[^\n]*replacement:\s*'promptDefaults\.([a-z]+)'/g)]
      .map((match) => ({ legacyKey: match[1] ?? '', slot: match[2] ?? '' }));
    expect(uiMappings).toEqual(mappings);
  });
});
