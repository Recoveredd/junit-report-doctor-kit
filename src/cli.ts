#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { inspectJunitXml } from "./index.js";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("-"));
const json = args.includes("--json");
const strict = args.includes("--strict");

if (!file || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: junit-report-doctor <report.xml> [--json] [--strict]

Options:
  --json    Print the full inspection result as JSON.
  --strict  Treat counter mismatches as errors.
  -h, --help  Show this help message.`);
  process.exit(file ? 0 : 1);
}

let input = "";
try {
  input = readFileSync(file, "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, diagnostics: [{ code: "read-error", message }] }, null, 2));
  } else {
    console.error(`ERROR read-error ${message}`);
  }
  process.exit(2);
}

const result = inspectJunitXml(input, { strictCounters: strict });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const summary = result.report?.summary;
  if (summary) {
    console.log(
      `${summary.suites} suites, ${summary.tests} tests, ${summary.passed} passed, ${summary.failures} failures, ${summary.errors} errors, ${summary.skipped} skipped, ${summary.durationMs}ms`
    );
  }
  if (result.report?.dialectHints.length) {
    console.log(`hints: ${result.report.dialectHints.join(", ")}`);
  }
  for (const entry of result.diagnostics) {
    console.log(`${entry.severity.toUpperCase()} ${entry.code} ${entry.path} ${entry.message}`);
  }
}

process.exit(result.ok ? 0 : 2);
