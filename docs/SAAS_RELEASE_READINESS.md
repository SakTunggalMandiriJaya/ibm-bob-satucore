# SATUCORE SaaS release-readiness checklist

This checklist records the current MVP boundary and the evidence required before calling SATUCORE production-ready. A UI state, local preview, or successful connectivity preflight is not proof of a completed integration.

## Confirmed in the current application source

- React 19 + Vite + TypeScript frontend.
- Supabase Auth session and tenant workspace lookup.
- Workspace lookup rejects users with multiple active clinic memberships and clinics with multiple active Organizations until an explicit selection flow exists.
- CSV ingestion, deterministic profiling, tenant-scoped import persistence, source row preservation, field mapping review, canonical Patient creation, FHIR R4 Patient draft, local validation and audit writes are implemented in the frontend workflow.
- KFA catalogue search/synchronization and clinic-specific review call backend Edge Functions.
- SATUSEHAT connectivity preflight is a backend call; the UI correctly states that preflight does not authorize Patient submission.
- SATUSEHAT Patient write remains disabled. No live Patient transmission is claimed.

## Release blockers to close

### 1. Patient correction and human review

- [x] Add a reusable Patient conflict-resolution dialog component (`src/components/PatientConflictResolution.tsx`) with current value, proposed value, mandatory reason/evidence and a pending-review hand-off.
- [x] Wire the action into Patient records and persist proposals to `patient_correction_requests` using the Patient's tenant resolved server-side by RLS-scoped lookup.
- [x] Add a tenant-scoped pending review queue with reviewer-only approve/reject decisions and append audit events.
- [x] Add database RLS, tenant/Patient/FHIR consistency trigger, immutable evidence fields and one-way pending-to-decision transition.
- [ ] After approval, apply the accepted field to canonical Patient and a new versioned FHIR draft, then re-run validation. Approval currently records the decision only.
- [ ] Preserve the original import row and original canonical value; never overwrite source data.
- [ ] Store proposed value, field path, reason, requester, timestamps and status separately.
- [ ] Require an authorized reviewer to approve or reject; record reviewer and decision rationale.
- [ ] Apply approved changes only to the canonical Patient and corresponding FHIR draft.
- [ ] Re-run deterministic validation after approval and retain prior payload/version lineage.
- [ ] Enforce tenant scope and role checks in database RLS and server-side operations.
- [ ] Test rejected, duplicate, unauthorized and cross-tenant correction attempts.

**Safety gate:** do not represent correction as persisted or governed until schema, RLS, server-side authorization and audit behavior are implemented and tested. Supabase SQL inspection and the Patient identity review migration have been applied and inspected. Build and end-to-end tenant tests remain outstanding.

### 2. SATUSEHAT conformance and submission

- [ ] Load and pin the current official SATUSEHAT Patient profile and terminology rules used by the validator.
- [ ] Distinguish generic FHIR R4 validation from SATUSEHAT profile conformance in every result.
- [ ] Verify each clinic's own Organization ID, credentials, environment and authorized scope.
- [ ] Verify MPI identity workflow separately from FHIR Patient create/update.
- [ ] Keep Patient write disabled until exact-payload approval, backend authorization and scope checks are demonstrated.
- [ ] Capture actual request/response, correlation identifiers, sanitized errors and audit events for any authorized sandbox write.

### 3. SaaS operations and security

- [ ] Verify tenant isolation with two real test tenants, including storage and Edge Functions.
- [ ] Verify role matrix for clinic admin, clinician/reviewer and read-only users.
- [ ] Review storage policies, upload limits, file type validation, retention and deletion procedures.
- [ ] Confirm secrets exist only in backend secret storage; never in Vite environment variables or browser bundles.
- [ ] Retain successful CI build evidence.
- [ ] Add integration tests for missing fields, invalid dates, duplicate MRNs, API errors and cross-tenant access.
- [ ] Confirm backup/restore, monitoring, incident response and UU PDP-aligned data handling before production.

## Demo-safe status labels

- **Implemented:** evidenced in source and passing relevant tests.
- **Partial:** UI or one side of the workflow exists, but persistence, authorization or verification is incomplete.
- **Blocked:** an explicit prerequisite or access limitation prevents safe completion.
- **Simulated:** browser-only or synthetic demonstration; never present as an external API success.
- **Planned:** not yet implemented.

## Session note

The import-time MRN conflict now opens a tenant-scoped identity review dialog. It queries actual Patients in the active clinic using the same Organization and MRN, captures a reviewer rationale, and offers confirmed match, not-same-patient, or unresolved decisions. Confirmed match links the source import row to the existing Patient using a SECURITY INVOKER RPC and audit event; it does not create a duplicate Patient, merge demographics, generate a new FHIR resource, or call SATUSEHAT MPI. The migration is applied and RLS is enabled. CI build and cross-tenant negative tests are still outstanding.

The Resolve conflict action is integrated into Patient records. Proposals persist in `patient_correction_requests`; a tenant-scoped review queue records reviewer approval/rejection and audit events. The database migration was applied. Approval does not yet mutate canonical Patient or FHIR: that controlled application/versioning and revalidation step remains outstanding. Build and end-to-end tenant tests remain outstanding. Database schema and RLS policies must be inspected before adding its migration. No database migration was applied and no SATUSEHAT Patient submission was attempted.


## MRN correction follow-up — 16 November 2026

- [x] Add a reviewer-entered corrected source MRN action for a confirmed not-the-same-person outcome.
- [x] Preserve the imported original payload; write the reviewed correction to the normalized overlay and the dedicated `source_row_corrections` ledger.
- [x] Check corrected MRN against Patient records in the same tenant and Organization.
- [x] Check corrected MRN against other imported rows in the same tenant and Organization.
- [x] Record reviewer evidence, actor, timestamp and audit event.
- [x] Add sequential immutable review attempts and an atomic tenant-scoped open/reuse RPC.
- [x] Restrict open/correct/decision RPCs to active tenant_admin, clinic_admin and data_manager memberships; anon execution denied.
- [x] Apply migrations to the connected development Supabase project and verify RLS policies and function grants.
- [x] GitHub Actions build passed on the reviewed branch before the final database-only migration and again after the UI RPC integration was queued for CI.
- [ ] Confirm the latest commit's CI run after the final RPC integration.
- [ ] Run authenticated browser tests for confirmed match, corrected MRN, duplicate rejection, unresolved/retry and cross-tenant denial.
- [ ] Verify end-to-end that a corrected row regenerates a valid canonical Patient and SATUSEHAT-profile-aware FHIR draft; no SATUSEHAT send.

The source-correction path remains a development feature. A successful SQL migration or build does not prove authenticated multi-tenant behavior. PR #1 remains draft and unmerged; production and SATUSEHAT transmission remain disabled.
