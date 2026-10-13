import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import React from 'react';
import { after, before, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let Button;
let FormField;
let TablePagination;

before(async () => {
  vite = await createServer({
    configFile: false,
    root: process.cwd(),
    resolve: { alias: { '@': resolve(process.cwd(), 'src') } },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true },
    appType: 'custom',
  });

  const buttonModule = await vite.ssrLoadModule('/src/components/ui/button.tsx');
  const fieldModule = await vite.ssrLoadModule('/src/components/ui/field.tsx');
  const tableModule = await vite.ssrLoadModule('/src/components/ui/table.tsx');
  Button = buttonModule.Button;
  FormField = fieldModule.FormField;
  TablePagination = tableModule.TablePagination;
});

after(async () => {
  await vite?.close();
});

test('Button keeps child icons and text in one row while preserving loading state', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Button,
      { isLoading: true },
      React.createElement(React.Fragment, null,
        React.createElement('svg', { 'aria-hidden': 'true', key: 'icon' }),
        'Save changes'
      )
    )
  );
  const button = html.match(/<button\b([^>]*)>(.*?)<\/button>/)?.[0];

  assert.ok(button);
  assert.match(button, /\sdisabled(?:="")?(?=[\s>])/);
  assert.match(button, /aria-busy="true"/);
  assert.match(button, /<span class="inline-flex[^\"]*">\s*<svg aria-hidden="true"><\/svg>Save changes<\/span>/);
});

test('TablePagination reflects server page availability and pending state accessibly', () => {
  const html = renderToStaticMarkup(
    React.createElement(TablePagination, {
      hasPreviousPage: false,
      hasNextPage: true,
      onPreviousPage: () => {},
      onNextPage: () => {},
      status: 'Showing 26–50 of filtered results',
    })
  );
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)];

  assert.match(html, /<nav[^>]*aria-label="Table pagination"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0][1], /\sdisabled(?:="")?(?=[\s>])/);
  assert.doesNotMatch(buttons[1][1], /\sdisabled(?:="")?(?=[\s>])/);
  assert.match(buttons[0][2], /Previous page/);
  assert.match(buttons[1][2], /Next page/);

  const pendingHtml = renderToStaticMarkup(
    React.createElement(TablePagination, {
      hasPreviousPage: true,
      hasNextPage: true,
      onPreviousPage: () => {},
      onNextPage: () => {},
      pending: true,
    })
  );
  const pendingButtons = [...pendingHtml.matchAll(/<button\b([^>]*)>/g)];

  assert.match(pendingHtml, /aria-busy="true"/);
  assert.equal(pendingButtons.length, 2);
  assert.ok(pendingButtons.every(([, attributes]) => /\sdisabled(?:="")?(?=[\s>])/.test(attributes)));

  const callbacksMissingHtml = renderToStaticMarkup(
    React.createElement(TablePagination, {
      hasPreviousPage: true,
      hasNextPage: true,
    })
  );
  const callbacksMissingButtons = [...callbacksMissingHtml.matchAll(/<button\b([^>]*)>/g)];
  assert.ok(callbacksMissingButtons.every(([, attributes]) => /\sdisabled(?:="")?(?=[\s>])/.test(attributes)));
});

test('FormField preserves the control id and wires visible help and error messages', () => {
  const html = renderToStaticMarkup(
    React.createElement(FormField, {
      id: 'field-fallback-id',
      label: 'Profile name',
      description: 'Use the customer-facing name.',
      error: 'A profile name is required.',
      children: React.createElement('input', { id: 'existing-control-id' }),
    })
  );
  const input = html.match(/<input\b[^>]*>/)?.[0];

  assert.match(html, /for="existing-control-id"/);
  assert.ok(input);
  assert.match(input, /id="existing-control-id"/);
  assert.match(input, /aria-describedby="existing-control-id-desc existing-control-id-err"/);
  assert.match(input, /aria-invalid="true"/);
  assert.match(input, /aria-errormessage="existing-control-id-err"/);
  assert.match(html, /role="alert"[^>]*>A profile name is required\.<\/p>/);
  assert.ok(html.indexOf('<input') < html.indexOf('Use the customer-facing name.'));
  assert.ok(html.indexOf('Use the customer-facing name.') < html.indexOf('A profile name is required.'));
});

test('FormField preserves the input id in a multi-child datalist composition', () => {
  const html = renderToStaticMarkup(
    React.createElement(FormField, {
      id: 'fallback-field-id',
      label: 'Connector revision',
      children: [
        React.createElement('input', { id: 'revision-input', list: 'revision-options', key: 'input' }),
        React.createElement('datalist', { id: 'revision-options', key: 'datalist' }),
      ],
    })
  );

  assert.match(html, /for="revision-input"/);
  assert.match(html, /<input\b[^>]*id="revision-input"[^>]*list="revision-options"/);
  assert.match(html, /<datalist\b[^>]*id="revision-options"/);
});
