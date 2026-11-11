import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Plus, FileText, Shield, Cpu, Wrench, CheckCircle, Clock, User, Trash2 } from "lucide-react";
import type { ServiceLog } from "@shared/schema";

const serviceLogFormSchema = z.object({
  clientName: z.string().min(1, "Client name is required"),
  deviceModel: z.string().min(1, "Device model is required"),
  hardwareAction: z.string().optional(),
  hardwareResult: z.string().optional(),
  securityAction: z.string().optional(),
  securityResult: z.string().optional(),
  optimizationAction: z.string().optional(),
  optimizationResult: z.string().optional(),
  gate1EnvironmentRecon: z.string().optional(),
  gate2ResourceExhaustion: z.string().optional(),
  gate3ThreatPerimeter: z.string().optional(),
  gate4ThermalPowerAudit: z.string().optional(),
  gate5OptimizationStrike: z.string().optional(),
  gate6ResilienceTest: z.string().optional(),
  gate7SecureHandover: z.string().optional(),
  securityHardened: z.boolean().default(false),
  technicianNotes: z.string().optional(),
  performedBy: z.string().optional(),
});

type ServiceLogFormData = z.infer<typeof serviceLogFormSchema>;

export default function ServiceLogsPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ServiceLog | null>(null);
  const { toast } = useToast();

  const { data: logs = [], isLoading } = useQuery<ServiceLog[]>({
    queryKey: ["/api/service-logs"],
  });

  const form = useForm<ServiceLogFormData>({
    resolver: zodResolver(serviceLogFormSchema),
    defaultValues: {
      clientName: "",
      deviceModel: "",
      hardwareAction: "",
      hardwareResult: "",
      securityAction: "",
      securityResult: "",
      optimizationAction: "",
      optimizationResult: "",
      gate1EnvironmentRecon: "",
      gate2ResourceExhaustion: "",
      gate3ThreatPerimeter: "",
      gate4ThermalPowerAudit: "",
      gate5OptimizationStrike: "",
      gate6ResilienceTest: "",
      gate7SecureHandover: "",
      securityHardened: false,
      technicianNotes: "",
      performedBy: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ServiceLogFormData) => {
      const response = await apiRequest("POST", "/api/service-logs", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs"] });
      toast({ title: "Service log created", description: "The repair log has been saved successfully." });
      setIsDialogOpen(false);
      form.reset();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create service log", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/service-logs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs"] });
      toast({ title: "Service log deleted", description: "The repair log has been removed." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete service log", variant: "destructive" });
    },
  });

  const onSubmit = (data: ServiceLogFormData) => {
    createMutation.mutate(data);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Service Logs</h1>
          <p className="text-gray-600">Track repair history and diagnostic results</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-red-600 hover:bg-red-700">
              <Plus className="h-4 w-4 mr-2" />
              New Service Log
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Service Log</DialogTitle>
              <DialogDescription>
                Record repair details and 7-Gate Diagnostic Framework results
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="clientName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Client Name *</FormLabel>
                        <FormControl>
                          <Input placeholder="John Doe" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="deviceModel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Device Model *</FormLabel>
                        <FormControl>
                          <Input placeholder="Alienware x17 R2" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="performedBy"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Technician</FormLabel>
                        <FormControl>
                          <Input placeholder="Tech name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="securityHardened"
                    render={({ field }) => (
                      <FormItem className="flex items-center space-x-2 pt-6">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <FormLabel className="!mt-0">Security Hardened</FormLabel>
                      </FormItem>
                    )}
                  />
                </div>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Wrench className="h-5 w-5" />
                      Service Actions & Results
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="hardwareAction"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Hardware Action</FormLabel>
                            <FormControl>
                              <Input placeholder="Replaced thermal pads" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="hardwareResult"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Hardware Result</FormLabel>
                            <FormControl>
                              <Input placeholder="-12°C temp drop" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="securityAction"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Security Action</FormLabel>
                            <FormControl>
                              <Input placeholder="Malware purge, firewall config" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="securityResult"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Security Result</FormLabel>
                            <FormControl>
                              <Input placeholder="System clean, hardened" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="optimizationAction"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Optimization Action</FormLabel>
                            <FormControl>
                              <Input placeholder="Bloatware removal, driver update" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="optimizationResult"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Optimization Result</FormLabel>
                            <FormControl>
                              <Input placeholder="+15% FPS improvement" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Shield className="h-5 w-5" />
                      7-Gate Diagnostic Framework
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="gate1EnvironmentRecon"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 1: Environment Recon</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="OS, hardware specs (CPU/GPU/RAM), security posture..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gate2ResourceExhaustion"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 2: Resource Exhaustion Audit</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Hidden processes sweeping CPU/RAM/bandwidth..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gate3ThreatPerimeter"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 3: Threat Perimeter</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Spyware, keyloggers, miners, malicious extensions..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gate4ThermalPowerAudit"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 4: Thermal/Power Audit</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Thermal throttling, fan curves, power delivery issues..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gate5OptimizationStrike"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 5: Optimization Strike</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Bloatware removal, OS hardening, driver updates..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gate6ResilienceTest"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 6: Resilience Test</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Benchmarks (3DMark, Cinebench), stability verification..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="gate7SecureHandover"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gate 7: Secure Handover</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="CSD Security Checklist complete, Google Contact sync..." 
                              className="h-20"
                              {...field} 
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                <FormField
                  control={form.control}
                  name="technicianNotes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Technician Notes</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="Additional notes about the repair..." 
                          className="h-24"
                          {...field} 
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <div className="flex justify-end gap-3">
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" className="bg-red-600 hover:bg-red-700" disabled={createMutation.isPending}>
                    {createMutation.isPending ? "Saving..." : "Save Service Log"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No service logs yet</h3>
            <p className="text-gray-500 mb-4">Start tracking repair history by creating your first log.</p>
            <Button onClick={() => setIsDialogOpen(true)} className="bg-red-600 hover:bg-red-700">
              <Plus className="h-4 w-4 mr-2" />
              Create First Log
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {logs.map((log) => (
            <Card key={log.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">{log.clientName}</h3>
                      {log.securityHardened && (
                        <Badge className="bg-green-100 text-green-800">
                          <Shield className="h-3 w-3 mr-1" />
                          Hardened
                        </Badge>
                      )}
                      {log.googleContactSynced && (
                        <Badge className="bg-blue-100 text-blue-800">
                          Synced
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-600 mb-3">
                      <span className="flex items-center gap-1">
                        <Cpu className="h-4 w-4" />
                        {log.deviceModel}
                      </span>
                      {log.performedBy && (
                        <span className="flex items-center gap-1">
                          <User className="h-4 w-4" />
                          {log.performedBy}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        {new Date(log.createdAt!).toLocaleDateString()}
                      </span>
                    </div>
                    
                    {(log.hardwareAction || log.securityAction || log.optimizationAction) && (
                      <div className="grid grid-cols-3 gap-4 mt-3 pt-3 border-t">
                        {log.hardwareAction && (
                          <div>
                            <div className="text-xs font-medium text-gray-500 uppercase">Hardware</div>
                            <div className="text-sm">{log.hardwareAction}</div>
                            {log.hardwareResult && (
                              <div className="text-xs text-green-600">{log.hardwareResult}</div>
                            )}
                          </div>
                        )}
                        {log.securityAction && (
                          <div>
                            <div className="text-xs font-medium text-gray-500 uppercase">Security</div>
                            <div className="text-sm">{log.securityAction}</div>
                            {log.securityResult && (
                              <div className="text-xs text-green-600">{log.securityResult}</div>
                            )}
                          </div>
                        )}
                        {log.optimizationAction && (
                          <div>
                            <div className="text-xs font-medium text-gray-500 uppercase">Optimization</div>
                            <div className="text-sm">{log.optimizationAction}</div>
                            {log.optimizationResult && (
                              <div className="text-xs text-green-600">{log.optimizationResult}</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 shrink-0"
                    onClick={() => {
                      if (window.confirm("Delete this service log? This cannot be undone.")) {
                        deleteMutation.mutate(log.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    aria-label="Delete service log"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
