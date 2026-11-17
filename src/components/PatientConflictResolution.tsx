import { useState } from 'react'
import { AlertTriangle, Check, ClipboardCheck, X } from 'lucide-react'

export type PatientConflictField =
  | 'identifier'
  | 'name'
  | 'birthDate'
  | 'gender'
  | 'telecom'
  | 'address'

export type PatientConflictResolutionRequest = {
  patientId: string
  field: PatientConflictField
  currentValue: string
  proposedValue: string
  reason: string
  status: 'pending_review'
}

type Props = {
  patientId: string
  field: PatientConflictField
  currentValue: string
  conflictLabel?: string
  disabled?: boolean
  onSubmitForReview: (request: PatientConflictResolutionRequest) => Promise<void> | void
}

/**
 * Drop-in human-review control for a Patient identity/data conflict.
 * It deliberately does not update a Patient or call Supabase. The parent
 * must connect onSubmitForReview to a tenant-scoped, RLS-protected backend.
 */
export function PatientConflictResolution({
  patientId,
  field,
  currentValue,
  conflictLabel = 'A conflicting or inconsistent value needs review.',
  disabled = false,
  onSubmitForReview,
}: Props) {
  const [open, setOpen] = useState(false)
  const [proposedValue, setProposedValue] = useState(currentValue)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const submit = async () => {
    if (!proposedValue.trim() || !reason.trim() || busy) return
    setBusy(true)
    setMessage('')
    try {
      await onSubmitForReview({
        patientId,
        field,
        currentValue,
        proposedValue: proposedValue.trim(),
        reason: reason.trim(),
        status: 'pending_review',
      })
      setMessage('Correction proposal handed to the review handler. No patient record was changed by this component.')
      setOpen(false)
      setReason('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit correction proposal.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="secondary-btn"
        disabled={disabled}
        onClick={() => { setProposedValue(currentValue); setOpen(true); setMessage('') }}
        aria-label="Resolve patient conflict"
      >
        <AlertTriangle size={15} /> Resolve conflict
      </button>

      {message && <p role="status" className="foot-note">{message}</p>}

      {open && (
        <div
          role="presentation"
          onClick={() => !busy && setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(12, 10, 25, .68)', display: 'grid', placeItems: 'center', padding: 16 }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="patient-conflict-title"
            onClick={event => event.stopPropagation()}
            style={{ width: 'min(560px, 100%)', background: 'var(--panel, #fff)', color: 'var(--text, #211d32)', border: '1px solid var(--border, #ddd)', borderRadius: 18, padding: 24, boxShadow: '0 24px 80px rgba(0,0,0,.28)' }}
          >
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div className="eyebrow">PATIENT DATA GOVERNANCE</div>
                <h2 id="patient-conflict-title" style={{ margin: '8px 0' }}>Resolve patient conflict</h2>
                <p style={{ margin: 0, opacity: .75 }}>{conflictLabel}</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}><X size={18}/></button>
            </header>

            <div style={{ display: 'grid', gap: 8, marginTop: 20 }}>
              <label htmlFor="conflict-current"><b>Current value · preserved</b></label>
              <input id="conflict-current" value={currentValue} readOnly />

              <label htmlFor="conflict-proposed"><b>Proposed correction</b></label>
              <input id="conflict-proposed" value={proposedValue} onChange={event => setProposedValue(event.target.value)} placeholder="Enter the proposed value" />

              <label htmlFor="conflict-reason"><b>Reason and evidence</b></label>
              <textarea id="conflict-reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} placeholder="Explain why this correction is proposed and cite the source evidence." />

              <div className="callout" style={{ marginTop: 8 }}>
                <ClipboardCheck size={18}/>
                <span><b>Human approval required</b><small>This proposal is marked pending review. It must not update the canonical Patient or FHIR resource until an authorized reviewer approves it.</small></span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                <button type="button" className="secondary-btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="primary-btn" disabled={busy || !proposedValue.trim() || !reason.trim()} onClick={submit}>
                  <Check size={15}/>{busy ? 'Submitting…' : 'Submit for review'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
