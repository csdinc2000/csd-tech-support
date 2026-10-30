import { useEffect } from "react";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Client, insertClientSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

interface ClientFormProps {
  open: boolean;
  onClose: () => void;
  client?: Client;
  isEdit?: boolean;
}

const clientFormSchema = insertClientSchema.extend({
  name: z.string().trim().min(1, "Company name is required"),
  contactEmail: z.string().trim().email("Enter a valid contact email"),
  contactPhone: insertClientSchema.shape.contactPhone.optional(),
  address: insertClientSchema.shape.address.optional(),
  city: insertClientSchema.shape.city.optional(),
  state: insertClientSchema.shape.state.optional(),
  zipCode: insertClientSchema.shape.zipCode.optional(),
});

type ClientFormValues = z.infer<typeof clientFormSchema>;

const toFormValues = (client?: Client) => ({
  name: client?.name || "",
  contactEmail: client?.contactEmail || "",
  contactPhone: client?.contactPhone || "",
  address: client?.address || "",
  city: client?.city || "",
  state: client?.state || "FL",
  zipCode: client?.zipCode || "",
});

export default function ClientForm({ open, onClose, client, isEdit = false }: ClientFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm({
    resolver: zodResolver(clientFormSchema),
    defaultValues: toFormValues(client),
  });

  // Load the selected client every time the dialog opens (or the selection
  // changes), because `defaultValues` alone only applies to the first mount.
  useEffect(() => {
    if (open) form.reset(toFormValues(client));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client?.id]);

  const createClientMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/clients", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: "Client created successfully" });
      onClose();
      form.reset();
    },
    onError: (error: any) => {
      toast({
        title: "Failed to create client",
        description: error?.message,
        variant: "destructive",
      });
    },
  });

  const updateClientMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/clients/${client?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: "Client updated successfully" });
      onClose();
    },
    onError: (error: any) => {
      toast({
        title: "Failed to update client",
        description: error?.message,
        variant: "destructive",
      });
    },
  });

  const archiveClientMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/clients/${client?.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      toast({ title: "Client archived successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to archive client", variant: "destructive" });
    },
  });

  const onSubmit = (data: ClientFormValues) => {
    if (isEdit && client) {
      updateClientMutation.mutate(data);
    } else {
      createClientMutation.mutate(data);
    }
  };

  const handleArchive = () => {
    if (client && confirm("Are you sure you want to archive this client? This will not delete their data but will hide them from active lists.")) {
      archiveClientMutation.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Client" : "Add New Client"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Fort Lauderdale Legal Associates" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="contactEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="contact@company.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="contactPhone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="(954) 555-0123" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Input placeholder="123 Business Blvd" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input placeholder="Fort Lauderdale" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="state"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>State</FormLabel>
                    <FormControl>
                      <Input placeholder="FL" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="zipCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>ZIP Code</FormLabel>
                    <FormControl>
                      <Input placeholder="33301" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2">
              {isEdit && client && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleArchive}
                  disabled={archiveClientMutation.isPending}
                >
                  Archive Client
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="bg-primary hover:bg-primary"
                disabled={createClientMutation.isPending || updateClientMutation.isPending}
              >
                {isEdit ? "Update Client" : "Create Client"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}