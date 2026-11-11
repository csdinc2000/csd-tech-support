import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Device, insertDeviceSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

interface DeviceFormProps {
  open: boolean;
  onClose: () => void;
  device?: Device;
  isEdit?: boolean;
}

const deviceFormSchema = insertDeviceSchema.extend({
  cpuUsage: insertDeviceSchema.shape.cpuUsage.optional(),
  memoryUsage: insertDeviceSchema.shape.memoryUsage.optional(),
  diskUsage: insertDeviceSchema.shape.diskUsage.optional(),
});

export default function DeviceForm({ open, onClose, device, isEdit = false }: DeviceFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm({
    resolver: zodResolver(deviceFormSchema),
    defaultValues: {
      name: device?.name || "",
      type: device?.type || "workstation",
      status: device?.status || "offline",
      ipAddress: device?.ipAddress || "",
      macAddress: device?.macAddress || "",
      operatingSystem: device?.operatingSystem || "",
      cpuUsage: device?.cpuUsage || undefined,
      memoryUsage: device?.memoryUsage || undefined,
      diskUsage: device?.diskUsage || undefined,
      clientId: device?.clientId || undefined,
      teamviewerId: device?.teamviewerId || "",
      teamviewerAlias: device?.teamviewerAlias || "",
      preferredRemoteProvider: device?.preferredRemoteProvider || "meshcentral",
    },
  });

  const createDeviceMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/devices", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Device created successfully" });
      onClose();
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to create device", variant: "destructive" });
    },
  });

  const updateDeviceMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/devices/${device?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Device updated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update device", variant: "destructive" });
    },
  });

  const deleteDeviceMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/devices/${device?.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Device deleted successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to delete device", variant: "destructive" });
    },
  });

  const onSubmit = (data: any) => {
    if (isEdit && device) {
      updateDeviceMutation.mutate(data);
    } else {
      createDeviceMutation.mutate(data);
    }
  };

  const handleDelete = () => {
    if (device && confirm("Are you sure you want to delete this device?")) {
      deleteDeviceMutation.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Device" : "Add New Device"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Device Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., WS-RECEPTION-01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Device Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select device type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="server">Server</SelectItem>
                        <SelectItem value="workstation">Workstation</SelectItem>
                        <SelectItem value="laptop">Laptop</SelectItem>
                        <SelectItem value="network">Network Device</SelectItem>
                        <SelectItem value="printer">Printer</SelectItem>
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
                        <SelectItem value="online">Online</SelectItem>
                        <SelectItem value="offline">Offline</SelectItem>
                        <SelectItem value="warning">Warning</SelectItem>
                        <SelectItem value="error">Error</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="ipAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>IP Address</FormLabel>
                    <FormControl>
                      <Input placeholder="192.168.1.100" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="macAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>MAC Address</FormLabel>
                    <FormControl>
                      <Input placeholder="00:1B:44:11:3A:B7" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="operatingSystem"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Operating System</FormLabel>
                    <FormControl>
                      <Input placeholder="Windows 11 Pro" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="border-t pt-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Remote access</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="teamviewerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>TeamViewer ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. 1 234 567 890"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="teamviewerAlias"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>TeamViewer Alias (optional)</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Account-side alias"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="preferredRemoteProvider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Preferred Provider</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? "meshcentral"}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select provider" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="meshcentral">MeshCentral</SelectItem>
                          <SelectItem value="teamviewer">TeamViewer</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <DialogFooter className="gap-2">
              {isEdit && device && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteDeviceMutation.isPending}
                >
                  Delete Device
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="bg-primary hover:bg-primary"
                disabled={createDeviceMutation.isPending || updateDeviceMutation.isPending}
              >
                {isEdit ? "Update Device" : "Create Device"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}