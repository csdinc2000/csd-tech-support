import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, CheckCircle2, Globe, ImageUp, Keyboard, ScanLine, Sparkles, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { SCAN_ENCODE, compressPhoto, suggestedAskingPrice, type PendingPhoto, type ScanResult } from "@/lib/marketplace";

type Props = {
  /** Called with the decoded suggestions; the form decides which fields to fill. */
  onDetected: (result: ScanResult, photo: PendingPhoto | null) => void;
  /** Add the scanned frame to the listing's photos as well. */
  onUsePhoto?: (photo: PendingPhoto) => void;
  disabled?: boolean;
  /** Funnel mode: bigger hero treatment. */
  hero?: boolean;
};

type Phase = "idle" | "preparing" | "scanning" | "done" | "failed";
type Source = "photo" | "text";

const PHOTO_LOG = ["capturing frame", "sharpening label text", "reading model & serial codes", "resolving factory specs"];
const TEXT_LOG = ["parsing model / part number", "matching vendor code tables", "resolving factory configurations", "checking current used prices"];

const GLYPHS = "0123456789ABCDEF#$%&@?!<>/\\|=+*";
const HEX_BYTES = 24;
const randomHex = () => Array.from({ length: HEX_BYTES }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase());

// Fake OCR "lock-on" targets drawn over the label while the model reads it.
// Positions are fixed so the effect is stable across renders; the CSS
// staggers the flicker so they appear to hunt around the frame.
const LOCK_BOXES = [
  { left: "12%", top: "18%", width: "34%", height: "12%", tag: "MODEL" },
  { left: "54%", top: "36%", width: "30%", height: "10%", tag: "S/N" },
  { left: "18%", top: "62%", width: "44%", height: "11%", tag: "P/N" },
  { left: "60%", top: "72%", width: "24%", height: "14%", tag: "QR" },
];

/** Viewfinder dressing: corner brackets, drifting crosshair, lock-on boxes. */
function ScanOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="scan-overlay" aria-hidden>
      <span className="reticle reticle-tl" /><span className="reticle reticle-tr" /><span className="reticle reticle-bl" /><span className="reticle reticle-br" />
      <span className="crosshair-h" /><span className="crosshair-v" />
      {LOCK_BOXES.map((b, i) => (
        <span key={b.tag} className="lock-box" style={{ left: b.left, top: b.top, width: b.width, height: b.height, animationDelay: `${i * 0.55}s` }}>
          <span className="lock-tag">{b.tag}</span>
        </span>
      ))}
    </div>
  );
}

/** A strip of "raw bytes" churning under the decode log. */
function HexFeed({ active }: { active: boolean }) {
  const [bytes, setBytes] = useState<string[]>(randomHex);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setBytes(randomHex()), 140);
    return () => clearInterval(id);
  }, [active]);
  return (
    <p className="hex-feed mt-3 select-none overflow-hidden whitespace-nowrap font-mono text-[10px] leading-4 tracking-wider text-red-900/90" aria-hidden data-testid="scan-hex-feed">
      {bytes.join(" ")}
    </p>
  );
}

/** Model number "resolving" glyph by glyph — the visual for text lookups,
 *  which have no photo to sweep. Loops until the lookup returns. */
function ScrambleText({ text, active }: { text: string; active: boolean }) {
  const [reveal, setReveal] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setReveal(text.length); return; }
    setReveal(0);
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setReveal((r) => (r >= text.length + 6 ? 0 : r + 1));
    }, 70);
    return () => clearInterval(id);
  }, [active, text]);
  const shown = text.split("").map((ch, i) => (ch === " " || i < reveal ? ch : GLYPHS[(i * 7 + tick * 3) % GLYPHS.length]));
  return (
    <p className="scramble font-mono text-lg sm:text-xl font-bold tracking-[0.18em] text-red-200" data-testid="scan-scramble" aria-label={text}>
      {shown.map((ch, i) => <span key={i} className={cn(i < reveal ? "text-white" : "text-red-400")}>{ch}</span>)}
      <span className="caret" />
    </p>
  );
}

/** Asymptotic fake progress: races to ~90% then crawls, so it never lies
 *  about being done before the request returns. */
function useFakeProgress(active: boolean, done: boolean) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    if (done) { setPct(100); return; }
    if (!active) { setPct(0); return; }
    setPct(0);
    const id = setInterval(() => setPct((p) => Math.min(94, p + Math.max(0.4, (94 - p) * 0.09))), 160);
    return () => clearInterval(id);
  }, [active, done]);
  return Math.round(pct);
}

// "📸 Scan Model Tag / Serial" — point the camera at a laptop sticker, service
// tag or GPU label (or just type the model number). The result pre-fills the
// listing. Purely a suggestion layer: the seller can change anything.
export default function CyberScan({ onDetected, onUsePhoto, disabled, hero }: Props) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [source, setSource] = useState<Source>("photo");
  const [photo, setPhoto] = useState<PendingPhoto | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usedPhoto, setUsedPhoto] = useState(false);
  const [logStep, setLogStep] = useState(0);
  const [pickedCandidate, setPickedCandidate] = useState<number | null>(null);

  const status = useQuery<{ enabled: boolean }>({ queryKey: ["/api/portal/marketplace/scan/status"], staleTime: 5 * 60_000, retry: false });
  const photoEnabled = status.data?.enabled ?? true;

  const busy = phase === "preparing" || phase === "scanning";
  const log = source === "photo" ? PHOTO_LOG : TEXT_LOG;
  const progress = useFakeProgress(busy, phase === "done");
  // Frozen copy of the query for the scramble display, so edits to the input
  // mid-lookup don't change what's being "decoded".
  const [scanQuery, setScanQuery] = useState("");

  // Advance the decode log one line at a time while we wait on the server —
  // it's cosmetic pacing, the real work is a single request.
  useEffect(() => {
    if (!busy) return;
    setLogStep(0);
    const id = setInterval(() => setLogStep((n) => Math.min(n + 1, log.length - 1)), source === "text" ? 2200 : 900);
    return () => clearInterval(id);
  }, [busy, log.length, source]);

  // Seller picked one of the factory configurations for an ambiguous model.
  const pickCandidate = (index: number) => {
    if (!result) return;
    const c = result.candidates?.[index];
    if (!c) return;
    setPickedCandidate(index);
    const short = (c.specs.gpu || c.specs.cpu).replace(/^(NVIDIA|AMD|Intel)\s*/i, "").replace(/^(GeForce|Radeon|Core)\s*/i, "");
    const title = result.title && !result.title.includes(" - ") && short ? `${result.title} - ${short}${c.specs.ram ? " / " + c.specs.ram.replace(/\s.*$/, "") : ""}` : result.title;
    onDetected({ ...result, title, specs: c.specs, candidates: [] }, photo);
  };

  const finish = (data: ScanResult, frame: PendingPhoto | null) => {
    setResult(data);
    setPickedCandidate(null);
    if (data.detected) {
      setPhase("done");
      onDetected(data, frame);
    } else {
      setPhase("failed");
      setError(source === "photo"
        ? "Couldn't find a model number or specs in that shot. Try a closer, well-lit photo of the label — or type the model number."
        : "That didn't match a model or part number we recognise. Try the full model name (e.g. \"Legion 5 Pro 16ACH6H\") or scan the label.");
    }
  };

  const scanPhoto = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setSource("photo");
    setError(null); setResult(null); setUsedPhoto(false);
    setPhase("preparing");
    let frame: PendingPhoto;
    try {
      frame = await compressPhoto(file, SCAN_ENCODE);
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : "That photo could not be read");
      return;
    } finally {
      if (cameraInput.current) cameraInput.current.value = "";
      if (fileInput.current) fileInput.current.value = "";
    }
    setPhoto(frame);
    setPhase("scanning");
    try {
      const res = await apiRequest("POST", "/api/portal/marketplace/scan", { dataBase64: frame.dataBase64 });
      finish((await res.json()) as ScanResult, frame);
    } catch (e) {
      setPhase("failed");
      setError((e instanceof Error ? e.message : "Scan failed").replace(/^\d+:\s*/, ""));
    }
  };

  const lookupText = async () => {
    const q = query.trim();
    if (q.length < 2) { setError("Type a model or part number first."); setPhase("failed"); return; }
    setSource("text");
    setScanQuery(q);
    setError(null); setResult(null); setPhoto(null); setUsedPhoto(false);
    setPhase("scanning");
    try {
      const res = await apiRequest("POST", "/api/portal/marketplace/scan/lookup", { query: q });
      finish((await res.json()) as ScanResult, null);
    } catch (e) {
      setPhase("failed");
      setError((e instanceof Error ? e.message : "Lookup failed").replace(/^\d+:\s*/, ""));
    }
  };

  const reset = () => { setPhase("idle"); setPhoto(null); setResult(null); setError(null); setUsedPhoto(false); setPickedCandidate(null); };

  const found = result?.detected
    ? [result.brand && result.model ? `${result.brand} ${result.model}` : result.brand || result.model, result.specs.cpu, result.specs.gpu, result.specs.ram, result.specs.storage].filter(Boolean)
    : [];
  const filledCount = result?.detected ? [result.title, result.category, result.descriptionHook, ...Object.values(result.specs)].filter(Boolean).length : 0;
  const askingPrice = suggestedAskingPrice(result?.pricing ?? null);
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;

  return (
    <section
      className={cn(
        "hud relative overflow-hidden rounded-xl border transition-colors",
        hero ? "p-5 sm:p-7" : "p-4 sm:p-5",
        phase === "done" ? "border-emerald-500/50 bg-emerald-950/20 scan-locked" : "border-red-500/40 bg-gradient-to-br from-red-950/40 via-zinc-900 to-zinc-900 glow-red",
        busy && "scan-breathe",
      )}
      data-testid="panel-cyber-scan"
      data-phase={phase}
    >
      <div className="flex flex-col gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-red-400">
            <ScanLine className={cn("h-3.5 w-3.5", busy && "scan-icon-spin")} /> CyberScan · auto-fill engine
            {busy && <span className="ml-1 inline-flex items-center gap-1.5 rounded border border-red-500/60 bg-red-950/60 px-1.5 py-0.5 text-[10px] tracking-[0.2em] text-red-300" data-testid="badge-scan-live"><span className="pulse-dot-red inline-block h-1.5 w-1.5 rounded-full bg-red-500" /> LIVE</span>}
          </p>
          <h3 className={cn("mt-1 font-black tracking-tight text-white", hero ? "text-2xl sm:text-3xl" : "text-lg")}>
            Identify your hardware. <span className="text-red-500 text-glow-red">We fill in the rest.</span>
          </h3>
          <p className="mt-1 text-sm text-zinc-400 max-w-2xl">
            Snap the sticker on the bottom of a laptop, a Dell/HP/Lenovo service tag, or a GPU box — or type the model number. We decode it and pre-fill the title, category and spec matrix.
          </p>
        </div>

        {(phase === "idle" || phase === "failed") && (
          <div className="stagger grid gap-3 sm:grid-cols-2">
            {photoEnabled && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 flex items-center gap-1.5"><Camera className="h-3 w-3 text-red-500" /> Option A · photo</p>
                <Button type="button" onClick={() => cameraInput.current?.click()} disabled={disabled} className="w-full bg-red-600 hover:bg-red-500 text-white font-semibold glow-red-strong h-11" data-testid="button-scan-camera">
                  <Camera className="h-4 w-4 mr-2" /> 📸 Scan Model Tag / Serial
                </Button>
                <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={disabled} className="w-full border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white" data-testid="button-scan-upload">
                  <ImageUp className="h-4 w-4 mr-2" /> Upload a label photo
                </Button>
              </div>
            )}
            <div className={cn("rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2", !photoEnabled && "sm:col-span-2")}>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 flex items-center gap-1.5"><Keyboard className="h-3 w-3 text-red-500" /> {photoEnabled ? "Option B · " : ""}model number</p>
              {/* Not a <form>: this sits inside the listing form, so Enter is handled by hand. */}
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void lookupText(); } }}
                  placeholder="e.g. 82JQ · XPS 9520"
                  className="bg-zinc-950 border-zinc-800 text-white placeholder:text-zinc-600 font-mono focus-visible:ring-red-500 h-11"
                  disabled={disabled}
                  data-testid="input-scan-query"
                />
                <Button type="button" onClick={() => void lookupText()} disabled={disabled} className="h-11 bg-zinc-100 text-zinc-950 hover:bg-white font-semibold shrink-0" data-testid="button-scan-lookup">
                  <Sparkles className="h-4 w-4 mr-1.5" /> Decode
                </Button>
              </div>
              <p className="text-[11px] text-zinc-500">Model names, Lenovo type codes, HP/Dell product numbers, GPU part numbers — typos welcome. We also pull the going used price.</p>
            </div>
          </div>
        )}

        {phase !== "idle" && (
          <div className="funnel-enter flex flex-col sm:flex-row gap-4">
            {photo && (
              <div className="relative w-full sm:w-56 shrink-0 aspect-[4/3] overflow-hidden rounded-lg border border-zinc-700 bg-black">
                <img src={photo.previewUrl} alt="Label being scanned" className={cn("h-full w-full object-cover", busy && "opacity-80")} />
                {busy && <div className="scan-line" data-testid="scan-line" />}
                {busy && <div className="absolute inset-0 bg-[linear-gradient(rgba(239,68,68,0.08)_1px,transparent_1px)] bg-[length:100%_6px] pointer-events-none" />}
                {busy && <ScanOverlay />}
                {phase === "done" && <div className="lock-flash pointer-events-none absolute inset-0" aria-hidden />}
                <span className={cn("absolute bottom-1.5 left-1.5 term-badge bg-black/80", phase === "done" ? "text-emerald-400 border-emerald-500/70" : phase === "failed" ? "text-red-400 border-red-500/70" : "text-red-300 border-red-500/70")}>
                  {phase === "preparing" ? "Preparing" : phase === "scanning" ? "Decoding…" : phase === "done" ? "Decoded & synced" : "No match"}
                </span>
              </div>
            )}
            <div className="flex-1 min-w-0 text-sm">
              {busy && (
                <div data-testid="text-scan-progress">
                  {source === "text" && <ScrambleText text={scanQuery} active={busy} />}
                  <div className="mb-3 mt-2 flex items-center gap-3">
                    <div className="laser-bar flex-1" />
                    <span className="font-mono text-[11px] tabular-nums text-red-300" data-testid="text-scan-percent">{String(progress).padStart(2, "0")}%</span>
                  </div>
                  <ul className="font-mono text-xs space-y-1">
                    {log.slice(0, logStep + 1).map((line, i) => (
                      <li key={line} className={cn("log-line flex items-center gap-2", i < logStep ? "text-zinc-500" : "text-red-300 caret")}>
                        <span className="text-red-500">›</span> {line}{i < logStep ? " ✓" : ""}
                      </li>
                    ))}
                  </ul>
                  <HexFeed active={busy} />
                </div>
              )}
              {phase === "done" && result && (
                <div data-testid="text-scan-result" className="stagger">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" /> Decoded &amp; synced — <span className="tally-pop inline-block">{filledCount} fields auto-filled</span>
                    {result.grounded && <span className="term-badge inline-flex items-center gap-1 text-sky-300 border-sky-500/60 bg-sky-950/40" title="Checked against current web sources" data-testid="badge-grounded"><Globe className="h-3 w-3" /> Web-verified</span>}
                  </p>
                  {result.summary && (
                    <p className="mt-1.5 text-sm text-zinc-200" data-testid="text-scan-summary">
                      {result.summary}{result.releaseYear && !result.summary.includes(result.releaseYear) ? <span className="text-zinc-500"> · {result.releaseYear}</span> : null}
                    </p>
                  )}
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {found.map((f) => <li key={f} className="rounded border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 font-mono text-xs text-emerald-200">{f}</li>)}
                  </ul>
                  {(result.candidates?.length ?? 0) > 0 && (
                    <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-950/20 p-3" data-testid="panel-candidates">
                      <p className="text-xs font-semibold text-amber-300">This model shipped in a few configurations — which one is yours?</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {result.candidates.map((c, i) => (
                          <button
                            key={c.label}
                            type="button"
                            onClick={() => pickCandidate(i)}
                            data-testid={`button-candidate-${i}`}
                            className={cn(
                              "rounded-md border px-2.5 py-1.5 text-left font-mono text-[11px] transition",
                              pickedCandidate === i ? "border-emerald-500 bg-emerald-950/50 text-emerald-200" : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-amber-400 hover:text-white",
                            )}
                          >
                            {pickedCandidate === i ? "✓ " : ""}{c.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {result.pricing && (
                    <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-300" data-testid="text-scan-pricing">
                      <Tag className="h-3.5 w-3.5 text-red-500" />
                      <span>Going rate used: <span className="font-mono font-semibold text-white">{fmt(result.pricing.low)}–{fmt(result.pricing.high)}</span></span>
                      {askingPrice && <span className="font-mono text-zinc-500">· suggested asking {fmt(askingPrice)} (set on the next step)</span>}
                      {result.pricing.basis && <span className="text-zinc-500">· {result.pricing.basis}</span>}
                    </p>
                  )}
                  {(result.identifiers.serviceTag || result.identifiers.partNumber) && (
                    <p className="mt-2 font-mono text-[11px] text-zinc-500">
                      {result.identifiers.serviceTag && <>Service tag {result.identifiers.serviceTag} · </>}
                      {result.identifiers.partNumber && <>Part {result.identifiers.partNumber} · </>}
                      confidence {result.confidence}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-zinc-400">Check the fields — labels can be partial, and specs may have been upgraded since the factory.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {photo && onUsePhoto && !usedPhoto && (
                      <Button type="button" size="sm" variant="outline" className="border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white" onClick={() => { onUsePhoto(photo); setUsedPhoto(true); }} data-testid="button-scan-use-photo">
                        Add this photo to the listing
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" className="text-zinc-400 hover:text-white hover:bg-zinc-800" onClick={reset} data-testid="button-scan-again">
                      <X className="h-3.5 w-3.5 mr-1" /> Scan another
                    </Button>
                  </div>
                </div>
              )}
              {phase === "failed" && error && (
                <p className="rounded-md border border-red-500/40 bg-red-950/40 p-3 text-red-200" data-testid="text-scan-error">{error}</p>
              )}
            </div>
          </div>
        )}
      </div>

      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => scanPhoto(e.target.files)} data-testid="input-scan-camera" />
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => scanPhoto(e.target.files)} data-testid="input-scan-upload" />
    </section>
  );
}
