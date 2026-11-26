# SATUCORE Phase 3 — Identity-review persistence fix (candidate)

## Confirmed defect
The current frontend helper writes directly to `patient_identity_review_requests`. Production grants `authenticated` SELECT but not INSERT on this table. The database already exposes `create_patient_identity_review_request(uuid,uuid,uuid,integer,text,text,uuid)`, which authenticated users can execute. It performs membership/role checks, tenant and source-row validation, pending-request idempotency, and audit logging.

## Proposed minimal correction
Replace only `createPatientIdentityReviewRequest()` in `src/lib/workflow.ts` with the implementation in `workflow-identity-review-rpc.ts` (or apply `identity-review-rpc.patch`). It calls the existing RPC and removes the direct table insert and separate frontend audit write. No database migration is required for this correction.

## Safety
- Candidate patch only; no repository files or database objects were changed by preparing it.
- Do not deploy a migration or change grants to authenticated.
- Keep tenant and organization parameters from the active workspace.
- The RPC validates authorization and source ownership server-side.
- Do not use `satucore-sync`; target only `satucore-remote-check`.

## Validation
After applying to the actual working tree:
1. Run `npm test`.
2. Run `npm run build`.
3. In localhost, use only the synthetic duplicate test row and submit one review request.
4. Confirm one pending row appears in the same tenant's queue and the audit event is present.
5. Repeat once to confirm the RPC returns the existing pending request rather than inserting a duplicate.
6. Verify another tenant cannot read or decide the request.

The prepared source was extracted from the uploaded `SATUCORE-Phase3-Review-FIX.zip`. Confirm the current working-tree helper matches the original hunk before applying; do not overwrite unrelated changes.
