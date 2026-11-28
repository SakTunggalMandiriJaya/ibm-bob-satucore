import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import Papa from "papaparse";
import { supabase, isSupabaseConfigured } from "./lib/supabase";
import {
  getWorkspace,
  getPatientMappingIssues,
  normalizePatient,
  persistImport,
  persistMappingReview,
  persistPatient,
  getPatientDraft,
  getPatientDraftRevisions,
  savePatientDraft,
  validatePatientDraft,

  restorePatientDraftValidation,
  validatePatientLocally,
  persistSourceRowCorrection,
  createPatientIdentityReviewRequest,
  PatientMrnConflictError,
  restoreLatestImport,
} from "./lib/workflow";
import type { Workspace, PatientDraftRecord } from "./lib/workflow";
import { PatientCorrectionReviewQueue } from "./components/PatientCorrectionReviewQueue";
import { PatientIdentityReviewQueue } from "./components/PatientIdentityReviewQueue";
import { TransactionMonitor } from "./components/TransactionMonitor";
import { FacilityAccessManagement } from "./components/FacilityAccessManagement";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Bell,
  Check,
  CircleAlert,
  ClipboardCheck,
  CloudUpload,
  Database,
  FileSpreadsheet,
  Fingerprint,
  GitBranch,
  HeartPulse,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Table2,
  Upload,
  UserRound,
  Users,
  X,
} from "lucide-react";

type Row = Record<string, string>;
type Field = {
  source: string;
  target: string;
  confidence: number;
  approved: boolean;
};
const targets = [
  "identifier",
  "national_identifier",
  "name",
  "birthDate",
  "gender",
  "telecom",
  "address.city",
  "address",
];
const demo: Row[] = [
  {
    patient_no: "MRN-10021",
    patient_name: "Siti Rahmawati",
    dob: "1988-04-12",
    sex: "F",
    phone: "081234567890",
    city: "Jakarta Selatan",
  },
  {
    patient_no: "MRN-10022",
    patient_name: "Budi Santoso",
    dob: "1975-11-03",
    sex: "M",
    phone: "081298765432",
    city: "Tangerang",
  },
  {
    patient_no: "MRN-10023",
    patient_name: "Dewi Anggraini",
    dob: "1992-07-21",
    sex: "F",
    phone: "",
    city: "Bekasi",
  },
  {
    patient_no: "MRN-10024",
    patient_name: "Andi Pratama",
    dob: "2001-02-15",
    sex: "M",
    phone: "081377712345",
    city: "Depok",
  },
];
const guess = (s: string): Field => {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rules: [RegExp, string, number][] = [
    [
      /^(mrn|medicalrecord|patientno|patientid|nomorrm|norm)$/,
      "identifier",
      0.96,
    ],
    [
      /^(nik|nationalid|nationalidentifier|nomorindukkependudukan|niktp|noktp|ktp)$/,
      "national_identifier",
      0.99,
    ],
    [
      /^(name|patientname|fullname|nama|namapasien|namalengkap)$/,
      "name",
      0.98,
    ],
    [
      /^(dob|birthdate|dateofbirth|tanggallahir)$/,
      "birthDate",
      0.98,
    ],
    [
      /^(sex|gender|jeniskelamin)$/,
      "gender",
      0.97,
    ],
    [
      /^(phone|mobile|telecom|telephone|nohp|handphone|nomorhp|phonenumber)$/,
      "telecom",
      0.94,
    ],
    [
      /^(city|kota|kabupaten|regency)$/,
      "address.city",
      0.95,
    ],
    [
      /^(address|alamat|alamatlengkap)$/,
      "address",
      0.82,
    ],
  ];
  const hit = rules.find(([re]) => re.test(k));
  return {
    source: s,
    target: hit?.[1] ?? "—",
    confidence: hit?.[2] ?? 0,
    approved: false,
  };
};
function getReadableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts = [
      value.message,
      value.details,
      value.hint,
      value.code ? `Code: ${String(value.code)}` : null,
    ]
      .filter((part) => typeof part === "string" && part.trim())
      .map((part) => String(part).trim());
    if (parts.length) return [...new Set(parts)].join(" · ");
    try {
      return JSON.stringify(error);
    } catch {
      return "The database returned an unreadable error object.";
    }
  }
  return String(error ?? "Unknown persistence error");
}

function validateSourceBirthDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "Date of birth is empty.";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return `Date of birth "${raw}" must use YYYY-MM-DD format.`;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    year >= 1 &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  if (!isRealDate) {
    return `Date of birth "${raw}" is not a valid calendar date. Month must be 01–12 and the day must exist in that month.`;
  }
  return null;
}

function App() {
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [page, setPage] = useState("Overview"),
    [rows, setRows] = useState<Row[]>([]),
    [filename, setFilename] = useState(""),
    [fields, setFields] = useState<Field[]>([]),
    [active, setActive] = useState("SCAN"),
    [notice, setNotice] = useState(""),
    [session, setSession] = useState<any>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [importId, setImportId] = useState<string | null>(null),
    [sourceFile, setSourceFile] = useState<File | null>(null),
    [savedPatients, setSavedPatients] = useState<Record<number, {
      patientId: string;
      resourceId?: string;
      mrn?: string;
    }>>({}),
    [savedPatientStatusLoadedFor, setSavedPatientStatusLoadedFor] = useState<string | null>(null),
    [patientDrafts, setPatientDrafts] = useState<Record<number, PatientDraftRecord>>({}),
    [draftRevisions, setDraftRevisions] = useState<Record<number, Record<string, unknown>[]>>({}),
    [persisting, setPersisting] = useState(false),
    [saveFeedback, setSaveFeedback] = useState<{
      rowIndex: number;
      kind: "invalid_date" | "mrn_conflict" | "other";
      title: string;
      message: string;
      action: string;
    } | null>(null),
    [sandboxResult, setSandboxResult] = useState<any>(null),
    [opsRows, setOpsRows] = useState<any[]>([]),
    [termQuery, setTermQuery] = useState(""),
    [termRows, setTermRows] = useState<any[]>([]),
    [termBusy, setTermBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const validationRunRef = useRef(false);
  // Saved state belongs to a source row, never to the workflow globally.
  const savedPatientStatusKey = workspace && importId ? `${workspace.tenantId}:${importId}` : null;
  const savedPatientStatusesReady = !supabase || !savedPatientStatusKey || savedPatientStatusLoadedFor === savedPatientStatusKey;
  useEffect(() => {
    if (!supabase || !workspace || !importId) {
      setSavedPatients({});
      setSavedPatientStatusLoadedFor(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { data: sourceRows, error: sourceError } = await supabase
          .from("import_rows")
          .select("id,row_number,original_data")
          .eq("tenant_id", workspace.tenantId)
          .eq("import_id", importId)
          .order("row_number", { ascending: true });
        if (sourceError) throw sourceError;
        const references = (sourceRows ?? []).map((r: any) => ({
          rowNumber: Number(r.row_number),
          reference: `import_rows/${r.id}`,
          mrn: String(r.original_data?.mrn ?? r.original_data?.patient_no ?? ""),
        }));
        if (!references.length) {
          if (alive) {
            setSavedPatients({});
            setSavedPatientStatusLoadedFor(`${workspace.tenantId}:${importId}`);
          }
          return;
        }
        const { data: patients, error: patientError } = await supabase
          .from("patients")
          .select("id,source_record_reference,local_mrn")
          .eq("tenant_id", workspace.tenantId)
          .in("source_record_reference", references.map(r => r.reference));
        if (patientError) throw patientError;
        const restored: Record<number, { patientId: string; mrn?: string }> = {};
        for (const patient of patients ?? []) {
          const source = references.find(r => r.reference === patient.source_record_reference);
          if (source) restored[source.rowNumber - 1] = {
            patientId: patient.id,
            mrn: patient.local_mrn ?? source.mrn,
          };
        }
        if (alive) {
          setSavedPatients(restored);
          setSavedPatientStatusLoadedFor(`${workspace.tenantId}:${importId}`);
        }
      } catch (error) {
        if (alive) {
          setNotice("Could not restore individual Patient save statuses: " + (error as Error).message);
          setSavedPatientStatusLoadedFor(`${workspace.tenantId}:${importId}`);
        }
      }
    })();
    return () => { alive = false; };
  }, [workspace, importId]);
  const [selected, setSelected] = useState(0);
  const [patientRecordsTab, setPatientRecordsTab] = useState<"records" | "identity">("records");
  const [fhirViewTab, setFhirViewTab] = useState<"summary" | "json">("summary");
  // Patient Drafts are separate from canonical Patient records and restored per tenant/import.
  useEffect(() => {
    if (!workspace || !importId || !rows.length) {
      setPatientDrafts({});
      setDraftRevisions({});
      return;
    }
    let alive = true;
    (async () => {
      try {
        const entries = await Promise.all(rows.map(async (_row, index) => {
          const draft = await getPatientDraft({ workspace, importId, rowNumber: index + 1 });
          return [index, draft] as const;
        }));
        if (!alive) return;
        const restored: Record<number, PatientDraftRecord> = {};
        for (const [index, draft] of entries) if (draft) restored[index] = draft;
        setPatientDrafts(restored);
      } catch (error) {
        if (alive) setNotice("Could not restore Patient Drafts: " + getReadableError(error));
      }
    })();
    return () => { alive = false; };
  }, [workspace, importId, rows]);

  useEffect(() => {
    const draft = patientDrafts[selected];
    if (!workspace || !draft) {
      setDraftRevisions(current => ({ ...current, [selected]: [] }));
      return;
    }
    let alive = true;
    getPatientDraftRevisions({ workspace, draftId: draft.id })
      .then(revisions => { if (alive) setDraftRevisions(current => ({ ...current, [selected]: revisions })); })
      .catch(error => { if (alive) setNotice("Could not load Patient Draft revision history: " + getReadableError(error)); });
    return () => { alive = false; };
  }, [workspace, patientDrafts, selected]);

  const [showLogin, setShowLogin] = useState(false);
  const [showSourceCorrection, setShowSourceCorrection] = useState(false);
  const [correctionValue, setCorrectionValue] = useState("");
  const [correctionTarget, setCorrectionTarget] = useState<"name" | "identifier" | "birthDate" | "gender">("birthDate");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [validation, setValidation] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationFor, setValidationFor] = useState<{ rowIndex: number; inputHash: string; payloadHash: string; rowSnapshot: string; mappingSnapshot: string } | null>(null);
  const [validationResult, setValidationResult] = useState<Awaited<ReturnType<typeof validatePatientDraft>> | null>(null);
  const [demoValidationResult, setDemoValidationResult] = useState<{
    rowIndex: number;
    rowSnapshot: string;
    mappingSnapshot: string;
    outcome: "passed" | "warning" | "failed";
    issues: ReturnType<typeof validatePatientLocally>;
  } | null>(null);
  const [validationError, setValidationError] = useState("");
  // Restore exact persisted validation evidence for the selected Patient Draft.
  useEffect(() => {
    if (validationRunRef.current) return;
    if (isDemoMode) {
      setValidation(false);
      setValidationResult(null);
      setValidationFor(null);
      return;
    }

    const row = rows[selected];
    const mappingsApproved = fields.length > 0 && fields.every(field => field.approved);

    if (!workspace || !importId || !approved || !mappingsApproved || !row) {
      setValidation(false);
      setValidationResult(null);
      setValidationFor(null);
      return;
    }

    let alive = true;
    setValidation(false);
    setValidationResult(null);
    setValidationFor(null);
    setValidationError("");

    (async () => {
      try {
        const result = await restorePatientDraftValidation({
          workspace,
          importId,
          row,
          rowNumber: selected + 1,
          fields,
        });

        if (!alive || !result || validationRunRef.current) return;

        setValidationResult(result);
        setValidation(true);
        setValidationFor({
          rowIndex: selected,
          inputHash: result.inputHash,
          payloadHash: result.payloadHash,
          rowSnapshot: JSON.stringify(row),
          mappingSnapshot: JSON.stringify(
            fields.map(({ source, target, approved }) => ({ source, target, approved }))
          ),
        });
      } catch (error) {
        if (!alive) return;
        setValidation(false);
        setValidationResult(null);
        setValidationFor(null);
        setValidationError("Saved validation evidence could not be restored: " + getReadableError(error));
        setNotice("Saved Patient validation could not be restored. Run validation again. " + getReadableError(error));
      }
    })();

    return () => {
      alive = false;
    };
  }, [workspace, importId, selected, rows, fields, approved, isDemoMode]);
  const [mrnReviewPatient, setMrnReviewPatient] = useState<import("./lib/workflow").PatientMrnConflict | null>(null);
  const [mrnReviewOpen, setMrnReviewOpen] = useState(false);
  const [mrnReviewReason, setMrnReviewReason] = useState("");
  const [mrnReviewBusy, setMrnReviewBusy] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [search, setSearch] = useState(""),
    [kfaKeyword, setKfaKeyword] = useState(""),
    [kfaRows, setKfaRows] = useState<any[]>([]),
    [kfaBusy, setKfaBusy] = useState(false),
    [kfaSyncResult, setKfaSyncResult] = useState<any>(null);
  const [kfaCatalogueRows, setKfaCatalogueRows] = useState<any[]>([]);
  const [tenant, setTenant] = useState("Demo Clinic · Jakarta");

  // Clear only browser-held workspace/session state. Tenant records remain untouched.
  const clearSessionData = () => {
    setSession(null);
    setWorkspace(null);
    setIsDemoMode(false);
    setTenant("Demo Clinic · Jakarta");

    setRows([]);
    setFields([]);
    setFilename("");
    setSourceFile(null);
    setImportId(null);
    setSelected(0);
    setApproved(false);
    setActive("SCAN");
    setPage("Overview");

    setSavedPatients({});
    setPatientDrafts({});
    setDraftRevisions({});
    setOpsRows([]);

    setValidation(false);
    setIsValidating(false);
    setValidationFor(null);
    setValidationResult(null);
    setDemoValidationResult(null);
    setValidationError("");
    validationRunRef.current = false;
    setSandboxResult(null);

    setShowSourceCorrection(false);
    setCorrectionValue("");
    setCorrectionReason("");
    setCorrectionBusy(false);
    setSaveFeedback(null);

    setMrnReviewPatient(null);
    setMrnReviewOpen(false);
    setMrnReviewReason("");
    setMrnReviewBusy(false);

    // Clear clinic-specific reference/search results from the previous session.
    setKfaRows([]);
    setKfaSyncResult(null);
    setKfaCatalogueRows([]);
    setTermRows([]);
  };
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive || !data.session) return;
      try {
        const w = await getWorkspace(data.session);
        const restored = w.organizationId ? await restoreLatestImport(w) : null;
        if (alive) {
          setSession(data.session);
          setWorkspace(w);
          setTenant(w.tenantName);
          if (restored) {
            setIsDemoMode(false);
            setImportId(restored.importId);
            setFilename(restored.filename);
            setRows(restored.rows);
            setFields(restored.fields);
            setApproved(restored.fields.length > 0 && restored.fields.every(f => f.approved));
            setActive(restored.fields.length ? "MAP" : "SCAN");
            setPage(restored.fields.length && restored.fields.every(f => f.approved) ? "FHIR & validation" : "MAP");
            setNotice("Your latest clinic import and saved mapping decisions have been restored.");
          }
        }
      } catch {
        if (alive) {
          await supabase?.auth.signOut();
          setNotice("This account has no active clinic membership.");
        }
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        if (!next) {
          clearSessionData();
          setNotice("Session ended. No clinic patient records are displayed.");
        }
      },
    );
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!workspace || !supabase) return;
    const table =
      page === "Transactions"
        ? "integration_transactions"
        : page === "Audit trail"
          ? "audit_logs"
          : page === "Patient records"
            ? "patients"
            : null;
    if (!table) return;
    let alive = true;
    supabase
      .from(table)
      .select("*")
      .eq("tenant_id", workspace.tenantId)
      .order("created_at", { ascending: false })
      .limit(25)
      .then(({ data, error }) => {
        if (alive) {
          if (error)
            setNotice(
              "Could not load " + page.toLowerCase() + ": " + error.message,
            );
          else setOpsRows(data ?? []);
        }
      });
    return () => {
      alive = false;
    };
  }, [page, workspace]);
  useEffect(() => {
    if (page !== "Terminology" || !supabase || termQuery.trim().length < 2) {
      setTermRows([]);
      return;
    }
    const client = supabase;
    let alive = true;
    setTermBusy(true);
    const safeQuery = termQuery
      .trim()
      .replace(/[^a-zA-Z0-9 ._-]/g, "")
      .slice(0, 80);
    const timer = setTimeout(() => {
      client
        .from("terminology_concepts")
        .select(
          "id,code,display,definition,active,source_sheet,source_row_number,properties",
        )
        .eq("active", true)
        .or(`code.ilike.%${safeQuery}%,display.ilike.%${safeQuery}%`)
        .limit(30)
        .then(({ data, error }) => {
          if (alive) {
            setTermBusy(false);
            if (error)
              setNotice("Terminology lookup unavailable: " + error.message);
            else setTermRows(data ?? []);
          }
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [page, termQuery]);
  useEffect(() => {
    const client = supabase;
    if (page !== "KFA catalogue" || !workspace || !client) return;
    let alive = true;
    (async () => {
      const { data: products, error } = await client
        .from("medication_products")
        .select(
          "id,product_code,product_display,product_type,active,approval_status,catalogue_version,properties",
        )
        .eq("catalogue_key", "KFA")
        .order("product_display")
        .limit(100);
      if (error) {
        if (alive)
          setNotice("Could not load imported KFA catalogue: " + error.message);
        return;
      }
      const ids = (products ?? []).map((p: any) => p.id);
      let reviews: any[] = [];
      if (ids.length) {
        const { data, error: reviewError } = await client
          .from("kfa_product_reviews")
          .select("medication_product_id,decision,rationale,reviewed_at")
          .eq("tenant_id", workspace.tenantId)
          .in("medication_product_id", ids);
        if (reviewError) {
          if (alive)
            setNotice(
              "Could not load clinic KFA reviews: " + reviewError.message,
            );
          return;
        }
        reviews = data ?? [];
      }
      if (alive)
        setKfaCatalogueRows(
          (products ?? []).map((p: any) => ({
            ...p,
            clinic_review:
              reviews.find((r: any) => r.medication_product_id === p.id) ??
              null,
          })),
        );
    })();
    return () => {
      alive = false;
    };
  }, [page, workspace, kfaSyncResult]);
  const reviewKfa = async (
    productId: string,
    decision: "approved" | "rejected" | "needs_review",
  ) => {
    if (!workspace || !session || !supabase) return;
    try {
      setKfaBusy(true);
      const { error } = await supabase.from("kfa_product_reviews").upsert(
        {
          tenant_id: workspace.tenantId,
          medication_product_id: productId,
          decision,
          rationale:
            decision === "approved"
              ? "Reviewed by authorized clinic reviewer; accepted for this clinic reference use."
              : decision === "rejected"
                ? "Rejected by clinic reviewer; do not use for this clinic."
                : "Requires additional clinic review.",
          reviewed_by: session.user.id,
          reviewed_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,medication_product_id" },
      );
      if (error) throw error;
      setNotice(
        "Clinic-specific KFA review decision saved and audited by reviewer identity.",
      );
      setKfaSyncResult((v: any) => ({ ...v, refresh: Date.now() }));
    } catch (err) {
      setNotice("KFA review could not be saved: " + (err as Error).message);
    } finally {
      setKfaBusy(false);
    }
  };
  const runKfa = async (action: "search" | "sync_page") => {
    if (!supabase || !workspace || !session) {
      setShowLogin(true);
      setNotice(
        "Sign in to a clinic workspace to access its authorized KFA connection.",
      );
      return;
    }
    try {
      setKfaBusy(true);
      const { data, error } = await supabase.functions.invoke("kfa-catalogue", {
        body: {
          action,
          tenant_id: workspace.tenantId,
          page: 1,
          size: 50,
          product_type: "farmasi",
          keyword: kfaKeyword.trim() || undefined,
        },
      });
      if (error) throw error;
      if (!data?.success)
        throw new Error(data?.error ?? "KFA request was not successful");
      if (action === "search") setKfaRows(data.items ?? []);
      else setKfaSyncResult(data);
      setNotice(
        action === "search"
          ? "Live KFA staging catalogue search completed."
          : "KFA page synchronized; records remain unreviewed until human approval.",
      );
    } catch (err) {
      setNotice("KFA operation blocked: " + (err as Error).message);
    } finally {
      setKfaBusy(false);
    }
  };
  const runSandboxPreflight = async () => {
    if (!supabase || !session || !workspace) {
      setNotice(
        "Sign in and select a clinic workspace before running the SATUSEHAT Sandbox preflight.",
      );
      return;
    }
    try {
      setPersisting(true);
      const { data, error } = await supabase.functions.invoke(
        "satusehat-connectivity-test",
        {
          body: {
            action: "preflight",
            tenant_id: workspace.tenantId,
            organization_id: workspace.organizationId
          }
        },
      );
      if (error) throw error;
      setSandboxResult(data);
      setNotice(
        data?.success
          ? "SATUSEHAT staging preflight completed. This confirms connectivity only, not Patient submission."
          : "SATUSEHAT staging preflight returned a blocker. See details below.",
      );
    } catch (err) {
      setNotice("SATUSEHAT preflight unavailable: " + (err as Error).message);
    } finally {
      setPersisting(false);
    }
  };
  const columns = useMemo(
    () => (rows.length ? Object.keys(rows[0]) : []),
    [rows],
  );
  const missing = useMemo(
    () =>
      rows.reduce(
        (n, r) =>
          n + Object.values(r).filter((v) => !String(v ?? "").trim()).length,
        0,
      ),
    [rows],
  );
  const duplicateDisplay = useMemo(() => {
  const identifierField = fields.find((field) => field.target === "identifier")?.source;
  if (!identifierField) return { field: "", groups: new Map<string, number>(), count: 0 };

  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const value = String(row[identifierField] ?? "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  const groups = new Map<string, number>();
  let nextGroup = 0;
  counts.forEach((count, value) => {
    if (count > 1) groups.set(value, nextGroup++ % 6);
  });

  return { field: identifierField, groups, count: groups.size };
}, [fields, rows]);

const recordValidationIssues = useMemo(
  () => rows.map((row) => validatePatientLocally(row, fields)),
  [rows, fields],
);

const scanDuplicateGroups = useMemo(() => {
  const identifierField = fields.find((field) => field.target === "identifier")?.source;
  const nameField = fields.find((field) => field.target === "name")?.source;

  const empty = {
    groups: [] as Array<{
      id: number;
      kind: "potential-exact-duplicate" | "identity-conflict" | "name-incomplete";
      rows: number[];
      mrn: string;
      names: string[];
    }>,
    rowGroups: new Map<number, number>(),
    identifierField: identifierField ?? "",
    nameField: nameField ?? "",
  };

  if (!identifierField || !nameField) return empty;

  const normalizeMrn = (value: unknown) =>
    String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();

  const normalizeName = (value: unknown) =>
    String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

  const byMrn = new Map<string, { rows: number[]; names: Set<string>; originalNames: Set<string> }>();

  rows.forEach((row, index) => {
    const mrn = normalizeMrn(row[identifierField]);
    if (!mrn) return;

    const name = normalizeName(row[nameField]);
    const originalName = String(row[nameField] ?? "").trim();

    const entry = byMrn.get(mrn) ?? {
      rows: [],
      names: new Set<string>(),
      originalNames: new Set<string>(),
    };

    entry.rows.push(index);
    if (name) entry.names.add(name);
    if (originalName) entry.originalNames.add(originalName);
    byMrn.set(mrn, entry);
  });

  const groups: typeof empty.groups = [];
  const rowGroups = new Map<number, number>();

  for (const [mrn, entry] of byMrn) {
    if (entry.rows.length < 2) continue;

    const kind =
      entry.names.size === 0
        ? "name-incomplete"
        : entry.names.size > 1
          ? "identity-conflict"
          : "potential-exact-duplicate";

    const id = groups.length;
    groups.push({
      id,
      kind,
      rows: entry.rows,
      mrn,
      names: Array.from(entry.originalNames),
    });

    entry.rows.forEach((rowIndex) => rowGroups.set(rowIndex, id));
  }

  return { ...empty, groups, rowGroups };
}, [fields, rows]);

const scanCellFindings = useMemo(() => {
  type CellFinding = {
    classes: string[];
    messages: string[];
  };

  const findings = new Map<string, CellFinding>();

  const addFinding = (rowIndex: number, column: string, className: string, message: string) => {
    const key = `${rowIndex}::${column}`;
    const existing = findings.get(key) ?? { classes: [], messages: [] };

    if (!existing.classes.includes(className)) existing.classes.push(className);
    if (!existing.messages.includes(message)) existing.messages.push(message);

    findings.set(key, existing);
  };

  const mappingFor = (target: string) =>
    fields.find((field) => field.target === target);

  const validationTarget = (code: string) => {
    if (code === "PATIENT_NAME_REQUIRED") return "name";
    if (code === "SOURCE_NIK_INVALID_FORMAT") return "national_identifier";
    if (code.startsWith("BIRTH_DATE_")) return "birthDate";
    if (code === "GENDER_INVALID") return "gender";
    if (code === "PATIENT_CITY_MISSING") return "address.city";
    return "";
  };

  rows.forEach((row, rowIndex) => {
    // Highlight blank fields that have an explicit suggested or approved mapping.
    fields.forEach((field) => {
      if (!field.source || !columns.includes(field.source)) return;
      if (String(row[field.source] ?? "").trim()) return;

      const mappingState = field.approved ? "approved mapping" : "preliminary suggested mapping";

      addFinding(
        rowIndex,
        field.source,
        "scan-cell--missing",
        `Missing expected value for ${field.target} (${mappingState}).`,
      );
    });

    // Validation errors and warnings are based only on the existing approved-mapping validator.
    recordValidationIssues[rowIndex]?.forEach((issue) => {
      const target = validationTarget(issue.code);
      if (!target) return;

      const mapping = mappingFor(target);
      if (!mapping?.approved || !columns.includes(mapping.source)) return;

      const className = issue.severity === "error"
        ? "scan-cell--invalid"
        : "scan-cell--missing";

      addFinding(
        rowIndex,
        mapping.source,
        className,
        `${issue.severity.toUpperCase()}: ${issue.message}`,
      );
    });
  });

  // Highlight both MRN and name cells for every record in a repeated-MRN group.
  scanDuplicateGroups.groups.forEach((group) => {
    const duplicateClass = `scan-cell--duplicate-${group.id % 6}`;
    const description =
      group.kind === "identity-conflict"
        ? "IDENTITY CONFLICT: the same normalized MRN is associated with different patient names. Human review is required."
        : group.kind === "name-incomplete"
          ? "IDENTITY REVIEW REQUIRED: the MRN is repeated, but patient names are missing or incomplete."
          : "POTENTIAL EXACT DUPLICATE: the same normalized MRN and patient name appear in multiple records. Human review is required.";

    group.rows.forEach((rowIndex) => {
      addFinding(rowIndex, scanDuplicateGroups.identifierField, duplicateClass, description);
      addFinding(rowIndex, scanDuplicateGroups.nameField, duplicateClass, description);
    });
  });

  return findings;
}, [rows, columns, fields, recordValidationIssues, scanDuplicateGroups]);

const getScanCellFinding = (rowIndex: number, column: string) =>
  scanCellFindings.get(`${rowIndex}::${column}`);
const recordScanStatuses = useMemo(
  () => rows.map((row, index) => {
    const identifierValue = duplicateDisplay.field
      ? String(row[duplicateDisplay.field] ?? "").trim()
      : "";
    const duplicateGroup = identifierValue
      ? duplicateDisplay.groups.get(identifierValue)
      : undefined;
    const missingFields = columns.filter((column) => !String(row[column] ?? "").trim());

    const validationErrors = recordValidationIssues[index].filter((issue, issueIndex, allIssues) => {
      if (issue.severity !== "error") return false;
      if (String(issue.code ?? "").startsWith("BIRTH_DATE_")) {
        return allIssues.findIndex((candidate) =>
          candidate.severity === "error" && String(candidate.code ?? "").startsWith("BIRTH_DATE_"),
        ) === issueIndex;
      }
      return true;
    });

    const status = validationErrors.length
      ? "invalid"
      : missingFields.length
        ? "missing"
        : duplicateGroup !== undefined
          ? "duplicate"
          : "clean";

    return { duplicateGroup, missingFields, validationErrors, status } as const;
  }),
  [rows, columns, duplicateDisplay, recordValidationIssues],
);

const getRecordScanClass = (index: number) => {
  const status = recordScanStatuses[index];
  if (status?.status === "invalid") return "invalid";
  if (status?.status === "missing") return "missing";
  if (status?.status === "duplicate") return `duplicate duplicate-group-${status.duplicateGroup}`;
  return "clean";
};

const getRecordScanLabel = (index: number) => {
  const status = recordScanStatuses[index];
  if (status?.status === "invalid") {
    return `${status.validationErrors.length} validation error${status.validationErrors.length === 1 ? "" : "s"}`;
  }
  if (status?.status === "duplicate") return "Duplicate identifier";
  if (status?.status === "missing") {
    return `${status.missingFields.length} blank source field${status.missingFields.length === 1 ? "" : "s"}`;
  }
  return "No detected issue";
};
const issues = useMemo(
    () =>
      rows.reduce(
        (n, r) =>
          n + (!Object.values(r).some((v) => String(v ?? "").trim()) ? 1 : 0),
        0,
      ),
    [rows],
  );
  const fhir = useMemo(
    () => normalizePatient(rows[selected] ?? {}, fields).fhir,
    [rows, selected, fields],
  );
  const patientChecks = useMemo(
    () => ({ ...normalizePatient(rows[selected] ?? {}, fields), issues: validatePatientLocally(rows[selected] ?? {}, fields) }),
    [rows, selected, fields],
  );
  const selectedNameIssue = patientChecks.issues.find(
    (issue) => issue.code === "PATIENT_NAME_REQUIRED",
  );
  const selectedIdentifierIssue = patientChecks.issues.find(
    (issue) => issue.code === "SOURCE_IDENTIFIER_MISSING",
  );
  const selectedBirthDateIssue = patientChecks.issues.find(
    (issue) => ["BIRTH_DATE_INVALID", "BIRTH_DATE_MISSING", "BIRTH_DATE_FUTURE"].includes(issue.code),
  );
  const selectedGenderIssue = patientChecks.issues.find((issue) => issue.code === "GENDER_INVALID");
  const selectedCorrectionIssues = {
    name: selectedNameIssue,
    identifier: selectedIdentifierIssue,
    birthDate: selectedBirthDateIssue,
    gender: selectedGenderIssue,
  };
  const correctionLabel = correctionTarget === "name"
    ? "Patient name"
    : correctionTarget === "identifier"
      ? "MRN / Patient identifier"
      : correctionTarget === "birthDate" ? "Date of birth" : "Administrative gender";
  const openBirthDateCorrection = (rowIndex: number) => {
    const row = rows[rowIndex];
    const mapping = fields.find(
      (field) => field.target === "birthDate" && field.approved,
    );
    if (!row || !mapping) {
      setNotice("Cannot open date correction: an approved Patient birthDate mapping is required.");
      return;
    }
    const rowIssue = validatePatientLocally(row, fields).find(
      (issue) => ["BIRTH_DATE_INVALID", "BIRTH_DATE_MISSING", "BIRTH_DATE_FUTURE"].includes(issue.code),
    );
    if (!rowIssue) return;
    setCorrectionTarget("birthDate");
    setCorrectionValue(String(row[mapping.source] ?? ""));
    setCorrectionReason("");
    setShowSourceCorrection(true);
    setNotice(`Invalid date of birth detected for ${String(row[fields.find((field) => field.target === "name" && field.approved)?.source ?? ""] ?? "this Patient")}. Correct it using verified source evidence.`);
  };
  const openPatientSourceCorrection = (target: "name" | "identifier" | "birthDate" | "gender", rowIndex: number) => {
    const mapping = fields.find(field => field.target === target);
    if (!rows[rowIndex] || !mapping) {
      setNotice(`Cannot correct ${target}: map a source column to this Patient field first.`);
      return;
    }
    setCorrectionTarget(target);
    setCorrectionValue(String(rows[rowIndex]?.[mapping.source] ?? ""));
    setCorrectionReason("");
    setShowSourceCorrection(true);
  };
  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    setSourceFile(file);
    setImportId(null);
    setSavedPatients({});
    setPatientDrafts({});
    setDraftRevisions({});
    setDemoValidationResult(null);
    setValidationResult(null);
    setValidationFor(null);
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (r) => {
        const data = r.data.slice(0, 500);
        const mapped = (r.meta.fields ?? []).map(guess);
        setRows(data);
        setFields(mapped);
        setActive("SCAN");
        setApproved(false);
        setValidation(false);
        setPage("Source data");
        setNotice(`Loaded ${data.length} rows from ${file.name}.`);
        if (workspace) {
          try {
            setPersisting(true);
            const id = await persistImport({
              workspace,
              file,
              rows: data,
              fields: mapped,
            });
            setImportId(id);
            setNotice(
              `SCAN profile saved to clinic workspace · ${data.length} records.`,
            );
          } catch (err) {
            setNotice(`Import not fully saved: ${(err as Error).message}`);
          } finally {
            setPersisting(false);
          }
        }
      },
      error: () => setNotice("Could not parse this CSV file."),
    });
  };
  const loadDemo = () => {
    const headers = Object.keys(demo[0]);
    const csv = [
      headers.join(","),
      ...demo.map((row) =>
        headers
          .map(
            (h) => '\"' + String(row[h] ?? "").replaceAll('\"', '\"\"') + '\"',
          )
          .join(","),
      ),
    ].join("\n");
    const file = new File([csv], "synthetic_patient_register.csv", {
      type: "text/csv",
    });
    setIsDemoMode(true);
    setFilename(file.name);
    setSourceFile(file);
    setImportId(null);
    setSavedPatients({});
    setPatientDrafts({});
    setDraftRevisions({});
    setDemoValidationResult(null);
    setValidationResult(null);
    setValidationFor(null);
    setRows(demo);
    setFields(headers.map(guess));
    setActive("SCAN");
    setApproved(false);
    setValidation(false);
    setPage("Source data");
    setNotice(
      "Synthetic dataset loaded. No real patient data used. " +
        (workspace
          ? "Save it to the authenticated tenant when ready."
          : "Sign in to persist this dataset."),
    );
  };
  const updateField = (i: number, target: string) => {
    setValidation(false);
    setValidationResult(null);
    setDemoValidationResult(null);
    setApproved(false);
    setFields((fs) =>
      fs.map((f, j) => (i === j ? { ...f, target, approved: false } : f)),
    );
  };
  const toggleApprove = (i: number) => {
    const proposed = fields.map((field, index) =>
      index === i ? { ...field, approved: !field.approved } : field
    );
    const issues = getPatientMappingIssues(proposed);
    if (issues.length) {
      setApproved(false);
      setNotice("Mapping approval blocked: " + issues.map(issue => issue.message).join(" "));
      return;
    }
    setValidation(false);
    setValidationResult(null);
    setDemoValidationResult(null);
    setApproved(false);
    setFields(proposed);
  };
  const login = async () => {
    if (!supabase) {
      setNotice(
        "Supabase is not configured. Add the project URL and publishable key to .env.",
      );
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setBusy(false);
      setNotice(error.message);
      return;
    }
    try {
      const w = await getWorkspace(data.session);
      const restored = await restoreLatestImport(w);
      clearSessionData();
      setIsDemoMode(false);
      setWorkspace(w);
      setTenant(w.tenantName);
      setSession(data.session);
      if (restored) {
        setIsDemoMode(false);
        setImportId(restored.importId);
        setFilename(restored.filename);
        setRows(restored.rows);
        setFields(restored.fields);
        setApproved(restored.fields.length > 0 && restored.fields.every(f => f.approved));
        setActive(restored.fields.length ? "MAP" : "SCAN");
        setPage(restored.fields.length && restored.fields.every(f => f.approved) ? "FHIR & validation" : "MAP");
      }
      setShowLogin(false);
      setNotice(restored
        ? "Signed in. Your latest import and saved mapping decisions have been restored."
        : `Signed in to ${w.tenantName} · ${w.role}.`);
    } catch (err) {
      await supabase.auth.signOut();
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    let signOutError: unknown = null;
    try {
      const result = await supabase?.auth.signOut();
      signOutError = result?.error ?? null;
    } catch (error) {
      signOutError = error;
    }

    clearSessionData();
    setNotice(
      signOutError
        ? "Local clinic data cleared, but remote sign-out reported an error: " + getReadableError(signOutError)
        : "Logged out. No clinic patient records are displayed.",
    );
  };
  const runValidation = async () => {
    if (validationRunRef.current) return;
    validationRunRef.current = true;
    setIsValidating(true);
    setValidation(false);
    setValidationResult(null);
    setValidationFor(null);
    setDemoValidationResult(null);
    setValidationError("");
    try {
      const row = rows[selected];
      const mappingsApproved = fields.length > 0 && fields.every((field) => field.approved);
      if (!approved || !mappingsApproved || !row) {
        throw new Error("Validation requires a selected Patient and explicit approval of every source mapping.");
      }

      if (isDemoMode) {
        // Browser-only deterministic checks. No database call, hash, report ID or audit event.
        const issues = validatePatientLocally(row, fields);
        const outcome = issues.some((issue) => issue.severity === "error")
          ? "failed"
          : issues.some((issue) => issue.severity === "warning")
            ? "warning"
            : "passed";
        setDemoValidationResult({
          rowIndex: selected,
          rowSnapshot: JSON.stringify(row),
          mappingSnapshot: JSON.stringify(fields.map(({ source, target, approved }) => ({ source, target, approved }))),
          outcome,
          issues,
        });
        setValidation(outcome === "passed");
        setActive("VALIDATE");
        setNotice("DEMO local deterministic validation " + outcome + ". Result exists only in this browser and is not persisted. SATUSEHAT profile validation was not executed. Canonical Patient saving and SATUSEHAT submission remain disabled in Demo Mode.");
        return;
      }

      if (!workspace || !importId) {
        throw new Error("Authenticated validation requires a clinic workspace and a persisted source import.");
      }
      const currentDraft = await getPatientDraft({ workspace, importId, rowNumber: selected + 1 });
      if (!currentDraft || currentDraft.status === "stale") {
        throw new Error("Save the current Patient Draft before validation.");
      }
      setPatientDrafts(current => ({ ...current, [selected]: currentDraft }));
      const result = await validatePatientDraft({ workspace, importId, row, rowNumber: selected + 1, fields });
      const refreshedDraft = await getPatientDraft({ workspace, importId, rowNumber: selected + 1 });
      if (refreshedDraft) {
        setPatientDrafts(current => ({ ...current, [selected]: refreshedDraft }));
        const revisions = await getPatientDraftRevisions({ workspace, draftId: refreshedDraft.id });
        setDraftRevisions(current => ({ ...current, [selected]: revisions }));
      }
      setValidationResult(result);
      setValidation(result.outcome === "passed");
      setActive("VALIDATE");
      setValidationFor({
        rowIndex: selected,
        inputHash: result.inputHash,
        payloadHash: result.payloadHash,
        rowSnapshot: JSON.stringify(row),
        mappingSnapshot: JSON.stringify(fields.map(({ source, target, approved }) => ({ source, target, approved }))),
      });
      setNotice(`Local Patient validation ${result.outcome}.${result.auditWarning ? " Audit warning: " + result.auditWarning : ""} SATUSEHAT profile validation not yet executed.`);
    } catch (error) {
      const message = "Validation could not be completed: " + getReadableError(error);
      setValidation(false);
      setValidationResult(null);
      setValidationFor(null);
      setDemoValidationResult(null);
      setValidationError(message);
      setNotice(message);
    } finally {
      validationRunRef.current = false;
      setIsValidating(false);
    }
  };
  const saveImport = async () => {
    if (isDemoMode) {
      setNotice("Demo Mode is browser-only. Synthetic preview data is not persisted to a clinic tenant.");
      return;
    }
    if (!workspace || !sourceFile) {
      setShowLogin(true);
      setNotice("Sign in to a tenant workspace before persisting this import.");
      return;
    }
    try {
      setPersisting(true);
      const id = await persistImport({
        workspace,
        file: sourceFile,
        rows,
        fields,
      });
      setImportId(id);
      setNotice(
        "Source file, SCAN profile, rows and mapping suggestions saved under the authenticated tenant.",
      );
    } catch (err) {
      setNotice("Import persistence failed: " + (err as Error).message);
    } finally {
      setPersisting(false);
    }
  };
  const saveMapping = async (): Promise<boolean> => {
    const mappingIssues = getPatientMappingIssues(fields);
    if (mappingIssues.length) {
      setApproved(false);
      setNotice("Mapping approval blocked: " + mappingIssues.map(issue => issue.message).join(" "));
      return false;
    }
    if (!workspace || !importId) {
      setNotice("Mapping approval was not saved. Persist the source import first.");
      return false;
    }
    try {
      setPersisting(true);
      setNotice("Saving mapping decisions and reviewer audit...");
      await persistMappingReview(workspace, importId, fields);
      setApproved(true);
      setNotice("Mapping decisions saved with reviewer identity and audit event.");
      return true;
    } catch (err) {
      setApproved(false);
      setNotice("Mapping review could not be saved: " + (err as Error).message);
      return false;
    } finally {
      setPersisting(false);
    }
  };
  const saveCanonicalPatient = async () => {
    if (isDemoMode) {
      setNotice("Canonical Patient saving is disabled in Demo Mode. No tenant record was created.");
      return;
    }
    const rowIndex = selected;
    const selectedRow = rows[rowIndex];

    if (!approved) {
      setSaveFeedback({
        rowIndex,
        kind: "other",
        title: "SAVE BLOCKED · MAPPINGS NOT APPROVED",
        message: "Approve and save all source mappings before creating a canonical Patient.",
        action: "Open MAP, review the mappings, and confirm them before retrying.",
      });
      return;
    }
    if (!workspace || !importId) {
      setSaveFeedback({
        rowIndex,
        kind: "other",
        title: "SAVE BLOCKED · CLINIC IMPORT NOT READY",
        message: "A signed-in clinic workspace and a persisted source import are required.",
        action: "Sign in and save the source import, then return to this Patient.",
      });
      return;
    }
    if (!selectedRow) {
      setSaveFeedback({
        rowIndex,
        kind: "other",
        title: "SAVE BLOCKED · NO PATIENT SELECTED",
        message: "Select a source Patient record before saving.",
        action: "Choose a Patient from the source record list.",
      });
      return;
    }
    if (savedPatients[rowIndex]) {
      setSaveFeedback({
        rowIndex,
        kind: "other",
        title: "PATIENT ALREADY SAVED",
        message: "This source row already has a persisted canonical Patient.",
        action: "Select another source Patient to continue.",
      });
      return;
    }
    if (!currentValidationMatchesSelection) {
      setSaveFeedback({ rowIndex, kind: "other", title: "SAVE BLOCKED · VALIDATION REQUIRED", message: "Run and pass local validation for this exact Patient before saving.", action: "Run validation and resolve all blocking errors." }); return;
    }

    const birthDateField = fields.find((field) => field.target === "birthDate");
    const birthDateSource = birthDateField?.source ?? "";
    const birthDateValue = birthDateSource ? selectedRow[birthDateSource] : undefined;
    const birthDateIssue = validateSourceBirthDate(birthDateValue);
    if (birthDateIssue) {
      setSaveFeedback({
        rowIndex,
        kind: "invalid_date",
        title: "SAVE FAILED · INVALID DATE OF BIRTH",
        message: birthDateIssue,
        action: `Source field: ${birthDateSource || "birthDate mapping not found"}. Correct this value in the source data and re-import the corrected row. No Patient record was saved.`,
      });
      return;
    }

    setSaveFeedback(null);
    try {
      setPersisting(true);
      setNotice("Saving canonical Patient, FHIR draft, validation result and audit record...");
      const result = await persistPatient({
        workspace,
        importId,
        row: selectedRow,
        rowNumber: rowIndex + 1,
        fields,
        expectedPayloadHash: validationResult.payloadHash,
        expectedInputHash: validationResult.inputHash,
      });

      // Mark this exact source row as saved only after persistence confirms success.
      setSavedPatients(current => ({
        ...current,
        [rowIndex]: {
          patientId: result.patientId,
          resourceId: result.resourceId,
          mrn: String(selectedRow[fields.find(f => f.target === "identifier")?.source ?? ""] ?? ""),
        },
      }));
      setSaveFeedback({
        rowIndex,
        kind: "other",
        title: "PATIENT SAVED",
        message: "The canonical Patient, FHIR draft, validation result and audit record were persisted.",
        action: `Validation outcome: ${result.outcome}. No SATUSEHAT submission was made.`,
      });
      setNotice(`Canonical Patient persisted for source row ${rowIndex + 1}. No SATUSEHAT submission was made.`);
    } catch (err) {
      const rawMessage = getReadableError(err);
      const lowerMessage = rawMessage.toLowerCase();
      const invalidDate =
        lowerMessage.includes("date/time field value out of range") ||
        lowerMessage.includes("date field value out of range") ||
        lowerMessage.includes("invalid input syntax for type date") ||
        lowerMessage.includes("invalid date") ||
        lowerMessage.includes("birth date") ||
        lowerMessage.includes("birthdate") ||
        lowerMessage.includes("date of birth");
      const mrnConflict = err instanceof PatientMrnConflictError ||
        lowerMessage.includes("source mrn already exists") ||
        (lowerMessage.includes("mrn") && lowerMessage.includes("already exists")) ||
        lowerMessage.includes("identity match manually");

      if (mrnConflict) {
        if (err instanceof PatientMrnConflictError) setMrnReviewPatient(err.patient);
        setMrnReviewReason("");
        setMrnReviewOpen(true);
        setSaveFeedback({
          rowIndex,
          kind: "mrn_conflict",
          title: "SAVE BLOCKED · MRN CONFLICT",
          message: rawMessage,
          action: "Do not create or merge this Patient automatically. A clinic reviewer must verify whether this is an existing Patient before proceeding.",
        });
      } else if (invalidDate) {
        setSaveFeedback({
          rowIndex,
          kind: "invalid_date",
          title: "SAVE FAILED · INVALID DATE OF BIRTH",
          message: `${rawMessage}${birthDateSource ? ` · Source field "${birthDateSource}" = "${String(birthDateValue ?? "")}"` : ""}`,
          action: "Correct the source date of birth to a real calendar date (YYYY-MM-DD), then re-import the corrected row. SATUCORE does not silently alter source values.",
        });
      } else {
        setSaveFeedback({
          rowIndex,
          kind: "other",
          title: "SAVE FAILED · PATIENT NOT SAVED",
          message: rawMessage,
          action: "The database did not confirm persistence. Review the error details above; this Patient remains unsaved and can be retried after correction.",
        });
      }
      // Keep the same source Patient selected; a failed save never changes selection or saved status.
      setNotice("Patient save did not complete. See the message beside the Save button.");
    } finally {
      setPersisting(false);
    }
  };
  const demoValidationIsFresh = !!demoValidationResult &&
    demoValidationResult.rowIndex === selected &&
    !!rows[selected] &&
    demoValidationResult.rowSnapshot === JSON.stringify(rows[selected]) &&
    demoValidationResult.mappingSnapshot === JSON.stringify(fields.map(({ source, target, approved }) => ({ source, target, approved }))) &&
    approved && fields.length > 0 && fields.every((field) => field.approved);
  const currentValidationIsFresh = !!validationResult && !!validationFor &&
    validationFor.rowIndex === selected &&
    !!rows[selected] && !!fields.length &&
    validationFor.rowSnapshot === JSON.stringify(rows[selected]) &&
    validationFor.mappingSnapshot === JSON.stringify(fields.map(({source,target,approved}) => ({source,target,approved}))) &&
    validationFor.inputHash === validationResult.inputHash &&
    validationFor.payloadHash === validationResult.payloadHash;
  const currentValidationMatchesSelection = !isDemoMode && !!validationResult && currentValidationIsFresh &&
    validationResult.outcome === "passed" && validation && !isValidating &&
    patientDrafts[selected]?.status === "validated" && !patientDrafts[selected]?.identityConflict &&
    patientDrafts[selected]?.payload_hash === validationResult.payloadHash &&
    patientDrafts[selected]?.input_hash === validationResult.inputHash;
  const selectedHasBlockingIssues = patientChecks.issues.some(issue => issue.severity === "error");
  const selectedHasUnresolvedIssues = selectedHasBlockingIssues || patientChecks.issues.some(issue => issue.severity === "warning");
  const patientActionLabel = isDemoMode
    ? isValidating ? "Validating…" : demoValidationIsFresh ? `Demo checks · ${demoValidationResult?.outcome.toUpperCase()}` : "Run local validation"
    : persisting ? "Saving…"
    : isValidating ? "Validating…"
    : patientDrafts[selected]?.identityConflict?.status === "pending" ? "Identity review pending"
    : patientDrafts[selected]?.identityConflict?.status === "request_failed" ? "Retry identity review"
    : savedPatients[selected] ? "Canonical Patient saved"
    : !importId ? "Save source import first"
    : !patientDrafts[selected] || patientDrafts[selected]?.status === "stale" ? "Save Patient Draft"
    : validationResult && currentValidationIsFresh && validationResult.outcome !== "passed" ? "Review validation report"
    : currentValidationMatchesSelection ? "Draft validated"
    : selectedHasUnresolvedIssues ? "Review Patient issues"
    : "Run validation";

  const runPatientAction = async () => {
    if (savedPatients[selected] || persisting || isValidating) return;
    if (isDemoMode) {
      await runValidation();
      return;
    }
    if (patientDrafts[selected]?.identityConflict?.status === 'pending') {
      setNotice('This Patient Draft is saved, but approval is blocked until its pending identity review is resolved.');
      return;
    }
    if (saveFeedback?.rowIndex === selected && saveFeedback.kind === "mrn_conflict") { setMrnReviewOpen(true); return; }
    if (!approved || !workspace || !importId || !rows[selected]) {
      setNotice("Approve and persist all mappings, and save the source import before creating a Patient Draft.");
      if (!importId) go("Source data");
      else go("MAP");
      return;
    }
    if (selectedBirthDateIssue) {
      openBirthDateCorrection(selected);
      return;
    }
    try {
      setPersisting(true);
      const priorDraft = patientDrafts[selected];
      const draft = await savePatientDraft({
        workspace, importId, row: rows[selected], rowNumber: selected + 1, fields
      });
      setPatientDrafts(current => ({ ...current, [selected]: draft }));
      const revisions = await getPatientDraftRevisions({ workspace, draftId: draft.id });
      setDraftRevisions(current => ({ ...current, [selected]: revisions }));
      if (!priorDraft || priorDraft.revision !== draft.revision || priorDraft.status !== draft.status) {
        setValidation(false);
        setValidationResult(null);
        setValidationFor(null);
      }
      setNotice(draft.identityConflict
        ? `Patient Draft saved, but approval is blocked: MRN ${draft.identityConflict.mrn} matches ${draft.identityConflict.candidateName}. ${draft.identityConflict.requestId ? `Identity review ${draft.identityConflict.requestId} is pending.` : `Review request failed: ${draft.identityConflict.warning ?? 'unknown error'}`}`
        : draft.auditWarning
          ? `Patient Draft revision ${draft.revision} saved, but audit logging returned a warning: ${draft.auditWarning}`
          : `Patient Draft revision ${draft.revision} saved. No canonical Patient or SATUSEHAT resource was created.`);
      if (selectedHasUnresolvedIssues) {
        go("FHIR & validation");
        return;
      }
    } catch (error) {
      setNotice("Patient Draft could not be saved: " + getReadableError(error));
      return;
    } finally {
      setPersisting(false);
    }
    if (selectedHasUnresolvedIssues) {
      go("FHIR & validation");
      return;
    }
    if (currentValidationMatchesSelection) {
      setNotice("This Patient Draft passed local validation and is ready for explicit human approval. Use Approve & Save Canonical Patient to persist it. No SATUSEHAT submission was made.");
      return;
    }
    await runValidation();
  };
  const nav = [
    ["Overview", LayoutDashboard],
    ["Source data", FileSpreadsheet],
    ["SCAN", Search],
    ["MAP", GitBranch],
    ["Terminology", Database],
    ["KFA catalogue", Database],
    ["Patient records", Users],
    ["FHIR & validation", ClipboardCheck],
    ["Transactions", Activity],
    ["Audit trail", ShieldCheck],
    ...(workspace?.role === "tenant_admin" ? [["Facility access", Users] as const] : []),
    ["Settings", Settings],
  ];
  const go = (p: string) => {
    setPage(p);
    setSidebar(false);
    if (p === "SCAN" && rows.length) setActive("SCAN");
    if (p === "MAP" && rows.length) setActive("MAP");
  };
  const title = page === "Overview" ? "Good evening" : page;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <div className="brand">
          <div
            className="brand-mark"
            style={{
              width: 190,
              height: "auto",
              minWidth: 0,
              padding: 1,
              background: "#100d24",
              border: "1px solid rgba(255,255,255,0.38)",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 190px",
            }}
          >
            <img
              src="https://vffribtxjxzkydfwrqre.supabase.co/storage/v1/object/public/assets/satucore-logo-transparent-white-wordmark-preview.png"
              alt="SATUCORE — Healthcare Data Integration SaaS"
              onError={(event) => {
                event.currentTarget.style.display = "none";
                const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
                if (fallback) fallback.style.display = "flex";
              }}
              style={{
                display: "block",
                width: "100%",
                height: "auto",
                aspectRatio: "1280 / 427",
                objectFit: "contain",
              }}
            />
            <div style={{ display: "none", alignItems: "center", gap: 10, color: "#fff", fontWeight: 800, letterSpacing: "-0.5px", fontSize: 22 }}>
              <span style={{ color: "#a78bfa", fontSize: 28 }}>✣</span>
              <span>SATUCORE<small style={{ display: "block", fontSize: 8, fontWeight: 500, letterSpacing: 0 }}>Healthcare Data Integration SaaS</small></span>
            </div>
          </div>
          <button
            className="icon-btn mobile-close"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="sidebar-scroll">
        <div className="workspace-label">WORKSPACE</div>
        <div className="tenant-switch">
          <span className="tenant-icon">
            <Stethoscope size={16} />
          </span>
          <span>
            <b>{workspace?.tenantName ?? "No clinic selected"}</b>
            <small>
              {session
                ? "Authenticated tenant"
                : "Sign in to access clinic workspace"}
            </small>
          </span>
        </div>
        <div className="nav-label">PLATFORM</div>
        {nav.map(([label, Icon]) => (
          <button
            key={label as string}
            className={`nav-item ${page === label ? "active" : ""}`}
            onClick={() => go(label as string)}
          >
            <Icon size={17} />
            <span>{label as string}</span>
            {label === "Source data" && rows.length > 0 ? (
              <i className="nav-count">{rows.length}</i>
            ) : null}
          </button>
        ))}
        </div>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={17} />
            <span>
              <b>Secure by design</b>
              <small>Tenant-scoped workspace</small>
            </span>
          </div>
          <div className="profile">
            <div className="avatar">AA</div>
            <div>
              <b>{session?.user?.email ?? "Demo operator"}</b>
              <small>
                {session ? "Authenticated user" : "Hackathon preview"}
              </small>
            </div>
            <button
              className="icon-btn"
              title="Sign out"
              onClick={session ? logout : () => setShowLogin(true)}
            >
              {session ? <LogOut size={16} /> : <UserRound size={16} />}
            </button>
          </div>
        </div>
      </aside>
      {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
      <main className="main">
        <style>{`
          .topbar{position:sticky;top:0;z-index:50;isolation:isolate;background:var(--panel,#fff)}
          .workflow-journey{position:sticky;top:64px;z-index:40;align-self:stretch;flex:0 0 auto;background:var(--panel,#fff);border-bottom:1px solid var(--border,#e7e4ef);padding:12px 28px 10px;box-shadow:0 5px 18px rgba(31,20,65,.04);isolation:isolate;scroll-margin-top:64px}
          .journey-topline{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
          .journey-topline>div{display:flex;flex-direction:column;gap:2px}.journey-topline small{color:var(--muted,#777);font-size:11px}
          .journey-next{font-size:10px;font-weight:800;letter-spacing:.08em;color:#6555c7;background:#f1efff;border-radius:20px;padding:7px 10px}
          .journey-steps{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
          .journey-step{display:flex;align-items:center;gap:7px;min-width:0;border:0;background:transparent;color:var(--muted,#777);padding:5px 3px;font:inherit;font-size:11px;text-align:left;cursor:pointer}
          .journey-dot{display:inline-flex;align-items:center;justify-content:center;flex:0 0 23px;height:23px;border-radius:50%;background:#efedf4;color:#777;font-size:10px;font-weight:800}
          .journey-step.done{color:#16845b}.journey-step.done .journey-dot{background:#16845b;color:#fff}
          .journey-step.current{color:#5140b2;font-weight:800}.journey-step.current .journey-dot{background:#6555c7;color:#fff;box-shadow:0 0 0 3px #e9e5ff}
          .journey-step.locked{opacity:.5;cursor:not-allowed}
          .journey-guidance{font-size:11px;color:var(--muted,#777);margin:7px 0 0 30px}
          .patient-save-badge{display:inline-flex;align-items:center;padding:4px 8px;border-radius:20px;font-size:9px;font-weight:800;letter-spacing:.04em;white-space:nowrap}
          .patient-save-badge.saved{background:#e7f7ef;color:#137a50;border:1px solid #bce8d1}
          .patient-save-feedback{margin-top:14px;padding:13px 15px;border-radius:12px;border:1px solid #e5b7b7;background:#fff5f5;color:#8f2525;display:flex;gap:10px;align-items:flex-start}
          .patient-save-feedback.success{border-color:#bce8d1;background:#effaf4;color:#146b49}
          .patient-save-feedback .feedback-icon{flex:0 0 auto;margin-top:1px}
          .patient-save-feedback strong{display:block;font-size:12px;font-weight:850;letter-spacing:.035em;margin-bottom:4px}
          .patient-save-feedback p{margin:0 0 5px;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
          .patient-save-feedback small{display:block;font-size:11px;line-height:1.5;opacity:.9}
          .patient-field-status{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 16px;position:sticky;top:calc(64px + var(--satucore-journey-height, 112px));z-index:30;background:var(--bg,#f7f6fb);padding:8px 0;scroll-margin-top:180px}
          .patient-field-tab{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:170px;padding:11px 14px;border:1px solid #d9d4e8;border-radius:10px;background:#f5f2fc;color:#4b3a78;text-align:left}
          .patient-field-tab span{font-size:12px;font-weight:750}
          .patient-field-tab strong{font-size:9px;letter-spacing:.06em}
          .patient-field-tab.valid{border-color:#b9e5cf;background:#effaf4;color:#16734d;cursor:default}
          .patient-field-tab.error{border-color:#efb7b7;background:#fff1f1;color:#a52b35;cursor:pointer}
          .patient-field-tab.warning{border-color:#ead49b;background:#fff8e7;color:#8a6215;cursor:pointer}
          .patient-field-tab:disabled{opacity:1}
          .split-grid>.panel:first-child{min-width:0;min-height:0;display:flex;flex-direction:column}
          .split-grid>.panel:first-child>.panel-head{position:sticky;top:0;z-index:2;flex:0 0 auto;background:var(--panel,#fff)}
          .record-list{min-height:180px;max-height:min(52vh,560px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:4px}
          .record-list .record-item{width:100%;box-sizing:border-box}

          .record-entry{display:flex;flex-wrap:wrap;align-items:stretch;position:relative;border-top:1px solid #f0eef5}
          .record-entry .record-item{flex:1 1 100%;width:100%;min-width:0;border-top:0;padding-right:8px}
          .record-list::-webkit-scrollbar{width:8px}
          .record-list::-webkit-scrollbar-thumb{background:#c9c3d8;border-radius:8px}
          .record-list::-webkit-scrollbar-track{background:transparent}
          .source-correction-modal textarea{width:100%;box-sizing:border-box;border:1px solid var(--border,#ddd);border-radius:9px;padding:11px;font:inherit;resize:vertical;margin:5px 0 13px}
          .source-correction-modal input[readonly]{background:#f4f2f8;color:#625d70}
          .source-correction-blocker{display:block;margin:0 0 12px;padding:10px 12px;border:1px solid #ead6a5;border-radius:9px;background:#fff9e9;color:#76551a;font-size:12px;line-height:1.5}
          @media(max-width:760px){.topbar{top:0}.workflow-journey{top:58px;padding:10px 14px}.journey-steps{grid-template-columns:repeat(4,minmax(0,1fr))}.journey-next{font-size:9px}.journey-guidance{margin-left:0}.patient-field-status{top:calc(58px + 118px);padding:6px 0}.record-list{max-height:42vh;min-height:160px}}
          .fhir-preview-panel{min-width:0}
          .fhir-tabs{display:flex;gap:6px;padding:8px 10px 0;border-bottom:1px solid #ebe7f1}
          .fhir-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 12px;color:#777187;font-size:11px;font-weight:700;cursor:pointer}
          .fhir-tabs button.active{border-bottom-color:#7155c8;color:#5944a5}
          .patient-record-tabs{margin:14px 0 18px}
          .fhir-summary{padding:16px 18px 14px;background:#fbfaff}
          .fhir-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}
          .fhir-summary-grid>div{min-width:0;padding:10px 0;border-bottom:1px solid #ece8f3}
          .fhir-summary-grid small{display:block;margin-bottom:5px;color:#858096;font-size:10px;font-weight:650;letter-spacing:.045em;text-transform:uppercase}
          .fhir-summary-grid strong{display:block;color:#28243b;font-size:12px;font-weight:750;overflow-wrap:anywhere}
          .fhir-preview-note{margin:12px 0 0;color:#777187;font-size:10px;line-height:1.5}
          .fhir-preview-panel .json-view{max-height:360px;margin:12px;padding:14px;overflow:auto;border-radius:8px;background:#211b32;color:#e9e3f7;font-size:10px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
          @media(max-width:900px){.fhir-summary-grid{grid-template-columns:1fr}}
        `}</style>
        <header className="topbar">
          <div className="top-left">
            <button
              className="icon-btn menu-btn"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">
              Workspace <b>/</b> {page}
            </span>
          </div>
          <div className="top-actions">
            <span className="env-pill">
              <span /> {isDemoMode ? "DEMO MODE · LOCAL ONLY" : "SANDBOX PREVIEW"}
            </span>
            <button
              className="icon-btn"
              onClick={() => setNotice("You are all caught up.")}
            >
              <Bell size={18} />
            </button>
            {session ? (
              <button
                className="avatar top-avatar"
                title={session.user.email}
                onClick={() => setShowLogin(true)}
              >
                {String(session.user.email ?? "U")
                  .slice(0, 2)
                  .toUpperCase()}
              </button>
            ) : (
              <button
                className="primary-btn"
                onClick={() => setShowLogin(true)}
              >
                <UserRound size={16} /> Sign in
              </button>
            )}
          </div>
        </header>
        {rows.length > 0 && (
          <div className="workflow-journey">
            <div className="journey-topline">
              <div>
                <strong>Patient workflow</strong>
                <small>{filename || "Restored clinic import"} · {rows.length} records</small>
              </div>
              <span className="journey-next">
                {savedPatients[selected]
                  ? "CANONICAL PATIENT · NOT SUBMITTED TO SATUSEHAT"
                  : fields.length && !fields.every(f => f.approved)
                    ? "NEXT: REVIEW MAPPINGS"
                    : !importId ? "NEXT: SAVE SOURCE IMPORT"
                    : !patientDrafts[selected] || patientDrafts[selected]?.status === "stale" ? "NEXT: SAVE PATIENT DRAFT"
                    : patientDrafts[selected]?.identityConflict ? "NEXT: IDENTITY REVIEW REQUIRED"
                    : selectedHasUnresolvedIssues ? "NEXT: RESOLVE PATIENT ISSUES"
                    : !currentValidationIsFresh ? "NEXT: RUN VALIDATION"
                    : validationResult?.outcome !== "passed" ? "NEXT: REVIEW VALIDATION REPORT"
                    : "NEXT: APPROVE PATIENT"}
              </span>
            </div>
            {savedPatientStatusesReady ? (
            <div className="journey-steps">
              {(() => {
                const mappingsConfirmed = fields.length > 0 && fields.every((field) => field.approved);
                const selectedDraft = patientDrafts[selected];
                const patientReviewComplete = !!selectedDraft && selectedDraft.status !== "stale" &&
                  !selectedDraft.identityConflict && !selectedHasUnresolvedIssues && mappingsConfirmed;
                const canonicalPatientApproved = !!savedPatients[selected];
                // A saved canonical Patient completes the journey only when no identity or data-quality issue remains.
                const canonicalJourneyComplete = canonicalPatientApproved &&
                  !selectedDraft?.identityConflict && !selectedHasUnresolvedIssues;
                const steps = [
                  { label: "Upload", done: !!importId, page: "Source data" },
                  { label: "SCAN", done: !!importId, page: "SCAN" },
                  { label: "MAP", done: mappingsConfirmed, page: "MAP" },
                  { label: "Review", done: canonicalJourneyComplete || patientReviewComplete, page: "FHIR & validation" },
                  { label: "Validate", done: canonicalJourneyComplete || currentValidationMatchesSelection, page: "FHIR & validation" },
                  { label: "Approval", done: canonicalJourneyComplete, page: "FHIR & validation" },
                  { label: "Send & monitor", done: false, page: "Transactions" },
                ];
                const firstIncomplete = steps.findIndex((step) => !step.done);
                return steps.map((step, index) => {
                  const locked =
                    (index === 1 && !importId) ||
                    (index === 2 && !importId) ||
                    (index === 3 && !canonicalJourneyComplete && !mappingsConfirmed) ||
                    (index === 4 && !canonicalJourneyComplete && !patientReviewComplete) ||
                    (index === 5 && !canonicalJourneyComplete && !currentValidationMatchesSelection) ||
                    (index === 6);
                  const current = index === firstIncomplete && !locked;
                  return (
                    <button
                      type="button"
                      key={step.label}
                      className={`journey-step ${step.done ? "done" : ""} ${current ? "current" : ""} ${locked ? "locked" : ""}`}
                      onClick={() => {
                        if (locked) {
                          const message = index === 6
                            ? "SATUSEHAT submission is disabled. It requires verified backend credentials, facility Organization scope and explicit payload approval."
                            : index === 5
                              ? "Canonical Patient approval is available only after the selected Patient passes fresh validation and the explicit human approval action is completed."
                              : index === 4
                                ? "Complete Patient review first: confirm mappings, save the current draft, and resolve identity conflicts or outstanding Patient issues."
                                : index === 3
                                  ? "Confirm every proposed source-to-Patient mapping before proceeding to Patient review."
                                  : "Complete the source import before continuing.";
                          setNotice(message);
                        } else {
                          go(step.page);
                        }
                      }}
                    >
                      <span className="journey-dot">{step.done ? <Check size={13} strokeWidth={3} /> : String(index + 1)}</span>
                      <span>{step.label}</span>
                    </button>
                  );
                });
              })()}
            </div>
            ) : (
              <div className="journey-guidance">Restoring this clinic's saved Patient statuses…</div>
            )}
            <div className="journey-guidance">
              <span>{savedPatients[selected]
                ? "This Patient is already canonical. The FHIR resource is prepared locally and has not been submitted to SATUSEHAT."
                : !importId
                ? "Persist the source import in the authenticated clinic workspace before creating a Patient draft."
                : fields.length > 0 && !fields.every((field) => field.approved)
                  ? "MAP is not complete: review every proposed source-to-Patient mapping and confirm the mappings."
                  : !patientDrafts[selected] || patientDrafts[selected]?.status === "stale"
                    ? "Mapping is confirmed. Save the tenant-scoped Patient Draft; original source data remains preserved and material changes create an auditable revision."
                    : patientDrafts[selected]?.identityConflict
                      ? "Patient review is blocked by an identity conflict. Resolve it through the human identity-review process; do not merge automatically."
                      : selectedHasUnresolvedIssues
                        ? "Patient review is not complete. Resolve outstanding Patient issues before running validation."
                        : !currentValidationMatchesSelection
                          ? "Patient review is complete. Run validation against this exact saved draft revision and approved mapping set."
                          : savedPatients[selected]
                            ? "Canonical Patient is saved. It has not been sent to SATUSEHAT; submission remains disabled pending verified authorization and facility scope."
                            : "Validation passed for this draft revision. Use Approve & Save Canonical Patient for explicit human approval; SATUSEHAT sending remains disabled."}</span>
            </div>
          </div>
        )}
        <div className="content">
          {notice && (
            <div className="notice">
              <span>{notice}</span>
              <button onClick={() => setNotice("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {workspace?.availableOrganizations?.length ? (
            <>
              <PageTitle eyebrow="FACILITY SELECTION" title="Choose your facility" desc="Your account has access to multiple facilities. Select the Organization for this working session before accessing clinical data." />
              <div className="panel settings-panel">
                {workspace.availableOrganizations.map((organization) => (
                  <div className="settings-line" key={organization.id}>
                    <span><b>{organization.name}</b><small>Authorized facility · {organization.id}</small></span>
                    <button className="primary-btn" onClick={async () => {
                      const selectedWorkspace = { ...workspace, organizationId: organization.id, organizationName: organization.name, availableOrganizations: undefined };
                      setWorkspace(selectedWorkspace);
                      setTenant(organization.name);
                      setNotice("Facility selected: " + organization.name + ". Loading only this facility's latest import.");
                      try {
                        const restored = await restoreLatestImport(selectedWorkspace);
                        if (restored) {
                          setIsDemoMode(false);
                          setImportId(restored.importId);
                          setFilename(restored.filename);
                          setRows(restored.rows);
                          setFields(restored.fields);
                          setApproved(restored.fields.length > 0 && restored.fields.every(f => f.approved));
                          setActive(restored.fields.length ? "MAP" : "SCAN");
                          setPage(restored.fields.length && restored.fields.every(f => f.approved) ? "FHIR & validation" : "MAP");
                          setNotice("Facility selected. Its latest import and mapping decisions have been restored.");
                        } else {
                          setImportId(null);
                          setRows([]);
                          setFields([]);
                          setPage("Overview");
                          setNotice("Facility selected: " + organization.name + ". No prior import exists for this facility.");
                        }
                      } catch (error) {
                        setNotice("Facility selected, but its previous import could not be restored: " + getReadableError(error));
                      }
                    }}>Open facility <ArrowRight size={15}/></button>
                  </div>
                ))}
              </div>
            </>
          ) : workspace && !workspace.organizationId ? (
            <div className="empty-state">
              <div className="empty-icon"><ShieldCheck size={28}/></div>
              <h3>No facility access assigned</h3>
              <p>Your tenant membership is active, but no Organization has been assigned to your account. Ask your tenant administrator to grant access. No clinical facility data is available in this session.</p>
            </div>
          ) : page === "Overview" ? (
            <>
              <div className="welcome-row">
                <div>
                  <div className="eyebrow">
                    <Sparkles size={14} /> LEGACY DATA INTELLIGENCE
                  </div>
                  <h1>{title}, operator.</h1>
                  <p>
                    Prepare your clinic data for trusted healthcare
                    interoperability.
                  </p>
                </div>
                <button
                  className="primary-btn"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload size={16} /> Import legacy data
                </button>
              </div>
              <div className="hero-card">
                <div className="hero-copy">
                  <div className="hero-kicker">
                    YOUR INTEROPERABILITY WORKFLOW
                  </div>
                  <h2>
                    From legacy data
                    <br />
                    <em>to connected care.</em>
                  </h2>
                  <p>
                    One governed pathway to understand, standardize and prepare
                    clinical data for SATUSEHAT.
                  </p>
                  <button
                    className="hero-btn"
                    onClick={() => (rows.length ? go("SCAN") : loadDemo())}
                  >
                    {" "}
                    {rows.length
                      ? "Continue workflow"
                      : "Explore with synthetic data"}{" "}
                    <ArrowRight size={16} />
                  </button>
                </div>
                <div className="hero-graphic">
                  <div className="orb orb-one" />
                  <div className="orb orb-two" />
                  <div className="orbit orbit-a" />
                  <div className="orbit orbit-b" />
                  <div className="core">
                    <HeartPulse size={38} />
                  </div>
                  <div className="orbit-node node-a">
                    <Database size={17} />
                  </div>
                  <div className="orbit-node node-b">
                    <ShieldCheck size={17} />
                  </div>
                  <div className="orbit-node node-c">
                    <GitBranch size={17} />
                  </div>
                  <div className="orbit-node node-d">
                    <Activity size={17} />
                  </div>
                </div>
                <div className="hero-foot">
                  <span>
                    <span className="live-dot" /> PATIENT-FIRST MVP
                  </span>
                  <span>FHIR R4 · TENANT-AWARE · HUMAN-APPROVED</span>
                </div>
              </div>
              <div className="section-head">
                <div>
                  <h3>Workspace overview</h3>
                  <p>Live workspace indicators</p>
                </div>
                <span className="muted-tag">DEMO DATA ONLY</span>
              </div>
              <div className="metric-grid">
                <Metric
                  icon={Database}
                  label="Imported records"
                  value={rows.length.toLocaleString()}
                  note={
                    rows.length ? "Current dataset" : "Awaiting first import"
                  }
                  tone="purple"
                />
                <Metric
                  icon={CircleAlert}
                  label="Data quality flags"
                  value={rows.length ? missing.toLocaleString() : "—"}
                  note={
                    rows.length ? "Blank cells detected" : "No scan run yet"
                  }
                  tone="amber"
                />
                <Metric
                  icon={GitBranch}
                  label="Mappings approved"
                  value={fields.filter((f) => f.approved).length.toString()}
                  note={
                    fields.length
                      ? `of ${fields.length} source fields`
                      : "Awaiting mapping"
                  }
                  tone="blue"
                />
                <Metric
                  icon={BadgeCheck}
                  label="FHIR validated"
                  value={validation ? "1" : "0"}
                  note={
                    validation ? "Local checks passed" : "Not yet validated"
                  }
                  tone="green"
                />
              </div>
              <div className="bottom-grid">
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h3>Processing pipeline</h3>
                      <p>Human-governed data preparation</p>
                    </div>
                    <span className="status-chip">
                      • {rows.length ? "IN PROGRESS" : "READY"}
                    </span>
                  </div>
                  <div className="pipeline">
                    {[
                      "SCAN",
                      "MAP",
                      "VALIDATE",
                      "APPROVAL",
                      "SEND",
                      "MONITOR",
                    ].map((s, i) => (
                      <button
                        key={s}
                        className={`pipe-step ${active === s ? "selected" : ""} ${i === 0 && rows.length ? "done" : ""}`}
                        onClick={() => {
                          if (s === "SCAN") go("SCAN");
                          else if (s === "MAP") go("MAP");
                          else if (s === "VALIDATE") go("FHIR & validation");
                          else
                            setNotice(
                              s === "SEND"
                                ? "Submission is disabled until backend authorization, facility scope and exact-payload approval are verified."
                                : "This workflow stage is reserved for the approved submission and monitoring process.",
                            );
                        }}
                      >
                        <span className="pipe-num">
                          {i === 0 && rows.length ? (
                            <Check size={14} />
                          ) : (
                            String(i + 1).padStart(2, "0")
                          )}
                        </span>
                        <b>{s}</b>
                        {i < 5 && <span className="pipe-line" />}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="panel quick-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Quick actions</h3>
                      <p>Continue your workflow</p>
                    </div>
                  </div>
                  <button
                    className="quick-action"
                    onClick={() => fileRef.current?.click()}
                  >
                    <span className="quick-icon purple">
                      <CloudUpload size={18} />
                    </span>
                    <span>
                      <b>Import source file</b>
                      <small>Upload a CSV patient register</small>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                  <button className="quick-action" onClick={loadDemo}>
                    <span className="quick-icon blue">
                      <Sparkles size={18} />
                    </span>
                    <span>
                      <b>Load synthetic dataset</b>
                      <small>Explore the patient workflow</small>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : page === "Source data" ? (
  <>
    <PageTitle
      eyebrow="DATA INGESTION"
      title="Source data"
      desc="Upload and inspect original legacy records before running the SCAN assessment."
      action={
        <button
          className="primary-btn"
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={16} /> Upload CSV
        </button>
      }
    />
    {!rows.length ? (
      <div className="empty-state">
        <div className="empty-icon">
          <FileSpreadsheet size={28} />
        </div>
        <h3>No source file loaded</h3>
        <p>
          Upload a CSV file or explore the workflow with synthetic patient records.
        </p>
        <button className="primary-btn" onClick={loadDemo}>
          <Sparkles size={16} /> Load synthetic data
        </button>
      </div>
    ) : (
      <>
        <div className="data-summary">
          <div>
            <small>SOURCE FILE</small>
            <b><FileSpreadsheet size={16} /> {filename}</b>
          </div>
          <div>
            <small>SOURCE RECORDS</small>
            <b>{rows.length}</b>
          </div>
          <div>
            <small>SOURCE FIELDS</small>
            <b>{columns.length}</b>
          </div>
          <div>
            <small>BLANK VALUES</small>
            <b className={missing ? "warn-text" : ""}>{missing}</b>
          </div>
        </div>

        <div className="panel table-panel">
          <div className="panel-head">
            <div>
              <h3>Original source data</h3>
              <p>
                First {Math.min(rows.length, 8)} records · {columns.length} detected columns
              </p>
            </div>
            <span className="status-chip">SOURCE PREVIEW</span>
          </div>

          {opsRows.some(
            (t: any) =>
              t.transaction_status === "retry_pending" ||
              t.error_code === "network_outcome_unknown",
          ) && (
            <div className="reconciliation-alert reconciliation-warning">
              <strong>Submission outcome unknown</strong>
              <p>
                A Patient submission may have reached SATUSEHAT, but confirmation is
                incomplete. Verify the Patient in SATUSEHAT before attempting any retry.
              </p>
              <span>DO NOT RETRY AUTOMATICALLY</span>
            </div>
          )}

          {opsRows.some(
            (t: any) => t.error_message_sanitized?.includes("reconciliation"),
          ) && (
            <div className="reconciliation-alert reconciliation-critical">
              <strong>Local reconciliation required</strong>
              <p>
                SATUSEHAT may have created the Patient, but local persistence is
                incomplete. Verify the SATUSEHAT Patient ID and reconcile the local
                records before taking further action.
              </p>
              <span>MANUAL VERIFICATION REQUIRED</span>
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c}>
                        {r[c] || <span className="missing">Empty</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-foot">
            <span className="foot-note">
              {importId
                ? "Persisted import · " + importId.slice(0, 8)
                : "Local preview only"}
            </span>
            <div className="action-row">
              <button
                className="secondary-btn"
                disabled={persisting || !workspace || !!importId}
                onClick={saveImport}
              >
                {persisting
                  ? "Saving..."
                  : importId
                    ? "Saved"
                    : "Save to tenant"}
              </button>
              <button className="primary-btn" onClick={() => go("SCAN")}>
                Run SCAN <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </>
    )}
  </>
) : page === "SCAN" ? (
  <>
    <PageTitle
      eyebrow="DATA QUALITY ASSESSMENT"
      title="SCAN"
      desc="Review deterministic record-level validation, completeness and duplicate-identifier findings before mapping."
      action={
        <button className="secondary-btn" onClick={() => go("Source data")}>
          <FileSpreadsheet size={16} /> Back to Source Data
        </button>
      }
    />

    {!rows.length ? (
      <div className="empty-state">
        <div className="empty-icon">
          <Search size={28} />
        </div>
        <h3>Nothing to scan yet</h3>
        <p>Load or upload source records first. SCAN will then assess the available records.</p>
        <button className="primary-btn" onClick={() => go("Source data")}>
          Open Source Data <ArrowRight size={16} />
        </button>
      </div>
    ) : (
      <>
        <div className="data-summary">
          <div>
            <small>TOTAL RECORDS</small>
            <b>{rows.length}</b>
          </div>
          <div>
            <small>CLEAN</small>
            <b>{recordScanStatuses.filter((s) => s.status === "clean").length}</b>
          </div>
          <div>
            <small>INVALID</small>
            <b className="warn-text">
              {recordScanStatuses.filter((s) => s.status === "invalid").length}
            </b>
          </div>
          <div>
            <small>MISSING DATA</small>
            <b className="warn-text">
              {recordScanStatuses.filter((s) => s.status === "missing").length}
            </b>
          </div>
          <div>
            <small>DUPLICATE RECORDS</small>
            <b className="warn-text">
              {recordScanStatuses.filter((s) => s.status === "duplicate").length}
            </b>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <h3>SCAN assessment</h3>
              <p>
                Local deterministic checks · status priority: invalid, missing,
                duplicate, clean
              </p>
            </div>
            <span className="status-chip">LOCAL PROFILE</span>
          </div>
          <div className="finding-list">
            <Finding
              icon={Check}
              tone="green"
              title="Source structure readable"
              detail={`${columns.length} source fields detected across ${rows.length} records.`}
            />
            <Finding
              icon={CircleAlert}
              tone={recordScanStatuses.some((s) => s.status === "invalid") ? "amber" : "green"}
              title="Patient validation assessment"
              detail={`${recordScanStatuses.filter((s) => s.status === "invalid").length} records have local Patient validation errors.`}
            />
            <Finding
              icon={CircleAlert}
              tone={recordScanStatuses.some((s) => s.status === "missing") ? "amber" : "green"}
              title="Source completeness assessment"
              detail={`${recordScanStatuses.filter((s) => s.status === "missing").length} records have blank source fields.`}
            />
            <Finding
              icon={CircleAlert}
              tone={duplicateDisplay.count > 0 ? "amber" : "green"}
              title="Duplicate identifier assessment"
              detail={`${duplicateDisplay.count} duplicate identifier groups detected using ${duplicateDisplay.field || "no approved identifier mapping"}.`}
            />
          </div>
        </div>

        <div className="panel table-panel">
          <div className="panel-head">
            <div>
              <h3>Record-level findings</h3>
              <p>Each highlighted source cell identifies the location of a detected data-quality or identity finding.</p>
            </div>
            <span className="status-chip">CELL-LEVEL REVIEW</span>
          </div>

          <div className="scan-legend" aria-label="SCAN cell highlight legend">
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-invalid" />
              <span><strong>Red</strong> · Invalid value</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-missing" />
              <span><strong>Amber</strong> · Missing expected value</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-duplicate-0" />
              <span><strong>Blue</strong> · Duplicate group</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-duplicate-1" />
              <span><strong>Purple</strong> · Duplicate group</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-duplicate-2" />
              <span><strong>Teal</strong> · Duplicate group</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-duplicate-3" />
              <span><strong>Orange</strong> · Duplicate group</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-duplicate-4" />
              <span><strong>Pink</strong> · Duplicate group</span>
            </div>
            <div className="scan-legend-item">
              <span className="scan-legend-swatch scan-legend-duplicate-5" />
              <span><strong>Grey</strong> · Duplicate group</span>
            </div>
            <p className="scan-legend-note">
              Each duplicate group receives one consistent color. Hover over a highlighted cell to read its finding.
              Unhighlighted cells have no issue detected by these SCAN checks.
            </p>
          </div>

          <div className="table-wrap">
            <table className="scan-cell-table">
              <thead>
                <tr>
                  <th className="scan-index-heading">RECORD</th>
                  {columns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td className="scan-record-index">{i + 1}</td>
                    {columns.map((c) => {
                      const finding = getScanCellFinding(i, c);
                      const cellClass = finding?.classes.join(" ") ?? "";
                      const explanation = finding?.messages.join(" | ") ?? "";

                      return (
                        <td
                          key={c}
                          className={`scan-cell ${cellClass}`}
                          title={explanation || undefined}
                          aria-label={explanation || `${c}: ${String(r[c] ?? "")}`}
                        >
                          {String(r[c] ?? "").trim()
                            ? r[c]
                            : <span className="scan-empty-value">Empty</span>}
                          {finding && finding.messages.length > 1 && (
                            <span className="scan-cell-multiple" aria-label="Multiple findings">!</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-foot">
            <span className="foot-note">
              Local deterministic profile · No SATUSEHAT submission performed
            </span>
            <div className="action-row">
              <button className="secondary-btn" onClick={() => go("Source data")}>
                Back to Source Data
              </button>
              <button className="primary-btn" onClick={() => go("MAP")}>
                Continue to MAP <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </>
    )}
  </>
) : page === "MAP" ? (
            <>
              <PageTitle
                eyebrow="FIELD INTERPRETATION"
                title="MAP · Source to Patient"
                desc="Review suggested mappings. Approve each field deliberately before normalization."
              />
              <div className="callout">
                <Sparkles size={18} />
                <span>
                  <b>Transparent deterministic suggestions</b>
                  <small>
                    Suggestions use source-column names and patterns. They are
                    not clinical authority and are not generated by a connected
                    AI model.
                  </small>
                </span>
              </div>
              {getPatientMappingIssues(fields).length > 0 && (
                <div className="reconciliation-alert reconciliation-critical">
                  <strong>Mapping conflicts detected</strong>
                  {getPatientMappingIssues(fields).map((issue, index) => (
                    <p key={`${issue.code}-${index}`}>{issue.message}</p>
                  ))}
                  <span>Correct the mappings before approval. No automatic remapping will occur.</span>
                </div>
              )}
              {!fields.length ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <GitBranch size={28} />
                  </div>
                  <h3>No fields to map</h3>
                  <p>
                    Load a CSV or synthetic dataset to start field
                    interpretation.
                  </p>
                  <button className="primary-btn" onClick={loadDemo}>
                    Load synthetic data
                  </button>
                </div>
              ) : (
                <>
                  <div className="panel table-panel">
                    <div className="panel-head">
                      <div>
                        <h3>Mapping review</h3>
                        <p>
                          {fields.filter((f) => f.approved).length} of{" "}
                          {fields.length} fields approved
                        </p>
                      </div>
                      <span className="status-chip">
                        {fields.every((f) => f.approved)
                          ? "REVIEWED"
                          : "NEEDS REVIEW"}
                      </span>
                    </div>
                    <div className="mapping-list">
                      {fields.map((f, i) => (
                        <div className="mapping-row" key={f.source}>
                          <div className="mapping-source">
                            <span className="field-icon">
                              <Table2 size={16} />
                            </span>
                            <span>
                              <b>{f.source}</b>
                              <small>Source column</small>
                            </span>
                          </div>
                          <ArrowRight size={17} className="map-arrow" />
                          <div className="mapping-target">
                            <select
                              value={f.target}
                              onChange={(e) => updateField(i, e.target.value)}
                            >
                              <option value="—">Do not map</option>
                              {targets.map((t) => (
                                <option key={t}>{t}</option>
                              ))}
                            </select>
                            <small>{f.target === "national_identifier" ? "Canonical only · not sent to FHIR" : "FHIR Patient field"}</small>
                          </div>
                          <div className="confidence">
                            <b>
                              {f.confidence
                                ? Math.round(f.confidence * 100) + "%"
                                : "Manual"}
                            </b>
                            <small>Suggestion</small>
                          </div>
                          <button
                            className={`approve-btn ${f.approved ? "approved" : ""}`}
                            onClick={() => toggleApprove(i)}
                          >
                            {f.approved ? (
                              <>
                                <Check size={15} /> Approved
                              </>
                            ) : (
                              <>Approve</>
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="panel-foot">
                      <span className="foot-note">
                        Only reviewed mappings are used to create the canonical
                        preview.
                      </span>
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={
                          !fields.length ||
                          !fields.every(
                            (f) => f.approved,
                          ) ||
                          getPatientMappingIssues(fields).length > 0 ||
                          persisting
                        }
                        onClick={async () => {
                          if (importId && workspace) {
                            const saved = await saveMapping();
                            if (!saved) return;
                          } else {
                            setApproved(true);
                            setNotice(
                              "Mappings approved in this browser preview only. Sign in and persist the import and mapping decisions before saving a canonical Patient.",
                            );
                          }
                          go("FHIR & validation");
                        }}
                      >
                        Confirm mappings & continue <ArrowRight size={16} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : page === "FHIR & validation" ? (
            <>
              <PageTitle
                eyebrow="FHIR R4"
                title="Patient resource & validation"
                desc="Preview the normalized Patient resource and run local structural checks."
                action={
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={!rows[selected] || persisting || isValidating || !approved || (isDemoMode ? !fields.length || !fields.every((field) => field.approved) : !workspace || !importId)}
                    onClick={isDemoMode ? runValidation : runPatientAction}
                  >
                    <ShieldCheck size={16} /> {patientActionLabel}
                  </button>
                }
              />
              {!rows.length ? (
                <div className="empty-state">
                  <h3>No patient dataset</h3>
                  <p>
                    Load synthetic data and approve its field mappings first.
                  </p>
                  <button className="primary-btn" onClick={loadDemo}>
                    Load synthetic data
                  </button>
                </div>
              ) : (
                <>
                  <div className="action-row patient-field-status" aria-label="Patient source field status">
                    {([
                      { target: "name" as const, label: "Patient name", value: String(rows[selected]?.[fields.find(f => f.target === "name" && f.approved)?.source ?? ""] ?? "") },
                      { target: "identifier" as const, label: "MRN", value: String(rows[selected]?.[fields.find(f => f.target === "identifier" && f.approved)?.source ?? ""] ?? "") },
                      { target: "birthDate" as const, label: "Date of birth", value: String(rows[selected]?.[fields.find(f => f.target === "birthDate" && f.approved)?.source ?? ""] ?? "") },
                      { target: "gender" as const, label: "Administrative gender", value: String(rows[selected]?.[fields.find(f => f.target === "gender" && f.approved)?.source ?? ""] ?? "") },
                    ]).map((field) => {
                      const issue = selectedCorrectionIssues[field.target];
                      const hasApprovedMapping = fields.some((mapping) => mapping.target === field.target && mapping.approved);
                      const isProblem = !!issue || !field.value.trim();
                      const status = isProblem ? (field.target === "identifier" ? "warning" : "error") : "valid";
                      return (
                        <button
                          key={field.target}
                          type="button"
                          className={`patient-field-tab ${status}`}
                          disabled={!isProblem || !hasApprovedMapping}
                          aria-label={`${field.label}: ${isProblem ? "needs correction" : "correct"}`}
                          onClick={() => openPatientSourceCorrection(field.target, selected)}
                        >
                          <span>{field.label}</span>
                          <strong>{isProblem ? (field.target === "identifier" ? "REVIEW" : "CORRECTION REQUIRED") : "CORRECT"}</strong>
                        </button>
                      );
                    })}
                  </div>
                  <div className="split-grid">
                    <div className="panel">
                      <div className="panel-head">
                        <div>
                          <h3>Source record</h3>
                          <p>Select a synthetic patient record</p>
                        </div>
                      </div>
                      <div className="record-list">
                        {rows.map((r, i) => (
                          <div className="record-entry" key={i}>
                            <span className={`record-status-line ${getRecordScanClass(i)}`} aria-hidden="true" />
                          <button
                            type="button"
                            className={`record-item ${selected === i ? "chosen" : ""}`}
                            onClick={() => {
                              setSelected(i);
                              setSaveFeedback(null);
                              setValidation(false); setValidationResult(null);
                              setDemoValidationResult(null);
                              const birthDateIssue = validatePatientLocally(r, fields).find(
                                (issue) => ["BIRTH_DATE_INVALID", "BIRTH_DATE_MISSING", "BIRTH_DATE_FUTURE"].includes(issue.code),
                              );
                              if (birthDateIssue) {
                                const birthDateMapping = fields.find(
                                  (field) => field.target === "birthDate" && field.approved,
                                );
                                if (birthDateMapping) {
                                  setCorrectionTarget("birthDate");
                                  setCorrectionValue(String(r[birthDateMapping.source] ?? ""));
                                  setCorrectionReason("");
                                  setShowSourceCorrection(true);
                                  setNotice(`Invalid date of birth detected for ${String(r[fields.find((field) => field.target === "name" && field.approved)?.source ?? ""] ?? "this Patient")}. Correct it using verified source evidence.`);
                                } else {
                                  setNotice("Invalid date of birth detected, but no approved birthDate mapping is available.");
                                }
                              }
                            }}
                          >
                            <span className="avatar patient-avatar">
                              {String(
                                r[
                                  fields.find((f) => f.target === "name")
                                    ?.source ?? ""
                                ] ?? "P",
                              ).slice(0, 1)}
                            </span>
                            <span>
                              <b>
                                {r[
                                  fields.find((f) => f.target === "name")
                                    ?.source ?? ""
                                ] || "Unnamed record"}
                              </b>
                              <small>
                                {r[
                                  fields.find((f) => f.target === "identifier")
                                    ?.source ?? ""
                                ] || "No MRN"}
                              </small>
                              <small className={`record-scan-label ${getRecordScanClass(i)}`}>{getRecordScanLabel(i)}</small>
                            </span>
                            {savedPatients[i]
                              ? <span className="patient-save-badge saved">CANONICAL</span>
                              : patientDrafts[i]?.status === "validated"
                                ? <span className="patient-save-badge saved">VALIDATED</span>
                                : patientDrafts[i]
                                  ? <span className="patient-save-badge">DRAFT · R{patientDrafts[i].revision}</span>
                                  : <span className="patient-save-badge">NOT SAVED</span>}
                          </button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="panel fhir-preview-panel">
                      <div className="panel-head">
                        <div>
                          <h3>FHIR Patient · R4</h3>
                          <p>{savedPatients[selected] ? "FHIR resource prepared · not submitted" : "Generated preview · not submitted"}</p>
                        </div>
                        <span className="status-chip">{savedPatients[selected] ? "PREPARED" : "DRAFT"}</span>
                      </div>
                      <div className="fhir-tabs" role="tablist" aria-label="FHIR Patient views">
                        <button type="button" role="tab" aria-selected={fhirViewTab === "summary"} className={fhirViewTab === "summary" ? "active" : ""} onClick={() => setFhirViewTab("summary")}>Patient summary</button>
                        <button type="button" role="tab" aria-selected={fhirViewTab === "json"} className={fhirViewTab === "json" ? "active" : ""} onClick={() => setFhirViewTab("json")}>FHIR JSON</button>
                      </div>
                      {fhirViewTab === "summary" ? (
                        <div className="fhir-summary" role="tabpanel">
                          <div className="fhir-summary-grid">
                            <div><small>Patient name</small><strong>{fhir.name?.[0]?.text || "Not populated"}</strong></div>
                            <div><small>Medical record number</small><strong>{fhir.identifier?.[0]?.value || "Not populated"}</strong></div>
                            <div><small>Date of birth</small><strong>{fhir.birthDate || "Not populated"}</strong></div>
                            <div><small>Administrative gender</small><strong>{fhir.gender || "Not populated"}</strong></div>
                          </div>
                          <p className="fhir-preview-note">FHIR R4 resource prepared locally for review. Not submitted to SATUSEHAT.</p>
                        </div>
                      ) : (
                        <div role="tabpanel">
                          <pre className="json-view">{JSON.stringify(fhir, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="panel">
                    <div className="panel-head">
                      <div>
                        <h3>Validation results</h3>
                        <p>
                          Generic local checks are distinct from SATUSEHAT
                          profile conformance.
                        </p>
                      </div>
                      <span
                        className={`status-chip ${(currentValidationIsFresh || demoValidationIsFresh) ? "success-chip" : ""}`}
                      >
                        {demoValidationIsFresh ? "DEMO · LOCAL" : currentValidationIsFresh ? "CHECKED" : validationResult ? "STALE" : "NOT RUN"}
                      </span>
                    </div>
                    {patientDrafts[selected] && (
                      <div className="finding-list">
                        <Finding icon={patientDrafts[selected].status === "validated" ? Check : CircleAlert}
                          tone={patientDrafts[selected].status === "validated" ? "green" : "blue"}
                          title={`Patient Draft · ${patientDrafts[selected].status.toUpperCase()} · revision ${patientDrafts[selected].revision}`}
                          detail={`Draft ID: ${patientDrafts[selected].id} · Updated: ${new Date(patientDrafts[selected].updated_at).toLocaleString()}`} />
                        <Finding icon={GitBranch} tone="blue"
                          title={`Revision history · ${(draftRevisions[selected] ?? []).length} snapshot(s)`}
                          detail={(draftRevisions[selected] ?? []).slice(0, 3).map((revision: any) => `R${revision.revision} · ${new Date(revision.created_at).toLocaleString()}`).join(" | ") || "No revision snapshots returned yet."} />
                        {patientDrafts[selected].identityConflict && (
                          <>
                          <Finding icon={CircleAlert} tone="amber"
                            title="Potential existing Patient · identity review required"
                            detail={`Incoming ${patientDrafts[selected].identityConflict.incomingName} · existing ${patientDrafts[selected].identityConflict.candidateName} · MRN ${patientDrafts[selected].identityConflict.mrn}. Date of birth ${patientDrafts[selected].identityConflict.birthDateMatch ? 'matches' : 'does not match / unavailable'}; gender ${patientDrafts[selected].identityConflict.genderMatch ? 'matches' : 'does not match / unavailable'}. ${patientDrafts[selected].identityConflict.requestId ? `Review request ${patientDrafts[selected].identityConflict.requestId} is pending.` : `Review request could not be created: ${patientDrafts[selected].identityConflict.warning ?? 'permission or database error'}`}`} />
                          {patientDrafts[selected].identityConflict.status !== "pending" && (
                            <button type="button" className="secondary-btn" disabled={!workspace || !importId || persisting || isValidating}
                              onClick={() => { setMrnReviewReason(""); setMrnReviewOpen(true); }}>
                              Request human identity review
                            </button>
                          )}
                          </>
                        )}
                      </div>
                    )}
                    {demoValidationIsFresh ? (
                      <div className="finding-list">
                        <Finding icon={demoValidationResult?.outcome === "failed" ? CircleAlert : Check}
                          tone={demoValidationResult?.outcome === "failed" ? "amber" : demoValidationResult?.outcome === "warning" ? "blue" : "green"}
                          title={`DEMO · Browser-only deterministic checks · ${demoValidationResult?.outcome.toUpperCase()}`}
                          detail="Synthetic data only. This result is not persisted, has no report ID or audit event, and is not a SATUSEHAT conformance result." />
                        {demoValidationResult?.issues.length ? demoValidationResult.issues.map((issue, i) => (
                          <Finding key={i} icon={CircleAlert} tone={issue.severity === "error" ? "amber" : "blue"}
                            title={issue.code} detail={issue.message + (issue.path ? " · " + issue.path : "")} />
                        )) : (
                          <Finding icon={Check} tone="green" title="Local Patient checks passed"
                            detail="No blocking issues were detected by the available deterministic local checks." />
                        )}
                        <Finding icon={CircleAlert} tone="amber" title="SATUSEHAT profile validation not executed"
                          detail="Applicable official SATUSEHAT StructureDefinition and terminology rules have not been executed." />
                        <Finding icon={LockKeyhole} tone="blue" title="Persistence and submission disabled"
                          detail="Canonical Patient save, tenant audit persistence and SATUSEHAT transmission are unavailable in Demo Mode." />
                      </div>
                    ) : validationResult ? (
                      <div className="finding-list">
                        <Finding icon={validationResult.outcome === "failed" ? CircleAlert : Check} tone={validationResult.outcome === "failed" ? "amber" : "green"} title={`Local deterministic checks · ${validationResult.outcome.toUpperCase()}`} detail={`Supported local checks only; FHIR R4 structural scope is partial. SHA-256: ${validationResult.payloadHash}`} />
                        {validationResult.issues.length ? (
                          validationResult.issues.map((issue, i) => (
                            <Finding
                              key={i}
                              icon={
                                issue.severity === "error"
                                  ? CircleAlert
                                  : CircleAlert
                              }
                              tone={
                                issue.severity === "error" ? "amber" : "blue"
                              }
                              title={issue.code}
                              detail={
                                issue.message +
                                (issue.path ? " · " + issue.path : "")
                              }
                            />
                          ))
                        ) : (
                          <Finding
                            icon={Check}
                            tone="green"
                            title="Local Patient checks passed"
                            detail="No blocking issues were detected by deterministic local checks."
                          />
                        )}
                        <Finding
                          icon={CircleAlert}
                          tone="amber"
                          title="SATUSEHAT profile validation not yet executed."
                          detail="Applicable official StructureDefinition and terminology rules are not executed here."
                        />
                      </div>
                    ) : (
                      <div className="validation-prompt">
                        <ShieldCheck size={22} />
                        <span>
                          {!approved
                            ? "Approve all mappings to enable deterministic validation."
                            : patientDrafts[selected]?.identityConflict
                              ? "Resolve the pending Patient identity review before validation and approval."
                              : "Run deterministic validation for this saved Patient Draft."}
                        </span>
                      </div>
                    )}
                    {validationError && !validationResult && !demoValidationIsFresh && <div className="patient-save-feedback" role="alert" aria-live="assertive"><CircleAlert className="feedback-icon" size={18}/><div><strong>Validation report unavailable</strong><p>{validationError}</p><small>Check tenant access, the persisted mapping approval, and validation report persistence, then retry.</small></div></div>}
                    <div className="panel-foot">
                      <span className="foot-note">
                        SATUSEHAT submission: NOT SUBMITTED. No request is sent from this screen.
                      </span>
                      <div className="action-row">
                        {patientDrafts[selected] && (
                          <span className={`patient-save-badge ${patientDrafts[selected].status === "validated" ? "saved" : ""}`}>
                            {patientDrafts[selected].status.toUpperCase()} · REVISION {patientDrafts[selected].revision}
                          </span>
                        )}
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={persisting || isValidating || !!savedPatients[selected] || (!approved || (isDemoMode ? !fields.length || !fields.every((field) => field.approved) : !workspace || !importId))}
                          onClick={isDemoMode ? runValidation : runPatientAction}
                        >
                          {patientActionLabel}
                        </button>
                        {!isDemoMode && !savedPatients[selected] && (
                          <button
                            type="button"
                            className="primary-btn"
                            disabled={
                              persisting ||
                              isValidating ||
                              !workspace ||
                              !importId ||
                              !currentValidationMatchesSelection ||
                              !!patientDrafts[selected]?.identityConflict ||
                              selectedHasUnresolvedIssues
                            }
                            onClick={saveCanonicalPatient}
                            title={
                              savedPatients[selected]
                                ? "This Patient is already canonical"
                                : patientDrafts[selected]?.identityConflict
                                  ? "Blocked: resolve the identity conflict before canonical approval"
                                  : selectedHasUnresolvedIssues
                                    ? "Blocked: resolve all Patient validation issues first"
                                    : !currentValidationMatchesSelection
                                      ? "Run validation successfully for this exact Patient draft before approval"
                                      : "Explicitly approve and persist this validated Patient in the active tenant"
                            }
                          >
                            <ShieldCheck size={16} /> Approve & Save Canonical Patient
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={isDemoMode || persisting || isValidating || !!savedPatients[selected] || !!patientDrafts[selected]?.identityConflict || !workspace || !importId}
                          title={patientDrafts[selected]?.identityConflict ? "Resolve the pending identity review before proceeding" : patientDrafts[selected]?.status === "validated" ? "Open SATUSEHAT staging connectivity settings" : "Save and validate this Patient Draft first"}
                          onClick={() => go("Settings")}
                        >
                          {patientDrafts[selected]?.status === "validated" ? "Sandbox readiness" : "Sandbox not ready"} <LockKeyhole size={15} />
                        </button>
                      </div>
                      {saveFeedback?.rowIndex === selected && (
                        <div
                          className={`patient-save-feedback ${savedPatients[selected] ? "success" : ""}`}
                          role="status"
                          aria-live="polite"
                        >
                          {savedPatients[selected] ? (
                            <Check className="feedback-icon" size={18} />
                          ) : (
                            <CircleAlert className="feedback-icon" size={18} />
                          )}
                          <div>
                            <strong>{saveFeedback.title}</strong>
                            <p>{`Patient: ${String(rows[selected]?.[fields.find(f => f.target === "name")?.source ?? ""] ?? "Unnamed record")} · MRN: ${String(rows[selected]?.[fields.find(f => f.target === "identifier")?.source ?? ""] ?? "Not supplied")}`}</p>
                            <p>{saveFeedback.message}</p>
                            <small>{saveFeedback.action}</small>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          ) : page === "Transactions" ? (
            <>
              <PageTitle
                eyebrow="INTEGRATION MONITOR"
                title="SATUSEHAT Monitor"
                desc="Monitor real backend requests, responses and reconciliation states for this clinic."
              />
              {workspace ? <TransactionMonitor workspace={workspace} /> : (
                <div className="empty-state">
                  <h3>Sign in to view tenant transactions</h3>
                  <p>Only authenticated tenant data is displayed here.</p>
                </div>
              )}
            </>
          ) : page === "Audit trail" ? (
            <>
              <PageTitle
                eyebrow="GOVERNANCE"
                title="Audit trail"
                desc="Trace decisions, approvals and integration outcomes."
              />
              {!workspace ? (
                <div className="empty-state">
                  <h3>Sign in to view the audit trail</h3>
                  <p>
                    Audit records are isolated by authenticated tenant
                    membership.
                  </p>
                </div>
              ) : opsRows.length ? (
                <div className="panel table-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Recent audit events</h3>
                      <p>Authenticated actions · newest first</p>
                    </div>
                    <span className="status-chip">AUDIT LOG</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Entity</th>
                          <th>Outcome</th>
                          <th>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {opsRows.map((a: any) => (
                          <tr key={a.id}>
                            <td>{a.action}</td>
                            <td>
                              {a.entity_type} · {a.entity_id ?? "—"}
                            </td>
                            <td>{a.outcome}</td>
                            <td>{new Date(a.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <ShieldCheck size={28} />
                  </div>
                  <h3>No audit events recorded yet</h3>
                  <p>
                    Import, mapping and canonicalization actions will appear
                    here after authenticated tenant operations.
                  </p>
                </div>
              )}
            </>
          ) : page === "Terminology" ? (
            <>
              <PageTitle
                eyebrow="REFERENCE DATA"
                title="Terminology explorer"
                desc="Search the loaded SATUSEHAT terminology catalogue. Results are reference suggestions, not automatic clinical coding."
              />
              <div className="panel">
                <div className="term-search">
                  <Search size={17} />
                  <input
                    value={termQuery}
                    onChange={(e) => setTermQuery(e.target.value)}
                    placeholder="Search code or display name (minimum 2 characters)"
                  />
                </div>
                <div className="panel-head">
                  <div>
                    <h3>Reference concepts</h3>
                    <p>
                      {termBusy
                        ? "Searching catalogue…"
                        : termRows.length + " matching concepts"}{" "}
                      · loaded reference dataset
                    </p>
                  </div>
                  <span className="status-chip">READ ONLY</span>
                </div>
                {termRows.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Display</th>
                          <th>Source sheet</th>
                          <th>Active</th>
                        </tr>
                      </thead>
                      <tbody>
                        {termRows.map((t: any) => (
                          <tr key={t.id}>
                            <td>{t.code}</td>
                            <td>{t.display}</td>
                            <td>{t.source_sheet ?? "—"}</td>
                            <td>{t.active ? "Yes" : "No"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="validation-prompt">
                    <Database size={19} />
                    <span>
                      {termQuery.trim().length < 2
                        ? "Enter at least two characters to search the reference catalogue."
                        : termBusy
                          ? "Searching…"
                          : "No matching terminology concepts."}
                    </span>
                  </div>
                )}
              </div>
              <div className="callout">
                <ShieldCheck size={18} />
                <span>
                  <b>Governed terminology</b>
                  <small>
                    Catalogue records retain source provenance. Proposed
                    mappings and equivalence relationships are not treated as
                    approved clinical equivalence; clinicians must review code
                    selection.
                  </small>
                </span>
              </div>
            </>
          ) : page === "KFA catalogue" ? (
            <>
              <PageTitle
                eyebrow="MASTER DATA · KFA"
                title="KFA pharmaceutical & device catalogue"
                desc="Search the authorized SATUSEHAT KFA v2 staging API or synchronize a page into the governed reference catalogue."
              />
              <div className="callout">
                <ShieldCheck size={18} />
                <span>
                  <b>Clinic-scoped credentials</b>
                  <small>
                    Requests use the active clinic's SATUSEHAT connection. No
                    shared organization credentials or browser-side tokens.
                    Catalogue records are stored as unreviewed reference data
                    until approved.
                  </small>
                </span>
              </div>
              <div className="panel">
                <div className="term-search">
                  <Search size={17} />
                  <input
                    value={kfaKeyword}
                    onChange={(e) => setKfaKeyword(e.target.value)}
                    placeholder="Search KFA product keyword, e.g. paracetamol or glove"
                  />
                </div>
                <div className="panel-foot">
                  <span className="foot-note">
                    KFA v2 · product_type=farmasi · page 1 · 50 items
                  </span>
                  <div className="action-row">
                    <button
                      className="secondary-btn"
                      disabled={kfaBusy || !workspace}
                      onClick={() => runKfa("search")}
                    >
                      {kfaBusy ? "Working…" : "Search live KFA"}
                    </button>
                    <button
                      className="primary-btn"
                      disabled={kfaBusy || !workspace}
                      onClick={() => runKfa("sync_page")}
                    >
                      Sync this page <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              </div>
              {kfaSyncResult && (
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h3>Last synchronization</h3>
                      <p>
                        {kfaSyncResult.stored} records stored from{" "}
                        {kfaSyncResult.received} returned by SATUSEHAT.
                      </p>
                    </div>
                    <span className="status-chip">UNREVIEWED</span>
                  </div>
                  <p className="foot-note">
                    Source ID: {kfaSyncResult.source_id} · Total reported by
                    API: {kfaSyncResult.total ?? "Not supplied"}
                  </p>
                </div>
              )}
              <div className="panel table-panel">
                <div className="panel-head">
                  <div>
                    <h3>Live KFA search results</h3>
                    <p>
                      {kfaRows.length} products returned by the SATUSEHAT API
                    </p>
                  </div>
                  <span className="status-chip">LIVE API</span>
                </div>
                {kfaRows.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>KFA code</th>
                          <th>Product</th>
                          <th>Type</th>
                          <th>Active</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kfaRows.map((p: any, i: number) => (
                          <tr key={String(p.kfa_code ?? i)}>
                            <td>{p.kfa_code ?? "—"}</td>
                            <td>{p.name ?? "—"}</td>
                            <td>
                              {p.farmalkes_type?.name ??
                                p.farmalkes_type?.code ??
                                "—"}
                            </td>
                            <td>{p.active === false ? "No" : "Yes"}</td>
                            <td>{p.state ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="validation-prompt">
                    <Database size={19} />
                    <span>
                      Search the live catalogue. An authorized staging
                      connection is required.
                    </span>
                  </div>
                )}
              </div>
              <div className="panel table-panel">
                <div className="panel-head">
                  <div>
                    <h3>Imported reference catalogue</h3>
                    <p>
                      {kfaCatalogueRows.length} records visible · decisions are
                      isolated to this clinic
                    </p>
                  </div>
                  <span className="status-chip">CLINIC REVIEW</span>
                </div>
                {kfaCatalogueRows.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>KFA code</th>
                          <th>Product</th>
                          <th>Type</th>
                          <th>Clinic decision</th>
                          <th>Review action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kfaCatalogueRows.map((p: any) => (
                          <tr key={p.id}>
                            <td>{p.product_code}</td>
                            <td>{p.product_display}</td>
                            <td>{p.product_type}</td>
                            <td>
                              {p.clinic_review?.decision ?? "Not reviewed"}
                            </td>
                            <td>
                              <div className="action-row">
                                <button
                                  className="secondary-btn"
                                  disabled={kfaBusy}
                                  onClick={() => reviewKfa(p.id, "approved")}
                                >
                                  Approve
                                </button>
                                <button
                                  className="secondary-btn"
                                  disabled={kfaBusy}
                                  onClick={() =>
                                    reviewKfa(p.id, "needs_review")
                                  }
                                >
                                  Review
                                </button>
                                <button
                                  className="secondary-btn"
                                  disabled={kfaBusy}
                                  onClick={() => reviewKfa(p.id, "rejected")}
                                >
                                  Reject
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="validation-prompt">
                    <Database size={19} />
                    <span>
                      No imported KFA products yet. Synchronize a page after the
                      clinic connection is configured.
                    </span>
                  </div>
                )}
              </div>
              <div className="callout">
                <CircleAlert size={18} />
                <span>
                  <b>Important</b>
                  <small>
                    Search is read-only. Synchronization imports one page only
                    (maximum 100 records per request), preserves source payload
                    and lineage, and marks all imported products unreviewed.
                    This is not a full-catalogue synchronization and does not
                    establish clinical approval.
                  </small>
                </span>
              </div>
            </>
          ) : page === "Facility access" ? (
            workspace ? <FacilityAccessManagement workspace={workspace} /> : (
              <div className="empty-state">
                <div className="empty-icon"><ShieldCheck size={28} /></div>
                <h3>Tenant administrator workspace required</h3>
                <p>Sign in with an active tenant administrator account to manage facility assignments. Ordinary users cannot assign access.</p>
              </div>
            )
          ) : page === "Patient records" ? (
            <>
              <PageTitle
                eyebrow="LONGITUDINAL IDENTITY"
                title="Patient records"
                desc="Patient identity is the anchor for longitudinal clinical relationships."
              />
              {workspace && (
                <div className="fhir-tabs patient-record-tabs" role="tablist" aria-label="Patient records views">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={patientRecordsTab === "records"}
                    className={patientRecordsTab === "records" ? "active" : ""}
                    onClick={() => setPatientRecordsTab("records")}
                  >
                    Patient records
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={patientRecordsTab === "identity"}
                    className={patientRecordsTab === "identity" ? "active" : ""}
                    onClick={() => setPatientRecordsTab("identity")}
                  >
                    Identity intelligence
                  </button>
                </div>
              )}
              {patientRecordsTab === "identity" ? (
                workspace && importId ? (
                  <PatientIdentityReviewQueue workspace={workspace} importId={importId} />
                ) : (
                  <div className="empty-state">
                    <h3>Identity intelligence unavailable</h3>
                    <p>Sign in to the clinic workspace and select an active import to review identity conflicts.</p>
                  </div>
                )
              ) : (
                !workspace ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <Fingerprint size={28} />
                  </div>
                  <h3>Sign in to view clinic Patients</h3>
                  <p>
                    Patient records are tenant-scoped and require
                    authentication.
                  </p>
                </div>
              ) : opsRows.length ? (
                <div className="panel table-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Canonical Patient records</h3>
                      <p>Tenant-scoped Patient identity anchors</p>
                    </div>
                    <span className="status-chip">{opsRows.length} RECENT</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>MRN</th>
                          <th>Name</th>
                          <th>Birth date</th>
                          <th>Gender</th>
                          <th>Clinical status</th>
                          <th>Record</th>
                        </tr>
                      </thead>
                      <tbody>
                        {opsRows.map((p: any) => (
                          <tr key={p.id}>
                            <td>{p.local_mrn ?? "—"}</td>
                            <td>
                              {(p.name ?? [])
                                .map(
                                  (n: any) =>
                                    n.text ??
                                    [...(n.given ?? []), n.family]
                                      .filter(Boolean)
                                      .join(" "),
                                )
                                .join(", ") || "—"}
                            </td>
                            <td>{p.birth_date ?? "—"}</td>
                            <td>{p.administrative_gender ?? "—"}</td>
                            <td>{p.active ? "Active" : "Inactive"}</td>
                            <td>
                              <span className="patient-save-badge saved"><Check size={12} strokeWidth={3} /> SAVED</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <Fingerprint size={28} />
                  </div>
                  <h3>No canonical Patients yet</h3>
                  <p>
                    Import source data, approve mappings and persist a canonical
                    Patient to see it here.
                  </p>
                  <button
                    className="secondary-btn"
                    onClick={() => go("Source data")}
                  >
                    Open source data <ArrowRight size={16} />
                  </button>
                </div>
                )
              )}
              {workspace && <PatientCorrectionReviewQueue />}
            </>
          ) : (
            <>
              <PageTitle
                eyebrow="WORKSPACE"
                title="Settings"
                desc="Configure the secure tenant workspace."
              />
              <div className="panel settings-panel">
                <div className="settings-line">
                  <span>
                    <b>Supabase connection</b>
                    <small>
                      {isSupabaseConfigured
                        ? "Project URL and publishable key detected"
                        : "Environment variables not configured"}
                    </small>
                  </span>
                  <span
                    className={`status-chip ${isSupabaseConfigured ? "success-chip" : ""}`}
                  >
                    {isSupabaseConfigured ? "CONFIGURED" : "NOT CONFIGURED"}
                  </span>
                </div>
                <div className="settings-line">
                  <span>
                    <b>Authentication</b>
                    <small>Supabase Auth · email and password</small>
                  </span>
                  <button
                    className="secondary-btn"
                    onClick={() => setShowLogin(true)}
                  >
                    {session ? "Authenticated" : "Sign in"}{" "}
                    <ArrowRight size={15} />
                  </button>
                </div>
                <div className="settings-line">
                  <span>
                    <b>SATUSEHAT staging</b>
                    <small>
                      Backend-only credentials and verified facility scope
                      required
                    </small>
                  </span>
                  <button
                    className="secondary-btn"
                    disabled={!session || persisting}
                    onClick={runSandboxPreflight}
                  >
                    Run staging preflight <RefreshCw size={14} />
                  </button>
                </div>
                {sandboxResult && (
                  <div className="settings-line">
                    <span>
                      <b>Latest preflight response</b>
                      <small>
                        Connectivity/metadata only · does not authorize Patient
                        write
                      </small>
                      <pre className="json-view">
                        {JSON.stringify(sandboxResult, null, 2)}
                      </pre>
                    </span>
                    <span className="status-chip">
                      {sandboxResult.success ? "PREFLIGHT OK" : "BLOCKED"}
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
          <footer className="footer">
            <span>© 2026 Andalan AI · SATUCORE</span>
            <span>
              <LockKeyhole size={12} /> Secure healthcare data preparation
            </span>
            <span>FHIR R4 · SATUSEHAT readiness</span>
          </footer>
        </div>
      </main>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={handleFile}
      />
      {showSourceCorrection && (
        <div className="modal-backdrop" role="presentation" onClick={() => !correctionBusy && setShowSourceCorrection(false)}>
          <div className="login-modal source-correction-modal" role="dialog" aria-modal="true" aria-labelledby="source-correction-title" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close icon-btn" aria-label="Close" disabled={correctionBusy} onClick={() => setShowSourceCorrection(false)}>
              <X size={18} />
            </button>
            <div className="brand-mark"><FileSpreadsheet size={22} /></div>
            <h2 id="source-correction-title">Correct {correctionLabel}</h2>
            <p>Resolve this specific Patient field using verified source evidence. Other fields remain unchanged. The original imported value is preserved.</p>
            <label>Patient</label>
            <input readOnly value={String(rows[selected]?.[fields.find(f => f.target === "name")?.source ?? ""] ?? "Unnamed record")} />
            <label>MRN</label>
            <input readOnly value={String(rows[selected]?.[fields.find(f => f.target === "identifier")?.source ?? ""] ?? "Not supplied")} />
            {correctionTarget === "gender" && (
              <div className="patient-save-feedback" role="alert">
                <CircleAlert className="feedback-icon" size={18} />
                <div><strong>Verify administrative gender</strong><p>Use M, F, OTHER or UNKNOWN from the authoritative source. The value X is not accepted and will not be silently converted.</p></div>
              </div>
            )}
            {correctionTarget === "birthDate" && (
              <div className="patient-save-feedback" role="alert">
                <CircleAlert className="feedback-icon" size={18} />
                <div><strong>Verify date of birth</strong><p>{validateSourceBirthDate(correctionValue) || "Use the verified date from the authoritative source. Do not guess or estimate the date."}</p></div>
              </div>
            )}
            <label>Correction field</label>
            <input readOnly value={correctionLabel} />
            <label>Source field · {fields.find(f => f.target === correctionTarget && (f.approved || correctionTarget === "identifier"))?.source ?? "No mapped source column"}</label>
            <label>Original imported value</label>
            <input readOnly value={String(rows[selected]?.[fields.find(f => f.target === correctionTarget && (f.approved || correctionTarget === "identifier"))?.source ?? ""] ?? "")} />
            <label>Corrected {correctionTarget === "name" ? "Patient name" : correctionTarget === "identifier" ? "MRN / Patient identifier" : correctionTarget === "birthDate" ? "date of birth" : "administrative gender"}</label>
            <input value={correctionValue} onChange={(e) => setCorrectionValue(e.target.value)} placeholder={correctionTarget === "birthDate" ? "YYYY-MM-DD" : correctionTarget === "identifier" ? "Enter verified MRN" : correctionTarget === "gender" ? "M, F, OTHER or UNKNOWN" : "Enter corrected Patient name"} />
            <label>Reason / evidence</label>
            <textarea value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="Explain the source document or reason supporting this correction." rows={3} />
            {!workspace || !importId || !fields.some(f => f.target === correctionTarget && (f.approved || correctionTarget === "identifier")) ? (
              <small className="source-correction-blocker" role="status">
                {!workspace
                  ? "Saving requires signing in to an authorized clinic workspace. This upload is currently local only."
                  : !importId
                    ? "This CSV import has not been saved to the clinic workspace yet. Check the import status before correcting it."
                    : correctionTarget === "identifier" ? "Map a source column to Patient identifier before saving this correction." : `Approve a source-to-${correctionTarget} mapping before saving this correction.`}
              </small>
            ) : !correctionReason.trim() ? (
              <small className="source-correction-blocker" role="status">Enter the reason or source evidence to enable saving.</small>
             ) : correctionTarget === "birthDate" && validateSourceBirthDate(correctionValue) ? (
              <small className="source-correction-blocker" role="status">{validateSourceBirthDate(correctionValue)}</small>
            ) : null}
            <div className="action-row">
              <button type="button" className="secondary-btn" disabled={correctionBusy} onClick={() => setShowSourceCorrection(false)}>Cancel</button>
              <button type="button" className="primary-btn" disabled={correctionBusy || persisting || !workspace || !importId || !fields.some(f => f.target === correctionTarget && (f.approved || correctionTarget === "identifier")) || !correctionReason.trim() || (correctionTarget === "birthDate" && !!validateSourceBirthDate(correctionValue))} onClick={async () => {
                const sourceField = fields.find(f => f.target === correctionTarget && (f.approved || correctionTarget === "identifier"))?.source ?? "";
                const validationError = correctionTarget === "birthDate" ? validateSourceBirthDate(correctionValue) : !correctionValue.trim() ? "A corrected value is required." : "";
                if (validationError) { setNotice(validationError); return; }
                if (!workspace || !importId || !sourceField) { setNotice("Correction cannot be saved: clinic import or mapped source column is unavailable."); return; }
                try {
                  setCorrectionBusy(true);
                  const originalValue = String(rows[selected]?.[sourceField] ?? "");
                  const result = await persistSourceRowCorrection({
                    workspace, importId, rowNumber: selected + 1, sourceField,
                    targetField: correctionTarget,
                    originalValue, correctedValue: correctionValue.trim(), reason: correctionReason
                  });
                  // The correction is already persisted at this point. Close the modal and
                  // update the working row before attempting the optional draft refresh;
                  // a refresh failure must never make a successful save look unsaved.
                  setRows(current => current.map((row, index) => index === selected ? { ...row, [sourceField]: correctionValue.trim() } : row));
                  setSaveFeedback(null);
                  setValidation(false);
                  setValidationResult(null);
                  setShowSourceCorrection(false);
                  setNotice(result.auditWarning
                    ? "Correction saved and source value updated for this working batch, but the audit event failed: " + result.auditWarning
                    : "Correction recorded. Original imported data is preserved. Run validation again, then save the canonical Patient.");
                  try {
                    const refreshedDraft = await getPatientDraft({ workspace, importId, rowNumber: selected + 1 });
                    if (refreshedDraft) setPatientDrafts(current => ({ ...current, [selected]: refreshedDraft }));
                  } catch (refreshError) {
                    setNotice("Correction was saved and the modal was closed, but the Patient Draft refresh failed: " + getReadableError(refreshError) + ". Reopen the record or refresh the page to reload it.");
                  }
                } catch (error) {
                  setNotice("Correction could not be saved: " + getReadableError(error));
                } finally {
                  setCorrectionBusy(false);
                }
              }}>{correctionBusy ? "Saving correction…" : "Save correction"}</button>
            </div>
            <small className="login-foot">A correction record is appended to the clinic audit trail. No Patient or SATUSEHAT record is created by this action.</small>
          </div>
        </div>
      )}
      {mrnReviewOpen && mrnReviewPatient && workspace && importId && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !mrnReviewBusy) setMrnReviewOpen(false); }}>
          <section className="login-modal patient-correction-modal" role="dialog" aria-modal="true" aria-labelledby="mrn-review-title">
            <button type="button" className="modal-close secondary-btn" aria-label="Close" disabled={mrnReviewBusy} onClick={() => setMrnReviewOpen(false)}><X size={16}/></button>
            <div className="eyebrow">MANUAL IDENTITY REVIEW · TENANT SCOPED</div>
            <h2 id="mrn-review-title">MRN already exists</h2>
            <p>A Patient with this MRN already exists in this clinic. No Patient was created and no automatic merge was attempted. Submit the source row to the authorized identity review queue.</p>
            <label>Incoming MRN</label><input readOnly value={String(rows[selected]?.[fields.find(f => f.target === "identifier")?.source ?? ""] ?? "")} />
            <label>Existing Patient record</label><input readOnly value={`${mrnReviewPatient.id} · ${Array.isArray(mrnReviewPatient.name) ? mrnReviewPatient.name.map((n: any) => n.text ?? "").filter(Boolean).join(", ") : "Existing clinic Patient"}`} />
            <label>Review reason / evidence</label><textarea value={mrnReviewReason} onChange={(event) => setMrnReviewReason(event.target.value)} rows={3} maxLength={2000} placeholder="Describe the source evidence that should be reviewed." />
            <div className="action-row">
              <button type="button" className="secondary-btn" disabled={mrnReviewBusy} onClick={() => setMrnReviewOpen(false)}>Cancel</button>
              <button type="button" className="primary-btn" disabled={mrnReviewBusy || !mrnReviewReason.trim()} onClick={async () => {
                try {
                  setMrnReviewBusy(true);
                  const result = await createPatientIdentityReviewRequest({ workspace, importId, rowNumber: selected + 1, incomingMrn: String(rows[selected]?.[fields.find(f => f.target === "identifier")?.source ?? ""] ?? ""), reason: mrnReviewReason });
                  setMrnReviewOpen(false);
                  setNotice(result.existing
                    ? `An identity review request is already pending (${result.requestId}).`
                    : `Identity review request submitted (${result.requestId}). An authorized clinic administrator or data manager must decide it. No Patient was merged or created.`);
                } catch (error) { setNotice("Identity review request failed: " + getReadableError(error)); }
                finally { setMrnReviewBusy(false); }
              }}>{mrnReviewBusy ? "Submitting…" : "Submit for identity review"}</button>
            </div>
          </section>
        </div>
      )}
      {showLogin && (
        <div className="modal-backdrop" onClick={() => setShowLogin(false)}>
          <div className="login-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close icon-btn"
              onClick={() => setShowLogin(false)}
            >
              <X size={18} />
            </button>
            <div
              className="brand-mark"
              style={{
                width: 250,
                height: "auto",
                minWidth: 0,
                padding: 1,
                margin: "0 auto 12px",
                background: "#100d24",
                border: "1px solid rgba(255,255,255,0.38)",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img
                src="https://vffribtxjxzkydfwrqre.supabase.co/storage/v1/object/public/assets/satucore-logo-transparent-white-wordmark-preview.png"
                alt="SATUCORE — Healthcare Data Integration SaaS"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                  const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
                  if (fallback) fallback.style.display = "flex";
                }}
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                  aspectRatio: "1280 / 427",
                  objectFit: "contain",
                }}
              />
              <div style={{ display: "none", alignItems: "center", gap: 10, color: "#fff", fontWeight: 800, letterSpacing: "-0.5px", fontSize: 24 }}>
                <span style={{ color: "#a78bfa", fontSize: 30 }}>✣</span>
                <span>SATUCORE<small style={{ display: "block", fontSize: 9, fontWeight: 500, letterSpacing: 0 }}>Healthcare Data Integration SaaS</small></span>
              </div>
            </div>
            <h2>Sign in to SATUCORE</h2>
            <p>Authenticate to access your tenant workspace.</p>
            <label>Email address</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="you@clinic.id"
            />
            <label>Password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Your password"
            />
            <button
              className="primary-btn full-btn"
              disabled={busy || !email || !password}
              onClick={login}
            >
              {busy ? "Signing in…" : "Sign in securely"}
            </button>
            <small className="login-foot">
              Tenant authorization is enforced by Supabase Auth and database
              policies.
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
function Metric({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  note: string;
  tone: string;
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>
        <Icon size={18} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  desc,
  action,
}: {
  eyebrow: string;
  title: string;
  desc: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
      {action}
    </div>
  );
}
function Finding({
  icon: Icon,
  tone,
  title,
  detail,
}: {
  icon: any;
  tone: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="finding">
      <span className={`finding-icon ${tone}`}>
        <Icon size={16} />
      </span>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
    </div>
  );
}
export default App;
