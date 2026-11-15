import { useEffect, useState } from 'react'
import { Check, RefreshCw, X, FileCheck2 } from 'lucide-react'
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
  applied_at: string | null
  resulting_fhir_resource_id: string | null
}

function displayValue(value: unknown) {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Tenant-scoped human review. Application is a separate controlled operation. */
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
      .select('id,tenant_id,patient_id,field_path,original_value,proposed_value,reason,status,created_at,applied_at,resulting_fhir_resource_id')
      .or('status.eq.pending,and(status.eq.approved,applied_at.is.null)')
      .order('created_at', { ascending: true })
      .limit(50)
    if (error) setNote(error.message)
    else { setItems((data ?? []) as RequestRow[]); setNote('') }
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  const decide = async (item: RequestRow, decision: 'approved' | 'rejected') => {
    if (!supabase || busyId || item.status !== 'pending') return
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) { setNote('Sign in to review correction proposals.'); return }
    setBusyId(item.id)
    const { error } = await supabase.from('patient_correction_requests').update({
      status: decision,
      reviewed_by: auth.user.id,
      reviewed_at: new Date().toISOString(),
      review_comment: decision === 'approved'
        ? 'Approved by an authorized human reviewer. Canonical application is a separate controlled operation.'
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
          ? 'Proposal approved. An authorized clinic administrator or data manager must apply it to create a new FHIR draft.'
          : 'Proposal rejected. The canonical Patient and FHIR payload were not changed.')
      await refresh()
    }
    setBusyId(null)
  }

  const apply = async (item: RequestRow) => {
    if (!supabase || busyId || item.status !== 'approved' || item.applied_at) return
    setBusyId(item.id)
    const { data, error } = await supabase.rpc('apply_approved_patient_name_correction', {
      p_request_id: item.id,
    })
    if (error) setNote(error.message)
    else {
      const result = Array.isArray(data) ? data[0] : data
      setNote(`Correction applied to the canonical Patient. New FHIR draft: ${result?.fhir_resource_id ?? 'created'}. Full FHIR R4 and SATUSEHAT Patient profile revalidation is still required; no submission was made.`)
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
      <p className="foot-note">Only Patient.name is currently supported for application. Approval and application are separate; application creates a new FHIR draft and requires full revalidation.</p>
      {note && <p role="status" className="foot-note">{note}</p>}
      {loading ? <p>Loading correction requests…</p> : items.length === 0 ? <p className="foot-note">No pending or approved-unapplied correction requests.</p> : (
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
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {item.status === 'pending' ? <>
                  <button type="button" className="secondary-btn" disabled={busyId === item.id} onClick={() => void decide(item, 'rejected')}><X size={14}/> Reject</button>
                  <button type="button" className="primary-btn" disabled={busyId === item.id} onClick={() => void decide(item, 'approved')}><Check size={14}/> Approve proposal</button>
                </> : item.status === 'approved' && !item.applied_at ? (
                  <button type="button" className="primary-btn" disabled={busyId === item.id} onClick={() => void apply(item)}><FileCheck2 size={14}/> Apply correction & create FHIR draft</button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
