import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P0-1 patient creation integrity migration', () => {
  const migrationPath = join(
    process.cwd(),
    'supabase',
    'migrations',
    '20261118170000_p0_1_bind_patient_creation_to_validated_draft.sql'
  );

  const sql = readFileSync(migrationPath, 'utf8');

  it('locks the persisted Patient draft before creation', () => {
    expect(sql).toMatch(/from public\.patient_drafts[\s\S]*?for update/i);
  });

  it('requires the draft to be validated', () => {
    expect(sql).toMatch(/v_draft\.status is distinct from 'validated'/i);
  });

  it('binds the draft to the exact validation report', () => {
    expect(sql).toMatch(/v_draft\.validation_report_id is distinct from p_validation_report_id/i);
  });

  it('rejects canonical data different from the validated draft', () => {
    expect(sql).toMatch(/v_draft\.canonical_patient is distinct from p_canonical/i);
  });

  it('rejects FHIR data different from the validated draft', () => {
    expect(sql).toMatch(/v_draft\.fhir_patient is distinct from p_fhir_patient/i);
  });

  it('binds draft payload and input hashes to validation evidence', () => {
    expect(sql).toMatch(/v_draft\.payload_hash is distinct from v_report\.payload_hash/i);
    expect(sql).toMatch(/v_draft\.input_hash is distinct from v_report\.input_hash/i);
  });

  it('binds approved mapping snapshot to the validation report', () => {
    expect(sql).toMatch(/v_draft\.mapping_snapshot is distinct from v_report\.approved_mappings/i);
  });

  it('binds submitted FHIR hash to the validated draft', () => {
    expect(sql).toMatch(/p_fhir_payload_hash is distinct from v_draft\.payload_hash/i);
  });

  it('rejects substituted validation issues', () => {
    expect(sql).toMatch(/p_issues is distinct from v_report\.issues/i);
  });

  it('performs integrity checks before inserting a canonical Patient', () => {
    const integrityCheck = sql.indexOf('v_draft.fhir_patient is distinct from p_fhir_patient');
    const patientInsert = sql.indexOf('insert into public.patients(');

    expect(integrityCheck).toBeGreaterThan(-1);
    expect(patientInsert).toBeGreaterThan(-1);
    expect(integrityCheck).toBeLessThan(patientInsert);
  });

  it('preserves tenant role authorization', () => {
    expect(sql).toMatch(/private\.has_tenant_role/i);
    expect(sql).toMatch(/tenant_admin.*clinic_admin.*data_manager/i);
  });

  it('preserves identity-review blocking', () => {
    expect(sql).toMatch(/processing_status = 'identity_review'/i);
    expect(sql).toMatch(/decision = 'pending'/i);
  });

  it('preserves source-row duplicate protection', () => {
    expect(sql).toMatch(/patient_source_links[\s\S]*?already linked to a Patient/i);
  });

  it('preserves MRN conflict protection', () => {
    expect(sql).toMatch(/MRN_CONFLICT/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
  });

  it('preserves authenticated-only RPC execution', () => {
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to authenticated/i);
  });
});
