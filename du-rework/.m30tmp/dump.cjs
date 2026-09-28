const fs = require("fs");
const p = process.argv[2];
const from = Number(process.argv[3]);
const to = Number(process.argv[4]);
const b = fs.readFileSync(p);
let line = 1, i = 0, out = [];
while (i < b.length && line <= to) {
  let j = i;
  while (j < b.length && b[j] !== 10) j += 1;
  const eol = j >= b.length ? "NONE" : (j > i && b[j - 1] === 13 ? "CRLF" : "LF");
  if (line >= from) out.push(line + "|" + eol + "|" + b.slice(i, j).toString("utf8"));
  i = j + 1; line += 1;
}
console.log(out.join("\n"));
