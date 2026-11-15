alter table public.patient_correction_requests
  add column if not exists applied_at timestamptz,
  add column if not exists applied_by uuid references auth.users(id),
  add column if not exists resulting_fhir_resource_id uuid references public.fhir_resources(id);

create or replace function public.apply_approved_patient_name_correction(p_request_id uuid)
returns table(request_id uuid, patient_id uuid, fhir_resource_id uuid, application_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.patient_correction_requests%rowtype;
  v_patient public.patients%rowtype;
  v_old_fhir public.fhir_resources%rowtype;
  v_current_name text;
  v_new_name text;
  v_canonical_name jsonb;
  v_payload jsonb;
  v_new_resource_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_request from public.patient_correction_requests where id = p_request_id for update;
  if not found then raise exception 'Correction request not found'; end if;
  if v_request.status <> 'approved' then raise exception 'Only an approved correction request can be applied'; end if;
  if v_request.applied_at is not null then raise exception 'This correction request has already been applied'; end if;
  if v_request.field_path <> 'Patient.name' then raise exception 'This application function supports Patient.name only'; end if;
  if not private.has_tenant_role(v_request.tenant_id, array['tenant_admin','clinic_admin','data_manager']::text[]) then
    raise exception 'Insufficient tenant role to apply a Patient correction';
  end if;
  select * into v_patient from public.patients
    where id = v_request.patient_id and tenant_id = v_request.tenant_id for update;
  if not found then raise exception 'Patient not found in the correction request tenant'; end if;
  v_current_name := coalesce((
    select string_agg(coalesce(n->>'text', concat_ws(' ', n->>'given', n->>'family')), ', ')
    from jsonb_array_elements(v_patient.name) as n
  ), '');
  if v_request.original_value <> to_jsonb(v_current_name) then
    raise exception 'Patient name changed after the proposal was created; a new review request is required';
  end if;
  if jsonb_typeof(v_request.proposed_value) <> 'string' then raise exception 'Proposed Patient.name must be a string'; end if;
  v_new_name := btrim(v_request.proposed_value #>> '{}');
  if v_new_name = '' then raise exception 'Proposed Patient.name cannot be empty'; end if;
  select * into v_old_fhir from public.fhir_resources
    where tenant_id = v_request.tenant_id and patient_id = v_request.patient_id and resource_type = 'Patient'
    order by generated_at desc limit 1 for update;
  if not found then raise exception 'No FHIR Patient draft exists; correction cannot be applied'; end if;
  v_canonical_name := jsonb_build_array(jsonb_build_object('text', v_new_name, 'use', 'official'));
  v_payload := jsonb_set(v_old_fhir.payload, '{name}', v_canonical_name, true);
  update public.patients set name = v_canonical_name,
    provenance = jsonb_set(coalesce(provenance, '{}'::jsonb), '{last_human_correction}',
      jsonb_build_object('request_id',v_request.id,'field_path',v_request.field_path,'applied_by',v_user_id,
        'applied_at',now(),'reason',v_request.reason,'source_preserved',true), true),
    updated_at = now()
    where id = v_patient.id and tenant_id = v_request.tenant_id;
  insert into public.fhir_resources (
    tenant_id,patient_id,resource_type,fhir_version,profile_urls,payload,payload_hash,status,source_record_reference,created_by
  ) values (
    v_request.tenant_id,v_request.patient_id,'Patient',v_old_fhir.fhir_version,v_old_fhir.profile_urls,
    v_payload,null,'draft',v_old_fhir.source_record_reference,v_user_id
  ) returning id into v_new_resource_id;
  insert into public.validation_results (
    tenant_id,fhir_resource_id,validator,validator_version,conformance_scope,outcome,issues
  ) values (
    v_request.tenant_id,v_new_resource_id,'satucore-correction-gate','0.1.0','fhir_r4','warning',
    jsonb_build_array(jsonb_build_object('code','REVALIDATION_REQUIRED','severity','warning',
      'message','A new Patient FHIR draft was generated after the approved name correction. Run the full FHIR R4 and SATUSEHAT Patient profile validation before approval or transmission.'))
  );
  update public.patient_correction_requests set applied_at=now(),applied_by=v_user_id,resulting_fhir_resource_id=v_new_resource_id
    where id=v_request.id and tenant_id=v_request.tenant_id and status='approved' and applied_at is null;
  insert into public.audit_logs (tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
  values (v_request.tenant_id,v_user_id,'patient_correction_applied','patient_correction_request',v_request.id::text,'success',
    jsonb_build_object('patient_id',v_request.patient_id,'field_path',v_request.field_path,
      'resulting_fhir_resource_id',v_new_resource_id,'previous_fhir_resource_id',v_old_fhir.id,
      'source_record_unchanged',true,'validation_status','revalidation_required'));
  return query select v_request.id,v_request.patient_id,v_new_resource_id,'applied_draft_requires_revalidation'::text;
end;
$$;
revoke all on function public.apply_approved_patient_name_correction(uuid) from public, anon;
grant execute on function public.apply_approved_patient_name_correction(uuid) to authenticated;
