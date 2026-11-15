import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://api-satusehat-stg.dto.kemkes.go.id";
const FHIR = `${BASE}/fhir-r4/v1`;
const NIK_SYSTEM = "https://fhir.kemkes.go.id/id/nik";
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function getToken(clientId: string, clientSecret: string) {
  const response = await fetch(`${BASE}/oauth2/v1/accesstoken?grant_type=client_credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`OAuth2 failed with HTTP ${response.status}`);
  return { token: String(body.access_token), expiresIn: Number(body.expires_in ?? 0), status: response.status };
}

async function fhirRequest(path: string, token: string) {
  const response = await fetch(`${FHIR}/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ success: false, stage: "configuration", error: "Supabase server configuration is incomplete." }, 500);

  const bearer = req.headers.get("Authorization") ?? "";
  if (!bearer.startsWith("Bearer ")) return json({ success: false, error: "Authentication required." }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: bearer } } });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) return json({ success: false, error: "Invalid user session." }, 401);
  const admin = createClient(supabaseUrl, serviceKey);

  const input = await req.json().catch(() => ({}));
  const tenantId = String(input.tenant_id ?? "").trim();
  if (!tenantId) return json({ success: false, error: "tenant_id is required." }, 400);
  const { data: membership } = await admin.from("tenant_members").select("role,status")
    .eq("tenant_id", tenantId).eq("user_id", auth.user.id).eq("status", "active").maybeSingle();
  if (!membership) return json({ success: false, error: "Active tenant membership required." }, 403);

  const { data: connections, error: connectionError } = await admin.from("satusehat_connections")
    .select("id,tenant_id,organization_id,environment,client_id_reference,client_secret_reference,connection_status")
    .eq("tenant_id", tenantId).eq("environment", "sandbox");
  if (connectionError) return json({ success: false, stage: "configuration", error: "Could not load tenant Sandbox connection." }, 500);
  if (!connections?.length) return json({ success: false, stage: "configuration", error: "No Sandbox connection is configured for this tenant." }, 409);
  if (connections.length !== 1) return json({ success: false, stage: "configuration", error: "Multiple Sandbox connections found. Select a facility connection before testing." }, 409);
  const connection = connections[0];

  const { data: organization, error: organizationError } = await admin.from("organizations")
    .select("id,tenant_id,satusehat_organization_id,active")
    .eq("id", connection.organization_id).eq("tenant_id", tenantId).maybeSingle();
  if (organizationError || !organization?.active || !organization.satusehat_organization_id)
    return json({ success: false, stage: "configuration", error: "Active local Organization with SATUSEHAT Organization ID is required." }, 409);

  const clientId = Deno.env.get(connection.client_id_reference);
  const clientSecret = Deno.env.get(connection.client_secret_reference);
  const globalOrganizationId = Deno.env.get("SATUSEHAT_ORGANIZATION_ID");
  const env = (Deno.env.get("SATUSEHAT_ENV") ?? "").trim().toLowerCase();
  if (!clientId || !clientSecret) return json({ success: false, stage: "configuration", error: "Configured tenant credential secret references are missing from Edge Function Secrets." }, 409);
  if (env && !["sandbox", "staging"].includes(env)) return json({ success: false, stage: "configuration", error: "SATUSEHAT_ENV does not identify the Sandbox environment." }, 409);
  if (globalOrganizationId && globalOrganizationId !== organization.satusehat_organization_id)
    return json({ success: false, stage: "configuration", error: "Global Organization ID does not match this tenant facility. Refusing cross-organization credential use." }, 409);

  const action = String(input.action ?? "preflight");
  if (action === "patient_create" || action === "patient_update")
    return json({ success: false, action, stage: "authorization", submission_enabled: false, error: "Patient writes remain disabled pending backend-enforced exact-resource approval, SATUSEHAT profile validation and facility-scope verification." }, 403);

  try {
    const authResult = await getToken(clientId, clientSecret);
    const metadata = await fhirRequest("metadata", authResult.token);
    if (!metadata.ok) {
      await admin.from("satusehat_connections").update({ connection_status: "error", last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", connection.id).eq("tenant_id", tenantId);
      return json({ success: false, stage: "fhir_metadata", oauth_http_status: authResult.status, fhir_http_status: metadata.status, error: "OAuth succeeded but FHIR metadata request failed." }, 502);
    }

    const checks = {
      oauth2: { passed: true, http_status: authResult.status, expires_in_seconds: authResult.expiresIn },
      fhir_metadata: {
        passed: true, http_status: metadata.status,
        fhir_version: metadata.body?.fhirVersion ?? null,
        resource_type: metadata.body?.resourceType ?? null,
        patient_resource_advertised: JSON.stringify(metadata.body ?? {}).includes('"Patient"')
      },
      facility: {
        organization_id_configured: true,
        organization_id: organization.satusehat_organization_id,
        organization_scope_verified: false
      },
      environment: "sandbox",
      patient_submission_enabled: false
    };

    if (action === "preflight") {
      await admin.from("satusehat_connections").update({
        connection_status: "tested", last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq("id", connection.id).eq("tenant_id", tenantId);
      await admin.from("audit_logs").insert({
        tenant_id: tenantId, actor_user_id: auth.user.id, action: "satusehat.sandbox_preflight",
        entity_type: "satusehat_connection", entity_id: connection.id,
        outcome: "success", metadata: { environment: "sandbox", oauth_http_status: authResult.status, fhir_http_status: metadata.status, organization_scope_verified: false }
      });
      return json({ success: true, action, checks, next_operations: [
        "MPI lookup with an authorized test identifier",
        "Patient GET with an IHS number",
        "Patient writes remain disabled pending approval and facility-scope verification"
      ] });
    }

    if (action === "mpi_lookup") {
      const identifier = String(input.identifier ?? "").trim();
      const system = String(input.system ?? NIK_SYSTEM).trim();
      if (!identifier || !system.startsWith("https://fhir.kemkes.go.id/id/"))
        return json({ success: false, action, checks, error: "A test identifier and documented SATUSEHAT identifier system are required." }, 400);
      const query = new URLSearchParams({ identifier: `${system}|${identifier}` });
      const result = await fhirRequest(`Patient?${query.toString()}`, authResult.token);
      return json({ success: result.ok, action, checks, operation: {
        method: "GET", endpoint: `${FHIR}/Patient?identifier=[redacted]`, http_status: result.status, response: result.body
      } }, result.ok ? 200 : 502);
    }

    if (action === "patient_get") {
      const ihs = String(input.ihs_number ?? "").trim();
      if (!ihs) return json({ success: false, action, checks, error: "ihs_number is required." }, 400);
      const result = await fhirRequest(`Patient/${encodeURIComponent(ihs)}`, authResult.token);
      return json({ success: result.ok, action, checks, operation: {
        method: "GET", endpoint: `${FHIR}/Patient/[IHS]`, http_status: result.status, response: result.body
      } }, result.ok ? 200 : 502);
    }

    return json({ success: false, error: "Unsupported action. Use preflight, mpi_lookup or patient_get." }, 400);
  } catch (error) {
    await admin.from("satusehat_connections").update({
      connection_status: "error", last_tested_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", connection.id).eq("tenant_id", tenantId);
    return json({ success: false, stage: "connection", error: error instanceof Error ? error.message : "SATUSEHAT request failed." }, 502);
  }
});