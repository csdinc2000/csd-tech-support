import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AutomationScript, insertAutomationScriptSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

interface AutomationScriptFormProps {
  open: boolean;
  onClose: () => void;
  script?: AutomationScript;
  isEdit?: boolean;
}

const scriptFormSchema = insertAutomationScriptSchema.extend({
  description: insertAutomationScriptSchema.shape.description.optional(),
  isActive: insertAutomationScriptSchema.shape.isActive.optional(),
});

export default function AutomationScriptForm({ open, onClose, script, isEdit = false }: AutomationScriptFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm({
    resolver: zodResolver(scriptFormSchema),
    defaultValues: {
      name: script?.name || "",
      description: script?.description || "",
      scriptType: script?.scriptType || "powershell",
      scriptContent: script?.scriptContent || "",
      isActive: script?.isActive ?? true,
    },
  });

  const createScriptMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/automation-scripts", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation-scripts"] });
      toast({ title: "Automation script created successfully" });
      onClose();
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to create script", variant: "destructive" });
    },
  });

  const updateScriptMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/automation-scripts/${script?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation-scripts"] });
      toast({ title: "Automation script updated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update script", variant: "destructive" });
    },
  });

  const deactivateScriptMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/automation-scripts/${script?.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation-scripts"] });
      toast({ title: "Script deactivated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to deactivate script", variant: "destructive" });
    },
  });

  const onSubmit = (data: any) => {
    if (isEdit && script) {
      updateScriptMutation.mutate(data);
    } else {
      createScriptMutation.mutate(data);
    }
  };

  const handleDeactivate = () => {
    if (script && confirm("Are you sure you want to deactivate this script?")) {
      deactivateScriptMutation.mutate();
    }
  };

  const getScriptTemplate = (type: string) => {
    const templates = {
      powershell: `# PowerShell Script Example
# Check Windows Updates
Get-WUList | Format-Table

# Get System Information
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, TotalPhysicalMemory`,
      
      batch: `@echo off
REM Batch Script Example
REM Clean temporary files
del /q /f %temp%\\*.*
for /d %%x in (%temp%\\*) do @rd /s /q "%%x"

REM Display system information
systeminfo | findstr /c:"OS Name" /c:"System Type" /c:"Total Physical Memory"`,
      
      bash: `#!/bin/bash
# Bash Script Example
# Update system packages
sudo apt update && sudo apt upgrade -y

# Check disk usage
df -h

# Display system information
uname -a`
    };
    return templates[type as keyof typeof templates] || "";
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Automation Script" : "Create New Automation Script"}
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
                    <FormLabel>Script Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Windows Update Check" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="scriptType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Script Type</FormLabel>
                    <Select 
                      onValueChange={(value) => {
                        field.onChange(value);
                        if (!script) {
                          form.setValue("scriptContent", getScriptTemplate(value));
                        }
                      }} 
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select script type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="powershell">PowerShell</SelectItem>
                        <SelectItem value="batch">Batch</SelectItem>
                        <SelectItem value="bash">Bash</SelectItem>
                        <SelectItem value="python">Python</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea 
                      placeholder="Brief description of what this script does"
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="scriptContent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Script Content</FormLabel>
                  <FormControl>
                    <Textarea 
                      placeholder="Enter your script code here..."
                      rows={12}
                      className="font-mono text-sm"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Active Script</FormLabel>
                    <div className="text-sm text-muted-foreground">
                      Enable this script for automated execution
                    </div>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter className="gap-2">
              {isEdit && script && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDeactivate}
                  disabled={deactivateScriptMutation.isPending}
                >
                  Deactivate Script
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="bg-primary hover:bg-primary"
                disabled={createScriptMutation.isPending || updateScriptMutation.isPending}
              >
                {isEdit ? "Update Script" : "Create Script"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}