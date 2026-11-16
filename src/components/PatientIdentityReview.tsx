import { useEffect, useState } from 'react'
import { Check, CircleAlert, Loader2, ShieldCheck, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Workspace } from '../lib/workflow'

type Candidate = {
  id: string
  local_mrn: string | null
  name: any
  birth_date: string | null
  administrative_gender: string | null
  telecom: any
  addresses: any
}
type Props = {
  workspace: Workspace
  importId: string
  rowNumber: number
  incoming: { mrn: string; name: string; birthDate: string; gender: string; row: Record<string,string> }
  onClose: () => void
  onComplete: (message: string) => void
}
const patientName = (value:any) => Array.isArray(value) ? value.map(n=>n.text ?? [...(n.given??[]),n.family].filter(Boolean).join(' ')).filter(Boolean).join(', ') : ''

export function PatientIdentityReview({workspace,importId,rowNumber,incoming,onClose,onComplete}:Props) {
  const [reviewId,setReviewId]=useState<string|null>(null)
  const [candidates,setCandidates]=useState<Candidate[]>([])
  const [selected,setSelected]=useState('')
  const [comment,setComment]=useState('')
  const [correctedMrn,setCorrectedMrn]=useState('')
  const [reviewDecision,setReviewDecision]=useState('pending')
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')

  useEffect(()=>{
    let alive=true
    ;(async()=>{
      if(!supabase) { if(alive){setError('Supabase is not configured.');setLoading(false)};return }
      const {data:source,error:sourceError}=await supabase.from('import_rows').select('id').eq('tenant_id',workspace.tenantId).eq('import_id',importId).eq('row_number',rowNumber).single()
      if(sourceError) throw sourceError
      if(!alive)return
      const {data:found,error:findError}=await supabase.from('patients')
        .select('id,local_mrn,name,birth_date,administrative_gender,telecom,addresses')
        .eq('tenant_id',workspace.tenantId).eq('organization_id',workspace.organizationId).eq('local_mrn',incoming.mrn)
        .limit(10)
      if(findError) throw findError
      if(!alive)return
      setCandidates((found??[]) as Candidate[])
      const {data:prior,error:priorError}=await supabase.from('patient_identity_review_requests')
        .select('id,decision').eq('tenant_id',workspace.tenantId).eq('import_row_id',source.id).order('created_at',{ascending:false}).limit(1).maybeSingle()
      if(priorError) throw priorError
      if(prior?.id && prior.decision==='pending') { setReviewId(prior.id); setReviewDecision(prior.decision) }
      else {
        const {data:created,error:createError}=await supabase.from('patient_identity_review_requests').insert({
          tenant_id:workspace.tenantId,organization_id:workspace.organizationId,import_id:importId,import_row_id:source.id,
          incoming_mrn:incoming.mrn,incoming_snapshot:{name:incoming.name,birth_date:incoming.birthDate,gender:incoming.gender},
        }).select('id').single()
        if(createError) throw createError
        if(alive)setReviewId(created.id)
      }
      if(alive)setLoading(false)
    })().catch(err=>{if(alive){setError(err.message??'Could not load identity review.');setLoading(false)}})
    return()=>{alive=false}
  },[workspace,importId,rowNumber,incoming.mrn,incoming.name,incoming.birthDate,incoming.gender])

  const correctMrn=async()=>{
    if(!supabase||!reviewId||busy)return
    if(!correctedMrn.trim()||!comment.trim()){setError('Enter the corrected MRN and evidence for the correction.');return}
    setBusy(true);setError('')
    const {data,error:rpcError}=await supabase.rpc('correct_patient_identity_mrn',{p_review_id:reviewId,p_corrected_mrn:correctedMrn.trim(),p_comment:comment.trim()})
    setBusy(false)
    if(rpcError){setError(rpcError.message);return}
    onComplete('Source MRN correction recorded separately from the original import. The original source row remains unchanged. Save again to rerun clinic uniqueness checks and generate a fresh canonical Patient and FHIR draft.')
    onClose()
  }

  const decide=async(decision:'confirmed_match'|'unresolved')=>{
    if(!supabase||!reviewId||busy)return
    if(decision==='confirmed_match'&&!selected){setError('Select the existing Patient record to confirm the match.');return}
    if(!comment.trim()){setError('Enter the evidence or rationale for this identity decision.');return}
    setBusy(true);setError('')
    const {data,error:rpcError}=await supabase.rpc('decide_patient_identity_review',{
      p_review_id:reviewId,p_decision:decision,p_candidate_patient_id:decision==='confirmed_match'?selected:null,p_comment:comment.trim()
    })
    if(rpcError){setError(rpcError.message);setBusy(false);return}
    const result=Array.isArray(data)?data[0]:data
    setBusy(false)
    if(decision==='confirmed_match') onComplete('Identity confirmed and source row linked to existing clinic Patient '+result.linked_patient_id+'. No duplicate Patient or new FHIR resource was created.')
    else onComplete('Identity review left unresolved. Patient save remains blocked.')
    onClose()
  }

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="login-modal identity-review-modal" style={{width:'min(900px,96vw)',maxWidth:900,maxHeight:'90vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()}>
      <button className="modal-close icon-btn" onClick={onClose}><X size={18}/></button>
      <div className="eyebrow"><ShieldCheck size={14}/> HUMAN IDENTITY REVIEW</div>
      <h2>MRN conflict review</h2>
      <p>Compare the incoming source record with actual Patient records in this clinic. Matching MRN is a candidate signal, not proof of identity.</p>
      <div className="callout"><CircleAlert size={18}/><span><b>Incoming source record</b><small>MRN: {incoming.mrn} · {incoming.name || 'Name not mapped'} · DOB: {incoming.birthDate || 'Not supplied'} · Gender: {incoming.gender || 'Not supplied'}</small></span></div>
      {loading?<p><Loader2 size={16}/> Loading clinic records…</p>:error&&candidates.length===0?<p role="alert" className="warn-text">{error}</p>:<>
        <h3>Existing clinic records with this MRN ({candidates.length})</h3>
        {candidates.length===0?<p>No existing Patient was returned for this MRN. The conflict may have changed; refresh and retry the save rather than assuming a match.</p>:candidates.map(candidate=><label key={candidate.id} style={{display:'block',border:'1px solid var(--border)',borderRadius:12,padding:12,marginBottom:10,cursor:'pointer'}}>
          <input type="radio" name="identity-candidate" checked={selected===candidate.id} onChange={()=>setSelected(candidate.id)}/>
          <b style={{marginLeft:8}}>{patientName(candidate.name)||'Name unavailable'}</b>
          <div className="foot-note">MRN {candidate.local_mrn} · DOB {candidate.birth_date??'—'} · Gender {candidate.administrative_gender??'—'}</div>
          <div className="foot-note">Patient ID: {candidate.id}</div>
        </label>)}
      </>}
      {reviewDecision!=='pending'&&<p role="status" className="warn-text">This review was already decided ({reviewDecision}). Start a new import/review rather than overwriting its audit history.</p>}
      <label>Reviewer evidence / rationale</label>
      <textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="Record which source evidence was checked and why this decision is appropriate." rows={3}/>
      {error&&<p role="alert" className="warn-text">{error}</p>}
      {reviewDecision==='pending'&&<>
        <label>Verified corrected source MRN</label>
        <input value={correctedMrn} onChange={e=>setCorrectedMrn(e.target.value)} placeholder="Enter corrected MRN" maxLength={128}/>
        <div className="action-row" style={{justifyContent:'flex-end',flexWrap:'wrap',marginTop:16}}>
          <button className="secondary-btn" disabled={busy||loading} onClick={()=>void decide('unresolved')}>Leave unresolved</button>
          <button className="secondary-btn" disabled={busy||loading||!correctedMrn.trim()} onClick={()=>void correctMrn()}>Not the same · correct MRN</button>
          <button className="primary-btn" disabled={busy||loading||!candidates.length} onClick={()=>void decide('confirmed_match')}><Check size={15}/> Confirm match & link</button>
        </div>
      </>}
      <p className="foot-note">A confirmed match links this import row to the existing Patient. It does not merge records, overwrite demographics, create a second Patient, call MPI or submit to SATUSEHAT.</p>
    </div>
  </div>
}
