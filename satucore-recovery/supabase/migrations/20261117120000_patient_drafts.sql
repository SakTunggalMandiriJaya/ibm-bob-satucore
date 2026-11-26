
-- SATUCORE Stage 3A: Patient Draft persistence
-- Review before applying. No canonical Patient creation or SATUSEHAT submission.

begin;

-- Support exact tenant/source validation report references.
alter table public.patient_draft_validation_reports
  add constraint patient_draft_validation_reports_lineage_key
  unique (id, tenant_id, import_id, import_row_id, row_number);


create table public.patient_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  import_id uuid not null,
  import_row_id uuid not null,
  row_number integer not null,

  revision integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'validated', 'stale')),

  canonical_patient jsonb not null,
  fhir_patient jsonb not null,
  mapping_snapshot jsonb not null,

  payload_hash text not null
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  input_hash text not null
    check (input_hash ~ '^[0-9a-f]{64}$'),

  validation_report_id uuid,
  validated_at timestamptz,

  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint patient_drafts_revision_positive
    check (revision > 0),

  constraint patient_drafts_row_positive
    check (row_number > 0),

  constraint patient_drafts_fhir_type
    check (
      jsonb_typeof(fhir_patient) = 'object'
      and fhir_patient ->> 'resourceType' = 'Patient'
    ),

  constraint patient_drafts_mapping_array
    check (jsonb_typeof(mapping_snapshot) = 'array'),

  constraint patient_drafts_import_tenant_fk
    foreign key (import_id, tenant_id)
    references public.data_imports(id, tenant_id),

  constraint patient_drafts_source_tenant_fk
    foreign key (import_row_id, tenant_id)
    references public.import_rows(id, tenant_id),

  constraint patient_drafts_validation_lineage_fk
    foreign key (
      validation_report_id,
      tenant_id,
      import_id,
      import_row_id,
      row_number
    )
    references public.patient_draft_validation_reports (
      id,
      tenant_id,
      import_id,
      import_row_id,
      row_number
    ),

  constraint patient_drafts_one_per_source
    unique (tenant_id, import_row_id),

  constraint patient_drafts_id_tenant_key
    unique (id, tenant_id)
);

create index patient_drafts_import_idx
  on public.patient_drafts(tenant_id, import_id);

create index patient_drafts_status_idx
  on public.patient_drafts(tenant_id, status, updated_at desc);


create table public.patient_draft_revisions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null,
  tenant_id uuid not null,
  revision integer not null,

  status text not null,
  canonical_patient jsonb not null,
  fhir_patient jsonb not null,
  mapping_snapshot jsonb not null,
  payload_hash text not null,
  input_hash text not null,
  validation_report_id uuid,

  changed_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),

  constraint patient_draft_revisions_draft_fk
    foreign key (draft_id, tenant_id)
    references public.patient_drafts(id, tenant_id),

  constraint patient_draft_revisions_version_unique
    unique (draft_id, revision)
);

create index patient_draft_revisions_history_idx
  on public.patient_draft_revisions(tenant_id, draft_id, revision desc);


-- Validate every draft write and invalidate validation when content changes.
create or replace function public.guard_patient_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_report public.patient_draft_validation_reports%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authenticated user context is required for Patient Draft changes';
  end if;

  if tg_op = 'INSERT' then
    if new.revision <> 1
       or new.status <> 'draft'
       or new.validation_report_id is not null
       or new.validated_at is not null then
      raise exception 'New Patient drafts must begin at revision 1 in draft state';
    end if;

    if new.created_by <> auth.uid() or new.updated_by <> auth.uid() then
      raise exception 'Draft creator and updater must match the authenticated user';
    end if;
  else
    if new.id <> old.id
       or new.tenant_id <> old.tenant_id
       or new.import_id <> old.import_id
       or new.import_row_id <> old.import_row_id
       or new.row_number <> old.row_number
       or new.created_by <> old.created_by
       or new.created_at <> old.created_at then
      raise exception 'Patient draft source identity and creator are immutable';
    end if;

    if new.updated_by <> auth.uid() then
      raise exception 'Draft updater must match the authenticated user';
    end if;

    new.revision := old.revision + 1;
    new.updated_at := now();

    if new.canonical_patient is distinct from old.canonical_patient
       or new.fhir_patient is distinct from old.fhir_patient
       or new.mapping_snapshot is distinct from old.mapping_snapshot
       or new.payload_hash is distinct from old.payload_hash
       or new.input_hash is distinct from old.input_hash then

      new.status := 'draft';
      new.validation_report_id := null;
      new.validated_at := null;
    end if;
  end if;

  if not exists (
    select 1
    from public.import_rows ir
    where ir.id = new.import_row_id
      and ir.import_id = new.import_id
      and ir.tenant_id = new.tenant_id
      and ir.row_number = new.row_number
  ) then
    raise exception 'Patient draft source row does not match tenant, import and row number';
  end if;

  if new.status = 'validated' then
    if new.validation_report_id is null then
      raise exception 'A validation report is required';
    end if;

    select r.*
      into v_report
      from public.patient_draft_validation_reports r
      where r.id = new.validation_report_id
        and r.tenant_id = new.tenant_id
        and r.import_id = new.import_id
        and r.import_row_id = new.import_row_id
        and r.row_number = new.row_number
        and r.outcome = 'passed'
        and r.payload_hash = new.payload_hash
        and r.input_hash = new.input_hash
        and r.approved_mappings = new.mapping_snapshot;

    if not found then
      raise exception 'Passing validation evidence does not match this draft';
    end if;

    new.validated_at := now();
  else
    if new.validation_report_id is not null or new.validated_at is not null then
      raise exception 'Only validated drafts may reference validation evidence';
    end if;
  end if;

  return new;
end;
$function$;


-- Append an immutable revision after every draft insert or update.
create or replace function public.record_patient_draft_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.patient_draft_revisions (
    draft_id, tenant_id, revision, status,
    canonical_patient, fhir_patient, mapping_snapshot,
    payload_hash, input_hash, validation_report_id, changed_by
  )
  values (
    new.id, new.tenant_id, new.revision, new.status,
    new.canonical_patient, new.fhir_patient, new.mapping_snapshot,
    new.payload_hash, new.input_hash, new.validation_report_id, auth.uid()
  );

  return new;
end;
$function$;


create or replace function public.prevent_patient_draft_revision_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Patient draft revision history is append-only';
end;
$function$;


-- Source correction invalidates the current draft.
create or replace function public.invalidate_patient_draft_after_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.patient_drafts d
     set status = 'stale',
         validation_report_id = null,
         validated_at = null,
         updated_by = auth.uid()
   where d.tenant_id = new.tenant_id
     and d.import_id = new.import_id
     and d.import_row_id = new.import_row_id
     and d.status <> 'stale';

  return new;
end;
$function$;


create trigger trg_guard_patient_draft
before insert or update on public.patient_drafts
for each row execute function public.guard_patient_draft();

create trigger trg_record_patient_draft_revision
after insert or update on public.patient_drafts
for each row execute function public.record_patient_draft_revision();

create trigger trg_prevent_patient_draft_revision_mutation
before update or delete on public.patient_draft_revisions
for each row execute function public.prevent_patient_draft_revision_mutation();

create trigger trg_invalidate_patient_draft_after_correction
after insert on public.source_row_corrections
for each row execute function public.invalidate_patient_draft_after_correction();


alter table public.patient_drafts enable row level security;
alter table public.patient_draft_revisions enable row level security;

create policy patient_drafts_member_read
on public.patient_drafts
for select to authenticated
using (private.is_tenant_member(tenant_id));

create policy patient_drafts_authorized_insert
on public.patient_drafts
for insert to authenticated
with check (
  created_by = auth.uid()
  and updated_by = auth.uid()
  and private.has_tenant_role(
    tenant_id,
    array['tenant_admin','clinic_admin','data_manager','clinician','reviewer']::text[]
  )
);

create policy patient_drafts_authorized_update
on public.patient_drafts
for update to authenticated
using (
  private.has_tenant_role(
    tenant_id,
    array['tenant_admin','clinic_admin','data_manager','clinician','reviewer']::text[]
  )
)
with check (
  updated_by = auth.uid()
  and private.has_tenant_role(
    tenant_id,
    array['tenant_admin','clinic_admin','data_manager','clinician','reviewer']::text[]
  )
);

create policy patient_draft_revisions_member_read
on public.patient_draft_revisions
for select to authenticated
using (private.is_tenant_member(tenant_id));


revoke all on public.patient_drafts from anon, authenticated;
grant select, insert, update on public.patient_drafts to authenticated;

revoke all on public.patient_draft_revisions from anon, authenticated;
grant select on public.patient_draft_revisions to authenticated;

revoke all on function public.guard_patient_draft() from public, anon, authenticated;
revoke all on function public.record_patient_draft_revision() from public, anon, authenticated;
revoke all on function public.prevent_patient_draft_revision_mutation() from public, anon, authenticated;
revoke all on function public.invalidate_patient_draft_after_correction() from public, anon, authenticated;

commit;
