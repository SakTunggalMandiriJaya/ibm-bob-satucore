import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261120120000_bind_patient_creation_to_validated_draft.sql"
), "utf8");

describe("Phase 4A server-side Patient validation gate", () => {
  it("requires the persisted Patient draft to be validated", () => {
    expect(sql).toMatch(/v_draft\.status is distinct from 'validated'/i);
    expect(sql).toMatch(/v_draft\.validated_at is null/i);
  });

  it("binds the draft to the exact tenant, import, source row and validation report", () => {
    expect(sql).toMatch(/v_draft\.validation_report_id is distinct from p_validation_report_id/i);
    expect(sql).toMatch(/r\.tenant_id = p_tenant_id[\s\S]*?r\.import_id = p_import_id[\s\S]*?r\.import_row_id = p_import_row_id/i);
  });

  it("requires a passing report and records partial local conformance honestly", () => {
    expect(sql).toMatch(/r\.outcome = 'passed'/i);
    expect(sql).toContain("satucore-patient-local");
    expect(sql).toContain("satusehat_profile_not_executed");
  });

  it("binds report input, payload and approved mapping hashes to the draft", () => {
    expect(sql).toMatch(/v_report\.payload_hash is distinct from v_draft\.payload_hash/i);
    expect(sql).toMatch(/v_report\.input_hash is distinct from v_draft\.input_hash/i);
    expect(sql).toMatch(/v_report\.approved_mappings is distinct from v_draft\.mapping_snapshot/i);
  });

  it("rejects substituted canonical and FHIR payloads", () => {
    expect(sql).toMatch(/p_fhir_patient is distinct from v_draft\.fhir_patient/i);
    expect(sql).toMatch(/p_canonical is distinct from v_draft\.canonical_patient/i);
    expect(sql).toMatch(/p_fhir_payload_hash is distinct from v_draft\.payload_hash/i);
  });

  it("rejects caller-substituted issues and any non-empty issue set", () => {
    expect(sql).toMatch(/p_issues is distinct from v_report\.issues/i);
    expect(sql).toMatch(/jsonb_array_length\(v_report\.issues\) <> 0/i);
  });

  it("performs all validation integrity checks before canonical Patient insertion", () => {
    const gate = sql.indexOf("p_issues IS DISTINCT FROM v_report.issues");
    const insert = sql.indexOf("INSERT INTO public.patients(");
    expect(gate).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(insert);
  });

  it("preserves tenant authorization and unresolved identity-review blocking", () => {
    expect(sql).toMatch(/private\.has_tenant_role/i);
    expect(sql).toMatch(/r\.decision = 'pending'/i);
  });
});
