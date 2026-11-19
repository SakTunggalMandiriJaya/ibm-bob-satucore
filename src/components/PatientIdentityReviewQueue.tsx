
import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  RefreshCw,
  ShieldAlert,
  UserRoundX,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Workspace } from '../lib/workflow'
import { comparePatientIdentities } from '../lib/identity-intelligence'

type Review = {
  id: string
  tenant_id: string
  organization_id: string
  import_id: string
  import_row_id: string
  incoming_mrn: string
  incoming_snapshot: Record<string, unknown> | null
  candidate_patient_id: string | null
  decision: string
  created_at: string
  attempt_number: number
}

type Source = {
  id: string
  row_number: number
  original_data: Record<string, unknown> | null
  normalized_data: Record<string, unknown> | null
}

type Patient = {
  id: string
  name: unknown
  birth_date: string | null
  administrative_gender: string | null
  local_mrn: string | null
  addresses: unknown
  nik: string | null
  nikAmbiguous?: boolean
}

type Item = {
  review: Review
  source: Source | null
  candidate: Patient | null
}

type Decision =
  | 'confirmed_match'
  | 'not_same_patient'
  | 'unresolved'

const allowedRoles = new Set([
  'tenant_admin',
  'clinic_admin',
  'data_manager',
])

const value = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'â€”'

  if (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return String(v)
  }

  if (Array.isArray(v)) {
    return v.map(value).join(', ')
  }

  if (
    typeof v === 'object' &&
    'text' in (v as object)
  ) {
    return String(
      (v as { text?: unknown }).text ?? 'â€”'
    )
  }

  try {
    return JSON.stringify(v)
  } catch {
    return 'â€”'
  }
}

const mask = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—'

  const s =
    typeof v === 'string' || typeof v === 'number'
      ? String(v)
      : value(v)

  if (s.length < 5 || s === '—' || s === 'â€”') return s

  return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`
}

const patientCity = (addresses: unknown): string | null => {
  const entries = Array.isArray(addresses)
    ? addresses
    : addresses && typeof addresses === 'object'
      ? [addresses]
      : []

  for (const entry of entries) {
    if (
      entry &&
      typeof entry === 'object' &&
      'city' in entry &&
      typeof (entry as { city?: unknown }).city === 'string'
    ) {
      return (entry as { city: string }).city
    }
  }

  return null
}

const decisionOptions: {
  value: Decision
  label: string
  description: string
}[] = [
  {
    value: 'confirmed_match',
    label: 'Confirm same patient',
    description:
      'Link the incoming record to the existing canonical Patient.',
  },
  {
    value: 'not_same_patient',
    label: 'Confirm different patients',
    description:
      'Keep the incoming person separate from the existing Patient.',
  },
  {
    value: 'unresolved',
    label: 'Leave unresolved',
    description:
      'Keep the identity conflict open for further investigation.',
  },
]

function IdentityDecisionSelect({
  id,
  value,
  allowMatch,
  onChange,
}: {
  id: string
  value: Decision
  allowMatch: boolean
  onChange: (value: Decision) => void
}) {
  const [open, setOpen] = useState(false)

  const selected =
    decisionOptions.find(option => option.value === value) ??
    decisionOptions[2]

  return (
    <div
      className={`identity-decision${open ? ' is-open' : ''}`}
      onBlur={event => {
        if (
          !event.currentTarget.contains(
            event.relatedTarget as Node | null
          )
        ) {
          setOpen(false)
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          setOpen(false)

          ;(
            event.currentTarget.querySelector(
              'button[aria-haspopup="listbox"]'
            ) as HTMLButtonElement | null
          )?.focus()
        }
      }}
    >
      <button
        id={id}
        type="button"
        className="identity-decision-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        onClick={() => setOpen(current => !current)}
      >
        <span className="identity-decision-current">
          <span className="identity-decision-kicker">
            SELECTED DECISION
          </span>

          <span className="identity-decision-label">
            {selected.label}
          </span>
        </span>

        <ChevronDown size={16} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="identity-decision-menu"
          id={`${id}-options`}
          role="listbox"
          aria-label="Identity decision"
        >
          {decisionOptions.map(option => {
            const active = option.value === value

            const unavailable =
              option.value === 'confirmed_match' &&
              !allowMatch

            return (
              <button
                type="button"
                role="option"
                aria-selected={active}
                key={option.value}
                className={`identity-decision-option${
                  active ? ' is-selected' : ''
                }`}
                disabled={unavailable}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span className="identity-decision-option-copy">
                  <span className="identity-decision-option-title">
                    {option.label}
                  </span>

                  <span className="identity-decision-option-description">
                    {option.description}
                  </span>
                </span>

                {active && (
                  <Check size={16} aria-hidden="true" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function PatientIdentityReviewQueue({
  workspace,
}: {
  workspace: Workspace
}) {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const [comments, setComments] = useState<
    Record<string, string>
  >({})

  const [decisions, setDecisions] = useState<
    Record<string, Decision>
  >({})

  const [message, setMessage] = useState('')

  const canDecide = allowedRoles.has(
    workspace.role.toLowerCase()
  )

  const refresh = useCallback(async () => {
    if (!supabase) {
      setMessage('Supabase is not configured.')
      setLoading(false)
      return
    }

    if (!workspace.organizationId) {
      setItems([])
      setLoading(false)
      return
    }

    setLoading(true)

    try {
      const { data, error } = await supabase
        .from('patient_identity_review_requests')
        .select(
          'id,tenant_id,organization_id,import_id,import_row_id,incoming_mrn,incoming_snapshot,candidate_patient_id,decision,created_at,attempt_number'
        )
        .eq('tenant_id', workspace.tenantId)
        .eq('organization_id', workspace.organizationId)
        .eq('decision', 'pending')
        .order('created_at', { ascending: true })
        .limit(50)

      if (error) throw error

      const reviews = (data ?? []) as Review[]

      const rowIds = [
        ...new Set(reviews.map(x => x.import_row_id)),
      ]

      const patientIds = [
        ...new Set(
          reviews
            .map(x => x.candidate_patient_id)
            .filter((x): x is string => Boolean(x))
        ),
      ]

      const [rowsResult, patientsResult, identifiersResult] =
        await Promise.all([
          rowIds.length
            ? supabase
                .from('import_rows')
                .select(
                  'id,row_number,original_data,normalized_data'
                )
                .eq('tenant_id', workspace.tenantId)
                .in('id', rowIds)
            : Promise.resolve({
                data: [],
                error: null,
              }),

          patientIds.length
            ? supabase
                .from('patients')
                .select(
                  'id,name,birth_date,administrative_gender,local_mrn,addresses'
                )
                .eq('tenant_id', workspace.tenantId)
                .eq(
                  'organization_id',
                  workspace.organizationId
                )
                .in('id', patientIds)
            : Promise.resolve({
                data: [],
                error: null,
              }),

          patientIds.length
            ? supabase
                .from('patient_identifiers')
                .select('patient_id,value,verification_status')
                .eq('tenant_id', workspace.tenantId)
                .eq('system', 'urn:satucore:source-nik')
                .in('patient_id', patientIds)
            : Promise.resolve({
                data: [],
                error: null,
              }),
        ])

      if (rowsResult.error) throw rowsResult.error
      if (patientsResult.error) throw patientsResult.error
      if (identifiersResult.error) throw identifiersResult.error

      const rows = new Map(
        ((rowsResult.data ?? []) as Source[]).map(
          x => [x.id, x]
        )
      )

      const patientIdentifiers = new Map<string, string[]>()
      for (const identifier of identifiersResult.data ?? []) {
        const values = patientIdentifiers.get(identifier.patient_id) ?? []
        values.push(identifier.value)
        patientIdentifiers.set(identifier.patient_id, values)
      }

      const patients = new Map(
        ((patientsResult.data ?? []) as Patient[]).map(patient => {
          const nikValues = patientIdentifiers.get(patient.id) ?? []
          return [patient.id, {
            ...patient,
            nik: nikValues.length === 1 ? nikValues[0] : null,
            nikAmbiguous: nikValues.length > 1,
          } satisfies Patient]
        })
      )

      setItems(
        reviews.map(review => ({
          review,
          source:
            rows.get(review.import_row_id) ?? null,
          candidate: review.candidate_patient_id
            ? patients.get(review.candidate_patient_id) ??
              null
            : null,
        }))
      )

      setMessage('')
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : String(e)
      )
    } finally {
      setLoading(false)
    }
  }, [
    workspace.tenantId,
    workspace.organizationId,
  ])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const decide = async (item: Item) => {
    if (!supabase || busy) return

    const decision = decisions[item.review.id] ?? 'unresolved'

    if (!decisions[item.review.id]) {
      setMessage('Please explicitly select an identity decision before recording it.')
      return
    }

    const comment = (
      comments[item.review.id] ?? ''
    ).trim()

    if (!canDecide) {
      setMessage(
        'Only a clinic administrator or data manager can finalize identity decisions.'
      )
      return
    }

    if (comment.length < 10) {
      setMessage(
        'Please provide at least 10 characters of evidence and rationale.'
      )
      return
    }

    if (
      decision === 'confirmed_match' &&
      !item.candidate
    ) {
      setMessage(
        'No eligible candidate Patient is available to confirm.'
      )
      return
    }

    setBusy(item.review.id)
    setMessage('')

    try {
      const { data, error } = await supabase.rpc(
        'decide_patient_identity_review',
        {
          p_review_id: item.review.id,
          p_decision: decision,
          p_candidate_patient_id:
            decision === 'confirmed_match'
              ? item.candidate?.id ?? null
              : null,
          p_comment: comment,
        }
      )

      if (error) throw error

      const result = Array.isArray(data)
        ? data[0]
        : data

      if (
        !result?.review_id ||
        result.review_id !== item.review.id ||
        result.decision !== decision
      ) {
        throw new Error(
          'The database did not return the expected decision confirmation. Refresh and verify before retrying.'
        )
      }

      setMessage(
        `Decision recorded: ${decision.replaceAll(
          '_',
          ' '
        )}. Source status: ${result.row_status}. No Patient was merged, renamed or submitted.`
      )

      await refresh()
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : String(e)
      )
    } finally {
      setBusy(null)
    }
  }

  if (!workspace.organizationId) {
    return (
      <section className="panel">
        <p className="foot-note">
          Select an active clinic Organization to review
          identity conflicts.
        </p>
      </section>
    )
  }

  return (
    <section className="panel patient-identity-review-queue">
      <div className="panel-head">
        <div>
          <div className="eyebrow">
            HUMAN IDENTITY GOVERNANCE
          </div>

          <h3>Patient identity review queue</h3>

          <p>
            Resolve duplicate-MRN conflicts without
            automatic merging or overwriting source
            evidence.
          </p>
        </div>

        <button
          type="button"
          className="secondary-btn"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      <div className="callout">
        <ShieldAlert size={17} />

        <span>
          <b>Human decision required</b>

          <small>
            A validated draft is not an identity decision
            or permission to create or submit a Patient.
            Decisions are checked again by the database.
          </small>
        </span>
      </div>

      {message && (
        <p
          className="patient-correction-message"
          role="status"
        >
          {message}
        </p>
      )}

      {loading ? (
        <p className="foot-note">
          Loading identity reviewsâ€¦
        </p>
      ) : items.length === 0 ? (
        <p className="foot-note">
          No pending identity reviews for this clinic.
        </p>
      ) : (
        <div className="patient-correction-list">
          {items.map(item => {
            const r = item.review

            const snapshot =
              r.incoming_snapshot ??
              item.source?.original_data ??
              {}

            const selected = decisions[r.id] ?? 'unresolved'

            const incomingName =
              snapshot.full_name ?? snapshot.name ?? snapshot.patient_name

            const incomingDob =
              snapshot.birth_date ?? snapshot.dob

            const incomingGender =
              snapshot.gender ?? snapshot.administrative_gender

            const intelligence = comparePatientIdentities({
              incoming: {
                name: value(incomingName) === 'â€”' ? null : value(incomingName),
                birthDate: value(incomingDob) === 'â€”' ? null : value(incomingDob),
                gender: value(incomingGender) === 'â€”' ? null : value(incomingGender),
                city: value(snapshot.city) === 'â€”' ? null : value(snapshot.city),
                mrn: r.incoming_mrn || null,
                nik: value(
                  snapshot.nik ??
                  snapshot.NIK ??
                  snapshot.national_id ??
                  snapshot.national_identifier ??
                  snapshot.nomor_induk_kependudukan ??
                  snapshot.no_ktp ??
                  snapshot.ktp
                ) === 'â€”'
                  ? null
                  : value(
                      snapshot.nik ??
                      snapshot.NIK ??
                      snapshot.national_id ??
                      snapshot.national_identifier ??
                      snapshot.nomor_induk_kependudukan ??
                      snapshot.no_ktp ??
                      snapshot.ktp
                    ),
              },
              candidate: {
                name: item.candidate
                  ? value(item.candidate.name)
                  : null,
                birthDate: item.candidate?.birth_date ?? null,
                gender: item.candidate?.administrative_gender ?? null,
                city: item.candidate ? patientCity(item.candidate.addresses) : null,
                mrn: item.candidate?.local_mrn ?? null,
                nik: item.candidate?.nik ?? null,
              },
              mrnVerification: 'unverified',
              nikVerification: 'unverified',
            })

            const hasMaterialIdentityConflict = intelligence.fields.some(
              field =>
                ['name', 'birthDate', 'gender', 'nik'].includes(field.field) &&
                field.status === 'conflict'
            )

            return (
              <article
                className="patient-correction-item"
                key={r.id}
              >
                <div className="patient-correction-item-head">
                  <b>MRN {r.incoming_mrn}</b>

                  <span className="status-chip">
                    PENDING REVIEW
                  </span>
                </div>

                <small>
                  Attempt {r.attempt_number} Â·{' '}
                  {new Date(
                    r.created_at
                  ).toLocaleString()}{' '}
                  Â· Import row{' '}
                  {item.source?.row_number ?? 'â€”'}
                </small>

                <div className="grid-two">
                  <div>
                    <b>Incoming source record</b>

                    <p>
                      Name:{' '}
                      {value(
                        snapshot.full_name ??
                          snapshot.name ??
                          snapshot.patient_name
                      )}
                    </p>

                    <p>
                      DOB:{' '}
                      {value(
                        snapshot.birth_date ??
                          snapshot.dob
                      )}
                    </p>

                    <p>
                      Gender:{' '}
                      {value(
                        snapshot.gender ??
                          snapshot.administrative_gender
                      )}
                    </p>

                    <p>
                      City: {value(snapshot.city)}
                    </p>

                    <p>
                      National ID:{' '}
                      {mask(
                        snapshot.nik ?? snapshot.NIK
                      )}
                    </p>
                  </div>

                  <div>
                    <b>Existing canonical Patient</b>

                    {item.candidate ? (
                      <>
                        <p>
                          Name:{' '}
                          {value(item.candidate.name)}
                        </p>

                        <p>
                          DOB:{' '}
                          {value(
                            item.candidate.birth_date
                          )}
                        </p>

                        <p>
                          Gender:{' '}
                          {value(
                            item.candidate.administrative_gender
                          )}
                        </p>

                        <p>
                          MRN:{' '}
                          {value(
                            item.candidate.local_mrn
                          )}
                        </p>

                        <p>
                          National ID:{' '}
                          {item.candidate.nikAmbiguous
                            ? 'Multiple identifiers — review required'
                            : mask(item.candidate.nik)}
                        </p>

                        <p>
                          Patient ID:{' '}
                          <code>
                            {item.candidate.id}
                          </code>
                        </p>
                      </>
                    ) : (
                      <p>
                        No single eligible candidate was
                        attached. Do not confirm a match
                        without selecting a verified
                        candidate.
                      </p>
                    )}
                  </div>
                </div>

<section
                  className="identity-intelligence-advisory"
                  aria-label="Identity Intelligence advisory"
                  style={{
                    marginTop: 18,
                    marginBottom: 18,
                    padding: 16,
                    border: '1px solid var(--border-color, #d8d5e5)',
                    borderRadius: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ShieldAlert size={18} />
                    <b>IDENTITY INTELLIGENCE</b>
                    <span className="status-chip">ADVISORY ONLY</span>
                  </div>

                  <p>{intelligence.summary}</p>

                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                    gap: 10,
                  }}>
                    {intelligence.fields.map(field => (
                      <div
                        key={field.field}
                        style={{
                          padding: 10,
                          border: '1px solid var(--border-color, #e2e0e9)',
                          borderRadius: 8,
                        }}
                      >
                        <b>{field.field === 'birthDate' ? 'Date of birth' : field.field.toUpperCase()}</b>
                        <div data-identity-status={field.status}>
                          {field.status.toUpperCase()}
                        </div>
                        <small>{field.explanation}</small>
                      </div>
                    ))}
                  </div>

                  <p className="foot-note">
                    This is a deterministic comparison, not an identity decision.
                    No Patient is merged, separated, created or submitted by this advisory.
                    An authorized human reviewer must decide.
                  </p>
                </section>

                {canDecide ? (
                  <>
                    <div className="identity-review-decision-block">
                      <div className="identity-review-field-heading">
                        <label
                          className="field-label"
                          htmlFor={`decision-${r.id}`}
                        >
                          Identity decision
                        </label>

                        <p>
                          Choose the outcome supported by
                          the available evidence.
                        </p>
                      </div>

                      <IdentityDecisionSelect
                        id={`decision-${r.id}`}
                        value={selected}
                        allowMatch={Boolean(
                          item.candidate
                        ) && !hasMaterialIdentityConflict}
                        onChange={decision =>
                          setDecisions(prev => ({
                            ...prev,
                            [r.id]: decision,
                          }))
                        }
                      />

                      <div className="identity-review-field-heading identity-review-evidence-heading">
                        <label
                          className="field-label"
                          htmlFor={`comment-${r.id}`}
                        >
                          Evidence and decision rationale

                          <span className="required-mark">
                            Required
                          </span>
                        </label>

                        <p>
                          Explain what was checked, which
                          evidence supports the decision,
                          and why this outcome is
                          appropriate.
                        </p>
                      </div>

                      <textarea
                        id={`comment-${r.id}`}
                        className="identity-review-evidence-input"
                        rows={4}
                        value={comments[r.id] ?? ''}
                        onChange={e =>
                          setComments(prev => ({
                            ...prev,
                            [r.id]: e.target.value,
                          }))
                        }
                        placeholder={
                          selected === 'confirmed_match'
                            ? 'Example: The clinic registration record and verified patient identifier confirm that this incoming record belongs to the existing Patient. MRN and date of birth were cross-checked.'
                            : selected ===
                                'not_same_patient'
                              ? 'Explain which authoritative records establish that these are two different individuals, despite the matching identifier.'
                              : 'Describe the conflicting or insufficient information and what additional evidence is needed before this identity can be resolved.'
                        }
                      />

                      <div className="identity-review-evidence-note">
                        <ShieldAlert size={14} />

                        <span>
                          Record verifiable evidence, not
                          assumptions. Do not use name
                          similarity or an AI suggestion
                          alone as proof of identity.
                        </span>
                      </div>
                    </div>

                    <div className="action-row patient-correction-actions">
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={busy === r.id}
                        onClick={() => void decide(item)}
                      >
                        {selected ===
                        'confirmed_match' ? (
                          <Check size={13} />
                        ) : (
                          <UserRoundX size={13} />
                        )}

                        {busy === r.id
                          ? 'Savingâ€¦'
                          : 'Record human decision'}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="foot-note">
                    View only. Final decisions require
                    tenant_admin, clinic_admin or
                    data_manager authorization.
                  </p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}


