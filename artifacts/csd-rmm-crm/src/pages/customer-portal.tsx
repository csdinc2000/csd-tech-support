import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface PortalTicket {
  id: number;
  ticketNumber: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  dueAt?: string;
  requesterName: string;
  requesterEmail: string;
}
interface PortalMessage {
  id: number;
  authorType: string;
  authorName: string;
  body: string;
  createdAt: string;
}
interface PortalView {
  ticket: PortalTicket;
  messages: PortalMessage[];
  attachments: { id: number; filename: string; mimeType?: string; sizeBytes?: number }[];
}

export default function CustomerPortal() {
  const { toast } = useToast();
  const [tab, setTab] = useState<string>("login");

  // Login form
  const [email, setEmail] = useState("");
  const [ticketNumber, setTicketNumber] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const [view, setView] = useState<PortalView | null>(null);
  const [reply, setReply] = useState("");

  // New-ticket form
  const [newTicket, setNewTicket] = useState({
    requesterName: "",
    requesterEmail: "",
    requesterPhone: "",
    subject: "",
    description: "",
  });
  const [newTicketResult, setNewTicketResult] = useState<{ ticketNumber: string; accessToken: string } | null>(null);

  useEffect(() => {
    // Allow auto-fill from URL params (e.g. links emailed to customers)
    const p = new URLSearchParams(window.location.search);
    const e = p.get("email"), n = p.get("ticket"), t = p.get("token");
    if (e) setEmail(e);
    if (n) setTicketNumber(n);
    if (t) setAccessToken(t);
    if (e && n && t) {
      setTab("login");
      setTimeout(() => lookup.mutate({ email: e, ticketNumber: n, accessToken: t }), 100);
    }
  }, []);

  const lookup = useMutation({
    mutationFn: async (vars: { email: string; ticketNumber: string; accessToken: string }) => {
      const res = await apiRequest("POST", "/api/portal/tickets/lookup", vars);
      return res.json();
    },
    onSuccess: (data: PortalView) => {
      setView(data);
      setTab("ticket");
    },
    onError: (e: any) => toast({ title: "Lookup failed", description: e.message, variant: "destructive" }),
  });

  const replyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/portal/tickets/reply", {
        email,
        ticketNumber,
        accessToken,
        body: reply,
      });
      return res.json();
    },
    onSuccess: () => {
      setReply("");
      toast({ title: "Reply sent" });
      lookup.mutate({ email, ticketNumber, accessToken });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const createTicket = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/portal/tickets", newTicket);
      return res.json();
    },
    onSuccess: (data: any) => {
      setNewTicketResult({ ticketNumber: data.ticketNumber, accessToken: data.accessToken });
      setEmail(newTicket.requesterEmail);
      setTicketNumber(data.ticketNumber);
      setAccessToken(data.accessToken);
      toast({ title: `Ticket created: ${data.ticketNumber}` });
    },
    onError: (e: any) => toast({ title: "Failed to submit", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center p-6">
      <div className="w-full max-w-3xl">
        <Link
          href="/portal"
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-red-600 mb-4"
          data-testid="link-back-home"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Portal
        </Link>
        <h1 className="text-3xl font-bold mb-1">Customer Portal</h1>
        <p className="text-sm text-gray-600 mb-6">
          Submit a new request, or look up an existing ticket using your email and ticket ID — no account required.
        </p>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="login">View existing ticket</TabsTrigger>
            <TabsTrigger value="new">Submit new ticket</TabsTrigger>
            {view && <TabsTrigger value="ticket">Ticket {view.ticket.ticketNumber}</TabsTrigger>}
          </TabsList>

          <TabsContent value="login">
            <Card>
              <CardHeader><CardTitle>Look up your ticket</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <label className="text-xs text-gray-500">Email address</label>
                  <Input value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Ticket number (e.g. CSD-2026-0001)</label>
                  <Input value={ticketNumber} onChange={(e) => setTicketNumber(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Access token (from the confirmation email)</label>
                  <Input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
                </div>
                <Button
                  onClick={() => lookup.mutate({ email, ticketNumber, accessToken })}
                  disabled={!email || !ticketNumber || !accessToken || lookup.isPending}
                >
                  View ticket
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="new">
            <Card>
              <CardHeader><CardTitle>Submit a new ticket</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {newTicketResult ? (
                  <div className="bg-green-50 border border-green-200 rounded p-4">
                    <p className="font-medium">Ticket submitted!</p>
                    <p className="text-sm mt-2">
                      Your ticket number is{" "}
                      <span className="font-mono">{newTicketResult.ticketNumber}</span>. We've sent a confirmation email
                      with a link you can use to view and reply at any time.
                    </p>
                    <p className="text-xs text-gray-600 mt-2 break-all">
                      Access token: <span className="font-mono">{newTicketResult.accessToken}</span>
                    </p>
                    <Button className="mt-3" onClick={() => { setTab("login"); }}>
                      View this ticket
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-gray-500">Your name</label>
                        <Input value={newTicket.requesterName}
                          onChange={(e) => setNewTicket({ ...newTicket, requesterName: e.target.value })} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Email</label>
                        <Input type="email" value={newTicket.requesterEmail}
                          onChange={(e) => setNewTicket({ ...newTicket, requesterEmail: e.target.value })} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Phone (optional)</label>
                        <Input value={newTicket.requesterPhone}
                          onChange={(e) => setNewTicket({ ...newTicket, requesterPhone: e.target.value })} />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Subject</label>
                        <Input value={newTicket.subject}
                          onChange={(e) => setNewTicket({ ...newTicket, subject: e.target.value })} />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500">Describe the issue</label>
                      <Textarea rows={6} value={newTicket.description}
                        onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })} />
                    </div>
                    <Button
                      onClick={() => createTicket.mutate()}
                      disabled={!newTicket.requesterName || !newTicket.requesterEmail || !newTicket.subject || !newTicket.description || createTicket.isPending}
                    >
                      Submit ticket
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {view && (
            <TabsContent value="ticket">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span className="font-mono text-sm text-gray-500">{view.ticket.ticketNumber}</span>
                    <span>{view.ticket.subject}</span>
                    <Badge>{view.ticket.priority}</Badge>
                    <Badge variant="outline">{view.ticket.status}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {view.messages.length === 0 && <p className="text-sm text-gray-500">No messages yet.</p>}
                    {view.messages.map((m) => (
                      <div
                        key={m.id}
                        className={`p-3 rounded border ${m.authorType === "customer" ? "bg-blue-50 border-blue-200" : "bg-gray-50 border-gray-200"}`}
                      >
                        <div className="flex justify-between text-xs text-gray-600 mb-1">
                          <span className="font-medium">{m.authorName} ({m.authorType})</span>
                          <span>{new Date(m.createdAt).toLocaleString()}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-sm">{m.body}</div>
                      </div>
                    ))}
                  </div>
                  {view.attachments.length > 0 && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Attachments</div>
                      <ul className="text-sm">
                        {view.attachments.map((a) => (
                          <li key={a.id}>{a.filename} ({Math.round((a.sizeBytes || 0) / 1024)} KB)</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="border-t pt-3">
                    <label className="text-xs text-gray-500">Reply</label>
                    <Textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} />
                    <Button className="mt-2" disabled={!reply.trim() || replyMutation.isPending}
                      onClick={() => replyMutation.mutate()}>
                      Send reply
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
