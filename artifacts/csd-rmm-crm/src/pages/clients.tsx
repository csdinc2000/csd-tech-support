import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { Plus, Search, Filter, MapPin, Phone, Mail, Building, Edit, Eye } from "lucide-react";
import { Client, Device, Ticket } from "@shared/schema";
import ClientForm from "@/components/forms/client-form";

export default function Clients({ embedded = false }: { embedded?: boolean } = {}) {
  const [showClientForm, setShowClientForm] = useState(false);
  const [selectedClient, setSelectedClient] = useState<Client | undefined>();
  const [isEdit, setIsEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const { data: clients = [], isLoading: clientsLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const { data: devices = [], isLoading: devicesLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
  });

  const { data: tickets = [], isLoading: ticketsLoading } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets"],
  });

  const isLoading = clientsLoading || devicesLoading || ticketsLoading;

  const filteredClients = clients.filter((client: Client) => 
    client.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    client.contactEmail.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleEdit = (client: Client) => {
    setSelectedClient(client);
    setIsEdit(true);
    setShowClientForm(true);
  };

  const handleAdd = () => {
    setSelectedClient(undefined);
    setIsEdit(false);
    setShowClientForm(true);
  };

  const closeForm = () => {
    setShowClientForm(false);
    setSelectedClient(undefined);
    setIsEdit(false);
  };

  const getClientStats = (clientId: number) => {
    const clientDevices = devices.filter(d => d.clientId === clientId);
    const clientTickets = tickets.filter(t => t.clientId === clientId);
    const onlineDevices = clientDevices.filter(d => d.status === "online").length;
    const openTickets = clientTickets.filter(t => t.status === "open" || t.status === "in-progress").length;
    
    return {
      totalDevices: clientDevices.length,
      onlineDevices,
      openTickets,
      healthScore: clientDevices.length > 0 ? Math.round((onlineDevices / clientDevices.length) * 100) : 100,
    };
  };

  const getHealthScoreColor = (score: number) => {
    if (score >= 90) return "bg-green-100 text-green-800";
    if (score >= 70) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  const getHealthScoreText = (score: number) => {
    if (score >= 90) return "Excellent";
    if (score >= 70) return "Good";
    return "Needs Attention";
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-32 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "min-h-screen bg-gray-50"}>
      {/* Header */}
      <div className={embedded ? "pb-4" : "bg-white border-b border-gray-200 px-4 md:px-6 py-4"}>
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          {!embedded && (
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-gray-900">Client Management</h2>
              <p className="text-sm md:text-base text-gray-600">Manage your South Florida client base</p>
            </div>
          )}
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
            <Input 
              placeholder="Search clients..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-48 lg:w-64"
            />
            <div className="flex space-x-2">
              <Button variant="outline" className="flex-1 sm:flex-none">
                <Filter className="h-4 w-4 mr-2" />
                Filter
              </Button>
              <Button 
                className="bg-primary text-white hover:bg-primary flex-1 sm:flex-none"
                onClick={handleAdd}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Client
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className={embedded ? "space-y-4 md:space-y-6" : "p-4 md:p-6 space-y-4 md:space-y-6"}>
        {/* Client Overview Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Clients</p>
                  <p className="text-3xl font-bold text-gray-900">{clients.length}</p>
                </div>
                <div className="p-3 rounded-full bg-blue-100">
                  <Building className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Active Contracts</p>
                  <p className="text-3xl font-bold text-green-600">{clients.length}</p>
                </div>
                <div className="p-3 rounded-full bg-green-100">
                  <Building className="h-5 w-5 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Devices Under Management</p>
                  <p className="text-3xl font-bold text-purple-600">{devices.length}</p>
                </div>
                <div className="p-3 rounded-full bg-purple-100">
                  <Building className="h-5 w-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Avg Response Time</p>
                  <p className="text-3xl font-bold text-primary">&lt; 20min</p>
                </div>
                <div className="p-3 rounded-full bg-red-100">
                  <Building className="h-5 w-5 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Client List */}
        <Card>
          <CardHeader>
            <CardTitle>Active Clients ({filteredClients.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {filteredClients.map((client: Client) => {
                const stats = getClientStats(client.id);
                return (
                  <div
                    key={client.id}
                    className="p-6 border border-gray-200 rounded-lg hover:border-primary hover:bg-red-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-4">
                        <div className="w-12 h-12 bg-primary bg-opacity-10 rounded-lg flex items-center justify-center">
                          <Building className="h-6 w-6 text-primary" />
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold text-gray-900">{client.name}</h3>
                          <div className="flex items-center space-x-4 text-sm text-gray-600 mt-1">
                            <div className="flex items-center space-x-1">
                              <Mail className="h-4 w-4" />
                              <span>{client.contactEmail}</span>
                            </div>
                            {client.contactPhone && (
                              <div className="flex items-center space-x-1">
                                <Phone className="h-4 w-4" />
                                <span>{client.contactPhone}</span>
                              </div>
                            )}
                            {client.address && (
                              <div className="flex items-center space-x-1">
                                <MapPin className="h-4 w-4" />
                                <span>{client.city}, {client.state}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-6">
                        <div className="text-center">
                          <div className="text-2xl font-bold text-gray-900">{stats.totalDevices}</div>
                          <div className="text-xs text-gray-500">Devices</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-green-600">{stats.onlineDevices}</div>
                          <div className="text-xs text-gray-500">Online</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-yellow-600">{stats.openTickets}</div>
                          <div className="text-xs text-gray-500">Open Tickets</div>
                        </div>
                        <div className="text-center">
                          <Badge className={getHealthScoreColor(stats.healthScore)}>
                            {stats.healthScore}%
                          </Badge>
                          <div className="text-xs text-gray-500">{getHealthScoreText(stats.healthScore)}</div>
                        </div>
                      </div>
                    </div>
                    
                    <div className="mt-4 flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Badge variant="outline" className="text-xs">
                          Client since {client.createdAt ? new Date(client.createdAt).getFullYear() : 'N/A'}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          IT Support Contract
                        </Badge>
                      </div>
                      
                      <div className="flex space-x-2">
                        <Link href={`/crm/customers/${client.id}`} className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 px-3 text-blue-600 hover:text-blue-800">
                          <Eye className="h-4 w-4 mr-1" />
                          View Details
                        </Link>
                        <Button variant="ghost" size="sm" className="text-green-600 hover:text-green-800">
                          Remote Access
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleEdit(client)}
                          className="text-primary hover:text-red-600"
                        >
                          <Edit className="h-4 w-4 mr-1" />
                          Edit
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Service Area Map */}
        <Card>
          <CardHeader>
            <CardTitle>Service Area Coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="text-center p-6 border border-gray-200 rounded-lg">
                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <MapPin className="h-8 w-8 text-blue-600" />
                </div>
                <h3 className="font-bold text-lg text-gray-900">Broward County</h3>
                <p className="text-sm text-gray-600 mt-2">
                  Fort Lauderdale, Davie, Weston, Margate, Parkland, Coral Springs, Sunrise
                </p>
                <div className="mt-4">
                  <Badge className="bg-blue-100 text-blue-800">
                    {clients.filter(c => c.city && ['Fort Lauderdale', 'Davie', 'Weston', 'Margate', 'Parkland', 'Coral Springs', 'Sunrise'].includes(c.city)).length} Clients
                  </Badge>
                </div>
              </div>
              
              <div className="text-center p-6 border border-gray-200 rounded-lg">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <MapPin className="h-8 w-8 text-green-600" />
                </div>
                <h3 className="font-bold text-lg text-gray-900">Dade County</h3>
                <p className="text-sm text-gray-600 mt-2">
                  Miami, Aventura, Doral, Hialeah, Homestead
                </p>
                <div className="mt-4">
                  <Badge className="bg-green-100 text-green-800">
                    {clients.filter(c => c.city && ['Miami', 'Aventura', 'Doral', 'Hialeah', 'Homestead'].includes(c.city)).length} Clients
                  </Badge>
                </div>
              </div>
              
              <div className="text-center p-6 border border-gray-200 rounded-lg">
                <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <MapPin className="h-8 w-8 text-purple-600" />
                </div>
                <h3 className="font-bold text-lg text-gray-900">Palm Beach County</h3>
                <p className="text-sm text-gray-600 mt-2">
                  Boca Raton, Delray Beach, Boynton Beach, Jupiter
                </p>
                <div className="mt-4">
                  <Badge className="bg-purple-100 text-purple-800">
                    {clients.filter(c => c.city && ['Boca Raton', 'Delray Beach', 'Boynton Beach', 'Jupiter'].includes(c.city)).length} Clients
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* RMM Platform Information */}
        <Card className="bg-gradient-to-r from-primary to-red-600 text-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold mb-2">RMM Platform</h3>
                <p className="text-red-100 mb-4">
                  "Fast, Reliable, Affordable Computer Repair" - Serving South Florida since 1996
                </p>
                <div className="flex items-center space-x-6 text-sm">
                  <div className="flex items-center space-x-2">
                    <Phone className="h-4 w-4" />
                    <span className="font-semibold">954-637-7300</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <MapPin className="h-4 w-4" />
                    <span>5601 NW 13th Street, Lauderhill, FL 33313</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Building className="h-4 w-4" />
                    <span>27+ Years of Excellence</span>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <Button className="bg-white text-primary px-6 py-3 font-semibold hover:bg-gray-100 transition-colors">
                  Contact RMM
                </Button>
                <p className="text-xs text-red-100 mt-2">
                  "Customers come first at RMM Platform"
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <ClientForm 
        open={showClientForm}
        onClose={closeForm}
        client={selectedClient}
        isEdit={isEdit}
      />
    </div>
  );
}
