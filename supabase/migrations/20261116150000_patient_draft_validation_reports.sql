begin;

-- Standalone, append-only validation evidence. This avoids creating a FHIR resource
-- merely to satisfy the legacy validation_results.fhir_resource_id requirement.
create table if not exists public.patient_draft_validation_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  import_id uuid not null,
  import_row_id uuid not null,
  row_number integer not null check (row_number > 0),
  validator text not null,
  validator_version text not null,
  conformance_scope text not null,
  outcome text not null check (outcome in ('passed','warning','failed')),
  issues jsonb not null default '[]'::jsonb,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  approved_mappings jsonb not null,
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists patient_draft_validation_lookup_idx
  on public.patient_draft_validation_reports (tenant_id, import_id, import_row_id, created_at desc);
create index if not exists patient_draft_validation_hash_idx
  on public.patient_draft_validation_reports (tenant_id, import_row_id, payload_hash, input_hash, created_at desc);

create or replace function public.guard_patient_draft_validation_report()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.import_rows ir
    where ir.id = new.import_row_id and ir.import_id = new.import_id
      and ir.tenant_id = new.tenant_id and ir.row_number = new.row_number
  ) then raise exception 'Validation report source row does not match its tenant and import'; end if;
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'Validation reports are append-only';
  end if;
  return new;
end; $$;

drop trigger if exists trg_guard_patient_draft_validation_report on public.patient_draft_validation_reports;
create trigger trg_guard_patient_draft_validation_report
  before insert or update or delete on public.patient_draft_validation_reports
  for each row execute function public.guard_patient_draft_validation_report();
revoke all on function public.guard_patient_draft_validation_report() from public, anon, authenticated;

alter table public.patient_draft_validation_reports enable row level security;
drop policy if exists patient_draft_validation_member_read on public.patient_draft_validation_reports;
create policy patient_draft_validation_member_read
  on public.patient_draft_validation_reports for select to authenticated
  using (private.is_tenant_member(tenant_id));
drop policy if exists patient_draft_validation_member_insert on public.patient_draft_validation_reports;
create policy patient_draft_validation_member_insert
  on public.patient_draft_validation_reports for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.has_tenant_role(tenant_id, array['tenant_admin','clinic_admin','data_manager','clinician','reviewer']::text[])
  );
revoke update, delete on public.patient_draft_validation_reports from authenticated;

comment on table public.patient_draft_validation_reports is
  'Append-only tenant-scoped local Patient draft validation evidence, linked to imported source rows before canonical Patient creation. Does not assert complete FHIR R4 or SATUSEHAT profile conformance.';

commit;
