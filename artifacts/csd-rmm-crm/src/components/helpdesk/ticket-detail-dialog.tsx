import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Ticket,
  TicketMessage,
  TicketActivity,
  TicketAttachment,
  TicketDepartment,
  TicketTeam,
  CannedResponse,
  SlaPlan,
  TicketHelpTopic,
  User,
} from "@shared/schema";
import { Lock, Unlock, Send, Paperclip, RefreshCw, Download } from "lucide-react";

type TimelineMessage = TicketMessage & {
  proxyStatus?: "pending" | "delivered" | "failed";
  proxyError?: string | null;
};

interface Props {
  ticketId: number;
  open: boolean;
  onClose: () => void;
}

export default function TicketDetailDialog({ ticketId, open, onClose }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [tab, setTab] = useState("thread");

  const { data: ticket } = useQuery<Ticket>({
    queryKey: [`/api/tickets/${ticketId}`],
    enabled: open && !!ticketId,
  });
  const { data: messages = [] } = useQuery<TimelineMessage[]>({
    queryKey: [`/api/tickets/${ticketId}/messages`],
    enabled: open && !!ticketId,
  });
  const { data: activity = [] } = useQuery<TicketActivity[]>({
    queryKey: [`/api/tickets/${ticketId}/activity`],
    enabled: open && !!ticketId,
  });
  const { data: attachments = [] } = useQuery<TicketAttachment[]>({
    queryKey: [`/api/tickets/${ticketId}/attachments`],
    enabled: open && !!ticketId,
  });
  const { data: departments = [] } = useQuery<TicketDepartment[]>({
    queryKey: ["/api/helpdesk/departments"],
    enabled: open,
  });
  const { data: teams = [] } = useQuery<TicketTeam[]>({
    queryKey: ["/api/helpdesk/teams"],
    enabled: open,
  });
  const { data: topics = [] } = useQuery<TicketHelpTopic[]>({
    queryKey: ["/api/helpdesk/help-topics"],
    enabled: open,
  });
  const { data: slaPlans = [] } = useQuery<SlaPlan[]>({
    queryKey: ["/api/helpdesk/sla-plans"],
    enabled: open,
  });
  const { data: canned = [] } = useQuery<CannedResponse[]>({
    queryKey: ["/api/helpdesk/canned-responses"],
    enabled: open,
  });
  const { data: usersList = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: open,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [`/api/tickets/${ticketId}`] });
    qc.invalidateQueries({ queryKey: [`/api/tickets/${ticketId}/messages`] });
    qc.invalidateQueries({ queryKey: [`/api/tickets/${ticketId}/activity`] });
    qc.invalidateQueries({ queryKey: [`/api/tickets/${ticketId}/attachments`] });
    qc.invalidateQueries({ queryKey: ["/api/tickets"] });
  };

  const replyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/messages`, {
        body: reply,
        isInternal: internal,
        authorType: "staff",
      });
      return res.json();
    },
    onSuccess: () => {
      setReply("");
      invalidate();
      toast({ title: internal ? "Internal note added" : "Reply sent" });
    },
    onError: (e: any) => toast({ title: "Failed to send", description: e.message, variant: "destructive" }),
  });

  const lockMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/lock`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Locked" }); },
    onError: (e: any) => toast({ title: "Lock failed", description: e.message, variant: "destructive" }),
  });
  const unlockMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/unlock`, {});
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Unlocked" }); },
  });

  const assignMutation = useMutation({
    mutationFn: async (vars: { assignedTo?: number | null; teamId?: number | null; note?: string }) => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/assign`, vars);
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Assignment updated" }); },
  });

  const transferMutation = useMutation({
    mutationFn: async (vars: { departmentId: number; note?: string }) => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/transfer`, vars);
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Transferred" }); },
  });

  const statusMutation = useMutation({
    mutationFn: async (status: string) => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/status`, { status });
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Status updated" }); },
  });

  const updateMutation = useMutation({
    mutationFn: async (patch: Partial<Ticket>) => {
      const res = await apiRequest("PUT", `/api/tickets/${ticketId}`, patch);
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Saved" }); },
  });

  const applyCannedMutation = useMutation({
    mutationFn: async (cannedId: number) => {
      const res = await apiRequest("POST", `/api/tickets/${ticketId}/apply-canned/${cannedId}`, { internal });
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "Canned response applied" }); },
  });

  const uploadAttachment = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.split(",")[1];
      try {
        await apiRequest("POST", `/api/tickets/${ticketId}/attachments`, {
          filename: file.name,
          mimeType: file.type,
          dataBase64: base64,
        });
        invalidate();
        toast({ title: "Attachment uploaded" });
      } catch (e: any) {
        toast({ title: "Upload failed", description: e.message, variant: "destructive" });
      }
    };
    reader.readAsDataURL(file);
  };

  // Combine messages + activity into a unified timeline view for "thread"
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime(),
  );

  useEffect(() => {
    if (!open) { setReply(""); setInternal(false); setTab("thread"); }
  }, [open]);

  if (!ticket) {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Loading...</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const overdueBadge = ticket.slaDueAt && new Date(ticket.slaDueAt) < new Date() &&
    ticket.status !== "closed" && ticket.status !== "resolved";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="font-mono text-sm text-gray-500">
              {ticket.ticketNumber || `#${ticket.id}`}
            </span>
            <span>{ticket.subject}</span>
            <Badge>{ticket.priority}</Badge>
            <Badge variant="outline">{ticket.status}</Badge>
            {overdueBadge && <Badge variant="destructive">OVERDUE</Badge>}
            {ticket.lockedBy && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Lock className="h-3 w-3" /> Locked
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col lg:flex-row gap-4 overflow-hidden flex-1">
          {/* Left: thread + replies */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col overflow-hidden">
              <TabsList>
                <TabsTrigger value="thread">Thread ({sortedMessages.length})</TabsTrigger>
                <TabsTrigger value="attachments">Attachments ({attachments.length})</TabsTrigger>
                <TabsTrigger value="activity">Activity ({activity.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="thread" className="flex-1 overflow-y-auto space-y-3 pr-2">
                {sortedMessages.length === 0 && (
                  <div className="text-sm text-gray-500">No messages yet.</div>
                )}
                {sortedMessages.map((m) => (
                  <div
                    key={m.id}
                    className={`p-3 rounded border ${m.isInternal ? "bg-yellow-50 border-yellow-200" : m.authorType === "customer" ? "bg-blue-50 border-blue-200" : "bg-gray-50 border-gray-200"}`}
                  >
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span className="font-medium">
                        {m.authorName || m.authorType}
                        {m.isInternal && <Badge variant="outline" className="ml-2 text-yellow-700">internal</Badge>}
                        {m.proxyStatus && (
                          <Badge
                            variant={m.proxyStatus === "failed" ? "destructive" : "outline"}
                            className="ml-2"
                          >
                            SMS {m.proxyStatus}
                          </Badge>
                        )}
                      </span>
                      <span>{m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm">{m.body}</div>
                    {m.proxyError && <div className="mt-1 text-xs text-red-700">{m.proxyError}</div>}
                  </div>
                ))}
              </TabsContent>

              <TabsContent value="attachments" className="flex-1 overflow-y-auto">
                <div className="space-y-2">
                  {attachments.length === 0 && <div className="text-sm text-gray-500">No attachments.</div>}
                  {attachments.map((a) => (
                    <div key={a.id} className="flex justify-between items-center border rounded p-2">
                      <div>
                        <div className="font-medium text-sm">{a.filename}</div>
                        <div className="text-xs text-gray-500">
                          {a.mimeType || "unknown"} • {Math.round((a.sizeBytes || 0) / 1024)} KB
                        </div>
                      </div>
                      <a
                        href={`/api/tickets/${ticketId}/attachments/${a.id}/download`}
                        className="text-primary hover:underline text-sm flex items-center gap-1"
                      >
                        <Download className="h-4 w-4" /> Download
                      </a>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="activity" className="flex-1 overflow-y-auto">
                <div className="space-y-1 text-sm">
                  {activity.map((a) => (
                    <div key={a.id} className="border-b py-2">
                      <div className="flex justify-between">
                        <span className="font-medium">{a.action}</span>
                        <span className="text-xs text-gray-500">
                          {a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}
                        </span>
                      </div>
                      <div className="text-xs text-gray-600">
                        {a.actorName || a.actorType}{a.details ? ` • ${a.details}` : ""}
                      </div>
                    </div>
                  ))}
                  {activity.length === 0 && <div className="text-gray-500">No activity recorded.</div>}
                </div>
              </TabsContent>
            </Tabs>

            {/* Reply composer */}
            <div className="border-t mt-3 pt-3 space-y-2">
              <div className="flex items-center gap-2">
                <Select onValueChange={(v) => applyCannedMutation.mutate(parseInt(v))}>
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Insert canned response" />
                  </SelectTrigger>
                  <SelectContent>
                    {canned.map((c) => (
                      <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(e) => setInternal(e.target.checked)}
                  />
                  Internal note
                </label>
                <label className="ml-auto cursor-pointer text-sm text-primary flex items-center gap-1">
                  <Paperclip className="h-4 w-4" /> Attach
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadAttachment(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <Textarea
                rows={3}
                placeholder={internal ? "Internal note (only staff can see)…" : "Type your reply…"}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <div className="flex justify-end">
                <Button
                  onClick={() => replyMutation.mutate()}
                  disabled={!reply.trim() || replyMutation.isPending}
                >
                  <Send className="h-4 w-4 mr-2" />
                  {internal ? "Post note" : "Send reply"}
                </Button>
              </div>
            </div>
          </div>

          {/* Right: properties + actions */}
          <div className="lg:w-80 space-y-3 overflow-y-auto pl-2 border-l">
            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Requester</div>
              <div className="text-sm">{ticket.requesterName || "—"}</div>
              <div className="text-xs text-gray-600">{ticket.requesterEmail || "—"}</div>
              {ticket.requesterPhone && <div className="text-xs text-gray-600">{ticket.requesterPhone}</div>}
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Department</div>
              <Select
                value={ticket.departmentId?.toString() || ""}
                onValueChange={(v) => transferMutation.mutate({ departmentId: parseInt(v) })}
              >
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Team</div>
              <Select
                value={ticket.teamId?.toString() || ""}
                onValueChange={(v) => assignMutation.mutate({ teamId: parseInt(v) })}
              >
                <SelectTrigger><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {teams
                    .filter((t) => !ticket.departmentId || t.departmentId === ticket.departmentId)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Assigned to</div>
              <Select
                value={ticket.assignedTo?.toString() || ""}
                onValueChange={(v) => assignMutation.mutate({ assignedTo: v ? parseInt(v) : null })}
              >
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  {usersList.map((u) => (
                    <SelectItem key={u.id} value={u.id.toString()}>{u.username}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Help Topic</div>
              <Select
                value={ticket.helpTopicId?.toString() || ""}
                onValueChange={(v) => updateMutation.mutate({ helpTopicId: parseInt(v) })}
              >
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  {topics.map((t) => (
                    <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">SLA Plan</div>
              <Select
                value={ticket.slaPlanId?.toString() || ""}
                onValueChange={(v) => updateMutation.mutate({ slaPlanId: parseInt(v) })}
              >
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  {slaPlans.map((s) => (
                    <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Due date</div>
              <Input
                type="datetime-local"
                value={ticket.dueAt ? new Date(ticket.dueAt).toISOString().slice(0, 16) : ""}
                onChange={(e) => updateMutation.mutate({ dueAt: e.target.value ? new Date(e.target.value) as any : null })}
              />
              {ticket.slaDueAt && (
                <div className="text-xs text-gray-500 mt-1">
                  SLA due: {new Date(ticket.slaDueAt).toLocaleString()}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500 mb-1">Status</div>
              <Select value={ticket.status} onValueChange={(v) => statusMutation.mutate(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in-progress">In Progress</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2">
              {ticket.lockedBy ? (
                <Button variant="outline" size="sm" onClick={() => unlockMutation.mutate()} className="flex-1">
                  <Unlock className="h-4 w-4 mr-1" /> Unlock
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => lockMutation.mutate()} className="flex-1">
                  <Lock className="h-4 w-4 mr-1" /> Lock
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => invalidate()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
