const fs = require('fs');
const T = 'D:/Git/dugate/.qwen/tmp/';
for (const f of ['enc-test-p2.txt','enc-test-p3.txt']) {
  const p = T + f;
  let s = fs.readFileSync(p, 'utf8');
  s = s.split('createMetadataCrypto(makeProvider(), KEY_REF)').join('makeCrypto().crypto');
  s = s.split('createMetadataCrypto(makeProvider({ failWrap: true }), KEY_REF)').join('makeCrypto({ failWrap: true }).crypto');
  s = s.split('createMetadataCrypto(makeProvider({ failUnwrap: true }), KEY_REF)').join('makeCrypto({ failUnwrap: true }).crypto');
  s = s.split('createMetadataCrypto(makeProvider({ wrongKey: true }), KEY_REF)').join('makeCrypto({ wrongKey: true }).crypto');
  fs.writeFileSync(p, s, 'utf8');
}
// part2 also had a provider.wraps assertion; switch it to stats.wraps
const p2 = T + 'enc-test-p2.txt';
let s2 = fs.readFileSync(p2, 'utf8');
s2 = s2.split('const provider = makeProvider();').join('const { stats } = makeCrypto();');
s2 = s2.split('const crypto = createMetadata').join('const crypto = makeCrypto().crypto; void');
s2 = s2.split('expect(provider.wraps)').join('expect(stats.wraps)');
fs.writeFileSync(p2, s2, 'utf8');
console.log('rewritten');