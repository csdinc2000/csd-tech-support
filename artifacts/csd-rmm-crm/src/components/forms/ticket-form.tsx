import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Ticket, insertTicketSchema, Client, TicketDepartment, TicketHelpTopic, SlaPlan } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

interface TicketFormProps {
  open: boolean;
  onClose: () => void;
  ticket?: Ticket;
  isEdit?: boolean;
}

const ticketFormSchema = insertTicketSchema.extend({
  clientId: insertTicketSchema.shape.clientId.optional(),
  assignedTo: insertTicketSchema.shape.assignedTo.optional(),
});

export default function TicketForm({ open, onClose, ticket, isEdit = false }: TicketFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });
  const { data: departments = [] } = useQuery<TicketDepartment[]>({
    queryKey: ["/api/helpdesk/departments"],
  });
  const { data: helpTopics = [] } = useQuery<TicketHelpTopic[]>({
    queryKey: ["/api/helpdesk/help-topics"],
  });
  const { data: slaPlans = [] } = useQuery<SlaPlan[]>({
    queryKey: ["/api/helpdesk/sla-plans"],
  });

  const form = useForm({
    resolver: zodResolver(ticketFormSchema),
    defaultValues: {
      subject: ticket?.subject || "",
      description: ticket?.description || "",
      priority: ticket?.priority || "medium",
      status: ticket?.status || "open",
      clientId: ticket?.clientId || undefined,
      assignedTo: ticket?.assignedTo || undefined,
      requesterName: ticket?.requesterName || "",
      requesterEmail: ticket?.requesterEmail || "",
      requesterPhone: ticket?.requesterPhone || "",
      departmentId: ticket?.departmentId || undefined,
      helpTopicId: ticket?.helpTopicId || undefined,
      slaPlanId: ticket?.slaPlanId || undefined,
      source: ticket?.source || "web",
    } as any,
  });

  const createTicketMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/tickets", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tickets/open"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Ticket created successfully" });
      onClose();
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to create ticket", variant: "destructive" });
    },
  });

  const updateTicketMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/tickets/${ticket?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tickets/open"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Ticket updated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update ticket", variant: "destructive" });
    },
  });

  const closeTicketMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/tickets/${ticket?.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tickets/open"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Ticket closed successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to close ticket", variant: "destructive" });
    },
  });

  const onSubmit = (data: any) => {
    if (isEdit && ticket) {
      updateTicketMutation.mutate({
        ...data,
        updatedAt: new Date(),
      });
    } else {
      createTicketMutation.mutate(data);
    }
  };

  const handleClose = () => {
    if (ticket && confirm("Are you sure you want to close this ticket?")) {
      closeTicketMutation.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Ticket" : "Create New Ticket"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="subject"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subject</FormLabel>
                  <FormControl>
                    <Input placeholder="Brief description of the issue" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea 
                      placeholder="Detailed description of the issue, steps to reproduce, etc."
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="requesterName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Requester Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Customer name" {...field} value={field.value || ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="requesterEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Requester Email</FormLabel>
                    <FormControl>
                      <Input placeholder="customer@example.com" type="email" {...field} value={field.value || ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="requesterPhone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Requester Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="(555) 555-1212" {...field} value={field.value || ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(v ? parseInt(v) : undefined)}
                      value={field.value?.toString() || ""}
                    >
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {departments.map((d) => (
                          <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="helpTopicId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Help Topic</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(v ? parseInt(v) : undefined)}
                      value={field.value?.toString() || ""}
                    >
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {helpTopics.map((t) => (
                          <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slaPlanId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>SLA Plan</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(v ? parseInt(v) : undefined)}
                      value={field.value?.toString() || ""}
                    >
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {slaPlans.map((s) => (
                          <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select priority" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="in-progress">In Progress</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="clientId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client</FormLabel>
                    <Select onValueChange={(value) => field.onChange(value ? parseInt(value) : undefined)} value={field.value?.toString() || ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select client" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {clients.map((client) => (
                          <SelectItem key={client.id} value={client.id.toString()}>
                            {client.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2">
              {isEdit && ticket && ticket.status !== "closed" && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleClose}
                  disabled={closeTicketMutation.isPending}
                >
                  Close Ticket
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="bg-primary hover:bg-primary"
                disabled={createTicketMutation.isPending || updateTicketMutation.isPending}
              >
                {isEdit ? "Update Ticket" : "Create Ticket"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}