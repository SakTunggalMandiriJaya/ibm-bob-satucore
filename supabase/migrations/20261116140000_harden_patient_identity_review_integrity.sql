-- SATUCORE: Patient identity-review integrity hardening.
-- This migration intentionally preserves the existing decision RPC body.
-- Its current implementation contains NIK and demographic evidence checks.
-- The function is changed to SECURITY DEFINER only after explicit tenant/role
-- checks in that body have been verified against the live database.

begin;

create or replace function public.guard_patient_identity_review_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_authorized boolean;
  v_source_valid boolean;
  v_candidate_valid boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required for Patient identity review';
  end if;

  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = new.tenant_id
      and tm.user_id = v_user_id
      and tm.status = 'active'
      and (
        (tg_op = 'INSERT' and tm.role in (
          'tenant_admin', 'clinic_admin', 'data_manager', 'clinician', 'reviewer'
        ))
        or
        (tg_op = 'UPDATE' and tm.role in (
          'tenant_admin', 'clinic_admin', 'data_manager'
        ))
      )
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized for this Patient identity review';
  end if;

  select exists (
    select 1
    from public.organizations o
    join public.data_imports di
      on di.organization_id = o.id
     and di.tenant_id = o.tenant_id
    join public.import_rows ir
      on ir.import_id = di.id
     and ir.tenant_id = di.tenant_id
    where o.id = new.organization_id
      and o.tenant_id = new.tenant_id
      and di.id = new.import_id
      and ir.id = new.import_row_id
  ) into v_source_valid;

  if not v_source_valid then
    raise exception 'Patient identity review source does not match its tenant, Organization and import';
  end if;

  if tg_op = 'INSERT' then
    if new.decision is distinct from 'pending'
       or new.reviewed_by is not null
       or new.reviewed_at is not null then
      raise exception 'A new identity-review request must start pending and undecided';
    end if;
    if new.incoming_mrn is null or btrim(new.incoming_mrn) = '' then
      raise exception 'Incoming MRN is required';
    end if;
    if new.attempt_number is null or new.attempt_number < 1 then
      raise exception 'Invalid identity-review attempt number';
    end if;

    -- A candidate on a pending request is only a suggestion, never a match.
    if new.candidate_patient_id is not null then
      select exists (
        select 1 from public.patients p
        where p.id = new.candidate_patient_id
          and p.tenant_id = new.tenant_id
          and p.organization_id = new.organization_id
          and p.local_mrn = new.incoming_mrn
      ) into v_candidate_valid;
      if not v_candidate_valid then
        raise exception 'Suggested candidate must match the same tenant, Organization and incoming MRN';
      end if;
    end if;
    return new;
  end if;

  if old.id is distinct from new.id
     or old.tenant_id is distinct from new.tenant_id
     or old.organization_id is distinct from new.organization_id
     or old.import_id is distinct from new.import_id
     or old.import_row_id is distinct from new.import_row_id
     or old.incoming_mrn is distinct from new.incoming_mrn
     or old.incoming_snapshot is distinct from new.incoming_snapshot
     or old.created_at is distinct from new.created_at
     or old.attempt_number is distinct from new.attempt_number then
    raise exception 'Identity-review source and evidence fields are immutable';
  end if;

  if old.decision <> 'pending' then
    raise exception 'This identity-review request has already been decided';
  end if;

  if new.decision is null
     or new.decision not in ('confirmed_match', 'not_same_patient', 'unresolved') then
    raise exception 'Invalid Patient identity-review decision';
  end if;

  if new.reviewed_by is distinct from v_user_id
     or new.reviewed_at is null
     or length(btrim(coalesce(new.reviewer_comment, ''))) < 10 then
    raise exception 'A decision requires the authenticated reviewer, timestamp and rationale';
  end if;

  if new.decision = 'confirmed_match' then
    if new.candidate_patient_id is null then
      raise exception 'A confirmed match requires a candidate Patient';
    end if;
    select exists (
      select 1 from public.patients p
      where p.id = new.candidate_patient_id
        and p.tenant_id = new.tenant_id
        and p.organization_id = new.organization_id
        and p.local_mrn = new.incoming_mrn
    ) into v_candidate_valid;
    if not v_candidate_valid then
      raise exception 'Candidate Patient must match the same tenant, Organization and incoming local MRN';
    end if;
  elsif new.candidate_patient_id is not null then
    raise exception 'A non-match or unresolved decision cannot retain a candidate Patient';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_patient_identity_review_request
  on public.patient_identity_review_requests;

create trigger trg_guard_patient_identity_review_request
before insert or update on public.patient_identity_review_requests
for each row execute function public.guard_patient_identity_review_request();

revoke all on function public.guard_patient_identity_review_request()
  from public, anon, authenticated;

-- The live decision function body is deliberately not replaced. It has
-- explicit auth.uid(), active-tenant-role, source-row locking, NIK and
-- demographic conflict checks, source-link integrity and atomic audit logic.
alter function public.decide_patient_identity_review(uuid, text, uuid, text)
  security definer;
alter function public.decide_patient_identity_review(uuid, text, uuid, text)
  set search_path = '';

revoke all on function public.decide_patient_identity_review(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.decide_patient_identity_review(uuid, text, uuid, text)
  to authenticated;

-- Force all authenticated inserts and decisions through the audited RPCs.
revoke insert, update, delete on public.patient_identity_review_requests
  from public, anon, authenticated;
revoke insert (
  id, tenant_id, organization_id, import_id, import_row_id, incoming_mrn,
  incoming_snapshot, candidate_patient_id, decision, reviewer_comment,
  reviewed_by, reviewed_at, created_at, attempt_number
) on public.patient_identity_review_requests from public, anon, authenticated;
revoke update (
  id, tenant_id, organization_id, import_id, import_row_id, incoming_mrn,
  incoming_snapshot, candidate_patient_id, decision, reviewer_comment,
  reviewed_by, reviewed_at, created_at, attempt_number
) on public.patient_identity_review_requests from public, anon, authenticated;

commit;
