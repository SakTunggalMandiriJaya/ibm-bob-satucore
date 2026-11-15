import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STAGING = "https://api-satusehat-stg.dto.kemkes.go.id";
const PRODUCTION = "https://api-satusehat.kemkes.go.id";
const KFA_SYSTEM = "http://sys-ids.kemkes.go.id/kfa";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const bearer = req.headers.get("Authorization") ?? "";
  if (!bearer.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const userClient = createClient(url, anon, { global: { headers: { Authorization: bearer } } });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) return json({ error: "Invalid user session" }, 401);

  const admin = createClient(url, serviceKey);
  const body = await req.json().catch(() => ({}));
  const tenantId = String(body.tenant_id ?? "");
  if (!tenantId) return json({ error: "tenant_id is required" }, 400);

  const { data: membership, error: memberError } = await admin.from("tenant_members")
    .select("role,status").eq("tenant_id", tenantId).eq("user_id", auth.user.id).eq("status", "active").maybeSingle();
  if (memberError || !membership) return json({ error: "Active tenant membership required" }, 403);
  const action = String(body.action ?? "search");
  if (action === "sync_page" && !["tenant_admin","clinic_admin","data_manager"].includes(membership.role))
    return json({ error: "Catalogue synchronization requires tenant_admin, clinic_admin or data_manager role" }, 403);

  const { data: connections, error: connError } = await admin.from("satusehat_connections")
    .select("id,organization_id,environment,client_id_reference,client_secret_reference,token_url,api_base_url,authorization_scope,connection_status")
    .eq("tenant_id", tenantId);
  if (connError) return json({ error: "Could not resolve clinic SATUSEHAT connection" }, 500);
  const connection = (connections ?? []).find((c: any) => ["sandbox", "staging"].includes(String(c.environment).toLowerCase()) && c.connection_status === "active");
  if (!connection) return json({ error: "No active staging SATUSEHAT connection is configured for this clinic." }, 409);
  if (!connection.organization_id || !connection.client_id_reference || !connection.client_secret_reference)
    return json({ error: "Clinic connection is missing Organization or credential references." }, 409);
  const base = connection.api_base_url === PRODUCTION ? PRODUCTION : STAGING;
  if (base !== STAGING) return json({ error: "Production KFA access is disabled in this implementation." }, 403);

  const clientId = Deno.env.get(connection.client_id_reference);
  const clientSecret = Deno.env.get(connection.client_secret_reference);
  if (!clientId || !clientSecret) return json({ error: "The clinic credential references do not resolve to configured server secrets." }, 409);
  const tokenUrl = connection.token_url || `${STAGING}/oauth2/v1/accesstoken?grant_type=client_credentials`;
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret })
  });
  const tokenBody = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenBody.access_token) return json({ error: "SATUSEHAT OAuth2 authentication failed", upstream_status: tokenResponse.status }, 502);
  const headers = { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/json" };

  if (action === "search" || action === "sync_page") {
    const page = Math.max(1, Math.min(100000, Number(body.page ?? 1)));
    const size = Math.max(1, Math.min(100, Number(body.size ?? 50)));
    const params = new URLSearchParams({ page: String(page), size: String(size), product_type: String(body.product_type ?? "farmasi") });
    for (const key of ["keyword","farmalkes_type","template_code","packaging_code","from_date","to_date"])
      if (body[key]) params.set(key, String(body[key]));
    const upstream = await fetch(`${STAGING}/kfa-v2/products/all?${params}`, { headers });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) return json({ error: "KFA product search failed", upstream_status: upstream.status, response: result }, 502);
    if (action === "search") return json({ success: true, action, page, size, total: result?.total ?? null, items: result?.items?.data ?? result?.items ?? [] });

    const products = Array.isArray(result?.items?.data) ? result.items.data : Array.isArray(result?.items) ? result.items : [];
    const sourceVersion = "KFA-API-v2";
    const { data: source, error: sourceError } = await admin.from("terminology_sources").insert({
      source_key: "satusehat_kfa_v2", source_document: "SATUSEHAT KFA REST API v2",
      source_version: sourceVersion, source_sheet: "products/all", code_system_uri: KFA_SYSTEM,
      source_type: "api", domain_key: "kfa", approval_status: "unreviewed",
      source_row_count: products.length,
      metadata: { environment: connection.environment, satusehat_api_environment: "staging", page, size, total: result?.total ?? null, organization_id: connection.organization_id, fetched_at: new Date().toISOString() }
    }).select("id").single();
    if (sourceError) return json({ error: "Could not record KFA source provenance", detail: sourceError.message }, 500);

    const rows = products.filter((p: any) => p && p.kfa_code && p.name).map((p: any, i: number) => ({
      catalogue_key: "KFA",
      catalogue_version: sourceVersion,
      product_code: String(p.kfa_code),
      product_display: String(p.name),
      product_type: String(p.farmalkes_type?.name ?? p.farmalkes_type?.code ?? body.product_type ?? "unknown"),
      code_system_uri: KFA_SYSTEM,
      properties: p,
      source_id: source.id,
      source_sheet: "products/all",
      source_row_number: i + 1,
      active: p.active !== false,
      approval_status: "unreviewed"
    }));
    if (rows.length) {
      const { error: upsertError } = await admin.from("medication_products").upsert(rows, { onConflict: "catalogue_key,catalogue_version,product_code" });
      if (upsertError) return json({ error: "KFA page received but catalogue upsert failed", detail: upsertError.message, source_id: source.id }, 500);
    }
    await admin.from("reference_sync_logs").insert({
      tenant_id: tenantId, source_key: "satusehat_kfa_v2", status: "completed",
      records_received: products.length, records_processed: rows.length,
      metadata: { page, size, total: result?.total ?? null, source_id: source.id, environment: "staging" }
    });
    return json({ success: true, action, page, received: products.length, stored: rows.length, total: result?.total ?? null, source_id: source.id, approval: "unreviewed; human review required before clinical use" });
  }

  if (action === "detail") {
    const code = String(body.code ?? "").trim();
    if (!code) return json({ error: "code is required" }, 400);
    const params = new URLSearchParams({ identifier: String(body.identifier ?? "kfa"), code });
    const upstream = await fetch(`${STAGING}/kfa-v2/products?${params}`, { headers });
    const result = await upstream.json().catch(() => null);
    return json({ success: upstream.ok, upstream_status: upstream.status, result }, upstream.ok ? 200 : 502);
  }
  return json({ error: "Unsupported action. Use search, detail or sync_page." }, 400);
});
