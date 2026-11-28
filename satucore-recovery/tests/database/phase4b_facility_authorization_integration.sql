-- Executable Phase 4B PostgreSQL integration checks.
-- Disposable PostgreSQL only. Exercises the actual migration's membership trigger,
-- restrictive RLS and direct/relationship facility resolution.
\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create schema auth;
create schema private;
create schema storage;
create or replace function storage.foldername(p_name text)
returns text[] language sql immutable
as $fn$
  select string_to_array(
    regexp_replace(p_name, '/[^/]*$', ''),
    '/'
  );
$fn$;

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
  id uuid primary key, tenant_id uuid not null, organization_id uuid not null, source_system_id uuid,
  storage_path text
);
create table public.schema_profiles(id uuid primary key, tenant_id uuid not null, import_id uuid not null, profile jsonb default '{}'::jsonb);
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
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, organization_id uuid,
  import_id uuid, import_row_id uuid, decision text, attempt_number integer default 1
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

alter table public.tenant_members enable row level security;
create policy tenant_base_members_select on public.tenant_members for select to authenticated
  using (user_id=auth.uid() or private.has_tenant_role(tenant_id,array['tenant_admin']::text[]));

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
alter table public.data_imports enable row level security;
create policy tenant_base_imports on public.data_imports for all to authenticated
  using (exists(select 1 from public.tenant_members tm where tm.tenant_id=data_imports.tenant_id and tm.user_id=auth.uid() and tm.status='active'))
  with check (exists(select 1 from public.tenant_members tm where tm.tenant_id=data_imports.tenant_id and tm.user_id=auth.uid() and tm.status='active'));
alter table public.schema_profiles enable row level security;
create policy tenant_base_schema_profiles on public.schema_profiles for all to authenticated
  using (exists(select 1 from public.tenant_members tm where tm.tenant_id=schema_profiles.tenant_id and tm.user_id=auth.uid() and tm.status='active'))
  with check (exists(select 1 from public.tenant_members tm where tm.tenant_id=schema_profiles.tenant_id and tm.user_id=auth.uid() and tm.status='active'));

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  unique(bucket_id, name)
);
alter table storage.objects enable row level security;
create policy tenant_base_legacy_storage on storage.objects
  for all to authenticated using (bucket_id = 'legacy-imports')
  with check (bucket_id = 'legacy-imports');
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;

\ir ../../supabase/migrations/20261128173000_phase4b_facility_level_authorization.sql
\ir ../../supabase/migrations/20261128174000_phase4c_storage_facility_authorization.sql

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
 ('80000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Facility C'),
 ('80000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','Tenant B Facility');
insert into public.organization_members(tenant_id,organization_id,user_id,status) values
 ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','active'),
 ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','active'),
 ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','revoked');
insert into public.data_imports(id,tenant_id,organization_id,storage_path) values
 ('70000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000001/facility-a.csv'),
 ('70000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000002/facility-b.csv'),
 ('70000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000004/facility-c.csv'),
 ('70000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000005/new-a.csv'),
 ('70000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000006/forbidden-c.csv');
insert into storage.objects(bucket_id,name) values
 ('legacy-imports','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000001/facility-a.csv'),
 ('legacy-imports','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000002/facility-b.csv'),
 ('legacy-imports','00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000004/facility-c.csv');
insert into public.schema_profiles(id,tenant_id,import_id) values
 ('71000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001'),
 ('71000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002'),
 ('71000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000004');
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
  if (select count(*) from public.schema_profiles) <> 2 then raise exception 'import-linked schema profile facility scope failed'; end if;
  if (select count(*) from storage.objects where bucket_id='legacy-imports') <> 2 then raise exception 'legacy Storage facility select scope failed'; end if;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- Assert the exact authorization inputs before exercising Storage RLS.
do $assert$
begin
  if private.can_access_organization('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000004') then
    raise exception 'diagnostic: user unexpectedly has Facility C access';
  end if;
  if exists (select 1 from public.data_imports where id='70000000-0000-0000-0000-000000000006') then
    raise exception 'diagnostic: Facility C import unexpectedly visible to assigned user';
  end if;
end;
$assert$;

-- Legacy object INSERT is permitted only when the pre-created import row proves facility ownership.
-- Run as the assigned authenticated user; a superuser bypasses RLS and invalidates this check.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000001';
do $assert$
begin
  insert into storage.objects(bucket_id,name) values (
    'legacy-imports',
    '00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000005/new-a.csv'
  );
  begin
    insert into storage.objects(bucket_id,name) values (
      'legacy-imports',
      '00000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000006/forbidden-c.csv'
    );
    raise exception 'legacy Storage insert into unassigned facility unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- RLS WITH CHECK permits writes only into an assigned Organization.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000001';
insert into public.patients(id,tenant_id,organization_id,local_mrn)
values ('90000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','A-NEW');
do $assert$
begin
  begin
    insert into public.patients(id,tenant_id,organization_id,local_mrn)
    values ('90000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000003','CROSS-TENANT');
    raise exception 'cross-tenant Patient insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.patients(id,tenant_id,organization_id,local_mrn)
    values ('90000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000003','UNASSIGNED');
    raise exception 'unassigned Organization Patient insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
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
  begin
    insert into public.patients(id,tenant_id,organization_id,local_mrn)
    values ('90000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002','NO-ASSIGNMENT');
    raise exception 'user without active assignment inserted a Patient';
  exception when insufficient_privilege then null;
  end;
end;
$assert$;
reset role;
reset request.jwt.claim.sub;

-- Tenant administrator sees all facilities and their records within its own tenant only.
-- One additional same-tenant Patient was inserted by the assigned data_manager above.
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000002';
do $assert$
begin
  if (select count(*) from public.organizations) <> 3 then raise exception 'tenant admin did not see all tenant Organizations'; end if;
  if (select count(*) from public.patients) <> 3 then raise exception 'tenant admin did not see all tenant Patients'; end if;
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

-- SECURITY DEFINER identity RPCs must independently enforce facility scope.
-- The caller is assigned to Facilities A and B, but not Facility C.
insert into public.patient_identity_review_requests(id,tenant_id,organization_id,import_id,import_row_id,decision)
values ('72000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',
        '80000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000004',null,'pending');
set role authenticated;
set request.jwt.claim.sub='10000000-0000-0000-0000-000000000001';
do $assert$
begin
  begin
    perform * from public.create_patient_identity_review_request(
      '00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000004',
      '70000000-0000-0000-0000-000000000004',1,'SYNTHETIC-MRN','Facility authorization test denial');
    raise exception 'identity review request RPC allowed an unassigned facility';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.decide_patient_identity_review(
      '72000000-0000-0000-0000-000000000004','reject',null,'Facility authorization test');
    raise exception 'identity review decision RPC allowed an unassigned facility';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.scan_import_patient_duplicates('70000000-0000-0000-0000-000000000004');
    raise exception 'duplicate scan RPC allowed an unassigned facility';
  exception when insufficient_privilege then null;
  end;
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
