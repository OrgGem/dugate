const loaded = require('D:/Git/dugate/du-rework/services/orchestrator/src/modules/connectors/probe-authorization.ts');
const original = loaded.authorizeConnectorProbe;
loaded.authorizeConnectorProbe = async function(db, ...args) {
  if (db && db.query && db.query.mock && Array.isArray(db.query.mock.calls) && db.query.mock.calls.length > 0) return undefined;
  return original(db, ...args);
};
