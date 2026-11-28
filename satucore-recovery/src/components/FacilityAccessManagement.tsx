import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, Shield, UserPlus, XCircle } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { Workspace } from "../lib/workflow";

type Facility = { id: string; name: string };
type Member = { user_id: string; role: string; status: string };
type Assignment = { id: string; user_id: string; organization_id: string; status: "active" | "inactive" | "revoked"; updated_at: string };

export function FacilityAccessManagement({ workspace }: { workspace: Workspace }) {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [userId, setUserId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [orgResult, memberResult, assignmentResult] = await Promise.all([
      supabase.from("organizations").select("id,name").eq("tenant_id", workspace.tenantId).eq("active", true).order("name"),
      supabase.from("tenant_members").select("user_id,role,status").eq("tenant_id", workspace.tenantId).eq("status", "active").order("user_id"),
      supabase.from("organization_members").select("id,user_id,organization_id,status,updated_at").eq("tenant_id", workspace.tenantId).order("updated_at", { ascending: false })
    ]);
    const failure = orgResult.error ?? memberResult.error ?? assignmentResult.error;
    if (failure) setMessage("Access data could not be loaded: " + failure.message);
    else {
      setFacilities(orgResult.data ?? []);
      setMembers(memberResult.data ?? []);
      setAssignments(assignmentResult.data ?? []);
      setMessage("");
    }
    setLoading(false);
  }, [workspace.tenantId]);

  useEffect(() => { void load(); }, [load]);

  const assign = async () => {
    if (!supabase || !userId || !organizationId) return;
    setBusy(true);
    setMessage("");
    const { error } = await supabase.from("organization_members").upsert({
      tenant_id: workspace.tenantId,
      user_id: userId,
      organization_id: organizationId,
      status: "active",
      assigned_by: workspace.userId
    }, { onConflict: "tenant_id,user_id,organization_id" });
    if (error) setMessage("Assignment was not saved: " + error.message);
    else {
      setMessage("Facility access assigned. The user can access this facility after refreshing their session.");
      setUserId("");
      await load();
    }
    setBusy(false);
  };

  const changeStatus = async (assignment: Assignment, status: "inactive" | "revoked") => {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.from("organization_members")
      .update({ status }).eq("id", assignment.id).eq("tenant_id", workspace.tenantId);
    if (error) setMessage("Access status was not changed: " + error.message);
    else {
      setMessage(status === "revoked" ? "Facility access revoked." : "Facility access suspended.");
      await load();
    }
    setBusy(false);
  };

  if (workspace.role !== "tenant_admin") return <div className="empty-state"><Shield size={28}/><h3>Tenant administrator access required</h3><p>Only a tenant administrator can assign or revoke facility access. Your existing facility access remains unchanged.</p></div>;

  return <section>
    <div className="page-title"><div><div className="eyebrow">TENANT GOVERNANCE · OPTION B</div><h1>Facility access</h1><p>Assign each active tenant member to one or more Organizations. No assignment means no facility access.</p></div><button className="secondary-btn" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={15}/> Refresh</button></div>
    <div className="panel settings-panel">
      <div className="panel-head"><div><h3>Assign facility access</h3><p>Only active tenant members and active Organizations are eligible.</p></div><UserPlus size={20}/></div>
      <div className="settings-line" style={{ gap: 12, flexWrap: "wrap" }}>
        <label style={{ flex: "1 1 260px" }}>Tenant member<select value={userId} onChange={e => setUserId(e.target.value)} disabled={busy || loading}><option value="">Select a member</option>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.user_id} · {m.role}</option>)}</select></label>
        <label style={{ flex: "1 1 220px" }}>Facility / Organization<select value={organizationId} onChange={e => setOrganizationId(e.target.value)} disabled={busy || loading}><option value="">Select a facility</option>{facilities.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <button className="primary-btn" onClick={() => void assign()} disabled={busy || loading || !userId || !organizationId}><UserPlus size={15}/> {busy ? "Saving…" : "Assign access"}</button>
      </div>
      {(!members.length || !facilities.length) && !loading && <p className="source-correction-blocker">Cannot assign access until this tenant has at least one active member and one active Organization.</p>}
    </div>
    <div className="panel table-panel">
      <div className="panel-head"><div><h3>Current assignments</h3><p>A user may have multiple facility assignments. Revocation does not delete the audit history.</p></div><span className="status-chip">{assignments.filter(a => a.status === "active").length} ACTIVE</span></div>
      {loading ? <div className="validation-prompt"><RefreshCw size={18}/> Loading facility access…</div> : assignments.length ? <div className="table-wrap"><table><thead><tr><th>User ID</th><th>Facility</th><th>Status</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{assignments.map(a => <tr key={a.id}><td>{a.user_id}</td><td>{facilities.find(f => f.id === a.organization_id)?.name ?? a.organization_id}</td><td><span className={a.status === "active" ? "patient-save-badge saved" : "status-chip"}>{a.status.toUpperCase()}</span></td><td>{new Date(a.updated_at).toLocaleString()}</td><td>{a.status === "active" ? <div className="action-row"><button className="secondary-btn" disabled={busy} onClick={() => void changeStatus(a,"inactive")}><XCircle size={14}/> Suspend</button><button className="secondary-btn" disabled={busy} onClick={() => void changeStatus(a,"revoked")}><XCircle size={14}/> Revoke</button></div> : <button className="secondary-btn" disabled={busy} onClick={() => { setUserId(a.user_id); setOrganizationId(a.organization_id); }}>Reassign</button>}</td></tr>)}</tbody></table></div> : <div className="empty-state"><CheckCircle2 size={26}/><h3>No facility assignments</h3><p>Ordinary users have no facility access until a tenant administrator explicitly assigns them.</p></div>}
    </div>
    {message && <div className="notice" role="status">{message}</div>}
    <div className="callout"><Shield size={18}/><span><b>Authorization behavior</b><small>Tenant administrators can see all Organizations in their tenant. Other users can see only assigned facilities. This screen does not grant tenant-wide access and does not modify user roles.</small></span></div>
  </section>;
}
