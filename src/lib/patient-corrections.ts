import { supabase } from './supabase'
import type { PatientConflictResolutionRequest } from '../components/PatientConflictResolution'

export async function createPatientCorrectionRequest(request: PatientConflictResolutionRequest) {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError) throw authError
  if (!auth.user) throw new Error('Sign in before submitting a correction proposal.')

  // Resolve tenant scope from the Patient row; never accept a client-supplied tenant ID.
  const { data: patient, error: patientError } = await supabase
    .from('patients')
    .select('id, tenant_id')
    .eq('id', request.patientId)
    .single()
  if (patientError) throw patientError

  const { data: fhir, error: fhirError } = await supabase
    .from('fhir_resources')
    .select('id')
    .eq('tenant_id', patient.tenant_id)
    .eq('patient_id', patient.id)
    .eq('resource_type', 'Patient')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (fhirError) throw fhirError

  const { data: created, error: insertError } = await supabase
    .from('patient_correction_requests')
    .insert({
      tenant_id: patient.tenant_id,
      patient_id: patient.id,
      fhir_resource_id: fhir?.id ?? null,
      field_path: `Patient.${request.field}`,
      original_value: request.currentValue,
      proposed_value: request.proposedValue,
      reason: request.reason,
      status: 'pending',
      requested_by: auth.user.id,
    })
    .select('id, status, created_at')
    .single()
  if (insertError) throw insertError

  // Audit is a separate append-only event. The correction request remains pending
  // and no canonical Patient or FHIR payload is changed here.
  const { error: auditError } = await supabase.from('audit_logs').insert({
    tenant_id: patient.tenant_id,
    actor_user_id: auth.user.id,
    action: 'patient_correction_requested',
    entity_type: 'patient_correction_request',
    entity_id: created.id,
    outcome: 'success',
    metadata: {
      patient_id: patient.id,
      field_path: `Patient.${request.field}`,
      status: 'pending',
      fhir_resource_id: fhir?.id ?? null,
    },
  })
  if (auditError) {
    // Do not falsely report the request as failed: it is already safely stored.
    return { ...created, auditWarning: 'Correction request saved, but audit event could not be written.' }
  }
  return created
}

/**
 * Applies an already-approved Patient.name correction through a tenant-checked,
 * SECURITY INVOKER database function. This creates a new FHIR draft; it does not
 * approve or submit that draft to SATUSEHAT.
 */
export async function applyApprovedPatientNameCorrection(requestId: string) {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError) throw authError
  if (!auth.user) throw new Error('Sign in before applying an approved correction.')

  const { data, error } = await supabase.rpc('apply_approved_patient_name_correction', {
    p_request_id: requestId,
  })
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}
