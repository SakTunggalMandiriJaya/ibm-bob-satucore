import { useCallback, useEffect, useState } from 'react'
import { Check, FileCheck2, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'

type RequestRow = {
  id: string; tenant_id: string; patient_id: string; field_path: string
  original_value: unknown; proposed_value: unknown; reason: string
  status: 'pending' | 'approved' | 'rejected'; created_at: string
  applied_at: string | null; resulting_fhir_resource_id: string | null
}
const show = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v)

/** The queue is tenant-scoped by Supabase RLS; approval is separate from application. */
export function PatientCorrectionReviewQueue() {
  const [items, setItems] = useState<RequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) { setMessage('Supabase is not configured.'); setLoading(false); return }
    setLoading(true)
    const { data, error } = await supabase.from('patient_correction_requests')
      .select('id,tenant_id,patient_id,field_path,original_value,proposed_value,reason,status,created_at,applied_at,resulting_fhir_resource_id')
      .or('status.eq.pending,and(status.eq.approved,applied_at.is.null)')
      .order('created_at', { ascending: true }).limit(50)
    if (error) setMessage(error.message)
    else { setItems((data ?? []) as RequestRow[]); setMessage('') }
    setLoading(false)
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const decide = async (item: RequestRow, decision: 'approved' | 'rejected') => {
    if (!supabase || busyId || item.status !== 'pending') return
    setBusyId(item.id)
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!auth.user) throw new Error('Sign in before reviewing correction requests.')
      const { error } = await supabase.from('patient_correction_requests').update({
        status: decision, reviewed_by: auth.user.id, reviewed_at: new Date().toISOString(),
        review_comment: decision === 'approved' ? 'Approved by an authorized human reviewer.' : 'Rejected by an authorized human reviewer.',
      }).eq('id', item.id).eq('status', 'pending')
      if (error) throw error
      const { error: auditError } = await supabase.from('audit_logs').insert({
        tenant_id: item.tenant_id, actor_user_id: auth.user.id,
        action: decision === 'approved' ? 'patient_correction_approved' : 'patient_correction_rejected',
        entity_type: 'patient_correction_request', entity_id: item.id, outcome: 'success',
        metadata: { patient_id: item.patient_id, field_path: item.field_path, decision },
      })
      setMessage(auditError ? `Decision saved, but audit write failed: ${auditError.message}` : decision === 'approved'
        ? 'Proposal approved. An authorized clinic administrator or data manager can now apply the name correction.'
        : 'Proposal rejected. The Patient and FHIR resource were not changed.')
      await refresh()
    } catch (error) { setMessage((error as Error).message) }
    finally { setBusyId(null) }
  }

  const apply = async (item: RequestRow) => {
    if (!supabase || busyId || item.status !== 'approved' || item.applied_at) return
    setBusyId(item.id)
    try {
      const { data, error } = await supabase.rpc('apply_approved_patient_name_correction', { p_request_id: item.id })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      setMessage(`Correction applied. New FHIR draft: ${result?.fhir_resource_id ?? 'created'}. Full FHIR R4 and SATUSEHAT Patient profile revalidation is still required. No SATUSEHAT submission was made.`)
      await refresh()
    } catch (error) { setMessage((error as Error).message) }
    finally { setBusyId(null) }
  }

  return <section className="panel patient-correction-queue">
    <div className="panel-head patient-correction-queue-head"><div><div className="eyebrow">GOVERNED IDENTITY CHANGES</div><h3>Patient correction review queue</h3><p>Review proposals before any canonical Patient change.</p></div><button type="button" className="secondary-btn" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13}/> Refresh</button></div>
    <div className="callout"><Check size={17}/><span><b>Two-step control</b><small>Approval records the human decision. Applying an approved Patient.name correction is a separate authorized action and creates a new FHIR draft requiring full revalidation.</small></span></div>
    {message && <p className="patient-correction-message" role="status">{message}</p>}
    {loading ? <p className="foot-note">Loading correction requests…</p> : items.length === 0 ? <p className="foot-note">No pending or approved-unapplied correction requests.</p> : <div className="patient-correction-list">{items.map(item => <article className="patient-correction-item" key={item.id}>
      <div className="patient-correction-item-head"><b>{item.field_path}</b><span className="status-chip">{item.status.toUpperCase()}</span></div>
      <p><b>Current:</b> {show(item.original_value)}</p><p><b>Proposed:</b> {show(item.proposed_value)}</p><p><b>Reason:</b> {item.reason}</p>
      <small>Patient {item.patient_id} · {new Date(item.created_at).toLocaleString()}</small>
      <div className="action-row patient-correction-actions">{item.status === 'pending' ? <><button type="button" className="secondary-btn" disabled={busyId === item.id} onClick={() => void decide(item, 'rejected')}><X size={13}/> Reject</button><button type="button" className="primary-btn" disabled={busyId === item.id} onClick={() => void decide(item, 'approved')}><Check size={13}/> Approve proposal</button></> : item.status === 'approved' && !item.applied_at ? <button type="button" className="primary-btn" disabled={busyId === item.id} onClick={() => void apply(item)}><FileCheck2 size={13}/> Apply correction & create FHIR draft</button> : null}</div>
    </article>)}</div>}
  </section>
}
