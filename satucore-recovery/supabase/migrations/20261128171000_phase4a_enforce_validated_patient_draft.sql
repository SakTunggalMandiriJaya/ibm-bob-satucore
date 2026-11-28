
CREATE OR REPLACE FUNCTION public.create_patient_from_validated_import(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_import_id uuid,
  p_import_row_id uuid,
  p_validation_report_id uuid,
  p_canonical jsonb,
  p_fhir_patient jsonb,
  p_issues jsonb,
  p_fhir_payload_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_row public.import_rows%rowtype;
  v_import public.data_imports%rowtype;
  v_draft public.patient_drafts%rowtype;
  v_report public.patient_draft_validation_reports%rowtype;
  v_patient_id uuid;
  v_resource_id uuid;
  v_link_id uuid;
  v_mrn text;
  v_nik text;
  v_outcome text;
  v_source_reference text;
BEGIN
  -- Authentication and tenant authorization
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT private.has_tenant_role(
    p_tenant_id,
    ARRAY['tenant_admin','clinic_admin','data_manager']::text[]
  ) THEN
    RAISE EXCEPTION 'Not authorized for this clinic';
  END IF;

  -- Basic request shape
  IF jsonb_typeof(p_canonical) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_fhir_patient) IS DISTINCT FROM 'object'
     OR p_fhir_patient->>'resourceType' IS DISTINCT FROM 'Patient'
     OR jsonb_typeof(p_issues) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Canonical Patient, FHIR Patient or issues payload has invalid shape';
  END IF;

  IF p_fhir_payload_hash IS NULL
     OR p_fhir_payload_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'Invalid FHIR payload hash';
  END IF;

  -- Preserve existing lock order: import, then source row.
  SELECT *
  INTO v_import
  FROM public.data_imports
  WHERE id = p_import_id
    AND tenant_id = p_tenant_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import does not belong to this tenant and Organization';
  END IF;

  SELECT *
  INTO v_row
  FROM public.import_rows
  WHERE id = p_import_row_id
    AND import_id = p_import_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source row does not belong to this tenant and import';
  END IF;

  -- Identity review must be resolved before creating a new Patient.
  IF v_row.processing_status = 'identity_review'
     OR EXISTS (
       SELECT 1
       FROM public.patient_identity_review_requests r
       WHERE r.tenant_id = p_tenant_id
         AND r.import_id = p_import_id
         AND r.import_row_id = p_import_row_id
         AND r.decision = 'pending'
     )
  THEN
    RAISE EXCEPTION
      'Identity review is pending; Patient creation is blocked until a human decision';
  END IF;

  -- Lock the one authoritative Patient Draft for this source row.
  SELECT *
  INTO v_draft
  FROM public.patient_drafts d
  WHERE d.tenant_id = p_tenant_id
    AND d.import_id = p_import_id
    AND d.import_row_id = p_import_row_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A persisted Patient Draft is required';
  END IF;

  IF v_draft.status IS DISTINCT FROM 'validated'
     OR v_draft.validation_report_id IS DISTINCT FROM p_validation_report_id
     OR v_draft.row_number IS DISTINCT FROM v_row.row_number
     OR v_draft.validated_at IS NULL
  THEN
    RAISE EXCEPTION
      'Patient Draft is not currently validated against the supplied report and source row';
  END IF;

  -- Load the exact report bound to the locked draft.
  SELECT *
  INTO v_report
  FROM public.patient_draft_validation_reports r
  WHERE r.id = p_validation_report_id
    AND r.tenant_id = p_tenant_id
    AND r.import_id = p_import_id
    AND r.import_row_id = p_import_row_id
    AND r.row_number = v_row.row_number
    AND r.outcome = 'passed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A matching passing Patient validation report is required';
  END IF;

  -- Do not mistake partial local checks for SATUSEHAT conformance.
  IF v_report.validator IS DISTINCT FROM 'satucore-patient-local'
     OR v_report.validator_version IS DISTINCT FROM '0.2.0'
     OR v_report.conformance_scope IS DISTINCT FROM
       'local_deterministic_checks; fhir_r4_structure_partial; satusehat_profile_not_executed'
  THEN
    RAISE EXCEPTION
      'Validation report does not have the required Patient validator identity and scope';
  END IF;

  -- Verify the complete persisted validation lineage.
  IF v_report.payload_hash IS DISTINCT FROM v_draft.payload_hash
     OR v_report.input_hash IS DISTINCT FROM v_draft.input_hash
     OR v_report.approved_mappings IS DISTINCT FROM v_draft.mapping_snapshot
  THEN
    RAISE EXCEPTION
      'Validation report does not match the current Patient Draft lineage';
  END IF;

  -- Bind all submitted data to the persisted, validated draft.
  IF p_fhir_payload_hash IS DISTINCT FROM v_draft.payload_hash THEN
    RAISE EXCEPTION 'Submitted FHIR hash does not match the validated Patient Draft';
  END IF;

  IF p_fhir_patient IS DISTINCT FROM v_draft.fhir_patient THEN
    RAISE EXCEPTION 'Submitted FHIR Patient differs from the validated Patient Draft';
  END IF;

  IF p_canonical IS DISTINCT FROM v_draft.canonical_patient THEN
    RAISE EXCEPTION 'Submitted canonical Patient differs from the validated Patient Draft';
  END IF;

  IF p_issues IS DISTINCT FROM v_report.issues
     OR jsonb_array_length(v_report.issues) <> 0
  THEN
    RAISE EXCEPTION
      'A passed Patient report must match the submitted issues and contain no issues';
  END IF;

  -- Existing duplicate-source safeguards.
  IF EXISTS (
    SELECT 1
    FROM public.patient_source_links
    WHERE tenant_id = p_tenant_id
      AND import_row_id = p_import_row_id
  ) THEN
    RAISE EXCEPTION 'This source row is already linked to a Patient';
  END IF;

  v_source_reference := 'import_rows/' || p_import_row_id::text;

  IF EXISTS (
    SELECT 1
    FROM public.patients
    WHERE tenant_id = p_tenant_id
      AND source_record_reference = v_source_reference
  ) THEN
    RAISE EXCEPTION 'This source row already has a canonical Patient';
  END IF;

  -- Existing MRN/NIK extraction and format checks.
  v_mrn := NULLIF(BTRIM(p_canonical->>'local_mrn'), '');

  SELECT NULLIF(BTRIM(identifier->>'value'), '')
  INTO v_nik
  FROM jsonb_array_elements(
    COALESCE(p_canonical->'source_identifiers', '[]'::jsonb)
  ) AS identifiers(identifier)
  WHERE identifier->>'system' = 'urn:satucore:source-nik'
  LIMIT 1;

  IF v_nik IS NOT NULL AND v_nik !~ '^[0-9]{16}$' THEN
    RAISE EXCEPTION
      'NIK_INVALID_FORMAT: The canonical NIK must contain exactly 16 digits';
  END IF;

  IF v_mrn IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || ':' ||
        p_organization_id::text || ':' ||
        v_mrn,
        0
      )
    );

    IF EXISTS (
      SELECT 1
      FROM public.patients
      WHERE tenant_id = p_tenant_id
        AND organization_id = p_organization_id
        AND local_mrn = v_mrn
    ) THEN
      RAISE EXCEPTION
        'MRN_CONFLICT: This source MRN already exists in this clinic. Identity review is required.';
    END IF;
  END IF;

  IF v_nik IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || ':urn:satucore:source-nik:' || v_nik,
        0
      )
    );

    IF EXISTS (
      SELECT 1
      FROM public.patient_identifiers
      WHERE tenant_id = p_tenant_id
        AND system = 'urn:satucore:source-nik'
        AND value = v_nik
    ) THEN
      RAISE EXCEPTION
        'NIK_CONFLICT: This NIK is already recorded for another Patient in this tenant. Human identity review is required.';
    END IF;
  END IF;

  -- Create canonical Patient.
  INSERT INTO public.patients(
    tenant_id,
    organization_id,
    local_mrn,
    active,
    name,
    birth_date,
    administrative_gender,
    telecom,
    addresses,
    source_identifiers,
    source_record_reference,
    provenance
  )
  VALUES (
    p_tenant_id,
    p_organization_id,
    v_mrn,
    COALESCE((p_canonical->>'active')::boolean, true),
    COALESCE(p_canonical->'name', '[]'::jsonb),
    NULLIF(p_canonical->>'birth_date', '')::date,
    NULLIF(p_canonical->>'administrative_gender', ''),
    COALESCE(p_canonical->'telecom', '[]'::jsonb),
    COALESCE(p_canonical->'addresses', '[]'::jsonb),
    COALESCE(p_canonical->'source_identifiers', '[]'::jsonb),
    v_source_reference,
    COALESCE(p_canonical->'provenance', '{}'::jsonb)
  )
  RETURNING id INTO v_patient_id;

  -- Source MRN remains unverified.
  IF v_mrn IS NOT NULL THEN
    INSERT INTO public.patient_identifiers(
      tenant_id,
      patient_id,
      system,
      value,
      identifier_type,
      is_primary,
      verification_status
    )
    VALUES (
      p_tenant_id,
      v_patient_id,
      'urn:satucore:source-mrn',
      v_mrn,
      'MR',
      true,
      'unverified'
    );
  END IF;

  -- NIK is recorded as unverified, never as proof of identity.
  IF v_nik IS NOT NULL THEN
    INSERT INTO public.patient_identifiers(
      tenant_id,
      patient_id,
      system,
      value,
      identifier_type,
      is_primary,
      verification_status
    )
    VALUES (
      p_tenant_id,
      v_patient_id,
      'urn:satucore:source-nik',
      v_nik,
      NULL,
      false,
      'unverified'
    );
  END IF;

  -- Create FHIR Patient draft; this does not transmit to SATUSEHAT.
  INSERT INTO public.fhir_resources(
    tenant_id,
    patient_id,
    resource_type,
    fhir_version,
    profile_urls,
    payload,
    payload_hash,
    status,
    source_record_reference,
    created_by
  )
  VALUES (
    p_tenant_id,
    v_patient_id,
    'Patient',
    '4.0.1',
    ARRAY['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient'],
    p_fhir_patient,
    p_fhir_payload_hash,
    'draft',
    v_source_reference,
    v_user_id
  )
  RETURNING id INTO v_resource_id;

  -- A passed report with no issues yields passed local validation.
  v_outcome := 'passed';

    INSERT INTO public.validation_results(
    tenant_id,
    fhir_resource_id,
    validator,
    validator_version,
    conformance_scope,
    outcome,
    issues
  )
  VALUES (
    p_tenant_id,
    v_resource_id,
    v_report.validator,
    v_report.validator_version,
    v_report.conformance_scope,
    v_outcome,
    p_issues
  );

  -- Link source row to the newly created Patient.
  INSERT INTO public.patient_source_links(
    tenant_id,
    organization_id,
    patient_id,
    import_id,
    import_row_id,
    source_system_id,
    source_record_key,
    link_type,
    created_by
  )
  VALUES (
    p_tenant_id,
    p_organization_id,
    v_patient_id,
    p_import_id,
    p_import_row_id,
    v_import.source_system_id,
    v_row.source_record_key,
    'new_patient',
    v_user_id
  )
  RETURNING id INTO v_link_id;

  UPDATE public.import_rows
  SET normalized_data = p_canonical,
      processing_status = 'processed',
      issues = p_issues
  WHERE id = p_import_row_id
    AND tenant_id = p_tenant_id;

  INSERT INTO public.audit_logs(
    tenant_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outcome,
    metadata
  )
  VALUES (
    p_tenant_id,
    v_user_id,
    'canonical_patient_created',
    'patient',
    v_patient_id::text,
    'success',
    jsonb_build_object(
      'fhir_resource_id', v_resource_id,
      'source_link_id', v_link_id,
      'import_id', p_import_id,
      'import_row_id', p_import_row_id,
      'validation_outcome', v_outcome,
      'validation_report_id', p_validation_report_id,
      'source_nik_recorded', (v_nik IS NOT NULL)
    )
  );

  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'resource_id', v_resource_id,
    'source_link_id', v_link_id,
    'outcome', v_outcome
  );
END;
$function$;

-- Preserve the live function's existing execution grants.
REVOKE ALL ON FUNCTION public.create_patient_from_validated_import(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_patient_from_validated_import(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_patient_from_validated_import(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text
) TO service_role;
