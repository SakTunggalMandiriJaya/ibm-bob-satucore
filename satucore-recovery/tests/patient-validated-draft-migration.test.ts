import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P0 replacement: validated Patient Draft creation migration', () => {
  const migrationPath = join(
    process.cwd(),
    'supabase',
    'migrations',
    '20261120120000_bind_patient_creation_to_validated_draft.sql'
  );

  const sql = readFileSync(migrationPath, 'utf8');

  it('uses SECURITY INVOKER and an empty search path', () => {
    expect(sql).toMatch(/SECURITY INVOKER/i);
    expect(sql).toMatch(/SET search_path TO ''/i);
  });

  it('locks the import, source row and Patient Draft', () => {
    expect((sql.match(/FOR UPDATE/gi) || []).length).toBeGreaterThanOrEqual(3);
    expect(sql).toMatch(/FROM public\.patient_drafts[\s\S]*?FOR UPDATE/i);
  });

  it('requires a validated draft and exact validation report', () => {
    expect(sql).toMatch(/v_draft\.status IS DISTINCT FROM 'validated'/i);
    expect(sql).toMatch(
      /v_draft\.validation_report_id IS DISTINCT FROM p_validation_report_id/i
    );
    expect(sql).toMatch(/v_draft\.validated_at IS NULL/i);
  });

  it('binds the report to tenant, import and source row', () => {
    expect(sql).toMatch(/r\.id = p_validation_report_id/i);
    expect(sql).toMatch(/r\.tenant_id = p_tenant_id/i);
    expect(sql).toMatch(/r\.import_id = p_import_id/i);
    expect(sql).toMatch(/r\.import_row_id = p_import_row_id/i);
  });

  it('requires the expected validator and version', () => {
    expect(sql).toMatch(
      /v_report\.validator IS DISTINCT FROM 'satucore-patient-local'/i
    );
    expect(sql).toMatch(
      /v_report\.validator_version IS DISTINCT FROM '0\.2\.0'/i
    );
  });

  it('declares the exact partial validation scope', () => {
    expect(sql).toMatch(
      /local_deterministic_checks;\s*fhir_r4_structure_partial;\s*satusehat_profile_not_executed/i
    );
  });

  it('requires a passed validation report', () => {
    expect(sql).toMatch(/AND r\.outcome = 'passed'/i);
  });

  it('binds report hashes and approved mappings to the draft', () => {
    expect(sql).toMatch(
      /v_report\.payload_hash IS DISTINCT FROM v_draft\.payload_hash/i
    );
    expect(sql).toMatch(
      /v_report\.input_hash IS DISTINCT FROM v_draft\.input_hash/i
    );
    expect(sql).toMatch(
      /v_report\.approved_mappings IS DISTINCT FROM v_draft\.mapping_snapshot/i
    );
  });

  it('binds submitted FHIR and canonical data to the persisted draft', () => {
    expect(sql).toMatch(
      /p_fhir_payload_hash IS DISTINCT FROM v_draft\.payload_hash/i
    );
    expect(sql).toMatch(
      /p_fhir_patient IS DISTINCT FROM v_draft\.fhir_patient/i
    );
    expect(sql).toMatch(
      /p_canonical IS DISTINCT FROM v_draft\.canonical_patient/i
    );
  });

  it('rejects substituted issues and non-empty report issues', () => {
    expect(sql).toMatch(/p_issues IS DISTINCT FROM v_report\.issues/i);
    expect(sql).toMatch(/jsonb_array_length\(v_report\.issues\) <> 0/i);
  });

  it('copies validator metadata from the report into validation_results', () => {
    expect(sql).toMatch(
      /INSERT INTO public\.validation_results[\s\S]*?v_report\.validator,\s*v_report\.validator_version,\s*v_report\.conformance_scope/i
    );
  });

  it('checks draft integrity before inserting a Patient', () => {
    const integrityCheck = sql.toLowerCase().indexOf('p_fhir_patient is distinct from v_draft.fhir_patient');
    const patientInsert = sql.toLowerCase().indexOf('insert into public.patients(');

    expect(integrityCheck).toBeGreaterThan(-1);
    expect(patientInsert).toBeGreaterThan(-1);
    expect(integrityCheck).toBeLessThan(patientInsert);
  });

  it('preserves tenant role authorization', () => {
    expect(sql).toMatch(/private\.has_tenant_role/i);
    expect(sql).toMatch(/tenant_admin.*clinic_admin.*data_manager/i);
  });

  it('blocks unresolved identity review', () => {
    expect(sql).toMatch(/processing_status = 'identity_review'/i);
    expect(sql).toMatch(/decision = 'pending'/i);
  });

  it('protects against duplicate source-row links', () => {
    expect(sql).toMatch(/FROM public\.patient_source_links/i);
    expect(sql).toMatch(/import_row_id = p_import_row_id/i);
  });

  it('preserves MRN and NIK conflict protection', () => {
    expect(sql).toMatch(/MRN_CONFLICT/i);
    expect(sql).toMatch(/NIK_CONFLICT/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
  });

  it('preserves execution grants and revokes PUBLIC access', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/i);
  });

  it('does not implement SATUSEHAT transmission', () => {
    expect(sql).not.toMatch(
      /https?:\/\/[^'"\s]*satusehat[^'"\s]*|fetch\s*\(|net\.http_post/i
    );
  });
});
