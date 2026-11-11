import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { HardDrive } from "lucide-react";

const UNITS: Record<string, number> = {
  bit: 1 / 8,
  Byte: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

const SPEED: Record<string, number> = {
  "Mbps": 1e6 / 8,
  "Gbps": 1e9 / 8,
  "MB/s": 1e6,
  "GB/s": 1e9,
};

function fmt(n: number): string {
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1e15 || (n < 1e-3 && n > 0)) return n.toExponential(3);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const units: [string, number][] = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  const parts: string[] = [];
  let rem = seconds;
  for (const [label, size] of units) {
    if (rem >= size) {
      const v = Math.floor(rem / size);
      rem -= v * size;
      parts.push(`${v}${label}`);
    }
  }
  if (parts.length === 0) return `${seconds.toFixed(1)}s`;
  return parts.slice(0, 2).join(" ");
}

export default function UnitConverter() {
  const [amount, setAmount] = useState("500");
  const [from, setFrom] = useState("GB");
  const bytes = (Number(amount) || 0) * (UNITS[from] ?? 1);

  const [fileSize, setFileSize] = useState("25");
  const [fileUnit, setFileUnit] = useState("GB");
  const [speed, setSpeed] = useState("100");
  const [speedUnit, setSpeedUnit] = useState("Mbps");
  const [efficiency, setEfficiency] = useState("80");

  const fileBytes = (Number(fileSize) || 0) * (UNITS[fileUnit] ?? 1);
  const bytesPerSec = (Number(speed) || 0) * (SPEED[speedUnit] ?? 1);
  const efficiencyFactor = Math.min(100, Math.max(1, Number(efficiency) || 80)) / 100;
  const transferSeconds = bytesPerSec > 0 ? fileBytes / (bytesPerSec * efficiencyFactor) : Infinity;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="h-4 w-4 text-csd-red" /> Storage &amp; Data Converter
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <Label className="mb-2 block text-sm font-semibold">Unit conversion</Label>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[120px]">
              <Label htmlFor="conv-amount" className="text-xs text-gray-500">Amount</Label>
              <Input id="conv-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" data-testid="input-convert-amount" />
            </div>
            <div className="w-28">
              <Label className="text-xs text-gray-500">Unit</Label>
              <Select value={from} onValueChange={setFrom}>
                <SelectTrigger data-testid="select-convert-unit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.keys(UNITS).map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-24">
              <Label className="text-xs text-gray-500">Efficiency %</Label>
              <Input type="number" min={1} max={100} value={efficiency} onChange={(e) => setEfficiency(e.target.value)} className="font-mono" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="convert-results">
            {Object.keys(UNITS).filter((u) => u !== from).map((u) => (
              <div key={u} className="rounded-md border bg-gray-50 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">{u}</div>
                <div className="font-mono text-sm font-medium">{fmt(bytes / UNITS[u])}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t pt-5">
          <Label className="mb-2 block text-sm font-semibold">Transfer time estimator</Label>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-24">
              <Label className="text-xs text-gray-500">File size</Label>
              <Input type="number" value={fileSize} onChange={(e) => setFileSize(e.target.value)} className="font-mono" data-testid="input-file-size" />
            </div>
            <div className="w-24">
              <Label className="text-xs text-gray-500">Unit</Label>
              <Select value={fileUnit} onValueChange={setFileUnit}>
                <SelectTrigger data-testid="select-file-unit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["MB", "GB", "TB", "MiB", "GiB", "TiB"].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-24">
              <Label className="text-xs text-gray-500">Speed</Label>
              <Input type="number" value={speed} onChange={(e) => setSpeed(e.target.value)} className="font-mono" data-testid="input-speed" />
            </div>
            <div className="w-28">
              <Label className="text-xs text-gray-500">Speed unit</Label>
              <Select value={speedUnit} onValueChange={setSpeedUnit}>
                <SelectTrigger data-testid="select-speed-unit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.keys(SPEED).map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-3 rounded-md border bg-csd-red/5 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-gray-400">Estimated transfer time</div>
            <div className="font-mono text-xl font-semibold text-csd-red" data-testid="text-transfer-time">{fmtTime(transferSeconds)}</div>
            <div className="text-[11px] text-gray-400">Includes the selected protocol/media efficiency. Use 70–85% for Wi-Fi or network copies.</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
