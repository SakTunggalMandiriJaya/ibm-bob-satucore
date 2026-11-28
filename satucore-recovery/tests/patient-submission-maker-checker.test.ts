import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261128170000_phase4a_strict_maker_checker.sql"
), "utf8");

const submit = readFileSync(join(
  process.cwd(),
  "supabase",
  "functions",
  "satusehat-patient-submit",
  "index.ts"
), "utf8");

describe("Phase 4A strict maker-checker separation", () => {
  it("allows only tenant admins, clinic admins and reviewers to approve", () => {
    expect(migration).toMatch(/array\['tenant_admin','clinic_admin','reviewer'\]::text\[\]/);
    expect(migration).not.toMatch(/array\['tenant_admin','clinic_admin','reviewer','submitter'\]::text\[\]/);
  });

  it("keeps submitter out of approval insert and update policies", () => {
    expect(migration).toMatch(/create policy role_insert[\s\S]*?array\['tenant_admin','clinic_admin','reviewer'\]::text\[\]/i);
    expect(migration).toMatch(/create policy role_update[\s\S]*?array\['tenant_admin','clinic_admin'\]::text\[\]/i);
    expect(migration).not.toMatch(/role_(?:insert|update)[\s\S]*?submitter/i);
  });

  it("preserves creator-versus-approver separation", () => {
    expect(migration).toMatch(/v_resource_creator = new\.approved_by/);
  });

  it("preserves exact FHIR payload hash binding", () => {
    expect(migration).toMatch(/new\.approved_payload_hash := v_payload_hash/);
  });

  it("allows submitters to initiate SEND but not approve", () => {
    expect(submit).toMatch(/\["tenant_admin","clinic_admin","data_manager","submitter"\]\.includes\(member\.role\)/);
    expect(submit).toMatch(/\["tenant_admin","clinic_admin","reviewer"\]\.includes\(approver\.role\)/);
  });
});
