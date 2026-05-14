export type JunitDiagnosticSeverity = "info" | "warning" | "error";

export type JunitDiagnosticCode =
  | "invalid-input"
  | "empty-input"
  | "invalid-xml"
  | "unsupported-root"
  | "missing-testcase-name"
  | "missing-suite-name"
  | "invalid-duration"
  | "counter-mismatch"
  | "case-outside-suite"
  | "duplicate-property"
  | "nested-suite"
  | "namespace-normalized"
  | "attachment-metadata"
  | "stdout-at-root"
  | "stderr-at-root"
  | "unsupported-xml-construct";

export type JunitDiagnostic = {
  code: JunitDiagnosticCode;
  severity: JunitDiagnosticSeverity;
  message: string;
  path: string;
};

export type JunitCaseStatus = "passed" | "failed" | "error" | "skipped";

export type JunitProperty = {
  name: string;
  value: string;
};

export type JunitMessageDetail = {
  message?: string;
  type?: string;
  text?: string;
};

export type JunitAttachment = {
  path?: string;
  url?: string;
  source: "attachment-element" | "file-attribute" | "url-attribute" | "stdout-marker";
};

export type JunitTestCase = {
  name: string;
  classname?: string;
  file?: string;
  line?: number;
  durationMs?: number;
  status: JunitCaseStatus;
  failureMessages: string[];
  errorMessages: string[];
  failureDetails: JunitMessageDetail[];
  errorDetails: JunitMessageDetail[];
  skippedMessage?: string;
  stdout?: string;
  stderr?: string;
  attachments: JunitAttachment[];
  properties: JunitProperty[];
};

export type JunitSuite = {
  name: string;
  durationMs?: number;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  properties: JunitProperty[];
  stdout?: string;
  stderr?: string;
  attachments: JunitAttachment[];
  cases: JunitTestCase[];
};

export type JunitReportSummary = {
  suites: number;
  tests: number;
  passed: number;
  failures: number;
  errors: number;
  skipped: number;
  durationMs: number;
};

export type JunitReport = {
  root: "testsuites" | "testsuite";
  dialectHints: string[];
  suites: JunitSuite[];
  summary: JunitReportSummary;
};

export type JunitInspectOptions = {
  strictCounters?: boolean;
  preserveWhitespace?: boolean;
};

export type JunitInspectResult = {
  ok: boolean;
  report?: JunitReport;
  diagnostics: JunitDiagnostic[];
};

type XmlNode = {
  name: string;
  rawName: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
  parent?: XmlNode;
};

const defaultOptions = {
  strictCounters: false,
  preserveWhitespace: false
} satisfies Required<JunitInspectOptions>;

export function inspectJunitXml(input: unknown, options: JunitInspectOptions = {}): JunitInspectResult {
  if (typeof input !== "string") {
    return {
      ok: false,
      diagnostics: [diagnostic("invalid-input", "error", "Expected JUnit XML as a string.", "$")]
    };
  }

  if (input.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [diagnostic("empty-input", "error", "Expected a non-empty JUnit XML document.", "$")]
    };
  }

  const settings = { ...defaultOptions, ...options };
  const diagnostics: JunitDiagnostic[] = [];
  const parsed = parseXml(input, settings.preserveWhitespace, diagnostics);
  if (!parsed) return { ok: false, diagnostics };

  if (parsed.name !== "testsuites" && parsed.name !== "testsuite") {
    diagnostics.push(
      diagnostic("unsupported-root", "error", `Expected <testsuites> or <testsuite>, found <${parsed.name}>.`, "$")
    );
    return { ok: false, diagnostics };
  }

  const suiteNodes = collectSuiteNodes(parsed);
  const suites = suiteNodes.map((suite, index) => normalizeSuite(suite, `$.suites[${index}]`, diagnostics));
  const summary = summarizeSuites(suites);

  for (const [index, suite] of suites.entries()) {
    checkSuiteCounters(suite, `$.suites[${index}]`, settings.strictCounters, diagnostics);
  }
  checkDeclaredCounters(parsed, summary, "$.summary", settings.strictCounters, diagnostics);

  if (directChildren(parsed, "testcase").length > 0) {
    diagnostics.push(
      diagnostic("case-outside-suite", "warning", "Found <testcase> directly under the document root.", "$")
    );
  }

  const rootStdout = directChildren(parsed, "system-out");
  const rootStderr = directChildren(parsed, "system-err");
  if (rootStdout.length > 0) {
    diagnostics.push(diagnostic("stdout-at-root", "info", "Found root-level stdout; attach it to a suite if needed.", "$"));
  }
  if (rootStderr.length > 0) {
    diagnostics.push(diagnostic("stderr-at-root", "info", "Found root-level stderr; attach it to a suite if needed.", "$"));
  }

  if (suiteNodes.some((suite) => suite.parent?.name === "testsuite")) {
    diagnostics.push(
      diagnostic(
        "nested-suite",
        "info",
        "Found nested <testsuite> nodes; they were flattened into the normalized suites list.",
        "$.suites"
      )
    );
  }

  const report: JunitReport = {
    root: parsed.name,
    dialectHints: detectDialectHints(parsed),
    suites,
    summary
  };

  return {
    ok: diagnostics.every((entry) => entry.severity !== "error"),
    report,
    diagnostics
  };
}

export function parseJunitXml(input: string, options: JunitInspectOptions = {}): JunitReport {
  const result = inspectJunitXml(input, options);
  if (!result.ok || !result.report) {
    const reason = result.diagnostics.map((entry) => entry.code).join(", ") || "unknown-error";
    throw new Error(`Invalid JUnit XML report: ${reason}`);
  }
  return result.report;
}

export function createJunitXmlInspector(defaultOptions: JunitInspectOptions = {}) {
  return {
    inspect(input: unknown, options: JunitInspectOptions = {}) {
      return inspectJunitXml(input, { ...defaultOptions, ...options });
    },
    parse(input: string, options: JunitInspectOptions = {}) {
      return parseJunitXml(input, { ...defaultOptions, ...options });
    }
  };
}

function normalizeSuite(node: XmlNode, path: string, diagnostics: JunitDiagnostic[]): JunitSuite {
  const cases = directChildren(node, "testcase").map((testCase, index) =>
    normalizeCase(testCase, `${path}.cases[${index}]`, diagnostics)
  );
  const properties = readProperties(node, `${path}.properties`, diagnostics);
  const durationMs = parseDuration(node.attributes.time, `${path}.durationMs`, diagnostics);
  const name = node.attributes.name ?? "";

  if (name.length === 0) {
    diagnostics.push(diagnostic("missing-suite-name", "warning", "A testsuite is missing a name.", path));
  }

  const suite: JunitSuite = {
    name,
    tests: parseInteger(node.attributes.tests, cases.length),
    failures: parseInteger(node.attributes.failures, cases.filter((entry) => entry.status === "failed").length),
    errors: parseInteger(node.attributes.errors, cases.filter((entry) => entry.status === "error").length),
    skipped: parseInteger(node.attributes.skipped, cases.filter((entry) => entry.status === "skipped").length),
    properties,
    attachments: readAttachments(node, `${path}.attachments`, diagnostics),
    cases
  };
  if (durationMs !== undefined) suite.durationMs = durationMs;
  const stdout = firstText(node, "system-out");
  const stderr = firstText(node, "system-err");
  if (stdout !== undefined) suite.stdout = stdout;
  if (stderr !== undefined) suite.stderr = stderr;
  return suite;
}

function normalizeCase(node: XmlNode, path: string, diagnostics: JunitDiagnostic[]): JunitTestCase {
  const failureDetails = directChildren(node, "failure").map(readMessageDetail);
  const errorDetails = directChildren(node, "error").map(readMessageDetail);
  const failures = failureDetails.map((entry) => entry.message ?? entry.text ?? "").filter(Boolean);
  const errors = errorDetails.map((entry) => entry.message ?? entry.text ?? "").filter(Boolean);
  const skippedNode = directChildren(node, "skipped")[0];
  const durationMs = parseDuration(node.attributes.time, `${path}.durationMs`, diagnostics);
  const name = node.attributes.name ?? "";

  if (name.length === 0) {
    diagnostics.push(diagnostic("missing-testcase-name", "error", "A testcase is missing its required name.", path));
  }

  const testCase: JunitTestCase = {
    name,
    status: errors.length > 0 ? "error" : failures.length > 0 ? "failed" : skippedNode ? "skipped" : "passed",
    failureMessages: failures,
    errorMessages: errors,
    failureDetails,
    errorDetails,
    attachments: readAttachments(node, `${path}.attachments`, diagnostics),
    properties: readProperties(node, `${path}.properties`, diagnostics)
  };
  if (node.attributes.classname !== undefined) testCase.classname = node.attributes.classname;
  if (node.attributes.file !== undefined) testCase.file = node.attributes.file;
  const line = parseOptionalInteger(node.attributes.line);
  if (line !== undefined) testCase.line = line;
  if (durationMs !== undefined) testCase.durationMs = durationMs;
  if (skippedNode) testCase.skippedMessage = skippedNode.attributes.message ?? textOf(skippedNode);
  const stdout = firstText(node, "system-out");
  const stderr = firstText(node, "system-err");
  if (stdout !== undefined) testCase.stdout = stdout;
  if (stderr !== undefined) testCase.stderr = stderr;
  return testCase;
}

function readMessageDetail(node: XmlNode): JunitMessageDetail {
  const detail: JunitMessageDetail = {};
  const message = node.attributes.message;
  const type = node.attributes.type;
  const text = textOf(node);
  if (message !== undefined) detail.message = message;
  if (type !== undefined) detail.type = type;
  if (text.length > 0) detail.text = text;
  return detail;
}

function checkSuiteCounters(
  suite: JunitSuite,
  path: string,
  strictCounters: boolean,
  diagnostics: JunitDiagnostic[]
) {
  const actual = {
    tests: suite.cases.length,
    failures: suite.cases.filter((entry) => entry.status === "failed").length,
    errors: suite.cases.filter((entry) => entry.status === "error").length,
    skipped: suite.cases.filter((entry) => entry.status === "skipped").length
  };

  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    if (suite[key] !== actual[key]) {
      diagnostics.push(
        diagnostic(
          "counter-mismatch",
          strictCounters ? "error" : "warning",
          `Suite counter ${key}=${suite[key]} does not match normalized cases (${actual[key]}).`,
          `${path}.${key}`
        )
      );
    }
  }
}

function checkDeclaredCounters(
  node: XmlNode,
  summary: JunitReportSummary,
  path: string,
  strictCounters: boolean,
  diagnostics: JunitDiagnostic[]
) {
  const declared = {
    tests: parseOptionalInteger(node.attributes.tests),
    failures: parseOptionalInteger(node.attributes.failures),
    errors: parseOptionalInteger(node.attributes.errors),
    skipped: parseOptionalInteger(node.attributes.skipped)
  };

  for (const key of Object.keys(declared) as Array<keyof typeof declared>) {
    const value = declared[key];
    if (value !== undefined && value !== summary[key]) {
      diagnostics.push(
        diagnostic(
          "counter-mismatch",
          strictCounters ? "error" : "warning",
          `Root counter ${key}=${value} does not match normalized cases (${summary[key]}).`,
          `${path}.${key}`
        )
      );
    }
  }
}

function summarizeSuites(suites: JunitSuite[]): JunitReportSummary {
  const summary = suites.reduce(
    (accumulator, suite) => {
      accumulator.suites += 1;
      accumulator.tests += suite.cases.length;
      accumulator.failures += suite.cases.filter((entry) => entry.status === "failed").length;
      accumulator.errors += suite.cases.filter((entry) => entry.status === "error").length;
      accumulator.skipped += suite.cases.filter((entry) => entry.status === "skipped").length;
      accumulator.durationMs += suite.durationMs ?? suite.cases.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
      return accumulator;
    },
    { suites: 0, tests: 0, passed: 0, failures: 0, errors: 0, skipped: 0, durationMs: 0 }
  );
  summary.passed = summary.tests - summary.failures - summary.errors - summary.skipped;
  return summary;
}

function readProperties(node: XmlNode, path: string, diagnostics: JunitDiagnostic[]): JunitProperty[] {
  const seen = new Set<string>();
  const properties = directChildren(node, "properties").flatMap((propertiesNode) =>
    directChildren(propertiesNode, "property").map((property) => {
      const name = property.attributes.name ?? "";
      if (name && seen.has(name)) {
        diagnostics.push(diagnostic("duplicate-property", "warning", `Duplicate property "${name}".`, path));
      }
      if (name) seen.add(name);
      return { name, value: property.attributes.value ?? textOf(property) };
    })
  );
  return properties;
}

function readAttachments(node: XmlNode, path: string, diagnostics: JunitDiagnostic[]): JunitAttachment[] {
  const attachments: JunitAttachment[] = [];

  for (const attachment of directChildren(node, "attachment")) {
    const item: JunitAttachment = { source: "attachment-element" };
    if (attachment.attributes.path !== undefined) item.path = attachment.attributes.path;
    if (attachment.attributes.file !== undefined) item.path = attachment.attributes.file;
    if (attachment.attributes.url !== undefined) item.url = attachment.attributes.url;
    if (!item.path && !item.url && textOf(attachment)) item.path = textOf(attachment);
    attachments.push(item);
  }

  if (node.attributes.file) attachments.push({ source: "file-attribute", path: node.attributes.file });
  if (node.attributes.url) attachments.push({ source: "url-attribute", url: node.attributes.url });

  for (const output of [firstText(node, "system-out"), firstText(node, "system-err")]) {
    if (!output) continue;
    for (const match of output.matchAll(/\[\[ATTACHMENT\|([^\]\r\n]+)\]\]/g)) {
      const path = match[1]?.trim();
      if (path) attachments.push({ source: "stdout-marker", path });
    }
  }

  if (attachments.length > 0) {
    diagnostics.push(
      diagnostic(
        "attachment-metadata",
        "info",
        `Found ${attachments.length} attachment metadata entr${attachments.length === 1 ? "y" : "ies"}.`,
        path
      )
    );
  }

  return attachments;
}

function parseXml(input: string, preserveWhitespace: boolean, diagnostics: JunitDiagnostic[]): XmlNode | undefined {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let cursor = 0;

  while (cursor < input.length) {
    const tokenStart = input.indexOf("<", cursor);
    if (tokenStart === -1) {
      appendText(input.slice(cursor), stack, preserveWhitespace, diagnostics);
      break;
    }

    appendText(input.slice(cursor, tokenStart), stack, preserveWhitespace, diagnostics);

    if (input.startsWith("<!--", tokenStart)) {
      const end = input.indexOf("-->", tokenStart + 4);
      if (end === -1) {
        diagnostics.push(diagnostic("invalid-xml", "error", "Unclosed XML comment.", "$"));
        return undefined;
      }
      cursor = end + 3;
      continue;
    }

    if (input.startsWith("<![CDATA[", tokenStart)) {
      const end = input.indexOf("]]>", tokenStart + 9);
      if (end === -1) {
        diagnostics.push(diagnostic("invalid-xml", "error", "Unclosed CDATA section.", "$"));
        return undefined;
      }
      const current = stack.at(-1);
      if (current) current.text += normalizeText(input.slice(tokenStart + 9, end), preserveWhitespace);
      cursor = end + 3;
      continue;
    }

    const tokenEnd = findTagEnd(input, tokenStart);
    if (tokenEnd === -1) {
      diagnostics.push(diagnostic("invalid-xml", "error", "Unclosed XML tag.", "$"));
      return undefined;
    }

    const token = input.slice(tokenStart, tokenEnd + 1);
    cursor = tokenEnd + 1;

    if (token.startsWith("<?")) continue;
    if (token.startsWith("<!")) {
      diagnostics.push(
        diagnostic(
          "unsupported-xml-construct",
          "warning",
          "Ignored an XML declaration construct that is outside the JUnit report model.",
          "$"
        )
      );
      continue;
    }

    if (token.startsWith("</")) {
      const rawName = token.slice(2, -1).trim();
      const name = localName(rawName);
      const current = stack.pop();
      if (!current || current.name !== name) {
        diagnostics.push(diagnostic("invalid-xml", "error", `Unexpected closing tag </${rawName}>.`, "$"));
        return undefined;
      }
      continue;
    }

    const selfClosing = token.endsWith("/>");
    const content = token.slice(1, selfClosing ? -2 : -1).trim();
    const spaceIndex = content.search(/\s/);
    const rawName = spaceIndex === -1 ? content : content.slice(0, spaceIndex);
    const name = localName(rawName);
    const attributeSource = spaceIndex === -1 ? "" : content.slice(spaceIndex + 1);
    if (rawName !== name) {
      diagnostics.push(
        diagnostic("namespace-normalized", "info", `Normalized XML name "${rawName}" to "${name}".`, "$")
      );
    }
    const node: XmlNode = { name, rawName, attributes: parseAttributes(attributeSource), children: [], text: "" };
    const parent = stack.at(-1);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else if (!root) {
      root = node;
    } else {
      diagnostics.push(diagnostic("invalid-xml", "error", "Found multiple document roots.", "$"));
      return undefined;
    }
    if (!selfClosing) stack.push(node);
  }

  if (stack.length > 0) {
    const current = stack.at(-1);
    diagnostics.push(diagnostic("invalid-xml", "error", `Unclosed tag <${current?.name ?? "unknown"}>.`, "$"));
    return undefined;
  }

  if (!root) {
    diagnostics.push(diagnostic("invalid-xml", "error", "No XML element found.", "$"));
  }
  return root;
}

function appendText(
  text: string,
  stack: XmlNode[],
  preserveWhitespace: boolean,
  diagnostics: JunitDiagnostic[]
) {
  if (!text) return;
  const current = stack.at(-1);
  if (current) {
    current.text += decodeXml(text, preserveWhitespace);
    return;
  }
  if (text.trim().length > 0) {
    diagnostics.push(diagnostic("invalid-xml", "error", "Found text outside the XML root element.", "$"));
  }
}

function findTagEnd(input: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attributePattern)) {
    const name = match[1];
    if (name) attributes[name] = decodeXml(match[3] ?? match[4] ?? "", true);
  }
  return attributes;
}

function detectDialectHints(root: XmlNode): string[] {
  const hints = new Set<string>();
  const allNodes = flatten(root);
  if (allNodes.some((node) => node.name === "attachment" || node.attributes.file || node.attributes.url)) {
    hints.add("attachments-or-file-metadata");
  }
  if (allNodes.some((node) => node.rawName.includes(":"))) {
    hints.add("namespaced-xml");
  }
  if (allNodes.some((node) => node.parent?.name === "testsuite" && node.name === "testsuite")) {
    hints.add("nested-suites");
  }
  if (allNodes.some((node) => node.name === "property" && node.attributes.name?.startsWith("ci."))) {
    hints.add("ci-properties");
  }
  if (root.name === "testsuite") hints.add("single-suite-root");
  return [...hints];
}

function flatten(node: XmlNode): XmlNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function directChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function collectSuiteNodes(root: XmlNode): XmlNode[] {
  if (root.name === "testsuite") return [root, ...descendantSuites(root)];
  return directChildren(root, "testsuite").flatMap((suite) => [suite, ...descendantSuites(suite)]);
}

function descendantSuites(node: XmlNode): XmlNode[] {
  return directChildren(node, "testsuite").flatMap((suite) => [suite, ...descendantSuites(suite)]);
}

function firstText(node: XmlNode, name: string): string | undefined {
  const child = directChildren(node, name)[0];
  return child ? textOf(child) : undefined;
}

function textOf(node: XmlNode): string {
  return node.text.trim();
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = parseOptionalInteger(value);
  return parsed ?? fallback;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function parseDuration(value: string | undefined, path: string, diagnostics: JunitDiagnostic[]): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    diagnostics.push(diagnostic("invalid-duration", "warning", `Invalid duration "${value}".`, path));
    return undefined;
  }
  return Math.round(parsed * 1000);
}

function decodeXml(value: string, preserveWhitespace: boolean): string {
  const decoded = value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  return normalizeText(decoded, preserveWhitespace);
}

function normalizeText(value: string, preserveWhitespace: boolean): string {
  return preserveWhitespace ? value : value.replace(/\s+/g, " ");
}

function localName(name: string): string {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function diagnostic(
  code: JunitDiagnosticCode,
  severity: JunitDiagnosticSeverity,
  message: string,
  path: string
): JunitDiagnostic {
  return { code, severity, message, path };
}
