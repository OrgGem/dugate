import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Document-Core Package & Source Boundary (R08-08)', () => {
  const packageDir = path.resolve(__dirname, '..');
  const srcDir = path.join(packageDir, 'src');
  const pkgJsonPath = path.join(packageDir, 'package.json');

  const ALLOWED_EXTERNAL_PACKAGES = new Set([
    '@du/contracts',
    '@du/worker-sdk',
    '@du/document-kit',
    'zod',
  ]);

  const FORBIDDEN_SERVICE_PATTERNS = [
    '@du/orchestrator',
    '@du/connector',
    '@du/example-review',
    'services/orchestrator',
    'services/connector',
  ];

  function getTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('declares only approved shared public packages in dependencies', () => {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const deps = Object.keys(pkgJson.dependencies || {});
    for (const dep of deps) {
      expect(ALLOWED_EXTERNAL_PACKAGES.has(dep)).toBe(true);
    }
    // Explicitly verify no internal service dependencies
    for (const forbidden of FORBIDDEN_SERVICE_PATTERNS) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it('contains zero source imports of internal services or unapproved packages in src/', () => {
    const tsFiles = getTsFiles(srcDir);
    expect(tsFiles.length).toBeGreaterThan(0);

    const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;

    for (const file of tsFiles) {
      const relativeFile = path.relative(packageDir, file);
      const content = fs.readFileSync(file, 'utf8');

      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        const importTarget = match[1];
        if (!importTarget) continue;

        // 1. Check forbidden service packages
        for (const forbidden of FORBIDDEN_SERVICE_PATTERNS) {
          expect({ file: relativeFile, importTarget }).not.toEqual({
            file: relativeFile,
            importTarget: forbidden,
          });
          expect(importTarget).not.toContain(forbidden);
        }

        // 2. If non-relative, verify it is allowed
        if (!importTarget.startsWith('.')) {
          const isNodeBuiltin = importTarget.startsWith('node:') || [
            'fs', 'path', 'crypto', 'http', 'https', 'stream', 'util', 'os', 'events', 'buffer'
          ].includes(importTarget);

          const isAllowed = isNodeBuiltin || ALLOWED_EXTERNAL_PACKAGES.has(importTarget);
          expect({ file: relativeFile, importTarget, allowed: isAllowed }).toEqual({
            file: relativeFile,
            importTarget,
            allowed: true,
          });
        }

        // 3. If relative, verify it does not escape src/ to services or root
        if (importTarget.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), importTarget);
          const escapesSrc = path.relative(srcDir, resolved).startsWith('..');
          expect({ file: relativeFile, importTarget, escapesSrc }).toEqual({
            file: relativeFile,
            importTarget,
            escapesSrc: false,
          });
        }
      }
    }
  });

  it('contains zero explicit "any" types in production source files (R08-08 strict typing)', () => {
    const tsFiles = getTsFiles(srcDir);
    const anyMatches: Array<{ file: string; line: number; text: string }> = [];

    // Match : any, as any, <any> (excluding comments)
    const anyRegex = /(?::\s*any\b|\bas\s+any\b|<any>)/;

    for (const file of tsFiles) {
      const relativeFile = path.relative(packageDir, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');

      lines.forEach((line, idx) => {
        // Strip single line comments
        const cleanLine = line.replace(/\/\/.*$/, '').trim();
        if (anyRegex.test(cleanLine)) {
          anyMatches.push({
            file: relativeFile,
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    expect(anyMatches).toEqual([]);
  });
});
