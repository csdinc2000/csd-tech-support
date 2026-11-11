import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Trophy,
  XCircle,
  Trash2,
  History,
  Phone,
  Voicemail,
  Ticket,
  MessageSquare,
  DollarSign,
  Ticket as TicketIcon,
  Briefcase,
  CalendarDays,
  Wrench,
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePipelineSync } from "@/hooks/use-pipeline-sync";
import { DEAL_STAGES, type CrmDeal, type CrmContact, type DealStage } from "@shared/schema";
import { format } from "date-fns";

const stageMeta: Record<DealStage, { label: string; color: string; column: string }> = {
  lead: { label: "Lead", color: "bg-blue-100 text-blue-800", column: "border-t-blue-400" },
  discovery: { label: "Discovery", color: "bg-indigo-100 text-indigo-800", column: "border-t-indigo-400" },
  proposal: { label: "Proposal", color: "bg-amber-100 text-amber-800", column: "border-t-amber-400" },
  won: { label: "Won", color: "bg-green-100 text-green-800", column: "border-t-green-500" },
  lost: { label: "Lost", color: "bg-gray-200 text-gray-600", column: "border-t-gray-400" },
};

interface TimelineItem {
  interactionType: "call" | "voicemail" | "ticket" | "interaction" | "appointment" | "job";
  itemId: number;
  timestamp: string;
  durationSeconds: number | null;
  description: string;
  assetUrl: string | null;
}

const timelineIcons = {
  call: Phone,
  voicemail: Voicemail,
  ticket: Ticket,
  interaction: MessageSquare,
  appointment: CalendarDays,
  job: Wrench,
} as const;

const money = (v: string | number | null | undefined) =>
  `$${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const emptyForm = {
  title: "",
  companyName: "",
  estimatedMrr: "",
  oneTimeFee: "",
  primaryContactId: "",
  notes: "",
};

export default function CrmPipeline({ embedded = false }: { embedded?: boolean } = {}) {
  const { toast } = useToast();
  const { stats } = usePipelineSync();
  const [showDealDialog, setShowDealDialog] = useState(false);
  const [timelineDeal, setTimelineDeal] = useState<CrmDeal | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: deals = [], isLoading } = useQuery<CrmDeal[]>({
    queryKey: ["/api/crm/deals"],
  });
  const { data: contacts = [] } = useQuery<CrmContact[]>({
    queryKey: ["/api/crm/contacts"],
  });
  const { data: timelineData, isLoading: timelineLoading } = useQuery<{
    deal: CrmDeal;
    timeline: TimelineItem[];
  }>({
    queryKey: [`/api/crm/deals/${timelineDeal?.id}/timeline`],
    enabled: !!timelineDeal,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/crm/deals"] });
    queryClient.invalidateQueries({ queryKey: ["/api/crm/pipeline/stats"] });
  };

  const createDealMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/crm/deals", {
        title: form.title,
        companyName: form.companyName,
        estimatedMrr: form.estimatedMrr || "0",
        oneTimeFee: form.oneTimeFee || "0",
        primaryContactId: form.primaryContactId ? parseInt(form.primaryContactId, 10) : null,
        notes: form.notes || null,
      });
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Deal created" });
      setShowDealDialog(false);
      setForm(emptyForm);
    },
    onError: () => toast({ title: "Failed to create deal", variant: "destructive" }),
  });

  const stageMutation = useMutation({
    mutationFn: async ({ id, stage }: { id: number; stage: DealStage }) => {
      const res = await apiRequest("PATCH", `/api/crm/deals/${id}/stage`, { stage });
      return (await res.json()) as { deal: CrmDeal; onboardingTicket: { ticketNumber?: string; id: number } | null };
    },
    onSuccess: ({ deal, onboardingTicket }) => {
      invalidate();
      if (onboardingTicket) {
        toast({
          title: `Deal won! 🎉`,
          description: `Onboarding ticket ${onboardingTicket.ticketNumber ?? `#${onboardingTicket.id}`} was created automatically.`,
        });
      } else {
        toast({ title: `Moved to ${stageMeta[deal.stage as DealStage]?.label ?? deal.stage}` });
      }
    },
    onError: () => toast({ title: "Failed to move deal", variant: "destructive" }),
  });

  const deleteDealMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/crm/deals/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Deal deleted" });
    },
    onError: () => toast({ title: "Failed to delete deal", variant: "destructive" }),
  });

  const contactName = (id: number | null) =>
    contacts.find((c) => c.id === id)?.fullName ?? null;

  return (
    <div className={embedded ? "space-y-4" : "p-4 md:p-6 space-y-4"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!embedded && (
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Sales Pipeline</h1>
            <p className="text-sm text-gray-500">
              Live deal board — updates sync to every technician in real time
            </p>
          </div>
        )}
        <Button onClick={() => setShowDealDialog(true)} className={embedded ? "ml-auto" : undefined}>
          <Plus className="w-4 h-4 mr-2" /> New Deal
        </Button>
      </div>

      {/* Live stat badges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <TicketIcon className="w-8 h-8 text-sky-500" />
            <div>
              <p className="text-2xl font-bold">{stats?.openTickets ?? "—"}</p>
              <p className="text-xs text-gray-500">Open Tickets</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Briefcase className="w-8 h-8 text-indigo-500" />
            <div>
              <p className="text-2xl font-bold">{stats?.activeDeals ?? "—"}</p>
              <p className="text-xs text-gray-500">Active Deals</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="w-8 h-8 text-amber-500" />
            <div>
              <p className="text-2xl font-bold">{stats ? money(stats.pipelineMrr) : "—"}</p>
              <p className="text-xs text-gray-500">Pipeline MRR</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Trophy className="w-8 h-8 text-green-500" />
            <div>
              <p className="text-2xl font-bold">
                {stats ? `${stats.wonThisMonth} · ${money(stats.wonMrrThisMonth)}` : "—"}
              </p>
              <p className="text-xs text-gray-500">Won This Month</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Kanban board */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {DEAL_STAGES.map((stage) => {
          const meta = stageMeta[stage];
          const stageDeals = deals.filter((d) => d.stage === stage);
          const stageMrr = stageDeals.reduce((sum, d) => sum + Number(d.estimatedMrr ?? 0), 0);
          return (
            <div key={stage} className={`bg-white rounded-lg border border-t-4 ${meta.column} p-3 space-y-3`}>
              <div className="flex items-center justify-between">
                <Badge className={meta.color}>{meta.label}</Badge>
                <span className="text-xs text-gray-500">
                  {stageDeals.length} · {money(stageMrr)}/mo
                </span>
              </div>
              {isLoading && <p className="text-xs text-gray-400">Loading…</p>}
              {!isLoading && stageDeals.length === 0 && (
                <p className="text-xs text-gray-400 italic">No deals</p>
              )}
              {stageDeals.map((deal) => (
                <Card key={deal.id} className="shadow-sm">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{deal.title}</p>
                        <p className="text-xs text-gray-500 truncate">{deal.companyName}</p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="360° history"
                          onClick={() => setTimelineDeal(deal)}
                        >
                          <History className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-gray-400 hover:text-red-500"
                          title="Delete deal"
                          onClick={() => {
                            if (confirm(`Delete deal "${deal.title}"?`)) {
                              deleteDealMutation.mutate(deal.id);
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-gray-600">
                      {money(deal.estimatedMrr)}/mo
                      {Number(deal.oneTimeFee) > 0 && <> + {money(deal.oneTimeFee)} setup</>}
                    </p>
                    {contactName(deal.primaryContactId) && (
                      <p className="text-xs text-gray-500 truncate">
                        👤 {contactName(deal.primaryContactId)}
                      </p>
                    )}
                    {deal.notes && (
                      <p className="line-clamp-2 text-xs text-gray-400" title={deal.notes}>
                        {deal.notes}
                      </p>
                    )}
                    <div className="flex items-center gap-1 pt-1">
                      <Select
                        value={deal.stage}
                        onValueChange={(v) => stageMutation.mutate({ id: deal.id, stage: v as DealStage })}
                      >
                        <SelectTrigger className="h-7 text-xs flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DEAL_STAGES.map((s) => (
                            <SelectItem key={s} value={s} className="text-xs">
                              {stageMeta[s].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {stage !== "won" && stage !== "lost" && (
                        <>
                          <Button
                            size="icon"
                            className="h-7 w-7 bg-green-600 hover:bg-green-500"
                            title="Mark Won (auto-creates onboarding ticket)"
                            onClick={() => stageMutation.mutate({ id: deal.id, stage: "won" })}
                          >
                            <Trophy className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-7 w-7"
                            title="Mark Lost"
                            onClick={() => stageMutation.mutate({ id: deal.id, stage: "lost" })}
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          );
        })}
      </div>

      {/* New deal dialog */}
      <Dialog open={showDealDialog} onOpenChange={setShowDealDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Deal</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="deal-title">Title *</Label>
              <Input
                id="deal-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Managed services for Acme"
              />
            </div>
            <div>
              <Label htmlFor="deal-company">Company *</Label>
              <Input
                id="deal-company"
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                placeholder="Acme Corporation"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="deal-mrr">Estimated MRR ($/mo)</Label>
                <Input
                  id="deal-mrr"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.estimatedMrr}
                  onChange={(e) => setForm({ ...form, estimatedMrr: e.target.value })}
                  placeholder="1500"
                />
              </div>
              <div>
                <Label htmlFor="deal-fee">One-Time Fee ($)</Label>
                <Input
                  id="deal-fee"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.oneTimeFee}
                  onChange={(e) => setForm({ ...form, oneTimeFee: e.target.value })}
                  placeholder="500"
                />
              </div>
            </div>
            <div>
              <Label>Primary Contact</Label>
              <Select
                value={form.primaryContactId}
                onValueChange={(v) => setForm({ ...form, primaryContactId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a contact (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.fullName}
                      {c.company ? ` — ${c.company}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="deal-notes">Notes</Label>
              <Textarea
                id="deal-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowDealDialog(false)}>
                Cancel
              </Button>
              <Button
                disabled={!form.title || !form.companyName || createDealMutation.isPending}
                onClick={() => createDealMutation.mutate()}
              >
                Create Deal
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 360° timeline dialog */}
      <Dialog open={!!timelineDeal} onOpenChange={(open) => !open && setTimelineDeal(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>360° History — {timelineDeal?.title}</DialogTitle>
          </DialogHeader>
          {timelineLoading && <p className="text-sm text-gray-500">Loading timeline…</p>}
          {!timelineLoading && timelineData?.timeline.length === 0 && (
            <p className="text-sm text-gray-500">
              No linked activity yet. Calls, voicemails, tickets, appointments, jobs and CRM
              activity attached to this deal will appear here.
            </p>
          )}
          <div className="space-y-3">
            {timelineData?.timeline.map((item) => {
              const Icon = timelineIcons[item.interactionType] ?? MessageSquare;
              return (
                <div
                  key={`${item.interactionType}-${item.itemId}`}
                  className="flex gap-3 border-l-2 border-gray-200 pl-3"
                >
                  <Icon className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800">{item.description}</p>
                    <p className="text-xs text-gray-500">
                      {format(new Date(item.timestamp), "MMM d, yyyy h:mm a")}
                      {item.durationSeconds != null && <> · {item.durationSeconds}s</>}
                      {item.assetUrl && (
                        <>
                          {" · "}
                          <a
                            href={item.assetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-600 hover:underline"
                          >
                            Recording
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
