import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Plus, Play, Settings, Code, Edit, Pause } from "lucide-react";
import AutomationScriptForm from "@/components/forms/automation-script-form";

interface AutomationProps {
  embedded?: boolean;
}

export default function Automation({ embedded = false }: AutomationProps) {
  const [showScriptForm, setShowScriptForm] = useState(false);
  const [selectedScript, setSelectedScript] = useState(undefined);
  const [isEdit, setIsEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const { data: scripts = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/automation-scripts"],
  });

  const filteredScripts = scripts.filter((script: any) =>
    script.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    script.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleEdit = (script: any) => {
    setSelectedScript(script);
    setIsEdit(true);
    setShowScriptForm(true);
  };

  const handleAdd = () => {
    setSelectedScript(undefined);
    setIsEdit(false);
    setShowScriptForm(true);
  };

  const closeForm = () => {
    setShowScriptForm(false);
    setSelectedScript(undefined);
    setIsEdit(false);
  };

  const getScriptTypeColor = (type: string) => {
    switch (type) {
      case "powershell":
        return "bg-blue-100 text-blue-800";
      case "batch":
        return "bg-green-100 text-green-800";
      case "bash":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getScriptTypeIcon = (type: string) => {
    switch (type) {
      case "powershell":
        return "🔷";
      case "batch":
        return "📄";
      case "bash":
        return "🐧";
      default:
        return "📜";
    }
  };

  return (
    <div className={embedded ? "" : "min-h-screen bg-gray-50"}>
      {/* Header */}
      {!embedded && <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">IT Automation Scripts</h2>
            <p className="text-gray-600">Streamline maintenance tasks across South Florida networks</p>
          </div>
          <div className="flex space-x-3">
            <Button variant="outline">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </Button>
            <Button 
              className="bg-primary text-white hover:bg-primary"
              onClick={handleAdd}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Script
            </Button>
          </div>
        </div>
      </div>}

      <div className={embedded ? "space-y-4 md:space-y-6" : "p-4 md:p-6 space-y-4 md:space-y-6"}>
        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-4 text-center">
              <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Code className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="font-medium text-gray-900">System Updates</h3>
              <p className="text-sm text-gray-500">Check for updates</p>
            </CardContent>
          </Card>
          
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-4 text-center">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Settings className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="font-medium text-gray-900">Maintenance</h3>
              <p className="text-sm text-gray-500">System cleanup</p>
            </CardContent>
          </Card>
          
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-4 text-center">
              <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Play className="h-6 w-6 text-purple-600" />
              </div>
              <h3 className="font-medium text-gray-900">Security Scan</h3>
              <p className="text-sm text-gray-500">Run security checks</p>
            </CardContent>
          </Card>
          
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-4 text-center">
              <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Code className="h-6 w-6 text-yellow-600" />
              </div>
              <h3 className="font-medium text-gray-900">Custom Script</h3>
              <p className="text-sm text-gray-500">Run custom code</p>
            </CardContent>
          </Card>
        </div>

        {/* Scripts Management */}
        <Card>
          <CardHeader>
            <CardTitle>Automation Scripts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-4">Script</th>
                    <th className="text-left p-4">Type</th>
                    <th className="text-left p-4">Status</th>
                    <th className="text-left p-4">Last Run</th>
                    <th className="text-left p-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={5} className="p-6 text-center text-gray-500">Loading scripts…</td></tr>
                  )}
                  {!isLoading && filteredScripts.length === 0 && (
                    <tr><td colSpan={5} className="p-6 text-center text-gray-500">
                      No automation scripts yet. Create one with the button above.
                    </td></tr>
                  )}
                  {filteredScripts.map((script) => (
                    <tr key={script.id} className="border-b hover:bg-gray-50">
                      <td className="p-4">
                        <div className="flex items-center space-x-3">
                          <span className="text-xl">{getScriptTypeIcon(script.scriptType)}</span>
                          <div>
                            <p className="font-medium text-gray-900">{script.name}</p>
                            <p className="text-sm text-gray-500">{script.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <Badge className={getScriptTypeColor(script.scriptType)}>
                          {script.scriptType}
                        </Badge>
                      </td>
                      <td className="p-4">
                        <Badge className={script.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}>
                          {script.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="p-4 text-sm text-gray-600">
                        {script.lastRun ? new Date(script.lastRun).toLocaleString() : "Never"}
                      </td>
                      <td className="p-4">
                        <div className="flex space-x-2">
                          <Button variant="ghost" size="sm" className="text-primary hover:text-red-600">
                            <Play className="h-4 w-4 mr-1" />
                            Run
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => handleEdit(script)}
                          >
                            <Edit className="h-4 w-4 mr-1" />
                            Edit
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Script Library */}
        <Card>
          <CardHeader>
            <CardTitle>Script Library</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="p-4 border border-gray-200 rounded-lg hover:border-primary transition-colors">
                <div className="flex items-center space-x-3 mb-3">
                  <span className="text-2xl">🔷</span>
                  <h3 className="font-medium">Password Policy Check</h3>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  Verify domain password policy compliance
                </p>
                <Button size="sm" className="bg-primary hover:bg-primary">
                  Add to Library
                </Button>
              </div>
              
              <div className="p-4 border border-gray-200 rounded-lg hover:border-primary transition-colors">
                <div className="flex items-center space-x-3 mb-3">
                  <span className="text-2xl">📄</span>
                  <h3 className="font-medium">Event Log Cleanup</h3>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  Clear old Windows event logs
                </p>
                <Button size="sm" className="bg-primary hover:bg-primary">
                  Add to Library
                </Button>
              </div>
              
              <div className="p-4 border border-gray-200 rounded-lg hover:border-primary transition-colors">
                <div className="flex items-center space-x-3 mb-3">
                  <span className="text-2xl">🔒</span>
                  <h3 className="font-medium">Security Audit</h3>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  Run comprehensive security audit
                </p>
                <Button size="sm" className="bg-primary hover:bg-primary">
                  Add to Library
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <AutomationScriptForm 
        open={showScriptForm}
        onClose={closeForm}
        script={selectedScript}
        isEdit={isEdit}
      />
    </div>
  );
}
