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
  incoming: { mrn: string; name: string; birthDate: string; gender: string; row: Record<string,string>; sourceField: string }
  onClose: () => void
  onComplete: (message: string, action: 'corrected' | 'matched' | 'unresolved') => void
}
const patientName = (value:any) => Array.isArray(value) ? value.map(n=>n.text ?? [...(n.given??[]),n.family].filter(Boolean).join(' ')).filter(Boolean).join(', ') : ''

export function PatientIdentityReview({workspace,importId,rowNumber,incoming,onClose,onComplete}:Props) {
  const [reviewId,setReviewId]=useState<string|null>(null)
  const [candidates,setCandidates]=useState<Candidate[]>([])
  const [selected,setSelected]=useState('')
  const [comment,setComment]=useState('')
  const [correctedMrn,setCorrectedMrn]=useState('')
  const [attempt,setAttempt]=useState<number|null>(null)
  const [duplicateRows,setDuplicateRows]=useState<{id:string;row_number:number;processing_status:string}[]>([])
  const canReview=['tenant_admin','clinic_admin','data_manager'].includes(workspace.role)
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
      const {data:allRows,error:rowsError}=await supabase.from('import_rows').select('id,row_number,original_data,processing_status').eq('tenant_id',workspace.tenantId).eq('import_id',importId).limit(1000)
      if(rowsError) throw rowsError
      if(!alive)return
      setCandidates((found??[]) as Candidate[])
      setDuplicateRows((allRows??[]).filter((r:any)=>String(r.original_data?.[incoming.sourceField]??'').trim()===incoming.mrn).map((r:any)=>({id:r.id,row_number:r.row_number,processing_status:r.processing_status})))
      if(canReview){
        const {data:opened,error:openError}=await supabase.rpc('open_patient_identity_review',{
          p_tenant_id:workspace.tenantId,p_organization_id:workspace.organizationId,p_import_id:importId,p_import_row_id:source.id,
          p_incoming_mrn:incoming.mrn,p_incoming_snapshot:{name:incoming.name,birth_date:incoming.birthDate,gender:incoming.gender,source_field:incoming.sourceField}
        })
        if(openError) throw openError
        const review=Array.isArray(opened)?opened[0]:opened
        if(!review?.review_id) throw new Error('Could not open an identity review attempt.')
        if(alive){setReviewId(review.review_id);setAttempt(review.attempt_number)}
      }
      if(alive)setLoading(false)
    })().catch(err=>{if(alive){setError(err.message??'Could not load identity review.');setLoading(false)}})
    return()=>{alive=false}
  },[workspace.tenantId,workspace.organizationId,workspace.role,importId,rowNumber,incoming.mrn,incoming.name,incoming.birthDate,incoming.gender,incoming.sourceField])

  const correctMrn=async()=>{
    if(!supabase||!reviewId||busy||!canReview)return
    if(!correctedMrn.trim()||!comment.trim()){setError('Enter the corrected MRN and evidence for the correction.');return}
    if(correctedMrn.trim()===incoming.mrn){setError('The corrected MRN must be different from the duplicated MRN.');return}
    setBusy(true);setError('')
    const {data,error:rpcError}=await supabase.rpc('correct_patient_identity_mrn',{p_review_id:reviewId,p_corrected_mrn:correctedMrn.trim(),p_comment:comment.trim()})
    setBusy(false)
    if(rpcError){setError(rpcError.message);return}
    onComplete('Corrected MRN recorded in the source correction ledger. SATUCORE is reprocessing this row to regenerate the canonical Patient and FHIR draft.','corrected')
    onClose()
  }

  const decide=async(decision:'confirmed_match'|'unresolved')=>{
    if(!supabase||!reviewId||busy||!canReview)return
    if(decision==='confirmed_match'&&!selected){setError('Select the existing Patient record to confirm the match.');return}
    if(!comment.trim()){setError('Enter the evidence or rationale for this identity decision.');return}
    setBusy(true);setError('')
    const {error:rpcError}=await supabase.rpc('decide_patient_identity_review',{
      p_review_id:reviewId,p_decision:decision,p_candidate_patient_id:decision==='confirmed_match'?selected:null,p_comment:comment.trim()
    })
    if(rpcError){setError(rpcError.message);setBusy(false);return}
    setBusy(false)
    if(decision==='confirmed_match') onComplete('Identity confirmed and source row linked to the existing clinic Patient. No duplicate Patient or new FHIR resource was created.','matched')
    else onComplete('Identity review remains unresolved. Patient creation stays blocked.','unresolved')
    onClose()
  }

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="login-modal identity-review-modal" style={{width:'min(900px,96vw)',maxWidth:900,maxHeight:'90vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()}>
      <button className="modal-close icon-btn" onClick={onClose}><X size={18}/></button>
      <div className="eyebrow"><ShieldCheck size={14}/> HUMAN IDENTITY REVIEW</div>
      <h2>Duplicate MRN detected</h2>
      {attempt&&<p className="foot-note">Review attempt {attempt}</p>}
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
      {duplicateRows.length>1&&<div className="callout"><CircleAlert size={18}/><span><b>Repeated in this import · {duplicateRows.length} rows</b><small>{duplicateRows.map(r=>'#'+r.row_number+' ('+r.processing_status+')').join(' · ')}. Resolve each row individually; SATUCORE will not assume they represent one person.</small></span></div>}
      {!canReview&&<div className="callout"><CircleAlert size={18}/><span><b>Read-only review</b><small>Your role cannot finalize identity decisions. Ask a clinic administrator or data manager.</small></span></div>}
      <label>Reviewer evidence / rationale</label>
      <textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="Record which source evidence was checked and why this decision is appropriate." rows={3}/>
      {error&&<p role="alert" className="warn-text">{error}</p>}
      {canReview&&<>
        <label>Verified corrected source MRN</label>
        <input value={correctedMrn} onChange={e=>setCorrectedMrn(e.target.value)} placeholder="Enter corrected MRN" maxLength={128}/>
        <div className="action-row" style={{justifyContent:'flex-end',flexWrap:'wrap',marginTop:16}}>
          <button className="secondary-btn" disabled={busy||loading||!reviewId} onClick={()=>void decide('unresolved')}>Leave unresolved</button>
          <button className="secondary-btn" disabled={busy||loading||!reviewId||!correctedMrn.trim()} onClick={()=>void correctMrn()}>Different Patient · correct MRN</button>
          <button className="primary-btn" disabled={busy||loading||!reviewId||!candidates.length||!selected} onClick={()=>void decide('confirmed_match')}><Check size={15}/> Confirm match & link</button>
        </div>
      </>}
      <p className="foot-note">A confirmed match links this import row to the existing Patient. It does not merge records, overwrite demographics, create a second Patient, call MPI or submit to SATUSEHAT.</p>
    </div>
  </div>
}
