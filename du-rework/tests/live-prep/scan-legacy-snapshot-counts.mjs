#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const COUNT_NAMES = [
  'legacy_config_field_rows',
  'rows_with_nonempty_legacy_credential_fields',
  'missing_new_shape_candidate_rows',
  'nonterminal_legacy_candidates',
];

const SQL = `
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT
  count(*) FILTER (
    WHERE o.profile_policy_snapshot ? 'fileUrlAuthConfig'
  ),
  count(*) FILTER (
    WHERE NULLIF(o.profile_policy_snapshot #>> '{fileUrlAuthConfig,token}', '') IS NOT NULL
       OR NULLIF(o.profile_policy_snapshot #>> '{fileUrlAuthConfig,header_value}', '') IS NOT NULL
       OR NULLIF(o.profile_policy_snapshot #>> '{fileUrlAuthConfig,query_value}', '') IS NOT NULL
  ),
  count(*) FILTER (
    WHERE NOT (o.profile_policy_snapshot ?& ARRAY['fileUrlAuthConfigured', 'credentialRef'])
  ),
  count(*) FILTER (
    WHERE (
      o.profile_policy_snapshot ? 'fileUrlAuthConfig'
      OR NOT (o.profile_policy_snapshot ?& ARRAY['fileUrlAuthConfigured', 'credentialRef'])
    )
      AND o.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      AND EXISTS (
        SELECT 1
        FROM tasks t
        WHERE t.operation_id = o.id
          AND t.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      )
  )
FROM operations o
WHERE o.profile_policy_snapshot IS NOT NULL;
ROLLBACK;
`;

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function parseArguments(argv) {
  let run = false;
  let service;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') {
      run = true;
    } else if (arg === '--service' && index + 1 < argv.length) {
      service = argv[index + 1];
      index += 1;
    } else if (arg === '--help') {
      return { help: true };
    } else {
      return { error: 'Unknown or incomplete argument.' };
    }
  }

  return { run, service };
}

const options = parseArguments(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    'Offline-prepared DD-03 count-only scan. A live run requires --run, --service <approved-pg-service-alias>, DD03_WINDOW_APPROVED=1, DD03_WINDOW_ID, PGSERVICEFILE, and PGPASSFILE. See dd03-count-only-runbook.md.\n',
  );
} else if (options.error) {
  fail(`DD03 scan not run: ${options.error}`, 2);
} else if (!options.run) {
  fail('DD03 scan not run: pass --run only inside an approved live window.', 2);
} else if (!options.service || !/^[A-Za-z0-9_-]{1,50}$/.test(options.service)) {
  fail('DD03 scan not run: provide a valid non-secret PostgreSQL service alias.', 2);
} else if (
  process.env.DD03_WINDOW_APPROVED !== '1'
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(process.env.DD03_WINDOW_ID ?? '')
) {
  fail('DD03 scan not run: approved live-window markers are missing.', 2);
} else if (!process.env.PGSERVICEFILE || !process.env.PGPASSFILE) {
  fail('DD03 scan not run: external PGSERVICEFILE and PGPASSFILE configuration is required.', 2);
} else {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '--dbname',
      options.service,
      '-c',
      SQL,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        PGSERVICEFILE: process.env.PGSERVICEFILE,
        PGPASSFILE: process.env.PGPASSFILE,
        PGCONNECT_TIMEOUT: '5',
      },
      maxBuffer: 2048,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );

  if (result.error || result.status !== 0) {
    fail('DD03 scan failed; client/server output was withheld. Stop and review the runbook.', 3);
  } else {
    const output = typeof result.stdout === 'string' ? result.stdout : '';
    const match = /^(\d+)\|(\d+)\|(\d+)\|(\d+)(?:\r?\n)?$/.exec(output);

    if (!match) {
      fail('DD03 scan failed: non-count output was rejected and withheld.', 4);
    } else {
      for (let index = 0; index < COUNT_NAMES.length; index += 1) {
        process.stdout.write(`${COUNT_NAMES[index]}=${match[index + 1]}\n`);
      }
    }
  }
}
