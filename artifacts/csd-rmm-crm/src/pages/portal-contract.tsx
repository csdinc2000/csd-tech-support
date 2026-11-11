import { useEffect, useState } from "react";
import { ArrowLeft, FileSignature, LockKeyhole, ShieldCheck } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

function normalizeAccessCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/sign\/contract\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    const match = trimmed.match(/(?:\/sign\/contract\/)?([^/?#\s]+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
}

export default function PortalContract() {
  const [, setLocation] = useLocation();
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState("");

  const openAgreement = (rawValue = accessCode) => {
    const token = normalizeAccessCode(rawValue);
    if (!token || token.length < 20) {
      setError("Enter the secure agreement link or access code provided by Computer Systems Depot.");
      return;
    }
    setError("");
    setLocation(`/sign/contract/${encodeURIComponent(token)}`);
  };

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) {
      setAccessCode(token);
      openAgreement(token);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-2xl">
        <Link
          href="/portal"
          className="mb-5 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-red-600"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Customer Portal
        </Link>

        <div className="mb-6 text-center">
          <img src={csdLogo} alt="Computer Systems Depot" className="mx-auto h-16" />
          <h1 className="mt-4 text-3xl font-bold text-gray-900">Maintenance Agreement</h1>
          <p className="mt-2 text-gray-600">Securely review or sign your service agreement.</p>
        </div>

        <Card className="border-gray-200 shadow-sm">
          <CardHeader>
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-red-50 text-red-600">
              <FileSignature className="h-6 w-6" />
            </div>
            <CardTitle>Open your agreement</CardTitle>
            <CardDescription>
              Paste the complete agreement link from your email, or enter the access code from the end of that link.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label htmlFor="contract-access-code" className="mb-1.5 block text-sm font-medium text-gray-800">
                Secure agreement link or access code
              </label>
              <Input
                id="contract-access-code"
                value={accessCode}
                onChange={(event) => {
                  setAccessCode(event.target.value);
                  if (error) setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openAgreement();
                }}
                placeholder="Paste your secure agreement link"
                autoComplete="off"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "contract-access-error" : undefined}
              />
              {error && <p id="contract-access-error" className="mt-2 text-sm text-red-700">{error}</p>}
            </div>
            <Button className="w-full" onClick={() => openAgreement()} disabled={!accessCode.trim()}>
              <LockKeyhole className="mr-2 h-4 w-4" />
              Open secure agreement
            </Button>
          </CardContent>
        </Card>

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm">
            Agreements are protected by a private, expiring access code. Computer Systems Depot will never ask you
            to send your agreement code by text or public message.
          </p>
        </div>
      </div>
    </div>
  );
}