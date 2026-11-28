import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, RefreshCw, Search, ShieldAlert, XCircle } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { Workspace } from "../lib/workflow";

type TransactionRow = {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  connection_id: string | null;
  fhir_resource_id: string | null;
  transaction_type: string;
  endpoint: string | null;
  http_method: string | null;
  request_reference: string | null;
  response_status: number | null;
  response_body: unknown;
  error_code: string | null;
  error_message_sanitized: string | null;
  idempotency_key: string | null;
  transaction_status: string;
  submitted_at: string | null;
  responded_at: string | null;
  created_at: string;
};

type Props = { workspace: Workspace };

const statuses = ["queued", "processing", "succeeded", "failed", "retry_pending", "cancelled", "reconciliation_required"];
const statusLabel = (value: string) => value.replaceAll("_", " ");
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : "—";

const palette: Record<string, { bg: string; color: string; icon: typeof CheckCircle2 }> = {
  succeeded: { bg: "#e8f7ef", color: "#16764a", icon: CheckCircle2 },
  failed: { bg: "#fff0f0", color: "#b42318", icon: XCircle },
  retry_pending: { bg: "#fff5e6", color: "#9a5b00", icon: AlertTriangle },
  reconciliation_required: { bg: "#fff0e8", color: "#a84416", icon: ShieldAlert },
  processing: { bg: "#edf4ff", color: "#245ca6", icon: Clock3 },
  queued: { bg: "#f1f3f6", color: "#526174", icon: Clock3 },
  cancelled: { bg: "#f1f3f6", color: "#526174", icon: XCircle },
};

export function TransactionMonitor({ workspace }: Props) {
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<TransactionRow | null>(null);
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setError("Database connection is not configured.");
      setLoading(false);
      return;
    }
    const db = supabase;
    setLoading(true);
    setError("");
    const [listResult, ...countResults] = await Promise.all([
      db.from("integration_transactions")
        .select("id,tenant_id,organization_id,connection_id,fhir_resource_id,transaction_type,endpoint,http_method,request_reference,response_status,response_body,error_code,error_message_sanitized,idempotency_key,transaction_status,submitted_at,responded_at,created_at")
        .eq("tenant_id", workspace.tenantId)
        .order("created_at", { ascending: false })
        .limit(100),
      ...statuses.map((value) => db.from("integration_transactions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", workspace.tenantId)
        .eq("transaction_status", value)),
      db.from("integration_transactions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", workspace.tenantId),
    ]);
    if (listResult.error) {
      setError(listResult.error.message);
      setRows([]);
    } else {
      setRows((listResult.data ?? []) as TransactionRow[]);
      setRefreshedAt(new Date().toISOString());
    }
    const next: Record<string, number> = {};
    statuses.forEach((value, index) => { next[value] = countResults[index]?.count ?? 0; });
    next.all = countResults[statuses.length]?.count ?? 0;
    setCounts(next);
    setLoading(false);
  }, [workspace.tenantId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => (status === "all" || row.transaction_status === status) &&
      (!needle || [row.transaction_type, row.transaction_status, row.id, row.request_reference ?? "", row.error_code ?? ""].join(" ").toLowerCase().includes(needle)));
  }, [rows, status, query]);

  const metricCards = [
    { label: "All transactions", value: counts.all ?? 0, icon: Activity },
    { label: "Succeeded", value: counts.succeeded ?? 0, icon: CheckCircle2 },
    { label: "Failed", value: counts.failed ?? 0, icon: XCircle },
    { label: "Needs attention", value: (counts.retry_pending ?? 0) + (counts.reconciliation_required ?? 0), icon: AlertTriangle },
  ];

  return (
    <section className="transaction-monitor">
      <style>{`
        .transaction-monitor{color:var(--text,#172033)}
        .tm-toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:18px 0}
        .tm-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}
        .tm-metric,.tm-panel,.tm-detail{background:var(--panel,#fff);border:1px solid var(--line,#e4e8ef);border-radius:14px}
        .tm-metric{padding:16px;display:flex;gap:12px;align-items:center}
        .tm-metric strong{display:block;font-size:24px;font-variant-numeric:tabular-nums}
        .tm-muted{color:var(--muted,#697586);font-size:12px}
        .tm-controls{display:flex;gap:8px;flex-wrap:wrap}
        .tm-input,.tm-select{border:1px solid var(--line,#dce2ea);border-radius:9px;padding:10px 12px;background:var(--panel,#fff);color:inherit;min-height:40px}
        .tm-search{position:relative}.tm-search input{padding-left:34px;min-width:240px}
        .tm-search svg{position:absolute;left:11px;top:12px;color:#7b8797}
        .tm-refresh{border:1px solid var(--line,#dce2ea);border-radius:9px;background:var(--panel,#fff);padding:9px 12px;display:flex;gap:8px;align-items:center;color:inherit;cursor:pointer}
        .tm-table-wrap{overflow:auto}.tm-table{width:100%;border-collapse:collapse;min-width:760px}
        .tm-table th,.tm-table td{padding:13px 14px;text-align:left;border-bottom:1px solid var(--line,#edf0f4);font-size:13px}
        .tm-table th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#697586)}
        .tm-row{cursor:pointer}.tm-row:hover{background:var(--surface,#f8f9fb)}
        .tm-status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:700;text-transform:capitalize;white-space:nowrap}
        .tm-empty{text-align:center;padding:48px 18px;color:var(--muted,#697586)}
        .tm-detail{padding:18px;margin-top:16px}
        .tm-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px}
        .tm-detail-grid label{display:block;font-size:11px;color:var(--muted,#697586);margin-bottom:5px}
        .tm-detail-grid strong{font-size:13px;overflow-wrap:anywhere}
        .tm-alert{padding:12px 14px;border-radius:10px;margin-top:14px;font-size:13px;line-height:1.5}
        .tm-alert.warning{background:#fff5e6;color:#875000;border:1px solid #f4d9a9}
        .tm-alert.danger{background:#fff0f0;color:#9d211b;border:1px solid #f2c5c5}
        .tm-close{float:right;border:0;background:transparent;cursor:pointer;color:inherit}
        @media(max-width:760px){.tm-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.tm-detail-grid{grid-template-columns:1fr}}
      `}</style>
      <div className="tm-metrics">
        {metricCards.map(({ label, value, icon: Icon }) => <div className="tm-metric" key={label}>
          <Icon size={20} color="#7156c8" />
          <div><strong>{value.toLocaleString()}</strong><div className="tm-muted">{label}</div></div>
        </div>)}
      </div>
      <div className="tm-toolbar">
        <div>
          <strong>Integration transactions</strong>
          <div className="tm-muted">Tenant-scoped records · latest 100 shown · counts reflect all records</div>
        </div>
        <div className="tm-controls">
          <label className="tm-search"><Search size={15} /><input className="tm-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search type, ID or reference" aria-label="Search transactions" /></label>
          <select className="tm-select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter transaction status">
            <option value="all">All statuses</option>
            {statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
          </select>
          <button className="tm-refresh" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} /> {loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>
      {error && <div className="tm-alert danger" role="alert">Unable to load transaction data: {error}</div>}
      <div className="tm-panel">
        <div className="tm-table-wrap">
          <table className="tm-table">
            <thead><tr><th>Operation</th><th>Status</th><th>HTTP</th><th>Submitted</th><th>Response / error</th></tr></thead>
            <tbody>
              {filtered.map((row) => {
                const style = palette[row.transaction_status] ?? palette.queued;
                const Icon = style.icon;
                return <tr className="tm-row" key={row.id} onClick={() => setSelected(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelected(row); }}>
                  <td><strong>{row.transaction_type}</strong><div className="tm-muted">{row.request_reference ?? row.id}</div></td>
                  <td><span className="tm-status" style={{ background: style.bg, color: style.color }}><Icon size={13} />{statusLabel(row.transaction_status)}</span></td>
                  <td>{row.response_status ?? "—"}</td>
                  <td>{dateLabel(row.submitted_at)}</td>
                  <td>{row.error_message_sanitized ?? (row.responded_at ? "Response recorded" : "Awaiting response")}</td>
                </tr>;
              })}
            </tbody>
          </table>
          {!loading && !filtered.length && <div className="tm-empty"><Activity size={28} /><h3>{rows.length ? "No matching transactions" : "No submission transactions"}</h3><p>{rows.length ? "Change the search or status filter." : "Only actual backend requests and responses appear here. No demo activity is counted as a submission."}</p></div>}
          {loading && <div className="tm-empty">Loading tenant transactions…</div>}
        </div>
      </div>
      {selected && <div className="tm-detail" aria-live="polite">
        <button className="tm-close" type="button" onClick={() => setSelected(null)} aria-label="Close transaction details">✕</button>
        <strong>Transaction details</strong><div className="tm-muted">{selected.id}</div>
        <div className="tm-detail-grid">
          <div><label>Operation</label><strong>{selected.transaction_type}</strong></div>
          <div><label>Status</label><strong>{statusLabel(selected.transaction_status)}</strong></div>
          <div><label>HTTP method / endpoint</label><strong>{selected.http_method ?? "—"} {selected.endpoint ?? ""}</strong></div>
          <div><label>HTTP response</label><strong>{selected.response_status ?? "No response status recorded"}</strong></div>
          <div><label>FHIR resource reference</label><strong>{selected.fhir_resource_id ?? "—"}</strong></div>
          <div><label>Organization reference</label><strong>{selected.organization_id ?? "—"}</strong></div>
          <div><label>Created</label><strong>{dateLabel(selected.created_at)}</strong></div>
          <div><label>Submitted</label><strong>{dateLabel(selected.submitted_at)}</strong></div>
          <div><label>Responded</label><strong>{dateLabel(selected.responded_at)}</strong></div>
          <div><label>Error code</label><strong>{selected.error_code ?? "—"}</strong></div>
          <div><label>Request reference</label><strong>{selected.request_reference ?? "—"}</strong></div>
          <div><label>Idempotency key</label><strong>{selected.idempotency_key ?? "—"}</strong></div>
        </div>
        {selected.error_message_sanitized && <div className={selected.transaction_status === "failed" ? "tm-alert danger" : "tm-alert warning"}><strong>Sanitized backend message</strong><br />{selected.error_message_sanitized}</div>}
        {selected.transaction_status === "retry_pending" && <div className="tm-alert warning"><strong>External outcome unknown.</strong> Do not retry automatically. Reconcile the Patient in SATUSEHAT before any further submission attempt.</div>}
        {selected.transaction_status === "reconciliation_required" && <div className="tm-alert warning"><strong>Manual reconciliation required.</strong> SATUSEHAT may have accepted the request while local persistence failed. Verify the external record before taking action.</div>}
        {selected.transaction_status === "failed" && <div className="tm-alert danger"><strong>Submission failed.</strong> Review the sanitized error and correct the underlying issue before an authorized retry workflow.</div>}
        <div className="tm-muted" style={{ marginTop: 12 }}>Response payload is intentionally not rendered here to avoid exposing patient identifiers or sensitive clinical data.</div>
      </div>}
      <div className="tm-muted" style={{ marginTop: 12 }}>Last refreshed: {dateLabel(refreshedAt)}</div>
    </section>
  );
}
