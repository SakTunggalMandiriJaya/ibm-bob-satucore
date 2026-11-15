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
