-- Remove row locking from immutable validation evidence.
-- Preserve exact report, tenant, source and hash checks.
BEGIN;

create or replace function public.create_patient_from_validated_import(
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
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.import_rows%rowtype;
  v_import public.data_imports%rowtype;
  v_draft public.patient_drafts%rowtype;
  v_report public.patient_draft_validation_reports%rowtype;
  v_patient_id uuid;
  v_resource_id uuid;
  v_link_id uuid;
  v_mrn text;
  v_outcome text;
  v_source_reference text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_tenant_role(
    p_tenant_id,
    array['tenant_admin','clinic_admin','data_manager']::text[]
  ) then
    raise exception 'Not authorized for this clinic';
  end if;

  if p_fhir_patient->>'resourceType' is distinct from 'Patient' then
    raise exception 'FHIR payload must be a Patient resource';
  end if;

  if jsonb_typeof(p_canonical) is distinct from 'object'
     or jsonb_typeof(p_issues) is distinct from 'array' then
    raise exception 'Canonical Patient and issues payload have invalid shape';
  end if;

  if p_fhir_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid FHIR payload hash';
  end if;

  -- Lock the import and exact source row.
  select *
    into v_import
    from public.data_imports
   where id = p_import_id
     and tenant_id = p_tenant_id
     and organization_id = p_organization_id
   for update;

  if not found then
    raise exception 'Import does not belong to this tenant and Organization';
  end if;

  select *
    into v_row
    from public.import_rows
   where id = p_import_row_id
     and import_id = p_import_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'Source row does not belong to this tenant and import';
  end if;

  -- Preserve existing identity-review protections.
  if v_row.processing_status = 'identity_review'
     or exists (
       select 1
         from public.patient_identity_review_requests r
        where r.tenant_id = p_tenant_id
          and r.import_id = p_import_id
          and r.import_row_id = p_import_row_id
          and r.decision = 'pending'
     ) then
    raise exception 'Identity review is pending; Patient creation is blocked until a human decision';
  end if;

  -- P0-1: Lock the authoritative persisted draft.
  select *
    into v_draft
    from public.patient_drafts d
   where d.tenant_id = p_tenant_id
     and d.import_id = p_import_id
     and d.import_row_id = p_import_row_id
     and d.row_number = v_row.row_number
   for update;

  if not found then
    raise exception 'Validated Patient draft not found';
  end if;

  if v_draft.status is distinct from 'validated' then
    raise exception 'Patient draft is not currently validated';
  end if;

  if v_draft.validation_report_id is distinct from p_validation_report_id then
    raise exception 'Validation report is not linked to the current draft';
  end if;

  -- Submitted content must be byte-semantically equivalent at JSON value level
  -- to the content stored in the validated draft.
  if v_draft.canonical_patient is distinct from p_canonical then
    raise exception 'Canonical Patient differs from validated draft';
  end if;

  if v_draft.fhir_patient is distinct from p_fhir_patient then
    raise exception 'FHIR Patient differs from validated draft';
  end if;

  -- Retrieve and lock the exact passing report.
  select *
    into v_report
    from public.patient_draft_validation_reports r
   where r.id = p_validation_report_id
     and r.tenant_id = p_tenant_id
     and r.import_id = p_import_id
     and r.import_row_id = p_import_row_id
     and r.row_number = v_row.row_number
     and r.outcome = 'passed'
   ;

  if not found then
    raise exception 'A matching passing Patient validation report is required';
  end if;

  -- Bind all persisted validation evidence to both the draft and RPC payload.
  if v_draft.payload_hash is distinct from v_report.payload_hash
     or v_draft.input_hash is distinct from v_report.input_hash
     or v_draft.mapping_snapshot is distinct from v_report.approved_mappings then
    raise exception 'Persisted draft and validation evidence do not match';
  end if;

  if p_fhir_payload_hash is distinct from v_draft.payload_hash then
    raise exception 'Submitted payload hash does not match validated draft';
  end if;

  if p_issues is distinct from v_report.issues then
    raise exception 'Submitted validation issues differ from validation report';
  end if;

  -- Existing duplicate source protection.
  if exists (
    select 1
      from public.patient_source_links
     where tenant_id = p_tenant_id
       and import_row_id = p_import_row_id
  ) then
    raise exception 'This source row is already linked to a Patient';
  end if;

  v_source_reference := 'import_rows/' || p_import_row_id::text;

  if exists (
    select 1
      from public.patients
     where tenant_id = p_tenant_id
       and source_record_reference = v_source_reference
  ) then
    raise exception 'This source row already has a canonical Patient';
  end if;

  -- Existing MRN concurrency protection.
  v_mrn := nullif(btrim(p_canonical->>'local_mrn'), '');

  if v_mrn is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || ':' || p_organization_id::text || ':' || v_mrn,
        0
      )
    );

    if exists (
      select 1
        from public.patients
       where tenant_id = p_tenant_id
         and organization_id = p_organization_id
         and local_mrn = v_mrn
    ) then
      raise exception 'MRN_CONFLICT: This source MRN already exists in this clinic. Identity review is required.';
    end if;
  end if;

  -- Existing atomic canonical Patient creation.
  insert into public.patients(
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
  values (
    p_tenant_id,
    p_organization_id,
    v_mrn,
    coalesce((p_canonical->>'active')::boolean, true),
    coalesce(p_canonical->'name', '[]'::jsonb),
    nullif(p_canonical->>'birth_date', '')::date,
    nullif(p_canonical->>'administrative_gender', ''),
    coalesce(p_canonical->'telecom', '[]'::jsonb),
    coalesce(p_canonical->'addresses', '[]'::jsonb),
    coalesce(p_canonical->'source_identifiers', '[]'::jsonb),
    v_source_reference,
    coalesce(p_canonical->'provenance', '{}'::jsonb)
  )
  returning id into v_patient_id;

  if v_mrn is not null then
    insert into public.patient_identifiers(
      tenant_id,
      patient_id,
      system,
      value,
      identifier_type,
      is_primary,
      verification_status
    )
    values (
      p_tenant_id,
      v_patient_id,
      'urn:satucore:source-mrn',
      v_mrn,
      'MR',
      true,
      'unverified'
    );
  end if;

  insert into public.fhir_resources(
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
    p_tenant_id,
    v_patient_id,
    'Patient',
    '4.0.1',
    array['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient'],
    p_fhir_patient,
    p_fhir_payload_hash,
    'draft',
    v_source_reference,
    v_user_id
  )
  returning id into v_resource_id;

  v_outcome := case
    when exists (
      select 1
        from jsonb_array_elements(p_issues) x
       where x->>'severity' = 'error'
    ) then 'failed'
    when jsonb_array_length(p_issues) > 0 then 'warning'
    else 'passed'
  end;

  insert into public.validation_results(
    tenant_id,
    fhir_resource_id,
    validator,
    validator_version,
    conformance_scope,
    outcome,
    issues
  )
  values (
    p_tenant_id,
    v_resource_id,
    'satucore-patient-validator',
    '0.1.0',
    'fhir_r4',
    v_outcome,
    p_issues
  );

  insert into public.patient_source_links(
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
  values (
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
  returning id into v_link_id;

  update public.import_rows
     set normalized_data = p_canonical,
         processing_status = case
           when v_outcome = 'failed' then 'failed'
           else 'processed'
         end,
         issues = p_issues
   where id = p_import_row_id
     and tenant_id = p_tenant_id;

  insert into public.audit_logs(
    tenant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outcome,
    metadata
  )
  values (
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
      'validation_report_id', p_validation_report_id
    )
  );

  return jsonb_build_object(
    'patient_id', v_patient_id,
    'resource_id', v_resource_id,
    'source_link_id', v_link_id,
    'outcome', v_outcome
  );
end;
$$;

revoke all on function public.create_patient_from_validated_import(
  uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text
) from public, anon;

grant execute on function public.create_patient_from_validated_import(
  uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text
) to authenticated;


COMMIT;
