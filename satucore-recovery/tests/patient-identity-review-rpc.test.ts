import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Patient identity-review request persistence', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/workflow.ts'), 'utf8')
  const start = source.indexOf('export async function createPatientIdentityReviewRequest(')
  const end = source.indexOf('export async function writeAudit', start)
  const implementation = source.slice(start, end)

  it('uses the authorized database RPC', () => {
    expect(implementation).toContain("db.rpc('create_patient_identity_review_request'")
    expect(implementation).toContain('p_tenant_id: w.tenantId')
    expect(implementation).toContain('p_organization_id: w.organizationId')
    expect(implementation).toContain('p_row_number: rowNumber')
    expect(implementation).toContain('p_candidate_patient_id: candidatePatientId')
  })

  it('does not attempt a direct insert into the protected request table', () => {
    expect(implementation).not.toMatch(/from\(['"]patient_identity_review_requests['"]\)[\s\S]*?\.insert\(/)
  })

  it('requires a returned request ID and preserves idempotent existing status', () => {
    expect(implementation).toContain('if (!result?.request_id)')
    expect(implementation).toContain('existing: Boolean(result.existing)')
  })
})
