import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { supabase } from '../lib/supabase'

type Props = {
  patientId: string
  tenantId: string
  currentName: string
  onSubmitted?: () => void
}

/** Proposes a correction only. It never edits the canonical Patient or FHIR resource. */
export function PatientConflictResolution({ patientId, tenantId, currentName, onSubmitted }: Props) {
  const [open, setOpen] = useState(false)
  const [proposedName, setProposedName] = useState(currentName)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const submit = async () => {
    if (!supabase || busy) return
    const nextName = proposedName.trim()
    const rationale = reason.trim()
    if (!nextName || !rationale) { setMessage('Enter the proposed name and the reason/evidence.'); return }
    if (nextName === currentName.trim()) { setMessage('The proposed name is identical to the current name.'); return }
    setBusy(true); setMessage('')
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!auth.user) throw new Error('Sign in before proposing a Patient correction.')
      const { data: request, error } = await supabase.from('patient_correction_requests').insert({
        tenant_id: tenantId,
        patient_id: patientId,
        field_path: 'Patient.name',
        original_value: currentName.trim(),
        proposed_value: nextName,
        reason: rationale,
        status: 'pending',
        requested_by: auth.user.id,
      }).select('id').single()
      if (error) throw error
      const { error: auditError } = await supabase.from('audit_logs').insert({
        tenant_id: tenantId,
        actor_user_id: auth.user.id,
        action: 'patient_correction_requested',
        entity_type: 'patient_correction_request',
        entity_id: request.id,
        outcome: 'success',
        metadata: { patient_id: patientId, field_path: 'Patient.name' },
      })
      setMessage(auditError
        ? `Proposal saved (${request.id}), but the audit event could not be written: ${auditError.message}`
        : 'Correction proposal submitted for human review. The Patient record has not been changed.')
      if (!auditError) { setOpen(false); onSubmitted?.() }
    } catch (error) {
      setMessage((error as Error).message)
    } finally { setBusy(false) }
  }

  return <>
    <button type="button" className="secondary-btn patient-conflict-trigger" onClick={() => { setProposedName(currentName); setReason(''); setMessage(''); setOpen(true) }}>
      <AlertTriangle size={13}/> Resolve conflict
    </button>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setOpen(false) }}>
      <section className="login-modal patient-correction-modal" role="dialog" aria-modal="true" aria-labelledby={`correction-title-${patientId}`}>
        <button type="button" className="modal-close secondary-btn" aria-label="Close" onClick={() => setOpen(false)} disabled={busy}><X size={16}/></button>
        <div className="eyebrow">HUMAN REVIEW · PATIENT IDENTITY</div>
        <h2 id={`correction-title-${patientId}`}>Propose Patient name correction</h2>
        <p>This creates a review request. It does not change the canonical Patient or FHIR resource.</p>
        <label>Current name</label><input value={currentName} readOnly />
        <label>Proposed name</label><input value={proposedName} onChange={e => setProposedName(e.target.value)} maxLength={200} />
        <label>Reason / evidence (required)</label><textarea value={reason} onChange={e => setReason(e.target.value)} rows={4} maxLength={2000} placeholder="Explain the source of the correction and evidence reviewed." />
        {message && <p className="patient-correction-message" role="status">{message}</p>}
        <div className="action-row"><button type="button" className="secondary-btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button><button type="button" className="primary-btn" onClick={() => void submit()} disabled={busy}>{busy ? 'Submitting…' : 'Submit for review'}</button></div>
      </section>
    </div>}
  </>
}
