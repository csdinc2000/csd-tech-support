import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ClipboardCheck, Copy, RotateCcw, Terminal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { WINDOWS_INTAKE_COMMAND } from "@/components/tech-tools/windows-commands";

type Gate = { id: string; title: string; items: string[] };

const GATES: Gate[] = [
  {
    id: "g1",
    title: "Gate 1 — Environment Recon",
    items: [
      "Record make, model, and serial number",
      "Note reported symptoms in customer's words",
      "Photograph physical condition / damage",
      "Confirm OS version and last working state",
    ],
  },
  {
    id: "g2",
    title: "Gate 2 — Resource Exhaustion Audit",
    items: [
      "Check CPU / RAM / disk usage at idle",
      "Review startup programs and background services",
      "Check free disk space and SMART drive health",
      "Identify resource-hogging processes",
    ],
  },
  {
    id: "g3",
    title: "Gate 3 — Threat Perimeter Scan",
    items: [
      "Run full malware / antivirus scan",
      "Check for unwanted browser extensions / toolbars",
      "Review installed programs for PUPs",
      "Confirm firewall and Defender status",
    ],
  },
  {
    id: "g4",
    title: "Gate 4 — Thermal / Power Audit",
    items: [
      "Monitor CPU / GPU temperatures under load",
      "Inspect and clean dust from fans and vents",
      "Check thermal paste condition (if applicable)",
      "Verify PSU output / battery health",
    ],
  },
  {
    id: "g5",
    title: "Gate 5 — Optimization Strike",
    items: [
      "Install pending OS and driver updates",
      "Disable unnecessary startup items",
      "Clear temp files and run disk cleanup",
      "Defragment HDD / confirm TRIM on SSD",
    ],
  },
  {
    id: "g6",
    title: "Gate 6 — Resilience Testing",
    items: [
      "Stress test CPU / GPU / RAM for stability",
      "Re-check temperatures after optimization",
      "Confirm reported issue is resolved",
      "Run multiple reboots to verify consistency",
    ],
  },
  {
    id: "g7",
    title: "Gate 7 — Secure Handover",
    items: [
      "Confirm all customer data intact",
      "Document work performed in service log",
      "Set / confirm restore point or backup",
      "Brief customer and provide recommendations",
    ],
  },
];

const STORAGE_KEY = "csd:diagnostic-checklist";
const DETAILS_KEY = "csd:diagnostic-details";
export default function DiagnosticChecklist() {
  const { toast } = useToast();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [jobRef, setJobRef] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [findings, setFindings] = useState("");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setChecked(JSON.parse(stored));
      const details = JSON.parse(localStorage.getItem(DETAILS_KEY) || "{}");
      setJobRef(details.jobRef || "");
      setSymptoms(details.symptoms || "");
      setFindings(details.findings || "");
    } catch {}
  }, []);

  const persist = (next: Record<string, boolean>) => {
    setChecked(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  const toggle = (key: string) => persist({ ...checked, [key]: !checked[key] });

  const total = GATES.reduce((n, g) => n + g.items.length, 0);
  const done = Object.values(checked).filter(Boolean).length;
  const pct = Math.round((done / total) * 100);

  const reset = () => persist({});

  useEffect(() => {
    try { localStorage.setItem(DETAILS_KEY, JSON.stringify({ jobRef, symptoms, findings })); } catch {}
  }, [jobRef, symptoms, findings]);

  const copySummary = async () => {
    const lines: string[] = [
      "7-Gate Diagnostic Summary",
      jobRef ? `Ticket / asset: ${jobRef}` : "",
      `Progress: ${done}/${total} (${pct}%)`,
      symptoms ? `Reported symptoms: ${symptoms}` : "",
      findings ? `Technician findings: ${findings}` : "",
      "",
    ].filter((line, index) => Boolean(line) || index === 5);
    GATES.forEach((g) => {
      lines.push(g.title);
      g.items.forEach((item, i) => {
        const key = `${g.id}-${i}`;
        lines.push(`  [${checked[key] ? "x" : " "}] ${item}`);
      });
      lines.push("");
    });
    await navigator.clipboard.writeText(lines.join("\n"));
    toast({ title: "Summary copied", description: "Paste it into the service log." });
  };

  const copyClientCommand = async () => {
    try {
      await navigator.clipboard.writeText(WINDOWS_INTAKE_COMMAND);
      toast({ title: "Client PC command copied", description: "Run it in PowerShell, then paste the output into Gate 1/2 ticket notes." });
    } catch {
      toast({ title: "Copy unavailable", description: "Clipboard access was blocked. Select the command manually.", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4 text-csd-red" /> 7-Gate Diagnostic Checklist
          </CardTitle>
          <Badge variant="secondary" data-testid="badge-checklist-progress">{done}/{total} · {pct}%</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div className="h-full bg-csd-red transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs font-medium text-gray-500">Ticket, asset tag, or customer</label>
            <Input value={jobRef} onChange={(e) => setJobRef(e.target.value)} placeholder="Ticket #, serial, or customer name" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">Reported symptoms</label>
            <Textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} rows={3} placeholder="Record the customer's exact complaint and when it occurs…" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">Technician findings</label>
            <Textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} placeholder="SMART, thermals, test failures, repair performed, retest results…" />
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={copySummary} data-testid="button-copy-checklist">
            <Copy className="mr-2 h-4 w-4" /> Copy summary
          </Button>
          <Button variant="outline" size="sm" onClick={reset} data-testid="button-reset-checklist">
            <RotateCcw className="mr-2 h-4 w-4" /> Reset
          </Button>
        </div>
        <div className="rounded-md border border-csd-red/25 bg-red-50/50 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-2"><Terminal className="mt-0.5 h-4 w-4 shrink-0 text-csd-red" /><div><p className="text-sm font-semibold">Auto-Fill from Client PC</p><p className="text-xs text-muted-foreground">Copy a static intake command. Paste its generated output into Gate 1 / Gate 2 ticket notes.</p></div></div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={copyClientCommand}><Copy className="mr-2 h-4 w-4" /> Copy command</Button>
          </div>
          <code className="mt-3 block max-h-16 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] text-green-300">{WINDOWS_INTAKE_COMMAND}</code>
        </div>

        <div className="space-y-4">
          {GATES.map((gate) => {
            const gateDone = gate.items.filter((_, i) => checked[`${gate.id}-${i}`]).length;
            return (
              <div key={gate.id} className="rounded-md border">
                <div className="flex items-center justify-between border-b bg-gray-50 px-3 py-2">
                  <span className="text-sm font-semibold">{gate.title}</span>
                  <span className="text-xs text-gray-400">{gateDone}/{gate.items.length}</span>
                </div>
                <div className="space-y-1 p-3">
                  {gate.items.map((item, i) => {
                    const key = `${gate.id}-${i}`;
                    return (
                      <label key={key} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50">
                        <Checkbox
                          checked={!!checked[key]}
                          onCheckedChange={() => toggle(key)}
                          className="mt-0.5"
                          data-testid={`checkbox-${key}`}
                        />
                        <span className={checked[key] ? "text-gray-400 line-through" : ""}>{item}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
