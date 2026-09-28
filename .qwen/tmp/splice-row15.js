const fs=require('fs');const crypto=require('crypto');
const rep='D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const NL=String.fromCharCode(10);
let s=fs.readFileSync(rep,'utf8');
const rows=s.split(NL).filter(l=>/^- \d+ —/.test(l));
console.log('before_rows='+rows.length+' last='+rows[rows.length-1].slice(0,30));
const row15=''+'';
const anchor='Muc 14.';
const i=s.lastIndexOf(anchor);
if (i<0) { console.log('ANCHOR_MISS'); process.exit(2); }
const lineEnd=s.indexOf(NL, i);
const row15line='- 15 — Δ32 closure: f3 test vacuous viet lai voi positive control (chi path la bien so) + binding guard assertion phan biet goc loi; M1 do-khong-do phat hien draft thieu account, M2 do dung cau (Expected 400 / Received 201); 8/8 x3 Exit 0, typecheck 0; f3 8e7e8aa9/20652/427; W-ENC-01-SCHEMA BLOCKED (ADR-18 chua freeze, packet file khong ton tai, ENC-00 [~]) — Muc 15.';
s=s.slice(0,lineEnd)+NL+row15line+s.slice(lineEnd);
fs.writeFileSync(rep,s,'utf8');
const after=fs.readFileSync(rep,'utf8');
const rows2=after.split(NL).filter(l=>/^- \d+ —/.test(l));
const nums=rows2.map(l=>Number(l.match(/^- (\d+)/)[1]));
console.log('after_rows='+nums.length+' asc='+JSON.stringify(nums));
console.log('total_lines='+after.split(NL).length);