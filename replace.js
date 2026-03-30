const fs = require('fs/promises');
const path = require('path');

const ROOT = 'd:\\Jobs\\scratch\\mdconvert';
const DIRS = ['app', 'lib', 'components', 'prisma', 'docs-site', 'docs', 'CLAUDE.md', 'README.md'];

const REPLACEMENTS = [
  // Exact words
  [/\bconvert\b/g, 'transform'],
  [/\bConvert\b/g, 'Transform'],
  [/\bCONVERT\b/g, 'TRANSFORM'],
  
  [/\bconverts\b/g, 'transforms'],
  [/\bConverts\b/g, 'Transforms'],
  
  [/\bconversion\b/g, 'transformation'],
  [/\bConversion\b/g, 'Transformation'],
  [/\bCONVERSION\b/g, 'TRANSFORMATION'],
  
  [/\bconversions\b/g, 'transformations'],
  [/\bConversions\b/g, 'Transformations'],
  [/\bCONVERSIONS\b/g, 'TRANSFORMATIONS'],
  
  [/\bconverter\b/g, 'transformer'],
  [/\bConverter\b/g, 'Transformer'],
  [/\bCONVERTER\b/g, 'TRANSFORMER'],
  
  [/\bconverters\b/g, 'transformers'],
  [/\bConverters\b/g, 'Transformers'],
  [/\bCONVERTERS\b/g, 'TRANSFORMERS'],

  // Special cases (fixing any mdconvert that was broken)
  [/\bmdtransform\b/g, 'mdconvert']
];

async function walk(dir, fileList = []) {
  try {
    const stat = await fs.stat(dir);
    if (stat.isFile()) {
       if (dir.match(/\.(ts|tsx|js|jsx|json|prisma|md|css)$/)) {
          fileList.push(dir);
       }
       return fileList;
    }
  } catch (e) {
    return fileList;
  }
  
  const files = await fs.readdir(dir);
  for (const n of files) {
    if (n === 'node_modules' || n === '.next' || n === '.git') continue;
    const p = path.join(dir, n);
    const s = await fs.stat(p);
    if (s.isDirectory()) {
      await walk(p, fileList);
    } else if (p.match(/\.(ts|tsx|js|jsx|json|prisma|md|css)$/)) {
      fileList.push(p);
    }
  }
  return fileList;
}

async function run() {
  let allFiles = [];
  for (const d of DIRS) {
    const full = path.join(ROOT, d);
    await walk(full, allFiles);
  }

  // File level replacement
  for (const f of allFiles) {
    let content = await fs.readFile(f, 'utf8');
    let modified = content;

    for (const [regex, replacement] of REPLACEMENTS) {
       modified = modified.replace(regex, replacement);
    }
    
    // Explicit exclusions/fixes
    modified = modified.replace(/mdtransform/gi, 'mdconvert'); // Restore original mdconvert anywhere

    if (modified !== content) {
       await fs.writeFile(f, modified, 'utf8');
       console.log('Updated:', f);
    }
  }
}

run().catch(console.error);
