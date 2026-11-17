# SATUCORE session handover — 17 November 2026

## Purpose
This note records the verified project position and next engineering actions for continuity. It does not claim that local files, GitHub, and the connected Supabase project are byte-for-byte synchronized.

## Repository and branch
- Repository: `SakTunggalMandiriJaya/ibm-bob-satucore`
- Default branch: `main`
- Active implementation branch: `feature/patient-correction-review-2026-11-15`
- Existing pull request: [PR #1 — Patient conflict proposal and human review workflow](https://github.com/SakTunggalMandiriJaya/ibm-bob-satucore/pull/1)
- PR #1 remains draft and unmerged. Do not create a duplicate PR or duplicate implementation branch.
- At the time of this note, the feature branch is 53 commits ahead of main and 0 commits behind main.
- Keep changes on the existing feature branch until review and verification are complete.

## Verified local development evidence (user-reported)
The user ran these commands in the Windows working copy:
- `npm run build`: passed. TypeScript compilation and Vite production build succeeded; 1,630 modules transformed. Vite emitted an advisory that the 601.94 kB JavaScript chunk exceeds its 500 kB warning threshold. This is not a build failure.
- `npm test`: passed, 1 test file and 16 tests. Coverage shown in output is local Patient draft validation (9) and source-row correction overlay (7).
- These results apply to the user's current local working copy at the time reported. They must not be represented as tests of a particular GitHub SHA unless the working tree is synchronized and the same commands are run against that SHA.

## GitHub CI evidence
- Latest PR workflow run inspected: run 148, ID `43797599864`.
- Commit: `dc66e801352a887cfd3bc893de3a9bd0e1a51596`.
- Event: pull_request; result: completed / success (16 November 2026).
- This verifies the configured GitHub Actions build for that commit. It does not establish authenticated browser end-to-end behavior or tenant isolation.

## Supabase / identity-review position
- The connected development Supabase project was inspected read-only during this session.
- Previously applied identity-review migrations include the identity review workflow, decision hardening, decision-RPC ambiguity fix, and allowed processing statuses `identity_matched` and `identity_review`.
- The schema contains Patient, Patient identifier, FHIR resource, import row, identity review request and audit structures.
- No migration or database write was performed during the GitHub inspection in this session.
- The existing PR implementation documents a tenant/Organization-scoped review flow, reviewer roles, confirmed-match linking, source MRN correction ledger, sequential review attempts and an atomic SECURITY INVOKER review-open RPC.
- A confirmed local clinic match is not SATUSEHAT MPI confirmation and does not establish an IHS identity.
- Do not create a duplicate Patient or duplicate Patient identifier when processing a confirmed match.
- A not-same-person decision must use the controlled source-MRN correction path and collision checks; never bypass a unique identifier constraint.
- Unresolved identity remains blocked.
- Verify actual deployed function definitions, grants and RLS policies before applying any further migration. Do not assume local migrations equal deployed migrations.

## Current safety boundaries
- Synthetic data only for demonstrations.
- Do not expose Supabase service-role credentials or SATUSEHAT credentials in browser code, Git, logs or UI.
- No automatic identity merge.
- No SATUSEHAT Patient create/update is authorized by a local identity-review decision.
- MPI, FHIR Patient, KYC, Master Wilayah, MSI, KFA and SSRME remain separate operations.
- Generic FHIR R4 validation must not be labelled SATUSEHAT profile conformance.
- SATUSEHAT Patient transmission remains disabled unless backend authorization, clinic-specific Organization scope, exact-payload approval, current profile validation and audited response handling are verified.

## Remaining work — recommended order
1. Reconcile the user's latest local working copy with the existing GitHub feature branch. Preserve all local changes; do not reset, clean, stash or overwrite.
2. Inspect the complete current implementation of identity review, MRN correction, canonical Patient persistence and FHIR draft generation.
3. Close the confirmed-match persistence gap only if it remains present in the reconciled code. The expected behavior is source-row linkage to the existing canonical Patient, no duplicate Patient, no duplicate MRN identifier, and immutable lineage/audit.
4. Keep not-same-person correction and unresolved cases fail-closed. Re-run canonical Patient/FHIR draft generation only after a corrected MRN passes tenant + Organization scoped collision checks.
5. Add dedicated automated tests for confirmed match, not-same-person correction, unresolved, duplicate/retry/idempotency, invalid candidate, authorization and cross-tenant denial.
6. Run authenticated browser tests using two synthetic tenants and role variants. Existing PR notes state these tests remain outstanding.
7. Reconcile implementation and release-readiness documentation with observed behavior and CI evidence.
8. Keep PR #1 draft until all relevant tests pass. Merge only after review; do not deploy production or enable SATUSEHAT Patient writes as part of this task.

## Known outstanding release risks
- Authenticated browser end-to-end tests and cross-tenant negative tests are not evidenced by the current PR description.
- Supabase security-advisor findings previously recorded in PR #1 include RLS-without-policy findings on `SATUCORE_synthetic_patient`, `satusehat_connections` and `terminology_sources`, plus leaked-password protection disabled. Recheck current state before release; do not assume resolved.
- Full current SATUSEHAT Patient profile validation, MPI identity confirmation and live Patient submission are not established by the local build or identity-review workflow.
- Excel ingestion and longitudinal clinical resource workflows are not established as complete.

## Operating instruction
Continue from this repository, existing branch and PR. Make the smallest safe change, test it, document actual evidence, and never claim a deployment or external acceptance that did not occur.
