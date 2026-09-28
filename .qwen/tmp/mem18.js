const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let s = fs.readFileSync(p, 'utf8');
const anchor = 'Cycle tiep: append Muc 18.';
const i = s.indexOf(anchor);
if (i < 0) { console.log('ANCHOR_MISS'); process.exit(2); }
const D = String.fromCharCode(916);
const tail = 'Muc 18 = W-ENC-04-WORKER-SDK BLOCKED (task_fb6bd3a9e44d), operator chon thu hoi, 0 file sua. 4 luong do bang lenh: (1) CryptoStorageFacade ENC-03 nam o services/orchestrator, worker-sdk khong co src/crypto; (2) worker-sdk khong phu thuoc orchestrator + tsconfig rootDir=src nen import cheo bat kha thi (3 noi nhan services/orchorchestrator chi la COMMENT); (3) ClaimResultSchema khong mang field key nao -> worker CHUA co duong nhan DEK, va ADR-18 cam app nhan raw master key; (4) packages/document-core KHONG ton tai, that la businesses/document-core. Can mo scope (a) cho cua facade, (b) co che DEK delivery, (c) sua duong dan packet. ' + D + '40 facade-o-scope, ' + D + '41 worker-chua-co-DEK-delivery, ' + D + '42 duong-dan-sai.' + NL + 'Cycle tiep: append Muc 19.';
s = s.slice(0, i) + tail + s.slice(i + anchor.length);
fs.writeFileSync(p, s, 'utf8');
console.log('memory updated lines=' + s.split(NL).length);