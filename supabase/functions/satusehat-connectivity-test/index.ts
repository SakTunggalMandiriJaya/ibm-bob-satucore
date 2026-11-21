import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  ACTIONS,
  canRunAction,
  isActiveMembershipForTenant,
  isKnownAction,
  isPermittedIdentifierSystem,
  summarizePatientResponse
} from "./policy.mjs";

const BASE = "https://api-satusehat-stg.dto.kemkes.go.id";
const FHIR = `${BASE}/fhir-r4/v1`;
const NIK_SYSTEM = "https://fhir.kemkes.go.id/id/nik";

// CORS is required for browser calls from the SATUCORE localhost app.
// This endpoint does not use cookie authentication: every operation still
// requires and validates the caller's Supabase Bearer token below.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store"
    }
  });

async function getToken(clientId: string, clientSecret: string) {
  const response = await fetch(
    `${BASE}/oauth2/v1/accesstoken?grant_type=client_credentials`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    throw new Error(`OAuth2 failed with HTTP ${response.status}`);
  }

  return {
    token: String(body.access_token),
    expiresIn: Number(body.expires_in ?? 0),
    status: response.status
  };
}

async function fhirRequest(path: string, token: string) {
  const response = await fetch(`${FHIR}/${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/fhir+json"
    }
  });

  const body = await response.json().catch(() => null);

  return {
    status: response.status,
    ok: response.ok,
    body
  };
}

Deno.serve(async (req: Request) => {
  // Browsers send OPTIONS before the authenticated POST. Respond before
  // method checks, authentication, or JSON parsing.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  if (req.method !== "POST") {
    return json(
      { success: false, error: "POST required" },
      405
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(
      {
        success: false,
        stage: "configuration",
        error: "Supabase server configuration is incomplete."
      },
      500
    );
  }

  const bearer = req.headers.get("Authorization") ?? "";

  if (!bearer.startsWith("Bearer ")) {
    return json(
      { success: false, error: "Authentication required." },
      401
    );
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: { Authorization: bearer }
    }
  });

  const { data: auth, error: authError } =
    await userClient.auth.getUser();

  if (authError || !auth.user) {
    return json(
      { success: false, error: "Invalid user session." },
      401
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const input = await req.json().catch(() => ({}));

  const tenantId = String(input.tenant_id ?? "").trim();
  const action = String(input.action ?? ACTIONS.PREFLIGHT).trim();

  if (!tenantId) {
    return json(
      { success: false, error: "tenant_id is required." },
      400
    );
  }

  // All connection status updates are tenant-scoped and checked.
  const updateConnectionStatus = async (
    connectionId: string,
    status: "tested" | "error"
  ): Promise<boolean> => {
    const now = new Date().toISOString();

    const { error } = await admin
      .from("satusehat_connections")
      .update({
        connection_status: status,
        last_tested_at: now,
        updated_at: now
      })
      .eq("id", connectionId)
      .eq("tenant_id", tenantId);

    return !error;
  };

  const { data: membership, error: membershipError } =
    await admin
      .from("tenant_members")
      .select("tenant_id,user_id,role,status")
      .eq("tenant_id", tenantId)
      .eq("user_id", auth.user.id)
      .eq("status", "active")
      .maybeSingle();

  if (membershipError) {
    return json(
      {
        success: false,
        stage: "authorization",
        error: "Could not verify tenant membership."
      },
      500
    );
  }

  if (
    !isActiveMembershipForTenant(
      membership,
      tenantId,
      auth.user.id
    )
  ) {
    return json(
      {
        success: false,
        error: "Active tenant membership required."
      },
      403
    );
  }

  const audit = async (
    outcome: string,
    metadata: Record<string, unknown> = {},
    entityId: string | null = null
  ) => {
    const { error } = await admin
      .from("audit_logs")
      .insert({
        tenant_id: tenantId,
        actor_user_id: auth.user.id,
        action: `satusehat.${action}`,
        entity_type: "satusehat_operation",
        entity_id: entityId,
        outcome,
        metadata: {
          environment: "sandbox",
          ...metadata
        }
      });

    if (error) {
      throw new Error("Audit persistence failed.");
    }
  };

  const auditedResponse = async (
    data: Record<string, unknown>,
    status: number,
    outcome: string,
    metadata: Record<string, unknown> = {},
    entityId: string | null = null
  ) => {
    try {
      await audit(outcome, metadata, entityId);
      return json(data, status);
    } catch {
      return json(
        {
          success: false,
          stage: "audit",
          error: "Audit persistence failed; the operation result was withheld."
        },
        500
      );
    }
  };

  if (!isKnownAction(action)) {
    const error =
      action === "mpi_lookup"
        ? "mpi_lookup is not supported because it performed FHIR Patient search, not the separate SATUSEHAT MPI API. Use patient_search_by_identifier for the documented FHIR Patient search."
        : "Unsupported action.";

    return auditedResponse(
      {
        success: false,
        action,
        stage: "authorization",
        error
      },
      400,
      "rejected",
      { reason: "unsupported_action" }
    );
  }

  if (!canRunAction(membership.role, action)) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "authorization",
        error: "Your active tenant role is not authorized for this SATUSEHAT operation."
      },
      403,
      "denied",
      { reason: "role_not_authorized" }
    );
  }

  try {
    await audit("requested", {
      operation_kind: action
    });
  } catch {
    return json(
      {
        success: false,
        action,
        stage: "audit",
        error: "Audit persistence failed; the operation was not started."
      },
      500
    );
  }

  // Patient writes remain deliberately disabled.
  if (
    action === ACTIONS.PATIENT_CREATE ||
    action === ACTIONS.PATIENT_UPDATE
  ) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "authorization",
        submission_enabled: false,
        error: "Patient writes remain disabled pending backend-enforced exact-resource approval, SATUSEHAT profile validation and facility-scope verification."
      },
      403,
      "blocked",
      { reason: "patient_writes_disabled" }
    );
  }

  const { data: connections, error: connectionError } =
    await admin
      .from("satusehat_connections")
      .select(
        "id,tenant_id,organization_id,environment,client_id_reference,client_secret_reference,connection_status"
      )
      .eq("tenant_id", tenantId)
      .eq("environment", "sandbox");

  if (connectionError) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "Could not load tenant Sandbox connection."
      },
      500,
      "failed",
      { stage: "configuration" }
    );
  }

  if (!connections?.length) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "No Sandbox connection is configured for this tenant."
      },
      409,
      "failed",
      { stage: "configuration" }
    );
  }

  if (connections.length !== 1) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "Multiple Sandbox connections found. Select a facility connection before testing."
      },
      409,
      "failed",
      { stage: "configuration" }
    );
  }

  const connection = connections[0];

  const { data: organization, error: organizationError } =
    await admin
      .from("organizations")
      .select("id,tenant_id,satusehat_organization_id,active")
      .eq("id", connection.organization_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

  if (
    organizationError ||
    !organization?.active ||
    !organization.satusehat_organization_id
  ) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "Active local Organization with SATUSEHAT Organization ID is required."
      },
      409,
      "failed",
      { stage: "configuration" },
      connection.id
    );
  }

  const clientId = Deno.env.get(
    connection.client_id_reference
  );

  const clientSecret = Deno.env.get(
    connection.client_secret_reference
  );

  const globalOrganizationId =
    Deno.env.get("SATUSEHAT_ORGANIZATION_ID");

  const env = (
    Deno.env.get("SATUSEHAT_ENV") ?? ""
  ).trim().toLowerCase();

  if (!clientId || !clientSecret) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "Configured tenant credential secret references are missing from Edge Function Secrets."
      },
      409,
      "failed",
      { stage: "configuration" },
      connection.id
    );
  }

  if (env && !["sandbox", "staging"].includes(env)) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "SATUSEHAT_ENV does not identify the Sandbox environment."
      },
      409,
      "failed",
      { stage: "configuration" },
      connection.id
    );
  }

  if (
    globalOrganizationId &&
    globalOrganizationId !==
      organization.satusehat_organization_id
  ) {
    return auditedResponse(
      {
        success: false,
        action,
        stage: "configuration",
        error: "Global Organization ID does not match this tenant facility. Refusing cross-organization credential use."
      },
      409,
      "failed",
      { stage: "configuration" },
      connection.id
    );
  }

  try {
    const authResult = await getToken(
      clientId,
      clientSecret
    );

    const metadata = await fhirRequest(
      "metadata",
      authResult.token
    );

    if (!metadata.ok) {
      const statusSaved = await updateConnectionStatus(
        connection.id,
        "error"
      );

      return auditedResponse(
        {
          success: false,
          action,
          stage: "fhir_metadata",
          oauth_http_status: authResult.status,
          fhir_http_status: metadata.status,
          connection_status_saved: statusSaved,
          error: statusSaved
            ? "OAuth succeeded but FHIR metadata request failed."
            : "FHIR metadata request failed and the connection error status could not be saved."
        },
        statusSaved ? 502 : 500,
        "failed",
        {
          stage: "fhir_metadata",
          oauth_http_status: authResult.status,
          fhir_http_status: metadata.status,
          connection_status_saved: statusSaved
        },
        connection.id
      );
    }

    const checks = {
      connectivity: {
        oauth2_token_obtained: true,
        oauth_http_status: authResult.status,
        fhir_metadata_reachable: true,
        fhir_http_status: metadata.status,
        fhir_version: metadata.body?.fhirVersion ?? null,
        patient_resource_advertised:
          JSON.stringify(metadata.body ?? {}).includes(
            '"Patient"'
          )
      },
      facility_scope: {
        organization_id_configured: true,
        scope_verification_status: "not_verified",
        scope_verified: false
      },
      environment: "sandbox",
      patient_submission_enabled: false
    };

    if (action === ACTIONS.PREFLIGHT) {
      const statusSaved = await updateConnectionStatus(
        connection.id,
        "tested"
      );

      if (!statusSaved) {
        return auditedResponse(
          {
            success: false,
            action,
            stage: "connection_status_update",
            checks,
            error: "SATUSEHAT connectivity succeeded, but the connection test status could not be saved."
          },
          500,
          "failed",
          {
            stage: "connection_status_update",
            oauth_http_status: authResult.status,
            fhir_http_status: metadata.status,
            facility_scope_verified: false,
            connection_status_saved: false
          },
          connection.id
        );
      }

      return auditedResponse(
        {
          success: true,
          action,
          checks,
          next_operations: [
            "FHIR Patient search by identifier with an authorized synthetic test identifier",
            "Patient GET with an authorized synthetic IHS number",
            "Separate SATUSEHAT MPI integration requires its own documented endpoint and scope verification",
            "Patient writes remain disabled pending approval, profile validation and facility-scope verification"
          ]
        },
        200,
        "success",
        {
          oauth_http_status: authResult.status,
          fhir_http_status: metadata.status,
          facility_scope_verified: false,
          connection_status_saved: true
        },
        connection.id
      );
    }

    if (
      action === ACTIONS.PATIENT_SEARCH_BY_IDENTIFIER
    ) {
      const identifier = String(
        input.identifier ?? ""
      ).trim();

      const system = String(
        input.system ?? NIK_SYSTEM
      ).trim();

      if (
        !identifier ||
        !isPermittedIdentifierSystem(system)
      ) {
        return auditedResponse(
          {
            success: false,
            action,
            checks,
            error: "An authorized synthetic test identifier and documented SATUSEHAT identifier system are required."
          },
          400,
          "rejected",
          { reason: "invalid_identifier_request" },
          connection.id
        );
      }

      const query = new URLSearchParams({
        identifier: `${system}|${identifier}`
      });

      const result = await fhirRequest(
        `Patient?${query.toString()}`,
        authResult.token
      );

      return auditedResponse(
        {
          success: result.ok,
          action,
          checks,
          operation: {
            method: "GET",
            endpoint: `${FHIR}/Patient?identifier=[redacted]`,
            http_status: result.status,
            response_summary: summarizePatientResponse(
              result.body
            )
          }
        },
        result.ok ? 200 : 502,
        result.ok ? "success" : "failed",
        {
          http_status: result.status,
          response_minimized: true
        },
        connection.id
      );
    }

    const ihs = String(
      input.ihs_number ?? ""
    ).trim();

    if (!ihs) {
      return auditedResponse(
        {
          success: false,
          action,
          checks,
          error: "ihs_number is required."
        },
        400,
        "rejected",
        { reason: "missing_ihs_number" },
        connection.id
      );
    }

    const result = await fhirRequest(
      `Patient/${encodeURIComponent(ihs)}`,
      authResult.token
    );

    return auditedResponse(
      {
        success: result.ok,
        action,
        checks,
        operation: {
          method: "GET",
          endpoint: `${FHIR}/Patient/[IHS]`,
          http_status: result.status,
          response_summary: summarizePatientResponse(
            result.body
          )
        }
      },
      result.ok ? 200 : 502,
      result.ok ? "success" : "failed",
      {
        http_status: result.status,
        response_minimized: true
      },
      connection.id
    );
  } catch {
    const statusSaved = await updateConnectionStatus(
      connection.id,
      "error"
    );

    return auditedResponse(
      {
        success: false,
        action,
        stage: "connection",
        connection_status_saved: statusSaved,
        error: statusSaved
          ? "SATUSEHAT connectivity request failed."
          : "SATUSEHAT connectivity request failed, and the connection error status could not be saved."
      },
      502,
      "failed",
      {
        stage: "connection",
        connection_status_saved: statusSaved
      },
      connection.id
    );
  }
});