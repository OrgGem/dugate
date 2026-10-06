#!/usr/bin/env node
/**
 * Harness-only debug helper: from INSIDE the candidate container, print DNS
 * resolution and HTTPS reachability for candidate URLs (used to diagnose the
 * runner's host fixture path). Prints one JSON line per target.
 */
'use strict';

const dns = require('node:dns').promises;

(async () => {
  for (const target of process.argv.slice(2)) {
    const url = new URL(target);
    const out = { target };
    try {
      out.dns = await dns.lookup(url.hostname);
    } catch (error) {
      out.dnsError = error.code || error.message;
    }
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      out.http = response.status;
    } catch (error) {
      out.fetchError = error.message;
      out.cause = error.cause ? (error.cause.code || error.cause.message) : undefined;
    }
    console.log(JSON.stringify(out));
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
