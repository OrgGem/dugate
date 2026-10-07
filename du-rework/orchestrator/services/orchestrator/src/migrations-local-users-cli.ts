#!/usr/bin/env node
/** Bootstrap an administrator local identity without placing its password in argv or logs. */
import { createDb } from './db/db';
import { createAuditService } from './modules/audit/audit';
import {
  createAdminLocalUserRepository,
  type AdminLocalUserRepository,
} from './modules/auth/admin-local/repository';
import { hashLocalPassword } from './modules/auth/admin-local/password';

const MAX_STDIN_BYTES = 1026;

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('password input must be piped through stdin');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += part.length;
    if (size > MAX_STDIN_BYTES) {
      for (const buffered of chunks) buffered.fill(0);
      part.fill(0);
      throw new Error('password input exceeds the supported size');
    }
    chunks.push(Buffer.from(part));
  }
  const input = Buffer.concat(chunks);
  try {
    let end = input.length;
    if (end > 0 && input[end - 1] === 0x0a) end -= 1;
    if (end > 0 && input[end - 1] === 0x0d) end -= 1;
    if (input.subarray(0, end).includes(0x0a) || input.subarray(0, end).includes(0x0d)) {
      throw new Error('password input must be a single line');
    }
    const bytes = input.subarray(0, end);
    const password = bytes.toString('utf8');
    if (!Buffer.from(password, 'utf8').equals(bytes)) throw new Error('password input encoding is invalid');
    return password;
  } finally {
    input.fill(0);
    for (const buffered of chunks) buffered.fill(0);
  }
}

export async function executeAdminLocalUserCommand(
  args: string[],
  repository: AdminLocalUserRepository,
  readPassword: () => Promise<string> = readPasswordFromStdin
): Promise<boolean> {
  try {
    const command = args[0];
    const tenantId = argumentValue(args, '--tenant-id');
    const username = argumentValue(args, '--username');
    const userId = argumentValue(args, '--user-id');
    if (!tenantId) return false;

    const actor = 'admin-local-user-cli';
    switch (command) {
      case 'create-admin': {
        if (!username) return false;
        const passwordHash = await hashLocalPassword(await readPassword());
        await repository.createAdmin({ tenantId, username, passwordHash, actor });
        return true;
      }
      case 'disable-admin': {
        if (!userId) return false;
        return (await repository.disableAdmin({ tenantId, userId, actor })) !== null;
      }
      case 'reset-password': {
        if (!userId) return false;
        const passwordHash = await hashLocalPassword(await readPassword());
        return (await repository.resetPassword({ tenantId, userId, passwordHash, actor })) !== null;
      }
      case 'rotate-credentials': {
        if (!userId) return false;
        const passwordHash = await hashLocalPassword(await readPassword());
        return (await repository.rotateCredentials({ tenantId, userId, passwordHash, actor })) !== null;
      }
      default:
        return false;
    }
  } catch {
    // Do not expose whether a tenant, username, or user id exists, or why
    // password material could not be processed.
    return false;
  }
}

export function adminLocalUserCommandMessage(success: boolean): string {
  return success ? 'admin local user command succeeded\n' : 'admin local user command failed\n';
}

async function run(args: string[]): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('command configuration is invalid');
  const db = createDb(databaseUrl);
  let succeeded = false;
  try {
    const repository = createAdminLocalUserRepository(db, createAuditService(db));
    succeeded = await executeAdminLocalUserCommand(args, repository);
  } finally {
    await db.close();
  }

  const message = adminLocalUserCommandMessage(succeeded);
  if (succeeded) process.stdout.write(message);
  else {
    process.stderr.write(message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch(() => {
    // The CLI intentionally gives the same failure response for invalid input,
    // missing tenants, and duplicate identities; it never enumerates users.
    process.stderr.write(adminLocalUserCommandMessage(false));
    process.exitCode = 1;
  });
}
