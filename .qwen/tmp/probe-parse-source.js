const fs = require('fs');
const path = require('path');
const conn = 'D:/Git/dugate/du-rework/services/connector';
const conRoot = 'D:/Git/dugate/du-rework/services/connector';
const res = require(path.join(conn, 'dist/vault/resolver.js'));
const REASON = { account: 'du-conn-openai-main', mount: 'secret', path: 'du/tenants/tenant-a/connectors/openai-live/accounts/du-conn-openai-main', key: 'api-key' };
for (const kind of ['vault-kv2', 'vault-kv-v2']) {
  try {
    const out = res.parseCredentialSource({ kind: kind, ...REASON, version: 1 });
    console.log('KIND=' + kind + ' OK -> kind=' + out.kind);
  } catch (e) {
    console.log('KIND=' + kind + ' THREW code=' + (e && e.code) + ' msg=' + (e && e.message));
  }
}
const cd = 'D:/Git/dugate/du-rework/packages/contracts/dist/vault.js';
const cs = fs.readFileSync(cd, 'utf8');
console.log('CONTRACTS_DIST_has_kv_v2_alias=' + (cs.indexOf('vault-kv-v2') >= 0));
console.log('CONTRACTS_DIST_BYTES=' + Buffer.byteLength(cs));
const srcV = fs.readFileSync('D:/Git/dugate/du-rework/packages/contracts/src/vault.ts', 'utf8');
console.log('CONTRACTS_SRC_has_alias=' + (srcV.indexOf('vault-kv-v2') >= 0));
console.log('dist_mtime=' + fs.statSync(cd).mtime.toISOString() + ' src_mtime=' + fs.statSync('D:/Git/dugate/du-rework/packages/contracts/src/vault.ts').mtime.toISOString());
console.log('conn_dist_resolver_mtime=' + fs.statSync(path.join(conn, 'dist/vault/resolver.js')).mtime.toISOString() + ' conn_src_mtime=' + fs.statSync(path.join(conn, 'src/vault/resolver.ts')).mtime.toISOString());