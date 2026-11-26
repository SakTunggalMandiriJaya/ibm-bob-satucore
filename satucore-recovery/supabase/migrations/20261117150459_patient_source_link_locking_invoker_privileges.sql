-- Fix row-locking privilege requirement while retaining SECURITY INVOKER.
-- The source import row is already locked by the decision RPC, serializing same-row decisions.

create or replace function public.decide_patient_identity_review(
 p_review_id uuid,p_decision text,p_candidate_patient_id uuid default null,p_comment text default null
) returns table(review_id uuid,decision text,linked_patient_id uuid,row_status text)
language plpgsql security invoker set search_path=''
as $function$
declare
 v_user uuid:=auth.uid(); v_review public.patient_identity_review_requests%rowtype;
 v_candidate public.patients%rowtype; v_import public.data_imports%rowtype;
 v_source public.import_rows%rowtype; v_existing public.patient_source_links%rowtype;
 v_status text; v_rows integer; v_comment text:=nullif(btrim(coalesce(p_comment,'')),'');
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if p_decision is null or p_decision not in ('confirmed_match','not_same_patient','unresolved') then raise exception 'Invalid identity review decision'; end if;
 if v_comment is null or length(v_comment)<10 then raise exception 'Evidence and rationale must contain at least 10 characters'; end if;
 select r.* into v_review from public.patient_identity_review_requests r where r.id=p_review_id for update;
 if not found then raise exception 'Identity review request not found'; end if;
 if v_review.decision='confirmed_match' and p_decision='confirmed_match' and v_review.candidate_patient_id=p_candidate_patient_id then
  select l.* into v_existing from public.patient_source_links l where l.tenant_id=v_review.tenant_id and l.import_row_id=v_review.import_row_id;
  if found and v_existing.patient_id=p_candidate_patient_id and v_existing.organization_id=v_review.organization_id then
   return query select v_review.id,'confirmed_match'::text,v_existing.patient_id,'identity_matched'::text; return;
  end if;
 end if;
 if v_review.decision<>'pending' then raise exception 'This identity review has already been decided'; end if;
 if not exists(select 1 from public.tenant_members tm where tm.tenant_id=v_review.tenant_id and tm.user_id=v_user and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','data_manager')) then
  raise exception 'Clinic administrator or data manager role required to finalize this identity decision';
 end if;
 select di.* into v_import from public.data_imports di where di.id=v_review.import_id and di.tenant_id=v_review.tenant_id and di.organization_id=v_review.organization_id for update;
 if not found then raise exception 'Import does not belong to this tenant and Organization'; end if;
 select ir.* into v_source from public.import_rows ir where ir.id=v_review.import_row_id and ir.import_id=v_review.import_id and ir.tenant_id=v_review.tenant_id for update;
 if not found then raise exception 'Source row does not belong to this tenant, import and Organization'; end if;
 if p_decision='confirmed_match' then
  if p_candidate_patient_id is null then raise exception 'Select the existing clinic Patient to confirm a match'; end if;
  select p.* into v_candidate from public.patients p where p.id=p_candidate_patient_id and p.tenant_id=v_review.tenant_id and p.organization_id=v_review.organization_id and p.local_mrn=v_review.incoming_mrn for update;
  if not found then raise exception 'Selected Patient does not match this clinic and incoming MRN'; end if;
  select l.* into v_existing from public.patient_source_links l where l.tenant_id=v_review.tenant_id and l.import_row_id=v_review.import_row_id;
  if found and (v_existing.patient_id<>v_candidate.id or v_existing.organization_id<>v_review.organization_id) then raise exception 'Source row is already linked to a different Patient'; end if;
  if not found then
   insert into public.patient_source_links(tenant_id,organization_id,patient_id,import_id,import_row_id,review_request_id,source_system_id,source_record_key,link_type,created_by)
   values(v_review.tenant_id,v_review.organization_id,v_candidate.id,v_review.import_id,v_review.import_row_id,v_review.id,v_import.source_system_id,coalesce(nullif(btrim(v_source.source_record_key),''),v_source.id::text),'confirmed_match',v_user);
  end if;
  update public.import_rows ir set processing_status='identity_matched',
   normalized_data=jsonb_set(coalesce(ir.normalized_data,'{}'::jsonb),'{identity_review}',jsonb_build_object('decision','confirmed_match','patient_id',v_candidate.id,'review_id',v_review.id,'reviewed_by',v_user,'reviewed_at',now()),true)
  where ir.id=v_review.import_row_id and ir.import_id=v_review.import_id and ir.tenant_id=v_review.tenant_id;
  get diagnostics v_rows=row_count; v_status:='identity_matched';
 else
  update public.import_rows ir set processing_status='identity_review',
   normalized_data=jsonb_set(coalesce(ir.normalized_data,'{}'::jsonb),'{identity_review}',jsonb_build_object('decision',p_decision,'review_id',v_review.id,'reviewed_by',v_user,'reviewed_at',now()),true)
  where ir.id=v_review.import_row_id and ir.import_id=v_review.import_id and ir.tenant_id=v_review.tenant_id;
  get diagnostics v_rows=row_count; v_status:='identity_review';
 end if;
 if v_rows<>1 then raise exception 'Expected exactly one source row update; found %',v_rows; end if;
 update public.patient_identity_review_requests rr set decision=p_decision,candidate_patient_id=case when p_decision='confirmed_match' then p_candidate_patient_id else null end,reviewer_comment=v_comment,reviewed_by=v_user,reviewed_at=now()
 where rr.id=v_review.id and rr.decision='pending';
 get diagnostics v_rows=row_count;
 if v_rows<>1 then raise exception 'Identity review was concurrently changed; no decision was recorded'; end if;
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
 values(v_review.tenant_id,v_user,'patient_identity_review_decided','patient_identity_review_request',v_review.id::text,'success',
 jsonb_build_object('decision',p_decision,'candidate_patient_id',case when p_decision='confirmed_match' then p_candidate_patient_id else null end,'import_row_id',v_review.import_row_id,'organization_id',v_review.organization_id,'mrn',v_review.incoming_mrn,'rationale',v_comment,'source_link_created',(p_decision='confirmed_match')));
 return query select v_review.id,p_decision,case when p_decision='confirmed_match' then p_candidate_patient_id else null end,v_status;
end;
$function$;
revoke execute on function public.decide_patient_identity_review(uuid,text,uuid,text) from public,anon;
grant execute on function public.decide_patient_identity_review(uuid,text,uuid,text) to authenticated;
