begin;

-- Direct authenticated UPDATE is replaced by this controlled RPC.
drop policy if exists patient_correction_requests_reviewer_update
on public.patient_correction_requests;

create or replace function public.review_patient_correction_request(
  p_request_id uuid,
  p_decision text,
  p_comment text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_request public.patient_correction_requests%rowtype;
  v_updated_count integer;
  v_comment text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_decision is null
   or p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select *
  into v_request
  from public.patient_correction_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Correction request not found';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Only pending correction requests may be reviewed';
  end if;

  if not private.has_tenant_role(
    v_request.tenant_id,
    array['tenant_admin', 'clinic_admin', 'reviewer']::text[]
  ) then
    raise exception 'Not authorized to review this correction request';
  end if;

  v_comment := coalesce(
    nullif(btrim(p_comment), ''),
    case
      when p_decision = 'approved'
        then 'Approved by an authorized human reviewer.'
      else 'Rejected by an authorized human reviewer.'
    end
  );

  update public.patient_correction_requests
  set
    status = p_decision,
    reviewed_by = v_user_id,
    reviewed_at = now(),
    review_comment = v_comment
  where id = p_request_id
    and tenant_id = v_request.tenant_id
    and status = 'pending';

  get diagnostics v_updated_count = row_count;

  if v_updated_count <> 1 then
    raise exception
      'Expected exactly one correction request to be reviewed; updated %',
      v_updated_count;
  end if;

  insert into public.audit_logs (
    tenant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outcome,
    metadata
  )
  values (
    v_request.tenant_id,
    v_user_id,
    case
      when p_decision = 'approved'
        then 'patient_correction_approved'
      else 'patient_correction_rejected'
    end,
    'patient_correction_request',
    v_request.id::text,
    'success',
    jsonb_build_object(
      'patient_id', v_request.patient_id,
      'field_path', v_request.field_path,
      'decision', p_decision,
      'review_comment', v_comment
    )
  );
end;
$$;

revoke all on function
  public.review_patient_correction_request(uuid, text, text)
from public, anon;

grant execute on function
  public.review_patient_correction_request(uuid, text, text)
to authenticated;

commit;
