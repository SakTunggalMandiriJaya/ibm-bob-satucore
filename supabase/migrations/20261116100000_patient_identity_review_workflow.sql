create table if not exists public.patient_identity_review_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  import_id uuid not null references public.data_imports(id) on delete restrict,
  import_row_id uuid not null references public.import_rows(id) on delete restrict,
  incoming_mrn text not null,
  incoming_snapshot jsonb not null default '{}'::jsonb,
  candidate_patient_id uuid references public.patients(id) on delete restrict,
  decision text not null default 'pending' check (decision in ('pending','confirmed_match','not_same_patient','unresolved')),
  reviewer_comment text,
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, import_row_id)
);
create index if not exists idx_patient_identity_review_tenant_status on public.patient_identity_review_requests(tenant_id,decision,created_at desc);
alter table public.patient_identity_review_requests enable row level security;
create policy patient_identity_review_select_tenant on public.patient_identity_review_requests for select to authenticated
using (exists(select 1 from public.tenant_members tm where tm.tenant_id=patient_identity_review_requests.tenant_id and tm.user_id=(select auth.uid()) and tm.status='active'));
create policy patient_identity_review_insert_tenant on public.patient_identity_review_requests for insert to authenticated
with check (reviewed_by is null and decision='pending'
 and exists(select 1 from public.tenant_members tm where tm.tenant_id=patient_identity_review_requests.tenant_id and tm.user_id=(select auth.uid()) and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','data_manager','clinician','reviewer'))
 and exists(select 1 from public.import_rows ir where ir.id=patient_identity_review_requests.import_row_id and ir.import_id=patient_identity_review_requests.import_id and ir.tenant_id=patient_identity_review_requests.tenant_id));
create policy patient_identity_review_update_tenant on public.patient_identity_review_requests for update to authenticated
using (decision='pending' and exists(select 1 from public.tenant_members tm where tm.tenant_id=patient_identity_review_requests.tenant_id and tm.user_id=(select auth.uid()) and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','data_manager')))
with check (reviewed_by=(select auth.uid()) and reviewed_at is not null and decision in ('confirmed_match','not_same_patient','unresolved'));
grant select,insert,update on public.patient_identity_review_requests to authenticated;
revoke all on public.patient_identity_review_requests from anon;
create or replace function public.decide_patient_identity_review(p_review_id uuid,p_decision text,p_candidate_patient_id uuid default null,p_comment text default null)
returns table(review_id uuid,decision text,linked_patient_id uuid,row_status text)
language plpgsql security invoker set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_review public.patient_identity_review_requests%rowtype; v_candidate public.patients%rowtype; v_status text;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if p_decision not in ('confirmed_match','not_same_patient','unresolved') then raise exception 'Invalid identity review decision'; end if;
 select * into v_review from public.patient_identity_review_requests where id=p_review_id for update;
 if not found then raise exception 'Identity review request not found'; end if;
 if v_review.decision<>'pending' then raise exception 'This identity review has already been decided'; end if;
 if not exists(select 1 from public.tenant_members tm where tm.tenant_id=v_review.tenant_id and tm.user_id=v_user and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','reviewer')) then raise exception 'Reviewer role required for identity decision'; end if;
 if p_decision='confirmed_match' then
  if p_candidate_patient_id is null then raise exception 'Select the existing clinic Patient to confirm a match'; end if;
  select * into v_candidate from public.patients where id=p_candidate_patient_id and tenant_id=v_review.tenant_id and organization_id=v_review.organization_id and local_mrn=v_review.incoming_mrn for update;
  if not found then raise exception 'Selected Patient does not match this clinic and incoming MRN'; end if;
  update public.import_rows set processing_status='identity_matched',
   normalized_data=jsonb_set(coalesce(normalized_data,'{}'::jsonb),'{identity_review}',jsonb_build_object('decision','confirmed_match','patient_id',v_candidate.id,'review_id',v_review.id,'reviewed_by',v_user,'reviewed_at',now()),true)
   where id=v_review.import_row_id and import_id=v_review.import_id and tenant_id=v_review.tenant_id;
  v_status:='identity_matched';
 elsif p_decision='not_same_patient' then
  update public.import_rows set processing_status='identity_review' where id=v_review.import_row_id and import_id=v_review.import_id and tenant_id=v_review.tenant_id;
  v_status:='identity_review';
 else
  update public.import_rows set processing_status='identity_review' where id=v_review.import_row_id and import_id=v_review.import_id and tenant_id=v_review.tenant_id;
  v_status:='identity_review';
 end if;
 update public.patient_identity_review_requests set decision=p_decision,candidate_patient_id=case when p_decision='confirmed_match' then p_candidate_patient_id else null end,reviewer_comment=nullif(btrim(coalesce(p_comment,'')),''),reviewed_by=v_user,reviewed_at=now() where id=v_review.id;
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
 values(v_review.tenant_id,v_user,'patient_identity_review_decided','patient_identity_review_request',v_review.id::text,'success',jsonb_build_object('decision',p_decision,'candidate_patient_id',p_candidate_patient_id,'import_row_id',v_review.import_row_id,'mrn',v_review.incoming_mrn));
 return query select v_review.id,p_decision,case when p_decision='confirmed_match' then p_candidate_patient_id else null end,v_status;
end; $$;
revoke all on function public.decide_patient_identity_review(uuid,text,uuid,text) from public,anon;
grant execute on function public.decide_patient_identity_review(uuid,text,uuid,text) to authenticated;