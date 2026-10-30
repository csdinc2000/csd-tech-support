import { useState } from "react";
import { AlertTriangle, Clipboard, Download, Package, Terminal, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  DEBLOAT_INSPECTION_COMMAND,
  TUNE_UP_COMMAND,
  WINDOWS_INTAKE_COMMAND,
} from "@/components/tech-tools/windows-commands";

const PACKAGES = [
  {
    id: "tune-up",
    name: "Tune-Up",
    summary: "Clears temp files, enables Storage Sense, runs Disk Cleanup, and resets search indexing.",
    command: TUNE_UP_COMMAND,
    changesSystem: true,
  },
  {
    id: "inspection",
    name: "Malware / Debloat inspection",
    summary: "Inventory optional software and non-Microsoft processes. No removals.",
    command: DEBLOAT_INSPECTION_COMMAND,
    changesSystem: false,
  },
  {
    id: "intake-scan",
    name: "Intake Scan",
    summary: "Collect the compact machine profile used for Gate 1 and Gate 2 notes.",
    command: WINDOWS_INTAKE_COMMAND,
    changesSystem: false,
  },
] as const;

export default function BenchCommands() {
  const { toast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(label);
      toast({ title: "Command copied", description: `${label} is ready for an elevated PowerShell window.` });
      window.setTimeout(() => setCopied((current) => current === label ? null : current), 1800);
    } catch {
      toast({ title: "Copy unavailable", description: "Clipboard access was blocked. Select the command manually.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-csd-red/30 shadow-md">
        <CardHeader className="border-b border-red-900/60 bg-csd-black px-4 py-4 text-white sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-red-300">
                <Terminal className="h-3.5 w-3.5" /> Bench console
              </div>
              <CardTitle className="text-lg tracking-tight text-white">Bench Commands</CardTitle>
              <CardDescription className="mt-1 text-gray-300">Static, reviewable PowerShell actions for Windows intake and triage.</CardDescription>
            </div>
            <Badge className="border-red-400/30 bg-red-500/15 text-red-200">SAFE BY DEFAULT</Badge>
          </div>
        </CardHeader>
         <CardContent className="space-y-5 bg-card p-4 sm:p-5">
           <div className="rounded-md border border-amber-300/70 bg-amber-50/80 p-3 text-xs text-amber-950 shadow-sm">
            <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>Review every command before running it. Tune-Up changes the client PC; inspection and intake packages are read-only.</span></div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div><h3 className="text-sm font-semibold">Windows intake one-liner</h3><p className="text-xs text-muted-foreground">Run in PowerShell on the client PC, then paste the output into the ticket.</p></div>
               <Button size="sm" variant="outline" onClick={() => copy("Windows intake", WINDOWS_INTAKE_COMMAND)}><Copy className="mr-2 h-3.5 w-3.5" />{copied === "Windows intake" ? "Copied" : "Copy"}</Button>
            </div>
              <code className="block max-h-32 overflow-auto rounded-md border border-stone-800 bg-[#171719] p-3 font-mono text-[11px] leading-relaxed text-emerald-300 shadow-inner">{WINDOWS_INTAKE_COMMAND}</code>
          </div>
          <Separator />
          <div>
            <div className="mb-3 flex items-center gap-2"><Package className="h-4 w-4 text-csd-red" /><h3 className="text-sm font-semibold">Quick-fix command packages</h3></div>
            <div className="grid gap-2">
              {PACKAGES.map((item) => (
                   <div key={item.id} className="group rounded-md border bg-muted/30 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-csd-red/50 hover:bg-red-50/40 hover:shadow-sm">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                     <div>
                       <div className="flex items-center gap-2 text-sm font-semibold">
                         {item.name}
                         <Badge variant={item.changesSystem ? "destructive" : "secondary"} className="text-[9px]">
                           {item.changesSystem ? "MAKES CHANGES" : "READ ONLY"}
                         </Badge>
                       </div>
                       <p className="text-xs text-muted-foreground">{item.summary}</p>
                     </div>
                    <Button size="sm" variant="outline" className="shrink-0" onClick={() => copy(item.name, item.command)}><Clipboard className="mr-2 h-3.5 w-3.5" />{copied === item.name ? "Copied" : "Copy package"}</Button>
                  </div>
                   <code className="mt-2 block max-h-20 overflow-auto rounded border border-stone-800 bg-[#171719] p-2 font-mono text-[10px] leading-relaxed text-slate-300">{item.command}</code>
                </div>
              ))}
            </div>
          </div>
          <Button className="w-full sm:w-auto" onClick={() => { window.location.href = "/api/tech-tools/windows-optimization-script"; }}>
            <Download className="mr-2 h-4 w-4" /> Download controlled cleanup script
          </Button>
          <p className="text-[11px] text-muted-foreground">The download is the controlled path for cleanup actions. Review it before execution and document approval.</p>
        </CardContent>
      </Card>
    </div>
  );
}