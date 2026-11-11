import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Globe, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type CheckResult = {
  host: string;
  error?: string;
  dns?: { ok: boolean; ms: number; addresses?: { address: string; family: string }[]; error?: string };
  http?: { ok: boolean; ms: number; scheme?: string; error?: string };
  port?: { ok: boolean; ms?: number; port?: number; error?: string };
};

function StatusRow({ ok, label, children }: { ok: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
      {ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-sm text-gray-500">{children}</div>
      </div>
    </div>
  );
}

export default function NetworkChecker() {
  const { toast } = useToast();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const portPresets = [
    ["HTTPS", "443"], ["DNS", "53"], ["RDP", "3389"], ["SMB", "445"],
    ["SSH", "22"], ["SMTP", "587"], ["IMAP", "993"],
  ];

  const run = async () => {
    if (!host.trim()) {
      toast({ title: "Enter a hostname or IP", variant: "destructive" });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await apiRequest("POST", "/api/tech-tools/network-check", {
        host: host.trim(),
        port: port.trim() || undefined,
      });
      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      toast({ title: "Check failed", description: e?.message || "Could not reach the server.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4 text-csd-red" /> Network Checker
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-500">
          Check if a host or website is reachable — DNS lookup, web server response, and an optional port test.
        </p>
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          This check runs from the service desk server. For the customer PC's gateway, Wi-Fi, DHCP, and DNS state, use the Adapter / DHCP / DNS bench command.
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <Label htmlFor="net-host">Hostname, IP, or URL</Label>
            <Input
              id="net-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="example.com or 8.8.8.8"
              className="font-mono"
              data-testid="input-net-host"
            />
          </div>
          <div className="w-28">
            <Label htmlFor="net-port">Port (optional)</Label>
            <Input
              id="net-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="443"
              className="font-mono"
              data-testid="input-net-port"
            />
          </div>
          <Button onClick={run} disabled={loading} data-testid="button-run-network-check">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {loading ? "Checking…" : "Check"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-500">Common ports:</span>
          {portPresets.map(([label, value]) => (
            <Button key={value} type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setPort(value)}>
              {label} {value}
            </Button>
          ))}
        </div>

        {result && (
          <div className="space-y-2" data-testid="network-results">
            {result.dns && (
              <StatusRow ok={result.dns.ok} label={`DNS lookup (${result.dns.ms} ms)`}>
                {result.dns.ok
                  ? result.dns.addresses?.map((a) => `${a.address} (${a.family})`).join(", ")
                  : result.dns.error}
              </StatusRow>
            )}
            {result.http && (
              <StatusRow ok={result.http.ok} label={`Web server (${result.http.ms} ms)`}>
                {result.http.ok ? (
                  <span>
                    Reachable on <Badge variant="secondary">{result.http.scheme?.toUpperCase()}</Badge>
                  </span>
                ) : (
                  result.http.error
                )}
              </StatusRow>
            )}
            {result.port && (
              <StatusRow ok={result.port.ok} label={`Port ${result.port.port ?? port}${result.port.ms != null ? ` (${result.port.ms} ms)` : ""}`}>
                {result.port.ok ? "Open — accepting connections" : result.port.error}
              </StatusRow>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
