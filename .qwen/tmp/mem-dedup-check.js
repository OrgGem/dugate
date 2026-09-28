const fs=require('fs');const NL=String.fromCharCode(10);
const m=fs.readFileSync('C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md','utf8');
console.log('lines=' + m.split(NL).length);
console.log('dup_D30=' + (m.split('Δ30 VAN MO').length-1) + ' dup_D32=' + (m.split("Δ32 MO (test 377-383").length-1) + ' has_D35=' + (m.indexOf('Δ35')>=0) + ' has_loopback_trap=' + (m.indexOf('Flake loopback')>=0));