# SATUSEHAT Patient validation notes

## Source evidence

The supplied SATUSEHAT Postman collections include Patient examples with the profile canonical:

`https://fhir.kemkes.go.id/r4/StructureDefinition/Patient`

Some supplied examples also include the version-qualified canonical:

`https://fhir.kemkes.go.id/r4/StructureDefinition/Patient|4.0.1`

The examples show Patient search using the documented NIK identifier system:

`https://fhir.kemkes.go.id/id/nik`

These examples are useful implementation evidence but are not a substitute for the current official Patient StructureDefinition, required bindings, cardinalities, invariants, and terminology ValueSets.

## Current application behavior

- The generated Patient draft uses the SATUSEHAT Patient profile canonical shown in the supplied examples.
- The source MRN is retained under a SATUCORE-local identifier system. It is not relabeled as NIK and does not claim to be an IHS number.
- Generic FHIR R4 checks cover resource type, required Patient name for this workflow, valid calendar birth date, future birth date, and administrative gender code.
- Missing MRN is a warning requiring identity review, not an instruction to invent a national identifier.
- The application explicitly marks SATUSEHAT profile conformance as not yet executed.

## Required next conformance step

Install or implement a validator from the current official SATUSEHAT Patient profile package and terminology package, record their version/date, and validate all profile constraints server-side before enabling approval for external submission. Never infer mandatory fields from example payloads alone.
