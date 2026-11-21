import type { Session } from '@supabase/supabase-js'

import { supabase } from './supabase'



export type SourceRow = Record<string, string>

export type Mapping = { source: string; target: string; confidence: number; approved: boolean }

export type Workspace = { tenantId: string; tenantName: string; role: string; organizationId: string | null; organizationName: string | null; userId: string }



export type PatientMrnConflict = { id: string; name: unknown; birth_date: string | null; administrative_gender: string | null }

export class PatientMrnConflictError extends Error {

  constructor(public readonly patient: PatientMrnConflict) {

    super('This source MRN already exists in the clinic. Identity review is required; SATUCORE will not merge patients automatically.')

    this.name = 'PatientMrnConflictError'

  }

}



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

        source_record_key: `${importId}:row:${i + index + 1}`, original_data: original, processing_status: 'profiled',

        issues: [...Object.entries(original).filter(([,v]) => !String(v ?? '').trim()).map(([field]) => ({ code: 'EMPTY_VALUE', field, severity: 'warning' })), ...(mrnField && String(original[mrnField]??'').trim() && (mrnCounts.get(String(original[mrnField]).trim())??0)>1 ? [{code:'DUPLICATE_SOURCE_IDENTIFIER',field:mrnField,severity:'error',message:'Duplicate source identifier within this import. Human identity review is required.'}] : [])]

      }))

      const { error } = await db.from('import_rows').insert(batch)

      if (error) throw error

    }

    if (fields.length) {

      const mappings = fields.map(f => ({
        tenant_id: w.tenantId, import_id: importId, source_field: f.source,
        target_resource: 'Patient',
        target_field: f.target === '—' ? 'unmapped' : f.target,
        mapping_expression: {
          method: f.target === '—' ? 'explicit_exclusion' : 'column_copy',
          source_field: f.source
        },
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

    const status = field.approved ? 'approved' : 'proposed'

    const { error: updateError } = await db.from('field_mappings').update({

      target_field: field.target === '—' ? 'unmapped' : field.target, status,

      mapping_expression: {
        method: field.target === '—' ? 'explicit_exclusion' : 'column_copy',
        source_field: field.source,
        reviewed_by: workspace.userId
      }

    }).eq('id', mapping.id).eq('tenant_id', workspace.tenantId)

    if (updateError) throw updateError

    if (field.approved) {

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

  await writeAudit(workspace, 'patient_mapping_reviewed', 'data_import', importId, { approved_fields: fields.filter(f=>f.approved && f.target !== '—').map(f=>f.source), reviewed_exclusions: fields.filter(f=>f.approved && f.target === '—').map(f=>f.source) })

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

  const nik = value('national_identifier')

  const gender = genderRaw === 'M' || genderRaw === 'MALE' ? 'male'

    : genderRaw === 'F' || genderRaw === 'FEMALE' ? 'female'

    : genderRaw === 'OTHER' ? 'other' : 'unknown'

  const city = value('address.city')

  const addressText = value('address')

  const cityMappingApproved = fields.some(f => f.target === 'address.city' && f.approved)

  const canonical = {

    local_mrn: mrn || null, active: true,

    name: rawName ? [{ text: rawName, use: 'official' }] : [],

    birth_date: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null,

    administrative_gender: gender,

    telecom: phone ? [{ system: 'phone', value: phone }] : [],

    addresses: city ? [{ city }] : addressText ? [{ text: addressText }] : [],

    source_identifiers: [
      ...(mrn ? [{ system: 'urn:satucore:source-mrn', value: mrn }] : []),
      ...(nik ? [{ system: 'urn:satucore:source-nik', value: nik }] : [])
    ],

    provenance: { transformation: 'satucore-canonical-patient-v1', source_fields: fields.filter(f=>f.approved && f.target !== '—').map(f=>({source:f.source,target:f.target})), reviewed_exclusions: fields.filter(f=>f.approved && f.target === '—').map(f=>f.source), human_reviewed: true }

  }

  const issues: {code:string,severity:'error'|'warning',message:string,path?:string}[] = []

  if (cityMappingApproved && !city) issues.push({code:'PATIENT_CITY_MISSING',severity:'warning',message:'A source field is mapped to Patient.address.city, but this record has no city value.',path:'Patient.address.city'})

  if (!rawName) issues.push({code:'PATIENT_NAME_REQUIRED',severity:'error',message:'A patient name is required for this Patient resource.',path:'Patient.name'})

  if (!mrn) issues.push({code:'SOURCE_IDENTIFIER_MISSING',severity:'warning',message:'No source MRN mapped. Identity review is required before any external matching.',path:'Patient.identifier'})

    if (nik && !/^[0-9]{16}$/.test(nik)) issues.push({code:'SOURCE_NIK_INVALID_FORMAT',severity:'error',message:'Mapped NIK must contain exactly 16 digits. Check the source value and mapping before approval.',path:'Patient.identifier'})

  if (!dob) issues.push({code:'BIRTH_DATE_MISSING',severity:'warning',message:'Birth date is missing or not in YYYY-MM-DD format.',path:'Patient.birthDate'})

  else {

    const date = new Date(dob + 'T00:00:00Z')

    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== dob) issues.push({code:'BIRTH_DATE_INVALID',severity:'error',message:'Birth date is not a valid calendar date.',path:'Patient.birthDate'})

    if (date.getTime() > Date.now()) issues.push({code:'BIRTH_DATE_FUTURE',severity:'error',message:'Birth date cannot be in the future.',path:'Patient.birthDate'})

  }

  if (!['male','female','other','unknown'].includes(gender)) issues.push({code:'GENDER_INVALID',severity:'error',message:'Administrative gender is outside the FHIR R4 code set.',path:'Patient.gender'})

  const fhir = {

    resourceType:'Patient',

    meta:{profile:['https\://fhir.kemkes.go.id/r4/StructureDefinition/Patient']},

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



export type PatientValidationIssue = { code: string; severity: 'error' | 'warning'; message: string; path: string }

export type PatientValidationResult = {

  payloadHash: string; inputHash: string; outcome: 'passed' | 'warning' | 'failed'

  issues: PatientValidationIssue[]; validator: string; validatorVersion: string

  conformanceScope: string; fhir: Record<string, unknown>; reportId?: string; auditWarning?: string

}



export function validationAuditOutcome(outcome: PatientValidationResult['outcome']): 'success' | 'failure' | 'blocked' {

  if (outcome === 'passed') return 'success'

  if (outcome === 'failed') return 'failure'

  return 'blocked'

}



async function sha256(value: string): Promise<string> {

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))

  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')

}



function stableJson(value: unknown): string {

  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`

  if (value && typeof value === 'object') {

    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`

  }

  return JSON.stringify(value)

}



export async function patientDraftHashes(row: SourceRow, fields: Mapping[]): Promise<{ payloadHash: string; inputHash: string }> {

  const { fhir } = normalizePatient(row, fields)

  const approvedMappings = fields.map(({source,target,approved}) => ({source,target,approved}))

  return {

    payloadHash: await sha256(stableJson(fhir)),

    inputHash: await sha256(stableJson({ row, fields: approvedMappings }))

  }

}





export type PatientDraftIdentityConflict = {

  requestId?: string

  candidatePatientId: string | null

  candidateName: string

  incomingName: string

  mrn: string

  birthDateMatch: boolean

  genderMatch: boolean

  status: 'pending' | 'request_failed'

  warning?: string

}



export type PatientDraftRecord = {

  id: string

  tenant_id: string

  import_id: string

  import_row_id: string

  row_number: number

  revision: number

  status: 'draft' | 'validated' | 'stale'

  canonical_patient: Record<string, unknown>

  fhir_patient: Record<string, unknown>

  mapping_snapshot: Mapping[]

  payload_hash: string

  input_hash: string

  validation_report_id: string | null

  validated_at: string | null

  created_by: string

  updated_by: string

  created_at: string

  updated_at: string

  auditWarning?: string

  identityConflict?: PatientDraftIdentityConflict

}



/**

 * Retrieve the current Patient draft for one source row.

 * Both the import row and draft are scoped to the active tenant.

 */

export async function getPatientDraft(args: {

  workspace: Workspace

  importId: string

  rowNumber: number

}): Promise<PatientDraftRecord | null> {

  const db = client()

  const { workspace: w, importId, rowNumber } = args



  const { data: source, error: sourceError } = await db

    .from('import_rows')

    .select('id')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)

    .eq('row_number', rowNumber)

    .single()



  if (sourceError) throw sourceError



  const { data, error } = await db

    .from('patient_drafts')

    .select('*')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)

    .eq('import_row_id', source.id)

    .maybeSingle()



  if (error) throw error

  if (!data) return null



  const canonical = (data.canonical_patient ?? {}) as Record<string, any>

  const incomingMrn = String(canonical.local_mrn ?? '').trim()

  let candidates: any[] = []

  if (incomingMrn && w.organizationId) {

    const { data: candidateRows, error: candidateError } = await db

      .from('patients')

      .select('id, name, birth_date, administrative_gender')

      .eq('tenant_id', w.tenantId)

      .eq('organization_id', w.organizationId)

      .eq('local_mrn', incomingMrn)

      .limit(2)

    if (candidateError) throw candidateError

    candidates = candidateRows ?? []

  }



  const { data: reviewRequest, error: reviewError } = await db

    .from('patient_identity_review_requests')

    .select('id, candidate_patient_id, incoming_mrn, decision')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)

    .eq('import_row_id', source.id)

    .eq('decision', 'pending')

    .order('created_at', { ascending: false })

    .limit(1)

    .maybeSingle()

  if (reviewError) throw reviewError



  if (!candidates.length && !reviewRequest) return data as PatientDraftRecord

  let candidate: any = candidates.length === 1 ? candidates[0] : null

  const candidateId = candidates.length === 1 ? candidates[0].id : reviewRequest?.candidate_patient_id ?? null

  if (!candidate && candidateId) {

    const { data: candidateData, error: candidateError } = await db

      .from('patients')

      .select('id, name, birth_date, administrative_gender')

      .eq('tenant_id', w.tenantId)

      .eq('id', candidateId)

      .maybeSingle()

    if (candidateError) throw candidateError

    candidate = candidateData

  }

  const candidateName = candidates.length > 1

    ? `${candidates.length} possible existing Patients`

    : Array.isArray(candidate?.name)

      ? candidate.name.map((item: any) => item?.text ?? '').filter(Boolean).join(', ')

      : 'Existing clinic Patient'

  const incomingName = Array.isArray(canonical.name)

    ? canonical.name.map((item: any) => item?.text ?? '').filter(Boolean).join(', ')

    : 'Unnamed incoming Patient'

  return {

    ...(data as PatientDraftRecord),

    identityConflict: {

      requestId: reviewRequest?.id,

      candidatePatientId: candidateId,

      candidateName,

      incomingName,

      mrn: incomingMrn || reviewRequest?.incoming_mrn || '',

      birthDateMatch: !!candidate && !!candidate.birth_date && candidate.birth_date === canonical.birth_date,

      genderMatch: !!candidate && !!candidate.administrative_gender && candidate.administrative_gender === canonical.administrative_gender,

      status: reviewRequest ? 'pending' : 'request_failed',

      warning: reviewRequest ? undefined : 'An existing Patient with this MRN was found, but no pending identity review request exists. Retry or contact a clinic administrator.'

    }

  }

}



/**

 * Read immutable draft revision snapshots.

 * RLS and the explicit tenant predicate both constrain the result.

 */

export async function getPatientDraftRevisions(args: {

  workspace: Workspace

  draftId: string

}): Promise<Record<string, unknown>[]> {

  const db = client()

  const { workspace: w, draftId } = args



  const { data, error } = await db

    .from('patient_draft_revisions')

    .select('*')

    .eq('tenant_id', w.tenantId)

    .eq('draft_id', draftId)

    .order('revision', { ascending: false })



  if (error) throw error

  return data ?? []

}



/**

 * Persist a Patient Draft only. This function does not create a canonical

 * Patient, FHIR resource, approval, or SATUSEHAT transaction.

 *

 * Original source data remains immutable; approved corrections are applied

 * through the append-only source correction ledger.

 */

export async function savePatientDraft(args: {

  workspace: Workspace

  importId: string

  row: SourceRow

  rowNumber: number

  fields: Mapping[]

}): Promise<PatientDraftRecord> {

  const db = client()

  const { workspace: w, importId, row, rowNumber, fields } = args



  if (!w.userId || !w.tenantId) {

    throw new Error('An authenticated tenant workspace is required to save a Patient Draft.')

  }

  if (!Number.isInteger(rowNumber) || rowNumber < 1) {

    throw new Error('A valid positive source row number is required.')

  }

  if (!fields.length || fields.some(f => !f.approved)) {

    throw new Error('All Patient mappings must be approved before saving a draft.')

  }



  const { data: source, error: sourceError } = await db

    .from('import_rows')

    .select('id, original_data')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)

    .eq('row_number', rowNumber)

    .single()



  if (sourceError) throw sourceError



  const { data: correctionRows, error: correctionError } = await db

    .from('source_row_corrections')

    .select('id, tenant_id, import_id, import_row_id, row_number, source_field, original_value, corrected_value, created_at')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)

    .eq('import_row_id', source.id)

    .order('created_at', { ascending: true })



  if (correctionError) throw correctionError



  const birthDateSource = fields.find(f => f.target === 'birthDate' && f.approved)?.source ?? ''

  const effectiveRow = applySourceRowCorrections(

    source.original_data as SourceRow,

    {

      tenantId: w.tenantId,

      importId,

      importRowId: source.id,

      rowNumber

    },

    (correctionRows ?? []) as SourceRowCorrection[],

    birthDateSource

  )



  if (stableJson(effectiveRow) !== stableJson(row)) {

    throw new Error('Selected source row differs from persisted import and correction history. Reload the import before saving.')

  }



  const { data: persistedMappings, error: mappingError } = await db

    .from('field_mappings')

    .select('source_field, target_field, status')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)



  if (mappingError) throw mappingError



  const expectedMappings = fields

    .map(({ source: sourceField, target, approved }) => ({

      source: sourceField,

      target,

      approved

    }))

    .sort((a, b) => a.source.localeCompare(b.source))



  const actualMappings = (persistedMappings ?? [])

    .map(mapping => ({

      source: mapping.source_field,

      target: mapping.target_field === 'unmapped' ? '—' : mapping.target_field,

      approved: mapping.status === 'approved'

    }))

    .sort((a, b) => a.source.localeCompare(b.source))



  if (

    stableJson(actualMappings) !== stableJson(expectedMappings) ||

    actualMappings.some(mapping => !mapping.approved)

  ) {

    throw new Error('Persisted mapping decisions do not match the approved mapping selection. Save the mapping review again.')

  }



  const { canonical, fhir } = normalizePatient(effectiveRow, fields)

  const { payloadHash, inputHash } = await patientDraftHashes(effectiveRow, fields)

  const mappingSnapshot = fields.map(({ source: sourceField, target, approved }) => ({

    source: sourceField,

    target,

    approved

  }))



  // Detect an existing clinic identity before a draft can advance toward approval.

  // A matching MRN is a candidate signal, never permission to merge or overwrite.

  let identityConflict: PatientDraftIdentityConflict | undefined

  const incomingMrn = String((canonical as any).local_mrn ?? '').trim()

  if (incomingMrn && !w.organizationId) {

    identityConflict = {

      candidatePatientId: null,

      candidateName: 'Organization scope unavailable',

      incomingName: Array.isArray((canonical as any).name)

        ? (canonical as any).name.map((item: any) => item?.text ?? '').filter(Boolean).join(', ')

        : 'Unnamed incoming Patient',

      mrn: incomingMrn,

      birthDateMatch: false,

      genderMatch: false,

      status: 'request_failed',

      warning: 'An active clinic Organization is required to check MRN uniqueness safely. Configure the Organization before identity review or approval.'

    }

  }

  if (incomingMrn && w.organizationId) {

    const { data: candidates, error: candidateError } = await db

      .from('patients')

      .select('id, name, birth_date, administrative_gender')

      .eq('tenant_id', w.tenantId)

      .eq('organization_id', w.organizationId)

      .eq('local_mrn', incomingMrn)

      .limit(2)

    if (candidateError) throw candidateError

    if ((candidates ?? []).length > 0) {

      const candidate = candidates![0] as any

      const candidateName = Array.isArray(candidate.name)

        ? candidate.name.map((item: any) => item?.text ?? '').filter(Boolean).join(', ')

        : 'Existing clinic Patient'

      const incomingName = Array.isArray((canonical as any).name)

        ? (canonical as any).name.map((item: any) => item?.text ?? '').filter(Boolean).join(', ')

        : 'Unnamed incoming Patient'

      let requestId: string | undefined

      let requestWarning: string | undefined

      try {

        const review = await createPatientIdentityReviewRequest({

          workspace: w, importId, rowNumber, incomingMrn,

          candidatePatientId: (candidates ?? []).length === 1 ? candidate.id : null,

          reason: (candidates ?? []).length > 1

            ? 'Multiple canonical Patients share this tenant/Organization MRN. Human identity resolution is required.'

            : 'Existing canonical Patient has the same tenant/Organization MRN. Compare incoming identity attributes; do not merge or overwrite automatically.'

        })

        requestId = review.requestId

        requestWarning = review.auditWarning

      } catch (error) {

        requestWarning = error instanceof Error ? error.message : String(error)

      }

      identityConflict = {

        requestId,

        candidatePatientId: (candidates ?? []).length === 1 ? candidate.id : null,

        candidateName: (candidates ?? []).length > 1 ? `${candidates!.length} possible existing Patients` : candidateName,

        incomingName,

        mrn: incomingMrn,

        birthDateMatch: (candidates ?? []).length === 1 && !!candidate.birth_date && candidate.birth_date === (canonical as any).birth_date,

        genderMatch: (candidates ?? []).length === 1 && !!candidate.administrative_gender && candidate.administrative_gender === (canonical as any).administrative_gender,

        status: requestId ? 'pending' : 'request_failed',

        warning: requestWarning

      }

    }

  }



  const { data: existing, error: existingError } = await db

    .from('patient_drafts')

    .select('*')

    .eq('tenant_id', w.tenantId)

    .eq('import_id', importId)

    .eq('import_row_id', source.id)

    .maybeSingle()



  if (existingError) throw existingError



  // Do not create needless revisions when the complete draft content is unchanged.

  if (

    existing &&

    existing.payload_hash === payloadHash &&

    existing.input_hash === inputHash &&

    stableJson(existing.mapping_snapshot) === stableJson(mappingSnapshot) &&

    stableJson(existing.canonical_patient) === stableJson(canonical) &&

    stableJson(existing.fhir_patient) === stableJson(fhir) &&

    existing.status !== 'stale'

  ) {

    return { ...(existing as PatientDraftRecord), ...(identityConflict ? { identityConflict } : {}) }

  }



  let saved: PatientDraftRecord



  if (existing) {

    // Revision predicate prevents silently overwriting a concurrent draft update.

    const { data, error } = await db

      .from('patient_drafts')

      .update({

        canonical_patient: canonical,

        fhir_patient: fhir,

        mapping_snapshot: mappingSnapshot,

        payload_hash: payloadHash,

        input_hash: inputHash,

        status: 'draft',

        validation_report_id: null,

        validated_at: null,

        updated_by: w.userId

      })

      .eq('id', existing.id)

      .eq('tenant_id', w.tenantId)

      .eq('revision', existing.revision)

      .select('*')

      .maybeSingle()



    if (error) throw error

    if (!data) {

      throw new Error('The Patient Draft changed in another session. Reload the draft and retry to avoid overwriting a newer revision.')

    }

    saved = data as PatientDraftRecord

  } else {

    const { data, error } = await db

      .from('patient_drafts')

      .insert({

        tenant_id: w.tenantId,

        import_id: importId,

        import_row_id: source.id,

        row_number: rowNumber,

        canonical_patient: canonical,

        fhir_patient: fhir,

        mapping_snapshot: mappingSnapshot,

        payload_hash: payloadHash,

        input_hash: inputHash,

        status: 'draft',

        validation_report_id: null,

        validated_at: null,

        created_by: w.userId,

        updated_by: w.userId

      })

      .select('*')

      .single()



    if (error) throw error

    saved = data as PatientDraftRecord

  }



  // Persistence and revision recording are performed by the database.

  // Audit failure is surfaced as a warning because the draft is already saved.

  try {

    await writeAudit(

      w,

      existing ? 'patient_draft_updated' : 'patient_draft_created',

      'patient_draft',

      saved.id,

      {

        import_id: importId,

        import_row_id: source.id,

        row_number: rowNumber,

        revision: saved.revision,

        payload_hash: payloadHash,

        input_hash: inputHash

      }

    )

  } catch (auditError) {

    saved.auditWarning = auditError instanceof Error

      ? auditError.message

      : String(auditError)

  }



  return { ...saved, ...(identityConflict ? { identityConflict } : {}) }

}



export function validatePatientLocally(row: SourceRow, fields: Mapping[]): PatientValidationIssue[] {

  const { fhir, issues: baseIssues } = normalizePatient(row, fields)

  const issues: PatientValidationIssue[] = baseIssues.map(i => ({ ...i, path: i.path ?? 'Patient' }))

  const rawValue = (target: string) => {

    const mapping = fields.find(f => f.target === target && f.approved)

    return mapping ? String(row[mapping.source] ?? '').trim() : ''

  }

  const rawDob = rawValue('birthDate')

  if (rawDob) {

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDob)

    const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : new Date(NaN)

    if (!match || date.toISOString?.().slice(0, 10) !== rawDob) {

      issues.push({ code: 'BIRTH_DATE_INVALID', severity: 'error', message: 'Birth date is not a real calendar date in YYYY-MM-DD format.', path: 'Patient.birthDate' })

    } else if (date.getTime() > new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()) {

      issues.push({ code: 'BIRTH_DATE_FUTURE', severity: 'error', message: 'Birth date cannot be in the future.', path: 'Patient.birthDate' })

    }

  }

  const gender = rawValue('gender').toLowerCase()

  if (gender && !['m','male','f','female','other','unknown'].includes(gender)) {

    issues.push({ code: 'GENDER_INVALID', severity: 'error', message: 'Administrative gender must map to male, female, other or unknown.', path: 'Patient.gender' })

  }

  if (typeof fhir.gender !== 'string' || !['male','female','other','unknown'].includes(fhir.gender)) {

    issues.push({ code: 'GENDER_INVALID', severity: 'error', message: 'Patient.gender must use an FHIR R4 administrative gender code.', path: 'Patient.gender' })

  }

  return issues

}



export async function validatePatientDraft(args: {

  workspace: Workspace; importId: string; row: SourceRow; rowNumber: number; fields: Mapping[]

}): Promise<PatientValidationResult> {

  const { workspace: w, importId, row, rowNumber, fields } = args

  if (!w.userId || !w.tenantId) throw new Error('An authenticated tenant workspace is required for Patient validation.')

  if (!fields.length || fields.some(f => !f.approved)) throw new Error('All Patient mappings must be approved before validation.')

  const db = client()

  const { data: source, error: sourceError } = await db.from('import_rows').select('id, original_data')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('row_number', rowNumber).single()

  if (sourceError) throw sourceError

  const { data: correctionRows, error: correctionError } = await db.from('source_row_corrections')

    .select('id, tenant_id, import_id, import_row_id, row_number, source_field, original_value, corrected_value, created_at')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('import_row_id', source.id)

    .order('created_at', { ascending: true })

  if (correctionError) throw correctionError

  const dobField = fields.find(f => f.target === 'birthDate' && f.approved)?.source ?? ''

  const effectiveRow = applySourceRowCorrections(source.original_data as SourceRow, {

    tenantId: w.tenantId, importId, importRowId: source.id, rowNumber

  }, correctionRows ?? [], dobField)

  if (stableJson(effectiveRow) !== stableJson(row)) throw new Error('Selected effective source row differs from persisted import and correction history. Reload the import before validation.')

  const { data: persistedMappings, error: mappingError } = await db.from('field_mappings')

    .select('source_field,target_field,status').eq('tenant_id', w.tenantId).eq('import_id', importId)

  if (mappingError) throw mappingError

  const expectedMappings = fields.map(({source,target,approved}) => ({ source, target, approved })).sort((a,b)=>a.source.localeCompare(b.source))

  const actualMappings = (persistedMappings ?? []).map(m => ({ source:m.source_field, target:m.target_field === 'unmapped' ? '—' : m.target_field, approved:m.status === 'approved' })).sort((a,b)=>a.source.localeCompare(b.source))

  if (stableJson(actualMappings) !== stableJson(expectedMappings) || actualMappings.some(m => !m.approved)) throw new Error('Mappings are not currently approved in the persisted import. Save the mapping review again before validation.')



  // Validation is only allowed against a persisted, current Patient Draft.

  const { data: draft, error: draftError } = await db.from('patient_drafts').select('*')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('import_row_id', source.id).maybeSingle()

  if (draftError) throw draftError

  if (!draft) throw new Error('Save the Patient Draft before running validation.')

  if (draft.status === 'stale') throw new Error('This Patient Draft is stale after a source correction. Save the draft again before validation.')



  const { fhir } = normalizePatient(effectiveRow, fields)

  const issues = validatePatientLocally(effectiveRow, fields)

  const { payloadHash, inputHash } = await patientDraftHashes(effectiveRow, fields)

  if (draft.payload_hash !== payloadHash || draft.input_hash !== inputHash) {

    throw new Error('The Patient Draft does not match the current source and mapping hashes. Save the draft again before validation.')

  }

  const mappingSnapshot = fields.map(({source,target,approved}) => ({source,target,approved}))

  if (stableJson(draft.mapping_snapshot) !== stableJson(mappingSnapshot)) {

    throw new Error('The Patient Draft mapping snapshot differs from the approved mappings. Save the draft again before validation.')

  }



  const outcome = issues.some(i => i.severity === 'error') ? 'failed' : issues.length ? 'warning' : 'passed'

  const result: PatientValidationResult = {

    payloadHash, inputHash, outcome, issues, validator: 'satucore-patient-local', validatorVersion: '0.2.0',

    conformanceScope: 'local_deterministic_checks; fhir_r4_structure_partial; satusehat_profile_not_executed', fhir

  }



  // Reuse an exact prior report where possible; otherwise append a new immutable report.

  const { data: priorReports, error: priorError } = await db.from('patient_draft_validation_reports')

    .select('id').eq('tenant_id', w.tenantId).eq('import_id', importId).eq('import_row_id', source.id)

    .eq('payload_hash', payloadHash).eq('input_hash', inputHash)

    .eq('validator', result.validator).eq('validator_version', result.validatorVersion)

    .order('created_at', { ascending: false }).limit(1)

  if (priorError) throw priorError



  let reportId = priorReports?.[0]?.id as string | undefined

  if (!reportId) {

    const { data: report, error: persistenceError } = await db.from('patient_draft_validation_reports').insert({

      tenant_id: w.tenantId, import_id: importId, import_row_id: source.id, row_number: rowNumber,

      validator: result.validator, validator_version: result.validatorVersion,

      conformance_scope: result.conformanceScope, outcome, issues, payload_hash: payloadHash, input_hash: inputHash,

      approved_mappings: mappingSnapshot, created_by: w.userId

    }).select('id').single()

    if (persistenceError) throw new Error(`Standalone validation report persistence failed. ${persistenceError.message}`)

    reportId = report.id

  } else {

    // A prior report with the same hashes may have a different outcome only if validator logic

    // changed; require the persisted report to match the current deterministic outcome.

    const { data: report, error: reportError } = await db.from('patient_draft_validation_reports')

      .select('id,outcome').eq('tenant_id', w.tenantId).eq('id', reportId).single()

    if (reportError) throw reportError

    if (report.outcome !== outcome) {

      const { data: report, error: insertError } = await db.from('patient_draft_validation_reports').insert({

        tenant_id: w.tenantId, import_id: importId, import_row_id: source.id, row_number: rowNumber,

        validator: result.validator, validator_version: result.validatorVersion,

        conformance_scope: result.conformanceScope, outcome, issues, payload_hash: payloadHash, input_hash: inputHash,

        approved_mappings: mappingSnapshot, created_by: w.userId

      }).select('id').single()

      if (insertError) throw insertError

      reportId = report.id

    }

  }



  // Only a passing report with exact draft lineage may move the draft to validated.

  if (outcome === 'passed') {

    const { data: updated, error: updateError } = await db.from('patient_drafts').update({

      status: 'validated', validation_report_id: reportId, validated_at: new Date().toISOString(), updated_by: w.userId

    }).eq('id', draft.id).eq('tenant_id', w.tenantId).eq('revision', draft.revision)

      .eq('payload_hash', payloadHash).eq('input_hash', inputHash).select('id').maybeSingle()

    if (updateError) throw updateError

    if (!updated) throw new Error('Validation passed, but the Patient Draft changed concurrently. Reload and validate again; the draft was not marked validated.')

  }



  const { error: auditError } = await db.from('audit_logs').insert({

    tenant_id: w.tenantId, actor_user_id: w.userId, action: 'patient_draft_validated',

    entity_type: 'patient_draft', entity_id: draft.id, outcome: validationAuditOutcome(outcome),

    metadata: { import_id: importId, import_row_id: source.id, row_number: rowNumber, draft_revision: draft.revision, validation_report_id: reportId, payload_hash: payloadHash, input_hash: inputHash, validation_outcome: outcome, validator: result.validator, validator_version: result.validatorVersion, conformance_scope: result.conformanceScope, issues }

  })

  if (auditError) result.auditWarning = auditError.message

  result.reportId = reportId

  return result

}




/**
 * Restore validation evidence for the exact current Patient Draft.
 * Read-only: never creates reports, changes draft status, or creates Patients.
 */
export async function restorePatientDraftValidation(args: {
  workspace: Workspace
  importId: string
  row: SourceRow
  rowNumber: number
  fields: Mapping[]
}): Promise<PatientValidationResult | null> {
  const { workspace: w, importId, row, rowNumber, fields } = args
  if (!w.userId || !w.tenantId || !fields.length || fields.some(f => !f.approved)) return null

  const draft = await getPatientDraft({ workspace: w, importId, rowNumber })
  if (!draft || draft.status !== 'validated' || !draft.validation_report_id || draft.identityConflict) return null

  const db = client()

  const { data: source, error: sourceError } = await db.from('import_rows')
    .select('id, original_data')
    .eq('tenant_id', w.tenantId)
    .eq('import_id', importId)
    .eq('row_number', rowNumber)
    .single()
  if (sourceError) throw sourceError

  const { data: correctionRows, error: correctionError } = await db.from('source_row_corrections')
    .select('id, tenant_id, import_id, import_row_id, row_number, source_field, original_value, corrected_value, created_at')
    .eq('tenant_id', w.tenantId)
    .eq('import_id', importId)
    .eq('import_row_id', source.id)
    .order('created_at', { ascending: true })
  if (correctionError) throw correctionError

  const dobField = fields.find(f => f.target === 'birthDate' && f.approved)?.source ?? ''
  const effectiveRow = applySourceRowCorrections(
    source.original_data as SourceRow,
    { tenantId: w.tenantId, importId, importRowId: source.id, rowNumber },
    (correctionRows ?? []) as SourceRowCorrection[],
    dobField
  )
  if (stableJson(effectiveRow) !== stableJson(row)) return null

  const { data: persistedMappings, error: mappingError } = await db.from('field_mappings')
    .select('source_field, target_field, status')
    .eq('tenant_id', w.tenantId)
    .eq('import_id', importId)
  if (mappingError) throw mappingError

  const expectedMappings = fields
    .map(({ source, target, approved }) => ({ source, target, approved }))
    .sort((a, b) => a.source.localeCompare(b.source))
  const actualMappings = (persistedMappings ?? [])
    .map(m => ({
      source: m.source_field,
      target: m.target_field === 'unmapped' ? '—' : m.target_field,
      approved: m.status === 'approved'
    }))
    .sort((a, b) => a.source.localeCompare(b.source))

  if (stableJson(actualMappings) !== stableJson(expectedMappings) || actualMappings.some(m => !m.approved)) return null
  if (stableJson(draft.mapping_snapshot) !== stableJson(fields.map(({ source, target, approved }) => ({ source, target, approved })))) return null

  const { fhir } = normalizePatient(effectiveRow, fields)
  const issues = validatePatientLocally(effectiveRow, fields)
  if (issues.length) return null

  const { payloadHash, inputHash } = await patientDraftHashes(effectiveRow, fields)
  if (draft.payload_hash !== payloadHash || draft.input_hash !== inputHash) return null

  const { data: report, error: reportError } = await db.from('patient_draft_validation_reports')
    .select('id, tenant_id, import_id, import_row_id, row_number, validator, validator_version, conformance_scope, outcome, issues, payload_hash, input_hash, approved_mappings')
    .eq('id', draft.validation_report_id)
    .eq('tenant_id', w.tenantId)
    .eq('import_id', importId)
    .eq('import_row_id', source.id)
    .eq('row_number', rowNumber)
    .eq('outcome', 'passed')
    .maybeSingle()
  if (reportError) throw reportError
  if (!report) return null

  const expectedIssues: PatientValidationIssue[] = []
  if (
    report.validator !== 'satucore-patient-local' ||
    report.validator_version !== '0.2.0' ||
    report.conformance_scope !== 'local_deterministic_checks; fhir_r4_structure_partial; satusehat_profile_not_executed' ||
    report.payload_hash !== payloadHash ||
    report.input_hash !== inputHash ||
    stableJson(report.approved_mappings) !== stableJson(fields.map(({ source, target, approved }) => ({ source, target, approved }))) ||
    stableJson(report.issues) !== stableJson(expectedIssues)
  ) return null

  return {
    payloadHash,
    inputHash,
    outcome: 'passed',
    issues: expectedIssues,
    validator: report.validator,
    validatorVersion: report.validator_version,
    conformanceScope: report.conformance_scope,
    fhir,
    reportId: report.id
  }
}
export async function persistPatient(args: {

  workspace: Workspace; importId: string; row: SourceRow; rowNumber: number;

  fields: Mapping[]; expectedPayloadHash: string; expectedInputHash: string

}) {

  const db = client()

  const { workspace:w, importId, row, rowNumber, fields } = args

  if (!w.organizationId) throw new Error('No active Organization is configured for this tenant.')

  const { data: persistedSource, error: persistedSourceError } = await db.from('import_rows').select('id, original_data')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('row_number', rowNumber).single()

  if (persistedSourceError) throw persistedSourceError

  const { data: correctionRows, error: correctionError } = await db.from('source_row_corrections')

    .select('id, tenant_id, import_id, import_row_id, row_number, source_field, original_value, corrected_value, created_at')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('import_row_id', persistedSource.id)

    .order('created_at', { ascending: true })

  if (correctionError) throw correctionError

  const dobField = fields.find(f => f.target === 'birthDate' && f.approved)?.source ?? ''

  const effectiveRow = applySourceRowCorrections(persistedSource.original_data as SourceRow, {

    tenantId: w.tenantId, importId, importRowId: persistedSource.id, rowNumber

  }, correctionRows ?? [], dobField)

  if (stableJson(effectiveRow) !== stableJson(row)) throw new Error('Effective source data or correction history changed after validation. Reload and validate again.')

  const { canonical, fhir, issues } = normalizePatient(effectiveRow, fields)

  const { payloadHash: actualPayloadHash, inputHash: actualInputHash } = await patientDraftHashes(effectiveRow, fields)

  if (actualPayloadHash !== args.expectedPayloadHash) throw new Error('Patient source or mappings changed after validation. Run validation again before saving.')

  if (actualInputHash !== args.expectedInputHash) throw new Error('Patient source or mappings changed after validation. Run validation again before saving.')

  const { data: currentMappings, error: mappingError } = await db.from('field_mappings').select('source_field, target_field, status')

    .eq('tenant_id', w.tenantId).eq('import_id', importId)

  if (mappingError) throw mappingError

  const mappingSnapshot = (currentMappings ?? []).map(m => ({ source: m.source_field, target: m.target_field === 'unmapped' ? '—' : m.target_field, approved: m.status === 'approved' }))

  const expectedMappings = fields.map(({source,target,approved}) => ({source,target,approved})).sort((a,b)=>a.source.localeCompare(b.source))

  if (JSON.stringify(mappingSnapshot.map(({source,target,approved})=>({source,target,approved})).sort((a,b)=>a.source.localeCompare(b.source))) !== JSON.stringify(expectedMappings)) throw new Error('Approved mappings changed after validation. Run validation again.')

  if (fields.length === 0 || fields.some(field => !field.approved)) throw new Error('Patient mappings are not currently approved. Run mapping review again.')

  const { data: reports, error: reportError } = await db.from('patient_draft_validation_reports').select('id, outcome, payload_hash, input_hash, validator, validator_version, approved_mappings')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('import_row_id', persistedSource.id)

    .eq('payload_hash', actualPayloadHash).eq('input_hash', actualInputHash).eq('outcome', 'passed')

    .order('created_at', {ascending:false}).limit(1)

  if (reportError) throw reportError

  if (!reports?.length || reports[0].validator !== 'satucore-patient-local' || reports[0].validator_version !== '0.2.0' || JSON.stringify(reports[0].approved_mappings) !== JSON.stringify(fields.map(({source,target,approved})=>({source,target,approved})))) throw new Error('No current passing validation report matches this source row and approved mapping state. Run validation again.')

  const sourceReference = `import_rows/${persistedSource.id}`

  if (canonical.local_mrn) {

    const { data: existingMrn, error: mrnError } = await db.from('patients').select('id,name,birth_date,administrative_gender').eq('tenant_id',w.tenantId).eq('organization_id',w.organizationId).eq('local_mrn',canonical.local_mrn).maybeSingle()

    if (mrnError) throw mrnError

    if (existingMrn) throw new PatientMrnConflictError(existingMrn as PatientMrnConflict)

  }

  const { data: existingPatient, error: existingError } = await db.from('patients').select('id').eq('tenant_id',w.tenantId).eq('source_record_reference',sourceReference).maybeSingle()

  if (existingError) throw existingError

  if (existingPatient) throw new Error('This source row already has a canonical Patient. Duplicate creation was prevented.')



  const fhirPayloadHash = actualPayloadHash

  const { data: created, error: createError } = await db.rpc('create_patient_from_validated_import', {

    p_tenant_id: w.tenantId,

    p_organization_id: w.organizationId,

    p_import_id: importId,

    p_import_row_id: persistedSource.id,

    p_validation_report_id: reports[0].id,

    p_canonical: canonical,

    p_fhir_patient: fhir,

    p_issues: issues,

    p_fhir_payload_hash: fhirPayloadHash

  })

  if (createError) {

    if (createError.message?.includes('MRN_CONFLICT:') && canonical.local_mrn) {

      const { data: conflict, error: conflictError } = await db.from('patients').select('id,name,birth_date,administrative_gender')

        .eq('tenant_id',w.tenantId).eq('organization_id',w.organizationId).eq('local_mrn',canonical.local_mrn).maybeSingle()

      if (conflictError) throw conflictError

      if (conflict) throw new PatientMrnConflictError(conflict as PatientMrnConflict)

    }

    throw createError

  }

  const outcome = created.outcome as 'passed'|'warning'|'failed'

  return { patientId: created.patient_id as string, resourceId: created.resource_id as string, sourceLinkId: created.source_link_id as string, fhir, issues, outcome }



}



export async function createPatientIdentityReviewRequest(args: {
  workspace: Workspace
  importId: string
  rowNumber: number
  incomingMrn: string
  reason: string
  candidatePatientId?: string | null
}): Promise<{ requestId: string; existing: boolean; attemptNumber: number }> {
  const { workspace: w, importId, rowNumber, incomingMrn, reason, candidatePatientId = null } = args
  if (!w.organizationId) throw new Error('An active Organization is required for identity review.')
  if (!incomingMrn.trim() || reason.trim().length < 10) {
    throw new Error('MRN and a review rationale of at least 10 characters are required.')
  }

  const { data, error } = await client().rpc('create_patient_identity_review_request', {
    p_tenant_id: w.tenantId,
    p_organization_id: w.organizationId,
    p_import_id: importId,
    p_row_number: rowNumber,
    p_incoming_mrn: incomingMrn.trim(),
    p_reason: reason.trim(),
    p_candidate_patient_id: candidatePatientId
  })
  if (error) throw error

  const result = Array.isArray(data) ? data[0] : data
  if (!result?.request_id) throw new Error('Identity-review RPC returned no request identifier.')

  return {
    requestId: result.request_id as string,
    existing: Boolean(result.existing),
    attemptNumber: Number(result.attempt_number)
  }
}



export async function writeAudit(w: Workspace, action: string, entityType: string, entityId: string, metadata: Record<string,unknown>) {

  const db = client()

  const { error } = await db.from('audit_logs').insert({

    tenant_id:w.tenantId, actor_user_id:w.userId, action, entity_type:entityType,

    entity_id:entityId, outcome:'success', metadata

  })

  if (error) throw error

}



export type RestoredImport = {

  importId: string

  filename: string

  rows: SourceRow[]

  fields: Mapping[]

  status: string

}



/**

 * Restore the most recent tenant-scoped import and its reviewed mappings.

 * Source values come from import_rows.original_data; approvals come from

 * field_mappings.status. No browser-only File object is required to continue.

 */

export async function restoreLatestImport(workspace: Workspace): Promise<RestoredImport | null> {

  const db = client()

  const { data: imports, error: importError } = await db.from('data_imports')

    .select('id, original_filename, status')

    .eq('tenant_id', workspace.tenantId)

    .order('created_at', { ascending: false })

    .limit(1)

  if (importError) throw importError

  const latest = imports?.[0]

  if (!latest) return null



  const [{ data: sourceRows, error: rowsError }, { data: mappingRows, error: mappingsError }] = await Promise.all([

    db.from('import_rows').select('id, row_number, original_data')

      .eq('tenant_id', workspace.tenantId).eq('import_id', latest.id)

      .order('row_number', { ascending: true }).limit(500),

    db.from('field_mappings').select('source_field, target_field, confidence, status')

      .eq('tenant_id', workspace.tenantId).eq('import_id', latest.id)

      .order('created_at', { ascending: true })

  ])

  if (rowsError) throw rowsError

  if (mappingsError) throw mappingsError



  const fields: Mapping[] = (mappingRows ?? []).map((item: any) => ({

    source: item.source_field,

    target: item.target_field === 'unmapped' ? '—' : item.target_field,

    confidence: Number(item.confidence ?? 0),

    approved: item.status === 'approved'

  }))

  const birthDateSource = fields.find(f => f.target === 'birthDate' && f.approved)?.source ?? ''



  const { data: correctionRows, error: correctionsError } = await db.from('source_row_corrections')

    .select('id, tenant_id, import_id, import_row_id, row_number, source_field, original_value, corrected_value, created_at')

    .eq('tenant_id', workspace.tenantId).eq('import_id', latest.id)

    .order('created_at', { ascending: true })

  if (correctionsError) throw correctionsError



  const correctionsByRow = new Map<string, SourceRowCorrection[]>()

  for (const correction of (correctionRows ?? []) as SourceRowCorrection[]) {

    const existing = correctionsByRow.get(correction.import_row_id) ?? []

    existing.push(correction)

    correctionsByRow.set(correction.import_row_id, existing)

  }



  const rows = (sourceRows ?? []).map((item: any) => {

    if (!item.id || !item.original_data || typeof item.original_data !== 'object') {

      throw new Error('An imported source row is missing its database identity or original data.')

    }

    return applySourceRowCorrections(

      item.original_data as SourceRow,

      {

        tenantId: workspace.tenantId,

        importId: latest.id,

        importRowId: item.id,

        rowNumber: item.row_number

      },

      correctionsByRow.get(item.id) ?? [],

      birthDateSource

    )

  })



  if (!rows.length) throw new Error('The latest import exists, but its source rows could not be restored.')

  return {

    importId: latest.id,

    filename: latest.original_filename ?? 'Restored import',

    rows,

    fields,

    status: latest.status ?? 'profiled'

  }

}



/**

 * Append a governed correction to an imported source row.

 * import_rows.original_data is deliberately never updated.

 */

export async function persistSourceRowCorrection(args: {

  workspace: Workspace

  importId: string

  rowNumber: number

  sourceField: string

  originalValue: string

  correctedValue: string

  reason: string

}): Promise<{ correctionId: string; auditWarning?: string }> {

  const db = client()

  const { workspace: w, importId, rowNumber, sourceField, originalValue, correctedValue, reason } = args



  if (!sourceField.trim()) throw new Error('A source field is required.')

  if (!reason.trim()) throw new Error('Please provide a correction reason.')

  if (!correctedValue.trim()) throw new Error('A corrected birth date is required.')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(correctedValue.trim())) {

    throw new Error('Corrected birth date must use YYYY-MM-DD format.')

  }

  const parsedDate = new Date(`${correctedValue.trim()}T00:00:00Z`)

  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== correctedValue.trim()) {

    throw new Error('Corrected birth date is not a valid calendar date.')

  }

  if (parsedDate.getTime() > new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime()) {

    throw new Error('Birth date cannot be in the future.')

  }



  const { data: approvedMapping, error: mappingError } = await db.from('field_mappings')

    .select('source_field')

    .eq('tenant_id', w.tenantId).eq('import_id', importId)

    .eq('source_field', sourceField).eq('target_field', 'birthDate').eq('status', 'approved')

    .maybeSingle()

  if (mappingError) throw mappingError

  if (!approvedMapping) throw new Error('Correction is allowed only for the currently approved Patient birthDate source mapping.')



  const { data: sourceRow, error: rowError } = await db.from('import_rows')

    .select('id, original_data').eq('tenant_id', w.tenantId).eq('import_id', importId)

    .eq('row_number', rowNumber).single()

  if (rowError) throw rowError



  const { data: priorCorrections, error: correctionsError } = await db.from('source_row_corrections')

    .select('id, tenant_id, import_id, import_row_id, row_number, source_field, original_value, corrected_value, created_at')

    .eq('tenant_id', w.tenantId).eq('import_id', importId).eq('import_row_id', sourceRow.id)

    .order('created_at', { ascending: true })

  if (correctionsError) throw correctionsError



  const identity: SourceRowIdentity = {

    tenantId: w.tenantId,

    importId,

    importRowId: sourceRow.id,

    rowNumber

  }

  const effectiveRow = applySourceRowCorrections(

    sourceRow.original_data as SourceRow,

    identity,

    (priorCorrections ?? []) as SourceRowCorrection[],

    sourceField

  )

  const currentValue = String(effectiveRow[sourceField] ?? '')

  if (currentValue !== originalValue) {

    throw new Error('The source value has changed since this correction was prepared. Reload the row before correcting it.')

  }

  if (currentValue === correctedValue.trim()) {

    throw new Error('The corrected birth date is identical to the current effective value.')

  }



  const { data, error } = await db.from('source_row_corrections').insert({

    tenant_id: w.tenantId,

    import_id: importId,

    import_row_id: sourceRow.id,

    row_number: rowNumber,

    source_field: sourceField,

    original_value: currentValue,

    corrected_value: correctedValue.trim(),

    reason: reason.trim(),

    corrected_by: w.userId

  }).select('id').single()

  if (error) throw error



  try {

    await writeAudit(w, 'source_row_corrected', 'import_row', sourceRow.id, {

      import_id: importId, row_number: rowNumber, source_field: sourceField,

      correction_id: data.id

    })

    return { correctionId: data.id }

  } catch (auditError) {

    return { correctionId: data.id, auditWarning: auditError instanceof Error ? auditError.message : String(auditError) }

  }

}



/**

 * Reconstruct an effective source row from immutable imported data

 * and its append-only correction ledger.

 *

 * Only the source field mapped to Patient.birthDate is supported.

 * Original source data is never mutated.

 */

export type SourceRowCorrection = {

  id: string

  tenant_id: string

  import_id: string

  import_row_id: string

  row_number: number

  source_field: string

  original_value: string | null

  corrected_value: string

  created_at: string

}



export type SourceRowIdentity = {

  tenantId: string

  importId: string

  importRowId: string

  rowNumber: number

}



export function applySourceRowCorrections(

  original: SourceRow,

  identity: SourceRowIdentity,

  corrections: SourceRowCorrection[],

  expectedSourceField: string

): SourceRow {

  if (corrections.length > 0 && !expectedSourceField.trim()) {

    throw new Error('Approved Patient birthDate source mapping is required to apply corrections.')

  }



  const effective: SourceRow = { ...original }



  const ordered = [...corrections].sort((a, b) => {

    const byDate = a.created_at.localeCompare(b.created_at)

    return byDate || a.id.localeCompare(b.id)

  })



  for (const correction of ordered) {

    if (

      correction.tenant_id !== identity.tenantId ||

      correction.import_id !== identity.importId ||

      correction.import_row_id !== identity.importRowId ||

      correction.row_number !== identity.rowNumber

    ) {

      throw new Error('Source correction does not belong to this tenant, import or source row.')

    }



    if (correction.source_field !== expectedSourceField) {

      throw new Error('Unsupported source correction field. Only the approved Patient birthDate mapping is permitted.')

    }



    const currentValue = String(effective[correction.source_field] ?? '')

    const expectedOriginal = correction.original_value ?? ''



    if (currentValue !== expectedOriginal) {

      throw new Error('Source correction history is inconsistent. The recorded original value does not match the preceding effective value.')

    }



    effective[correction.source_field] = correction.corrected_value

  }



  return effective

}
