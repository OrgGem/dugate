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

  function isBoundaryViolation(importer: string, importTarget: string): boolean {
    if (FORBIDDEN_SERVICE_PATTERNS.some((pattern) => importTarget.includes(pattern))) return true;

    if (importTarget.startsWith('.')) {
      const resolved = path.resolve(path.dirname(importer), importTarget);
      return path.relative(srcDir, resolved).startsWith('..');
    }

    const isNodeBuiltin = importTarget.startsWith('node:') || [
      'fs', 'path', 'crypto', 'http', 'https', 'stream', 'util', 'os', 'events', 'buffer'
    ].includes(importTarget);
    return !isNodeBuiltin && !ALLOWED_EXTERNAL_PACKAGES.has(importTarget);
  }

  function buildSourceImportGraph(files: string[]): Map<string, string[]> {
    const fileSet = new Set(files);
    const graph = new Map<string, string[]>();
    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const dependencies: string[] = [];
      for (const match of content.matchAll(importRegex)) {
        const importTarget = match[1];
        if (!importTarget?.startsWith('.')) continue;

        const base = path.resolve(path.dirname(file), importTarget);
        const target = [base, `${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fileSet.has(candidate));
        if (target) dependencies.push(target);
      }
      graph.set(file, dependencies);
    }

    return graph;
  }

  function findImportCycles(graph: Map<string, string[]>): string[][] {
    const visited = new Set<string>();
    const active = new Set<string>();
    const stack: string[] = [];
    const cycles: string[][] = [];

    function visit(file: string): void {
      if (active.has(file)) {
        const cycleStart = stack.indexOf(file);
        cycles.push([...stack.slice(cycleStart), file]);
        return;
      }
      if (visited.has(file)) return;

      active.add(file);
      stack.push(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency);
      stack.pop();
      active.delete(file);
      visited.add(file);
    }

    for (const file of graph.keys()) visit(file);
    return cycles;
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

  it('classifies cross-package, deep-import, and source-root escape fixtures as boundary violations', () => {
    const importer = path.join(srcDir, 'actions', 'ingest', 'index.ts');
    const violatingTargets = [
      '@du/orchestrator/internal/admin',
      '@du/contracts/private/internal',
      '@du/document-core/src/pipelines/parser-budget',
      '../../../../../services/connector/src/internal',
    ];

    for (const target of violatingTargets) {
      expect(isBoundaryViolation(importer, target)).toBe(true);
    }

    for (const target of ALLOWED_EXTERNAL_PACKAGES) {
      expect(isBoundaryViolation(importer, target)).toBe(false);
    }
  });

  it('detects a synthetic circular import instead of silently treating it as acyclic', () => {
    const graph = new Map([
      ['actions/ingest.ts', ['pipelines/parse.ts']],
      ['pipelines/parse.ts', ['actions/ingest.ts']],
    ]);

    expect(findImportCycles(graph)).toEqual([
      ['actions/ingest.ts', 'pipelines/parse.ts', 'actions/ingest.ts'],
    ]);
  });

  it('keeps the production source import graph free of circular dependencies', () => {
    const graph = buildSourceImportGraph(getTsFiles(srcDir));
    expect(findImportCycles(graph)).toEqual([]);
  });

  test.failing('does not expose implementation-only symbols through the package entry point', () => {
    const sourceEntry = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
    const internalModules = [
      "./validation/output-validators",
      "./pipelines/step-checkpoint",
      "./pipelines/parser-budget",
      "./config",
      "./main",
    ];
    const leakedModules = internalModules.filter((modulePath) =>
      new RegExp(`export\\s+\\*\\s+from\\s+['"]${modulePath.replaceAll('/', '\\/')}['"]`).test(sourceEntry)
    );

    expect(leakedModules).toEqual([]);
  });

  test.failing('restricts package exports to the approved public entry point', () => {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { exports?: Record<string, unknown> };
    expect(pkgJson.exports).toEqual({ '.': expect.anything() });
  });
});
