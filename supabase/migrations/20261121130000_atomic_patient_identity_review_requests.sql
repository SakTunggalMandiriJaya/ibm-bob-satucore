-- SATUCORE: atomic Patient identity-review request creation.
-- Request row and audit event commit or roll back together.
begin;

create or replace function public.create_patient_identity_review_request(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_import_id uuid,
  p_row_number integer,
  p_incoming_mrn text,
  p_reason text,
  p_candidate_patient_id uuid default null
)
returns table(request_id uuid, existing boolean, attempt_number integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_reason text;
  v_mrn text := nullif(btrim(coalesce(p_incoming_mrn, '')), '');
  v_import public.data_imports%rowtype;
  v_source public.import_rows%rowtype;
  v_pending public.patient_identity_review_requests%rowtype;
  v_attempt integer;
  v_request public.patient_identity_review_requests%rowtype;
  v_candidate_valid boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_tenant_id is null or p_organization_id is null or p_import_id is null
     or p_row_number is null or p_row_number < 1 then
    raise exception 'Tenant, Organization, import and positive source row number are required';
  end if;
  if v_mrn is null then
    raise exception 'Incoming MRN is required';
  end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 2000 then
    raise exception 'Review rationale must contain between 10 and 2000 characters';
  end if;

  if not exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = v_user_id
      and tm.status = 'active'
      and tm.role in ('tenant_admin', 'clinic_admin', 'data_manager', 'clinician', 'reviewer')
  ) then
    raise exception 'Active authorized clinic membership required to request identity review';
  end if;

  select di.* into v_import
  from public.data_imports di
  where di.id = p_import_id
    and di.tenant_id = p_tenant_id
    and di.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Import does not belong to the selected tenant and Organization';
  end if;

  select ir.* into v_source
  from public.import_rows ir
  where ir.tenant_id = p_tenant_id
    and ir.import_id = p_import_id
    and ir.row_number = p_row_number
  for update;
  if not found then
    raise exception 'Source row does not belong to the selected tenant and import';
  end if;

  if p_candidate_patient_id is not null then
    select exists (
      select 1
      from public.patients p
      where p.id = p_candidate_patient_id
        and p.tenant_id = p_tenant_id
        and p.organization_id = p_organization_id
        and p.local_mrn = v_mrn
    ) into v_candidate_valid;
    if not v_candidate_valid then
      raise exception 'Suggested candidate must match the same tenant, Organization and incoming MRN';
    end if;
  end if;

  -- The partial unique index is one pending request per tenant/source row,
  -- irrespective of MRN. Return that request idempotently without mutation.
  select r.* into v_pending
  from public.patient_identity_review_requests r
  where r.tenant_id = p_tenant_id
    and r.import_row_id = v_source.id
    and r.decision = 'pending'
  limit 1;
  if found then
    return query select v_pending.id, true, v_pending.attempt_number;
    return;
  end if;

  select coalesce(max(r.attempt_number), 0) + 1
    into v_attempt
  from public.patient_identity_review_requests r
  where r.tenant_id = p_tenant_id
    and r.import_row_id = v_source.id;

  insert into public.patient_identity_review_requests (
    tenant_id, organization_id, import_id, import_row_id,
    incoming_mrn, incoming_snapshot, candidate_patient_id,
    attempt_number, decision
  ) values (
    p_tenant_id, p_organization_id, p_import_id, v_source.id,
    v_mrn, coalesce(v_source.original_data, '{}'::jsonb), p_candidate_patient_id,
    v_attempt, 'pending'
  )
  returning * into v_request;

  -- Avoid writing a 16-digit national identifier if pasted into free text.
  v_reason := regexp_replace(v_reason, '\\m[0-9]{16}\\M', '************', 'g');

  insert into public.audit_logs (
    tenant_id, actor_user_id, action, entity_type, entity_id, outcome, metadata
  ) values (
    p_tenant_id, v_user_id, 'patient_identity_review_requested',
    'patient_identity_review_request', v_request.id::text, 'success',
    jsonb_build_object(
      'import_id', p_import_id,
      'import_row_id', v_source.id,
      'row_number', p_row_number,
      'incoming_mrn', v_mrn,
      'candidate_patient_id', p_candidate_patient_id,
      'attempt_number', v_attempt,
      'reason', v_reason
    )
  );

  return query select v_request.id, false, v_attempt;
end;
$$;

revoke all on function public.create_patient_identity_review_request(
  uuid, uuid, uuid, integer, text, text, uuid
) from public, anon;
grant execute on function public.create_patient_identity_review_request(
  uuid, uuid, uuid, integer, text, text, uuid
) to authenticated;

commit;
