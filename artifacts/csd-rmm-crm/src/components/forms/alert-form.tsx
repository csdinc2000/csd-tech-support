import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Alert, insertAlertSchema, Device } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

interface AlertFormProps {
  open: boolean;
  onClose: () => void;
  alert?: Alert;
  isEdit?: boolean;
}

const alertFormSchema = insertAlertSchema.extend({
  description: insertAlertSchema.shape.description.optional(),
  deviceId: insertAlertSchema.shape.deviceId.optional(),
});

export default function AlertForm({ open, onClose, alert, isEdit = false }: AlertFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
  });

  const form = useForm({
    resolver: zodResolver(alertFormSchema),
    defaultValues: {
      title: alert?.title || "",
      description: alert?.description || "",
      severity: alert?.severity || "medium",
      status: alert?.status || "active",
      deviceId: alert?.deviceId || undefined,
    },
  });

  const createAlertMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/alerts", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Alert created successfully" });
      onClose();
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to create alert", variant: "destructive" });
    },
  });

  const updateAlertMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/alerts/${alert?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Alert updated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update alert", variant: "destructive" });
    },
  });

  const resolveAlertMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/alerts/${alert?.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Alert resolved successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to resolve alert", variant: "destructive" });
    },
  });

  const onSubmit = (data: any) => {
    if (isEdit && alert) {
      updateAlertMutation.mutate(data);
    } else {
      createAlertMutation.mutate(data);
    }
  };

  const handleResolve = () => {
    if (alert && confirm("Are you sure you want to resolve this alert?")) {
      resolveAlertMutation.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Alert" : "Create New Alert"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Alert Title</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., High CPU Usage Detected" {...field} />
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
                      placeholder="Detailed description of the alert condition"
                      rows={3}
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
                name="severity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Severity</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select severity" />
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
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="acknowledged">Acknowledged</SelectItem>
                        <SelectItem value="investigating">Investigating</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="deviceId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Device</FormLabel>
                    <Select onValueChange={(value) => field.onChange(value ? parseInt(value) : undefined)} value={field.value?.toString() || ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select device" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {devices.map((device) => (
                          <SelectItem key={device.id} value={device.id.toString()}>
                            {device.name} ({device.type})
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
              {isEdit && alert && alert.status !== "resolved" && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleResolve}
                  disabled={resolveAlertMutation.isPending}
                >
                  Resolve Alert
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="bg-primary hover:bg-primary"
                disabled={createAlertMutation.isPending || updateAlertMutation.isPending}
              >
                {isEdit ? "Update Alert" : "Create Alert"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}