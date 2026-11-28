-- Executable Phase 4B PostgreSQL integration checks.
-- Disposable PostgreSQL only. Exercises the actual migration's membership trigger,
-- restrictive RLS and direct/relationship facility resolution.
\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create schema auth;
create schema private;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end;
$roles$;

create or replace function auth.uid()
returns uuid language sql stable set search_path=''
as $fn$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $fn$;

create table public.tenants(id uuid primary key);
create table public.tenant_members(
  tenant_id uuid not null, user_id uuid not null, role text not null, status text not null default 'active'
);
create table public.organizations(
  id uuid primary key, tenant_id uuid not null, name text not null, active boolean not null default true
);
create table public.patients(
  id uuid primary key, tenant_id uuid not null, organization_id uuid not null, local_mrn text,
  active boolean default true, name jsonb default '[]', birth_date date, administrative_gender text,
  telecom jsonb default '[]', addresses jsonb default '[]', source_identifiers jsonb default '[]',
  source_record_reference text, provenance jsonb default '{}'
);
create table public.encounters(
  id uuid primary key, tenant_id uuid not null, organization_id uuid not null, patient_id uuid
);
create table public.clinical_documents(
  id uuid primary key, tenant_id uuid not null, patient_id uuid, encounter_id uuid, document jsonb
);
create table public.data_imports(
  id uuid primary key, tenant_id uuid not null, organization_id uuid not null, source_system_id uuid
);
create table public.import_rows(
  id uuid primary key, tenant_id uuid not null, import_id uuid not null, row_number integer,
  source_record_key text, original_data jsonb, normalized_data jsonb, processing_status text, issues jsonb
);
create table public.patient_drafts(
  id uuid primary key, tenant_id uuid not null, import_id uuid not null, import_row_id uuid not null,
  row_number integer, status text, canonical_patient jsonb, fhir_patient jsonb, mapping_snapshot jsonb,
  payload_hash text, input_hash text, validation_report_id uuid, validated_at timestamptz,
  created_by uuid, updated_by uuid
);
create table public.patient_draft_validation_reports(
  id uuid primary key, tenant_id uuid not null, import_id uuid not null, import_row_id uuid not null,
  row_number integer, validator text, validator_version text, conformance_scope text, outcome text,
  issues jsonb, payload_hash text, input_hash text, approved_mappings jsonb, created_by uuid
);
create table public.fhir_resources(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, patient_id uuid,
  resource_type text, fhir_version text, profile_urls text[], payload jsonb, payload_hash text,
  status text, source_record_reference text, created_by uuid
);
create table public.validation_results(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, fhir_resource_id uuid,
  validator text, validator_version text, conformance_scope text, outcome text, issues jsonb
);
create table public.patient_source_links(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, organization_id uuid,
  patient_id uuid, import_id uuid, import_row_id uuid, source_system_id uuid,
  source_record_key text, link_type text, created_by uuid
);
create table public.patient_identifiers(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, patient_id uuid,
  system text, value text, identifier_type text, is_primary boolean, verification_status text
);
create table public.audit_logs(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, actor_user_id uuid,
  action text, entity_type text, entity_id text, outcome text, metadata jsonb
);
create table public.patient_identity_review_requests(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, import_id uuid,
  import_row_id uuid, decision text
);
create table public.submission_approvals(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, fhir_resource_id uuid,
  decision text, approved_by uuid, approved_payload_hash text, decided_at timestamptz default now()
);
create table public.field_mappings(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, import_id uuid,
  target_resource text, target_field text, status text
);
create table public.mapping_approvals(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, mapping_id uuid
);

create or replace function private.has_tenant_role(p_tenant_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path=''
as $fn$
  select exists(select 1 from public.tenant_members tm
    where tm.tenant_id=p_tenant_id and tm.user_id=auth.uid()
      and tm.status='active' and tm.role=any(p_roles));
$fn$;

grant usage on schema auth, private to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function private.has_tenant_role(uuid,text[]) to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Existing tenant-level permissive policies are modeled explicitly; Phase 4B's
-- restrictive policy must narrow them rather than replace their role contract.
alter table public.organizations enable row level security;
create policy tenant_base_org on public.organizations for all to authenticated
  using (exists(select 1 from public.tenant_members tm where tm.tenant_id=organizations.tenant_id and tm.user_id=auth.uid() and tm.status='active'))
  with check (exists(select 1 from public.tenant_members tm where tm.tenant_id=organizations.tenant_id and tm.user_id=auth.uid() and tm.status='active'));
alter table public.patients enable row level security;
create policy tenant_base_patient on public.patients for all to authenticated
  using (exists(select 1 from public.tenant_members tm where tm.tenant_id=patients.tenant_id and tm.user_id=auth.uid() and tm.status='active'))
  with check (exists(select 1 from public.tenant_members tm where tm.tenant_id=patients.tenant_id and tm.user_id=auth.uid() and tm.status='active'));
alter table public.clinical_documents enable row level security;
create policy tenant_base_docs on public.clinical_documents for all to authenticated
  using (exists(select 1 from public.tenant_members tm where tm.tenant_id=clinical_documents.tenant_id and tm.user_id=auth.uid() and tm.status='active'))
  with check (exists(select 1 from public.tenant_members tm where tm.tenant_id=clinical_documents.tenant_id and tm.user_id=auth.uid() and tm.status='active'));

\ir ../../supabase/migrations/20261128173000_phase4b_facility_level_authorization.sql

insert into public.tenants(id) values
 ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.tenant_members(tenant_id,user_id,role,status) values
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','data_manager','active'),
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','tenant_admin','active'),
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000003','data_manager','active'),
 ('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004','tenant_admin','active');
insert into public.organizations(id,tenant_id,name) values
 ('80000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Facility A'),
 ('80000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Facility B'),
 ('80000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','Tenant B Facility');
insert into public.organization_members(tenant_id,organization_id,user_id,status) values
 ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','active'),
 ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','active'),
 ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','revoked');
insert into public.patients(id,tenant_id,organization_id,local_mrn) values
 ('90000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','A-1'),
 ('90000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','B-1'),
 ('90000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','80000000-0000-0000-0000-000000000003','X-1');
insert into public.clinical_documents(id,tenant_id,patient_id,document) values
 ('a0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000001','{}'),
 ('a0000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000002','{}');

-- A user assigned to two facilities sees exactly those two, not other tenant rows.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000001';
do $assert$
begin
  if (select count(*) from public.organizations) <> 2 then raise exception 'assigned user Organization scope failed'; end if;
  if (select count(*) from public.patients) <> 2 then raise exception 'assigned user Patient scope failed'; end if;
  if (select count(*) from public.clinical_documents) <> 2 then raise exception 'relationship-based clinical document scope failed'; end if;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- User with no active assignment sees no facilities or facility-owned data.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000003';
do $assert$
begin
  if (select count(*) from public.organizations) <> 0 then raise exception 'revoked-only user saw an Organization'; end if;
  if (select count(*) from public.patients) <> 0 then raise exception 'revoked-only user saw a Patient'; end if;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- Tenant administrator sees all facilities and their records within its own tenant only.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000002';
do $assert$
begin
  if (select count(*) from public.organizations) <> 2 then raise exception 'tenant admin did not see all tenant Organizations'; end if;
  if (select count(*) from public.patients) <> 2 then raise exception 'tenant admin did not see all tenant Patients'; end if;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- Cross-tenant administrator cannot see the other tenant's rows.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000004';
do $assert$
begin
  if (select count(*) from public.organizations) <> 1 then raise exception 'cross-tenant Organization isolation failed'; end if;
  if (select count(*) from public.patients) <> 1 then raise exception 'cross-tenant Patient isolation failed'; end if;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- Invalid tenant/Organization assignment is rejected by the real membership trigger.
do $assert$
begin
  begin
    insert into public.organization_members(tenant_id,organization_id,user_id,status)
    values ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','active');
    raise exception 'invalid cross-tenant facility assignment unexpectedly succeeded';
  exception when check_violation then null;
  end;
end;
$assert$;

select 'Phase 4B PostgreSQL facility authorization checks passed' as result;
