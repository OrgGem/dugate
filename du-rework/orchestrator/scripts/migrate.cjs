#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolveLocalPath } = require('./local-paths.cjs');

const ROOT = path.resolve(__dirname, '..');

function isNewer(source, artifact) {
  if (!fs.existsSync(source)) return false;
  if (!fs.existsSync(artifact)) return true;
  return fs.statSync(source).mtimeMs > fs.statSync(artifact).mtimeMs;
}

function sqlFileNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.sql') && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort();
}

function normalizeSql(content) {
  return content.replace(/\r\n/g, '\n');
}

function migrationSqlIsStale(sourceDir, artifactDir) {
  if (!fs.existsSync(sourceDir)) return false;
  const sourceFiles = sqlFileNames(sourceDir);
  const artifactFiles = sqlFileNames(artifactDir);
  if (sourceFiles.length !== artifactFiles.length
    || sourceFiles.some((name, index) => name !== artifactFiles[index])) {
    return true;
  }

  return sourceFiles.some((name) => {
    try {
      const source = fs.readFileSync(path.join(sourceDir, name), 'utf8');
      const artifact = fs.readFileSync(path.join(artifactDir, name), 'utf8');
      return normalizeSql(source) !== normalizeSql(artifact);
    } catch {
      return true;
    }
  });
}

function migrationCliNeedsBuild(root = ROOT) {
  const services = [
    {
      pairs: [
        ['services/orchestrator/src/db/migrations.ts', 'services/orchestrator/dist/db/migrations.js'],
        ['services/orchestrator/src/db/db.ts', 'services/orchestrator/dist/db/db.js'],
        ['services/orchestrator/src/migrate-cli.ts', 'services/orchestrator/dist/migrate-cli.js'],
        ['services/orchestrator/src/migration-cli-report.ts', 'services/orchestrator/dist/migration-cli-report.js'],
      ],
      sql: null,
    },
    {
      pairs: [
        ['services/connector/src/db/migration-runner.ts', 'services/connector/dist/db/migration-runner.js'],
        ['services/connector/src/db/pg-client.ts', 'services/connector/dist/db/pg-client.js'],
        ['services/connector/src/migrate-cli.ts', 'services/connector/dist/migrate-cli.js'],
        ['services/connector/src/migration-cli-report.ts', 'services/connector/dist/migration-cli-report.js'],
      ],
      sql: ['services/connector/src/db/migrations', 'services/connector/dist/db/migrations'],
    },
  ];
  for (const service of services) {
    if (service.pairs.some(([source, artifact]) => isNewer(path.join(root, source), path.join(root, artifact)))) {
      return true;
    }
    if (service.sql && migrationSqlIsStale(path.join(root, service.sql[0]), path.join(root, service.sql[1]))) {
      return true;
    }
  }
  return false;
}

function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs.filter((arg) => arg !== '--');
  for (const arg of args) {
    if (!arg.startsWith('--env-file=') && !['migrate', 'status', 'verify', 'baseline-reviewed'].includes(arg)) {
      throw new Error(`Unknown migrate option: ${arg}`);
    }
  }
  const commandArgs = args.filter((arg) => !arg.startsWith('--env-file='));
  if (commandArgs.length > 1) throw new Error('Choose one migration command: migrate, status, verify, or baseline-reviewed.');
  const command = commandArgs[0] ?? 'migrate';
  const customEnvArg = args.find((arg) => arg.startsWith('--env-file='));
  const envFile = customEnvArg?.slice('--env-file='.length)
    ?? (fs.existsSync(path.join(ROOT, '.env.local')) ? '.env.local' : '.env');
  const resolvedEnvPath = resolveLocalPath(ROOT, envFile, '--env-file');

  const orchestratorCli = path.join(ROOT, 'services/orchestrator/dist/migrate-cli.js');
  const connectorCli = path.join(ROOT, 'services/connector/dist/migrate-cli.js');
  if (!fs.existsSync(orchestratorCli) || !fs.existsSync(connectorCli) || migrationCliNeedsBuild()) {
    console.log('\x1b[33m[migrate] Migration source or built CLI is stale. Building backend services first...\x1b[0m');
    const buildResult = spawnSync(process.execPath, ['scripts/build.cjs', '--backend-only'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (buildResult.status !== 0) process.exit(buildResult.status || 1);
  }

  console.log(`\x1b[34m[migrate] Running ${command} for Orchestrator and Connector using ${path.relative(ROOT, resolvedEnvPath)}...\x1b[0m`);
  const services = [['Orchestrator', orchestratorCli], ['Connector', connectorCli]];
  function runCommand(service, cliPath, selectedCommand) {
    const result = spawnSync(
      process.execPath,
      [`--env-file=${resolvedEnvPath}`, cliPath, selectedCommand],
      { cwd: ROOT, stdio: 'inherit' },
    );
    return result.status === 0 ? 0 : result.status || 1;
  }

  if (command === 'migrate') {
    let preflightFailed = false;
    for (const [service, cliPath] of services) {
      if (runCommand(service, cliPath, 'status') !== 0) preflightFailed = true;
    }
    if (preflightFailed) {
      console.error('\x1b[31m[migrate] Preflight found an integrity issue; no migration SQL was applied. Review status and baseline legacy rows explicitly if appropriate.\x1b[0m\n');
      process.exit(1);
    }
  }

  let commandFailed = false;
  for (const [service, cliPath] of services) {
    if (runCommand(service, cliPath, command) !== 0) {
      console.error(`\x1b[31m[migrate] ${service} ${command} failed. Verify the externally managed PostgreSQL service and DATABASE_URL.\x1b[0m\n`);
      commandFailed = true;
      if (command === 'migrate' || command === 'baseline-reviewed') break;
    }
  }
  if (commandFailed) process.exit(1);
  console.log(`\x1b[32m[migrate] Both migration engines completed ${command} successfully.\x1b[0m\n`);
}

module.exports = { migrationCliNeedsBuild, migrationSqlIsStale };

if (require.main === module) {
  main();
}
