const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/packages/worker-sdk/tests/crypto-seam.test.ts';
let s = fs.readFileSync(p, 'utf8');
// 1. wrappedKey -> ciphertext (matches the WrappedDek shape)
s = s.split('wrappedKey: xor(').join('ciphertext: xor(');
// 2. readFileSyncSync -> readFileSync, and restore the node:path import
s = s.split('readFileSyncSync(').join('readFileSync(');
s = s.replace("import { readFileSync } from 'node:fs';", "import { readFileSync } from 'node:fs';" + NL + "import { join } from 'node:path';");
// 3. build an async iterable for openStream instead of a plain array
const arrOpen = "    const opened = crypto.openStream(chunks, resolved, { artifactId: 'art-big' });";
const asyncOpen = "    async function* replay(list: Buffer[]): AsyncGenerator<Buffer, void, void> {" + NL + "      for (const item of list) yield item;" + NL + "    }" + NL + "    const opened = crypto.openStream(replay(chunks), resolved, { artifactId: 'art-big' });";
s = s.split(arrOpen).join(asyncOpen);
const arrOther = "    expect(() => crypto.openStream(chunks, resolved, { artifactId: 'art-other' })).toThrow();";
const asyncOther = "    async function* replay(list: Buffer[]): AsyncGenerator<Buffer, void, void> {" + NL + "      for (const item of list) yield item;" + NL + "    }" + NL + "    expect(() => crypto.openStream(replay(chunks), resolved, { artifactId: 'art-other' })).toThrow();";
s = s.split(arrOther).join(asyncOther);
fs.writeFileSync(p, s, 'utf8');
console.log('fixes_applied');
console.log('wrappedKey_left=' + (s.indexOf('wrappedKey: xor') >= 0));
console.log('readFileSyncSync_left=' + (s.indexOf('readFileSyncSync') >= 0));
console.log('join_import=' + (s.indexOf("from 'node:path'") >= 0));
console.log('replay_helper=' + (s.indexOf('async function* replay') >= 0));