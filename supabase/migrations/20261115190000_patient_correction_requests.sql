-- Patient correction proposals are stored separately from source rows and canonical Patient data.
-- Approval records a human decision only; applying a correction to Patient/FHIR is a separate governed operation.
create table if not exists public.patient_correction_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete restrict,
  fhir_resource_id uuid references public.fhir_resources(id) on delete restrict,
  field_path text not null,
  original_value jsonb not null,
  proposed_value jsonb not null,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete restrict,
  review_comment text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint patient_correction_requests_reason_nonempty check (length(btrim(reason)) > 0),
  constraint patient_correction_requests_field_nonempty check (length(btrim(field_path)) > 0),
  constraint patient_correction_requests_decision_consistency check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status in ('approved','rejected') and reviewed_by is not null and reviewed_at is not null)
  )
);

create index if not exists idx_patient_correction_requests_tenant_patient
  on public.patient_correction_requests (tenant_id, patient_id, created_at desc);
create index if not exists idx_patient_correction_requests_pending
  on public.patient_correction_requests (tenant_id, status, created_at desc);

alter table public.patient_correction_requests enable row level security;

create policy patient_correction_requests_tenant_read
on public.patient_correction_requests for select to authenticated
using (exists (
  select 1 from public.tenant_members tm
  where tm.tenant_id = patient_correction_requests.tenant_id
    and tm.user_id = (select auth.uid()) and tm.status = 'active'
));

create policy patient_correction_requests_member_insert
on public.patient_correction_requests for insert to authenticated
with check (
  requested_by = (select auth.uid())
  and status = 'pending'
  and reviewed_by is null and reviewed_at is null
  and exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = patient_correction_requests.tenant_id
      and tm.user_id = (select auth.uid()) and tm.status = 'active'
      and tm.role in ('tenant_admin','clinic_admin','data_manager','clinician','reviewer')
  )
);

create policy patient_correction_requests_reviewer_update
on public.patient_correction_requests for update to authenticated
using (exists (
  select 1 from public.tenant_members tm
  where tm.tenant_id = patient_correction_requests.tenant_id
    and tm.user_id = (select auth.uid()) and tm.status = 'active'
    and tm.role in ('tenant_admin','clinic_admin','reviewer')
))
with check (
  status in ('approved','rejected')
  and reviewed_by = (select auth.uid())
  and reviewed_at is not null
  and exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = patient_correction_requests.tenant_id
      and tm.user_id = (select auth.uid()) and tm.status = 'active'
      and tm.role in ('tenant_admin','clinic_admin','reviewer')
  )
);

-- Enforce tenant and Patient linkage independently of caller-supplied identifiers.
create or replace function public.enforce_patient_correction_request_integrity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.tenant_id = new.tenant_id
  ) then
    raise exception 'Patient does not belong to the correction request tenant';
  end if;

  if new.fhir_resource_id is not null and not exists (
    select 1 from public.fhir_resources fr
    where fr.id = new.fhir_resource_id
      and fr.tenant_id = new.tenant_id
      and fr.patient_id = new.patient_id
      and fr.resource_type = 'Patient'
  ) then
    raise exception 'FHIR resource does not belong to the selected Patient and tenant';
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'pending' then
      raise exception 'Only pending correction requests may be reviewed';
    end if;
    if new.tenant_id <> old.tenant_id
      or new.patient_id <> old.patient_id
      or new.fhir_resource_id is distinct from old.fhir_resource_id
      or new.field_path <> old.field_path
      or new.original_value <> old.original_value
      or new.proposed_value <> old.proposed_value
      or new.reason <> old.reason
      or new.requested_by <> old.requested_by
      or new.created_at <> old.created_at then
      raise exception 'Correction request evidence is immutable after submission';
    end if;
  end if;
  return new;
end;
$$;

create trigger patient_correction_request_integrity
before insert or update on public.patient_correction_requests
for each row execute function public.enforce_patient_correction_request_integrity();
