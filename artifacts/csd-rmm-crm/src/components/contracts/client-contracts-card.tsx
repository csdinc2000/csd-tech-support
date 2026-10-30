import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCopy, FileSignature, Plus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const isSigningPath = (path: unknown): path is string =>
  typeof path === "string" && /^\/sign\/contract\/[A-Za-z0-9_-]{40,}$/.test(path);

export default function ClientContractsCard({ client }: { client: any }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [lastLink, setLastLink] = useState<{ path: string; clientId: number } | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState(String(client.id));
  const [terms, setTerms] = useState({ includedSupport: "", deviceLimits: "", onsiteWork: "", backups: "" });
  const clients = useQuery<any[]>({ queryKey: ["/api/clients"] });
  const contracts = useQuery<any[]>({ queryKey: [`/api/clients/${client.id}/contracts`] });
  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/service-contracts", {
      clientId: Number(selectedClientId),
      signerName: "",
      contractType: "Yearly with Monthly Installments", annualValueCents: 0,
      monthlyPaymentCents: 0,
      effectiveDate: new Date().toISOString().slice(0, 10),
      renewalType: "auto_annual", responseTimeSla: "To be completed",
      supportHours: "To be completed",
      terms: { includedSupport: "Remote helpdesk and proactive network monitoring as selected by the parties.", deviceLimits: "To be completed before signing.", onsiteWork: "Onsite work is billed separately unless expressly listed as included.", backups: "Provider manages and monitors configured backup software; Client retains ownership and responsibility for its data and recovery objectives." },
    })).json(),
    onSuccess: async (data: any) => {
      let copied = false;
      if (isSigningPath(data.signingPath)) {
        setLastLink({ path: data.signingPath, clientId: Number(selectedClientId) });
        try {
          await navigator.clipboard.writeText(`${window.location.origin}${data.signingPath}`);
          copied = true;
        } catch {
          // The link remains available below for manual copying.
        }
      }
      const selectedClient = clients.data?.find((item) => String(item.id) === selectedClientId);
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: [`/api/clients/${selectedClientId}/contracts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/contracts`] });
      if ((data.status === "sent" || data.signingPath != null) && !isSigningPath(data.signingPath)) {
        toast({ title: "Agreement created, but its signing link is unavailable", description: "Do not share an older link. Create a new link from the agreement.", variant: "destructive" });
        return;
      }
      toast({ title: "Agreement created", description: isSigningPath(data.signingPath) ? (copied ? "Secure signing link copied." : "Signing link ready; select it below to copy manually.") : `Draft created for ${selectedClient?.name || "the selected customer"}. Complete service coverage before creating a signing link.` });
    },
    onError: (error: Error) => toast({ title: "Could not create agreement", description: error.message, variant: "destructive" }),
  });
  const copySigningLink = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/service-contracts/${id}/signing-link`)).json(),
    onMutate: () => setLastLink(null),
    onSuccess: async (data: any) => {
      if (!isSigningPath(data.signingPath)) {
        toast({ title: "Could not read the new signing link", description: "Do not reuse a previous link. Please create another new link.", variant: "destructive" });
        return;
      }
      setLastLink({ path: data.signingPath, clientId: client.id });
      let copied = false;
      try {
        await navigator.clipboard.writeText(`${window.location.origin}${data.signingPath}`);
        copied = true;
      } catch {
        // The new link remains available below for manual copying.
      }
      queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/contracts`] });
      toast({ title: copied ? "New signing link copied" : "New signing link ready", description: copied ? "The link expires in 30 days. Any previous link is now invalid." : "Copy the link from the field below. Any previous link is now invalid." });
    },
    onError: (error: Error) => toast({ title: "Could not create signing link", description: error.message, variant: "destructive" }),
  });
  const saveTerms = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/service-contracts/${editing.id}`, { terms }),
    onSuccess: () => { setEditing(null); queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/contracts`] }); toast({ title: "Agreement coverage updated" }); },
    onError: (error: Error) => toast({ title: "Could not save coverage", description: error.message, variant: "destructive" }),
  });
  const editTerms = (contract: any) => { setEditing(contract); setTerms(contract.terms); };
  return <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div className="flex items-center justify-between border-b bg-gray-50/50 px-4 py-3"><div><h2 className="flex items-center gap-2 font-bold"><FileSignature className="h-4 w-4 text-csd-red" /> Service agreements</h2><p className="text-xs text-gray-500">Fillable agreements and electronic signatures</p></div><Button size="sm" onClick={() => { setSelectedClientId(String(client.id)); setCreateOpen(true); }}><Plus className="mr-1 h-4 w-4" /> Create</Button></div>
    {lastLink !== null && lastLink.clientId === client.id && (
      <div className="m-4 rounded-md bg-emerald-50 p-3 text-xs text-emerald-900">
        <label htmlFor={`contract-link-${client.id}`} className="font-semibold">Current signing link — share only with the intended signer</label>
        <div className="mt-2 flex gap-2">
          <input id={`contract-link-${client.id}`} aria-label="Current signing link" readOnly value={`${window.location.origin}${lastLink.path}`} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 rounded border border-emerald-200 bg-white px-2 py-1.5" />
          <Button size="sm" variant="outline" onClick={async () => {
            const link = lastLink;
            if (!link) return;
            try {
              await navigator.clipboard.writeText(`${window.location.origin}${link.path}`);
            } catch {
              document.getElementById(`contract-link-${client.id}`)?.focus();
              toast({ title: "Select the link to copy it manually", variant: "destructive" });
            }
          }}><ClipboardCopy className="mr-1 h-3.5 w-3.5" /> Copy</Button>
        </div>
      </div>
    )}
    <div className="divide-y">{contracts.isLoading ? <div className="p-4 text-sm text-gray-500">Loading agreements…</div> : !contracts.data?.length ? <div className="p-6 text-center text-sm text-gray-500">No agreements for this client.</div> : contracts.data.map((c) => <div key={c.id} className="flex items-center justify-between gap-3 p-4"><div><div className="text-sm font-medium">{c.title}</div><div className="mt-1 text-xs text-gray-500">Effective {String(c.effectiveDate).slice(0, 10)} · {(c.annualValueCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}/year</div></div><div className="flex flex-wrap items-center justify-end gap-2"><Badge className={c.status === "signed" ? "bg-emerald-100 text-emerald-800" : ""}>{c.status === "signed" && <CheckCircle2 className="mr-1 h-3 w-3" />}{c.status}</Badge>{c.status !== "signed" && <><Button size="sm" variant="outline" onClick={() => editTerms(c)}>Edit coverage</Button><Button size="sm" variant="outline" disabled={copySigningLink.isPending} onClick={() => { if (window.confirm("Create a new signing link? Any previously shared link will stop working immediately.")) copySigningLink.mutate(c.id); }}><ClipboardCopy className="mr-1 h-3.5 w-3.5" /> New link</Button></>}</div></div>)}</div>
    <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Complete service coverage</DialogTitle></DialogHeader><div className="grid gap-4"><TermField label="Included support" value={terms.includedSupport} onChange={(value) => setTerms({ ...terms, includedSupport: value })} /><TermField label="Device and user limits" value={terms.deviceLimits} onChange={(value) => setTerms({ ...terms, deviceLimits: value })} /><TermField label="Onsite work" value={terms.onsiteWork} onChange={(value) => setTerms({ ...terms, onsiteWork: value })} /><TermField label="Backups" value={terms.backups} onChange={(value) => setTerms({ ...terms, backups: value })} /></div><DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => saveTerms.mutate()} disabled={saveTerms.isPending}>{saveTerms.isPending ? "Saving…" : "Save coverage"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>Create service agreement</DialogTitle></DialogHeader><div><label className="text-sm font-medium">Customer or client</label><Select value={selectedClientId} onValueChange={setSelectedClientId}><SelectTrigger className="mt-1.5"><SelectValue placeholder={clients.isLoading ? "Loading CRM customers…" : "Select a CRM customer"} /></SelectTrigger><SelectContent>{clients.data?.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent></Select><p className="mt-2 text-xs text-gray-500">The agreement will use the selected CRM record’s current company name and address.</p></div><DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || clients.isLoading || !selectedClientId}>{create.isPending ? "Creating…" : "Create draft"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function TermField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-sm font-medium">{label}<Textarea className="mt-1.5" rows={3} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}