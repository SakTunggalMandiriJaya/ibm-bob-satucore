export type IdentityFieldStatus = 'match' | 'conflict' | 'missing' | 'unverified'

export type IdentityVerification = 'verified' | 'unverified' | 'missing'

export type IdentityComparisonInput = {
  incoming: {
    name?: string | null
    birthDate?: string | null
    gender?: string | null
    city?: string | null
    mrn?: string | null
    nik?: string | null
  }
  candidate: {
    name?: string | null
    birthDate?: string | null
    gender?: string | null
    city?: string | null
    mrn?: string | null
    nik?: string | null
  }
  mrnVerification: IdentityVerification
  /**
   * Uploaded source NIK is unverified by default. A value match is not
   * proof of identity and must never trigger an automatic decision.
   */
  nikVerification?: IdentityVerification
}

export type IdentityFieldComparison = {
  field: 'name' | 'birthDate' | 'gender' | 'city' | 'mrn' | 'nik'
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
  field: Exclude<IdentityFieldComparison['field'], 'mrn' | 'nik'>,
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

function compareIdentifier(
  field: 'mrn' | 'nik',
  incoming?: string | null,
  candidate?: string | null,
  verification: IdentityVerification = 'unverified'
): IdentityFieldComparison {
  const left = normalize(incoming)
  const right = normalize(candidate)

  if (!left || !right) {
    return {
      field,
      status: 'missing',
      explanation: `${field.toUpperCase()} evidence is missing from one or both records; absence is not a match.`
    }
  }

  if (left !== right) {
    return {
      field,
      status: 'conflict',
      explanation: `${field.toUpperCase()} values differ and require human review.`
    }
  }

  if (verification === 'verified') {
    return {
      field,
      status: 'match',
      explanation: `${field.toUpperCase()} values match and the identifier is marked verified.`
    }
  }

  return {
    field,
    status: 'unverified',
    explanation: `${field.toUpperCase()} values match, but the identifier is not verified and is not proof of identity.`
  }
}

export function comparePatientIdentities(
  input: IdentityComparisonInput
): IdentityIntelligenceResult {
  const fields: IdentityFieldComparison[] = [
    compareField('name', input.incoming.name, input.candidate.name),
    compareField('birthDate', input.incoming.birthDate, input.candidate.birthDate),
    compareField('gender', input.incoming.gender, input.candidate.gender),
    compareField('city', input.incoming.city, input.candidate.city),
    compareIdentifier('nik', input.incoming.nik, input.candidate.nik, input.nikVerification ?? 'unverified'),
    compareIdentifier('mrn', input.incoming.mrn, input.candidate.mrn, input.mrnVerification)
  ]

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
