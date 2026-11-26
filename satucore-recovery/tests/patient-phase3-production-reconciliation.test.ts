import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('SATUCORE Phase 3 production reconciliation migration', () => {
  const migrationPath = join(
    process.cwd(),
    'supabase',
    'migrations',
    '20261122080000_reconcile_patient_phase3_workflows.sql'
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('is a single atomic migration and does not contain external submission calls', () => {
    expect(sql.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/i);
    expect(sql.trimEnd()).toMatch(/COMMIT;\s*$/i);
    expect(sql).not.toMatch(/\bfetch\s*\(|net\.http_post/i);
  });

  it('supports only pending-to-decision and approved-to-applied correction transitions', () => {
    expect(sql).toMatch(/old\.status = 'pending'/i);
    expect(sql).toMatch(/new\.status not in \('approved', 'rejected'\)/i);
    expect(sql).toMatch(/old\.status = 'approved'/i);
    expect(sql).toMatch(/new\.resulting_fhir_resource_id is null/i);
  });

  it('keeps correction evidence immutable and checks tenant roles', () => {
    expect(sql).toMatch(/Correction request evidence is immutable/i);
    expect(sql).toMatch(/private\.has_tenant_role/i);
    expect(sql).toMatch(/array\['tenant_admin', 'clinic_admin', 'reviewer'\]/i);
    expect(sql).toMatch(/array\['tenant_admin', 'clinic_admin', 'data_manager'\]/i);
  });

  it('provides atomic human review and application RPCs', () => {
    expect(sql).toMatch(/function public\.review_patient_correction_request/i);
    expect(sql).toMatch(/function public\.apply_approved_patient_name_correction/i);
    expect(sql).toMatch(/get diagnostics v_updated_count = row_count/i);
    expect(sql).toMatch(/revoke update on table public\.patient_correction_requests/i);
  });

  it('requires the persisted validated Patient Draft and exact report lineage', () => {
    expect(sql).toMatch(/from public\.patient_drafts d[\s\S]*?for update/i);
    expect(sql).toMatch(/v_draft\.status is distinct from 'validated'/i);
    expect(sql).toMatch(/v_draft\.validation_report_id is distinct from p_validation_report_id/i);
    expect(sql).toMatch(/v_report\.payload_hash is distinct from v_draft\.payload_hash/i);
    expect(sql).toMatch(/v_report\.input_hash is distinct from v_draft\.input_hash/i);
    expect(sql).toMatch(/v_report\.approved_mappings is distinct from v_draft\.mapping_snapshot/i);
  });

  it('binds submitted values and validation evidence to the persisted draft', () => {
    expect(sql).toMatch(/p_fhir_patient is distinct from v_draft\.fhir_patient/i);
    expect(sql).toMatch(/p_canonical is distinct from v_draft\.canonical_patient/i);
    expect(sql).toMatch(/p_issues is distinct from v_report\.issues/i);
    expect(sql).toMatch(/jsonb_array_length\(v_report\.issues\) <> 0/i);
  });

  it('declares partial local validation honestly, not SATUSEHAT conformance', () => {
    expect(sql).toMatch(/satucore-patient-local/i);
    expect(sql).toMatch(/fhir_r4_structure_partial;\s*satusehat_profile_not_executed/i);
  });

  it('preserves tenant, identity review, duplicate, MRN and NIK safeguards', () => {
    expect(sql).toMatch(/identity_review/i);
    expect(sql).toMatch(/patient_source_links/i);
    expect(sql).toMatch(/MRN_CONFLICT/i);
    expect(sql).toMatch(/NIK_CONFLICT/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
  });

  it('keeps canonical Patient creation separate from SATUSEHAT transmission', () => {
    expect(sql).toMatch(/create_patient_from_validated_import/i);
    expect(sql).toMatch(/returns jsonb/i);
    expect(sql).not.toMatch(/satusehat-patient-submit|https?:\/\/[^'"\s]*satusehat[^'"\s]*\/Patient/i);
  });
});
