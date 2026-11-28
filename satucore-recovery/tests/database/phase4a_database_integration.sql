-- Executable PostgreSQL integration checks for Phase 4A.
-- Runs against a disposable PostgreSQL 17 service in GitHub Actions.
-- Minimal fixtures reproduce the production columns and authorization contracts
-- touched by the two Phase 4A migrations; no production data or credentials are used.

\set ON_ERROR_STOP on

create schema auth;
create schema private;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

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
as $$
  select exists (
    select 1
      from public.tenant_members tm
     where tm.tenant_id = p_tenant_id
       and tm.user_id = auth.uid()
       and tm.status = 'active'
       and tm.role = any(p_roles)
  );
$$;

create table public.fhir_resources (
  id uuid primary key,
  tenant_id uuid not null,
  payload_hash text,
  created_by uuid
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
do $$
begin
  begin
    insert into public.submission_approvals(tenant_id, fhir_resource_id, decision, approved_by)
    values ('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','approved','10000000-0000-0000-0000-000000000001');
    raise exception 'ASSERTION FAILED: submitter approval unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;
reset role;
reset request.jwt.claim.sub;

-- A reviewer may approve another user's resource; the exact payload hash is bound.
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000002';
insert into public.submission_approvals(tenant_id, fhir_resource_id, decision, approved_by)
values ('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','approved','10000000-0000-0000-0000-000000000002');
reset role;
reset request.jwt.claim.sub;

do $$
begin
  if not exists (
    select 1 from public.submission_approvals
     where fhir_resource_id = '50000000-0000-0000-0000-000000000001'
       and approved_payload_hash = repeat('a',64)
  ) then
    raise exception 'ASSERTION FAILED: reviewer approval did not bind the stored payload hash';
  end if;
end;
$$;

-- A reviewer cannot approve their own FHIR resource.
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000002';
do $$
begin
  begin
    insert into public.submission_approvals(tenant_id, fhir_resource_id, decision, approved_by)
    values ('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','approved','10000000-0000-0000-0000-000000000002');
    raise exception 'ASSERTION FAILED: creator self-approval unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end;
$$;
reset role;
reset request.jwt.claim.sub;

-- Minimal Patient Draft/input tables for exercising the actual trigger migration.
create table public.patient_drafts (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid not null,
  import_row_id uuid not null,
  status text not null,
  validation_report_id uuid,
  validated_at timestamptz,
  updated_by uuid not null
);

create table public.import_rows (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid not null,
  row_number integer not null,
  original_data jsonb not null
);

create table public.field_mappings (
  id uuid primary key,
  tenant_id uuid not null,
  import_id uuid,
  target_resource text not null,
  target_field text not null,
  status text not null
);

\ir ../../supabase/migrations/20261128172000_phase4a_invalidate_patient_drafts_on_input_change.sql

insert into public.import_rows(id, tenant_id, import_id, row_number, original_data)
values
  ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,'{"name":"Before"}'),
  ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002',1,'{"name":"Other tenant"}');

insert into public.patient_drafts(id, tenant_id, import_id, import_row_id, status, validation_report_id, validated_at, updated_by)
values
  ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','validated','60000000-0000-0000-0000-000000000001',now(),'10000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','validated','60000000-0000-0000-0000-000000000002',now(),'10000000-0000-0000-0000-000000000001');

insert into public.field_mappings(id, tenant_id, import_id, target_resource, target_field, status)
values
  ('70000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Patient','name','approved'),
  ('70000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Observation','value','approved');

-- Direct persisted source-row edits invalidate only the matching tenant/import/source draft.
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000003';
update public.import_rows
   set original_data = '{"name":"After"}'
 where id = '20000000-0000-0000-0000-000000000001';

select auth.uid() as source_change_actor,
       id, status, validation_report_id, validated_at, updated_by
  from public.patient_drafts
 where id = '40000000-0000-0000-0000-000000000001';

do $
begin
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and status = 'stale'
       and validation_report_id is null
       and validated_at is null
       and updated_by = '10000000-0000-0000-0000-000000000003'
  ) then
    raise exception 'ASSERTION FAILED: source-row update did not invalidate the matching draft and clear evidence';
  end if;
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000002'
       and status = 'validated'
  ) then
    raise exception 'ASSERTION FAILED: source-row update crossed tenant boundaries';
  end if;
end;
$$;

-- Re-establish a validated fixture, then change the Patient mapping.
update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

update public.field_mappings
   set target_field = 'birthDate'
 where id = '70000000-0000-0000-0000-000000000001';

do $$
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
$;

-- A non-Patient mapping must not invalidate Patient drafts.
update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

insert into public.field_mappings(id, tenant_id, import_id, target_resource, target_field, status)
values ('70000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Observation','status','approved');

do $$
begin
  if not exists (
    select 1 from public.patient_drafts
     where id = '40000000-0000-0000-0000-000000000001'
       and status = 'validated'
  ) then
    raise exception 'ASSERTION FAILED: non-Patient mapping change invalidated a Patient draft';
  end if;
end;
$$;

-- Adding or removing a Patient mapping also invalidates the import's drafts.
insert into public.field_mappings(id, tenant_id, import_id, target_resource, target_field, status)
values ('70000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Patient','gender','approved');

do $$
begin
  if not exists (select 1 from public.patient_drafts where id = '40000000-0000-0000-0000-000000000001' and status = 'stale') then
    raise exception 'ASSERTION FAILED: inserting a Patient mapping did not invalidate the draft';
  end if;
end;
$$;

update public.patient_drafts
   set status = 'validated',
       validation_report_id = '60000000-0000-0000-0000-000000000001',
       validated_at = now()
 where id = '40000000-0000-0000-0000-000000000001';

delete from public.field_mappings
 where id = '70000000-0000-0000-0000-000000000004';

do $$
begin
  if not exists (select 1 from public.patient_drafts where id = '40000000-0000-0000-0000-000000000001' and status = 'stale') then
    raise exception 'ASSERTION FAILED: deleting a Patient mapping did not invalidate the draft';
  end if;
end;
$$;

reset request.jwt.claim.sub;
select 'Phase 4A PostgreSQL integration checks passed' as result;
