const fs = require('fs');
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
const NL = String.fromCharCode(10);
const ED = String.fromCharCode(8212);
let s = fs.readFileSync(p, 'utf8');
// 1. name line
s = s.replace('name: Qwen-Platform lane ' + ED + ' 12 cycles landed', 'name: Qwen-Platform lane ' + ED + ' 15 cycles landed; f3 binding + delta32 closure + ENC-01 blocked');
// 2. description
s = s.replace('description: du-rework orchestrator/connector lane state (cycles 1-11: cancel semantics, admin envelopes, vault fixture, DATA03 ingestion join, vault legacy-transition, post-lease fence + artifact consistency), gates, deltas, tool traps',
  'description: du-rework orchestrator/connector lane state (cycles 1-15: cancel semantics, admin envelopes, vault fixture, DATA03 ingestion join, vault legacy-transition, post-lease fence + artifact consistency, pg fail-closed, deadline literal 0019, f3 binding fix, delta32 closure, ENC-01 blocked), gates, deltas, tool traps');
// 3. body: cycle-14 state line -> cycle-15 state
const oldBody = s.match(/Muc 14 = [^S]*?SHA baseline cycle 9[^.]*\./);
console.log('body_match=' + (oldBody ? 'found' : 'MISSING'));
// Replace just the status tail (from 'Cycle tiep:' up to 'loopback).')
const m = s.indexOf('Cycle tiep: append Muc 15.');
if (m >= 0) {
  const end = s.indexOf('loopback).', m);
  if (end >= 0) {
    const tail = end + 'loopback).'.length;
    const replacement = 'Muc 15 = delta32 closure (f3 test vacuous viet lai voi positive control + M2 mutation do dung cau; 8/8 x3; f3 8e7e8aa9/20652/427) + W-ENC-01-SCHEMA BLOCKED (ADR-18 chua freeze, packet khong ton tai, ENC-00 [~]). ' + ED + '29 DONG (Admin align), ' + ED + '31 DONG (cycle 14), ' + ED + '32 DONG (cycle 15). MO: ' + ED + '30 (docs/06:74, docs/20:39, 0019 header, neo server.ts 2556/2594/2629); ' + ED + '35 (flake ETIMEDOUT loopback, fleet load). Cycle tiep: append Muc 16.';
    s = s.slice(0, m) + replacement + s.slice(tail);
  } else console.log('TAIL_END_MISSING');
} else console.log('TAIL_START_MISSING');
fs.writeFileSync(p, s, 'utf8');
console.log('DONE');
console.log('name_ok=' + (s.indexOf('15 cycles landed; f3 binding') >= 0));
console.log('desc_ok=' + (s.indexOf('cycles 1-15') >= 0));
console.log('cycle15_ok=' + (s.indexOf('Muc 15 = delta32 closure') >= 0));
console.log('oldstate_gone=' + (s.indexOf('Muc 15. MO:') < 0 && s.indexOf('append Muc 15.') < 0));