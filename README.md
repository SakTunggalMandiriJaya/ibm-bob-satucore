# SATUCORE

**Andalan AI · Legacy Healthcare Data Intelligence & Interoperability**

SATUCORE prepares legacy EMR/SIMRS/LIS/RIS data for governed interoperability with SATUSEHAT. It connects to existing systems; it does not replace them.

## MVP workflow

SCAN → MAP → VALIDATE → HUMAN APPROVAL → SEND → MONITOR

The first demonstrable workflow focuses on synthetic Patient data:
- CSV upload and deterministic profiling
- Human-reviewed source-to-Patient mapping
- Canonical Patient and FHIR R4 preview
- Deterministic validation and approval gates
- SATUSEHAT staging readiness and auditable outcomes

AI recommendations are advisory. Identity conflicts, mappings and submissions require human control. A simulated action is never represented as a real SATUSEHAT transmission.

## Local development

Requirements: Node.js 20+ and npm.

1. Copy `.env.example` to `.env`.
2. Set the Supabase project URL and publishable key.
3. Install and run:

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite.

## Security boundaries

- Browser uses only the Supabase publishable key and the signed-in user's session.
- Service-role keys and SATUSEHAT credentials remain server-side.
- Tenant access is based on authenticated membership and database RLS, not a client-supplied tenant identifier.
- Use synthetic data for demos. Never send NIK or identifiable clinical data to cloud AI.
- SATUSEHAT write operations remain disabled unless backend authorization, facility scope, exact-payload approval and provenance checks are satisfied.

## Current scope

The interface is an MVP foundation. SATUSEHAT profile conformance and live Patient write are not claimed unless backed by current official profile rules and an explicitly enabled, verified backend operation.
