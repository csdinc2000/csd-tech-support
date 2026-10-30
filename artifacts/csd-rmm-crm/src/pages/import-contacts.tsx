import { useRef, useState } from "react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  Contact,
  FileArchive,
  FileText,
  Info,
  Loader2,
  MinusCircle,
  PlusCircle,
  RefreshCcw,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Upload,
  Users,
  X,
} from "lucide-react";

type RowAction = "create" | "enrich" | "unchanged" | "skip";

type PreviewRow = {
  action: RowAction;
  action_label: string;
  detail: string | null;
  issue: string | null;
  valid: boolean;
} & Record<string, unknown>;

type FieldMapping = { column: string; field: string; label: string };

type PreviewCounts = { create: number; enrich: number; unchanged: number; skip: number };

type PreviewResponse = {
  source: string;
  sourceLabel: string;
  mappings: FieldMapping[];
  unmappedColumns: string[];
  headers: string[];
  rows: PreviewRow[];
  errors: string[];
  warnings: string[];
  counts: PreviewCounts;
};

type ImportResponse = {
  sourceLabel: string;
  created: number;
  enriched: number;
  unchanged: number;
  skipped: number;
  errors: string[];
};

const EMPTY_COUNTS: PreviewCounts = { create: 0, enrich: 0, unchanged: 0, skip: 0 };

const ACTION_STYLES: Record<RowAction, { chip: string; icon: typeof PlusCircle; row: string }> = {
  create: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: PlusCircle, row: "" },
  enrich: { chip: "bg-sky-50 text-sky-700 border-sky-200", icon: Sparkles, row: "" },
  unchanged: { chip: "bg-slate-100 text-slate-600 border-slate-200", icon: MinusCircle, row: "" },
  skip: { chip: "bg-amber-50 text-amber-700 border-amber-200", icon: TriangleAlert, row: "bg-[#fffaf0]" },
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const displayValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const headerLabel = (header: string) =>
  header.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export default function ImportContacts() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  const chooseFile = async (nextFile: File | null) => {
    if (!nextFile) return;
    setRequestError("");
    setImportResult(null);
    setPreview(null);
    setSelectedRows(new Set());
    if (!nextFile.name.toLowerCase().endsWith(".csv") && nextFile.type !== "text/csv") {
      setFile(null);
      setCsv("");
      setRequestError("Choose a CSV file. Google Contacts, Outlook, and PayPal can all export one.");
      return;
    }
    if (nextFile.size > 8 * 1024 * 1024) {
      setFile(null);
      setCsv("");
      setRequestError("Contact CSV files must be 8 MB or smaller. Split the export into smaller files and try again.");
      return;
    }
    try {
      const contents = await nextFile.text();
      if (!contents.trim()) {
        setFile(null);
        setCsv("");
        setRequestError("That file is empty. Choose a CSV export that contains contact rows.");
        return;
      }
      setFile(nextFile);
      setCsv(contents);
    } catch {
      setRequestError("We could not read that file. Try exporting it again.");
    }
  };

  const clearFile = () => {
    setFile(null);
    setCsv("");
    setPreview(null);
    setSelectedRows(new Set());
    setImportResult(null);
    setRequestError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const previewCsv = async () => {
    if (!csv || previewLoading) return;
    setPreviewLoading(true);
    setRequestError("");
    setImportResult(null);
    try {
      const response = await apiRequest("POST", "/api/contact-import/preview", { csv });
      const payload = (await response.json()) as PreviewResponse;
      setSelectedRows(new Set(
        (Array.isArray(payload.rows) ? payload.rows : [])
          .flatMap((row, position) => row.action === "create" || row.action === "enrich" ? [position] : []),
      ));
      setPreview({
        source: payload.source ?? "generic",
        sourceLabel: payload.sourceLabel ?? "CSV",
        mappings: Array.isArray(payload.mappings) ? payload.mappings : [],
        unmappedColumns: Array.isArray(payload.unmappedColumns) ? payload.unmappedColumns : [],
        headers: Array.isArray(payload.headers) ? payload.headers : [],
        rows: Array.isArray(payload.rows) ? payload.rows : [],
        errors: Array.isArray(payload.errors) ? payload.errors : [],
        warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
        counts: { ...EMPTY_COUNTS, ...(payload.counts ?? {}) },
      });
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message.replace(/^\d+:\s*/, "")
          : "The preview could not be loaded. Try again.",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const importCsv = async () => {
    if (!csv || importLoading || !preview || writeCount === 0) return;
    setImportLoading(true);
    setRequestError("");
    try {
      const response = await apiRequest("POST", "/api/contact-import/import", {
        csv,
        selectedRows: [...selectedRows].sort((a, b) => a - b),
        ...(file?.name ? { fileName: file.name } : {}),
      });
      setImportResult((await response.json()) as ImportResponse);
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message.replace(/^\d+:\s*/, "")
          : "The import could not be completed. Try again.",
      );
    } finally {
      setImportLoading(false);
    }
  };

  const writeCount = preview?.rows.filter((row, position) =>
    selectedRows.has(position) && (row.action === "create" || row.action === "enrich"),
  ).length ?? 0;

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-[#f5f2ed] p-4 lg:p-7">
      <div className="mx-auto max-w-[1220px]">
        <div className="mb-5 flex items-center justify-between">
          <Link
            href="/crm/contacts"
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-[#b21f32]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to contacts
          </Link>
          <span className="hidden items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-slate-400 sm:flex">
            <ShieldCheck className="h-4 w-4 text-[#b21f32]" />
            CRM workspace
          </span>
        </div>

        <header className="mb-7 border-b border-[#d8d0c3] pb-7">
          <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-[#b21f32]">Contact import</p>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="font-serif text-4xl font-bold tracking-tight text-[#172436] sm:text-5xl">
                Import contacts from a CSV
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                Drop in an export from Google Contacts, Outlook, or PayPal. The columns are matched to your CRM
                fields automatically, and you can check every row before anything is saved.
              </p>
            </div>
            <div className="flex items-center gap-2 self-start rounded-full border border-[#ded6c9] bg-[#fffdfa] px-3 py-2 text-xs font-semibold text-slate-600 lg:self-auto">
              <span className="h-2 w-2 rounded-full bg-emerald-600" />
              Nothing changes until you import
            </div>
          </div>
        </header>

        {requestError && (
          <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{requestError}</span>
            <button aria-label="Dismiss error" onClick={() => setRequestError("")} className="text-rose-500 transition hover:text-rose-800">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {importResult ? (
          <ImportComplete result={importResult} onStartOver={clearFile} />
        ) : (
          <>
            <section className="mb-6 grid gap-5 lg:grid-cols-[minmax(0,390px)_minmax(0,1fr)]">
              <UploadCard
                file={file}
                isDragging={isDragging}
                disabled={previewLoading || importLoading}
                inputRef={inputRef}
                onDragState={setIsDragging}
                onFile={chooseFile}
                onClear={clearFile}
              />
              <div className="rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-5 shadow-sm sm:p-6">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl bg-[#f1e7dc] p-2.5 text-[#172436]">
                    <Info className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-[#172436]">How the matching works</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Contacts are matched to the CRM by email address or phone number. A new person is added, and
                      someone already in the CRM only has their <strong>blank</strong> fields filled in — details you
                      typed yourself are never overwritten.
                    </p>
                  </div>
                </div>
                <div className="mt-5 grid gap-3 border-t border-[#eee7dc] pt-5 sm:grid-cols-3">
                  <Guidance icon={Users} label="Google, Outlook, PayPal" detail="Headers are detected for you" />
                  <Guidance icon={CircleAlert} label="Review first" detail="Every row is shown with its action" />
                  <Guidance icon={ShieldCheck} label="Safe to check" detail="Preview never writes" />
                </div>
              </div>
            </section>

            {file && !preview && (
              <div className="mb-6 flex flex-col gap-3 rounded-xl border border-[#ded6c9] bg-[#fffdfa] p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <FileArchive className="h-5 w-5 shrink-0 text-[#b21f32]" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-[#172436]">{file.name}</p>
                    <p className="text-xs text-slate-500">{formatBytes(file.size)} ready to check</p>
                  </div>
                </div>
                <button
                  onClick={previewCsv}
                  disabled={previewLoading}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#172436] px-4 py-2.5 text-sm font-bold text-[#fffdfa] transition hover:bg-[#243851] disabled:cursor-wait disabled:opacity-60"
                >
                  {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                  {previewLoading ? "Checking file" : "Preview contacts"}
                </button>
              </div>
            )}

            {previewLoading && <PreviewSkeleton />}
            {preview && !previewLoading && (
              <>
                <MappingPanel preview={preview} />
                <PreviewPanel
                  preview={preview}
                  writeCount={writeCount}
                  selectedRows={selectedRows}
                  onSelectionChange={setSelectedRows}
                  importLoading={importLoading}
                  onImport={importCsv}
                  onStartOver={clearFile}
                />
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function UploadCard({
  file,
  isDragging,
  disabled,
  inputRef,
  onDragState,
  onFile,
  onClear,
}: {
  file: File | null;
  isDragging: boolean;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDragState: (active: boolean) => void;
  onFile: (file: File | null) => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-5 shadow-sm sm:p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Step 01</p>
          <h2 className="mt-1 text-lg font-bold text-[#172436]">Choose your CSV</h2>
        </div>
        {file && (
          <button onClick={onClear} disabled={disabled} className="text-xs font-bold text-slate-500 underline decoration-[#d8d0c3] underline-offset-4 transition hover:text-[#b21f32]">
            Remove
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        disabled={disabled}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) onDragState(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => onDragState(false)}
        onDrop={(event) => {
          event.preventDefault();
          onDragState(false);
          if (!disabled) onFile(event.dataTransfer.files?.[0] ?? null);
        }}
        className={`flex min-h-[210px] w-full flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition ${
          isDragging ? "border-[#b21f32] bg-[#fff3f0]" : "border-[#cfc5b7] bg-[#faf8f4] hover:border-[#b21f32] hover:bg-[#fff9f5]"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span className={`mb-4 rounded-2xl p-3 ${isDragging ? "bg-[#b21f32] text-white" : "bg-[#f1e7dc] text-[#b21f32]"}`}>
          <CloudUpload className="h-7 w-7" />
        </span>
        <span className="text-sm font-bold text-[#172436]">{file ? "Choose a different CSV" : "Drop a contact CSV here"}</span>
        <span className="mt-1 text-xs text-slate-500">or browse from your computer</span>
        <span className="mt-4 rounded-md border border-[#d8d0c3] bg-white px-3 py-1.5 text-xs font-bold text-slate-600">
          <Upload className="mr-1.5 inline h-3.5 w-3.5" />
          Browse files
        </span>
      </button>
      <p className="mt-3 text-center text-[11px] text-slate-400">The file is sent securely for preview and is not stored by this page.</p>
    </div>
  );
}

function Guidance({ icon: Icon, label, detail }: { icon: typeof FileText; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#b21f32]" />
      <div>
        <p className="text-xs font-bold text-[#172436]">{label}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

/** Shows exactly which spreadsheet column became which CRM field. */
function MappingPanel({ preview }: { preview: PreviewResponse }) {
  return (
    <section className="mb-6 rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Step 02</p>
          <h2 className="mt-1 text-lg font-bold text-[#172436]">Columns we matched</h2>
        </div>
        <span className="inline-flex items-center gap-2 self-start rounded-full border border-[#ded6c9] bg-[#faf8f4] px-3 py-1.5 text-xs font-bold text-[#172436] sm:self-auto">
          <Contact className="h-3.5 w-3.5 text-[#b21f32]" />
          Detected: {preview.sourceLabel}
        </span>
      </div>

      {preview.mappings.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No columns in this file could be matched to a CRM contact field.</p>
      ) : (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {preview.mappings.map((mapping) => (
            <li
              key={`${mapping.column}-${mapping.field}`}
              className="flex items-center gap-2 rounded-lg border border-[#eee7dc] bg-[#faf8f4] px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600" title={mapping.column}>
                {mapping.column}
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#b21f32]" />
              <span className="shrink-0 text-xs font-bold text-[#172436]">{mapping.label}</span>
            </li>
          ))}
        </ul>
      )}

      {preview.unmappedColumns.length > 0 && (
        <details className="mt-4 rounded-lg border border-[#eee7dc] bg-white p-3">
          <summary className="cursor-pointer text-xs font-bold text-slate-600">
            {preview.unmappedColumns.length} column{preview.unmappedColumns.length === 1 ? "" : "s"} ignored
          </summary>
          <p className="mt-2 font-mono text-[11px] leading-5 text-slate-500">{preview.unmappedColumns.join(" · ")}</p>
        </details>
      )}
    </section>
  );
}

function PreviewSkeleton() {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#ded6c9] bg-[#fffdfa] shadow-sm">
      <div className="animate-pulse border-b border-[#e5ddd2] p-5">
        <div className="h-3 w-24 rounded bg-[#e9e2d8]" />
        <div className="mt-3 h-7 w-52 rounded bg-[#e9e2d8]" />
        <div className="mt-2 h-3 w-80 max-w-full rounded bg-[#eee7dc]" />
      </div>
      <div className="space-y-3 p-5">
        {[1, 2, 3, 4].map((row) => (
          <div key={row} className="grid animate-pulse grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((cell) => <div key={cell} className="h-10 rounded bg-[#eee7dc]" />)}
          </div>
        ))}
      </div>
    </section>
  );
}

function PreviewPanel({
  preview,
  writeCount,
  selectedRows,
  onSelectionChange,
  importLoading,
  onImport,
  onStartOver,
}: {
  preview: PreviewResponse;
  writeCount: number;
  selectedRows: Set<number>;
  onSelectionChange: (rows: Set<number>) => void;
  importLoading: boolean;
  onImport: () => void;
  onStartOver: () => void;
}) {
  const [nameSearch, setNameSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<RowAction | "all">("all");
  const search = nameSearch.trim().toLocaleLowerCase();
  const visibleRows = preview.rows.map((row, position) => ({ row, position })).filter(({ row }) =>
    (actionFilter === "all" || row.action === actionFilter) &&
    String(row.full_name ?? "").toLocaleLowerCase().includes(search),
  );
  const visibleSelectable = visibleRows.filter(({ row }) => row.action === "create" || row.action === "enrich");
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every(({ position }) => selectedRows.has(position));
  const someVisibleSelected = visibleSelectable.some(({ position }) => selectedRows.has(position));
  const toggleRow = (position: number) => {
    const next = new Set(selectedRows);
    if (next.has(position)) next.delete(position);
    else next.add(position);
    onSelectionChange(next);
  };
  const toggleVisible = () => {
    const next = new Set(selectedRows);
    visibleSelectable.forEach(({ position }) => {
      if (allVisibleSelected) next.delete(position);
      else next.add(position);
    });
    onSelectionChange(next);
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ded6c9] bg-[#fffdfa] shadow-sm">
      <div className="border-b border-[#e5ddd2] bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.16em] text-[#b21f32]">Step 03</p>
            <h2 className="mt-1 font-serif text-2xl font-bold text-[#172436]">Review what will happen</h2>
            <p className="mt-1 text-sm text-slate-500">Search by name and select which contacts to import. Only checked contacts will be saved.</p>
          </div>
          <div className="grid grid-cols-2 divide-[#e5ddd2] rounded-xl border border-[#e5ddd2] bg-[#fcfbfa] sm:grid-cols-4 sm:divide-x">
            <Metric label="New" value={preview.counts.create} tone="text-emerald-700" />
            <Metric label="Filled in" value={preview.counts.enrich} tone="text-sky-700" />
            <Metric label="Up to date" value={preview.counts.unchanged} tone="text-slate-700" />
            <Metric label="Skipped" value={preview.counts.skip} tone={preview.counts.skip > 0 ? "text-amber-700" : "text-slate-700"} />
          </div>
        </div>
      </div>

      {(preview.errors.length > 0 || preview.warnings.length > 0) && (
        <div className="grid gap-3 border-b border-[#e5ddd2] bg-[#fcfbfa] p-5 sm:grid-cols-2 sm:p-6">
          {preview.errors.length > 0 && <MessageList title="Rows that cannot be imported" items={preview.errors} tone="error" />}
          {preview.warnings.length > 0 && <MessageList title="Worth knowing" items={preview.warnings} tone="warning" />}
        </div>
      )}

      {preview.rows.length > 0 && (
        <div className="space-y-3 border-b border-[#e5ddd2] bg-[#fcfbfa] p-5 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <input
                type="search"
                aria-label="Search contacts by name"
                placeholder="Search contacts by name…"
                value={nameSearch}
                onChange={(event) => setNameSearch(event.target.value)}
                disabled={importLoading}
                className="w-full rounded-lg border border-[#d8d0c3] bg-white py-2.5 pl-9 pr-3 text-sm text-[#172436] focus:border-[#b21f32] focus:outline-none focus:ring-1 focus:ring-[#b21f32]"
              />
            </div>
            <select
              aria-label="Filter contacts by import action"
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value as RowAction | "all")}
              disabled={importLoading}
              className="rounded-lg border border-[#d8d0c3] bg-white px-3 py-2.5 text-sm text-[#172436] focus:outline-none focus:ring-1 focus:ring-[#b21f32]"
            >
              <option value="all">All actions</option>
              <option value="create">New contacts</option>
              <option value="enrich">Fill blank fields</option>
              <option value="unchanged">Already up to date</option>
              <option value="skip">Skipped rows</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <label className="inline-flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(element) => { if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                onChange={toggleVisible}
                disabled={importLoading || visibleSelectable.length === 0}
                className="h-4 w-4 accent-[#b21f32]"
              />
              Select visible ({visibleSelectable.length})
            </label>
            <span aria-live="polite">{visibleRows.length} of {preview.rows.length} shown · <strong>{writeCount} selected to import</strong></span>
            <button
              type="button"
              onClick={() => onSelectionChange(new Set())}
              disabled={importLoading || selectedRows.size === 0}
              className="font-semibold underline underline-offset-4 disabled:opacity-50"
            >
              Clear all selections
            </button>
          </div>
          <p className="text-[11px] text-slate-500">Search and filters do not change your selections. Skipped and up-to-date rows cannot be selected.</p>
        </div>
      )}

      {preview.rows.length === 0 ? (
        <div className="p-12 text-center">
          <FileText className="mx-auto h-9 w-9 text-slate-300" />
          <h3 className="mt-3 font-serif text-xl font-bold text-[#172436]">No contacts to preview</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            The CSV could be read, but it did not contain any importable contact rows.
          </p>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="p-12 text-center text-sm text-slate-500" role="status">
          No contacts match this name and action filter. Clear the search or choose another action.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[#e5ddd2] bg-[#fcfbfa]">
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Select</th>
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Action</th>
                {preview.headers.map((header) => (
                  <th key={header} className="whitespace-nowrap px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    {headerLabel(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eee7dc]">
              {visibleRows.map(({ row, position }) => {
                const style = ACTION_STYLES[row.action] ?? ACTION_STYLES.skip;
                const ActionIcon = style.icon;
                return (
                  <tr key={position} className={style.row || "transition hover:bg-[#fcfbfa]"}>
                    <td className="px-5 py-3 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select ${String(row.full_name || "unnamed contact")}`}
                        data-testid={`checkbox-import-contact-${position}`}
                        checked={selectedRows.has(position)}
                        onChange={() => toggleRow(position)}
                        disabled={importLoading || (row.action !== "create" && row.action !== "enrich")}
                        className="h-4 w-4 accent-[#b21f32] disabled:opacity-40"
                      />
                    </td>
                    <td className="px-5 py-3 align-top">
                      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-bold ${style.chip}`}>
                        <ActionIcon className="h-3.5 w-3.5" />
                        {row.action_label}
                      </span>
                      {(row.detail || row.issue) && (
                        <p className="mt-1 max-w-[220px] text-[11px] leading-4 text-slate-500">{row.issue ?? row.detail}</p>
                      )}
                    </td>
                    {preview.headers.map((header) => (
                      <td key={header} className="max-w-[200px] truncate px-4 py-3 align-top font-mono text-xs text-slate-700" title={displayValue(row[header])}>
                        {displayValue(row[header])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-[#e5ddd2] bg-[#fcfbfa] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <button onClick={onStartOver} disabled={importLoading} className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold text-slate-600 transition hover:bg-[#f1e7dc] hover:text-[#172436] disabled:opacity-50">
          <RefreshCcw className="h-4 w-4" />
          Choose another file
        </button>
        <button
          onClick={onImport}
          disabled={importLoading || writeCount === 0}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b21f32] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#8e1728] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {importLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {importLoading
            ? "Saving contacts"
            : writeCount === 0
              ? preview.counts.create + preview.counts.enrich > 0 ? "Select contacts to import" : "Nothing to import"
              : `Import ${writeCount} selected contact${writeCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value, tone = "text-[#172436]" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-[70px] px-3 py-2.5 text-center">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 font-mono text-base font-bold ${tone}`}>{value}</p>
    </div>
  );
}

function MessageList({ title, items, tone }: { title: string; items: string[]; tone: "error" | "warning" }) {
  const error = tone === "error";
  return (
    <div className={`rounded-xl border p-4 ${error ? "border-rose-200 bg-rose-50/70" : "border-amber-200 bg-amber-50/70"}`}>
      <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wider ${error ? "text-rose-800" : "text-amber-800"}`}>
        {error ? <CircleAlert className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
        {title}
      </div>
      <ul className={`mt-2 space-y-1 text-xs leading-5 ${error ? "text-rose-700" : "text-amber-700"}`}>
        {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function ImportComplete({ result, onStartOver }: { result: ImportResponse; onStartOver: () => void }) {
  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-6 text-center shadow-sm sm:p-10">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="h-8 w-8" />
      </div>
      <p className="mt-5 text-xs font-bold uppercase tracking-[.2em] text-emerald-700">Import complete</p>
      <h2 className="mt-2 font-serif text-3xl font-bold text-[#172436]">Your contacts are in the CRM</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-600">
        {result.sourceLabel ? `The ${result.sourceLabel} export finished importing. ` : "The import finished. "}
        Existing contacts kept everything they already had.
      </p>
      <div className="mx-auto mt-7 grid max-w-lg grid-cols-2 divide-[#e5ddd2] rounded-xl border border-[#e5ddd2] bg-[#fcfbfa] sm:grid-cols-4 sm:divide-x">
        <Metric label="Added" value={Number(result.created) || 0} tone="text-emerald-700" />
        <Metric label="Filled in" value={Number(result.enriched) || 0} tone="text-sky-700" />
        <Metric label="Up to date" value={Number(result.unchanged) || 0} tone="text-slate-700" />
        <Metric label="Skipped" value={Number(result.skipped) || 0} tone="text-amber-700" />
      </div>
      {result.errors?.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left text-xs text-amber-800">
          <p className="flex items-center gap-2 font-bold"><TriangleAlert className="h-4 w-4" /> Some rows were not imported</p>
          <ul className="mt-2 space-y-1">{result.errors.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
        </div>
      )}
      <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/crm/contacts" className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#172436] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#243851]">
          View contacts
          <ChevronRight className="h-4 w-4" />
        </Link>
        <button onClick={onStartOver} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#d8d0c3] px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-[#f1e7dc]">
          Import another CSV
        </button>
      </div>
    </section>
  );
}
