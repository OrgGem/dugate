#!/usr/bin/env node
/**
 * Harness-only debug helper: reproduce the candidate's OAuth2 token
 * acquisition from inside the container with (a) global fetch and (b) the
 * pinned egress fetch, printing raw error classes. No secrets are printed
 * (token length only).
 *
 * Usage: node /live-gates/inside/oauth-probe.cjs <tokenUrl> <clientId> <clientSecret>
 */
'use strict';

const { createRequire } = require('node:module');

// Resolve the app's dependencies from the image, not from the read-only mount.
const appRequire = createRequire('/app/dist/modules/webhooks/oauth2-client.js');
const { createPinnedFetch } = appRequire('@du/egress');
const { OAuth2TokenClient } = appRequire('/app/dist/modules/webhooks/oauth2-client.js');

async function main() {
  const [tokenUrl, clientId, clientSecret] = process.argv.slice(2);
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const plain = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  }).then((response) => response.status).catch(
    (error) => `ERR ${error.message} | ${error.cause ? (error.cause.code || error.cause.message) : ''}`,
  );
  console.log(JSON.stringify({ step: 'plain-fetch', result: plain }));

  for (const [step, options] of [
    ['oauth2-client-default-fetch', undefined],
    ['oauth2-client-pinned-fetch', { fetchImpl: createPinnedFetch({ allowPrivateNetworks: true }) }],
  ]) {
    try {
      const client = new OAuth2TokenClient(
        { tokenUrl, clientId, clientSecret, authMethod: 'client_secret_post' },
        { tenantId: 'live-gates-probe' },
        options,
      );
      const token = await client.getToken();
      console.log(JSON.stringify({ step, ok: true, tokenLength: token.length }));
    } catch (error) {
      console.log(JSON.stringify({
        step,
        ok: false,
        name: error.name,
        code: error.code,
        message: error.message,
      }));
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
