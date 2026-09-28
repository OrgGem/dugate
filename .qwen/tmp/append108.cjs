const fs = require("fs");
let n = 0;
const p1 = "D:/Git/dugate/du-rework/coordination/reports/qwen3.md";
let r1 = fs.readFileSync(p1, "utf8");
if (r1.indexOf("## W49-Q3-15") === -1) {
  if (!r1.endsWith("\n")) r1 += "\n";
  fs.writeFileSync(p1, r1 + fs.readFileSync("D:/Git/dugate/.qwen/tmp/w49q315.txt", "utf8"));
  n++;
}
console.log("report appended:", n);