"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDb = createDb;
exports.migrate = migrate;
const pg_1 = require("pg");
function createDb(connectionString) {
    const pool = new pg_1.Pool({ connectionString, max: 10 });
    return {
        pool,
        query: (text, params) => pool.query(text, params),
        async tx(fn) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await fn(client);
                await client.query('COMMIT');
                return result;
            }
            catch (err) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw err;
            }
            finally {
                client.release();
            }
        },
        close: () => pool.end(),
    };
}
async function migrate(db, migrationSql) {
    for (const sql of migrationSql) {
        await db.query(sql);
    }
}
