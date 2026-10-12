import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panelPath = resolve(__dirname, '../../../apps/admin-web/src/features/usage/cost-policy-panel.tsx');
const panelSource = readFileSync(panelPath, 'utf8');

describe('ORV14 cost policy revision history scroll regions', () => {
  test.each([
    ['Budget revision history'],
    ['Price revision history'],
  ])('%s is named and keyboard focusable', (accessibleName) => {
    const region = new RegExp(
      `<div className="overflow-x-auto rounded border border-\\[var\\(--border-subtle\\)\\]" role="region" aria-label="${accessibleName}" tabIndex=\\{0\\}>`,
    );
    expect(panelSource).toMatch(region);
  });

  test('both revision tables remain horizontally scrollable', () => {
    expect(panelSource.match(/className="overflow-x-auto rounded border border-\[var\(--border-subtle\)\]" role="region" aria-label="(?:Budget|Price) revision history" tabIndex=\{0\}>/g)).toHaveLength(2);
  });
});
