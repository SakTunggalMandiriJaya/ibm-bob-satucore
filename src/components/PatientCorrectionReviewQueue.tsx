import { useEffect, useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'

type RequestRow = {
  id: string
  tenant_id: string
  patient_id: string
  field_path: string
  original_value: unknown
  proposed_value: unknown
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}

function displayValue(value: unknown) {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Reviewer queue. Decisions are persisted; approval does not silently mutate Patient/FHIR. */
export function PatientCorrectionReviewQueue() {
  const [items, setItems] = useState<RequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const refresh = async () => {
    if (!supabase) { setNote('Supabase is not configured.'); setLoading(false); return }
    setLoading(true)
    const { data, error } = await supabase
      .from('patient_correction_requests')
      .select('id,tenant_id,patient_id,field_path,original_value,proposed_value,reason,status,created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50)
    if (error) setNote(error.message)
    else { setItems((data ?? []) as RequestRow[]); setNote('') }
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  const decide = async (item: RequestRow, decision: 'approved' | 'rejected') => {
    if (!supabase || busyId) return
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) { setNote('Sign in to review correction proposals.'); return }
    setBusyId(item.id)
    const { error } = await supabase.from('patient_correction_requests').update({
      status: decision,
      reviewed_by: auth.user.id,
      reviewed_at: new Date().toISOString(),
      review_comment: decision === 'approved'
        ? 'Approved by an authorized human reviewer. Canonical application remains a separate controlled step.'
        : 'Rejected by an authorized human reviewer.',
    }).eq('id', item.id).eq('status', 'pending')
    if (error) setNote(error.message)
    else {
      const { error: auditError } = await supabase.from('audit_logs').insert({
        tenant_id: item.tenant_id,
        actor_user_id: auth.user.id,
        action: decision === 'approved' ? 'patient_correction_approved' : 'patient_correction_rejected',
        entity_type: 'patient_correction_request',
        entity_id: item.id,
        outcome: 'success',
        metadata: { patient_id: item.patient_id, field_path: item.field_path, decision },
      })
      setNote(auditError
        ? `Decision saved; audit event could not be written: ${auditError.message}`
        : decision === 'approved'
          ? 'Proposal approved. The canonical Patient and FHIR payload have NOT been changed; application requires the next controlled step.'
          : 'Proposal rejected. The canonical Patient and FHIR payload were not changed.')
      await refresh()
    }
    setBusyId(null)
  }

  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><div className="eyebrow">HUMAN REVIEW</div><h3>Patient correction queue</h3></div>
        <button type="button" className="secondary-btn" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14}/> Refresh</button>
      </div>
      <p className="foot-note">Approval records the review decision only. Applying an approved correction to canonical Patient/FHIR remains a separate controlled operation.</p>
      {note && <p role="status" className="foot-note">{note}</p>}
      {loading ? <p>Loading pending requests…</p> : items.length === 0 ? <p className="foot-note">No pending correction requests.</p> : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map(item => (
            <article key={item.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <b>{item.field_path}</b><small>{new Date(item.created_at).toLocaleString()}</small>
              </div>
              <p><b>Current:</b> {displayValue(item.original_value)}</p>
              <p><b>Proposed:</b> {displayValue(item.proposed_value)}</p>
              <p><b>Reason:</b> {item.reason}</p>
              <small>Patient {item.patient_id} · Request {item.id}</small>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                <button type="button" className="secondary-btn" disabled={busyId === item.id} onClick={() => void decide(item, 'rejected')}><X size={14}/> Reject</button>
                <button type="button" className="primary-btn" disabled={busyId === item.id} onClick={() => void decide(item, 'approved')}><Check size={14}/> Approve proposal</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
