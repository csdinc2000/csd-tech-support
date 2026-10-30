import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Wrench, Globe, HardDrive, ClipboardCheck, BookOpen, Calculator, KeyRound, Network, Terminal, Activity, ShieldCheck } from "lucide-react";
import NetworkChecker from "@/components/tech-tools/network-checker";
import UnitConverter from "@/components/tech-tools/unit-converter";
import DiagnosticChecklist from "@/components/tech-tools/diagnostic-checklist";
import CheatSheets from "@/components/tech-tools/cheat-sheets";
import RepairEstimator from "@/components/tech-tools/repair-estimator";
import PasswordGenerator from "@/components/tech-tools/password-generator";
import SubnetCalculator from "@/components/tech-tools/subnet-calculator";
import BenchCommands from "@/components/tech-tools/bench-commands";

const TOOLS = [
  { id: "bench", label: "Bench Commands", icon: Terminal },
  { id: "network", label: "Network Check", icon: Globe },
  { id: "subnet", label: "Subnet / IP", icon: Network },
  { id: "converter", label: "Converter", icon: HardDrive },
  { id: "estimator", label: "Estimator", icon: Calculator },
  { id: "password", label: "Password", icon: KeyRound },
  { id: "checklist", label: "7-Gate", icon: ClipboardCheck },
  { id: "cheatsheets", label: "Cheat Sheets", icon: BookOpen },
];

export default function TechTools() {
  const [tab, setTab] = useState("bench");

  return (
    <div className="min-h-[calc(100dvh-4rem)] p-3 sm:p-6">
      <div className="mx-auto max-w-7xl">
      <div className="relative mb-5 overflow-hidden rounded-xl border border-csd-red/30 bg-csd-black px-5 py-5 text-white shadow-lg sm:px-7">
        <div className="absolute right-0 top-0 h-full w-1/3 bg-gradient-to-l from-csd-red/20 to-transparent" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-csd-red text-white shadow-[0_0_0_4px_rgba(193,29,42,.18)]">
              <Wrench className="h-5 w-5" />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-red-300"><Activity className="h-3 w-3" /> Technician workbench</div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl" data-testid="text-page-title">Tech Tools</h1>
              <p className="mt-1 text-sm text-stone-300">The fast lane for intake, diagnosis, repair, and field support.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-300"><ShieldCheck className="h-4 w-4 text-red-300" /> Review before execution</div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex h-auto w-full flex-nowrap justify-start gap-1 overflow-x-auto rounded-lg border border-border bg-stone-200/70 p-1.5 scrollbar-thin">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.id} value={t.id} className="shrink-0 gap-1.5 rounded-md px-3 py-2 text-xs data-[state=active]:bg-csd-black data-[state=active]:text-white data-[state=active]:shadow-md sm:text-sm" data-testid={`tab-${t.id}`}>
                <Icon className="h-4 w-4" /> {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <div className="mx-auto max-w-5xl">
          <TabsContent value="bench"><BenchCommands /></TabsContent>
          <TabsContent value="network"><NetworkChecker /></TabsContent>
          <TabsContent value="subnet"><SubnetCalculator /></TabsContent>
          <TabsContent value="converter"><UnitConverter /></TabsContent>
          <TabsContent value="estimator"><RepairEstimator /></TabsContent>
          <TabsContent value="password"><PasswordGenerator /></TabsContent>
          <TabsContent value="checklist"><DiagnosticChecklist /></TabsContent>
          <TabsContent value="cheatsheets"><CheatSheets /></TabsContent>
        </div>
      </Tabs>
      </div>
    </div>
  );
}
