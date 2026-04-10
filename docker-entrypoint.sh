#!/bin/sh
set -e

# Run ONLY the latest migration SQL when MIGRATION=true
if [ "$MIGRATION" = "true" ]; then
  MIGRATION_FILE="./prisma/migrations/20260410_add_step_id_to_override/migration.sql"

  if [ -f "$MIGRATION_FILE" ]; then
    echo "[entrypoint] MIGRATION=true → Running: $MIGRATION_FILE"
    node -e "
      const { PrismaClient } = require('@prisma/client');
      const fs = require('fs');
      const prisma = new PrismaClient();
      (async () => {
        const sql = fs.readFileSync('$MIGRATION_FILE', 'utf8');
        const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of statements) {
          try {
            await prisma.\$executeRawUnsafe(stmt);
            console.log('[migration] OK:', stmt.substring(0, 80) + '...');
          } catch (e) {
            // Skip if already applied (column/constraint already exists)
            if (e.message && (e.message.includes('already exists') || e.message.includes('does not exist'))) {
              console.log('[migration] SKIP (already applied):', stmt.substring(0, 80) + '...');
            } else {
              throw e;
            }
          }
        }
        await prisma.\$disconnect();
        console.log('[migration] Done.');
      })();
    "
  else
    echo "[entrypoint] Migration file not found: $MIGRATION_FILE — skipping."
  fi
else
  echo "[entrypoint] MIGRATION not set → Skipping migration."
fi

echo "[entrypoint] Starting server..."
exec node server.js
