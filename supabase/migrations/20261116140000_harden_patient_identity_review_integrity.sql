
-- SATUCORE
-- Harden Patient Identity Review integrity.
-- LOCAL SOURCE-CONTROL MIGRATION ONLY.
-- Do not apply to the connected Supabase project until reviewed and tested.

begin;

-- 1. Add database-side integrity checks for identity-review requests.
create or replace function public.guard_patient_identity_review_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_authorized boolean;
  v_link_valid boolean;
  v_candidate_valid boolean;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required for Patient identity review';
  end if;

  -- Only authorized active members may open or decide reviews.
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = new.tenant_id
      and tm.user_id = v_user_id
      and tm.status = 'active'
      and (
        (tg_op = 'INSERT' and tm.role in (
          'tenant_admin', 'clinic_admin', 'data_manager',
          'clinician', 'reviewer'
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

  -- The Organization, import and source row must all belong together.
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
      and ir.import_id = new.import_id
      and ir.tenant_id = new.tenant_id
  ) into v_link_valid;

  if not v_link_valid then
    raise exception 'Patient identity review source does not match its tenant, Organization and import';
  end if;

  if tg_op = 'INSERT' then
    if new.decision is distinct from 'pending'
       or new.reviewed_by is not null
       or new.reviewed_at is not null
       or new.candidate_patient_id is not null then
      raise exception 'A new identity-review request must start pending and undecided';
    end if;

    if new.attempt_number is null or new.attempt_number < 1 then
      raise exception 'Invalid identity-review attempt number';
    end if;

    return new;
  end if;

  -- Existing request identity and source evidence cannot be reassigned.
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

  -- A request can be decided only once.
  if old.decision <> 'pending' then
    raise exception 'This identity-review request has already been decided';
  end if;

 if new.decision is null
     or new.decision not in (
       'confirmed_match', 'not_same_patient', 'unresolved'
     ) then
    raise exception 'Invalid Patient identity-review decision';
  end if;

  if new.reviewed_by is distinct from v_user_id
     or new.reviewed_at is null then
    raise exception 'A decision requires the authenticated reviewer and review timestamp';
  end if;

  if new.decision = 'confirmed_match' then
    if new.candidate_patient_id is null then
      raise exception 'A confirmed match requires a candidate Patient';
    end if;

    select exists (
      select 1
      from public.patients p
      where p.id = new.candidate_patient_id
        and p.tenant_id = new.tenant_id
        and p.organization_id = new.organization_id
        and p.local_mrn = new.incoming_mrn
    ) into v_candidate_valid;

    if not v_candidate_valid then
      raise exception 'Candidate Patient must match the same tenant, Organization and incoming local MRN';
    end if;
  else
    if new.candidate_patient_id is not null then
      raise exception 'A non-match or unresolved decision cannot retain a candidate Patient';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_patient_identity_review_request
  on public.patient_identity_review_requests;

create trigger trg_guard_patient_identity_review_request
before insert or update
on public.patient_identity_review_requests
for each row
execute function public.guard_patient_identity_review_request();

-- The function is invoked through its trigger, not directly by clients.
revoke all on function public.guard_patient_identity_review_request()
  from public, anon, authenticated;


-- 2. Strengthen the UPDATE policy.

-- 2A. Make the existing decision RPC the only authenticated
-- pathway for finalizing identity-review decisions.
-- Its explicit tenant and role checks remain in place.

create or replace function public.decide_patient_identity_review(
  p_review_id uuid,
  p_decision text,
  p_candidate_patient_id uuid default null,
  p_comment text default null
)
returns table(
  review_id uuid,
  decision text,
  linked_patient_id uuid,
  row_status text
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_review public.patient_identity_review_requests%rowtype;
  v_candidate public.patients%rowtype;
  v_status text;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if p_decision is null or p_decision not in (
    'confirmed_match', 'not_same_patient', 'unresolved'
  ) then
    raise exception 'Invalid identity review decision';
  end if;

  select *
  into v_review
  from public.patient_identity_review_requests
  where id = p_review_id
  for update;

  if not found then
    raise exception 'Identity review request not found';
  end if;

  if v_review.decision <> 'pending' then
    raise exception 'This identity review has already been decided';
  end if;

  if not exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = v_review.tenant_id
      and tm.user_id = v_user
      and tm.status = 'active'
      and tm.role in (
        'tenant_admin', 'clinic_admin', 'data_manager'
      )
  ) then
    raise exception 'Clinic administrator or data manager role required to finalize this identity decision';
  end if;

  if p_decision = 'confirmed_match' then
    if p_candidate_patient_id is null then
      raise exception 'Select the existing clinic Patient to confirm a match';
    end if;

    select *
    into v_candidate
    from public.patients
    where id = p_candidate_patient_id
      and tenant_id = v_review.tenant_id
      and organization_id = v_review.organization_id
      and local_mrn = v_review.incoming_mrn
    for update;

    if not found then
      raise exception 'Selected Patient does not match this clinic and incoming MRN';
    end if;

    update public.import_rows
    set processing_status = 'identity_matched',
        normalized_data = jsonb_set(
          coalesce(normalized_data, '{}'::jsonb),
          '{identity_review}',
          jsonb_build_object(
            'decision', 'confirmed_match',
            'patient_id', v_candidate.id,
            'review_id', v_review.id,
            'reviewed_by', v_user,
            'reviewed_at', now()
          ),
          true
        )
    where id = v_review.import_row_id
      and import_id = v_review.import_id
      and tenant_id = v_review.tenant_id;

    if not found then
      raise exception 'Source import row not found in the review tenant';
    end if;

    v_status := 'identity_matched';

  else
    update public.import_rows
    set processing_status = 'identity_review'
    where id = v_review.import_row_id
      and import_id = v_review.import_id
      and tenant_id = v_review.tenant_id;

    if not found then
      raise exception 'Source import row not found in the review tenant';
    end if;

    v_status := 'identity_review';
  end if;

  update public.patient_identity_review_requests
  set decision = p_decision,
      candidate_patient_id = case
        when p_decision = 'confirmed_match'
        then p_candidate_patient_id
        else null
      end,
      reviewer_comment = nullif(btrim(coalesce(p_comment, '')), ''),
      reviewed_by = v_user,
      reviewed_at = now()
  where id = v_review.id;

  insert into public.audit_logs(
    tenant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outcome,
    metadata
  )
  values (
    v_review.tenant_id,
    v_user,
    'patient_identity_review_decided',
    'patient_identity_review_request',
    v_review.id::text,
    'success',
    jsonb_build_object(
      'decision', p_decision,
      'candidate_patient_id', p_candidate_patient_id,
      'import_row_id', v_review.import_row_id,
      'mrn', v_review.incoming_mrn
    )
  );

  return query
  select
    v_review.id,
    p_decision,
    case
      when p_decision = 'confirmed_match'
      then p_candidate_patient_id
      else null
    end,
    v_status;
end;
$function$;

-- Remove default public execution and grant only authenticated callers.
revoke all on function public.decide_patient_identity_review(
  uuid, text, uuid, text
) from public, anon;

grant execute on function public.decide_patient_identity_review(
  uuid, text, uuid, text
) to authenticated;

-- Prevent direct authenticated table updates.
-- The SECURITY DEFINER RPC performs the controlled update.
revoke update on table public.patient_identity_review_requests
  from authenticated;
-- Revoke separately granted column-level UPDATE privileges.
revoke update (
  id,
  tenant_id,
  organization_id,
  import_id,
  import_row_id,
  incoming_mrn,
  incoming_snapshot,
  candidate_patient_id,
  decision,
  reviewer_comment,
  reviewed_by,
  reviewed_at,
  created_at,
  attempt_number
)
on table public.patient_identity_review_requests
from authenticated;

-- The trigger above independently validates source relationships and
-- immutable evidence, including checks that are awkward to express in RLS.

drop policy if exists patient_identity_review_update_tenant
  on public.patient_identity_review_requests;

create policy patient_identity_review_update_tenant
on public.patient_identity_review_requests
for update
to authenticated
using (
  decision = 'pending'
  and exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = patient_identity_review_requests.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.status = 'active'
      and tm.role in (
        'tenant_admin', 'clinic_admin', 'data_manager'
      )
  )
)
with check (
  reviewed_by = (select auth.uid())
  and reviewed_at is not null
  and decision in (
    'confirmed_match', 'not_same_patient', 'unresolved'
  )
  and exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = patient_identity_review_requests.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.status = 'active'
      and tm.role in (
        'tenant_admin', 'clinic_admin', 'data_manager'
      )
  )
);


-- 3. Align import_rows status constraint with the existing decision RPC.
-- The RPC already writes these two statuses.
alter table public.import_rows
  drop constraint if exists import_rows_processing_status_check;

alter table public.import_rows
  add constraint import_rows_processing_status_check
  check (
    processing_status = any (
      array[
        'pending',
        'profiled',
        'mapped',
        'approved',
        'rejected',
        'processed',
        'failed',
        'identity_matched',
        'identity_review'
      ]::text[]
    )
  );

comment on constraint import_rows_processing_status_check
  on public.import_rows is
  'Includes identity_matched and identity_review statuses used by the Patient identity-review decision workflow.';

commit;
