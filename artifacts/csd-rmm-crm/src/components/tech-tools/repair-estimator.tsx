import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Calculator, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Service = { id: string; name: string; hours: number };

const SERVICES: Service[] = [
  { id: "diag", name: "Full diagnostic (7-Gate)", hours: 1 },
  { id: "os", name: "OS reinstall / setup", hours: 2 },
  { id: "malware", name: "Virus / malware removal", hours: 1.5 },
  { id: "tuneup", name: "Tune-up / optimization", hours: 1 },
  { id: "datatransfer", name: "Data backup / transfer", hours: 1.5 },
  { id: "ssd", name: "SSD / drive upgrade + clone", hours: 1.5 },
  { id: "ram", name: "RAM upgrade", hours: 0.5 },
  { id: "screen", name: "Laptop screen replacement", hours: 1.5 },
  { id: "battery", name: "Battery replacement", hours: 0.75 },
  { id: "thermal", name: "Cleaning + thermal paste", hours: 1 },
  { id: "psu", name: "Power supply replacement", hours: 1 },
  { id: "datarecovery", name: "Data recovery (basic)", hours: 3 },
];

export default function RepairEstimator() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rate, setRate] = useState("95");
  const [parts, setParts] = useState("0");
  const [complexity, setComplexity] = useState("1");
  const [taxRate, setTaxRate] = useState("7");
  const [discount, setDiscount] = useState("0");

  const toggle = (id: string) => setSelected((s) => ({ ...s, [id]: !s[id] }));

  const baseHours = SERVICES.filter((s) => selected[s.id]).reduce((n, s) => n + s.hours, 0);
  const mult = Number(complexity) || 1;
  const hours = baseHours * mult;
  const rateNum = Number(rate) || 0;
  const partsNum = Number(parts) || 0;
  const labor = hours * rateNum;
  const subtotal = labor + partsNum;
  const discountNum = Math.max(0, Number(discount) || 0);
  const afterDiscount = Math.max(0, subtotal - discountNum);
  const tax = afterDiscount * Math.max(0, Number(taxRate) || 0) / 100;
  const total = afterDiscount + tax;

  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const copyQuote = async () => {
    const chosen = SERVICES.filter((s) => selected[s.id]);
    if (chosen.length === 0) {
      toast({ title: "Select at least one service", variant: "destructive" });
      return;
    }
    const lines = [
      "Repair Estimate",
      ...chosen.map((s) => `- ${s.name} (${s.hours}h)`),
      "",
      `Estimated labor: ${hours.toFixed(2)} h @ ${money(rateNum)}/h = ${money(labor)}`,
      `Parts: ${money(partsNum)}`,
      `Subtotal: ${money(subtotal)}`,
      `Discount: -${money(discountNum)}`,
      `Tax (${Number(taxRate) || 0}%): ${money(tax)}`,
      `Estimated total: ${money(total)}`,
      "",
      "Estimate only — final price may vary after diagnosis.",
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    toast({ title: "Quote copied to clipboard" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="h-4 w-4 text-csd-red" /> Repair Time &amp; Cost Estimator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SERVICES.map((s) => (
            <label
              key={s.id}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              data-testid={`service-${s.id}`}
            >
              <span className="flex items-center gap-2">
                <Checkbox checked={!!selected[s.id]} onCheckedChange={() => toggle(s.id)} />
                {s.name}
              </span>
              <span className="text-xs text-gray-400">{s.hours}h</span>
            </label>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          <div>
            <Label htmlFor="est-rate" className="text-xs text-gray-500">Labor rate ($/hr)</Label>
            <Input id="est-rate" type="number" value={rate} onChange={(e) => setRate(e.target.value)} className="font-mono" data-testid="input-labor-rate" />
          </div>
          <div>
            <Label htmlFor="est-discount" className="text-xs text-gray-500">Discount ($)</Label>
            <Input id="est-discount" type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label htmlFor="est-tax" className="text-xs text-gray-500">Tax rate (%)</Label>
            <Input id="est-tax" type="number" min={0} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label htmlFor="est-parts" className="text-xs text-gray-500">Parts cost ($)</Label>
            <Input id="est-parts" type="number" value={parts} onChange={(e) => setParts(e.target.value)} className="font-mono" data-testid="input-parts-cost" />
          </div>
          <div>
            <Label htmlFor="est-complexity" className="text-xs text-gray-500">Complexity</Label>
            <select
              id="est-complexity"
              value={complexity}
              onChange={(e) => setComplexity(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="select-complexity"
            >
              <option value="0.75">Simple (×0.75)</option>
              <option value="1">Standard (×1)</option>
              <option value="1.5">Tricky (×1.5)</option>
              <option value="2">Complex (×2)</option>
            </select>
          </div>
        </div>

        <div className="rounded-md border bg-csd-red/5 px-4 py-3">
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">Est. hours</div>
              <div className="font-mono text-lg font-semibold" data-testid="text-est-hours">{hours.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">Labor</div>
              <div className="font-mono text-lg font-semibold" data-testid="text-est-labor">{money(labor)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">Tax</div>
              <div className="font-mono text-lg font-semibold">{money(tax)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-400">Total</div>
              <div className="font-mono text-lg font-semibold text-csd-red" data-testid="text-est-total">{money(total)}</div>
            </div>
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={copyQuote} data-testid="button-copy-quote">
          <Copy className="mr-2 h-4 w-4" /> Copy quote
        </Button>
      </CardContent>
    </Card>
  );
}
