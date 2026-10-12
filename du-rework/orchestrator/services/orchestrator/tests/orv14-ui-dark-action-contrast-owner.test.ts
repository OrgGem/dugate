import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tokenSource = readFileSync(
  resolve(__dirname, '../../../apps/admin-web/src/styles/tokens.css'),
  'utf8',
);

function declaration(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match) throw new Error(`missing --${name} declaration`);
  return match[1]!.toLowerCase();
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function cssBlock(pattern: RegExp): string {
  const match = tokenSource.match(pattern);
  if (!match) throw new Error(`missing CSS block ${pattern}`);
  return match[1]!;
}

describe('dark primary action contrast', () => {
  const light = cssBlock(/:root\s*\{([\s\S]*?)\n\}/);
  const prefersDark = cssBlock(/@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*?:root:not\(\[data-theme='light'\]\)\s*\{([\s\S]*?)\n\s{2}\}/);
  const explicitDark = cssBlock(/:root\[data-theme='dark'\],\s*\.dark\s*\{([\s\S]*?)\n\}/);

  it.each([
    ['prefers-color-scheme dark', prefersDark],
    ['explicit dark theme', explicitDark],
  ])('%s keeps normal and hover action text readable without changing link blue', (_mode, block) => {
    const foreground = declaration(block, 'on-action');
    expect(foreground).toBe('#111827');
    expect(contrastRatio(foreground, declaration(block, 'cf-blue'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(foreground, declaration(block, 'cf-blue-hover'))).toBeGreaterThanOrEqual(4.5);
    expect(declaration(block, 'cf-blue')).toBe('#4c8dff');
  });

  it('preserves the light action palette', () => {
    expect(declaration(light, 'on-action')).toBe('#ffffff');
    expect(contrastRatio('#ffffff', declaration(light, 'cf-blue'))).toBeGreaterThanOrEqual(4.5);
  });
});
