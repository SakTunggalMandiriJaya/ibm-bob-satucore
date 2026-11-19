import { describe, expect, it } from 'vitest'
import { comparePatientIdentities } from '../src/lib/identity-intelligence'

describe('Patient Identity Intelligence', () => {
  const bima = {
    name: 'DEMO PATIENT BIMA',
    birthDate: '1979-11-22',
    gender: 'male',
    city: 'Tangerang',
    mrn: 'DEMO-MRN-102'
  }

  it('flags conflicting demographic evidence without deciding identity', () => {
    const result = comparePatientIdentities({
      incoming: {
        ...bima,
        name: 'DEMO PATIENT HANA',
        birthDate: '1990-09-21',
        gender: 'female'
      },
      candidate: bima,
      mrnVerification: 'unverified'
    })

    expect(result.fields.filter(field => field.status === 'conflict').map(field => field.field))
      .toEqual(['name', 'birthDate', 'gender'])
    expect(result.fields.find(field => field.field === 'mrn')?.status).toBe('unverified')
    expect(result.recommendation).toBe('conflicting_evidence_review_required')
    expect(result.automaticDecision).toBe(false)
  })

  it('does not treat a shared unverified MRN as proof of identity', () => {
    const result = comparePatientIdentities({
      incoming: bima,
      candidate: bima,
      mrnVerification: 'unverified'
    })

    expect(result.fields.find(field => field.field === 'mrn')?.status).toBe('unverified')
    expect(result.recommendation).toBe('additional_evidence_required')
    expect(result.automaticDecision).toBe(false)
  })

  it('recognizes a verified matching MRN but still requires human review', () => {
    const result = comparePatientIdentities({
      incoming: bima,
      candidate: bima,
      mrnVerification: 'verified'
    })

    expect(result.fields.find(field => field.field === 'mrn')?.status).toBe('match')
    expect(result.recommendation).toBe('additional_evidence_required')
    expect(result.automaticDecision).toBe(false)
  })

  it('does not treat missing values as matches', () => {
    const result = comparePatientIdentities({
      incoming: { name: 'DEMO PATIENT BIMA', mrn: 'DEMO-MRN-102' },
      candidate: { name: 'DEMO PATIENT BIMA', mrn: 'DEMO-MRN-102' },
      mrnVerification: 'unverified'
    })

    expect(result.fields.find(field => field.field === 'birthDate')?.status).toBe('missing')
    expect(result.fields.find(field => field.field === 'gender')?.status).toBe('missing')
    expect(result.recommendation).toBe('additional_evidence_required')
  })

  it('normalizes case and repeated whitespace for comparison', () => {
    const result = comparePatientIdentities({
      incoming: { ...bima, name: '  Demo   Patient Bima ' },
      candidate: bima,
      mrnVerification: 'unverified'
    })

    expect(result.fields.find(field => field.field === 'name')?.status).toBe('match')
  })

  it('flags different MRNs as conflicting evidence', () => {
    const result = comparePatientIdentities({
      incoming: bima,
      candidate: { ...bima, mrn: 'DEMO-MRN-999' },
      mrnVerification: 'verified'
    })

    expect(result.fields.find(field => field.field === 'mrn')?.status).toBe('conflict')
    expect(result.recommendation).toBe('conflicting_evidence_review_required')
  })
})
