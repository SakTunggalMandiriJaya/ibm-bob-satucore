-- Executable PostgreSQL integration checks for Phase 4A.
-- Runs against a disposable PostgreSQL 17 service in GitHub Actions.
-- Minimal fixtures reproduce the production columns and authorization contracts
-- touched by the two Phase 4A migrations; no production data or credentials are used.

\set ON_ERROR_STOP on

create schema auth;
create schema private;

do $phase4a$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$phase4a$;

create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = ''
as $phase4a$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$phase4a$;

create table public.tenant_members (
  tenant_id uuid not null,
  user_id uuid not null,
  role text not null,
  status text not null default 'active'
);

create or replace function private.has_tenant_role(p_tenant_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $phase4a$
  select exists (
    select 1
      from public.tenant_members tm
     where tm.tenant_id = p_tenant_id
       and tm.user_id = auth.uid()
       and tm.status = 'active'
       and tm.role = any(p_roles)
  );
$phase4a$;

create table public.fhir_resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  payload_hash text,
  created_by uuid,
  patient_id uuid,
  resource_type text,
  fhir_version text,
  profile_urls text[],
  payload jsonb,
  status text,
  source_record_reference text
);

create table public.submission_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  fhir_resource_id uuid not null,
  decision text not null,
  approved_by uuid,
  approved_payload_hash text,
  decided_at timestamptz not null default now()
);

alter table public.submission_approvals enable row level security;
grant usage on schema auth, private to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function private.has_tenant_role(uuid, text[]) to authenticated;
grant insert, select, update on public.submission_approvals to authenticated;

\ir ../../supabase/migrations/20261128170000_phase4a_strict_maker_checker.sql

create trigger submission_approval_payload_binding
before insert or update of tenant_id, fhir_resource_id, decision, approved_by
on public.submission_approvals
for each row
execute function private.bind_submission_approval_to_payload();

insert into public.tenant_members(tenant_id, user_id, role)
values
  ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','submitter'),
  ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','reviewer'),
  ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000003','tenant_admin');

insert into public.fhir_resources(id, tenant_id, payload_hash, created_by)
values
  ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',repeat('a',64),'10000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',repeat('b',64),'10000000-0000-0000-0000-000000000002');

-- A submitter cannot approve, even when they created the FHIR resource.
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';
do $phase4a$
begin
  begin
    insert into public.submission_approvals(tenant_id, fhir_resource_id, decision, approved_by)
    values ('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','approved','10000000-0000-0000-0000-000000000001');
    raise exception 'ASSERTION FAILED: submitter approval unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end;
$phase4a$;
reset role;
reset request.jwt.claim.sub;

-- A reviewer may approve another user's resource; the exact payload hash is bound.
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000002';
insert into public.submission_approvals(tenant_id, fhir_resource_id, decision, approved_by)
values ('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','approved','10000000-0000-0000-0000-000000000002');
reset role;
reset request.jwt.claim.sub;

do $phase4a$
begin
  if not exists (
    select 1 from public.submission_approvals
     where fhir_resource_id = '50000000-0000-0000-0000-000000000001'
       and approved_payload_hash = repeat('a',64)
  ) then
    raise exception 'ASSERTION FAILED: reviewer approval did not bind the stored payload hash';
  end if;
end;
$phase4a$;

-- A reviewer cannot approve their own FHIR resource.
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000002';
do $phase4a$
begin
  begin
    insert into public.submission_approvals(tenant_id, fhir_resource_id, decision, approved_by)
    values ('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','approved','10000000-0000-0000-0000-000000000002');
    raise exception 'ASSERTION FAILED: creator self-approval unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end;
$phase4a$;
reset role;
reset request.jwt.claim.sub;

-- Minimal Patient Draft/input tables for exercising the actual trigger migration.
create table public.patient_drafts (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid not null,
  import_row_id uuid not null,
  row_number integer not null default 1,
  revision integer not null default 1,
  status text not null,
  canonical_patient jsonb not null default '{}'::jsonb,
  fhir_patient jsonb not null default '{"resourceType":"Patient"}'::jsonb,
  mapping_snapshot jsonb not null default '[]'::jsonb,
  payload_hash text not null default repeat('a',64),
  input_hash text not null default repeat('b',64),
  validation_report_id uuid,
  validated_at timestamptz,
  created_by uuid not null default '10000000-0000-0000-0000-000000000001',
  updated_by uuid not null
);

create table public.import_rows (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid not null,
  row_number integer not null,
  source_record_key text,
  original_data jsonb not null,
  normalized_data jsonb,
  processing_status text not null default 'profiled',
  issues jsonb not null default '[]'::jsonb
);

create table public.field_mappings (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid,
  target_resource text not null,
  target_field text not null,
  status text not null
);

create table public.data_imports (
  id uuid primary key,
  tenant_id uuid not null,
  organization_id uuid not null,
  source_system_id uuid
);

create table public.patient_draft_validation_reports (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid not null,
  import_row_id uuid not null,
  row_number integer not null,
  validator text not null,
  validator_version text not null,
  conformance_scope text not null,
  outcome text not null,
  issues jsonb not null,
  payload_hash text not null,
  input_hash text not null,
  approved_mappings jsonb not null,
  created_by uuid not null
);

create table public.patient_identity_review_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  import_id uuid not null,
  import_row_id uuid not null,
  decision text not null
);

grant usage on schema public to authenticated;
grant select, insert, update on public.data_imports, public.import_rows,
  public.patient_drafts, public.patient_draft_validation_reports,
  public.patient_identity_review_requests to authenticated;

\ir ../../supabase/migrations/20261120120000_bind_patient_creation_to_validated_draft.sql
\ir ../../supabase/migrations/20261128172000_phase4a_invalidate_patient_drafts_on_input_change.sql

insert into public.data_imports(id, tenant_id, organization_id, source_system_id)
values ('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000001');

insert into public.import_rows(id, tenant_id, import_id, row_number, original_data)
values
  ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,'{"name":"Before"}'),
  ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002',1,'{"name":"Other tenant"}');

insert into public.field_mappings(id, tenant_id, import_id, target_resource, target_field, status)
values
  ('70000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Patient','name','approved'),
  ('70000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Observation','value','approved');

insert into public.patient_drafts(id, tenant_id, import_id, import_row_id, status, validation_report_id, validated_at, updated_by)
values
  ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','validated','60000000-0000-0000-0000-000000000001',now(),'10000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','validated','60000000-0000-0000-0000-000000000002',now(),'10000000-0000-0000-0000-000000000001');

-- Direct persisted source-row edits invalidate only the matching tenant/import/source draft.
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000003';
update public.import_rows
   set original_data = '{"name":"After"}'
 where id = '20000000-0000-0000-0000-000000000001';

select auth.uid() as source_change_actor,
       id, status, validation_report_id, validated_at, updated_by
  from public.patient_drafts
 where id = '40000000-0000-0000-0000-000000000001';

do $phase4a$
begin
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and status = 'stale'
       and validation_report_id is null
       and validated_at is null
  ) then
    raise exception 'ASSERTION FAILED: source-row update did not invalidate the matching draft and clear evidence';
  end if;
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and updated_by is not null
  ) then
    raise exception 'ASSERTION FAILED: source-row invalidation lost the draft updater lineage';
  end if;
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000002'
       and status = 'validated'
  ) then
    raise exception 'ASSERTION FAILED: source-row update crossed tenant boundaries';
  end if;
end;
$phase4a$;

-- Re-establish a validated fixture, then change the Patient mapping.
update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

update public.field_mappings
   set target_field = 'birthDate'
 where id = '70000000-0000-0000-0000-000000000001';

do $phase4a$
begin
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and status = 'stale'
       and validation_report_id is null
       and validated_at is null
  ) then
    raise exception 'ASSERTION FAILED: Patient mapping update did not invalidate its import drafts';
  end if;
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000002'
       and status = 'validated'
  ) then
    raise exception 'ASSERTION FAILED: Patient mapping update crossed tenant/import boundaries';
  end if;
end;
$phase4a$;

-- A non-Patient mapping must not invalidate Patient drafts.
update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

insert into public.field_mappings(id, tenant_id, import_id, target_resource, target_field, status)
values ('70000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Observation','status','approved');

do $phase4a$
begin
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and status = 'validated'
  ) then
    raise exception 'ASSERTION FAILED: non-Patient mapping change invalidated a Patient draft';
  end if;
end;
$phase4a$;

-- Adding or removing a Patient mapping also invalidates the import's drafts.
insert into public.field_mappings(id, tenant_id, import_id, target_resource, target_field, status)
values ('70000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Patient','gender','approved');

do $phase4a$
begin
  if not exists (select 1 from public.patient_drafts where id = '40000000-0000-0000-0000-000000000001' and status = 'stale') then
    raise exception 'ASSERTION FAILED: inserting a Patient mapping did not invalidate the draft';
  end if;
end;
$phase4a$;

update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

delete from public.field_mappings
 where id = '70000000-0000-0000-0000-000000000004';

do $phase4a$
begin
  if not exists (select 1 from public.patient_drafts where id = '40000000-0000-0000-0000-000000000001' and status = 'stale') then
    raise exception 'ASSERTION FAILED: deleting a Patient mapping did not invalidate the draft';
  end if;
end;
$phase4a$;

-- Revalidate the fixture, then prove an Organization/source-system change invalidates it.
update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

update public.data_imports
   set organization_id = '80000000-0000-0000-0000-000000000002',
       source_system_id = '90000000-0000-0000-0000-000000000002'
 where id = '30000000-0000-0000-0000-000000000001';

do $phase4a$
begin
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and status = 'stale'
       and validation_report_id is null
       and validated_at is null
  ) then
    raise exception 'ASSERTION FAILED: import Organization/source-system change did not invalidate the draft';
  end if;
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000002'
       and status = 'validated'
  ) then
    raise exception 'ASSERTION FAILED: import scope change crossed tenant/import boundaries';
  end if;
end;
$phase4a$;

reset request.jwt.claim.sub;

-- The Patient creation RPC must reject stale drafts before any canonical write.
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000003';
do $phase4a$
begin
  begin
    perform public.create_patient_from_validated_import(
      '00000000-0000-0000-0000-000000000001',
      '80000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '{"active":true,"name":[],"source_identifiers":[]}'::jsonb,
      '{"resourceType":"Patient"}'::jsonb,
      '[]'::jsonb,
      repeat('a',64)
    );
    raise exception 'ASSERTION FAILED: stale Patient Draft unexpectedly passed the creation gate';
  exception when others then
    if sqlerrm = 'ASSERTION FAILED: stale Patient Draft unexpectedly passed the creation gate' then
      raise;
    end if;
    if sqlerrm not like '%Patient Draft is not currently validated%' then
      raise;
    end if;
  end;

  -- Organization must be bound to the import, not caller-substituted.
  begin
    perform public.create_patient_from_validated_import(
      '00000000-0000-0000-0000-000000000001',
      '80000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '{"active":true,"name":[],"source_identifiers":[]}'::jsonb,
      '{"resourceType":"Patient"}'::jsonb,
      '[]'::jsonb,
      repeat('a',64)
    );
    raise exception 'ASSERTION FAILED: caller-substituted Organization unexpectedly passed';
  exception when others then
    if sqlerrm = 'ASSERTION FAILED: caller-substituted Organization unexpectedly passed' then
      raise;
    end if;
    if sqlerrm not like '%Import does not belong to this tenant and Organization%' then
      raise;
    end if;
  end;

  -- A tenant administrator in tenant A cannot create a Patient in tenant B.
  begin
    perform public.create_patient_from_validated_import(
      '00000000-0000-0000-0000-000000000002',
      '80000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '{"active":true,"name":[],"source_identifiers":[]}'::jsonb,
      '{"resourceType":"Patient"}'::jsonb,
      '[]'::jsonb,
      repeat('a',64)
    );
    raise exception 'ASSERTION FAILED: cross-tenant Patient creation unexpectedly passed';
  exception when others then
    if sqlerrm = 'ASSERTION FAILED: cross-tenant Patient creation unexpectedly passed' then
      raise;
    end if;
    if sqlerrm not like '%Not authorized for this clinic%' then
      raise;
    end if;
  end;
end;
$phase4a$;
reset role;
reset request.jwt.claim.sub;

select 'Phase 4A PostgreSQL integration checks passed' as result;
