import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONS,
  canRunAction,
  isActiveMembershipForTenant,
  isKnownAction,
  isPermittedIdentifierSystem,
  summarizePatientResponse
} from "./policy.mjs";

test("permits only authorized roles for sensitive integration actions", () => {
  assert.equal(canRunAction("clinic_admin", ACTIONS.PREFLIGHT), true);
  assert.equal(canRunAction("clinician", ACTIONS.PATIENT_SEARCH_BY_IDENTIFIER), true);
  assert.equal(canRunAction("auditor", ACTIONS.PATIENT_GET), false);
  assert.equal(canRunAction("clinician", ACTIONS.PREFLIGHT), false);
});

test("requires an active membership for the exact tenant and user", () => {
  const membership = { tenant_id: "tenant-a", user_id: "user-a", status: "active" };
  assert.equal(isActiveMembershipForTenant(membership, "tenant-a", "user-a"), true);
  assert.equal(isActiveMembershipForTenant(membership, "tenant-b", "user-a"), false);
  assert.equal(isActiveMembershipForTenant(membership, "tenant-a", "user-b"), false);
  assert.equal(isActiveMembershipForTenant({ ...membership, status: "invited" }, "tenant-a", "user-a"), false);
});

test("rejects the mislabeled MPI action and minimizes Patient results", () => {
  assert.equal(isKnownAction("mpi_lookup"), false);
  assert.equal(isPermittedIdentifierSystem("https://fhir.kemkes.go.id/id/nik"), true);
  assert.equal(isPermittedIdentifierSystem("https://example.invalid/id/nik"), false);
  assert.deepEqual(summarizePatientResponse({ resourceType: "Bundle", total: 2, entry: [{}, {}] }), {
    resource_type: "Bundle",
    result_count: 2
  });
  assert.deepEqual(summarizePatientResponse({
    resourceType: "Patient", id: "sensitive-id", name: [{ text: "Sensitive name" }], birthDate: "2000-01-01", gender: "female", identifier: [{ value: "sensitive-id" }]
  }), {
    resource_type: "Patient",
    patient_found: true,
    active: null,
    identifier_count: 1,
    name_present: true,
    birth_date_present: true,
    gender_present: true
  });
});
