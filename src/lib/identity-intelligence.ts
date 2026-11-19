export type IdentityFieldStatus = 'match' | 'conflict' | 'missing' | 'unverified'

export type IdentityComparisonInput = {
  incoming: {
    name?: string | null
    birthDate?: string | null
    gender?: string | null
    city?: string | null
    mrn?: string | null
  }
  candidate: {
    name?: string | null
    birthDate?: string | null
    gender?: string | null
    city?: string | null
    mrn?: string | null
  }
  mrnVerification: 'verified' | 'unverified' | 'missing'
}

export type IdentityFieldComparison = {
  field: 'name' | 'birthDate' | 'gender' | 'city' | 'mrn'
  status: IdentityFieldStatus
  explanation: string
}

export type IdentityIntelligenceResult = {
  fields: IdentityFieldComparison[]
  recommendation:
    | 'conflicting_evidence_review_required'
    | 'additional_evidence_required'
  summary: string
  automaticDecision: false
}

function normalize(value?: string | null): string | null {
  const normalized = value
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()

  return normalized || null
}

function compareField(
  field: IdentityFieldComparison['field'],
  incoming?: string | null,
  candidate?: string | null
): IdentityFieldComparison {
  const left = normalize(incoming)
  const right = normalize(candidate)

  if (!left || !right) {
    return {
      field,
      status: 'missing',
      explanation: 'One or both records do not contain this field.'
    }
  }

  if (left === right) {
    return {
      field,
      status: 'match',
      explanation: 'The available values match.'
    }
  }

  return {
    field,
    status: 'conflict',
    explanation: 'The available values differ and require human review.'
  }
}

export function comparePatientIdentities(
  input: IdentityComparisonInput
): IdentityIntelligenceResult {
  const fields: IdentityFieldComparison[] = [
    compareField('name', input.incoming.name, input.candidate.name),
    compareField('birthDate', input.incoming.birthDate, input.candidate.birthDate),
    compareField('gender', input.incoming.gender, input.candidate.gender),
    compareField('city', input.incoming.city, input.candidate.city)
  ]

  const incomingMrn = normalize(input.incoming.mrn)
  const candidateMrn = normalize(input.candidate.mrn)

  if (!incomingMrn || !candidateMrn) {
    fields.push({
      field: 'mrn',
      status: 'missing',
      explanation: 'MRN evidence is missing from one or both records.'
    })
  } else if (incomingMrn !== candidateMrn) {
    fields.push({
      field: 'mrn',
      status: 'conflict',
      explanation: 'The MRN values differ.'
    })
  } else if (input.mrnVerification === 'verified') {
    fields.push({
      field: 'mrn',
      status: 'match',
      explanation: 'The MRN values match and are marked verified.'
    })
  } else {
    fields.push({
      field: 'mrn',
      status: 'unverified',
      explanation: 'The MRN values match, but the identifier is not verified.'
    })
  }

  const hasConflict = fields.some(field => field.status === 'conflict')

  const recommendation = hasConflict
    ? 'conflicting_evidence_review_required'
    : 'additional_evidence_required'

  return {
    fields,
    recommendation,
    summary: hasConflict
      ? 'Conflicting values were found. Keep the identity review unresolved until an authorized reviewer examines the evidence.'
      : 'The available evidence is insufficient to establish identity. Obtain additional evidence and retain human review.',
    automaticDecision: false
  }
}
