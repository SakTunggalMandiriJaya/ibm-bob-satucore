export const ACTIONS = Object.freeze({
  PREFLIGHT: "preflight",
  PATIENT_SEARCH_BY_IDENTIFIER: "patient_search_by_identifier",
  PATIENT_GET: "patient_get",
  PATIENT_CREATE: "patient_create",
  PATIENT_UPDATE: "patient_update"
});

const ROLE_ACTIONS = Object.freeze({
  [ACTIONS.PREFLIGHT]: new Set(["tenant_admin", "clinic_admin", "data_manager"]),
  [ACTIONS.PATIENT_SEARCH_BY_IDENTIFIER]: new Set(["tenant_admin", "clinic_admin", "data_manager", "clinician", "reviewer"]),
  [ACTIONS.PATIENT_GET]: new Set(["tenant_admin", "clinic_admin", "data_manager", "clinician", "reviewer"]),
  [ACTIONS.PATIENT_CREATE]: new Set(["tenant_admin", "clinic_admin", "data_manager", "submitter"]),
  [ACTIONS.PATIENT_UPDATE]: new Set(["tenant_admin", "clinic_admin", "data_manager", "submitter"])
});

export function isActiveMembershipForTenant(membership, tenantId, userId) {
  return membership?.status === "active" && membership.tenant_id === tenantId && membership.user_id === userId;
}

export function canRunAction(role, action) {
  return ROLE_ACTIONS[action]?.has(role) ?? false;
}

export function isKnownAction(action) {
  return Object.values(ACTIONS).includes(action);
}

export function isPermittedIdentifierSystem(system) {
  return /^https:\/\/fhir\.kemkes\.go\.id\/id\/[a-z0-9._-]+$/i.test(system);
}

export function summarizePatientResponse(body) {
  if (!body || typeof body !== "object") return { resource_type: null };
  if (body.resourceType === "Bundle") {
    return {
      resource_type: "Bundle",
      result_count: typeof body.total === "number" ? body.total : Array.isArray(body.entry) ? body.entry.length : 0
    };
  }
  return {
    resource_type: body.resourceType ?? null,
    patient_found: body.resourceType === "Patient",
    active: typeof body.active === "boolean" ? body.active : null,
    identifier_count: Array.isArray(body.identifier) ? body.identifier.length : 0,
    name_present: Array.isArray(body.name) && body.name.length > 0,
    birth_date_present: typeof body.birthDate === "string",
    gender_present: typeof body.gender === "string"
  };
}
