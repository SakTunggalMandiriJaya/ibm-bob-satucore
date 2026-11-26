-- SATUCORE Phase 3 production reconciliation
-- Reconciles the 2026-11-20 local Patient correction and validated-draft
-- migrations with production head 20261121054016.
-- Scope: Patient correction review/application and validated Patient creation.
-- Does NOT submit to SATUSEHAT or alter Phase 4 SEND controls.
--
-- SECURITY: correction RPCs use SECURITY DEFINER only because direct
-- authenticated UPDATE is revoked. Both RPCs explicitly require auth.uid(),
-- verify tenant roles, use an empty search_path, and qualify object names.
-- Patient creation remains SECURITY INVOKER.

BEGIN;

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

-- Direct authenticated UPDATE is replaced by this controlled RPC.
drop policy if exists patient_correction_requests_reviewer_update
on public.patient_correction_requests;

create or replace function public.review_patient_correction_request(
  p_request_id uuid,
  p_decision text,
  p_comment text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_request public.patient_correction_requests%rowtype;
  v_updated_count integer;
  v_comment text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_decision is null
   or p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select *
  into v_request
  from public.patient_correction_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Correction request not found';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Only pending correction requests may be reviewed';
  end if;

  if not private.has_tenant_role(
    v_request.tenant_id,
    array['tenant_admin', 'clinic_admin', 'reviewer']::text[]
  ) then
    raise exception 'Not authorized to review this correction request';
  end if;

  v_comment := coalesce(
    nullif(btrim(p_comment), ''),
    case
      when p_decision = 'approved'
        then 'Approved by an authorized human reviewer.'
      else 'Rejected by an authorized human reviewer.'
    end
  );

  update public.patient_correction_requests
  set
    status = p_decision,
    reviewed_by = v_user_id,
    reviewed_at = now(),
    review_comment = v_comment
  where id = p_request_id
    and tenant_id = v_request.tenant_id
    and status = 'pending';

  get diagnostics v_updated_count = row_count;

  if v_updated_count <> 1 then
    raise exception
      'Expected exactly one correction request to be reviewed; updated %',
      v_updated_count;
  end if;

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
    case
      when p_decision = 'approved'
        then 'patient_correction_approved'
      else 'patient_correction_rejected'
    end,
    'patient_correction_request',
    v_request.id::text,
    'success',
    jsonb_build_object(
      'patient_id', v_request.patient_id,
      'field_path', v_request.field_path,
      'decision', p_decision,
      'review_comment', v_comment
    )
  );
end;
$$;

revoke all on function
  public.review_patient_correction_request(uuid, text, text)
from public, anon;

grant execute on function
  public.review_patient_correction_request(uuid, text, text)
to authenticated;

CREATE OR REPLACE FUNCTION public.create_patient_from_validated_import(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_import_id uuid,
  p_import_row_id uuid,
  p_validation_report_id uuid,
  p_canonical jsonb,
  p_fhir_patient jsonb,
  p_issues jsonb,
  p_fhir_payload_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_row public.import_rows%rowtype;
  v_import public.data_imports%rowtype;
  v_draft public.patient_drafts%rowtype;
  v_report public.patient_draft_validation_reports%rowtype;
  v_patient_id uuid;
  v_resource_id uuid;
  v_link_id uuid;
  v_mrn text;
  v_nik text;
  v_outcome text;
  v_source_reference text;
BEGIN
  -- Authentication and tenant authorization
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT private.has_tenant_role(
    p_tenant_id,
    ARRAY['tenant_admin','clinic_admin','data_manager']::text[]
  ) THEN
    RAISE EXCEPTION 'Not authorized for this clinic';
  END IF;

  -- Basic request shape
  IF jsonb_typeof(p_canonical) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_fhir_patient) IS DISTINCT FROM 'object'
     OR p_fhir_patient->>'resourceType' IS DISTINCT FROM 'Patient'
     OR jsonb_typeof(p_issues) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Canonical Patient, FHIR Patient or issues payload has invalid shape';
  END IF;

  IF p_fhir_payload_hash IS NULL
     OR p_fhir_payload_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'Invalid FHIR payload hash';
  END IF;

  -- Preserve existing lock order: import, then source row.
  SELECT *
  INTO v_import
  FROM public.data_imports
  WHERE id = p_import_id
    AND tenant_id = p_tenant_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import does not belong to this tenant and Organization';
  END IF;

  SELECT *
  INTO v_row
  FROM public.import_rows
  WHERE id = p_import_row_id
    AND import_id = p_import_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source row does not belong to this tenant and import';
  END IF;

  -- Identity review must be resolved before creating a new Patient.
  IF v_row.processing_status = 'identity_review'
     OR EXISTS (
       SELECT 1
       FROM public.patient_identity_review_requests r
       WHERE r.tenant_id = p_tenant_id
         AND r.import_id = p_import_id
         AND r.import_row_id = p_import_row_id
         AND r.decision = 'pending'
     )
  THEN
    RAISE EXCEPTION
      'Identity review is pending; Patient creation is blocked until a human decision';
  END IF;

  -- Lock the one authoritative Patient Draft for this source row.
  SELECT *
  INTO v_draft
  FROM public.patient_drafts d
  WHERE d.tenant_id = p_tenant_id
    AND d.import_id = p_import_id
    AND d.import_row_id = p_import_row_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A persisted Patient Draft is required';
  END IF;

  IF v_draft.status IS DISTINCT FROM 'validated'
     OR v_draft.validation_report_id IS DISTINCT FROM p_validation_report_id
     OR v_draft.row_number IS DISTINCT FROM v_row.row_number
     OR v_draft.validated_at IS NULL
  THEN
    RAISE EXCEPTION
      'Patient Draft is not currently validated against the supplied report and source row';
  END IF;

  -- Load the exact report bound to the locked draft.
  SELECT *
  INTO v_report
  FROM public.patient_draft_validation_reports r
  WHERE r.id = p_validation_report_id
    AND r.tenant_id = p_tenant_id
    AND r.import_id = p_import_id
    AND r.import_row_id = p_import_row_id
    AND r.row_number = v_row.row_number
    AND r.outcome = 'passed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A matching passing Patient validation report is required';
  END IF;

  -- Do not mistake partial local checks for SATUSEHAT conformance.
  IF v_report.validator IS DISTINCT FROM 'satucore-patient-local'
     OR v_report.validator_version IS DISTINCT FROM '0.2.0'
     OR v_report.conformance_scope IS DISTINCT FROM
       'local_deterministic_checks; fhir_r4_structure_partial; satusehat_profile_not_executed'
  THEN
    RAISE EXCEPTION
      'Validation report does not have the required Patient validator identity and scope';
  END IF;

  -- Verify the complete persisted validation lineage.
  IF v_report.payload_hash IS DISTINCT FROM v_draft.payload_hash
     OR v_report.input_hash IS DISTINCT FROM v_draft.input_hash
     OR v_report.approved_mappings IS DISTINCT FROM v_draft.mapping_snapshot
  THEN
    RAISE EXCEPTION
      'Validation report does not match the current Patient Draft lineage';
  END IF;

  -- Bind all submitted data to the persisted, validated draft.
  IF p_fhir_payload_hash IS DISTINCT FROM v_draft.payload_hash THEN
    RAISE EXCEPTION 'Submitted FHIR hash does not match the validated Patient Draft';
  END IF;

  IF p_fhir_patient IS DISTINCT FROM v_draft.fhir_patient THEN
    RAISE EXCEPTION 'Submitted FHIR Patient differs from the validated Patient Draft';
  END IF;

  IF p_canonical IS DISTINCT FROM v_draft.canonical_patient THEN
    RAISE EXCEPTION 'Submitted canonical Patient differs from the validated Patient Draft';
  END IF;

  IF p_issues IS DISTINCT FROM v_report.issues
     OR jsonb_array_length(v_report.issues) <> 0
  THEN
    RAISE EXCEPTION
      'A passed Patient report must match the submitted issues and contain no issues';
  END IF;

  -- Existing duplicate-source safeguards.
  IF EXISTS (
    SELECT 1
    FROM public.patient_source_links
    WHERE tenant_id = p_tenant_id
      AND import_row_id = p_import_row_id
  ) THEN
    RAISE EXCEPTION 'This source row is already linked to a Patient';
  END IF;

  v_source_reference := 'import_rows/' || p_import_row_id::text;

  IF EXISTS (
    SELECT 1
    FROM public.patients
    WHERE tenant_id = p_tenant_id
      AND source_record_reference = v_source_reference
  ) THEN
    RAISE EXCEPTION 'This source row already has a canonical Patient';
  END IF;

  -- Existing MRN/NIK extraction and format checks.
  v_mrn := NULLIF(BTRIM(p_canonical->>'local_mrn'), '');

  SELECT NULLIF(BTRIM(identifier->>'value'), '')
  INTO v_nik
  FROM jsonb_array_elements(
    COALESCE(p_canonical->'source_identifiers', '[]'::jsonb)
  ) AS identifiers(identifier)
  WHERE identifier->>'system' = 'urn:satucore:source-nik'
  LIMIT 1;

  IF v_nik IS NOT NULL AND v_nik !~ '^[0-9]{16}$' THEN
    RAISE EXCEPTION
      'NIK_INVALID_FORMAT: The canonical NIK must contain exactly 16 digits';
  END IF;

  IF v_mrn IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || ':' ||
        p_organization_id::text || ':' ||
        v_mrn,
        0
      )
    );

    IF EXISTS (
      SELECT 1
      FROM public.patients
      WHERE tenant_id = p_tenant_id
        AND organization_id = p_organization_id
        AND local_mrn = v_mrn
    ) THEN
      RAISE EXCEPTION
        'MRN_CONFLICT: This source MRN already exists in this clinic. Identity review is required.';
    END IF;
  END IF;

  IF v_nik IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || ':urn:satucore:source-nik:' || v_nik,
        0
      )
    );

    IF EXISTS (
      SELECT 1
      FROM public.patient_identifiers
      WHERE tenant_id = p_tenant_id
        AND system = 'urn:satucore:source-nik'
        AND value = v_nik
    ) THEN
      RAISE EXCEPTION
        'NIK_CONFLICT: This NIK is already recorded for another Patient in this tenant. Human identity review is required.';
    END IF;
  END IF;

  -- Create canonical Patient.
  INSERT INTO public.patients(
    tenant_id,
    organization_id,
    local_mrn,
    active,
    name,
    birth_date,
    administrative_gender,
    telecom,
    addresses,
    source_identifiers,
    source_record_reference,
    provenance
  )
  VALUES (
    p_tenant_id,
    p_organization_id,
    v_mrn,
    COALESCE((p_canonical->>'active')::boolean, true),
    COALESCE(p_canonical->'name', '[]'::jsonb),
    NULLIF(p_canonical->>'birth_date', '')::date,
    NULLIF(p_canonical->>'administrative_gender', ''),
    COALESCE(p_canonical->'telecom', '[]'::jsonb),
    COALESCE(p_canonical->'addresses', '[]'::jsonb),
    COALESCE(p_canonical->'source_identifiers', '[]'::jsonb),
    v_source_reference,
    COALESCE(p_canonical->'provenance', '{}'::jsonb)
  )
  RETURNING id INTO v_patient_id;

  -- Source MRN remains unverified.
  IF v_mrn IS NOT NULL THEN
    INSERT INTO public.patient_identifiers(
      tenant_id,
      patient_id,
      system,
      value,
      identifier_type,
      is_primary,
      verification_status
    )
    VALUES (
      p_tenant_id,
      v_patient_id,
      'urn:satucore:source-mrn',
      v_mrn,
      'MR',
      true,
      'unverified'
    );
  END IF;

  -- NIK is recorded as unverified, never as proof of identity.
  IF v_nik IS NOT NULL THEN
    INSERT INTO public.patient_identifiers(
      tenant_id,
      patient_id,
      system,
      value,
      identifier_type,
      is_primary,
      verification_status
    )
    VALUES (
      p_tenant_id,
      v_patient_id,
      'urn:satucore:source-nik',
      v_nik,
      NULL,
      false,
      'unverified'
    );
  END IF;

  -- Create FHIR Patient draft; this does not transmit to SATUSEHAT.
  INSERT INTO public.fhir_resources(
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
  VALUES (
    p_tenant_id,
    v_patient_id,
    'Patient',
    '4.0.1',
    ARRAY['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient'],
    p_fhir_patient,
    p_fhir_payload_hash,
    'draft',
    v_source_reference,
    v_user_id
  )
  RETURNING id INTO v_resource_id;

  -- A passed report with no issues yields passed local validation.
  v_outcome := 'passed';

    INSERT INTO public.validation_results(
    tenant_id,
    fhir_resource_id,
    validator,
    validator_version,
    conformance_scope,
    outcome,
    issues
  )
  VALUES (
    p_tenant_id,
    v_resource_id,
    v_report.validator,
    v_report.validator_version,
    v_report.conformance_scope,
    v_outcome,
    p_issues
  );

  -- Link source row to the newly created Patient.
  INSERT INTO public.patient_source_links(
    tenant_id,
    organization_id,
    patient_id,
    import_id,
    import_row_id,
    source_system_id,
    source_record_key,
    link_type,
    created_by
  )
  VALUES (
    p_tenant_id,
    p_organization_id,
    v_patient_id,
    p_import_id,
    p_import_row_id,
    v_import.source_system_id,
    v_row.source_record_key,
    'new_patient',
    v_user_id
  )
  RETURNING id INTO v_link_id;

  UPDATE public.import_rows
  SET normalized_data = p_canonical,
      processing_status = 'processed',
      issues = p_issues
  WHERE id = p_import_row_id
    AND tenant_id = p_tenant_id;

  INSERT INTO public.audit_logs(
    tenant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outcome,
    metadata
  )
  VALUES (
    p_tenant_id,
    v_user_id,
    'canonical_patient_created',
    'patient',
    v_patient_id::text,
    'success',
    jsonb_build_object(
      'fhir_resource_id', v_resource_id,
      'source_link_id', v_link_id,
      'import_id', p_import_id,
      'import_row_id', p_import_row_id,
      'validation_outcome', v_outcome,
      'validation_report_id', p_validation_report_id,
      'source_nik_recorded', (v_nik IS NOT NULL)
    )
  );

  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'resource_id', v_resource_id,
    'source_link_id', v_link_id,
    'outcome', v_outcome
  );
END;
$function$;

-- Preserve the live function's existing execution grants.
REVOKE ALL ON FUNCTION public.create_patient_from_validated_import(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_patient_from_validated_import(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_patient_from_validated_import(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text
) TO service_role;

COMMIT;
