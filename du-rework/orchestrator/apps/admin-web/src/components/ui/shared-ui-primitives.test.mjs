import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import React from 'react';
import { after, before, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let Button;
let FormField;
let Input;
let NativeSelect;
let TableHead;
let TablePagination;
let TabsRoot;
let TabsList;
let TabsTab;

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
  const inputModule = await vite.ssrLoadModule('/src/components/ui/input.tsx');
  const selectModule = await vite.ssrLoadModule('/src/components/ui/select.tsx');
  const tableModule = await vite.ssrLoadModule('/src/components/ui/table.tsx');
  const tabsModule = await vite.ssrLoadModule('/src/components/ui/tabs.tsx');
  Button = buttonModule.Button;
  FormField = fieldModule.FormField;
  Input = inputModule.Input;
  NativeSelect = selectModule.NativeSelect;
  TableHead = tableModule.TableHead;
  TablePagination = tableModule.TablePagination;
  TabsRoot = tabsModule.TabsRoot;
  TabsList = tabsModule.TabsList;
  TabsTab = tabsModule.TabsTab;
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

test('Button exposes its responsive size while caller height utilities remain intact', () => {
  const defaultHtml = renderToStaticMarkup(
    React.createElement(Button, { size: 'sm' }, 'Next page')
  );
  const customHtml = renderToStaticMarkup(
    React.createElement(Button, { size: 'sm', className: 'h-7' }, 'Compact action')
  );
  const linkHtml = renderToStaticMarkup(
    React.createElement(Button, { variant: 'link', className: 'h-auto' }, 'Read more')
  );

  assert.match(defaultHtml, /data-ui-button-size="sm"/);
  assert.match(customHtml, /class="[^\"]*h-7[^\"]*"/);
  assert.doesNotMatch(customHtml, /sm:h-/);
  assert.doesNotMatch(linkHtml, /data-ui-button-size=/);
  assert.match(linkHtml, /class="[^\"]*h-auto[^\"]*"/);
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

test('Table headers and tab strips retain readable labels when their containers scroll', () => {
  const tableHeadHtml = renderToStaticMarkup(
    React.createElement(TableHead, null, 'Default version for new submissions')
  );
  const tabsHtml = renderToStaticMarkup(
    React.createElement(
      TabsRoot,
      { defaultValue: 'catalog' },
      React.createElement(
        TabsList,
        { 'aria-label': 'Connector sections' },
        React.createElement(TabsTab, { value: 'catalog' }, 'Catalog'),
        React.createElement(TabsTab, { value: 'revisions' }, 'Revision inspector'),
        React.createElement(TabsTab, { value: 'recipe' }, 'Recipe')
      )
    )
  );
  const tabs = [...tabsHtml.matchAll(/<button\b([^>]*)>/g)].map(([, attributes]) => attributes);

  assert.match(tableHeadHtml, /class="[^\"]*whitespace-nowrap[^\"]*"/);
  assert.match(tabsHtml, /class="[^\"]*admin-tabs-scroll[^\"]*"/);
  assert.equal(tabs.length, 3);
  assert.ok(tabs.every((attributes) => /class="[^\"]*shrink-0[^\"]*"/.test(attributes)));
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

test('FormField gives multi-control fields group semantics and describes every control', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      FormField,
      {
        label: 'API key scope',
        description: 'Search, then choose a key.',
        error: 'Choose an API key or Any key.',
        required: true,
      },
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Input, {
          'aria-label': 'Search API keys',
          'aria-describedby': 'search-help',
          key: 'search',
        }),
        React.createElement(
          NativeSelect,
          { 'aria-label': 'Budget API key scope', key: 'scope' },
          React.createElement('option', { value: '' }, 'Any key')
        )
      )
    )
  );
  const controls = [...html.matchAll(/<(?:input|select)\b([^>]*)>/g)].map(([, attributes]) => attributes);

  assert.equal(controls.length, 2);
  assert.match(html, /<fieldset\b/);
  assert.match(html, /<legend\b[^>]*>API key scope/);
  assert.doesNotMatch(html, /<label\b/);
  assert.match(controls[0], /aria-label="Search API keys"/);
  assert.match(controls[0], /aria-describedby="search-help [^\"]+-desc [^\"]+-err"/);
  assert.match(controls[1], /aria-label="Budget API key scope"/);
  for (const attributes of controls) {
    assert.match(attributes, /aria-invalid="true"/);
    assert.match(attributes, /aria-errormessage="[^\"]+-err"/);
    assert.doesNotMatch(attributes, /aria-required=/);
  }
  assert.equal(controls.filter((attributes) => /\sid="[^\"]+"/.test(attributes)).length, 1);
});

test('FormField honors an explicit primary control id in a group and can reserve an error line', () => {
  const groupedHtml = renderToStaticMarkup(
    React.createElement(
      FormField,
      { label: 'API key scope', primaryControlId: 'scope-control' },
      React.createElement(Input, { id: 'search-control', 'aria-label': 'Search API keys', key: 'search' }),
      React.createElement(NativeSelect, { id: 'scope-control', 'aria-label': 'Budget API key scope', key: 'scope' },
        React.createElement('option', { value: '' }, 'Any key'))
    )
  );
  const reservedHtml = renderToStaticMarkup(
    React.createElement(
      FormField,
      { id: 'profile-name', label: 'Profile name', reserveErrorSpace: true },
      React.createElement(Input, { id: 'profile-name' })
    )
  );

  assert.match(groupedHtml, /<label[^>]*for="scope-control"/);
  assert.match(groupedHtml, /<input\b[^>]*id="search-control"/);
  assert.match(groupedHtml, /<select\b[^>]*id="scope-control"/);
  assert.match(reservedHtml, /<p aria-hidden="true" class="[^\"]*min-h-4[^\"]*"> <\/p>/);
});

test('FormField keeps individual ids in a group and does not label its first control implicitly', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      FormField,
      { label: 'API key scope', description: 'Search and choose a key.', error: 'A key is required.' },
      React.createElement(Input, { id: 'search-control', 'aria-label': 'Search API keys', key: 'search' }),
      React.createElement(NativeSelect, { id: 'scope-control', 'aria-label': 'Budget API key scope', key: 'scope' },
        React.createElement('option', { value: '' }, 'Any key'))
    )
  );
  const controls = [...html.matchAll(/<(?:input|select)\b([^>]*)>/g)].map(([, attributes]) => attributes);

  assert.match(html, /<fieldset\b/);
  assert.match(html, /<legend\b[^>]*>API key scope/);
  assert.doesNotMatch(html, /<label\b/);
  assert.match(controls[0], /id="search-control"/);
  assert.match(controls[1], /id="scope-control"/);
  assert.ok(controls.every((attributes) => /aria-describedby="[^\"]+-desc [^\"]+-err"/.test(attributes)));
});

test('FormField traverses intrinsic wrappers without losing their props or nested control labeling', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      FormField,
      { id: 'profile-search-fallback', label: 'Business', description: 'Search by name or ID.' },
      React.createElement(
        'div',
        { id: 'business-search-wrapper', className: 'flex gap-2', 'data-layout': 'search-row' },
        React.createElement(Input, { id: 'profile-group-business-search', placeholder: 'Search businesses' })
      )
    )
  );
  const input = html.match(/<input\b[^>]*>/)?.[0];

  assert.match(html, /<label[^>]*for="profile-group-business-search"/);
  assert.match(html, /<div id="business-search-wrapper" class="flex gap-2" data-layout="search-row">/);
  assert.ok(input);
  assert.match(input, /id="profile-group-business-search"/);
  assert.match(input, /aria-describedby="profile-group-business-search-desc"/);
});

test('FormField keeps nested multi-control groups unambiguous and preserves required child semantics', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      FormField,
      {
        id: 'vault-version',
        label: 'Pinned version',
        description: 'Choose the mode, then optionally search a version number.',
        error: 'The pinned version is unavailable.',
        required: true,
      },
      React.createElement(
        'div',
        { id: 'vault-version-controls', className: 'grid gap-2', 'data-control-group': 'version' },
        React.createElement(NativeSelect, {
          id: 'vault-version-mode',
          required: true,
          'aria-required': true,
          key: 'mode',
        }, React.createElement('option', { value: 'pinned' }, 'Pinned')),
        React.createElement(Input, {
          id: 'vault-version-number',
          'aria-required': false,
          key: 'number',
        })
      )
    )
  );
  const controls = [...html.matchAll(/<(?:input|select)\b([^>]*)>/g)].map(([, attributes]) => attributes);

  assert.match(html, /<fieldset\b/);
  assert.match(html, /<legend[^>]*>Pinned version<span[^>]*>\*<\/span><span class="sr-only"> \(required\)<\/span><\/legend>/);
  assert.doesNotMatch(html, /<label\b/);
  assert.match(html, /<div id="vault-version-controls" class="grid gap-2" data-control-group="version">/);
  assert.equal(controls.length, 2);
  assert.match(controls[0], /id="vault-version-mode"/);
  assert.match(controls[0], /required(?:="")?(?=[\s>])/);
  assert.match(controls[0], /aria-required="true"/);
  assert.match(controls[1], /id="vault-version-number"/);
  assert.match(controls[1], /aria-required="false"/);
  assert.ok(controls.every((attributes) => /aria-describedby="vault-version-desc vault-version-err"/.test(attributes)));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(ids.length, new Set(ids).size);
});
