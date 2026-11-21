import { describe, expect, it } from 'vitest'
import { patientDraftHashes, validatePatientLocally, validationAuditOutcome, type Mapping, type SourceRow } from '../src/lib/workflow'

const fields: Mapping[] = [
  { source: 'mrn', target: 'identifier', confidence: 1, approved: true },
  { source: 'name', target: 'name', confidence: 1, approved: true },
  { source: 'dob', target: 'birthDate', confidence: 1, approved: true },
  { source: 'gender', target: 'gender', confidence: 1, approved: true },
]
const row: SourceRow = { mrn: 'M-1', name: 'Synthetic Person', dob: '2000-02-29', gender: 'F' }
const codes = (value: SourceRow, mapping = fields) => validatePatientLocally(value, mapping).map(issue => issue.code)

describe('local Patient draft validation', () => {
  it('accepts a valid synthetic Patient', () => expect(codes(row)).toEqual([]))
  it('blocks a missing Patient name', () => expect(codes({ ...row, name: '' })).toContain('PATIENT_NAME_REQUIRED'))
  it('warns when source identifier is missing', () => expect(codes({ ...row, mrn: '' })).toContain('SOURCE_IDENTIFIER_MISSING'))
  it('rejects impossible calendar dates', () => expect(codes({ ...row, dob: '2025-02-29' })).toContain('BIRTH_DATE_INVALID'))
  it('rejects future dates', () => expect(codes({ ...row, dob: '2999-01-01' })).toContain('BIRTH_DATE_FUTURE'))
  it('rejects invalid administrative gender', () => expect(codes({ ...row, gender: 'nonbinary' })).toContain('GENDER_INVALID'))
  it('maps validation statuses to audit_logs outcomes accepted by the database', () => {
    expect(validationAuditOutcome('passed')).toBe('success')
    expect(validationAuditOutcome('warning')).toBe('blocked')
    expect(validationAuditOutcome('failed')).toBe('failure')
  })
  it('invalidates the old validation hash when source data changes', async () => {
    const prior = await patientDraftHashes(row, fields)
    const changed = await patientDraftHashes({ ...row, name: 'Changed Person' }, fields)
    expect(changed.payloadHash).not.toBe(prior.payloadHash)
    expect(changed.inputHash).not.toBe(prior.inputHash)
  })
  it('invalidates the old validation hash when mappings change', async () => {
    const prior = await patientDraftHashes(row, fields)
    const changed = fields.map(field => field.target === 'name' ? { ...field, source: 'other' } : field)
    const next = await patientDraftHashes({ ...row, other: 'Mapped Person' }, changed)
    expect(next.payloadHash).not.toBe(prior.payloadHash)
    expect(next.inputHash).not.toBe(prior.inputHash)
  })
})


describe('source row correction overlay', () => {
  const identity = {
    tenantId: 'tenant-A',
    importId: 'import-1',
    importRowId: 'row-1',
    rowNumber: 1,
  }

  const correction = (
    overrides: Partial<import('../src/lib/workflow').SourceRowCorrection> = {}
  ): import('../src/lib/workflow').SourceRowCorrection => ({
    id: 'correction-1',
    tenant_id: identity.tenantId,
    import_id: identity.importId,
    import_row_id: identity.importRowId,
    row_number: identity.rowNumber,
    source_field: 'dob',
    original_value: '2000-02-29',
    corrected_value: '2000-03-01',
    created_at: '2026-11-17T08:00:00.000Z',
    ...overrides,
  })

  it('returns the original row unchanged when there are no corrections', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    const restored = applySourceRowCorrections(row, identity, [], 'dob')
    expect(restored).toEqual(row)
    expect(restored).not.toBe(row)
  })

  it('applies a single correction without mutating original data', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    const original = { ...row }
    const restored = applySourceRowCorrections(
      original, identity, [correction()], 'dob'
    )
    expect(restored.dob).toBe('2000-03-01')
    expect(original.dob).toBe('2000-02-29')
  })

  it('applies multiple corrections in chronological order', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    const corrections = [
      correction({
        id: 'correction-2',
        original_value: '2000-03-01',
        corrected_value: '2000-03-02',
        created_at: '2026-11-17T09:00:00.000Z',
      }),
      correction(),
    ]
    const restored = applySourceRowCorrections(row, identity, corrections, 'dob')
    expect(restored.dob).toBe('2000-03-02')
  })

  it('rejects corrections belonging to another tenant', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    expect(() => applySourceRowCorrections(
      row, identity, [correction({ tenant_id: 'tenant-B' })], 'dob'
    )).toThrow(/does not belong/)
  })

  it('rejects corrections belonging to another import or row', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    expect(() => applySourceRowCorrections(
      row, identity, [correction({ import_id: 'import-2' })], 'dob'
    )).toThrow(/does not belong/)

    expect(() => applySourceRowCorrections(
      row, identity, [correction({ import_row_id: 'row-2' })], 'dob'
    )).toThrow(/does not belong/)
  })

  it('rejects unsupported source fields', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    expect(() => applySourceRowCorrections(
      row, identity, [correction({ source_field: 'name' })], 'dob'
    )).toThrow(/Unsupported source correction field/)
  })

  it('rejects inconsistent correction history', async () => {
    const { applySourceRowCorrections } = await import('../src/lib/workflow')
    expect(() => applySourceRowCorrections(
      row, identity, [correction({ original_value: '1999-01-01' })], 'dob'
    )).toThrow(/history is inconsistent/)
  })
})
