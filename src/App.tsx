import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import Papa from "papaparse";
import { supabase, isSupabaseConfigured } from "./lib/supabase";
import {
  getWorkspace,
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
import { PatientConflictResolution } from "./components/PatientConflictResolution";
import { PatientCorrectionReviewQueue } from "./components/PatientCorrectionReviewQueue";
import { PatientIdentityReviewQueue } from "./components/PatientIdentityReviewQueue";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Bell,
  Check,
  ChevronDown,
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
      /^(mrn|medicalrecord|patientno|patientid|nomorrm|no_rm)$/,
      "identifier",
      0.96,
    ],
    [
      /^(nik|nationalid|nationalidentifier|nomorindukkependudukan|niktp|noktp|ktp)$/,
      "national_identifier",
      0.99,
    ],
    [/^(name|patientname|fullname|nama|namapasien)$/, "name", 0.98],
    [
      /^(dob|birthdate|dateofbirth|tanggal lahir|tanggallahir)$/,
      "birthDate",
      0.98,
    ],
    [/^(sex|gender|jenis kelamin|jeniskelamin)$/, "gender", 0.97],
    [/^(phone|mobile|telecom|telephone|nohp|handphone)$/, "telecom", 0.94],
    [/^(city|kota)$/, "address.city", 0.95],
    [/^(address|alamat)$/, "address", 0.82],
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
  useEffect(() => {
    if (!supabase || !workspace || !importId) {
      setSavedPatients({});
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
          if (alive) setSavedPatients({});
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
        if (alive) setSavedPatients(restored);
      } catch (error) {
        if (alive) setNotice("Could not restore individual Patient save statuses: " + (error as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [workspace, importId]);
  const [selected, setSelected] = useState(0);
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
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [validation, setValidation] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationFor, setValidationFor] = useState<{ rowIndex: number; inputHash: string; payloadHash: string; rowSnapshot: string; mappingSnapshot: string } | null>(null);
  const [validationResult, setValidationResult] = useState<Awaited<ReturnType<typeof validatePatientDraft>> | null>(null);
  const [validationError, setValidationError] = useState("");
  // Restore exact persisted validation evidence for the selected Patient Draft.
  useEffect(() => {
    if (validationRunRef.current) return;

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
  }, [workspace, importId, selected, rows, fields, approved]);
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
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive || !data.session) return;
      try {
        const w = await getWorkspace(data.session);
        const restored = await restoreLatestImport(w);
        if (alive) {
          setSession(data.session);
          setWorkspace(w);
          setTenant(w.tenantName);
          if (restored) {
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
          setSession(null);
          setWorkspace(null);
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
        { body: { action: "preflight", tenant_id: workspace?.tenantId } },
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
  const selectedBirthDateIssue = patientChecks.issues.find(
    (issue) => issue.code === "BIRTH_DATE_INVALID",
  );
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
      (issue) => issue.code === "BIRTH_DATE_INVALID",
    );
    if (!rowIssue) return;
    setCorrectionValue(String(row[mapping.source] ?? ""));
    setCorrectionReason("");
    setShowSourceCorrection(true);
    setNotice(`Invalid date of birth detected for ${String(row[fields.find((field) => field.target === "name" && field.approved)?.source ?? ""] ?? "this Patient")}. Correct it using verified source evidence.`);
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
    setFilename(file.name);
    setSourceFile(file);
    setImportId(null);
    setSavedPatients({});
    setPatientDrafts({});
    setDraftRevisions({});
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
    setApproved(false);
    setFields((fs) =>
      fs.map((f, j) => (i === j ? { ...f, target, approved: false } : f)),
    );
  };
  const toggleApprove = (i: number) => {
    setValidation(false); setValidationResult(null);
    setFields((fs) =>
      fs.map((f, j) => (i === j ? { ...f, approved: !f.approved } : f)),
    );
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
      setWorkspace(w);
      setTenant(w.tenantName);
      setSession(data.session);
      if (restored) {
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
    await supabase?.auth.signOut();
    setSession(null);
    setWorkspace(null);
    setImportId(null);
    setSavedPatients({});
    setPatientDrafts({});
    setDraftRevisions({});
  };
  const runValidation = async () => {
    if (validationRunRef.current) return;
    validationRunRef.current = true;
    setIsValidating(true);
    setValidation(false);
    setValidationResult(null);
    setValidationFor(null);
    setValidationError("");
    try {
      const row = rows[selected];
      if (!approved || !workspace || !importId || !row) {
        throw new Error("Validation requires approved mappings, an authenticated workspace, a persisted import and a selected Patient row.");
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
      setValidationResult(result); setValidation(result.outcome === "passed"); setActive("VALIDATE");
      setValidationFor({ rowIndex: selected, inputHash: result.inputHash, payloadHash: result.payloadHash, rowSnapshot: JSON.stringify(row), mappingSnapshot: JSON.stringify(fields.map(({source,target,approved}) => ({source,target,approved}))) });
      setNotice(`Local Patient validation ${result.outcome}.${result.auditWarning ? " Audit warning: " + result.auditWarning : ""} SATUSEHAT profile validation not yet executed.`);
    } catch (error) { const message = "Validation report could not be completed: " + getReadableError(error); setValidation(false); setValidationResult(null); setValidationError(message); setNotice(message); }
    finally { validationRunRef.current = false; setIsValidating(false); }
  };
  const saveImport = async () => {
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
  const currentValidationIsFresh = !!validationFor && validationFor.rowIndex === selected &&
    !!rows[selected] && !!fields.length &&
    validationFor.rowSnapshot === JSON.stringify(rows[selected]) &&
    validationFor.mappingSnapshot === JSON.stringify(fields.map(({source,target,approved}) => ({source,target,approved})));
  const currentValidationMatchesSelection = !!validationResult && currentValidationIsFresh &&
    validationResult.outcome === "passed" && validation && !isValidating &&
    patientDrafts[selected]?.status === "validated" && !patientDrafts[selected]?.identityConflict &&
    patientDrafts[selected]?.payload_hash === validationResult.payloadHash &&
    patientDrafts[selected]?.input_hash === validationResult.inputHash;
  const selectedHasBlockingIssues = patientChecks.issues.some(issue => issue.severity === "error");
  const selectedHasUnresolvedIssues = selectedHasBlockingIssues || patientChecks.issues.some(issue => issue.severity === "warning");
  const patientActionLabel = persisting ? "Saving…"
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
          <div className="brand-mark">
            <HeartPulse size={22} />
          </div>
          <div>
            <b>SATUCORE</b>
            <small>by ANDALAN AI</small>
          </div>
          <button
            className="icon-btn mobile-close"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
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
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={17} />
            <span>
              <b>Secure by design</b>
              <small>Tenant-scoped workspace</small>
            </span>
          </div>
          <button className="nav-item" onClick={() => go("Settings")}>
            <Settings size={17} />
            Settings
          </button>
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
          .workflow-journey{position:sticky;top:64px;z-index:8;background:var(--panel,#fff);border-bottom:1px solid var(--border,#e7e4ef);padding:12px 28px 10px;box-shadow:0 5px 18px rgba(31,20,65,.04)}
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
          .source-correction-modal textarea{width:100%;box-sizing:border-box;border:1px solid var(--border,#ddd);border-radius:9px;padding:11px;font:inherit;resize:vertical;margin:5px 0 13px}
          .source-correction-modal input[readonly]{background:#f4f2f8;color:#625d70}
          @media(max-width:760px){.workflow-journey{padding:10px 14px}.journey-steps{grid-template-columns:repeat(4,minmax(0,1fr))}.journey-next{font-size:9px}.journey-guidance{margin-left:0}}
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
              <span /> SANDBOX PREVIEW
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
                {fields.length && !fields.every(f => f.approved)
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
            <div className="journey-steps">
              {[
                { label: "Upload", done: !!importId, page: "Source data" },
                { label: "SCAN", done: !!importId, page: "SCAN" },
                { label: "MAP", done: fields.length > 0, page: "MAP" },
                { label: "Review", done: fields.length > 0 && fields.every(f => f.approved), page: "MAP" },
                { label: "Validate", done: currentValidationIsFresh, page: "FHIR & validation" },
                { label: "Approval", done: false, page: "FHIR & validation" },
                { label: "Send & monitor", done: false, page: "Transactions" },
              ].map((step, index) => {
                const current = !step.done && (
                  index === 0 ||
                  (index === 1 && !!importId) ||
                  (index === 2 && !!importId) ||
                  (index === 3 && fields.length > 0) ||
                  (index === 4 && !!patientDrafts[selected] && patientDrafts[selected]?.status !== "stale" && !selectedHasUnresolvedIssues && fields.length > 0 && fields.every(f => f.approved)) ||
                  (index === 5 && currentValidationMatchesSelection) ||
                  (index === 6 && false)
                );
                const locked = (index === 4 && (!patientDrafts[selected] || patientDrafts[selected]?.status === "stale")) || (index === 5 && (!currentValidationMatchesSelection || !!patientDrafts[selected]?.identityConflict)) || (index === 6);
                return (
                  <button
                    type="button"
                    key={step.label}
                    className={`journey-step ${step.done ? "done" : ""} ${current ? "current" : ""} ${locked ? "locked" : ""}`}
                    onClick={() => {
                      if (locked) {
                        setNotice(index === 5
                          ? (patientDrafts[selected]?.identityConflict
                              ? "Approval is blocked: this MRN matches an existing clinic Patient. Resolve the identity review request first."
                              : "Submission approval is a separate controlled step and is not yet enabled in this MVP.")
                          : "SATUSEHAT Patient submission remains disabled until backend authorization and facility scope are verified.");
                      } else {
                        go(step.page);
                      }
                    }}
                  >
                    <span className="journey-dot">{step.done ? <Check size={13} strokeWidth={3} /> : String(index + 1)}</span>
                    <span>{step.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="journey-guidance">
              <span>{fields.length && !fields.every(f => f.approved)
                ? "Review each proposed source-to-Patient mapping, then select Confirm mappings & continue."
                : !importId
                  ? "Persist the source import in the authenticated clinic workspace before creating a Patient draft."
                  : !patientDrafts[selected] || patientDrafts[selected]?.status === "stale"
                    ? "Save the tenant-scoped Patient Draft. Original source data remains preserved and material changes create an auditable revision."
                    : selectedHasUnresolvedIssues
                      ? "Resolve outstanding Patient issues and retain the original source values before running validation."
                      : !currentValidationMatchesSelection
                        ? "Run validation only after the selected Patient draft is saved and its issues are resolved."
                        : "Local validation is complete and linked to this exact draft revision. Formal approval and SATUSEHAT sending remain unavailable until their prerequisites are implemented and verified."}</span>
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
          {page === "Overview" ? (
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
          ) : page === "Source data" || page === "SCAN" ? (
            <>
              <PageTitle
                eyebrow="DATA INGESTION"
                title={
                  page === "SCAN" ? "SCAN · Source profiling" : "Source data"
                }
                desc="Inspect source structure and data quality before mapping."
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
                    Upload a CSV file or explore the workflow with synthetic
                    patient records.
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
                      <b>
                        <FileSpreadsheet size={16} /> {filename}
                      </b>
                    </div>
                    <div>
                      <small>RECORDS PROFILED</small>
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
                        <h3>Data preview</h3>
                        <p>
                          First {Math.min(rows.length, 8)} records ·{" "}
                          {columns.length} detected columns
                        </p>
                      </div>
                      <span className="status-chip">PROFILED</span>
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
                            {columns.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.slice(0, 8).map((r, i) => (
                            <tr key={i}>
                              {columns.map((c) => (
                                <td key={c}>
                                  {r[c] || (
                                    <span className="missing">Empty</span>
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="panel">
                    <div className="panel-head">
                      <div>
                        <h3>SCAN findings</h3>
                        <p>Deterministic structural and completeness checks</p>
                      </div>
                    </div>
                    <div className="finding-list">
                      <Finding
                        icon={Check}
                        tone="green"
                        title="File structure readable"
                        detail={`${columns.length} columns detected from CSV header.`}
                      />
                      <Finding
                        icon={CircleAlert}
                        tone="amber"
                        title="Blank values detected"
                        detail={`${missing} empty cells across the imported sample. Review clinically required fields before approval.`}
                      />
                      <Finding
                        icon={ShieldCheck}
                        tone="blue"
                        title="Synthetic/demo boundary"
                        detail="Data remains in this browser preview until you configure and authenticate the Supabase workspace."
                      />
                    </div>
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
                            ? "Saving…"
                            : importId
                              ? "Saved"
                              : "Save to tenant"}
                        </button>
                        <button
                          className="primary-btn"
                          onClick={() => go("MAP")}
                        >
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
                    disabled={!rows[selected] || persisting || isValidating || !workspace || !importId || !approved}
                    onClick={runPatientAction}
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
                  {selectedBirthDateIssue && (
                    <div className="patient-save-feedback" role="alert" aria-live="assertive">
                      <CircleAlert className="feedback-icon" size={18} />
                      <div>
                        <strong>INVALID DATE OF BIRTH · CORRECTION REQUIRED</strong>
                        <p>{selectedBirthDateIssue.message}</p>
                        <small>Source field: {fields.find((field) => field.target === "birthDate" && field.approved)?.source ?? "birthDate"} · Original value: {String(rows[selected]?.[fields.find((field) => field.target === "birthDate" && field.approved)?.source ?? ""] ?? "Not supplied")}. The original import is preserved. No Patient can be validated or saved with this value.</small>
                        <div className="action-row">
                          <button type="button" className="primary-btn" onClick={() => openBirthDateCorrection(selected)}>
                            Correct date of birth
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
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
                          <button
                            key={i}
                            className={`record-item ${selected === i ? "chosen" : ""}`}
                            onClick={() => {
                              setSelected(i);
                              setSaveFeedback(null);
                              setValidation(false); setValidationResult(null);
                              const birthDateIssue = validatePatientLocally(r, fields).find(
                                (issue) => issue.code === "BIRTH_DATE_INVALID",
                              );
                              if (birthDateIssue) {
                                const birthDateMapping = fields.find(
                                  (field) => field.target === "birthDate" && field.approved,
                                );
                                if (birthDateMapping) {
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
                            </span>
                            {savedPatients[i]
                              ? <span className="patient-save-badge saved">CANONICAL</span>
                              : patientDrafts[i]?.status === "validated"
                                ? <span className="patient-save-badge saved">VALIDATED</span>
                                : patientDrafts[i]
                                  ? <span className="patient-save-badge">DRAFT · R{patientDrafts[i].revision}</span>
                                  : <span className="patient-save-badge">NOT SAVED</span>}
                            <ChevronDown size={15} />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="panel">
                      <div className="panel-head">
                        <div>
                          <h3>FHIR Patient · R4</h3>
                          <p>Generated preview · not submitted</p>
                        </div>
                        <span className="status-chip">DRAFT</span>
                      </div>
                      <pre className="json-view">
                        {JSON.stringify(fhir, null, 2)}
                      </pre>
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
                        className={`status-chip ${validation ? "success-chip" : ""}`}
                      >
                        {validation ? "CHECKED" : "NOT RUN"}
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
                          <Finding icon={CircleAlert} tone="amber"
                            title="Potential existing Patient · identity review required"
                            detail={`Incoming ${patientDrafts[selected].identityConflict.incomingName} · existing ${patientDrafts[selected].identityConflict.candidateName} · MRN ${patientDrafts[selected].identityConflict.mrn}. Date of birth ${patientDrafts[selected].identityConflict.birthDateMatch ? 'matches' : 'does not match / unavailable'}; gender ${patientDrafts[selected].identityConflict.genderMatch ? 'matches' : 'does not match / unavailable'}. ${patientDrafts[selected].identityConflict.requestId ? `Review request ${patientDrafts[selected].identityConflict.requestId} is pending.` : `Review request could not be created: ${patientDrafts[selected].identityConflict.warning ?? 'permission or database error'}`}`} />
                        )}
                      </div>
                    )}
                    {validationResult ? (
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
                          Approve all mappings to enable deterministic
                          validation.
                        </span>
                      </div>
                    )}
                    {validationError && !validationResult && <div className="patient-save-feedback" role="alert" aria-live="assertive"><CircleAlert className="feedback-icon" size={18}/><div><strong>Validation report unavailable</strong><p>{validationError}</p><small>Check tenant access, the persisted mapping approval, and validation report persistence, then retry.</small></div></div>}
                    <div className="panel-foot">
                      <span className="foot-note">
                        No SATUSEHAT request is sent from this screen.
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
                          disabled={persisting || isValidating || !!savedPatients[selected] || patientDrafts[selected]?.identityConflict?.status === "pending" || (!approved || !workspace || !importId)}
                          onClick={runPatientAction}
                        >
                          {patientActionLabel}
                        </button>
                        {currentValidationMatchesSelection && !savedPatients[selected] && (
                          <button
                            type="button"
                            className="primary-btn"
                            disabled={persisting || isValidating || !workspace || !importId}
                            onClick={saveCanonicalPatient}
                            title="Explicitly approve and persist this validated Patient in the active tenant"
                          >
                            <ShieldCheck size={16} /> Approve & Save Canonical Patient
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={persisting || isValidating || !!savedPatients[selected] || !!patientDrafts[selected]?.identityConflict || !workspace || !importId}
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
                title="Transactions"
                desc="Track actual backend requests and responses. This preview has no live Patient write enabled."
              />
              {!workspace ? (
                <div className="empty-state">
                  <h3>Sign in to view tenant transactions</h3>
                  <p>Only authenticated tenant data is displayed here.</p>
                </div>
              ) : opsRows.length ? (
                <div className="panel table-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Recent integration transactions</h3>
                      <p>Tenant-scoped backend records · newest first</p>
                    </div>
                    <span className="status-chip">LIVE RECORDS</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Status</th>
                          <th>HTTP</th>
                          <th>Submitted</th>
                          <th>Response</th>
                        </tr>
                      </thead>
                      <tbody>
                        {opsRows.map((t: any) => (
                          <tr key={t.id}>
                            <td>{t.transaction_type}</td>
                            <td>{t.transaction_status}</td>
                            <td>{t.response_status ?? "—"}</td>
                            <td>
                              {t.submitted_at
                                ? new Date(t.submitted_at).toLocaleString()
                                : "—"}
                            </td>
                            <td>
                              {t.error_message_sanitized ??
                                (t.response_body
                                  ? "Response captured"
                                  : "Pending")}
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
                    <Activity size={28} />
                  </div>
                  <h3>No submission transactions</h3>
                  <p>
                    Only real backend requests and responses will appear here.
                    Demo actions are never recorded as successful transmissions.
                  </p>
                  <span className="status-chip">LIVE WRITE DISABLED</span>
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
          ) : page === "Patient records" ? (
            <>
              <PageTitle
                eyebrow="LONGITUDINAL IDENTITY"
                title="Patient records"
                desc="Patient identity is the anchor for longitudinal clinical relationships."
              />
              {!workspace ? (
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
                          <th>Identity review</th>
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
                            <td>
                              <PatientConflictResolution
                                patientId={p.id}
                                tenantId={workspace.tenantId}
                                currentName={(p.name ?? []).map((n: any) => n.text ?? [...(n.given ?? []), n.family].filter(Boolean).join(" ")).join(", ")}
                              />
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
              )}
              {workspace && <PatientIdentityReviewQueue workspace={workspace} />}
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
            <h2 id="source-correction-title">Correct source data</h2>
            <p>Correct the source value before creating the canonical Patient. The original imported value remains preserved.</p>
            <label>Patient</label>
            <input readOnly value={String(rows[selected]?.[fields.find(f => f.target === "name")?.source ?? ""] ?? "Unnamed record")} />
            <label>MRN</label>
            <input readOnly value={String(rows[selected]?.[fields.find(f => f.target === "identifier")?.source ?? ""] ?? "Not supplied")} />
            <div className="patient-save-feedback" role="alert">
              <CircleAlert className="feedback-icon" size={18} />
              <div><strong>Invalid date of birth</strong><p>{validateSourceBirthDate(correctionValue)}</p><small>Enter the verified date from the authoritative source. Do not guess or estimate the date.</small></div>
            </div>
            <label>Source field · {fields.find(f => f.target === "birthDate" && f.approved)?.source ?? "birthDate"}</label>
            <label>Original imported value</label>
            <input readOnly value={String(rows[selected]?.[fields.find(f => f.target === "birthDate" && f.approved)?.source ?? ""] ?? "")} />
            <label>Corrected date of birth</label>
            <input value={correctionValue} onChange={(e) => setCorrectionValue(e.target.value)} placeholder="YYYY-MM-DD" />
            <label>Reason / evidence</label>
            <textarea value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="Explain the source document or reason supporting this correction." rows={3} />
            <div className="action-row">
              <button type="button" className="secondary-btn" disabled={correctionBusy} onClick={() => setShowSourceCorrection(false)}>Cancel</button>
              <button type="button" className="primary-btn" disabled={correctionBusy || !correctionReason.trim() || !!validateSourceBirthDate(correctionValue)} onClick={async () => {
                const sourceField = fields.find(f => f.target === "birthDate" && f.approved)?.source ?? "";
                const validationError = validateSourceBirthDate(correctionValue);
                if (validationError) { setNotice(validationError); return; }
                if (!workspace || !importId || !sourceField) { setNotice("Correction cannot be saved: clinic import or birth-date mapping is unavailable."); return; }
                try {
                  setCorrectionBusy(true);
                  const originalValue = String(rows[selected]?.[sourceField] ?? "");
                  const result = await persistSourceRowCorrection({
                    workspace, importId, rowNumber: selected + 1, sourceField,
                    originalValue, correctedValue: correctionValue.trim(), reason: correctionReason
                  });
                  setRows(current => current.map((row, index) => index === selected ? { ...row, [sourceField]: correctionValue.trim() } : row));
                  const staleDraft = await getPatientDraft({ workspace, importId, rowNumber: selected + 1 });
                  if (staleDraft) setPatientDrafts(current => ({ ...current, [selected]: staleDraft }));
                  setSaveFeedback(null);
                  setValidation(false);
                  setValidationResult(null);
                  setShowSourceCorrection(false);
                  setNotice(result.auditWarning
                    ? "Correction saved and source value updated for this working batch, but the audit event failed: " + result.auditWarning
                    : "Correction recorded. Original imported data is preserved. Run validation again, then save the canonical Patient.");
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
                  setNotice(result.existing ? `An identity review request is already pending (${result.requestId}).` : `Identity review request submitted (${result.requestId}). An authorized clinic administrator or data manager must decide it. No Patient was merged or created.`);
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
            <div className="brand-mark">
              <HeartPulse size={22} />
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
