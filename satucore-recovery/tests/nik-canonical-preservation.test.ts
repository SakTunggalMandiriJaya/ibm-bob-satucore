import { describe, expect, it } from 'vitest'
import { normalizePatient, type Mapping, type SourceRow } from '../src/lib/workflow'

describe('Canonical NIK preservation', () => {
  const row: SourceRow = {
    patient_no: 'MRN-TEST-001',
    nik: '0000000000000008',
    patient_name: 'SYNTHETIC TEST PATIENT',
    dob: '1990-09-21',
    sex: 'female'
  }

  const mappings: Mapping[] = [
    { source: 'patient_no', target: 'identifier', confidence: 0.96, approved: true },
    { source: 'nik', target: 'national_identifier', confidence: 0.99, approved: true },
    { source: 'patient_name', target: 'name', confidence: 0.98, approved: true },
    { source: 'dob', target: 'birthDate', confidence: 0.98, approved: true },
    { source: 'sex', target: 'gender', confidence: 0.97, approved: true }
  ]

  it('preserves NIK as a separate unverified canonical source identifier', () => {
    const { canonical, fhir, issues } = normalizePatient(row, mappings)

    expect(canonical.source_identifiers).toContainEqual({
      system: 'urn:satucore:source-nik',
      value: '0000000000000008'
    })
    expect(issues.some(issue => issue.code === 'SOURCE_NIK_INVALID_FORMAT')).toBe(false)
    expect(JSON.stringify(fhir)).not.toContain('0000000000000008')
    expect(fhir.identifier).toEqual([
      expect.objectContaining({
        system: 'urn:satucore:source-mrn',
        value: 'MRN-TEST-001'
      })
    ])
  })

  it('does not preserve NIK when its mapping has not been approved', () => {
    const unapproved = mappings.map(mapping =>
      mapping.target === 'national_identifier'
        ? { ...mapping, approved: false }
        : mapping
    )
    const { canonical } = normalizePatient(row, unapproved)

    expect(canonical.source_identifiers).not.toContainEqual(
      expect.objectContaining({ system: 'urn:satucore:source-nik' })
    )
  })

  it('flags a mapped NIK that is not exactly 16 digits', () => {
    const invalidRow = { ...row, nik: '12345' }
    const { issues } = normalizePatient(invalidRow, mappings)

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_NIK_INVALID_FORMAT',
        severity: 'error'
      })
    )
  })

  it('preserves leading zeros in canonical NIK', () => {
    const { canonical } = normalizePatient(row, mappings)
    const nik = canonical.source_identifiers.find(
      identifier => identifier.system === 'urn:satucore:source-nik'
    )

    expect(nik?.value).toBe('0000000000000008')
  })
})
