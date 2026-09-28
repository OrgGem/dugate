const fs = require("fs");
const p = "D:/Git/dugate/du-rework/coordination/reports/qwen3.md";
let raw = fs.readFileSync(p, "utf8");
if (raw.indexOf("## W49-Q3-18") === -1) { if (!raw.endsWith("\n")) raw += "\n"; fs.writeFileSync(p, raw + fs.readFileSync("D:/Git/dugate/.qwen/tmp/w49q318.txt", "utf8")); console.log("appended"); } else console.log("already");