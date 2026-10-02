import type { QueryResultRow } from 'pg';
import type { Db } from '../../../db/db';
import type { LocalCredentialReader, LocalCredentialRecord } from '../local-primitives/authenticate';
import { normalizeLocalUsername } from './repository';

interface CredentialRow extends QueryResultRow {
  id: string;
  password_hash: string;
  role: string;
  tenant_id: string | null;
}

/**
 * LOCAL-03 login seam: resolve exactly ONE enabled, unlocked local account
 * by its normalized username.
 *
 * Fail-closed rules:
 *  - Disabled and locked accounts are invisible to the reader (WHERE
 *    clause), so they can never be authenticated.
 *  - A malformed username resolves to null without touching the database.
 *  - Unknown OR ambiguous (0 or >1 rows) resolves to null; the caller
 *    (authenticateLocalPassword) still performs a dummy derivation and
 *    returns the one generic 401 — no user enumeration.
 *  - The login normalization is the repository's own
 *    `normalizeLocalUsername`, the same function the writer uses, so a
 *    credential can never be created under one key and read under another.
 */
export function createAdminLocalCredentialReader(db: Db): LocalCredentialReader {
  return {
    async findByLogin(login: string): Promise<LocalCredentialRecord | null> {
      let normalized: string;
      try {
        normalized = normalizeLocalUsername(login);
      } catch {
        return null;
      }
      const result = await db.query<CredentialRow>(
        `SELECT id, password_hash, role, tenant_id
         FROM admin_local_users
         WHERE username_normalized = $1 AND is_enabled = true AND is_locked = false`,
        [normalized]
      );
      if (result.rows.length !== 1) return null;
      const row = result.rows[0];
      if (!row) return null;
      return {
        subjectId: row.id,
        passwordHash: row.password_hash,
        role: row.role,
        tenantId: row.tenant_id,
      };
    },
  };
}
