# SATUCORE MVP implementation status

Updated: 2026-11-17

## Implemented in the repository

- React + TypeScript + Vite localhost application foundation.
- Supabase Auth email/password sign-in and active tenant membership resolution.
- Tenant context is derived from the authenticated user's active `tenant_members` row; the browser does not select an arbitrary tenant ID.
- CSV upload to the private `legacy-imports` bucket under a tenant/import path.
- SHA-256 source-file checksum and original file retention.
- SCAN profile persistence in `data_imports`, `import_rows` and `schema_profiles`.
- Deterministic source-column mapping suggestions and explicit human review in `field_mappings` and `mapping_approvals`.
- Canonical Patient transformation and persistence in `patients` and `patient_identifiers`.
- FHIR R4 Patient draft persistence in `fhir_resources`, including SHA-256 payload hash and source lineage.
- Deterministic validation findings persisted in `validation_results`.
- Audit events persisted in `audit_logs`.
- Tenant-scoped Patient, transaction and audit list views.
- Read-only terminology explorer over the imported terminology catalogue, with source sheet and code display.
- Duplicate source MRN detection and a guard against automatic duplicate Patient creation.
- Staging preflight results explicitly distinguish OAuth/FHIR metadata success from unverified facility scope.
- SATUSEHAT staging preflight button wired to the existing JWT-protected Edge Function.
- Version-controlled source mirror of the currently deployed `satusehat-connectivity-test` Edge Function v8.
- Patient correction proposal/review UI and tenant-scoped reviewer queue.
- Import-time MRN conflict review, confirmed-match handling, source MRN correction ledger, sequential review attempts and atomic review-open RPC are included on the current feature branch. See [PR #1](https://github.com/SakTunggalMandiriJaya/ibm-bob-satucore/pull/1) and the session handover.

## Explicitly gated / not implemented

- SATUSEHAT Patient create/update remains disabled by the deployed Edge Function.
- The staging preflight checks OAuth2 and FHIR metadata only; it does not prove that the configured Organization ID is authorized for every tenant.
- MPI lookup is a distinct identity search, not Patient creation or KYC verification.
- No automatic MPI identity merge is implemented.
- A current, executable SATUSEHAT Patient StructureDefinition/profile validator is not yet installed. The local validator records generic FHIR R4 checks only and does not claim SATUSEHAT conformance.
- Exact-payload submission approval must be performed by a trusted backend that computes and verifies the payload hash. The browser does not write a submission approval or enable transmission.
- Excel ingestion, longitudinal Encounter/Observation/Condition/ServiceRequest/DiagnosticReport/ImagingStudy/Medication/Procedure workflows, production transmission, and SSRME are planned, not complete.
- Confirmed local identity match must not be described as SATUSEHAT MPI/IHS confirmation.
- Authenticated browser end-to-end and cross-tenant negative tests are still required before treating identity review as release-ready.

## Safety and demo boundaries

- Use synthetic data for the hackathon demo.
- No service-role key or SATUSEHAT credential is included in the browser build.
- No SATUSEHAT Patient write enablement or production deployment is authorized by this status update.
- Multi-step browser persistence is protected by RLS but is not a single database transaction; a failed step is surfaced and the import is marked failed where possible.
- Tenant scope must be enforced in database policies and RPCs, not trusted from client-supplied identifiers.
- Preserve original imported source data; corrections belong in the normalized overlay and correction ledger.
- Never bypass the tenant + Organization MRN uniqueness boundary or create duplicate Patient identifiers.

## Terminology domain foundation (2026-11-15)

- Added domain classification fields to terminology sets and sources; existing LOINC 2.74 rows remain classified as unclassified until explicitly reviewed.
- Added a separate `medication_products` reference catalogue for KFA-like medicinal product/device catalogues. This is intentionally distinct from FHIR `Medication` and `MedicationRequest`.
- The new catalogue is empty by design. No KFA source file/version was verified in the supplied inventory, so no product codes were fabricated or imported.
- Catalogue rows retain source ID, source sheet, source row, version, code system URI, properties and human approval status.
- Authenticated users can read reference catalogue entries; writes remain restricted to trusted backend/service operations.
- Existing terminology mappings marked `relatedto` remain suggestions and are not promoted to `equivalent`.
- This migration establishes schema only. Source-specific parsers, import execution, domain classification, terminology validation and FHIR-path binding remain pending.

## Verification snapshot (2026-11-17)

### User's current local working copy
- `npm run build`: passed. TypeScript and Vite production build completed; 1,630 modules transformed. The JavaScript bundle was 601.94 kB and Vite emitted its advisory warning for chunks above 500 kB.
- `npm test`: passed, 16/16 tests in one file. The reported tests cover local Patient draft validation (9) and source-row correction overlay (7).
- These results were reported from the user's current Windows working copy. They are not attributed to a GitHub commit SHA because synchronization of that exact working tree to the feature branch has not yet been proven.

### GitHub Actions
- PR #1 workflow run 148 completed successfully on 2026-11-16 for commit `dc66e801352a887cfd3bc893de3a9bd0e1a51596`.
- This is evidence of the configured GitHub Actions build for that commit, not authenticated browser E2E or cross-tenant test coverage.

### Release gate
- PR #1 remains draft and unmerged.
- Reconcile the latest local working copy with the feature branch before further code changes.
- Add and pass dedicated identity-review, retry/idempotency, role authorization and cross-tenant negative tests.
- Recheck live Supabase RLS, grants and function definitions before applying any migration.
- Keep SATUSEHAT Patient transmission disabled until current profile conformance, facility scope, exact-payload approval and audited backend submission are independently verified.

For detailed next actions and the evidence boundary, see [SESSION_HANDOVER_2026-11-17.md](SESSION_HANDOVER_2026-11-17.md).
