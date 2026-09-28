const fs = require("fs");
for (const p of process.argv.slice(2)) {
  const b = fs.readFileSync(p);
  let crlf = 0, lone = 0;
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] === 10) { if (i > 0 && b[i - 1] === 13) crlf += 1; else lone += 1; }
  }
  console.log(p.split(/[\\/]/).pop() + " crlf=" + crlf + " loneLF=" + lone);
}
