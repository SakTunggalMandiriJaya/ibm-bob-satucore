import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(join(process.cwd(), "supabase", "migrations", "20261128173000_phase4b_facility_level_authorization.sql"), "utf8");
const submit = readFileSync(join(process.cwd(), "supabase", "functions", "satusehat-patient-submit", "index.ts"), "utf8");

describe("Phase 4B facility-level authorization", () => {
  it("supports multiple facility assignments per user and revocation", () => {
    expect(migration).toMatch(/unique \(tenant_id, user_id, organization_id\)/i);
    expect(migration).toContain("status in ('active','inactive','revoked')");
    expect(migration).toContain("organization_members_user_scope_idx");
  });

  it("allows tenant-wide access only to active tenant administrators", () => {
    expect(migration).toMatch(/tm\.role = 'tenant_admin'/);
    expect(migration).toMatch(/tm\.status = 'active'/);
    expect(migration).toMatch(/om\.status = 'active'/);
    expect(migration).toMatch(/om\.user_id = auth\.uid\(\)/);
  });

  it("validates tenant and Organization consistency for every assignment", () => {
    expect(migration).toContain("Organization membership must reference an Organization in the same tenant");
    expect(migration).toContain("Organization assignment requires an active tenant membership");
  });

  it("adds restrictive row-level policies without widening existing role policies", () => {
    expect(migration).toMatch(/as restrictive for all to authenticated/i);
    expect(migration).toContain("private.can_access_row(tenant_id");
    expect(migration).toContain("'patient_correction_requests'");
    expect(migration).toContain("'submission_approvals'");
  });

  it("derives facility scope through import, Patient, encounter and FHIR relationships", () => {
    for (const table of ["field_mappings", "import_rows", "patient_drafts", "patient_draft_validation_reports", "patient_identifiers", "patient_identity_matches", "patient_draft_revisions", "mapping_approvals", "validation_results"]) {
      expect(migration).toContain(`p_table_name = '${table}'`);
    }
  });

  it("preserves the Phase 4A validated Patient draft and payload lineage gates", () => {
    expect(migration).toMatch(/v_report\.input_hash IS DISTINCT FROM v_draft\.input_hash/i);
    expect(migration).toMatch(/p_fhir_patient IS DISTINCT FROM v_draft\.fhir_patient/i);
    expect(migration).toMatch(/p_canonical IS DISTINCT FROM v_draft\.canonical_patient/i);
    expect(migration).toMatch(/private\.can_access_organization\(p_tenant_id, p_organization_id\)/i);
  });

  it("scopes SEND requester and approver to the Patient's facility", () => {
    expect(submit).toContain("organization_members");
    expect(submit).toContain("User is not assigned to the Patient's facility");
    expect(submit).toContain("Approver is not assigned to the Patient's facility");
    expect(submit).toContain('.eq("organization_id",patient.organization_id)');
    expect(submit).toContain("Sandbox connection Organization does not match the Patient's owning facility");
  });
});
