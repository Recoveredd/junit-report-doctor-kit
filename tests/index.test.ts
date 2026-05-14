import { describe, expect, it } from "vitest";
import { createJunitXmlInspector, inspectJunitXml, parseJunitXml } from "../src/index.js";

const simpleReport = `<?xml version="1.0"?>
<testsuites tests="3" failures="1" errors="0" skipped="1" time="1.5">
  <testsuite name="unit" tests="3" failures="1" errors="0" skipped="1" time="1.5">
    <properties>
      <property name="ci.provider" value="synthetic" />
    </properties>
    <testcase classname="math.add" name="adds numbers" time="0.1" />
    <testcase classname="math.subtract" name="subtracts numbers" time="0.2">
      <failure message="expected 1">details &amp; diff</failure>
      <system-out>case stdout</system-out>
    </testcase>
    <testcase classname="math.divide" name="skips zero" time="0">
      <skipped message="not implemented" />
    </testcase>
    <system-out>suite stdout</system-out>
  </testsuite>
</testsuites>`;

describe("inspectJunitXml", () => {
  it("normalizes a testsuites report into suites, cases and summary", () => {
    const result = inspectJunitXml(simpleReport);

    expect(result.ok).toBe(true);
    expect(result.report?.summary).toEqual({
      suites: 1,
      tests: 3,
      passed: 1,
      failures: 1,
      errors: 0,
      skipped: 1,
      durationMs: 1500
    });
    expect(result.report?.suites[0]?.cases[1]).toMatchObject({
      name: "subtracts numbers",
      status: "failed",
      durationMs: 200,
      failureMessages: ["expected 1"],
      stdout: "case stdout"
    });
  });

  it("accepts a single testsuite root", () => {
    const report = parseJunitXml(`<testsuite name="one"><testcase name="ok" time="0.003"/></testsuite>`);

    expect(report.root).toBe("testsuite");
    expect(report.dialectHints).toContain("single-suite-root");
    expect(report.summary.tests).toBe(1);
    expect(report.summary.durationMs).toBe(3);
  });

  it("returns stable diagnostics for invalid input and unsupported XML", () => {
    expect(inspectJunitXml(null).diagnostics[0]?.code).toBe("invalid-input");
    expect(inspectJunitXml("").diagnostics[0]?.code).toBe("empty-input");

    const result = inspectJunitXml("<coverage></coverage>");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("unsupported-root");
  });

  it("diagnoses counter mismatches without failing unless strict mode is enabled", () => {
    const xml = `<testsuite name="mismatch" tests="2" failures="0"><testcase name="ok"/></testsuite>`;
    const relaxed = inspectJunitXml(xml);
    const strict = inspectJunitXml(xml, { strictCounters: true });

    expect(relaxed.ok).toBe(true);
    expect(relaxed.diagnostics[0]).toMatchObject({ code: "counter-mismatch", severity: "warning" });
    expect(strict.ok).toBe(false);
    expect(strict.diagnostics[0]).toMatchObject({ code: "counter-mismatch", severity: "error" });
  });

  it("diagnoses missing testcase names and invalid durations", () => {
    const result = inspectJunitXml(`<testsuite name="bad"><testcase time="-1"/></testsuite>`);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["missing-testcase-name", "invalid-duration"])
    );
  });

  it("preserves special characters decoded from XML entities", () => {
    const report = parseJunitXml(
      `<testsuite name="chars"><testcase name="quote &amp; amp"><failure>1 &lt; 2 &amp; 3 &gt; 2</failure></testcase></testsuite>`
    );

    expect(report.suites[0]?.cases[0]?.name).toBe("quote & amp");
    expect(report.suites[0]?.cases[0]?.failureMessages).toEqual(["1 < 2 & 3 > 2"]);
  });

  it("keeps CDATA details and separates failure messages from text details", () => {
    const report = parseJunitXml(`<testsuite name="details">
      <testcase name="fails">
        <failure type="AssertionError" message="expected true"><![CDATA[
          stack line 1
          value <false>
        ]]></failure>
      </testcase>
    </testsuite>`);

    expect(report.suites[0]?.cases[0]?.failureMessages).toEqual(["expected true"]);
    expect(report.suites[0]?.cases[0]?.failureDetails[0]).toMatchObject({
      message: "expected true",
      type: "AssertionError",
      text: "stack line 1 value <false>"
    });
  });

  it("normalizes namespaced XML names and records a dialect hint", () => {
    const result = inspectJunitXml(
      `<j:testsuite xmlns:j="urn:junit" name="namespaced"><j:testcase name="ok"/></j:testsuite>`
    );

    expect(result.ok).toBe(true);
    expect(result.report?.root).toBe("testsuite");
    expect(result.report?.dialectHints).toContain("namespaced-xml");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("namespace-normalized");
  });

  it("flattens nested suites without duplicating cases", () => {
    const result = inspectJunitXml(`<testsuite name="parent">
      <testcase name="root-case"/>
      <testsuite name="child"><testcase name="child-case"/></testsuite>
    </testsuite>`);

    expect(result.ok).toBe(true);
    expect(result.report?.dialectHints).toContain("nested-suites");
    expect(result.report?.summary).toMatchObject({ suites: 2, tests: 2, passed: 2 });
    expect(result.report?.suites.map((suite) => suite.name)).toEqual(["parent", "child"]);
  });

  it("reports duplicate properties and root-level stdout as non-fatal diagnostics", () => {
    const result = inspectJunitXml(`<testsuites>
      <testsuite name="props">
        <properties>
          <property name="env" value="ci"/>
          <property name="env" value="local"/>
        </properties>
        <testcase name="ok"/>
      </testsuite>
      <system-out>root output</system-out>
    </testsuites>`);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["duplicate-property", "stdout-at-root"])
    );
  });

  it("checks root counters and extracts attachment metadata", () => {
    const result = inspectJunitXml(`<testsuites tests="3" failures="0">
      <testsuite name="attachments" tests="1">
        <testcase name="ok" file="screenshots/ok.png">
          <system-out>[[ATTACHMENT|screenshots/ok.png]]</system-out>
          <attachment url="https://example.test/artifact.txt"/>
        </testcase>
      </testsuite>
    </testsuites>`);

    expect(result.ok).toBe(true);
    expect(result.report?.dialectHints).toContain("attachments-or-file-metadata");
    expect(result.report?.suites[0]?.cases[0]?.attachments).toEqual(
      expect.arrayContaining([
        { source: "file-attribute", path: "screenshots/ok.png" },
        { source: "stdout-marker", path: "screenshots/ok.png" },
        { source: "attachment-element", url: "https://example.test/artifact.txt" }
      ])
    );
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["attachment-metadata", "counter-mismatch"])
    );
  });

  it("creates a reusable inspector with default strict options", () => {
    const inspector = createJunitXmlInspector({ strictCounters: true });

    expect(inspector.inspect(`<testsuite name="mismatch" tests="2"><testcase name="ok"/></testsuite>`).ok).toBe(false);
  });
});
