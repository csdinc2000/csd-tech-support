import { useState } from "react";
import { Check, ChevronDown, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { WINDOWS_SPECS_COMMAND, parseWindowsSpecs, type WindowsSpecs } from "@/lib/windows-specs";

const LABELS: Record<keyof WindowsSpecs, string> = { cpu: "processor", gpu: "graphics", ram: "memory", storage: "storage", os: "OS" };

/**
 * "No label to scan? Ask Windows." — copies a PowerShell one-liner for the
 * seller to run on the machine, then parses whatever they paste back and
 * hands the specs up to the form.
 */
export default function WindowsSpecsPaste({ onSpecs, disabled }: { onSpecs: (specs: WindowsSpecs) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ ok: true; keys: string[] } | { ok: false } | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(WINDOWS_SPECS_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (non-secure context / permissions) — the command is
      // shown in a selectable <code> block below as the fallback.
    }
  };

  const apply = (value: string) => {
    setText(value);
    if (!value.trim()) { setResult(null); return; }
    const specs = parseWindowsSpecs(value);
    if (!specs) { setResult({ ok: false }); return; }
    onSpecs(specs);
    setResult({ ok: true, keys: (Object.keys(specs) as Array<keyof WindowsSpecs>).map((k) => LABELS[k]) });
  };

  return (
    <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/60" data-testid="windows-specs-paste">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm text-zinc-300 hover:text-white"
        aria-expanded={open}
        data-testid="button-toggle-windows-specs"
      >
        <span className="flex items-center gap-2"><Terminal className="h-4 w-4 text-red-500" /> Selling a Windows PC? Pull the specs straight from it.</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-zinc-800 px-3 pb-3 pt-3">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-zinc-400">
            <li>On the PC you're selling, press <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 font-mono text-[11px] text-zinc-200">Win</kbd> + <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 font-mono text-[11px] text-zinc-200">X</kbd> and open <span className="text-zinc-200">Terminal</span> or <span className="text-zinc-200">PowerShell</span>. No admin rights needed.</li>
            <li>Paste the command below and press Enter. It only reads hardware info — it changes nothing.</li>
            <li>Copy the line it prints (it starts with <code className="font-mono text-zinc-300">{"{"}</code>) and paste it here.</li>
          </ol>

          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded border border-zinc-800 bg-black px-2 py-1.5 font-mono text-[11px] text-zinc-400" data-testid="text-windows-specs-command">
              {WINDOWS_SPECS_COMMAND}
            </code>
            <Button type="button" size="sm" variant="outline" onClick={copy} className="shrink-0 border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white" data-testid="button-copy-windows-specs">
              {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>

          <Textarea
            rows={3}
            value={text}
            disabled={disabled}
            placeholder='Paste the output here — e.g. {"CPU":"AMD Ryzen 7 7800X3D…'
            onChange={(e) => apply(e.target.value)}
            className="bg-zinc-950 border-zinc-800 font-mono text-xs text-white placeholder:text-zinc-600 focus-visible:ring-red-500"
            spellCheck={false}
            data-testid="input-windows-specs"
          />

          {result?.ok && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-400" data-testid="text-windows-specs-result">
              <Check className="h-3.5 w-3.5" /> Filled {result.keys.join(", ")} from Windows. Double-check them above.
            </p>
          )}
          {result && !result.ok && (
            <p className="text-xs text-amber-400" data-testid="text-windows-specs-result">
              Couldn't find any specs in that. Paste the whole line the command printed, or type the specs in above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
