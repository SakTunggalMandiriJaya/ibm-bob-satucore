import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Patient SCAN to identity-review integration', () => {
  const workflow = readFileSync(resolve(process.cwd(), 'src/lib/workflow.ts'), 'utf8')
  const queue = readFileSync(resolve(process.cwd(), 'src/components/PatientIdentityReviewQueue.tsx'), 'utf8')

  it('runs the authoritative duplicate scanner after source rows are persisted', () => {
    const rowsInsert = workflow.indexOf("db.from('import_rows').insert(batch)")
    const scanner = workflow.indexOf("'scan_import_patient_duplicates'")
    expect(rowsInsert).toBeGreaterThan(-1)
    expect(scanner).toBeGreaterThan(rowsInsert)
    expect(workflow).toContain('p_import_id: importId')
    expect(workflow).toContain('Patient identity SCAN failed')
  })

  it('records scanner counts in the tenant audit trail', () => {
    expect(workflow).toContain("'patient_duplicate_scan_completed'")
    expect(workflow).toContain('exact_identifier_count: scanResult.exact_identifier_count')
    expect(workflow).toContain('possible_name_count: scanResult.possible_name_count')
  })

  it('loads findings only within the active tenant, Organization and import', () => {
    expect(queue).toContain(".from('identity_duplicate_findings')")
    expect(queue).toContain('.eq(\'tenant_id\', workspace.tenantId)')
    expect(queue).toContain('.eq(\'organization_id\', workspace.organizationId)')
    expect(queue).toContain('.eq(\'import_id\', importId)')
  })

  it('supports an authorized manual rescan of an existing import', () => {
    expect(queue).toContain("'scan_import_patient_duplicates'")
    expect(queue).toContain('Run duplicate SCAN')
    expect(queue).toContain('Only a clinic administrator or data manager can run the authoritative duplicate scan.')
  })

  it('creates review requests through the authorized RPC, never a direct table insert', () => {
    expect(queue).toContain("supabase.rpc('create_patient_identity_review_request'")
    expect(queue).not.toMatch(/from\(['"]patient_identity_review_requests['"]\)[\s\S]*?\.insert\(/)
  })

  it('does not treat detected matches as automatic identity decisions', () => {
    expect(queue).toContain('no automatic merge or identity decision')
    expect(queue).toContain('finding remains visible and unresolved')
  })
})
