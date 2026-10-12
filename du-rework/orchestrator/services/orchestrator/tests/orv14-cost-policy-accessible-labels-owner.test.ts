import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panelPath = resolve(__dirname, '../../../apps/admin-web/src/features/usage/cost-policy-panel.tsx');
const panelSource = readFileSync(panelPath, 'utf8');

describe('ORV14 cost policy native select labels', () => {
  test.each([
    ['Budget API key scope', 'API key scope'],
    ['Budget profile scope', 'Profile scope'],
    ['Budget business scope', 'Business scope'],
  ])('%s remains explicitly named for assistive technology', (accessibleName, fieldLabel) => {
    const field = new RegExp(`<FormField label="${fieldLabel}"[\\s\\S]*?<NativeSelect aria-label="${accessibleName}"`);
    expect(panelSource).toMatch(field);
  });
});
