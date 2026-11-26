# SATUCORE — SCAN UI Behavior Specification

Version: 1.0
Date: 25 November 2026
Status: Approved product requirement

## 1. Purpose

SCAN identifies data-quality and identity issues in legacy healthcare records.
Findings must be visible directly in the original source-data table.

The user must immediately understand:
- Which record is affected.
- Which source field is affected.
- What the detected problem is.
- Whether human review is required.

SCAN must not modify original source values.

## 2. Table Structure

The SCAN findings table must contain:
1. Index column: sequential record number, starting at 1.
2. Original source columns, in their original order.

Do not add a separate SCAN STATUS column.

The index identifies the record. Highlight the actual affected source cells.

## 3. Cell Highlighting and Color Legend

- RED (#DC4545): Invalid value. A deterministic validation rule failed.
- AMBER (#D97706): Missing value. A required or expected value is blank.
- BLUE (#3976C8): Duplicate group 1.
- PURPLE (#8058C7): Duplicate group 2.
- TEAL (#219985): Duplicate group 3.
- ORANGE (#C56B42): Duplicate group 4.
- PINK (#B65380): Duplicate group 5.
- GREY (#718397): Duplicate group 6.
- GREEN (#16A36A): No detected issue, where a cell or record-level indicator is appropriate.

The color legend must always be visible above the SCAN findings table.

The legend must explain the meaning of each color. It must not rely on color alone; use text labels and hover explanations.

If more than six duplicate groups exist, use a deterministic, stable color assignment. Never assign colors randomly on each render.

## 4. Duplicate and Identity Detection

Duplicate comparison is tenant-scoped. Records belonging to different clinic tenants must never be compared.

Normalize identifiers and names for comparison without overwriting original values.

### 4.1 Same normalized MRN + same normalized name

Classification: POTENTIAL EXACT DUPLICATE.

- Highlight the MRN cells in all matching records.
- Highlight the corresponding name cells.
- Assign the same duplicate-group color to all occurrences.
- Display the duplicate-group identifier.
- Require human review.
- Never automatically merge or delete records.

### 4.2 Same normalized MRN + different normalized names

Classification: IDENTITY CONFLICT.

- Highlight the MRN cells in all conflicting records.
- Highlight the conflicting name cells.
- Assign the same duplicate-group color to all occurrences.
- Display an explicit IDENTITY CONFLICT warning.
- Require authorized human investigation and resolution.
- Block canonical approval and submission while the conflict remains unresolved.
- Never automatically merge identities.

### 4.3 Different MRNs + same normalized name

Classification: POSSIBLE IDENTITY MATCH.

- Do not classify as a confirmed duplicate based on name alone.
- Other available demographic evidence may support a review suggestion.
- Do not automatically merge identities.
- Preserve separate records pending human review.

### 4.4 Duplicate group behavior

- Every detected group has a stable group identifier.
- All occurrences belonging to one group use the same color.
- Different groups use different colors whenever available.
- All affected occurrences must be highlighted together.
- Duplicate occurrences must blink synchronously until the group is reviewed or acknowledged.
- Blinking must stop after review or acknowledgment.
- The group and its review state must remain auditable.

## 5. Multiple Issues in One Record

A record may have multiple issues.

- Highlight every affected cell.
- Do not highlight only the highest-priority issue.
- Preserve distinct issue meanings.
- If a cell has multiple findings, provide all findings through its hover explanation or issue details.
- Do not allow one issue to hide another.

## 6. Hover and Issue Explanation

Hovering over an affected cell must explain:
- Issue category.
- Detected value, where appropriate.
- Expected value or rule, where available.
- Related record index for duplicate findings.
- Duplicate-group identifier, where applicable.
- Whether human review is required.

Do not invent validation rules or expected clinical values.

## 7. SCAN Summary

Keep summary cards above the findings table:
- Total records.
- Clean records.
- Invalid records.
- Missing data.
- Duplicate records or groups.

Counts must be derived from actual deterministic findings. Define whether duplicate metrics count records or groups and label them accurately.

The SCAN assessment panel may summarize:
- Source structure readability.
- Patient validation findings.
- Source completeness.
- Duplicate identifier findings.

## 8. Navigation

Required workflow:

Source Data -> SCAN -> MAP

Source Data:
- Upload and inspect original source records.
- Preserve the original source preview.
- Save the import to the tenant where supported.
- Navigate to SCAN.

SCAN:
- Assess the loaded source records.
- Display cell-level findings and the color legend.
- Allow navigation back to Source Data.
- Allow continuation to MAP.

If no source data exists, show an empty state and direct the user to Source Data.

## 9. Data Integrity and Governance

- Original source values must never be overwritten by SCAN.
- Normalized comparison values must remain distinguishable from original values.
- AI suggestions must not be treated as authoritative identity decisions.
- No autonomous patient merge.
- No autonomous submission.
- Identity conflicts require human resolution.
- Findings, review decisions and changes must be auditable.
- Keep tenant isolation enforced server-side.
- SCAN UI changes must not alter existing Patient persistence, validation, canonical approval or FHIR submission logic.

## 10. Implementation Boundaries

This specification governs SCAN presentation and behavior.

It does not authorize:
- Database schema changes.
- Changes to Patient approval logic.
- Changes to identity-resolution rules without explicit approval.
- Changes to FHIR transformation or SATUSEHAT submission.
- Automatic patient merging.
- Changes to existing source records.

## 11. Acceptance Criteria

The implementation is accepted only when:

1. The findings table has an index column.
2. There is no separate SCAN STATUS column.
3. Actual problematic source cells are highlighted.
4. The color legend is visible and understandable.
5. Missing values are amber.
6. Invalid values are red.
7. Same MRN and same name are classified as potential exact duplicates.
8. Same MRN and different names are classified as identity conflicts.
9. Different MRNs and same names are not automatically classified as duplicates.
10. Duplicate occurrences share a stable group color.
11. Duplicate occurrences blink synchronously until reviewed or acknowledged.
12. Multiple issues in one record are all visible.
13. Hover explanations provide available issue details.
14. Original source values remain unchanged.
15. Tenant isolation is preserved.
16. Existing Patient validation, duplicate blocking, canonical approval and persistence tests continue to pass.

## 12. Change Governance

This document is the approved reference for SCAN UI behavior.

Any proposed change must:
- Identify the requirement being changed.
- Explain why the change is necessary.
- Preserve existing data and workflow integrity.
- Include appropriate regression tests.
- Receive explicit approval before changing this specification.

End of specification.