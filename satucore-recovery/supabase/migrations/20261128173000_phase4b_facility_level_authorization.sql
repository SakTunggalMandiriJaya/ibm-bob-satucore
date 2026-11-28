-- Phase 4B: facility-level authorization for tenant users.
-- Tenant administrators retain tenant-wide access. All other users require an active
-- organization_members assignment for the facility owning each clinical/import record.
-- This migration is additive and must be reconciled with live migration history before deployment.

begin;

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  status text not null default 'active' check (status in ('active','inactive','revoked')),
  assigned_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_tenant_user_org_key unique (tenant_id, user_id, organization_id)
);

create index if not exists organization_members_user_scope_idx
  on public.organization_members (tenant_id, user_id, status, organization_id);
create index if not exists organization_members_org_scope_idx
  on public.organization_members (tenant_id, organization_id, status, user_id);

create or replace function private.guard_organization_member_scope()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_org_tenant uuid;
  v_member_status text;
begin
  select o.tenant_id into v_org_tenant
    from public.organizations o
   where o.id = new.organization_id;

  if v_org_tenant is null or v_org_tenant <> new.tenant_id then
    raise exception 'Organization membership must reference an Organization in the same tenant'
      using errcode = '23514';
  end if;

  if new.status = 'active' then
    select tm.status into v_member_status
      from public.tenant_members tm
     where tm.tenant_id = new.tenant_id
       and tm.user_id = new.user_id;
  else
    v_member_status := 'active';
  end if;

  if v_member_status is distinct from 'active' then
    raise exception 'Organization assignment requires an active tenant membership'
      using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_guard_organization_member_scope on public.organization_members;
create trigger trg_guard_organization_member_scope
before insert or update of tenant_id, organization_id, user_id, status
on public.organization_members
for each row execute function private.guard_organization_member_scope();

create or replace function private.can_access_organization(p_tenant_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select
    p_organization_id is not null
    and exists (
      select 1 from public.tenant_members tm
       where tm.tenant_id = p_tenant_id
         and tm.user_id = auth.uid()
         and tm.status = 'active'
    )
    and (
      exists (
        select 1 from public.tenant_members tm
         where tm.tenant_id = p_tenant_id
           and tm.user_id = auth.uid()
           and tm.status = 'active'
           and tm.role = 'tenant_admin'
      )
      or exists (
        select 1 from public.organization_members om
         where om.tenant_id = p_tenant_id
           and om.organization_id = p_organization_id
           and om.user_id = auth.uid()
           and om.status = 'active'
      )
    );
$function$;

create or replace function private.can_access_row(p_tenant_id uuid, p_table_name text, p_row jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_org_id uuid;
  v_patient_id uuid;
  v_encounter_id uuid;
  v_import_id uuid;
  v_resource_id uuid;
  v_draft_id uuid;
  v_mapping_id uuid;
begin
  if not exists (
    select 1 from public.tenant_members tm
     where tm.tenant_id = p_tenant_id
       and tm.user_id = auth.uid()
       and tm.status = 'active'
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.tenant_members tm
     where tm.tenant_id = p_tenant_id
       and tm.user_id = auth.uid()
       and tm.status = 'active'
       and tm.role = 'tenant_admin'
  ) then
    return true;
  end if;

  if p_table_name = 'tenant_members' then
    return coalesce((p_row->>'user_id')::uuid = auth.uid(), false);
  elsif p_table_name = 'organizations' then
    v_org_id := nullif(p_row->>'id','')::uuid;
  elsif p_table_name = 'audit_logs' then
    v_org_id := nullif(p_row->'metadata'->>'organization_id','')::uuid;
    return private.can_access_organization(p_tenant_id, v_org_id);
  elsif p_table_name in ('data_imports','encounters','identity_duplicate_findings',
                         'integration_transactions','patient_identity_review_requests',
                         'patient_source_links','patients','practitioners',
                         'satusehat_connections','source_systems') then
    v_org_id := nullif(p_row->>'organization_id','')::uuid;
  elsif p_table_name in ('clinical_documents','conditions','diagnostic_reports',
                         'fhir_resources','imaging_studies','medication_requests',
                         'observations','procedures','service_requests','specimens') then
    v_patient_id := nullif(p_row->>'patient_id','')::uuid;
    v_encounter_id := nullif(p_row->>'encounter_id','')::uuid;
    if v_patient_id is not null then
      select p.organization_id into v_org_id from public.patients p
       where p.id = v_patient_id and p.tenant_id = p_tenant_id;
    elsif v_encounter_id is not null then
      select e.organization_id into v_org_id from public.encounters e
       where e.id = v_encounter_id and e.tenant_id = p_tenant_id;
    end if;
    if v_org_id is null and p_table_name in ('diagnostic_reports','imaging_studies','specimens') then
      v_resource_id := nullif(p_row->>'service_request_id','')::uuid;
      if v_resource_id is not null then
        select p.organization_id into v_org_id
          from public.service_requests sr
          join public.patients p on p.id = sr.patient_id and p.tenant_id = sr.tenant_id
         where sr.id = v_resource_id and sr.tenant_id = p_tenant_id;
      end if;
    end if;
  elsif p_table_name in ('field_mappings','import_rows','patient_drafts',
                          'patient_draft_validation_reports','source_row_corrections',
                          'schema_profiles') then
    v_import_id := nullif(p_row->>'import_id','')::uuid;
    if v_import_id is not null then
      select di.organization_id into v_org_id from public.data_imports di
       where di.id = v_import_id and di.tenant_id = p_tenant_id;
    end if;
  elsif p_table_name = 'patient_draft_revisions' then
    v_draft_id := nullif(p_row->>'draft_id','')::uuid;
    select di.organization_id into v_org_id
      from public.patient_drafts pd
      join public.data_imports di on di.id = pd.import_id and di.tenant_id = pd.tenant_id
     where pd.id = v_draft_id and pd.tenant_id = p_tenant_id;
  elsif p_table_name in ('patient_identifiers','patient_identity_matches','patient_correction_requests') then
    v_patient_id := nullif(p_row->>'patient_id','')::uuid;
    select p.organization_id into v_org_id from public.patients p
     where p.id = v_patient_id and p.tenant_id = p_tenant_id;
  elsif p_table_name in ('submission_approvals','validation_results') then
    v_resource_id := nullif(p_row->>'fhir_resource_id','')::uuid;
    select p.organization_id into v_org_id
      from public.fhir_resources fr
      join public.patients p on p.id = fr.patient_id and p.tenant_id = fr.tenant_id
     where fr.id = v_resource_id and fr.tenant_id = p_tenant_id;
  elsif p_table_name = 'mapping_approvals' then
    v_mapping_id := nullif(p_row->>'mapping_id','')::uuid;
    select di.organization_id into v_org_id
      from public.field_mappings fm
      join public.data_imports di on di.id = fm.import_id and di.tenant_id = fm.tenant_id
     where fm.id = v_mapping_id and fm.tenant_id = p_tenant_id;
  else
    -- Tenant-wide reference/configuration data remains tenant-scoped, not facility-scoped.
    return true;
  end if;

  return private.can_access_organization(p_tenant_id, v_org_id);
exception when invalid_text_representation then
  return false;
end;
$function$;

-- Facility membership administration: users may inspect their own assignments;
-- only tenant administrators may manage assignments.
alter table public.organization_members enable row level security;
drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (
    private.has_tenant_role(tenant_id, array['tenant_admin']::text[])
    or user_id = auth.uid()
  );
drop policy if exists organization_members_insert on public.organization_members;
create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (private.has_tenant_role(tenant_id, array['tenant_admin']::text[]));
drop policy if exists organization_members_update on public.organization_members;
create policy organization_members_update on public.organization_members
  for update to authenticated
  using (private.has_tenant_role(tenant_id, array['tenant_admin']::text[]))
  with check (private.has_tenant_role(tenant_id, array['tenant_admin']::text[]));
drop policy if exists organization_members_delete on public.organization_members;
create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (private.has_tenant_role(tenant_id, array['tenant_admin']::text[]));

grant select, insert, update, delete on public.organization_members to authenticated;
revoke all on function private.guard_organization_member_scope() from public, anon, authenticated;
revoke all on function private.can_access_organization(uuid, uuid) from public, anon;
revoke all on function private.can_access_row(uuid, text, jsonb) from public, anon;
grant execute on function private.can_access_organization(uuid, uuid) to authenticated, service_role;
grant execute on function private.can_access_row(uuid, text, jsonb) to authenticated, service_role;

-- Restrictive policies are layered over existing role policies so they cannot widen access.
do $phase4b$
declare
  v_table text;
  v_tables text[] := array[
    'audit_logs','clinical_documents','conditions','data_imports','diagnostic_reports',
    'encounters','fhir_resources','field_mappings','identity_duplicate_findings',
    'imaging_studies','import_rows','integration_transactions','mapping_approvals',
    'medication_requests','observations','organizations','patient_draft_revisions',
    'patient_draft_validation_reports','patient_drafts','patient_identifiers','patient_correction_requests',
    'patient_identity_matches','patient_identity_review_requests','patient_source_links',
    'patients','practitioners','procedures','reference_sync_logs','satusehat_connections',
    'schema_profiles','service_requests','source_row_corrections','source_systems','tenant_members',
    'specimens','submission_approvals','terminology_mappings','validation_results'
  ];
begin
  foreach v_table in array v_tables loop
    if to_regclass('public.' || v_table) is not null then
      execute format('drop policy if exists satucore_facility_scope on public.%I', v_table);
      execute format(
        'create policy satucore_facility_scope on public.%I as restrictive for all to authenticated using (private.can_access_row(tenant_id, %L, to_jsonb(%I))) with check (private.can_access_row(tenant_id, %L, to_jsonb(%I)))',
        v_table, v_table, v_table, v_table, v_table
      );
    end if;
  end loop;
end;
$phase4b$;

-- Organization membership cannot be bypassed by the Patient creation RPC.
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
  ) OR NOT private.can_access_organization(p_tenant_id, p_organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this facility' USING ERRCODE = '42501';
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
      'organization_id', p_organization_id,
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

revoke all on function public.create_patient_from_validated_import(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text) from public;
grant execute on function public.create_patient_from_validated_import(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text) to authenticated, service_role;

-- Facility-scope privileged RPCs as well as direct table access. SECURITY DEFINER bypasses RLS,
-- so each entry point must independently verify the caller's Organization assignment.
CREATE OR REPLACE FUNCTION public.create_patient_identity_review_request(p_tenant_id uuid, p_organization_id uuid, p_import_id uuid, p_row_number integer, p_incoming_mrn text, p_reason text, p_candidate_patient_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(request_id uuid, existing boolean, attempt_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_reason text;
  v_mrn text := nullif(btrim(coalesce(p_incoming_mrn, '')), '');
  v_import public.data_imports%rowtype;
  v_source public.import_rows%rowtype;
  v_pending public.patient_identity_review_requests%rowtype;
  v_attempt integer;
  v_request public.patient_identity_review_requests%rowtype;
  v_candidate_valid boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_tenant_id is null or p_organization_id is null or p_import_id is null
     or p_row_number is null or p_row_number < 1 then
    raise exception 'Tenant, Organization, import and positive source row number are required';
  end if;
  if v_mrn is null then
    raise exception 'Incoming MRN is required';
  end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 2000 then
    raise exception 'Review rationale must contain between 10 and 2000 characters';
  end if;

  if not exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = v_user_id
      and tm.status = 'active'
      and tm.role in ('tenant_admin', 'clinic_admin', 'data_manager', 'clinician', 'reviewer')
  ) or not private.can_access_organization(p_tenant_id, p_organization_id) then
    raise exception 'Active authorized facility membership required to request identity review' using errcode = '42501';
  end if;

  select di.* into v_import
  from public.data_imports di
  where di.id = p_import_id
    and di.tenant_id = p_tenant_id
    and di.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Import does not belong to the selected tenant and Organization';
  end if;

  select ir.* into v_source
  from public.import_rows ir
  where ir.tenant_id = p_tenant_id
    and ir.import_id = p_import_id
    and ir.row_number = p_row_number
  for update;
  if not found then
    raise exception 'Source row does not belong to the selected tenant and import';
  end if;

  -- The partial unique index is one pending request per tenant/source row,
  -- irrespective of MRN. Return that request idempotently without mutation.
  select r.* into v_pending
  from public.patient_identity_review_requests r
  where r.tenant_id = p_tenant_id
    and r.import_row_id = v_source.id
    and r.decision = 'pending'
  limit 1;
  if found then
    return query select v_pending.id, true, v_pending.attempt_number;
    return;
  end if;

  if exists (
    select 1 from public.patient_source_links l
    where l.tenant_id = p_tenant_id and l.import_row_id = v_source.id
  ) then
    raise exception 'Source row is already linked to a canonical Patient';
  end if;

  if p_candidate_patient_id is not null then
    select exists (
      select 1
      from public.patients p
      where p.id = p_candidate_patient_id
        and p.tenant_id = p_tenant_id
        and p.organization_id = p_organization_id
        and p.local_mrn = v_mrn
    ) into v_candidate_valid;
    if not v_candidate_valid then
      raise exception 'Suggested candidate must match the same tenant, Organization and incoming MRN';
    end if;
  end if;

  select coalesce(max(r.attempt_number), 0) + 1
    into v_attempt
  from public.patient_identity_review_requests r
  where r.tenant_id = p_tenant_id
    and r.import_row_id = v_source.id;

  insert into public.patient_identity_review_requests (
    tenant_id, organization_id, import_id, import_row_id,
    incoming_mrn, incoming_snapshot, candidate_patient_id,
    attempt_number, decision
  ) values (
    p_tenant_id, p_organization_id, p_import_id, v_source.id,
    v_mrn, coalesce(v_source.original_data, '{}'::jsonb), p_candidate_patient_id,
    v_attempt, 'pending'
  )
  returning * into v_request;

  -- Avoid writing a 16-digit national identifier if pasted into free text.
  v_reason := regexp_replace(v_reason, '\m[0-9]{16}\M', '************', 'g');

  insert into public.audit_logs (
    tenant_id, actor_user_id, action, entity_type, entity_id, outcome, metadata
  ) values (
    p_tenant_id, v_user_id, 'patient_identity_review_requested',
    'patient_identity_review_request', v_request.id::text, 'success',
    jsonb_build_object(
      'import_id', p_import_id,
      'import_row_id', v_source.id,
      'row_number', p_row_number,
      'incoming_mrn', v_mrn,
      'candidate_patient_id', p_candidate_patient_id,
      'attempt_number', v_attempt,
      'reason', v_reason
    )
  );

  return query select v_request.id, false, v_attempt;
end;
$function$;

CREATE OR REPLACE FUNCTION public.decide_patient_identity_review(p_review_id uuid, p_decision text, p_candidate_patient_id uuid DEFAULT NULL::uuid, p_comment text DEFAULT NULL::text)
 RETURNS TABLE(review_id uuid, decision text, linked_patient_id uuid, row_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_organization_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select r.tenant_id, r.organization_id into v_tenant_id, v_organization_id
  from public.patient_identity_review_requests r
  where r.id = p_review_id;

  if not found then
    raise exception 'Identity review request not found';
  end if;

  if not exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = v_tenant_id
      and tm.user_id = v_user_id
      and tm.status = 'active'
      and tm.role in ('tenant_admin', 'clinic_admin', 'data_manager')
  ) or not private.can_access_organization(v_tenant_id, v_organization_id) then
    raise exception 'Not authorized for this facility Patient identity review' using errcode = '42501';
  end if;

  return query
  select d.review_id, d.decision, d.linked_patient_id, d.row_status
  from public.decide_patient_identity_review_internal(
    p_review_id, p_decision, p_candidate_patient_id, p_comment
  ) d;
end;
$function$;

CREATE OR REPLACE FUNCTION public.scan_import_patient_duplicates(p_import_id uuid)
 RETURNS TABLE(findings_count integer, exact_identifier_count integer, possible_name_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_tenant uuid;
  v_org uuid;
  v_source_system uuid;
  v_count integer := 0;
  v_exact integer := 0;
  v_names integer := 0;
  v_rows integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select di.tenant_id,di.organization_id,di.source_system_id
    into v_tenant,v_org,v_source_system
  from public.data_imports di
  where di.id=p_import_id;

  if not found then raise exception 'Import not found'; end if;
  if not private.has_tenant_role(v_tenant,array['tenant_admin','clinic_admin','data_manager']::text[])
     or not private.can_access_organization(v_tenant,v_org) then
    raise exception 'Not authorized to run duplicate detection for this facility' using errcode = '42501';
  end if;

  select count(*) into v_rows from public.import_rows ir
  where ir.import_id=p_import_id and ir.tenant_id=v_tenant;
  if v_rows > 5000 then raise exception 'Import exceeds the 5,000-row duplicate scan limit'; end if;

  delete from public.identity_duplicate_findings f
  where f.tenant_id=v_tenant and f.import_id=p_import_id and f.status='detected';

  with src as (
    select ir.id,ir.row_number,ir.original_data,
      lower(regexp_replace(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('nik','national_id','national_identifier') limit 1),''
      )),'[^[:alnum:]]','','g')) as nik,
      lower(regexp_replace(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('mrn','medical_record_number','medical_record_no','no_rm','nomor_rm') limit 1),''
      )),'[^[:alnum:]]','','g')) as mrn,
      lower(regexp_replace(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('patient_no','legacy_patient_id','source_patient_id','patient_id') limit 1),''
      )),'[^[:alnum:]]','','g')) as source_id,
      lower(regexp_replace(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('patient_name','full_name','name','nama','nama_pasien') limit 1),''
      )),'[^[:alnum:]]+',' ','g')) as patient_name,
      nullif(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('dob','birth_date','date_of_birth','tanggal_lahir') limit 1),''
      )),'') as dob,
      lower(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('gender','sex','jenis_kelamin') limit 1),''
      ))) as gender,
      lower(trim(coalesce(
        (select value from jsonb_each_text(ir.original_data) where lower(key) in ('city','kabupaten','kota') limit 1),''
      ))) as city
    from public.import_rows ir
    where ir.import_id=p_import_id and ir.tenant_id=v_tenant
  ),
  row_pairs as (
    select a.*,b.id right_id,b.row_number right_row,b.nik right_nik,b.mrn right_mrn,
      b.source_id right_source_id,b.patient_name right_name,b.dob right_dob,
      b.gender right_gender,b.city right_city,
      array_remove(array[
        case when a.nik<>'' and a.nik=b.nik then 'NIK' end,
        case when a.mrn<>'' and a.mrn=b.mrn then 'MRN' end,
        case when a.source_id<>'' and a.source_id=b.source_id then 'SOURCE_PATIENT_ID' end
      ],null) exact_fields,
      extensions.similarity(a.patient_name,b.patient_name) name_score
    from src a join src b on a.row_number < b.row_number
  )
  insert into public.identity_duplicate_findings(
    tenant_id,organization_id,import_id,left_import_row_id,right_import_row_id,
    pair_key,pair_number,pair_color,match_class,severity,matched_fields,evidence
  )
  select v_tenant,v_org,p_import_id,
    rp.id,rp.right_id,
    'rows:'||least(rp.row_number,rp.right_row)||':'||greatest(rp.row_number,rp.right_row),
    row_number() over(order by rp.row_number,rp.right_row)::integer,
    (array['#F04452','#A855F7','#0EA5E9','#14B8A6','#F59E0B','#EC4899','#6366F1','#84CC16'])[
      1+((row_number() over(order by rp.row_number,rp.right_row)::integer-1)%8)
    ],
    case when cardinality(rp.exact_fields)>0 and (
      (rp.nik<>'' and rp.right_nik<>'' and rp.nik<>rp.right_nik)
      or (rp.patient_name<>'' and rp.right_name<>'' and rp.patient_name<>rp.right_name)
    ) then 'identifier_conflict'
    when cardinality(rp.exact_fields)>0 then 'exact_identifier' else 'possible_name' end,
    case when cardinality(rp.exact_fields)>0 then 'red' else 'amber' end,
    case when cardinality(rp.exact_fields)>0 then rp.exact_fields else array['PATIENT_NAME'] end,
    jsonb_build_object(
      'left_row',rp.row_number,'right_row',rp.right_row,
      'name_similarity',round(rp.name_score::numeric,3),
      'dob_match',case when rp.dob is not null and rp.dob=rp.right_dob then true else false end,
      'gender_match',case when rp.gender<>'' and rp.gender=rp.right_gender then true else false end,
      'city_match',case when rp.city<>'' and rp.city=rp.right_city then true else false end,
      'identifier_conflict',case when rp.nik<>'' and rp.right_nik<>'' and rp.nik<>rp.right_nik then 'NIK values differ' end,
      'name_conflict',case when rp.patient_name<>'' and rp.right_name<>'' and rp.patient_name<>rp.right_name then 'Names differ despite shared identifier' end,
      'masked_identifier',case when cardinality(rp.exact_fields)>0 then '••••' end
    )
  from row_pairs rp
  where cardinality(rp.exact_fields)>0
     or (rp.name_score>=0.72 and rp.patient_name<>'' and rp.right_name<>'')
  on conflict (tenant_id,import_id,pair_key) do nothing;

  get diagnostics v_exact = row_count;

  with src as (
    select ir.id,ir.row_number,ir.original_data,
      lower(regexp_replace(trim(coalesce((select value from jsonb_each_text(ir.original_data) where lower(key) in ('mrn','medical_record_number','medical_record_no','no_rm','nomor_rm') limit 1),'')),'[^[:alnum:]]','','g')) mrn,
      lower(regexp_replace(trim(coalesce((select value from jsonb_each_text(ir.original_data) where lower(key) in ('patient_name','full_name','name','nama','nama_pasien') limit 1),'')),'[^[:alnum:]]+',' ','g')) patient_name,
      nullif(trim(coalesce((select value from jsonb_each_text(ir.original_data) where lower(key) in ('dob','birth_date','date_of_birth','tanggal_lahir') limit 1),'')),'') dob,
      lower(trim(coalesce((select value from jsonb_each_text(ir.original_data) where lower(key) in ('gender','sex','jenis_kelamin') limit 1),''))) gender,
      lower(trim(coalesce((select value from jsonb_each_text(ir.original_data) where lower(key) in ('city','kabupaten','kota') limit 1),''))) city
    from public.import_rows ir where ir.import_id=p_import_id and ir.tenant_id=v_tenant
  ),
  candidates as (
    select s.*,p.id patient_id,p.local_mrn,
      lower(regexp_replace(trim(coalesce(
        p.name->0->>'text',
        concat_ws(' ',p.name->0->'given'->>0,p.name->0->>'family')
      )),'[^[:alnum:]]+',' ','g')) existing_name,
      p.birth_date::text existing_dob,lower(coalesce(p.administrative_gender,'')) existing_gender,
      lower(coalesce(p.addresses->0->>'city','')) existing_city
    from src s join public.patients p
      on p.tenant_id=v_tenant
     and p.organization_id is not distinct from v_org
     and ( (s.mrn<>'' and lower(regexp_replace(coalesce(p.local_mrn,''),'[^[:alnum:]]','','g'))=s.mrn)
        or (s.patient_name<>'' and extensions.similarity(s.patient_name,
            lower(regexp_replace(trim(coalesce(p.name->0->>'text',concat_ws(' ',p.name->0->'given'->>0,p.name->0->>'family'))),'[^[:alnum:]]+',' ','g')))>=0.72) )
  )
  insert into public.identity_duplicate_findings(
    tenant_id,organization_id,import_id,left_import_row_id,candidate_patient_id,
    pair_key,pair_number,pair_color,match_class,severity,matched_fields,evidence
  )
  select v_tenant,v_org,p_import_id,c.id,c.patient_id,
    'patient:'||c.id::text||':row:'||c.row_number,
    (select coalesce(max(pair_number),0) from public.identity_duplicate_findings f where f.tenant_id=v_tenant and f.import_id=p_import_id)
      + row_number() over(order by c.row_number,c.patient_id)::integer,
    (array['#F04452','#A855F7','#0EA5E9','#14B8A6','#F59E0B','#EC4899','#6366F1','#84CC16'])[
      1+((row_number() over(order by c.row_number,c.patient_id)::integer-1)%8)
    ],
    case when c.mrn<>'' and lower(regexp_replace(coalesce(c.local_mrn,''),'[^[:alnum:]]','','g'))=c.mrn
      then 'exact_identifier' else 'possible_name' end,
    case when c.mrn<>'' and lower(regexp_replace(coalesce(c.local_mrn,''),'[^[:alnum:]]','','g'))=c.mrn
      then 'red' else 'amber' end,
    case when c.mrn<>'' and lower(regexp_replace(coalesce(c.local_mrn,''),'[^[:alnum:]]','','g'))=c.mrn
      then array['MRN'] else array['PATIENT_NAME'] end,
    jsonb_build_object(
      'source_row',c.row_number,'candidate_patient_id',c.patient_id,
      'candidate_name',c.existing_name,'candidate_mrn_masked',
        case when c.local_mrn is null then null else '••••'||right(c.local_mrn,2) end,
      'name_similarity',round(extensions.similarity(c.patient_name,c.existing_name)::numeric,3),
      'dob_match',case when c.dob is not null and c.dob=c.existing_dob then true else false end,
      'gender_match',case when c.gender<>'' and c.gender=c.existing_gender then true else false end,
      'city_match',case when c.city<>'' and c.city=c.existing_city then true else false end
    )
  from candidates c
  on conflict (tenant_id,import_id,pair_key) do nothing;

  select count(*)::integer,
    count(*) filter(where match_class in ('exact_identifier','identifier_conflict'))::integer,
    count(*) filter(where match_class='possible_name')::integer
  into v_count,v_exact,v_names
  from public.identity_duplicate_findings
  where tenant_id=v_tenant and import_id=p_import_id;

  return query select v_count,v_exact,v_names;
end;
$function$;

commit;
