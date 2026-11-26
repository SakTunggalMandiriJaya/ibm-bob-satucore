import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P1.3 Patient submission reconciliation safeguards", () => {
  const sourcePath = join(
    process.cwd(),
    "supabase",
    "functions",
    "satusehat-patient-submit",
    "index.ts"
  );

  const source = readFileSync(sourcePath, "utf8");

  it("captures confirmed SATUSEHAT Patient response before local persistence", () => {
    const capture = source.indexOf("confirmedPatientId=responseBody.id");
    const finishSuccess = source.indexOf('await finish("succeeded"');
    const resourceUpdate = source.indexOf('admin.from("fhir_resources").update');

    expect(capture).toBeGreaterThan(-1);
    expect(finishSuccess).toBeGreaterThan(capture);
    expect(resourceUpdate).toBeGreaterThan(finishSuccess);
    expect(source).toContain("confirmedResponseStatus=response.status");
    expect(source).toContain("confirmedResponseBody=minimized");
  });

  it("persists reconciliation status and confirmed Patient reference", () => {
    expect(source).toMatch(/transaction_status:"reconciliation_required"/);
    expect(source).toMatch(/request_reference:confirmedPatientId/);
    expect(source).toMatch(/response_status:confirmedResponseStatus/);
    expect(source).toMatch(/response_body:confirmedResponseBody/);
    expect(source).toMatch(/post_submission_persistence_failure/);
  });

  it("reconciliation helper safely returns false on recovery-write failure", () => {
    const helperStart = source.indexOf("const markReconciliation=async()=>");
    const helperEnd = source.indexOf("\n  try {", helperStart);
    const helper = source.slice(helperStart, helperEnd);

    expect(helper).toContain("return false;");
    expect(helper).not.toContain("await markReconciliation()");
    expect(helper).toContain("catch");
  });

  it("captures confirmed Patient ID before marking the transaction succeeded", () => {
    const capture = source.indexOf("confirmedPatientId=responseBody.id");
    const success = source.indexOf('await finish("succeeded"');

    expect(capture).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(capture);
  });

  it("routes post-submission persistence errors to reconciliation", () => {
    const persistenceFailure = source.indexOf(
      "if(resourceUpdateError || connectionUpdateError || auditError)"
    );
    const recovery = source.indexOf("await markReconciliation()", persistenceFailure);
    const response = source.indexOf('stage:"reconciliation_required"', persistenceFailure);

    expect(persistenceFailure).toBeGreaterThan(-1);
    expect(recovery).toBeGreaterThan(persistenceFailure);
    expect(response).toBeGreaterThan(recovery);
    expect(source).toContain("satusehat_created:true");
  });

  it("handles confirmed creation in outer catch before unknown-network handling", () => {
    const outerCatch = source.lastIndexOf("} catch {");
    const confirmedBranch = source.indexOf("if(confirmedPatientId)", outerCatch);
    const unknownOutcome = source.indexOf('await finish("retry_pending"', outerCatch);

    expect(outerCatch).toBeGreaterThan(-1);
    expect(confirmedBranch).toBeGreaterThan(outerCatch);
    expect(unknownOutcome).toBeGreaterThan(confirmedBranch);
    expect(source).toContain("stage:\"reconciliation_required\"");
  });

  it("does not automatically retry when the network outcome is unknown", () => {
    expect(source).toContain('await finish("retry_pending"');
    expect(source).toContain("network_outcome_unknown");
    expect(source).toMatch(/Check SATUSEHAT before any retry/i);
  });
});