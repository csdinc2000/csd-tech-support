import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Network } from "lucide-react";

type Result = {
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  mask: string;
  wildcard: string;
  cidr: number;
  totalHosts: number;
  usableHosts: number;
};

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function calculate(ip: string, cidr: number): Result | null {
  const ipInt = ipToInt(ip);
  if (ipInt === null || cidr < 0 || cidr > 32) return null;
  const mask = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = cidr >= 31 ? Math.pow(2, 32 - cidr) : Math.pow(2, 32 - cidr);
  const usable = cidr >= 31 ? (cidr === 32 ? 1 : 2) : Math.max(0, total - 2);
  return {
    network: intToIp(network),
    broadcast: intToIp(broadcast),
    firstHost: cidr >= 31 ? intToIp(network) : intToIp(network + 1),
    lastHost: cidr >= 31 ? intToIp(broadcast) : intToIp(broadcast - 1),
    mask: intToIp(mask),
    wildcard: intToIp(~mask >>> 0),
    cidr,
    totalHosts: total,
    usableHosts: usable,
  };
}

export default function SubnetCalculator() {
  const [ip, setIp] = useState("192.168.1.10");
  const [cidr, setCidr] = useState("24");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  const run = () => {
    const c = Number(cidr);
    const r = calculate(ip.trim(), c);
    if (!r) {
      setError("Enter a valid IPv4 address and a CIDR between 0 and 32.");
      setResult(null);
      return;
    }
    setError("");
    setResult(r);
  };

  const rows: [string, string][] = result
    ? [
        ["Network address", result.network],
        ["Usable range", `${result.firstHost} – ${result.lastHost}`],
        ["Broadcast address", result.broadcast],
        ["Subnet mask", result.mask],
        ["Wildcard mask", result.wildcard],
        ["Total addresses", result.totalHosts.toLocaleString()],
        ["Usable hosts", result.usableHosts.toLocaleString()],
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4 text-csd-red" /> Subnet / IP Calculator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <Label htmlFor="subnet-ip">IPv4 address</Label>
            <Input id="subnet-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.10" className="font-mono" data-testid="input-subnet-ip" />
          </div>
          <div className="w-28">
            <Label htmlFor="subnet-cidr">CIDR (/)</Label>
            <Input id="subnet-cidr" type="number" min={0} max={32} value={cidr} onChange={(e) => setCidr(e.target.value)} className="font-mono" data-testid="input-subnet-cidr" />
          </div>
          <Button onClick={run} data-testid="button-calculate-subnet">Calculate</Button>
        </div>

        {error && <p className="text-sm text-red-600" data-testid="text-subnet-error">{error}</p>}

        {result && (
          <div className="overflow-hidden rounded-md border" data-testid="subnet-results">
            <table className="w-full text-sm">
              <tbody>
                {rows.map(([k, v], i) => (
                  <tr key={k} className={i % 2 ? "bg-gray-50" : ""}>
                    <td className="px-3 py-2 text-gray-500">{k}</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
