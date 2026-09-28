const fs=require('fs');const NL=String.fromCharCode(10);
const s=fs.readFileSync('C:/Users/Gem/.qwen/projects/d--git-dugate/memory/MEMORY.md','utf8');
const L=s.split(NL);
console.log('INDEX_LINES=' + L.length);
L.forEach((t,i)=>{ if(t.includes('qwen-platform-lane-state')) console.log((i+1)+': '+t.slice(0,120)); });
const m=fs.readFileSync('C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md','utf8');
console.log('MEM_FILE_LINES=' + m.split(NL).length);
console.log('has_c14=' + (m.indexOf('W-VAULT-06-DELTA31')>=0) + ' has_A_B=' + (m.indexOf('MOT BIEN')>=0) + ' has_ledger_trap=' + (m.indexOf('Tu pha line')>=0) + ' desc_c14=' + (m.indexOf('Cycle tiếp theo: append Mục 15')>=0 || m.indexOf('Cycle tiep: append Muc 15')>=0));