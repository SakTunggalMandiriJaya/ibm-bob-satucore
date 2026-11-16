import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type SourceRow = Record<string, string>
export type Mapping = { source: string; target: string; confidence: number; approved: boolean }
export type Workspace = { tenantId: string; tenantName: string; role: string; organizationId: string | null; organizationName: string | null; userId: string }

function client() {
  if (!supabase) throw new Error('Supabase connection is not configured.')
  return supabase
}

export async function getWorkspace(session: Session): Promise<Workspace> {
  const db = client()
  const { data: memberships, error } = await db.from('tenant_members')
    .select('tenant_id, role, tenants(name)')
    .eq('user_id', session.user.id).eq('status', 'active')
  if (error) throw error
  if (!memberships?.length) throw new Error('No active clinic membership is assigned to this account.')
  if (memberships.length > 1) throw new Error('This account belongs to multiple clinics. Workspace selection is required before continuing.')
  const membership: any = memberships[0]
  const { data: orgs, error: orgError } = await db.from('organizations')
    .select('id,name').eq('tenant_id', membership.tenant_id).eq('active', true).order('created_at')
  if (orgError) throw orgError
  if ((orgs ?? []).length > 1) throw new Error('This clinic has multiple active Organizations. Select the facility explicitly before importing or submitting data.')
  return {
    tenantId: membership.tenant_id,
    tenantName: membership.tenants?.name ?? 'Clinic workspace',
    role: membership.role,
    organizationId: orgs?.[0]?.id ?? null,
    organizationName: orgs?.[0]?.name ?? null,
    userId: session.user.id
  }
}

const inferType = (values: string[]) => {
  const present = values.filter(v => v.trim() !== '')
  if (!present.length) return 'unknown'
  if (present.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date'
  if (present.every(v => /^(true|false|yes|no|0|1)$/i.test(v))) return 'boolean'
  if (present.every(v => /^-?\d+(\.\d+)?$/.test(v))) return 'number'
  return 'string'
}

export async function persistImport(args: {
  workspace: Workspace; file: File; rows: SourceRow[]; fields: Mapping[]
}): Promise<string> {
  const db = client()
  const { workspace: w, file, rows, fields } = args
  const fileDigest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const checksum = Array.from(new Uint8Array(fileDigest)).map(b=>b.toString(16).padStart(2,'0')).join('')
  const { data: imported, error: importError } = await db.from('data_imports').insert({
    tenant_id: w.tenantId, organization_id: w.organizationId, uploaded_by: w.userId,
    original_filename: file.name, file_type: 'text/csv', file_size_bytes: file.size, checksum_sha256: checksum,
    status: 'profiling', total_rows: rows.length,
    metadata: { ingestion: 'browser_csv_parser', synthetic_or_user_supplied: 'unclassified', profile_version: 'satucore-scan-0.1' }
  }).select('id').single()
  if (importError) throw importError
  const importId = imported.id
  try {
    const path = `${w.tenantId}/${importId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error: storageError } = await db.storage.from('legacy-imports').upload(path, file, { upsert: false, contentType: 'text/csv' })
    if (storageError) throw storageError
    const { error: updateError } = await db.from('data_imports').update({ storage_path: path, status: 'profiling' }).eq('id', importId).eq('tenant_id', w.tenantId)
    if (updateError) throw updateError

    const columns = Object.keys(rows[0] ?? {})
    const profiles = columns.map(column => {
      const values = rows.map(row => String(row[column] ?? ''))
      const present = values.filter(v => v.trim() !== '')
      return {
        tenant_id: w.tenantId, import_id: importId, sheet_name: 'CSV',
        column_name: column, inferred_type: inferType(values), detected_format: null,
        null_count: values.length - present.length, distinct_count: new Set(present).size,
        sample_values: present.slice(0, 5),
        quality_findings: values.length !== present.length ? [{ code: 'EMPTY_VALUES', count: values.length - present.length, severity: 'warning' }] : []
      }
    })
    if (profiles.length) {
      const { error } = await db.from('schema_profiles').insert(profiles)
      if (error) throw error
    }
    const mrnField = fields.find(f=>f.target==='identifier')?.source
    const mrnCounts = new Map<string,number>()
    if (mrnField) for (const row of rows) { const value=String(row[mrnField]??'').trim(); if(value) mrnCounts.set(value,(mrnCounts.get(value)??0)+1) }
    const chunkSize = 250
    for (let i = 0; i < rows.length; i += chunkSize) {
      const batch = rows.slice(i, i + chunkSize).map((original, index) => ({
        tenant_id: w.tenantId, import_id: importId, row_number: i + index + 1,
        source_record_key: null, original_data: original, processing_status: 'profiled',
        issues: [...Object.entries(original).filter(([,v]) => !String(v ?? '').trim()).map(([field]) => ({ code: 'EMPTY_VALUE', field, severity: 'warning' })), ...(mrnField && String(original[mrnField]??'').trim() && (mrnCounts.get(String(original[mrnField]).trim())??0)>1 ? [{code:'DUPLICATE_SOURCE_IDENTIFIER',field:mrnField,severity:'error',message:'Duplicate source identifier within this import. Human identity review is required.'}] : [])]
      }))
      const { error } = await db.from('import_rows').insert(batch)
      if (error) throw error
    }
    if (fields.length) {
      const mappings = fields.filter(f => f.target !== '—').map(f => ({
        tenant_id: w.tenantId, import_id: importId, source_field: f.source,
        target_resource: 'Patient', target_field: f.target,
        mapping_expression: { method: 'column_copy', source_field: f.source },
        confidence: f.confidence, recommendation_source: 'deterministic',
        status: f.approved ? 'approved' : 'proposed', created_by: w.userId
      }))
      const { error } = await db.from('field_mappings').insert(mappings)
      if (error) throw error
    }
    const { error: doneError } = await db.from('data_imports').update({
      status: 'profiled', error_count: mrnField ? rows.filter(row=>{const v=String(row[mrnField]??'').trim();return !!v&&(mrnCounts.get(v)??0)>1}).length : 0, warning_count: rows.reduce((n,row)=>n+Object.values(row).filter(v=>!String(v??'').trim()).length,0)
    }).eq('id', importId).eq('tenant_id', w.tenantId)
    if (doneError) throw doneError
    await writeAudit(w, 'legacy_import_profiled', 'data_import', importId, { row_count: rows.length, column_count: columns.length })
    return importId
  } catch (error) {
    await db.from('data_imports').update({ status: 'failed' }).eq('id', importId).eq('tenant_id', w.tenantId)
    throw error
  }
}

export async function persistMappingReview(workspace: Workspace, importId: string, fields: Mapping[]) {
  const db = client()
  for (const field of fields) {
    const { data: mapping, error } = await db.from('field_mappings')
      .select('id').eq('tenant_id', workspace.tenantId).eq('import_id', importId)
      .eq('source_field', field.source).maybeSingle()
    if (error) throw error
    if (!mapping) continue
    const status = field.approved && field.target !== '—' ? 'approved' : 'proposed'
    const { error: updateError } = await db.from('field_mappings').update({
      target_field: field.target === '—' ? 'unmapped' : field.target, status,
      mapping_expression: { method: 'column_copy', source_field: field.source, reviewed_by: workspace.userId }
    }).eq('id', mapping.id).eq('tenant_id', workspace.tenantId)
    if (updateError) throw updateError
    if (field.approved && field.target !== '—') {
      const { data: prior, error: priorError } = await db.from('mapping_approvals').select('id').eq('tenant_id',workspace.tenantId).eq('mapping_id',mapping.id).order('decided_at',{ascending:false}).limit(1)
      if (priorError) throw priorError
      if (prior?.[0]) {
        const { error: approvalError } = await db.from('mapping_approvals').update({decision:'approved',comments:'Human-approved in SATUCORE mapping review.',decided_by:workspace.userId,decided_at:new Date().toISOString()}).eq('id',prior[0].id).eq('tenant_id',workspace.tenantId)
        if (approvalError) throw approvalError
      } else {
        const { error: approvalError } = await db.from('mapping_approvals').insert({tenant_id:workspace.tenantId,mapping_id:mapping.id,decision:'approved',comments:'Human-approved in SATUCORE mapping review.',decided_by:workspace.userId})
        if (approvalError) throw approvalError
      }
    }
  }
  const { error: importStatusError } = await db.from('data_imports').update({status:'review'}).eq('id',importId).eq('tenant_id',workspace.tenantId)
  if (importStatusError) throw importStatusError
  await writeAudit(workspace, 'patient_mapping_reviewed', 'data_import', importId, { approved_fields: fields.filter(f=>f.approved).map(f=>f.source) })
}

export function normalizePatient(row: SourceRow, fields: Mapping[]) {
  const value = (target: string) => {
    const field = fields.find(f => f.target === target && f.approved)
    return field ? String(row[field.source] ?? '').trim() : ''
  }
  const rawName = value('name')
  const dob = value('birthDate')
  const genderRaw = value('gender').toUpperCase()
  const phone = value('telecom')
  const mrn = value('identifier')
  const gender = genderRaw === 'M' || genderRaw === 'MALE' ? 'male'
    : genderRaw === 'F' || genderRaw === 'FEMALE' ? 'female'
    : genderRaw === 'OTHER' ? 'other' : 'unknown'
  const canonical = {
    local_mrn: mrn || null, active: true,
    name: rawName ? [{ text: rawName, use: 'official' }] : [],
    birth_date: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null,
    administrative_gender: gender,
    telecom: phone ? [{ system: 'phone', value: phone }] : [],
    addresses: value('address') ? [{ text: value('address') }] : [],
    source_identifiers: mrn ? [{ system: 'urn:satucore:source-mrn', value: mrn }] : [],
    provenance: { transformation: 'satucore-canonical-patient-v1', source_fields: fields.filter(f=>f.approved).map(f=>({source:f.source,target:f.target})), human_reviewed: true }
  }
  const issues: {code:string,severity:'error'|'warning',message:string,path?:string}[] = []
  if (!rawName) issues.push({code:'PATIENT_NAME_REQUIRED',severity:'error',message:'A patient name is required for this Patient resource.',path:'Patient.name'})
  if (!mrn) issues.push({code:'SOURCE_IDENTIFIER_MISSING',severity:'warning',message:'No source MRN mapped. Identity review is required before any external matching.',path:'Patient.identifier'})
  if (!dob) issues.push({code:'BIRTH_DATE_MISSING',severity:'warning',message:'Birth date is missing or not in YYYY-MM-DD format.',path:'Patient.birthDate'})
  else {
    const date = new Date(dob + 'T00:00:00Z')
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== dob) issues.push({code:'BIRTH_DATE_INVALID',severity:'error',message:'Birth date is not a valid calendar date.',path:'Patient.birthDate'})
    if (date.getTime() > Date.now()) issues.push({code:'BIRTH_DATE_FUTURE',severity:'error',message:'Birth date cannot be in the future.',path:'Patient.birthDate'})
  }
  if (!['male','female','other','unknown'].includes(gender)) issues.push({code:'GENDER_INVALID',severity:'error',message:'Administrative gender is outside the FHIR R4 code set.',path:'Patient.gender'})
  const fhir = {
    resourceType:'Patient',
    meta:{profile:['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient']},
    ...(mrn ? {identifier:[{use:'usual',type:{text:'Medical record number'},system:'urn:satucore:source-mrn',value:mrn}]} : {}),
    active:true,
    ...(rawName ? {name:[{use:'official',text:rawName}]} : {}),
    ...(canonical.birth_date ? {birthDate:canonical.birth_date} : {}),
    gender,
    ...(phone ? {telecom:[{system:'phone',value:phone}]} : {}),
    ...(canonical.addresses.length ? {address:canonical.addresses} : {})
  }
  return { canonical, fhir, issues }
}

export async function persistPatient(args: {
  workspace: Workspace; importId: string; row: SourceRow; rowNumber: number;
  fields: Mapping[]
}) {
  const db = client()
  const { workspace:w, importId, row, rowNumber, fields } = args
  if (!w.organizationId) throw new Error('No active Organization is configured for this tenant.')
  let { canonical, fhir } = normalizePatient(row, fields)
  const { issues } = normalizePatient(row, fields)
  const { data: sourceRow, error: rowError } = await db.from('import_rows')
    .select('id,original_data,normalized_data,processing_status').eq('tenant_id', w.tenantId).eq('import_id', importId).eq('row_number', rowNumber).single()
  if (rowError) throw rowError
  const sourceReference = `import_rows/${sourceRow.id}`
  const mrnCorrection = (sourceRow.normalized_data as any)?.source_mrn_correction
  if (mrnCorrection?.corrected_mrn) {
    const corrected = String(mrnCorrection.corrected_mrn).trim()
    canonical = { ...canonical, local_mrn: corrected, source_identifiers: [{ system: 'urn:satucore:source-mrn', value: corrected }], provenance: { ...canonical.provenance, source_mrn_correction: mrnCorrection } as typeof canonical.provenance & { source_mrn_correction: typeof mrnCorrection } }
    fhir = { ...fhir, identifier: [{ use: 'usual', type: { text: 'Medical record number' }, system: 'urn:satucore:source-mrn', value: corrected }] }
  }
  const identityReview = (sourceRow.normalized_data as any)?.identity_review
  if (sourceRow.processing_status === 'identity_matched' && identityReview?.decision === 'confirmed_match' && identityReview?.patient_id) {
    const { data: linkedPatient, error: linkedError } = await db.from('patients')
      .select('id').eq('id', identityReview.patient_id).eq('tenant_id', w.tenantId)
      .eq('organization_id', w.organizationId).maybeSingle()
    if (linkedError) throw linkedError
    if (!linkedPatient) throw new Error('The previously linked clinic Patient is no longer available in this tenant. Identity review must be repeated.')
    return { patientId: linkedPatient.id, resourceId: null, fhir, issues, outcome: 'identity_matched' as const }
  }
  const mrnSourceField = fields.find(f=>f.target==='identifier' && f.approved)?.source
  if (canonical.local_mrn && mrnSourceField) {
    const { data: importRows, error: duplicateRowsError } = await db.from('import_rows')
      .select('id,original_data').eq('tenant_id',w.tenantId).eq('import_id',importId).neq('id',sourceRow.id).limit(1000)
    if (duplicateRowsError) throw duplicateRowsError
    if ((importRows??[]).some((r:any)=>String(r.original_data?.[mrnSourceField]??'').trim()===canonical.local_mrn)) {
      throw new Error('DUPLICATE_SOURCE_MRN_IN_IMPORT: this MRN appears in another row in the same uploaded file.')
    }
  }
  if (canonical.local_mrn) {
    const { data: existingMrn, error: mrnError } = await db.from('patients').select('id').eq('tenant_id',w.tenantId).eq('organization_id',w.organizationId).eq('local_mrn',canonical.local_mrn).maybeSingle()
    if (mrnError) throw mrnError
    if (existingMrn) throw new Error('This source MRN already exists in the clinic. Resolve the identity match manually; SATUCORE will not merge patients automatically.')
  }
  const { data: existingPatient, error: existingError } = await db.from('patients').select('id').eq('tenant_id',w.tenantId).eq('source_record_reference',sourceReference).maybeSingle()
  if (existingError) throw existingError
  if (existingPatient) throw new Error('This source row already has a canonical Patient. Duplicate creation was prevented.')
  const { data: patient, error: patientError } = await db.from('patients').insert({
    tenant_id:w.tenantId, organization_id:w.organizationId, local_mrn:canonical.local_mrn,
    active:canonical.active, name:canonical.name, birth_date:canonical.birth_date,
    administrative_gender:canonical.administrative_gender, telecom:canonical.telecom,
    addresses:canonical.addresses, source_identifiers:canonical.source_identifiers,
    source_record_reference:sourceReference, provenance:canonical.provenance
  }).select('id').single()
  if (patientError) throw patientError
  if (canonical.local_mrn) {
    const { error } = await db.from('patient_identifiers').insert({
      tenant_id:w.tenantId, patient_id:patient.id, system:'urn:satucore:source-mrn',
      value:canonical.local_mrn, identifier_type:'MR', is_primary:true, verification_status:'unverified'
    })
    if (error) throw error
  }
  const payloadDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fhir)))
  const payloadHash = Array.from(new Uint8Array(payloadDigest)).map(b=>b.toString(16).padStart(2,'0')).join('')
  const { data: resource, error: resourceError } = await db.from('fhir_resources').insert({
    tenant_id:w.tenantId, patient_id:patient.id, resource_type:'Patient',
    fhir_version:'4.0.1', profile_urls:['https://fhir.kemkes.go.id/r4/StructureDefinition/Patient'],
    payload:fhir, payload_hash:payloadHash, status:'draft', source_record_reference:sourceReference,
    created_by:w.userId
  }).select('id').single()
  if (resourceError) throw resourceError
  const failed = issues.some(i=>i.severity==='error')
  const { error: validationError } = await db.from('validation_results').insert({
    tenant_id:w.tenantId, fhir_resource_id:resource.id, validator:'satucore-patient-validator',
    validator_version:'0.1.0', conformance_scope:'fhir_r4', outcome:failed?'failed':issues.length?'warning':'passed',
    issues
  })
  if (validationError) throw validationError
  const { error: rowUpdateError } = await db.from('import_rows').update({
    normalized_data: { ...canonical, ...(mrnCorrection ? { source_mrn_correction: mrnCorrection } : {}) }, processing_status:failed?'failed':'processed', issues
  }).eq('id',sourceRow.id).eq('tenant_id',w.tenantId)
  if (rowUpdateError) throw rowUpdateError
  await writeAudit(w,'canonical_patient_created','patient',patient.id,{fhir_resource_id:resource.id,validation_outcome:failed?'failed':issues.length?'warning':'passed'})
  return {patientId:patient.id, resourceId:resource.id, fhir, issues, outcome:failed?'failed':issues.length?'warning':'passed'}
}

export async function writeAudit(w: Workspace, action: string, entityType: string, entityId: string, metadata: Record<string,unknown>) {
  const db = client()
  const { error } = await db.from('audit_logs').insert({
    tenant_id:w.tenantId, actor_user_id:w.userId, action, entity_type:entityType,
    entity_id:entityId, outcome:'success', metadata
  })
  if (error) throw error
}
