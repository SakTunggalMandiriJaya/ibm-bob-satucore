-- SATUCORE: protect the decision RPC's idempotent return path.
-- The original implementation is retained verbatim under an internal name.
-- This public wrapper checks tenant membership before invoking it, so the
-- SECURITY DEFINER function cannot return cross-tenant identity data early.

begin;

alter function public.decide_patient_identity_review(uuid, text, uuid, text)
  rename to decide_patient_identity_review_internal;

revoke all on function public.decide_patient_identity_review_internal(uuid, text, uuid, text)
  from public, anon, authenticated;

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
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select r.tenant_id into v_tenant_id
  from public.patient_identity_review_requests r
  where r.id = p_review_id;

  if not found then
    raise exception 'Identity review request not found';
  end if;

  if not exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = v_tenant_id
      and tm.user_id = v_user_id
      and tm.status = 'active'
      and tm.role in ('tenant_admin', 'clinic_admin', 'data_manager')
  ) then
    raise exception 'Not authorized for this Patient identity review';
  end if;

  return query
  select d.review_id, d.decision, d.linked_patient_id, d.row_status
  from public.decide_patient_identity_review_internal(
    p_review_id, p_decision, p_candidate_patient_id, p_comment
  ) d;
end;
$$;

revoke all on function public.decide_patient_identity_review(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.decide_patient_identity_review(uuid, text, uuid, text)
  to authenticated;

commit;
