"use strict";
// Zero-dependency lint: parse every JS file (node --check). No eslint config
// needed — the codebase is dependency-free by design.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const files = ["server.js", "booking-page.js"];
for (const dir of ["notifiers", "payments", "scripts", "tests", "tools"]) {
  const d = path.join(ROOT, dir);
  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith(".js")) files.push(`${dir}/${f}`);
}
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
  } catch (e) {
    bad++;
    console.error(`SYNTAX FAIL ${f}\n${(e.stderr || e.stdout || "").toString().slice(0, 500)}`);
  }
}
console.log(bad ? `check: ${bad} file(s) failed` : `check: all ${files.length} files parse`);
process.exit(bad ? 1 : 0);
