import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261121130000_atomic_patient_identity_review_requests.sql'
), 'utf8')

const integrityMigration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261116140000_harden_patient_identity_review_integrity.sql'
), 'utf8')

const decisionWrapperMigration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261121140000_wrap_identity_decision_rpc_authorization.sql'
), 'utf8')

const workflow = readFileSync(join(process.cwd(), 'src', 'lib', 'workflow.ts'), 'utf8')

describe('Patient identity-review security migrations', () => {
  it('preserves the existing decision RPC body and changes only its execution security', () => {
    expect(integrityMigration).toMatch(/alter function public\.decide_patient_identity_review\(uuid, text, uuid, text\)\s+security definer/i)
    expect(integrityMigration).not.toMatch(/create or replace function public\.decide_patient_identity_review/i)
  })

  it('installs a database guard and revokes direct authenticated table writes', () => {
    expect(integrityMigration).toMatch(/create trigger trg_guard_patient_identity_review_request/i)
    expect(integrityMigration).toMatch(/revoke insert, update, delete[\s\S]*?from public, anon, authenticated/i)
  })

  it('checks tenant authorization before invoking the preserved decision implementation', () => {
    expect(decisionWrapperMigration).toMatch(/rename to decide_patient_identity_review_internal/i)
    expect(decisionWrapperMigration).toMatch(/tm\.tenant_id = v_tenant_id[\s\S]*?tm\.user_id = v_user_id[\s\S]*?tm\.status = 'active'/i)
    expect(decisionWrapperMigration).toMatch(/return query[\s\S]*?decide_patient_identity_review_internal/i)
    expect(decisionWrapperMigration).toMatch(/revoke all on function public\.decide_patient_identity_review_internal[\s\S]*?from public, anon, authenticated/i)
  })

  it('uses a locked source row to serialize request attempts', () => {
    expect(migration).toMatch(/from public\.import_rows ir[\s\S]*?for update/i)
  })

  it('checks an existing pending request independently of incoming MRN', () => {
    const pendingCheck = migration.slice(migration.indexOf('select r.* into v_pending'), migration.indexOf('if found then', migration.indexOf('select r.* into v_pending')))
    expect(pendingCheck).toMatch(/decision = 'pending'/i)
    expect(pendingCheck).not.toMatch(/incoming_mrn/i)
  })

  it('computes attempt numbers inside the database transaction', () => {
    expect(migration).toMatch(/coalesce\(max\(r\.attempt_number\), 0\) \+ 1/i)
  })

  it('writes the request and its audit event in the same RPC transaction', () => {
    expect(migration).toMatch(/insert into public\.patient_identity_review_requests/i)
    expect(migration).toMatch(/insert into public\.audit_logs/i)
    expect(migration).toMatch(/begin;[\s\S]*commit;/i)
  })

  it('uses the authenticated actor and verifies active tenant role', () => {
    expect(migration).toMatch(/v_user_id uuid := auth\.uid\(\)/i)
    expect(migration).toMatch(/tm\.tenant_id = p_tenant_id[\s\S]*?tm\.user_id = v_user_id[\s\S]*?tm\.status = 'active'/i)
  })

  it('validates tenant, Organization, import and source-row lineage', () => {
    expect(migration).toMatch(/di\.tenant_id = p_tenant_id[\s\S]*?di\.organization_id = p_organization_id/i)
    expect(migration).toMatch(/ir\.tenant_id = p_tenant_id[\s\S]*?ir\.import_id = p_import_id[\s\S]*?ir\.row_number = p_row_number/i)
  })

  it('restricts the RPC to authenticated users', () => {
    expect(migration).toMatch(/revoke all on function public\.create_patient_identity_review_request[\s\S]*?from public, anon/i)
    expect(migration).toMatch(/grant execute on function public\.create_patient_identity_review_request[\s\S]*?to authenticated/i)
  })

  it('routes the frontend through the atomic RPC rather than direct table inserts', () => {
    const fnStart = workflow.indexOf('export async function createPatientIdentityReviewRequest')
    const fnEnd = workflow.indexOf('export async function writeAudit', fnStart)
    const fn = workflow.slice(fnStart, fnEnd)
    expect(fn).toContain("rpc('create_patient_identity_review_request'")
    expect(fn).not.toMatch(/from\('patient_identity_review_requests'\)[\s\S]*?\.insert\(/i)
    expect(fn).not.toContain('auditWarning')
  })
})
