create or replace function public.open_patient_identity_review(
 p_tenant_id uuid,p_organization_id uuid,p_import_id uuid,p_import_row_id uuid,
 p_incoming_mrn text,p_incoming_snapshot jsonb
) returns table(review_id uuid,attempt_number integer,reused boolean)
language plpgsql security invoker set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_attempt integer; v_review public.patient_identity_review_requests%rowtype; v_row public.import_rows%rowtype;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.user_id=v_user and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','data_manager')) then raise exception 'Clinic administrator or data manager role required'; end if;
 select * into v_row from public.import_rows ir where ir.id=p_import_row_id and ir.import_id=p_import_id and ir.tenant_id=p_tenant_id for update;
 if not found then raise exception 'Import row not found in this tenant'; end if;
 if not exists(select 1 from public.data_imports di where di.id=p_import_id and di.tenant_id=p_tenant_id and di.organization_id=p_organization_id) then raise exception 'Import does not belong to this clinic Organization'; end if;
 select * into v_review from public.patient_identity_review_requests r where r.tenant_id=p_tenant_id and r.import_row_id=p_import_row_id and r.decision='pending' order by r.attempt_number desc limit 1;
 if found then return query select v_review.id,v_review.attempt_number,true; return; end if;
 select coalesce(max(r.attempt_number),0)+1 into v_attempt from public.patient_identity_review_requests r where r.tenant_id=p_tenant_id and r.import_row_id=p_import_row_id;
 insert into public.patient_identity_review_requests(tenant_id,organization_id,import_id,import_row_id,incoming_mrn,incoming_snapshot,attempt_number)
 values(p_tenant_id,p_organization_id,p_import_id,p_import_row_id,p_incoming_mrn,p_incoming_snapshot,v_attempt)
 returning * into v_review;
 return query select v_review.id,v_review.attempt_number,false;
end; $$;
revoke all on function public.open_patient_identity_review(uuid,uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.open_patient_identity_review(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
