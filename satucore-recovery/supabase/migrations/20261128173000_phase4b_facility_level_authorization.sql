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

  select tm.status into v_member_status
    from public.tenant_members tm
   where tm.tenant_id = new.tenant_id
     and tm.user_id = new.user_id;

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
                          'patient_draft_validation_reports','source_row_corrections') then
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
  elsif p_table_name in ('patient_identifiers','patient_identity_matches') then
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
    'patient_draft_validation_reports','patient_drafts','patient_identifiers',
    'patient_identity_matches','patient_identity_review_requests','patient_source_links',
    'patients','practitioners','procedures','reference_sync_logs','satusehat_connections',
    'schema_profiles','service_requests','source_row_corrections','source_systems',
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
set search_path to ''
as $function$
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
  v_nik text;
  v_outcome text;
  v_source_reference text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if not private.has_tenant_role(p_tenant_id, array['tenant_admin','clinic_admin','data_manager']::text[])
     or not private.can_access_organization(p_tenant_id,p_organization_id) then
    raise exception 'Not authorized for this facility' using errcode='42501';
  end if;

  select * into v_import from public.data_imports
   where id=p_import_id and tenant_id=p_tenant_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Import does not belong to this tenant and Organization'; end if;

  select * into v_row from public.import_rows
   where id=p_import_row_id and import_id=p_import_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Source row does not belong to this tenant and import'; end if;

  select * into v_draft from public.patient_drafts d
   where d.tenant_id=p_tenant_id and d.import_id=p_import_id and d.import_row_id=p_import_row_id for update;
  if not found or v_draft.status is distinct from 'validated'
     or v_draft.validation_report_id is distinct from p_validation_report_id
     or v_draft.row_number is distinct from v_row.row_number or v_draft.validated_at is null then
    raise exception 'Patient Draft is not currently validated against the supplied report and source row';
  end if;

  select * into v_report from public.patient_draft_validation_reports r
   where r.id=p_validation_report_id and r.tenant_id=p_tenant_id and r.import_id=p_import_id
     and r.import_row_id=p_import_row_id and r.row_number=v_row.row_number and r.outcome='passed';
  if not found then raise exception 'A matching passing Patient validation report is required'; end if;
  if v_report.validator is distinct from 'satucore-patient-local'
     or v_report.validator_version is distinct from '0.2.0'
     or v_report.conformance_scope is distinct from 'local_deterministic_checks; fhir_r4_structure_partial; satusehat_profile_not_executed' then
    raise exception 'Validation report does not have the required Patient validator identity and scope';
  end if;
  if v_report.payload_hash is distinct from v_draft.payload_hash
     or v_report.input_hash is distinct from v_draft.input_hash
     or v_report.approved_mappings is distinct from v_draft.mapping_snapshot
     or p_fhir_payload_hash is distinct from v_draft.payload_hash
     or p_fhir_patient is distinct from v_draft.fhir_patient
     or p_canonical is distinct from v_draft.canonical_patient
     or p_issues is distinct from v_report.issues
     or jsonb_array_length(v_report.issues) <> 0 then
    raise exception 'Patient submission data does not match the persisted validated draft';
  end if;
  if v_row.processing_status='identity_review' or exists (
    select 1 from public.patient_identity_review_requests r
     where r.tenant_id=p_tenant_id and r.import_id=p_import_id
       and r.import_row_id=p_import_row_id and r.decision='pending'
  ) then raise exception 'Identity review is pending'; end if;
  if exists (select 1 from public.patient_source_links l where l.tenant_id=p_tenant_id and l.import_row_id=p_import_row_id)
     or exists (select 1 from public.patients p where p.tenant_id=p_tenant_id and p.source_record_reference='import_rows/'||p_import_row_id::text) then
    raise exception 'This source row already has a canonical Patient';
  end if;

  v_mrn := nullif(btrim(p_canonical->>'local_mrn'),'');
  select nullif(btrim(identifier->>'value'),'') into v_nik
    from jsonb_array_elements(coalesce(p_canonical->'source_identifiers','[]'::jsonb)) as identifiers(identifier)
   where identifier->>'system'='urn:satucore:source-nik' limit 1;
  if v_nik is not null and v_nik !~ '^[0-9]{16}$' then raise exception 'NIK_INVALID_FORMAT'; end if;
  if v_mrn is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_organization_id::text||':'||v_mrn,0));
    if exists(select 1 from public.patients where tenant_id=p_tenant_id and organization_id=p_organization_id and local_mrn=v_mrn) then
      raise exception 'MRN_CONFLICT: Identity review is required';
    end if;
  end if;
  if v_nik is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':urn:satucore:source-nik:'||v_nik,0));
    if exists(select 1 from public.patient_identifiers where tenant_id=p_tenant_id and system='urn:satucore:source-nik' and value=v_nik) then
      raise exception 'NIK_CONFLICT: Human identity review is required';
    end if;
  end if;

  insert into public.patients(tenant_id,organization_id,local_mrn,active,name,birth_date,administrative_gender,telecom,addresses,source_identifiers,source_record_reference,provenance)
  values(p_tenant_id,p_organization_id,v_mrn,coalesce((p_canonical->>'active')::boolean,true),
    coalesce(p_canonical->'name','[]'::jsonb),nullif(p_canonical->>'birth_date','')::date,
    nullif(p_canonical->>'administrative_gender',''),coalesce(p_canonical->'telecom','[]'::jsonb),
    coalesce(p_canonical->'addresses','[]'::jsonb),coalesce(p_canonical->'source_identifiers','[]'::jsonb),
    'import_rows/'||p_import_row_id::text,coalesce(p_canonical->'provenance','{}'::jsonb))
  returning id into v_patient_id;

  if v_mrn is not null then
    insert into public.patient_identifiers(tenant_id,patient_id,system,value,identifier_type,is_primary,verification_status)
    values(p_tenant_id,v_patient_id,'urn:satucore:source-mrn',v_mrn,'MR',true,'unverified');
  end if;
  if v_nik is not null then
    insert into public.patient_identifiers(tenant_id,patient_id,system,value,identifier_type,is_primary,verification_status)
    values(p_tenant_id,v_patient_id,'urn:satucore:source-nik',v_nik,null,false,'unverified');
  end if;

  insert into public.fhir_resources(tenant_id,patient_id,resource_type,fhir_version,profile_urls,payload,payload_hash,status,source_record_reference,created_by)
  values(p_tenant_id,v_patient_id,'Patient','4.0.1',
    array['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient'],p_fhir_patient,p_fhir_payload_hash,
    'draft','import_rows/'||p_import_row_id::text,v_user_id)
  returning id into v_resource_id;

  insert into public.validation_results(tenant_id,fhir_resource_id,validator,validator_version,conformance_scope,outcome,issues)
  values(p_tenant_id,v_resource_id,v_report.validator,v_report.validator_version,v_report.conformance_scope,'passed',p_issues);

  insert into public.patient_source_links(tenant_id,organization_id,patient_id,import_id,import_row_id,source_system_id,source_record_key,link_type,created_by)
  values(p_tenant_id,p_organization_id,v_patient_id,p_import_id,p_import_row_id,v_import.source_system_id,v_row.source_record_key,'new_patient',v_user_id)
  returning id into v_link_id;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
  values(p_tenant_id,v_user_id,'canonical_patient_created','patient',v_patient_id::text,'success',
    jsonb_build_object('organization_id',p_organization_id,'fhir_resource_id',v_resource_id,'source_link_id',v_link_id,
      'import_id',p_import_id,'import_row_id',p_import_row_id,'validation_outcome','passed',
      'validation_report_id',p_validation_report_id,'source_nik_recorded',v_nik is not null));

  return jsonb_build_object('patient_id',v_patient_id,'resource_id',v_resource_id,'source_link_id',v_link_id,'outcome','passed');
end;
$function$;

revoke all on function public.create_patient_from_validated_import(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text) from public;
grant execute on function public.create_patient_from_validated_import(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text) to authenticated, service_role;

commit;
