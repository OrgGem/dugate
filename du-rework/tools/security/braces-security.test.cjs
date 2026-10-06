const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const uiRequire = createRequire(path.join(root, 'apps/admin-web/package.json'));
const shadcnRequire = createRequire(uiRequire.resolve('shadcn'));
const globRequire = createRequire(shadcnRequire.resolve('fast-glob'));
const matchRequire = createRequire(globRequire.resolve('micromatch'));
const braces = matchRequire('braces');
const packagePath = matchRequire.resolve('braces/package.json');

test('actual UI transitive package keeps its real upstream version', () => {
  assert.equal(matchRequire('braces/package.json').version, '3.0.3');
  assert.match(packagePath, /patch_hash/);
});

test('backend Jest dependency chain uses the same patched braces package', () => {
  const backendRequire = createRequire(path.join(root, 'services/orchestrator/package.json'));
  const jestRequire = createRequire(backendRequire.resolve('jest'));
  const coreRequire = createRequire(jestRequire.resolve('@jest/core'));
  const backendMatchRequire = createRequire(coreRequire.resolve('micromatch'));
  assert.equal(backendMatchRequire.resolve('braces/package.json'), packagePath);
  assert.throws(() => backendMatchRequire('braces').compile('{'.repeat(4000) + 'a,b' + '}'.repeat(4000)),
    error => error.code === 'ERR_BRACES_DEPTH_LIMIT');
});

test('normal glob, nested alternatives, ranges and escaped braces keep behavior', () => {
  assert.equal(braces.compile('src/{a,b}/**/*.ts'), 'src/(a|b)/**/*.ts');
  assert.deepEqual(braces.expand('{a,{b,c}}'), ['a', 'b', 'c']);
  assert.deepEqual(braces.expand('{1..3}'), ['1', '2', '3']);
  assert.equal(braces.stringify(braces.parse('src/{a,b}.ts')), 'src/{a,b}.ts');
  assert.equal(braces.stringify(braces.parse('\\{literal\\}')), '{literal}');
});

for (const method of ['parse', 'compile', 'expand', 'stringify']) {
  test(`${method} rejects deep balanced and unbalanced braces/parentheses without stack overflow`, () => {
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      for (const suffix of [close.repeat(4000), '']) {
        const input = open.repeat(4000) + 'a' + suffix;
        assert.throws(() => braces[method](input, { maxDepth: Infinity }),
          error => error.code === 'ERR_BRACES_DEPTH_LIMIT' && error instanceof SyntaxError);
      }
    }
    assert.doesNotThrow(() => braces[method]('{'.repeat(128) + 'a' + '}'.repeat(128)));
    assert.throws(() => braces[method]('{'.repeat(129) + 'a' + '}'.repeat(129)),
      error => error.code === 'ERR_BRACES_DEPTH_LIMIT');
  });
}

for (const method of ['compile', 'expand', 'stringify']) {
  test(`${method} also validates externally supplied AST depth, width and cycles`, () => {
    let ast = { type: 'text', value: 'a' };
    for (let i = 0; i < 12000; i++) ast = { type: 'root', nodes: [ast] };
    assert.throws(() => braces[method](ast), error => error.code === 'ERR_BRACES_DEPTH_LIMIT');
    const cyclic = { type: 'root', nodes: [] };
    cyclic.nodes.push(cyclic);
    assert.throws(() => braces[method](cyclic), error => error.code === 'ERR_BRACES_AST_LIMIT');
    assert.throws(() => braces[method]({ type: 'root', nodes: Array(65537).fill({ type: 'text', value: 'a' }) }),
      error => error.code === 'ERR_BRACES_AST_LIMIT');
  });
}
