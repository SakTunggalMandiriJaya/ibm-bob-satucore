CREATE OR REPLACE FUNCTION private.bind_submission_approval_to_payload()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth', 'private'
AS $function$
declare
  v_resource_tenant uuid;
  v_payload_hash text;
  v_resource_creator uuid;
begin
  select fr.tenant_id, fr.payload_hash, fr.created_by
    into v_resource_tenant, v_payload_hash, v_resource_creator
  from public.fhir_resources fr
  where fr.id = new.fhir_resource_id
  for key share;

  if not found then
    raise exception 'FHIR resource does not exist' using errcode = '23503';
  end if;

  if v_resource_tenant <> new.tenant_id then
    raise exception 'Approval tenant does not match FHIR resource tenant' using errcode = '23514';
  end if;

  if new.decision = 'approved' then
    if auth.uid() is null or new.approved_by is distinct from auth.uid() then
      raise exception 'Approval actor must match the authenticated user' using errcode = '42501';
    end if;

    if not private.has_tenant_role(new.tenant_id, array['tenant_admin','clinic_admin','reviewer','submitter']::text[]) then
      raise exception 'User is not authorized to approve this tenant resource' using errcode = '42501';
    end if;

    if v_resource_creator is null then
      raise exception 'FHIR resource creator is required for maker-checker approval' using errcode = '23514';
    end if;

    if v_resource_creator = new.approved_by then
      raise exception 'FHIR resource creator cannot approve their own resource' using errcode = '42501';
    end if;

    if v_payload_hash is null or v_payload_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'FHIR resource must have a valid stored SHA-256 payload hash' using errcode = '23514';
    end if;

    new.approved_payload_hash := v_payload_hash;
  else
    new.approved_payload_hash := null;
  end if;

  return new;
end;
$function$;
