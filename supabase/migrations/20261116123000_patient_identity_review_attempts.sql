-- Allow immutable, sequential review attempts per imported row.
alter table public.patient_identity_review_requests
  drop constraint if exists patient_identity_review_requests_tenant_id_import_row_id_key;
alter table public.patient_identity_review_requests
  add column if not exists attempt_number integer;
with ranked as (
  select id,row_number() over(partition by tenant_id,import_row_id order by created_at,id) as attempt
  from public.patient_identity_review_requests
)
update public.patient_identity_review_requests r
set attempt_number=ranked.attempt
from ranked where ranked.id=r.id and r.attempt_number is null;
alter table public.patient_identity_review_requests
  alter column attempt_number set default 1,
  alter column attempt_number set not null;
create unique index if not exists patient_identity_review_attempt_unique
  on public.patient_identity_review_requests(tenant_id,import_row_id,attempt_number);
create unique index if not exists patient_identity_review_one_pending_per_row
  on public.patient_identity_review_requests(tenant_id,import_row_id)
  where decision='pending';

-- Source MRN correction. Original source payload remains immutable.
create or replace function public.correct_patient_identity_mrn(p_review_id uuid,p_corrected_mrn text,p_comment text)
returns table(review_id uuid,corrected_mrn text,row_status text)
language plpgsql security invoker set search_path=''
as $$
declare
 v_user uuid:=auth.uid();
 v_review public.patient_identity_review_requests%rowtype;
 v_source_field text;
 v_conflict uuid;
 v_corrected text:=nullif(btrim(coalesce(p_corrected_mrn,'')),'');
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if v_corrected is null or length(v_corrected)>128 then raise exception 'Enter a valid corrected MRN (1–128 characters)'; end if;
 if nullif(btrim(coalesce(p_comment,'')),'') is null then raise exception 'Correction evidence is required'; end if;
 select * into v_review from public.patient_identity_review_requests where id=p_review_id for update;
 if not found or v_review.decision<>'pending' then raise exception 'A pending identity review is required'; end if;
 if not exists(select 1 from public.tenant_members tm where tm.tenant_id=v_review.tenant_id and tm.user_id=v_user and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','data_manager')) then raise exception 'Clinic administrator or data manager role required'; end if;
 select fm.source_field into v_source_field
 from public.field_mappings fm
 where fm.tenant_id=v_review.tenant_id and fm.import_id=v_review.import_id
   and fm.target_resource='Patient' and fm.target_field='identifier' and fm.status='approved'
 order by fm.updated_at desc,fm.created_at desc limit 1;
 if v_source_field is null then raise exception 'An approved Patient identifier mapping is required before correcting the MRN'; end if;
 if exists(select 1 from public.patients p where p.tenant_id=v_review.tenant_id and p.organization_id=v_review.organization_id and p.local_mrn=v_corrected) then
   raise exception 'Corrected MRN already belongs to a Patient in this clinic. Use identity match review instead';
 end if;
 select ir.id into v_conflict
 from public.import_rows ir
 join public.data_imports di on di.id=ir.import_id and di.tenant_id=ir.tenant_id
 join public.field_mappings fm on fm.tenant_id=ir.tenant_id and fm.import_id=ir.import_id
   and fm.target_resource='Patient' and fm.target_field='identifier' and fm.status='approved'
 where ir.tenant_id=v_review.tenant_id and di.organization_id=v_review.organization_id
   and ir.id<>v_review.import_row_id
   and btrim(coalesce(ir.original_data->>fm.source_field,''))=v_corrected
 limit 1;
 if v_conflict is not null then raise exception 'Corrected MRN already appears in another imported source row in this clinic'; end if;
 update public.import_rows
 set normalized_data=jsonb_set(coalesce(normalized_data,'{}'::jsonb),'{source_mrn_correction}',
   jsonb_build_object('original_mrn',v_review.incoming_mrn,'corrected_mrn',v_corrected,
     'reason',btrim(p_comment),'source_field',v_source_field,'reviewed_by',v_user,'reviewed_at',now()),true),
   processing_status='profiled'
 where id=v_review.import_row_id and import_id=v_review.import_id and tenant_id=v_review.tenant_id;
 if not found then raise exception 'Source import row is no longer available'; end if;
 update public.patient_identity_review_requests
 set decision='not_same_patient',reviewer_comment=btrim(p_comment),reviewed_by=v_user,reviewed_at=now()
 where id=v_review.id and decision='pending';
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
 values(v_review.tenant_id,v_user,'patient_source_mrn_corrected','import_row',v_review.import_row_id::text,'success',
   jsonb_build_object('review_id',v_review.id,'attempt_number',v_review.attempt_number,
     'original_mrn',v_review.incoming_mrn,'corrected_mrn',v_corrected,'source_field',v_source_field));
 return query select v_review.id,v_corrected,'profiled'::text;
end; $$;
revoke all on function public.correct_patient_identity_mrn(uuid,text,text) from public,anon;
grant execute on function public.correct_patient_identity_mrn(uuid,text,text) to authenticated;
