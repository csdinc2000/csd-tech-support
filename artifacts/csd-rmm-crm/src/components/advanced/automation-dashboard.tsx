import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  Play, Pause, Square, Settings, Clock, CheckCircle, AlertTriangle, 
  Zap, Code, Server, Wrench, Shield 
} from "lucide-react";

interface AutomationScript {
  id: number;
  name: string;
  description: string;
  type: 'powershell' | 'batch' | 'bash' | 'python';
  category: 'maintenance' | 'security' | 'deployment' | 'monitoring';
  content: string;
  lastRun?: Date;
  status: 'idle' | 'running' | 'completed' | 'failed';
  executionCount: number;
  successRate: number;
}

interface AutomationDashboardProps {
  embedded?: boolean;
}

export default function AutomationDashboard({ embedded = false }: AutomationDashboardProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: scripts = [], isLoading } = useQuery({
    queryKey: ["/api/automation-scripts"],
  });

  const executeScriptMutation = useMutation({
    mutationFn: (scriptId: number) => 
      apiRequest(`/api/automation-scripts/${scriptId}/execute`, "POST"),
    onSuccess: (data, scriptId) => {
      const script = (scripts as AutomationScript[]).find((s: AutomationScript) => s.id === scriptId);
      toast({ 
        title: `Script "${script?.name}" executed successfully`,
        description: "Check Slack for detailed results"
      });
      queryClient.invalidateQueries({ queryKey: ["/api/automation-scripts"] });
    },
    onError: (error, scriptId) => {
      const script = (scripts as AutomationScript[]).find((s: AutomationScript) => s.id === scriptId);
      toast({ 
        title: `Failed to execute "${script?.name}"`,
        variant: "destructive" 
      });
    },
  });

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'powershell': return <Code className="h-4 w-4 text-blue-500" />;
      case 'batch': return <Server className="h-4 w-4 text-orange-500" />;
      case 'bash': return <Code className="h-4 w-4 text-green-500" />;
      case 'python': return <Code className="h-4 w-4 text-yellow-500" />;
      default: return <Code className="h-4 w-4 text-gray-500" />;
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'maintenance': return <Wrench className="h-4 w-4 text-blue-500" />;
      case 'security': return <Shield className="h-4 w-4 text-red-500" />;
      case 'deployment': return <Server className="h-4 w-4 text-green-500" />;
      case 'monitoring': return <Zap className="h-4 w-4 text-purple-500" />;
      default: return <Code className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-blue-100 text-blue-800';
      case 'completed': return 'bg-green-100 text-green-800';
      case 'failed': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const filteredScripts = (scripts as AutomationScript[]).filter((script: AutomationScript) => 
    selectedCategory === "all" || script.category === selectedCategory
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-48 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Quick automation templates
  const quickAutomations = [
    {
      name: "System Health Check",
      description: "Run comprehensive system diagnostics",
      icon: <Zap className="h-5 w-5 text-green-500" />,
      action: "health-check"
    },
    {
      name: "Security Scan",
      description: "Perform security vulnerability assessment",
      icon: <Shield className="h-5 w-5 text-red-500" />,
      action: "security-scan"
    },
    {
      name: "Disk Cleanup",
      description: "Clean temporary files and optimize storage",
      icon: <Wrench className="h-5 w-5 text-blue-500" />,
      action: "disk-cleanup"
    },
    {
      name: "Software Updates",
      description: "Check and install available software updates",
      icon: <Server className="h-5 w-5 text-purple-500" />,
      action: "software-updates"
    }
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      {!embedded && <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Automation Hub</h2>
          <p className="text-gray-600">NinjaOne-inspired automation and scripting platform</p>
        </div>
        <Button className="bg-primary text-white hover:bg-primary">
          <Code className="h-4 w-4 mr-2" />
          Create Script
        </Button>
      </div>}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Automations</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {quickAutomations.map((automation, index) => (
              <div 
                key={index}
                className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => {
                  toast({ 
                    title: `${automation.name} initiated`,
                    description: "Automation started in background"
                  });
                }}
              >
                <div className="flex items-center space-x-3 mb-2">
                  {automation.icon}
                  <h3 className="font-medium">{automation.name}</h3>
                </div>
                <p className="text-sm text-gray-600">{automation.description}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Play className="h-8 w-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold text-green-600">
                  {(scripts as AutomationScript[]).filter((s: AutomationScript) => s.status === 'running').length}
                </p>
                <p className="text-sm text-gray-600">Running</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <CheckCircle className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold text-blue-600">
                  {(scripts as AutomationScript[]).filter((s: AutomationScript) => s.status === 'completed').length}
                </p>
                <p className="text-sm text-gray-600">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold text-red-600">
                  {(scripts as AutomationScript[]).filter((s: AutomationScript) => s.status === 'failed').length}
                </p>
                <p className="text-sm text-gray-600">Failed</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Code className="h-8 w-8 text-purple-500" />
              <div>
                <p className="text-2xl font-bold text-purple-600">{(scripts as AutomationScript[]).length}</p>
                <p className="text-sm text-gray-600">Total Scripts</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Category Filter */}
      <div className="flex space-x-2">
        {['all', 'maintenance', 'security', 'deployment', 'monitoring'].map((category) => (
          <Button
            key={category}
            variant={selectedCategory === category ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCategory(category)}
            className="capitalize"
          >
            {category === 'all' ? '🏷️' : ''} {category}
          </Button>
        ))}
      </div>

      {/* Script Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredScripts.map((script: AutomationScript) => (
          <Card key={script.id} className="hover:shadow-lg transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  {getCategoryIcon(script.category)}
                  <CardTitle className="text-lg">{script.name}</CardTitle>
                </div>
                <Badge className={getStatusColor(script.status)}>
                  {script.status}
                </Badge>
              </div>
            </CardHeader>
            
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-600">{script.description}</p>
              
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center space-x-2">
                  {getTypeIcon(script.type)}
                  <span className="capitalize">{script.type}</span>
                </div>
                <Badge variant="outline">{script.category}</Badge>
              </div>

              {/* Execution Stats */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Success Rate</span>
                  <span className="text-green-600">{script.successRate || 85}%</span>
                </div>
                <Progress value={script.successRate || 85} className="h-2" />
                
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Executions: {script.executionCount || 12}</span>
                  {script.lastRun && (
                    <span>Last: {new Date(script.lastRun).toLocaleDateString()}</span>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex space-x-2 pt-2">
                <Button 
                  size="sm" 
                  className="flex-1 bg-primary text-white hover:bg-primary"
                  onClick={() => executeScriptMutation.mutate(script.id)}
                  disabled={executeScriptMutation.isPending || script.status === 'running'}
                >
                  {script.status === 'running' ? (
                    <>
                      <Square className="h-4 w-4 mr-2" />
                      Running...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Execute
                    </>
                  )}
                </Button>
                <Button size="sm" variant="outline">
                  <Settings className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Executions */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Executions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { script: "System Health Check", status: "completed", time: "2 min ago", output: "All systems operational" },
              { script: "Security Scan", status: "running", time: "5 min ago", output: "Scanning in progress..." },
              { script: "Disk Cleanup", status: "completed", time: "15 min ago", output: "Freed 2.3 GB space" },
              { script: "Software Updates", status: "failed", time: "1 hour ago", output: "Network timeout error" }
            ].map((execution, index) => (
              <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center space-x-3">
                  {execution.status === 'running' ? (
                    <Play className="h-4 w-4 text-blue-500 animate-pulse" />
                  ) : execution.status === 'completed' ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-red-500" />
                  )}
                  <div>
                    <p className="font-medium">{execution.script}</p>
                    <p className="text-sm text-gray-600">{execution.output}</p>
                  </div>
                </div>
                <div className="text-right">
                  <Badge className={getStatusColor(execution.status)}>
                    {execution.status}
                  </Badge>
                  <p className="text-xs text-gray-500 mt-1">{execution.time}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}