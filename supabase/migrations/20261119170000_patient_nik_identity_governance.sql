-- SATUCORE P0: preserve NIK separately and enforce server-side identity conflict checks.
-- Existing Patient records and historical identity decisions are intentionally untouched.

create or replace function public.create_patient_from_validated_import(
  p_tenant_id uuid,p_organization_id uuid,p_import_id uuid,p_import_row_id uuid,
  p_validation_report_id uuid,p_canonical jsonb,p_fhir_patient jsonb,p_issues jsonb,p_fhir_payload_hash text
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.import_rows%rowtype;
  v_import public.data_imports%rowtype;
  v_report public.patient_draft_validation_reports%rowtype;
  v_patient_id uuid;
  v_resource_id uuid;
  v_link_id uuid;
  v_mrn text;
  v_nik text;
  v_outcome text;
  v_source_reference text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if not private.has_tenant_role(p_tenant_id,array['tenant_admin','clinic_admin','data_manager']::text[]) then raise exception 'Not authorized for this clinic'; end if;
  if p_fhir_patient->>'resourceType' is distinct from 'Patient' then raise exception 'FHIR payload must be a Patient resource'; end if;
  if jsonb_typeof(p_canonical) is distinct from 'object' or jsonb_typeof(p_issues) is distinct from 'array' then raise exception 'Canonical Patient and issues payload have invalid shape'; end if;
  if p_fhir_payload_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid FHIR payload hash'; end if;

  select * into v_import
  from public.data_imports
  where id=p_import_id and tenant_id=p_tenant_id and organization_id=p_organization_id
  for update;
  if not found then raise exception 'Import does not belong to this tenant and Organization'; end if;

  select * into v_row
  from public.import_rows
  where id=p_import_row_id and import_id=p_import_id and tenant_id=p_tenant_id
  for update;
  if not found then raise exception 'Source row does not belong to this tenant and import'; end if;

  if v_row.processing_status='identity_review'
     or exists(
       select 1 from public.patient_identity_review_requests r
       where r.tenant_id=p_tenant_id and r.import_id=p_import_id
         and r.import_row_id=p_import_row_id and r.decision='pending'
     ) then
    raise exception 'Identity review is pending; Patient creation is blocked until a human decision';
  end if;

  select * into v_report
  from public.patient_draft_validation_reports
  where id=p_validation_report_id and tenant_id=p_tenant_id
    and import_id=p_import_id and import_row_id=p_import_row_id and outcome='passed';
  if not found then raise exception 'A matching passing Patient validation report is required'; end if;

  if exists(select 1 from public.patient_source_links where tenant_id=p_tenant_id and import_row_id=p_import_row_id) then
    raise exception 'This source row is already linked to a Patient';
  end if;

  v_source_reference := 'import_rows/' || p_import_row_id::text;
  if exists(select 1 from public.patients where tenant_id=p_tenant_id and source_record_reference=v_source_reference) then
    raise exception 'This source row already has a canonical Patient';
  end if;

  v_mrn := nullif(btrim(p_canonical->>'local_mrn'),'');
  select nullif(btrim(identifier->>'value'),'')
    into v_nik
  from jsonb_array_elements(coalesce(p_canonical->'source_identifiers','[]'::jsonb)) as identifiers(identifier)
  where identifier->>'system'='urn:satucore:source-nik'
  limit 1;

  if v_nik is not null and v_nik !~ '^[0-9]{16}$' then
    raise exception 'NIK_INVALID_FORMAT: The canonical NIK must contain exactly 16 digits';
  end if;

  if v_mrn is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_organization_id::text || ':' || v_mrn,0));
    if exists(select 1 from public.patients where tenant_id=p_tenant_id and organization_id=p_organization_id and local_mrn=v_mrn) then
      raise exception 'MRN_CONFLICT: This source MRN already exists in this clinic. Identity review is required.';
    end if;
  end if;

  if v_nik is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':urn:satucore:source-nik:' || v_nik,0));
    if exists(
      select 1 from public.patient_identifiers
      where tenant_id=p_tenant_id and system='urn:satucore:source-nik' and value=v_nik
    ) then
      raise exception 'NIK_CONFLICT: This NIK is already recorded for another Patient in this tenant. Human identity review is required.';
    end if;
  end if;

  insert into public.patients(
    tenant_id,organization_id,local_mrn,active,name,birth_date,administrative_gender,
    telecom,addresses,source_identifiers,source_record_reference,provenance
  )
  values(
    p_tenant_id,p_organization_id,v_mrn,coalesce((p_canonical->>'active')::boolean,true),
    coalesce(p_canonical->'name','[]'::jsonb),
    nullif(p_canonical->>'birth_date','')::date,
    nullif(p_canonical->>'administrative_gender',''),
    coalesce(p_canonical->'telecom','[]'::jsonb),
    coalesce(p_canonical->'addresses','[]'::jsonb),
    coalesce(p_canonical->'source_identifiers','[]'::jsonb),
    v_source_reference,coalesce(p_canonical->'provenance','{}'::jsonb)
  ) returning id into v_patient_id;

  if v_mrn is not null then
    insert into public.patient_identifiers(
      tenant_id,patient_id,system,value,identifier_type,is_primary,verification_status
    ) values(
      p_tenant_id,v_patient_id,'urn:satucore:source-mrn',v_mrn,'MR',true,'unverified'
    );
  end if;

  if v_nik is not null then
    insert into public.patient_identifiers(
      tenant_id,patient_id,system,value,identifier_type,is_primary,verification_status
    ) values(
      p_tenant_id,v_patient_id,'urn:satucore:source-nik',v_nik,null,false,'unverified'
    );
  end if;

  insert into public.fhir_resources(
    tenant_id,patient_id,resource_type,fhir_version,profile_urls,payload,payload_hash,status,source_record_reference,created_by
  )
  values(
    p_tenant_id,v_patient_id,'Patient','4.0.1',
    array['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient'],
    p_fhir_patient,p_fhir_payload_hash,'draft',v_source_reference,v_user_id
  ) returning id into v_resource_id;

  v_outcome := case
    when exists(select 1 from jsonb_array_elements(p_issues) x where x->>'severity'='error') then 'failed'
    when jsonb_array_length(p_issues)>0 then 'warning'
    else 'passed'
  end;

  insert into public.validation_results(
    tenant_id,fhir_resource_id,validator,validator_version,conformance_scope,outcome,issues
  ) values(
    p_tenant_id,v_resource_id,'satucore-patient-validator','0.1.0','fhir_r4',v_outcome,p_issues
  );

  insert into public.patient_source_links(
    tenant_id,organization_id,patient_id,import_id,import_row_id,source_system_id,source_record_key,link_type,created_by
  )
  values(
    p_tenant_id,p_organization_id,v_patient_id,p_import_id,p_import_row_id,
    v_import.source_system_id,v_row.source_record_key,'new_patient',v_user_id
  ) returning id into v_link_id;

  update public.import_rows
  set normalized_data=p_canonical,
      processing_status=case when v_outcome='failed' then 'failed' else 'processed' end,
      issues=p_issues
  where id=p_import_row_id and tenant_id=p_tenant_id;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
  values(
    p_tenant_id,v_user_id,'canonical_patient_created','patient',v_patient_id::text,'success',
    jsonb_build_object(
      'fhir_resource_id',v_resource_id,'source_link_id',v_link_id,'import_id',p_import_id,
      'import_row_id',p_import_row_id,'validation_outcome',v_outcome,
      'validation_report_id',p_validation_report_id,'source_nik_recorded',(v_nik is not null)
    )
  );

  return jsonb_build_object('patient_id',v_patient_id,'resource_id',v_resource_id,'source_link_id',v_link_id,'outcome',v_outcome);
end;
$$;

revoke all on function public.create_patient_from_validated_import(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text) from public,anon;
grant execute on function public.create_patient_from_validated_import(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text) to authenticated;


create or replace function public.decide_patient_identity_review(
 p_review_id uuid,p_decision text,p_candidate_patient_id uuid default null,p_comment text default null
) returns table(review_id uuid,decision text,linked_patient_id uuid,row_status text)
language plpgsql security invoker set search_path=''
as $function$
declare
 v_user uuid:=auth.uid();
 v_review public.patient_identity_review_requests%rowtype;
 v_candidate public.patients%rowtype;
 v_import public.data_imports%rowtype;
 v_source public.import_rows%rowtype;
 v_existing public.patient_source_links%rowtype;
 v_status text;
 v_rows integer;
 v_comment text:=nullif(btrim(coalesce(p_comment,'')),'');
 v_incoming_nik text;
 v_candidate_nik text;
 v_candidate_nik_count integer:=0;
 v_incoming_name text;
 v_candidate_name text;
 v_incoming_dob text;
 v_candidate_dob text;
 v_incoming_gender text;
 v_candidate_gender text;
 v_identity_conflicts text[]:=array[]::text[];
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if p_decision is null or p_decision not in ('confirmed_match','not_same_patient','unresolved') then
   raise exception 'Invalid identity review decision';
 end if;
 if v_comment is null or length(v_comment)<10 then
   raise exception 'Evidence and rationale must contain at least 10 characters';
 end if;

 select r.* into v_review
 from public.patient_identity_review_requests r
 where r.id=p_review_id
 for update;
 if not found then raise exception 'Identity review request not found'; end if;

 -- Preserve idempotent reads of an already-recorded historical decision.
 if v_review.decision='confirmed_match'
    and p_decision='confirmed_match'
    and v_review.candidate_patient_id=p_candidate_patient_id then
   select l.* into v_existing
   from public.patient_source_links l
   where l.tenant_id=v_review.tenant_id and l.import_row_id=v_review.import_row_id;
   if found and v_existing.patient_id=p_candidate_patient_id
      and v_existing.organization_id=v_review.organization_id then
     return query select v_review.id,'confirmed_match'::text,v_existing.patient_id,'identity_matched'::text;
     return;
   end if;
 end if;

 if v_review.decision<>'pending' then
   raise exception 'This identity review has already been decided';
 end if;

 if not exists(
   select 1 from public.tenant_members tm
   where tm.tenant_id=v_review.tenant_id and tm.user_id=v_user
     and tm.status='active' and tm.role in ('tenant_admin','clinic_admin','data_manager')
 ) then
   raise exception 'Clinic administrator or data manager role required to finalize this identity decision';
 end if;

 select di.* into v_import
 from public.data_imports di
 where di.id=v_review.import_id and di.tenant_id=v_review.tenant_id
   and di.organization_id=v_review.organization_id
 for update;
 if not found then raise exception 'Import does not belong to this tenant and Organization'; end if;

 select ir.* into v_source
 from public.import_rows ir
 where ir.id=v_review.import_row_id and ir.import_id=v_review.import_id
   and ir.tenant_id=v_review.tenant_id
 for update;
 if not found then raise exception 'Source row does not belong to this tenant, import and Organization'; end if;

 if p_decision='confirmed_match' then
   if p_candidate_patient_id is null then
     raise exception 'Select the existing clinic Patient to confirm a match';
   end if;

   select p.* into v_candidate
   from public.patients p
   where p.id=p_candidate_patient_id and p.tenant_id=v_review.tenant_id
     and p.organization_id=v_review.organization_id and p.local_mrn=v_review.incoming_mrn
   for update;
   if not found then
     raise exception 'Selected Patient does not match this clinic and incoming MRN';
   end if;

   -- Resolve source evidence from the immutable review snapshot first, then the stored source row.
   v_incoming_nik := coalesce(
     nullif(btrim(v_review.incoming_snapshot->>'nik'),''),
     nullif(btrim(v_review.incoming_snapshot->>'NIK'),''),
     nullif(btrim(v_review.incoming_snapshot->>'national_id'),''),
     nullif(btrim(v_review.incoming_snapshot->>'national_identifier'),''),
     nullif(btrim(v_review.incoming_snapshot->>'nomor_induk_kependudukan'),''),
     nullif(btrim(v_review.incoming_snapshot->>'no_ktp'),''),
     nullif(btrim(v_review.incoming_snapshot->>'ktp'),''),
     nullif(btrim(v_source.original_data->>'nik'),''),
     nullif(btrim(v_source.original_data->>'NIK'),''),
     nullif(btrim(v_source.original_data->>'national_id'),''),
     nullif(btrim(v_source.original_data->>'national_identifier'),''),
     nullif(btrim(v_source.original_data->>'nomor_induk_kependudukan'),''),
     nullif(btrim(v_source.original_data->>'no_ktp'),''),
     nullif(btrim(v_source.original_data->>'ktp'),'')
   );

   select count(*),min(pi.value)
   into v_candidate_nik_count,v_candidate_nik
   from public.patient_identifiers pi
   where pi.tenant_id=v_review.tenant_id
     and pi.patient_id=v_candidate.id
     and pi.system='urn:satucore:source-nik';

   if v_candidate_nik_count>1 then
     v_identity_conflicts:=array_append(v_identity_conflicts,'nik_multiple_identifiers');
   end if;
   if v_incoming_nik is not null and v_incoming_nik !~ '^[0-9]{16}$' then
     v_identity_conflicts:=array_append(v_identity_conflicts,'nik_invalid_format');
   end if;
   if v_candidate_nik is not null and v_candidate_nik !~ '^[0-9]{16}$' then
     v_identity_conflicts:=array_append(v_identity_conflicts,'candidate_nik_invalid_format');
   end if;
   if v_incoming_nik is not null and v_candidate_nik is not null
      and v_incoming_nik<>v_candidate_nik then
     v_identity_conflicts:=array_append(v_identity_conflicts,'nik');
   end if;

   v_incoming_name:=coalesce(
     nullif(btrim(v_review.incoming_snapshot->>'full_name'),''),
     nullif(btrim(v_review.incoming_snapshot->>'name'),''),
     nullif(btrim(v_review.incoming_snapshot->>'patient_name'),''),
     nullif(btrim(v_source.original_data->>'full_name'),''),
     nullif(btrim(v_source.original_data->>'name'),''),
     nullif(btrim(v_source.original_data->>'patient_name'),'')
   );
   v_candidate_name:=coalesce(
     nullif(btrim(v_candidate.name #>> '{0,text}'),''),
     nullif(btrim(v_candidate.name #>> '{0,family}'),'')
   );
   if v_incoming_name is not null and v_candidate_name is not null
      and lower(regexp_replace(btrim(v_incoming_name), '\s+', ' ', 'g'))
          <> lower(regexp_replace(btrim(v_candidate_name), '\s+', ' ', 'g')) then
     v_identity_conflicts:=array_append(v_identity_conflicts,'name');
   end if;

   v_incoming_dob:=coalesce(
     nullif(btrim(v_review.incoming_snapshot->>'birth_date'),''),
     nullif(btrim(v_review.incoming_snapshot->>'dob'),''),
     nullif(btrim(v_source.original_data->>'birth_date'),''),
     nullif(btrim(v_source.original_data->>'dob'),'')
   );
   v_candidate_dob:=v_candidate.birth_date::text;
   if v_incoming_dob is not null and v_candidate_dob is not null
      and v_incoming_dob<>v_candidate_dob then
     v_identity_conflicts:=array_append(v_identity_conflicts,'birth_date');
   end if;

   v_incoming_gender:=coalesce(
     nullif(btrim(v_review.incoming_snapshot->>'gender'),''),
     nullif(btrim(v_review.incoming_snapshot->>'administrative_gender'),''),
     nullif(btrim(v_source.original_data->>'gender'),''),
     nullif(btrim(v_source.original_data->>'administrative_gender'),'')
   );
   v_candidate_gender:=v_candidate.administrative_gender;
   if v_incoming_gender is not null and v_candidate_gender is not null then
     v_incoming_gender:=case lower(btrim(v_incoming_gender))
       when 'm' then 'male' when 'l' then 'male' when 'laki-laki' then 'male'
       when 'f' then 'female' when 'p' then 'female' when 'perempuan' then 'female'
       else lower(btrim(v_incoming_gender)) end;
     v_candidate_gender:=case lower(btrim(v_candidate_gender))
       when 'm' then 'male' when 'l' then 'male' when 'laki-laki' then 'male'
       when 'f' then 'female' when 'p' then 'female' when 'perempuan' then 'female'
       else lower(btrim(v_candidate_gender)) end;
     if v_incoming_gender<>v_candidate_gender then
       v_identity_conflicts:=array_append(v_identity_conflicts,'gender');
     end if;
   end if;

   -- A missing NIK is missing evidence, never a match. It is not itself a conflict;
   -- other available attributes and the authorized human rationale remain reviewable.
   if cardinality(v_identity_conflicts)>0 then
     insert into public.audit_logs(
       tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata
     )
     values(
       v_review.tenant_id,v_user,'patient_identity_review_blocked',
       'patient_identity_review_request',v_review.id::text,'blocked',
       jsonb_build_object(
         'attempted_decision','confirmed_match',
         'candidate_patient_id',v_candidate.id,
         'import_row_id',v_review.import_row_id,
         'organization_id',v_review.organization_id,
         'blocked_fields',to_jsonb(v_identity_conflicts),
         'source_nik_present',(v_incoming_nik is not null),
         'candidate_nik_count',v_candidate_nik_count,
         'rationale_recorded',true
       )
     );
     return query select v_review.id,'blocked'::text,null::uuid,'identity_review'::text;
     return;
   end if;

   select l.* into v_existing
   from public.patient_source_links l
   where l.tenant_id=v_review.tenant_id and l.import_row_id=v_review.import_row_id;
   if found and (v_existing.patient_id<>v_candidate.id or v_existing.organization_id<>v_review.organization_id) then
     raise exception 'Source row is already linked to a different Patient';
   end if;

   if not found then
     insert into public.patient_source_links(
       tenant_id,organization_id,patient_id,import_id,import_row_id,review_request_id,
       source_system_id,source_record_key,link_type,created_by
     )
     values(
       v_review.tenant_id,v_review.organization_id,v_candidate.id,v_review.import_id,
       v_review.import_row_id,v_review.id,v_import.source_system_id,
       coalesce(nullif(btrim(v_source.source_record_key),''),v_source.id::text),
       'confirmed_match',v_user
     );
   end if;

   update public.import_rows ir
   set processing_status='identity_matched',
       normalized_data=jsonb_set(
         coalesce(ir.normalized_data,'{}'::jsonb),'{identity_review}',
         jsonb_build_object(
           'decision','confirmed_match','patient_id',v_candidate.id,'review_id',v_review.id,
           'reviewed_by',v_user,'reviewed_at',now()
         ),true
       )
   where ir.id=v_review.import_row_id and ir.import_id=v_review.import_id and ir.tenant_id=v_review.tenant_id;
   get diagnostics v_rows=row_count;
   v_status:='identity_matched';
 else
   update public.import_rows ir
   set processing_status='identity_review',
       normalized_data=jsonb_set(
         coalesce(ir.normalized_data,'{}'::jsonb),'{identity_review}',
         jsonb_build_object(
           'decision',p_decision,'review_id',v_review.id,'reviewed_by',v_user,'reviewed_at',now()
         ),true
       )
   where ir.id=v_review.import_row_id and ir.import_id=v_review.import_id and ir.tenant_id=v_review.tenant_id;
   get diagnostics v_rows=row_count;
   v_status:='identity_review';
 end if;

 if v_rows<>1 then
   raise exception 'Expected exactly one source row update; found %',v_rows;
 end if;

 -- Redact any Indonesian 16-digit national identifier entered in the rationale.
 v_comment:=regexp_replace(v_comment,'\m[0-9]{16}\M','************','g');

 update public.patient_identity_review_requests rr
 set decision=p_decision,
     candidate_patient_id=case when p_decision='confirmed_match' then p_candidate_patient_id else null end,
     reviewer_comment=v_comment,reviewed_by=v_user,reviewed_at=now()
 where rr.id=v_review.id and rr.decision='pending';
 get diagnostics v_rows=row_count;
 if v_rows<>1 then
   raise exception 'Identity review was concurrently changed; no decision was recorded';
 end if;

 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,outcome,metadata)
 values(
   v_review.tenant_id,v_user,'patient_identity_review_decided',
   'patient_identity_review_request',v_review.id::text,'success',
   jsonb_build_object(
     'decision',p_decision,
     'candidate_patient_id',case when p_decision='confirmed_match' then p_candidate_patient_id else null end,
     'import_row_id',v_review.import_row_id,
     'organization_id',v_review.organization_id,
     'mrn',v_review.incoming_mrn,
     'rationale',v_comment,
     'source_link_created',(p_decision='confirmed_match')
   )
 );

 return query select v_review.id,p_decision,
   case when p_decision='confirmed_match' then p_candidate_patient_id else null end,
   v_status;
end;
$function$;

revoke execute on function public.decide_patient_identity_review(uuid,text,uuid,text) from public,anon;
grant execute on function public.decide_patient_identity_review(uuid,text,uuid,text) to authenticated;
