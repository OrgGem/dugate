#!/usr/bin/env node
/** Trusted operator CLI: provision a migrated local identity over stdin. */
import { createDb } from '../../db/db';
import { createAuditService } from '../audit/audit';
import { createAdminLocalUserRepository } from '../auth/admin-local/repository';
import { hashLocalPassword } from '../auth/admin-local/password';

export async function readMigrationPassword(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      chunks.push(chunk);
      length += chunk.length;
      if (length > 1026) throw new Error('invalid input');
    }
    const bytes = Buffer.concat(chunks);
    try {
      const value = bytes.toString('utf8').replace(/\r?\n$/, '');
      if (!value || /[\r\n]/.test(value) || Buffer.byteLength(value) > 1024 || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('invalid input');
      return value;
    } finally { bytes.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function run(): Promise<void> {
  const [tenantId, userId] = process.argv.slice(2);
  if (!tenantId || !userId || process.argv.length !== 4 || process.stdin.isTTY || !process.env.DATABASE_URL) throw new Error('invalid configuration');
  const passwordHash = await hashLocalPassword(await readMigrationPassword(process.stdin));
  const db = createDb(process.env.DATABASE_URL);
  try {
    const repository = createAdminLocalUserRepository(db, createAuditService(db));
    const user = await repository.activateLegacyUser({ tenantId, userId, passwordHash, actor: 'legacy-cutover-operator-cli' });
    if (!user) throw new Error('activation failed');
    process.stdout.write('legacy identity activated\n');
  } finally { await db.close(); }
}

if (require.main === module) run().catch(() => {
  process.stderr.write('legacy identity activation failed\n');
  process.exitCode = 1;
});
