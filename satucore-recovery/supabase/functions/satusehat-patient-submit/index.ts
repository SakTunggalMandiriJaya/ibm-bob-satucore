import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};
const reply = (body: unknown, status=200) => Response.json(body,{status,headers:CORS});
const safeJson = async (r: Response) => {
  const raw = await r.text();
  try { return JSON.parse(raw); } catch { return { raw_body_excerpt: raw.slice(0,2000) }; }
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
  if (req.method !== "POST") return reply({success:false,error:"POST required"},405);
  const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return reply({success:false,stage:"configuration",error:"Supabase runtime configuration missing"},500);
  const authHeader=req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({success:false,error:"Authentication required"},401);
  const userClient=createClient(url,anon,{global:{headers:{Authorization:authHeader}}});
  const {data:{user},error:userError}=await userClient.auth.getUser();
  if (userError || !user) return reply({success:false,error:"Invalid user session"},401);
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const input=await req.json().catch(()=>null);
  if (!input || typeof input!=="object") return reply({success:false,error:"JSON request body required"},400);
  const tenantId=String(input.tenant_id??"").trim();
  const resourceId=String(input.fhir_resource_id??"").trim();
  const approvalId=String(input.approval_id??"").trim();
  const idempotencyKey=String(input.idempotency_key??"").trim();
  if (!tenantId || !resourceId || !approvalId || !idempotencyKey) return reply({success:false,error:"tenant_id, fhir_resource_id, approval_id and idempotency_key are required"},400);
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(resourceId) || !/^[0-9a-f-]{36}$/i.test(approvalId)) return reply({success:false,error:"Invalid identifier format"},400);
  if (idempotencyKey.length<16 || idempotencyKey.length>200) return reply({success:false,error:"idempotency_key must be 16-200 characters"},400);
  const {data:member,error:memberErr}=await admin.from("tenant_members").select("role,status").eq("tenant_id",tenantId).eq("user_id",user.id).maybeSingle();
  if (memberErr) return reply({success:false,stage:"authorization",error:"Could not verify tenant membership"},500);
  if (!member || member.status!=="active" || !["tenant_admin","clinic_admin","data_manager","submitter"].includes(member.role)) return reply({success:false,stage:"authorization",error:"Active authorized tenant membership required"},403);
  const {data:resource,error:resourceErr}=await admin.from("fhir_resources").select("id,tenant_id,patient_id,resource_type,resource_id,fhir_version,profile_urls,payload,payload_hash,status").eq("id",resourceId).eq("tenant_id",tenantId).maybeSingle();
  if (resourceErr || !resource) return reply({success:false,stage:"resource",error:"FHIR resource not found in this tenant"},404);
  const {data:patient,error:patientErr}=await admin.from("patients").select("id,tenant_id,organization_id").eq("id",resource.patient_id).eq("tenant_id",tenantId).maybeSingle();
  if (patientErr || !patient?.organization_id) return reply({success:false,stage:"facility_scope",error:"Patient facility ownership could not be verified"},409);
  if (member.role!=="tenant_admin") {
    const {data:assignment,error:assignmentErr}=await admin.from("organization_members").select("id").eq("tenant_id",tenantId).eq("organization_id",patient.organization_id).eq("user_id",user.id).eq("status","active").maybeSingle();
    if (assignmentErr || !assignment) return reply({success:false,stage:"authorization",error:"User is not assigned to the Patient's facility"},403);
  }
  if (resource.resource_type!=="Patient" || resource.payload?.resourceType!=="Patient" || resource.fhir_version!=="4.0.1" || resource.status!=="approved") return reply({success:false,stage:"resource",error:"Only FHIR R4 Patient resources can be submitted by this endpoint"},409);
  const actualHash=String(resource.payload_hash??"");
  if (!/^[0-9a-f]{64}$/.test(actualHash)) return reply({success:false,stage:"integrity",error:"Stored FHIR payload hash is invalid"},409);
  const computedHash=await sha256(stableJson(resource.payload));
  if (computedHash!==actualHash) return reply({success:false,stage:"integrity",error:"Actual FHIR payload differs from its stored integrity hash"},409);
  const {data:approval,error:approvalErr}=await admin.from("submission_approvals").select("id,tenant_id,fhir_resource_id,decision,approved_by,approved_payload_hash,decided_at").eq("id",approvalId).eq("tenant_id",tenantId).eq("fhir_resource_id",resourceId).maybeSingle();
  if (approvalErr || !approval) return reply({success:false,stage:"approval",error:"Exact-resource submission approval not found"},404);
  if (approval.decision!=="approved" || !approval.approved_by || approval.approved_payload_hash!==actualHash) return reply({success:false,stage:"approval",error:"Submission approval is missing, revoked, or does not match the exact FHIR payload"},409);
  const {data:approver}=await admin.from("tenant_members").select("role,status").eq("tenant_id",tenantId).eq("user_id",approval.approved_by).maybeSingle();
  if (!approver || approver.status!=="active" || !["tenant_admin","clinic_admin","reviewer"].includes(approver.role)) return reply({success:false,stage:"approval",error:"Approver is no longer an active authorized tenant member"},403);
  if (approver.role!=="tenant_admin") {
    const {data:approverAssignment,error:approverAssignmentErr}=await admin.from("organization_members").select("id").eq("tenant_id",tenantId).eq("organization_id",patient.organization_id).eq("user_id",approval.approved_by).eq("status","active").maybeSingle();
    if (approverAssignmentErr || !approverAssignment) return reply({success:false,stage:"approval",error:"Approver is not assigned to the Patient's facility"},403);
  }
  const {data:connections,error:connErr}=await admin.from("satusehat_connections").select("id,tenant_id,organization_id,environment,client_id_reference,client_secret_reference,token_url,api_base_url,connection_status,authorization_scope").eq("tenant_id",tenantId).eq("environment","sandbox");
  if (connErr || !connections || connections.length!==1) return reply({success:false,stage:"configuration",error:"Exactly one tenant Sandbox connection is required"},409);
  const connection=connections[0];
  if (connection.organization_id!==patient.organization_id) return reply({success:false,stage:"facility_scope",error:"Sandbox connection Organization does not match the Patient's owning facility"},409);
  const {data:org,error:orgErr}=await admin.from("organizations").select("id,tenant_id,satusehat_organization_id,active").eq("id",connection.organization_id).eq("tenant_id",tenantId).maybeSingle();
  if (orgErr || !org?.active || !org.satusehat_organization_id) return reply({success:false,stage:"facility_scope",error:"Active facility and SATUSEHAT Organization ID are required"},409);
  if (connection.connection_status!=="tested") return reply({success:false,stage:"connection_preflight",error:"Run and pass the Sandbox connectivity preflight before Patient submission"},409);
  const verifiedScopesRaw=Deno.env.get("SATUSEHAT_VERIFIED_FACILITY_SCOPES") ?? "";
  let verifiedScopes:Record<string,string[]>={};
  try { verifiedScopes=JSON.parse(verifiedScopesRaw); } catch { verifiedScopes={}; }
  if (!Array.isArray(verifiedScopes[tenantId]) || !verifiedScopes[tenantId].includes(org.satusehat_organization_id)) return reply({success:false,stage:"facility_scope",error:"This tenant and SATUSEHAT Organization ID are not in the backend-verified Sandbox facility-scope allowlist"},409);
  if (resource.payload?.managingOrganization?.identifier?.value && resource.payload.managingOrganization.identifier.value!==org.satusehat_organization_id) return reply({success:false,stage:"facility_scope",error:"FHIR Patient managingOrganization does not match the authorized facility"},409);
  const clientId=Deno.env.get(connection.client_id_reference);
  const clientSecret=Deno.env.get(connection.client_secret_reference);
  if (!clientId || !clientSecret) return reply({success:false,stage:"credentials",error:"Configured Sandbox credential references are not present in Edge Function Secrets"},409);
  const tokenUrl=connection.token_url;
  const apiBase=connection.api_base_url?.replace(/\/+$/,"");
  let tokenParsed:URL,apiParsed:URL; try { tokenParsed=new URL(tokenUrl); apiParsed=new URL(apiBase); } catch { return reply({success:false,stage:"configuration",error:"Invalid Sandbox URL"},409); }
  if (!tokenUrl || !apiBase || tokenParsed.protocol!=="https:" || apiParsed.protocol!=="https:" || tokenParsed.hostname!=="api-satusehat-stg.dto.kemkes.go.id" || apiParsed.hostname!=="api-satusehat-stg.dto.kemkes.go.id" || tokenParsed.pathname!=="/oauth2/v1/accesstoken" || (apiParsed.pathname!=="" && apiParsed.pathname!=="/fhir-r4/v1") || tokenParsed.searchParams.get("grant_type")!=="client_credentials") return reply({success:false,stage:"configuration",error:"Only the documented SATUSEHAT Sandbox OAuth2 and FHIR API paths are permitted"},409);
  const endpoint=apiBase.endsWith("/fhir-r4/v1") ? apiBase+"/Patient" : apiBase+"/fhir-r4/v1/Patient";
  const {data:prior,error:priorErr}=await admin.from("integration_transactions").select("id,transaction_status,response_status,response_body,error_code,error_message_sanitized,fhir_resource_id,transaction_type").eq("tenant_id",tenantId).eq("idempotency_key",idempotencyKey).maybeSingle();
  if (priorErr) return reply({success:false,stage:"transaction",error:"Could not check idempotency ledger"},500);
  if (prior) {
    if (prior.fhir_resource_id!==resourceId || prior.transaction_type!=="patient_create") return reply({success:false,stage:"idempotency",error:"Idempotency key already belongs to a different FHIR resource or transaction type. No new submission was sent."},409);
    return reply({success:prior.transaction_status==="succeeded",replayed:true,transaction:prior},prior.transaction_status==="succeeded"?200:409);
  }
  const {data:tx,error:txErr}=await admin.from("integration_transactions").insert({
    tenant_id:tenantId,organization_id:org.id,connection_id:connection.id,fhir_resource_id:resourceId,
    transaction_type:"patient_create",endpoint:"/fhir-r4/v1/Patient",http_method:"POST",
    request_reference:resource.resource_id??resource.id,idempotency_key:idempotencyKey,
    transaction_status:"processing",submitted_at:new Date().toISOString()
  }).select("id").single();
  if (txErr || !tx) return reply({success:false,stage:"transaction",error:"Could not atomically claim this submission; check for an existing transaction before retrying"},409);
  const finish=async(status:string,extra:Record<string,unknown>)=>{
    const {error}=await admin.from("integration_transactions").update({...extra,transaction_status:status,responded_at:new Date().toISOString()}).eq("id",tx.id).eq("tenant_id",tenantId);
    if(error) throw new Error("transaction_persistence_failed");
  };
  let patientRequestStarted=false;
  let confirmedPatientId:string|null=null;
  let confirmedResponseStatus:number|null=null;
  let confirmedResponseBody:Record<string,unknown>|null=null;
  const markReconciliation=async()=>{
    if(!confirmedPatientId || !confirmedResponseBody || confirmedResponseStatus===null) return false;
    try {
      const {error}=await admin.from("integration_transactions").update({
        transaction_status:"reconciliation_required",
        response_status:confirmedResponseStatus,
        response_body:confirmedResponseBody,
        request_reference:confirmedPatientId,
        error_code:"post_submission_persistence_failure",
        error_message_sanitized:"SATUSEHAT confirmed Patient creation; local persistence requires reconciliation",
        responded_at:new Date().toISOString()
      }).eq("id",tx.id).eq("tenant_id",tenantId);
      return !error;
    } catch {
      return false;
    }
  };
  try {
    const tokenResponse=await fetch(tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret}),redirect:"error",signal:AbortSignal.timeout(20000)});
    const tokenBody=await safeJson(tokenResponse);
    if (!tokenResponse.ok || !tokenBody.access_token) {
      await finish("failed",{response_status:tokenResponse.status,error_code:"oauth_failed",error_message_sanitized:"SATUSEHAT OAuth2 token request failed"});
      return reply({success:false,stage:"oauth",http_status:tokenResponse.status,transaction_id:tx.id,error:"Sandbox OAuth2 failed; no Patient request was sent"},502);
    }
    patientRequestStarted=true;
    const response=await fetch(endpoint,{method:"POST",headers:{Authorization:"Bearer "+String(tokenBody.access_token), "Content-Type":"application/fhir+json",Accept:"application/fhir+json"},body:JSON.stringify(resource.payload),redirect:"error",signal:AbortSignal.timeout(30000)});
    const responseBody=await safeJson(response);
    const isFhirSuccess=response.ok && responseBody?.resourceType==="Patient" && typeof responseBody?.id==="string";
    const minimized={resourceType:responseBody?.resourceType??null,id:responseBody?.id??null,issue:Array.isArray(responseBody?.issue)?responseBody.issue.slice(0,10).map((x:any)=>({severity:x?.severity??null,code:x?.code??null})):undefined,meta:responseBody?.meta??undefined};
    if (isFhirSuccess) {
      confirmedPatientId=responseBody.id;
      confirmedResponseStatus=response.status;
      confirmedResponseBody=minimized;
      await finish("succeeded",{response_status:response.status,response_body:minimized,request_reference:responseBody.id,error_code:null,error_message_sanitized:null});
      const {error:resourceUpdateError}=await admin.from("fhir_resources").update({status:"submitted",resource_id:responseBody.id}).eq("id",resourceId).eq("tenant_id",tenantId);
      const {error:connectionUpdateError}=await admin.from("satusehat_connections").update({connection_status:"tested",last_tested_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",connection.id).eq("tenant_id",tenantId);
      const {error:auditError}=await admin.from("audit_logs").insert({tenant_id:tenantId,actor_user_id:user.id,action:"satusehat.patient_create",entity_type:"integration_transaction",entity_id:tx.id,outcome:"success",metadata:{environment:"sandbox",http_status:response.status,fhir_resource_id:resourceId,returned_ihs_number:responseBody.id,approval_id:approvalId}});
      if(resourceUpdateError || connectionUpdateError || auditError) {
        await markReconciliation();
        return reply({success:false,stage:"reconciliation_required",satusehat_created:true,http_status:response.status,transaction_id:tx.id,ihs_number:responseBody.id,error:"SATUSEHAT returned a Patient id, but local post-submission persistence needs reconciliation"},500);
      }
      return reply({success:true,stage:"submitted",http_status:response.status,transaction_id:tx.id,ihs_number:responseBody.id,response:minimized},200);
    }
    await finish("failed",{response_status:response.status,response_body:minimized,error_code:"fhir_create_rejected",error_message_sanitized:"SATUSEHAT rejected the Patient create request"});
    await admin.from("audit_logs").insert({tenant_id:tenantId,actor_user_id:user.id,action:"satusehat.patient_create",entity_type:"integration_transaction",entity_id:tx.id,outcome:"failure",metadata:{environment:"sandbox",http_status:response.status,fhir_resource_id:resourceId,approval_id:approvalId}});
    return reply({success:false,stage:"satusehat_response",http_status:response.status,transaction_id:tx.id,response:minimized,error:"SATUSEHAT did not confirm Patient creation"},502);
  } catch {
    if(confirmedPatientId) {
      await markReconciliation();
      return reply({success:false,stage:"reconciliation_required",satusehat_created:true,http_status:confirmedResponseStatus,transaction_id:tx.id,ihs_number:confirmedPatientId,error:"SATUSEHAT confirmed Patient creation; local persistence requires reconciliation"},500);
    }
    if (!patientRequestStarted) {
      await finish("failed",{error_code:"oauth_network_error",error_message_sanitized:"Sandbox OAuth2 network request failed; no Patient create request was sent"});
      await admin.from("audit_logs").insert({tenant_id:tenantId,actor_user_id:user.id,action:"satusehat.patient_create",entity_type:"integration_transaction",entity_id:tx.id,outcome:"failure",metadata:{environment:"sandbox",stage:"oauth",fhir_resource_id:resourceId,approval_id:approvalId}});
      return reply({success:false,stage:"oauth",transaction_id:tx.id,error:"Sandbox OAuth2 network request failed; no Patient request was sent"},502);
    }
    await finish("retry_pending",{error_code:"network_outcome_unknown",error_message_sanitized:"Network outcome unknown; do not automatically retry until SATUSEHAT is checked for the Patient"});
    await admin.from("audit_logs").insert({tenant_id:tenantId,actor_user_id:user.id,action:"satusehat.patient_create",entity_type:"integration_transaction",entity_id:tx.id,outcome:"pending",metadata:{environment:"sandbox",fhir_resource_id:resourceId,approval_id:approvalId}});
    return reply({success:false,stage:"network",transaction_id:tx.id,error:"Submission outcome is unknown. Check SATUSEHAT before any retry."},502);
  }
});