// Source mirror of the currently deployed SATUSEHAT connectivity function v8.
// Do not deploy changes to this function without reviewing tenant authorization and write safeguards.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE = "https://api-satusehat-stg.dto.kemkes.go.id";
const FHIR = `${BASE}/fhir-r4/v1`;
const NIK_SYSTEM = "https://fhir.kemkes.go.id/id/nik";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function getToken(clientId: string, clientSecret: string) {
  const response = await fetch(`${BASE}/oauth2/v1/accesstoken?grant_type=client_credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`OAuth2 failed with HTTP ${response.status}`);
  return { token: body.access_token as string, expiresIn: Number(body.expires_in ?? 0), status: response.status };
}

async function fhirRequest(path: string, token: string) {
  const response = await fetch(`${FHIR}/${path}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/fhir+json" },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  try {
    const input = await req.json().catch(() => ({}));
    const action = input.action ?? "preflight";

    // Fail closed: caller-supplied approval/synthetic flags are not authoritative.
    // Patient writes stay disabled until server-side tenant, organization, resource-version
    // approval and synthetic provenance checks are implemented and tested.
    if (action === "patient_create" || action === "patient_update") {
      return json({
        success: false, action, stage: "authorization",
        error: "Patient write operations are disabled. Backend-enforced tenant authorization, facility scope, exact-resource approval and trusted synthetic provenance are not yet implemented.",
        submission_enabled: false
      }, 403);
    }

    const env = (Deno.env.get("SATUSEHAT_ENV") ?? "").trim().toLowerCase();
    const clientId = Deno.env.get("SATUSEHAT_CLIENT_ID");
    const clientSecret = Deno.env.get("SATUSEHAT_CLIENT_SECRET");
    const organizationId = Deno.env.get("SATUSEHAT_ORGANIZATION_ID");
    if (env !== "staging") return json({ success: false, stage: "configuration", error: "SATUSEHAT_ENV must be staging. Production and unverified sandbox aliases are disabled." }, 400);
    if (!clientId || !clientSecret || !organizationId) return json({ success: false, stage: "configuration", error: "SATUSEHAT credentials and Organization ID must be configured." }, 500);

    const auth = await getToken(clientId, clientSecret);
    const metadata = await fhirRequest("metadata", auth.token);
    if (!metadata.ok) return json({ success: false, stage: "fhir_metadata", oauth_http_status: auth.status, fhir_http_status: metadata.status, error: "FHIR metadata request failed." }, 502);

    const checks: Record<string, unknown> = {
      oauth2: { passed: true, http_status: auth.status, expires_in_seconds: auth.expiresIn },
      fhir_metadata: { passed: true, http_status: metadata.status, fhir_version: metadata.body?.fhirVersion ?? null, resource_type: metadata.body?.resourceType ?? null, patient_resource_advertised: JSON.stringify(metadata.body ?? {}).includes('"Patient"') },
      facility: { organization_id_configured: true, organization_scope_verified: false },
      environment: "staging",
      patient_submission_enabled: false
    };

    if (action === "preflight") return json({
      success: true, action, checks,
      next_operations: [
        "MPI Patient identifier lookup (synthetic test identifier only)",
        "Patient GET (IHS number required)",
        "Patient POST disabled pending backend-enforced approval and organization-scope verification"
      ]
    });

    if (action === "mpi_lookup") {
      const identifier = String(input.identifier ?? "").trim();
      const system = String(input.system ?? NIK_SYSTEM).trim();
      if (!identifier || !system.startsWith("https://fhir.kemkes.go.id/id/")) return json({ success: false, action, checks, error: "A test identifier and documented SATUSEHAT identifier system are required." }, 400);
      const query = new URLSearchParams({ identifier: `${system}|${identifier}` });
      const result = await fhirRequest(`Patient?${query.toString()}`, auth.token);
      return json({ success: result.ok, action, checks, operation: { method: "GET", endpoint: `${FHIR}/Patient?identifier=[redacted]`, http_status: result.status, response: result.body } }, result.ok ? 200 : 502);
    }

    if (action === "patient_get") {
      const ihs = String(input.ihs_number ?? "").trim();
      if (!ihs) return json({ success: false, action, checks, error: "ihs_number is required." }, 400);
      const result = await fhirRequest(`Patient/${encodeURIComponent(ihs)}`, auth.token);
      return json({ success: result.ok, action, checks, operation: { method: "GET", endpoint: `${FHIR}/Patient/[IHS]`, http_status: result.status, response: result.body } }, result.ok ? 200 : 502);
    }

    return json({ success: false, error: "Unsupported action. Use preflight, mpi_lookup or patient_get." }, 400);
  } catch (error) {
    return json({ success: false, stage: "connection", error: error instanceof Error ? error.message : "SATUSEHAT request failed." }, 502);
  }
});
