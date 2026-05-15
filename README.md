# junit-report-doctor-kit

[![npm version](https://img.shields.io/npm/v/junit-report-doctor-kit.svg)](https://www.npmjs.com/package/junit-report-doctor-kit)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Recoveredd/junit-report-doctor-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Recoveredd/junit-report-doctor-kit/actions/workflows/ci.yml)

Normalize JUnit XML reports with stable diagnostics.

`junit-report-doctor-kit` is a clean-room TypeScript package for CI tools that need to inspect JUnit-style XML before uploading it to Jenkins, GitLab, Azure DevOps, Testmo, or another report consumer. It keeps the v1 scope small: parse common `<testsuite>` and `<testsuites>` reports, normalize suites and cases, and explain common problems with stable diagnostic codes.


## Install

```bash
npm install junit-report-doctor-kit
```

## Quick Start

```ts
import { inspectJunitXml, parseJunitXml } from "junit-report-doctor-kit";

const result = inspectJunitXml(xmlText, { strictCounters: true });

if (result.ok && result.report) {
  console.log(result.report.summary);
} else {
  console.log(result.diagnostics);
}
```

Use `parseJunitXml` when invalid reports should fail fast:

```ts
const report = parseJunitXml(xmlText);
console.log(report.suites[0]?.cases[0]?.status);
```

## Demo

Try the browser preview: https://packages.wasta-wocket.fr/junit-report-doctor-kit/

## CLI

```bash
junit-report-doctor report.xml --json --strict
```

Without `--json`, the CLI prints a compact summary, dialect hints, and diagnostics. `--strict` turns declared counter mismatches into errors so CI can fail before uploading a misleading report.

Example text output:

```text
1 suites, 2 tests, 1 passed, 1 failures, 0 errors, 0 skipped, 0ms
ERROR counter-mismatch $.summary.failures Root counter failures=0 does not match normalized cases (1).
```

## API

### `inspectJunitXml(input, options?)`

Returns `{ ok, report?, diagnostics }`. Expected invalid input is reported through diagnostics instead of throwing.

### `parseJunitXml(input, options?)`

Returns the normalized report or throws an `Error` when diagnostics contain an error.

### `createJunitXmlInspector(defaultOptions?)`

Creates a small reusable inspector. Per-call options override the defaults.

## Normalized Report

The report contains:

- `root`: `testsuite` or `testsuites`;
- `dialectHints`: small hints such as `single-suite-root`, `ci-properties`, or `attachments-or-file-metadata`;
- `suites`: normalized suites with properties, stdout/stderr, attachments, and test cases;
- `summary`: suite count, test count, pass/fail/error/skipped counts, and duration in milliseconds.

Test cases include:

- `status`: `passed`, `failed`, `error`, or `skipped`;
- `durationMs`: parsed from JUnit `time` seconds when valid;
- `failureMessages` / `errorMessages`: compact message arrays for summaries;
- `failureDetails` / `errorDetails`: optional message, type, and text body for stack traces;
- `attachments`: metadata detected from `file`/`url` attributes, `<attachment>` elements, and `[[ATTACHMENT|path]]` stdout markers.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `strictCounters` | `false` | Treat declared counter mismatches as errors instead of warnings. |
| `preserveWhitespace` | `false` | Keep text whitespace as-is instead of normalizing runs to one space. |

## Diagnostics

Diagnostics are stable strings intended for logs, UIs, and tests:

- `invalid-input`
- `empty-input`
- `invalid-xml`
- `unsupported-root`
- `missing-testcase-name`
- `missing-suite-name`
- `invalid-duration`
- `counter-mismatch`
- `case-outside-suite`
- `duplicate-property`
- `nested-suite`
- `namespace-normalized`
- `attachment-metadata`
- `stdout-at-root`
- `stderr-at-root`
- `unsupported-xml-construct`

## Supported JUnit XML Shapes

The v1 scope is intentionally narrow but practical:

- `<testsuite>` as the document root;
- `<testsuites>` with one or more suite children;
- nested `<testsuite>` nodes, flattened in the normalized output;
- namespaced element names such as `<j:testsuite>`, normalized to their local names;
- `<properties>`, `<system-out>`, `<system-err>`, `<failure>`, `<error>`, and `<skipped>`;
- CDATA and common XML entities in text bodies.

## Limits

This is not a general XML engine and does not try to replace CI-native validators. The package supports common JUnit XML shapes and intentionally avoids runtime dependencies. Vendor-specific metadata, every attachment convention, XML DTD validation, and complete XML namespace semantics are outside the v1 scope.

## Browser Compatibility

The library entrypoint uses no Node-only APIs and can run in browsers, workers, CLIs, and build tooling. The optional CLI entrypoint uses Node.js file I/O.

## Package quality

CI runs `npm ci`, `typecheck`, `build`, and `test`. Tested on Node.js 20 and 22 with GitHub Actions.

The package has no runtime dependencies. The core inspector is browser-friendly; only the CLI imports Node.js `fs`.

## License

MPL-2.0
