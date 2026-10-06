'use strict';
const u = process.env.DU_LIVE_DATABASE_URL;
let user = null;
try {
  user = u ? new URL(u).username : null;
} catch {
  user = 'PARSE_ERROR';
}
process.stdout.write(JSON.stringify({
  hasLive: Boolean(u),
  liveLength: u ? u.length : 0,
  liveUser: user,
  hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
}) + '\n');
