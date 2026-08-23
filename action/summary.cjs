#!/usr/bin/env node
"use strict";

// src/summary.ts
var import_node_fs = require("node:fs");

// src/report.ts
function shortenPath(filePath) {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}
function escapeCell(value) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  const escaped = cleaned.replace(/[!-/:-@[-`{-~]/g, "\\$&");
  return `\`${escaped}\``;
}
function renderMarkdownReport(report2) {
  const lines = [];
  lines.push("## CRAP Report");
  lines.push("");
  if (report2.filter !== void 0) {
    lines.push(`Changed-only mode: since \`${report2.filter.changedSince}\` (merge base \`${report2.filter.mergeBase}\`, ${report2.filter.changedFileCount} changed file(s))`);
    lines.push("");
  }
  if (report2.rows.length === 0) {
    lines.push(report2.filter === void 0 ? "No functions found." : "No eligible changed functions found.");
    lines.push("");
    lines.push(`**Threshold:** ${report2.summary.threshold} \xB7 **Breached:** ${report2.summary.breached ? "YES" : "no"}`);
    return lines.join("\n");
  }
  lines.push("| Function | File | Line | CC | Cov | Threshold | CRAP |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report2.rows) {
    const breach = row.crap > row.threshold;
    const name = breach ? `\u26A0\uFE0F ${escapeCell(row.displayName)}` : escapeCell(row.displayName);
    const coverage = `${(row.coverage * 100).toFixed(1)}%`;
    lines.push(
      `| ${name} | ${escapeCell(shortenPath(row.filePath))} | ${row.startLine} | ${row.complexity} | ${coverage} | ${row.threshold.toFixed(1)} | ${row.crap.toFixed(1)} |`
    );
  }
  lines.push("");
  const gate = report2.summary.breached ? "\u274C FAIL" : "\u2705 PASS";
  lines.push(
    `**Threshold:** ${report2.summary.threshold} \xB7 **Functions:** ${report2.summary.totalFunctions} \xB7 **Max CRAP:** ${report2.summary.maxCrap.toFixed(1)} \xB7 **Breached:** ${report2.summary.breachedCount} function(s) \xB7 **Gate:** ${gate}`
  );
  return lines.join("\n");
}

// src/summary.ts
var jsonPath = process.argv[2];
if (jsonPath === void 0 || process.argv[3] !== void 0) {
  process.stderr.write("Error: usage: summary.cjs <report.json>\n");
  process.exit(1);
}
var report;
try {
  report = JSON.parse((0, import_node_fs.readFileSync)(jsonPath, "utf8"));
} catch (error) {
  process.stderr.write(`Error: cannot read report JSON: ${error.message}
`);
  process.exit(1);
}
var summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary === void 0 || summary === "") {
  process.stderr.write("Error: GITHUB_STEP_SUMMARY is not set\n");
  process.exit(1);
}
(0, import_node_fs.appendFileSync)(summary, renderMarkdownReport(report) + "\n\n");
