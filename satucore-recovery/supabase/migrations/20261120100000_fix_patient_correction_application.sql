
-- SATUCORE: Patient Correction application integrity repair
-- Creates a new FHIR Patient draft after an approved human correction.
-- Does not execute or submit any SATUSEHAT transaction.

begin;

-- 1. Replace the integrity trigger with explicit permitted transitions.
create or replace function public.enforce_patient_correction_request_integrity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.patients p
    where p.id = new.patient_id
      and p.tenant_id = new.tenant_id
  ) then
    raise exception 'Patient does not belong to the correction request tenant';
  end if;

  if new.fhir_resource_id is not null and not exists (
    select 1
    from public.fhir_resources fr
    where fr.id = new.fhir_resource_id
      and fr.tenant_id = new.tenant_id
      and fr.patient_id = new.patient_id
      and fr.resource_type = 'Patient'
  ) then
    raise exception 'FHIR resource does not belong to the selected Patient and tenant';
  end if;

  if tg_op = 'UPDATE' then

    -- Immutable proposal evidence and identity references.
    if new.tenant_id is distinct from old.tenant_id
       or new.patient_id is distinct from old.patient_id
       or new.fhir_resource_id is distinct from old.fhir_resource_id
       or new.field_path is distinct from old.field_path
       or new.original_value is distinct from old.original_value
       or new.proposed_value is distinct from old.proposed_value
       or new.reason is distinct from old.reason
       or new.requested_by is distinct from old.requested_by
       or new.created_at is distinct from old.created_at then
      raise exception 'Correction request evidence is immutable after submission';
    end if;

    -- Transition 1: pending -> approved/rejected.
    if old.status = 'pending' then

      if old.reviewed_by is not null
         or old.reviewed_at is not null then
        raise exception 'Pending correction request already contains review metadata';
      end if;

      if new.status not in ('approved', 'rejected')
         or new.reviewed_by is distinct from auth.uid()
         or new.reviewed_at is null
         or new.applied_at is not null
         or new.applied_by is not null
         or new.resulting_fhir_resource_id is not null then
        raise exception 'Invalid Patient correction review transition';
      end if;

      if not private.has_tenant_role(
        old.tenant_id,
        array['tenant_admin', 'clinic_admin', 'reviewer']::text[]
      ) then
        raise exception 'Insufficient tenant role to review a Patient correction';
      end if;

    -- Transition 2: approved -> applied metadata, exactly once.
    elsif old.status = 'approved' then

      if old.applied_at is not null
         or old.applied_by is not null
         or old.resulting_fhir_resource_id is not null then
        raise exception 'Approved correction request already contains application metadata';
      end if;

      if new.status is distinct from old.status
         or new.applied_at is null
         or new.applied_by is distinct from auth.uid()
         or new.resulting_fhir_resource_id is null
         or new.reviewed_by is distinct from old.reviewed_by
         or new.reviewed_at is distinct from old.reviewed_at
         or new.review_comment is distinct from old.review_comment then
        raise exception 'Invalid Patient correction application transition';
      end if;

      if not private.has_tenant_role(
        old.tenant_id,
        array['tenant_admin', 'clinic_admin', 'data_manager']::text[]
      ) then
        raise exception 'Insufficient tenant role to apply a Patient correction';
      end if;

      if not exists (
        select 1
        from public.fhir_resources fr
        where fr.id = new.resulting_fhir_resource_id
          and fr.tenant_id = new.tenant_id
          and fr.patient_id = new.patient_id
          and fr.resource_type = 'Patient'
          and fr.status = 'draft'
      ) then
        raise exception 'Resulting FHIR Patient draft does not match the correction request';
      end if;

    else
      raise exception 'Only pending requests can be reviewed and approved requests can be applied';
    end if;
  end if;

  return new;
end;
$$;


-- 2. Replace application RPC with a narrowly authorized SECURITY DEFINER function.
create or replace function public.apply_approved_patient_name_correction(
  p_request_id uuid
)
returns table(
  request_id uuid,
  patient_id uuid,
  fhir_resource_id uuid,
  application_status text
)
language plpgsql
security definer
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
  v_updated_count integer;
begin

  -- Authentication.
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Lock the correction request.
  select *
  into v_request
  from public.patient_correction_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Correction request not found';
  end if;

  if v_request.status <> 'approved' then
    raise exception 'Only an approved correction request can be applied';
  end if;

  if v_request.applied_at is not null then
    raise exception 'This correction request has already been applied';
  end if;

  if v_request.field_path <> 'Patient.name' then
    raise exception 'This application function supports Patient.name only';
  end if;

  -- Tenant authorization.
  if not private.has_tenant_role(
    v_request.tenant_id,
    array['tenant_admin', 'clinic_admin', 'data_manager']::text[]
  ) then
    raise exception 'Insufficient tenant role to apply a Patient correction';
  end if;

  -- Lock the canonical Patient.
  select *
  into v_patient
  from public.patients
  where id = v_request.patient_id
    and tenant_id = v_request.tenant_id
  for update;

  if not found then
    raise exception 'Patient not found in the correction request tenant';
  end if;

  -- Validate canonical Patient.name structure.
  if jsonb_typeof(v_patient.name) is distinct from 'array' then
    raise exception 'Patient name must be a JSON array before correction';
  end if;

  -- Reconstruct the current name for stale-proposal detection.
  v_current_name := coalesce((
    select string_agg(
      coalesce(
        n->>'text',
        concat_ws(' ', n->>'given', n->>'family')
      ),
      ', '
    )
    from jsonb_array_elements(v_patient.name) as n
  ), '');

  if v_request.original_value <> to_jsonb(v_current_name) then
    raise exception 'Patient name changed after proposal; a new review request is required';
  end if;

  -- Validate proposed name.
  if jsonb_typeof(v_request.proposed_value) is distinct from 'string' then
    raise exception 'Proposed Patient.name must be a string';
  end if;

  v_new_name := btrim(v_request.proposed_value #>> '{}');

  if v_new_name = '' then
    raise exception 'Proposed Patient.name cannot be empty';
  end if;

  -- Lock the latest existing FHIR Patient resource.
  select *
  into v_old_fhir
  from public.fhir_resources
  where tenant_id = v_request.tenant_id
    and patient_id = v_request.patient_id
    and resource_type = 'Patient'
  order by generated_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No FHIR Patient resource exists; correction cannot be applied';
  end if;

  -- Validate previous FHIR payload structure.
  if jsonb_typeof(v_old_fhir.payload) is distinct from 'object' then
    raise exception 'Existing FHIR Patient payload must be a JSON object';
  end if;

  -- Construct the corrected canonical Patient name.
  v_canonical_name := jsonb_build_array(
    jsonb_build_object(
      'text', v_new_name,
      'use', 'official'
    )
  );

  -- Create a new FHIR payload without overwriting the previous resource.
  v_payload := jsonb_set(
    v_old_fhir.payload,
    '{name}',
    v_canonical_name,
    true
  );

  -- Update canonical Patient with correction provenance.
  update public.patients
  set
    name = v_canonical_name,
    provenance = jsonb_set(
      coalesce(provenance, '{}'::jsonb),
      '{last_human_correction}',
      jsonb_build_object(
        'request_id', v_request.id,
        'field_path', v_request.field_path,
        'applied_by', v_user_id,
        'applied_at', now(),
        'reason', v_request.reason,
        'source_preserved', true
      ),
      true
    ),
    updated_at = now()
  where id = v_patient.id
    and tenant_id = v_request.tenant_id;

  -- Create a separate FHIR Patient draft.
  insert into public.fhir_resources (
    tenant_id,
    patient_id,
    resource_type,
    fhir_version,
    profile_urls,
    payload,
    payload_hash,
    status,
    source_record_reference,
    created_by
  )
  values (
    v_request.tenant_id,
    v_request.patient_id,
    'Patient',
    v_old_fhir.fhir_version,
    v_old_fhir.profile_urls,
    v_payload,
    null,
    'draft',
    v_old_fhir.source_record_reference,
    v_user_id
  )
  returning id into v_new_resource_id;

  -- Record mandatory revalidation warning.
  insert into public.validation_results (
    tenant_id,
    fhir_resource_id,
    validator,
    validator_version,
    conformance_scope,
    outcome,
    issues
  )
  values (
    v_request.tenant_id,
    v_new_resource_id,
    'satucore-correction-gate',
    '0.1.0',
    'fhir_r4',
    'warning',
    jsonb_build_array(
      jsonb_build_object(
        'code', 'REVALIDATION_REQUIRED',
        'severity', 'warning',
        'message',
        'A new Patient FHIR draft was generated after the approved name correction. Full FHIR R4 and SATUSEHAT Patient profile validation is required before approval or transmission.'
      )
    )
  );

  -- Mark the correction request as applied exactly once.
  update public.patient_correction_requests
  set
    applied_at = now(),
    applied_by = v_user_id,
    resulting_fhir_resource_id = v_new_resource_id
  where id = v_request.id
    and tenant_id = v_request.tenant_id
    and status = 'approved'
    and applied_at is null;

  get diagnostics v_updated_count = row_count;

  if v_updated_count <> 1 then
    raise exception
      'Expected exactly one correction request to be marked applied; updated %',
      v_updated_count;
  end if;

  -- Record application audit in the same transaction.
  insert into public.audit_logs (
    tenant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outcome,
    metadata
  )
  values (
    v_request.tenant_id,
    v_user_id,
    'patient_correction_applied',
    'patient_correction_request',
    v_request.id::text,
    'success',
    jsonb_build_object(
      'patient_id', v_request.patient_id,
      'field_path', v_request.field_path,
      'resulting_fhir_resource_id', v_new_resource_id,
      'previous_fhir_resource_id', v_old_fhir.id,
      'source_record_unchanged', true,
      'validation_status', 'revalidation_required'
    )
  );

  return query
  select
    v_request.id,
    v_request.patient_id,
    v_new_resource_id,
    'applied_draft_requires_revalidation'::text;
end;
$$;


-- 3. Restrict RPC execution.
revoke all on function
  public.apply_approved_patient_name_correction(uuid)
from public, anon;

grant execute on function
  public.apply_approved_patient_name_correction(uuid)
to authenticated;


-- 4. Prevent direct authenticated table updates.
-- Approval and application must use the controlled RPC functions.
revoke update on table public.patient_correction_requests
from authenticated;

revoke update (
  id, tenant_id, patient_id, fhir_resource_id, field_path,
  original_value, proposed_value, reason, status, requested_by,
  reviewed_by, review_comment, created_at, reviewed_at,
  applied_at, applied_by, resulting_fhir_resource_id
) on table public.patient_correction_requests
from authenticated;

commit;
