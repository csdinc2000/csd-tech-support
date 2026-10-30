import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { 
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { 
  Plus, 
  Search, 
  Filter,
  Target,
  Phone,
  Mail,
  Calendar,
  DollarSign,
  ArrowRight,
  Edit,
  Eye,
  Laptop
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CrmLead, CrmContact, InsertCrmLead, Service } from "@shared/schema";
import { format } from "date-fns";

type LeadStatus = 'new' | 'contacted' | 'qualified' | 'quoted' | 'won' | 'lost';

const statusOptions: { value: LeadStatus; label: string; color: string }[] = [
  { value: 'new', label: 'New', color: 'bg-blue-100 text-blue-800' },
  { value: 'contacted', label: 'Contacted', color: 'bg-indigo-100 text-indigo-800' },
  { value: 'qualified', label: 'Qualified', color: 'bg-purple-100 text-purple-800' },
  { value: 'quoted', label: 'Quoted', color: 'bg-amber-100 text-amber-800' },
  { value: 'won', label: 'Won', color: 'bg-green-100 text-green-800' },
  { value: 'lost', label: 'Lost', color: 'bg-gray-100 text-gray-800' },
];

// Legacy values that predate the booking catalog. Kept only so leads created
// before the catalog existed still render and remain selectable.
const legacyServiceTypes = [
  'computer_repair',
  'network_setup', 
  'data_recovery',
  'virus_removal',
  'hardware_upgrade',
  'software_installation',
  'it_consulting',
  'managed_services',
  'other',
];

// The arrival channel. Matches what POST /api/intake writes, so filtering by
// source actually returns the intake leads. The customer's "how did you hear
// about us" answer is attribution, and lives in `campaign`.
const sourceOptions = [
  'website_intake',
  'phone_call',
  'walk_in',
  'referral',
  'google_ads',
  'social_media',
  'other',
];

// Radix <Select> cannot hold an empty string as an item value, so an unassigned
// contact needs a sentinel rather than the 0 that used to stand in for it.
const NO_CONTACT = 'none';

export default function CrmLeads({ embedded = false }: { embedded?: boolean } = {}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showLeadDialog, setShowLeadDialog] = useState(false);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [selectedLead, setSelectedLead] = useState<CrmLead | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const { toast } = useToast();

  const { data: leads = [], isLoading: leadsLoading } = useQuery<CrmLead[]>({
    queryKey: ["/api/crm/leads"],
  });

  const { data: contacts = [] } = useQuery<CrmContact[]>({
    queryKey: ["/api/crm/contacts"],
  });

  const { data: services = [] } = useQuery<Service[]>({
    queryKey: ["/api/booking/services"],
  });

  // Catalog names first, then legacy values, then whatever this lead already
  // holds — so an existing value is never silently blanked by the Select.
  const serviceTypeOptions = (current?: string) => {
    const options = [...services.map((s) => s.name), ...legacyServiceTypes];
    if (current && !options.includes(current)) options.unshift(current);
    return Array.from(new Set(options));
  };

  const createLeadMutation = useMutation({
    mutationFn: async (data: InsertCrmLead) => {
      return await apiRequest("POST", "/api/crm/leads", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Lead created successfully" });
      setShowLeadDialog(false);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to create lead", variant: "destructive" });
    },
  });

  const updateLeadMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertCrmLead> }) => {
      return await apiRequest("PATCH", `/api/crm/leads/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Lead updated successfully" });
      setShowLeadDialog(false);
      setShowDetailDialog(false);
      setSelectedLead(null);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to update lead", variant: "destructive" });
    },
  });

  // `contactId` is nullable: a lead can exist before anyone has been recorded as
  // its contact, and most intake leads arrive that way. Never coerce that to 0 —
  // crm_leads.contact_id is a foreign key, so 0 fails the constraint.
  const [formData, setFormData] = useState<{
    contactId: number | null;
    source: string;
    serviceType: string;
    status: LeadStatus;
    estimatedValue: number;
    notes: string;
  }>({
    contactId: null,
    source: 'website_intake',
    serviceType: 'computer_repair',
    status: 'new' as LeadStatus,
    estimatedValue: 0,
    notes: '',
  });

  const resetForm = () => {
    setFormData({
      contactId: null,
      source: 'website_intake',
      serviceType: 'computer_repair',
      status: 'new',
      estimatedValue: 0,
      notes: '',
    });
    setIsEditing(false);
    setSelectedLead(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditing && selectedLead) {
      updateLeadMutation.mutate({ id: selectedLead.id, data: formData });
    } else {
      createLeadMutation.mutate(formData);
    }
  };

  const handleEdit = (lead: CrmLead) => {
    setSelectedLead(lead);
    setFormData({
      contactId: lead.contactId ?? null,
      source: lead.source || 'website_intake',
      serviceType: lead.serviceType,
      status: (lead.status || 'new') as LeadStatus,
      estimatedValue: lead.estimatedValue || 0,
      notes: lead.notes || '',
    });
    setIsEditing(true);
    setShowLeadDialog(true);
  };

  const handleViewDetail = (lead: CrmLead) => {
    setSelectedLead(lead);
    setShowDetailDialog(true);
  };

  const handleStatusChange = (leadId: number, newStatus: LeadStatus) => {
    updateLeadMutation.mutate({ id: leadId, data: { status: newStatus } });
  };

  const getContactName = (contactId: number | null) => {
    if (!contactId) return 'Unknown';
    const contact = contacts.find(c => c.id === contactId);
    return contact?.fullName || 'Unknown';
  };

  const getContactPhone = (contactId: number | null) => {
    if (!contactId) return '';
    const contact = contacts.find(c => c.id === contactId);
    return contact?.mobilePhone || contact?.officePhone || '';
  };

  const getContactEmail = (contactId: number | null) => {
    if (!contactId) return '';
    const contact = contacts.find(c => c.id === contactId);
    return contact?.email || '';
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
    }).format(amount / 100);
  };

  const formatServiceType = (type: string) => {
    if (!type.includes('_')) return type;
    return type.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  const filteredLeads = leads.filter(lead => {
    const contactName = getContactName(lead.contactId).toLowerCase();
    const needle = searchTerm.toLowerCase();
    const matchesSearch = [
      contactName,
      lead.serviceType,
      lead.deviceType,
      lead.brandModel,
      lead.problemDescription,
    ].some((field) => (field ?? '').toLowerCase().includes(needle));
    const matchesStatus = statusFilter === 'all' || lead.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string | null) => {
    const option = statusOptions.find(o => o.value === status) || statusOptions[0];
    return <Badge className={option.color}>{option.label}</Badge>;
  };

  if (leadsLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-6"></div>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "min-h-screen bg-gray-50"}>
      <div className={embedded ? "pb-4" : "bg-white border-b border-gray-200 px-4 md:px-6 py-4"}>
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          {!embedded && (
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-gray-900" data-testid="page-title">Leads & Pipeline</h2>
              <p className="text-sm md:text-base text-gray-600">Manage sales opportunities and track conversions</p>
            </div>
          )}
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
            <Input 
              placeholder="Search leads..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-48 lg:w-64"
              data-testid="input-search-leads"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-40" data-testid="select-status-filter">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {statusOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button 
              className="bg-primary text-white hover:bg-primary/90"
              onClick={() => {
                resetForm();
                setShowLeadDialog(true);
              }}
              data-testid="button-add-lead"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Lead
            </Button>
          </div>
        </div>
      </div>

      <div className={embedded ? "space-y-6" : "p-4 md:p-6 space-y-6"}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {statusOptions.map(status => {
            const count = leads.filter(l => l.status === status.value).length;
            return (
              <Card 
                key={status.value} 
                className={`cursor-pointer transition-all ${statusFilter === status.value ? 'ring-2 ring-primary' : ''}`}
                onClick={() => setStatusFilter(statusFilter === status.value ? 'all' : status.value)}
                data-testid={`card-status-${status.value}`}
              >
                <CardContent className="p-4 text-center">
                  <div className="text-2xl font-bold">{count}</div>
                  <div className="text-sm text-gray-600">{status.label}</div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-semibold">
              <div className="flex items-center">
                <Target className="h-5 w-5 mr-2 text-blue-500" />
                Lead Pipeline ({filteredLeads.length})
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-6">
            <div className="overflow-x-auto -mx-2 sm:mx-0">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead>Service Type</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLeads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-gray-500">
                        No leads found. Click "Add Lead" to create one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredLeads.map((lead) => (
                      <TableRow key={lead.id} data-testid={`row-lead-${lead.id}`}>
                        <TableCell>
                          <div className="font-medium">{getContactName(lead.contactId)}</div>
                          <div className="text-sm text-gray-500 flex items-center">
                            <Phone className="h-3 w-3 mr-1" />
                            {getContactPhone(lead.contactId) || 'No phone'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>{formatServiceType(lead.serviceType)}</div>
                          {lead.deviceType && (
                            <div className="text-xs text-gray-500">
                              {[lead.deviceType, lead.brandModel].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{formatServiceType(lead.source || 'Unknown')}</Badge>
                          {lead.campaign && (
                            <div className="mt-0.5 text-xs text-gray-500">{lead.campaign}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          {lead.estimatedValue ? formatCurrency(lead.estimatedValue) : '-'}
                        </TableCell>
                        <TableCell>
                          <Select 
                            value={lead.status || 'new'} 
                            onValueChange={(value) => handleStatusChange(lead.id, value as LeadStatus)}
                          >
                            <SelectTrigger className="w-32 h-8" data-testid={`select-lead-status-${lead.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {statusOptions.map(option => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          {lead.createdAt ? format(new Date(lead.createdAt), 'MMM d, yyyy') : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end space-x-2">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleViewDetail(lead)}
                              data-testid={`button-view-lead-${lead.id}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleEdit(lead)}
                              data-testid={`button-edit-lead-${lead.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showLeadDialog} onOpenChange={setShowLeadDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit Lead' : 'Add New Lead'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Contact</Label>
              <Select 
                value={formData.contactId === null ? NO_CONTACT : formData.contactId.toString()} 
                onValueChange={(value) => setFormData({...formData, contactId: value === NO_CONTACT ? null : parseInt(value)})}
              >
                <SelectTrigger data-testid="select-lead-contact">
                  <SelectValue placeholder="Select a contact" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CONTACT}>No contact</SelectItem>
                  {contacts.map(contact => (
                    <SelectItem key={contact.id} value={contact.id.toString()}>
                      {contact.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Service Type</Label>
                <Select 
                  value={formData.serviceType} 
                  onValueChange={(value) => setFormData({...formData, serviceType: value})}
                >
                  <SelectTrigger data-testid="select-lead-service">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceTypeOptions(formData.serviceType).map(type => (
                      <SelectItem key={type} value={type}>
                        {formatServiceType(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Source</Label>
                <Select 
                  value={formData.source} 
                  onValueChange={(value) => setFormData({...formData, source: value})}
                >
                  <SelectTrigger data-testid="select-lead-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceOptions.map(source => (
                      <SelectItem key={source} value={source}>
                        {formatServiceType(source)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select 
                  value={formData.status} 
                  onValueChange={(value) => setFormData({...formData, status: value as LeadStatus})}
                >
                  <SelectTrigger data-testid="select-lead-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Estimated Value (cents)</Label>
                <Input 
                  type="number"
                  value={formData.estimatedValue}
                  onChange={(e) => setFormData({...formData, estimatedValue: parseInt(e.target.value) || 0})}
                  placeholder="e.g., 15000 for $150"
                  data-testid="input-lead-value"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea 
                value={formData.notes}
                onChange={(e) => setFormData({...formData, notes: e.target.value})}
                placeholder="Additional notes about this lead..."
                rows={3}
                data-testid="textarea-lead-notes"
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setShowLeadDialog(false)}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={createLeadMutation.isPending || updateLeadMutation.isPending}
                data-testid="button-save-lead"
              >
                {isEditing ? 'Update Lead' : 'Create Lead'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Lead Details</DialogTitle>
          </DialogHeader>
          {selectedLead && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">{getContactName(selectedLead.contactId)}</h3>
                  <div className="flex items-center text-sm text-gray-500 mt-1">
                    <Mail className="h-4 w-4 mr-1" />
                    {getContactEmail(selectedLead.contactId) || 'No email'}
                  </div>
                  <div className="flex items-center text-sm text-gray-500">
                    <Phone className="h-4 w-4 mr-1" />
                    {getContactPhone(selectedLead.contactId) || 'No phone'}
                  </div>
                </div>
                {getStatusBadge(selectedLead.status)}
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                <div>
                  <div className="text-sm text-gray-500">Service Type</div>
                  <div className="font-medium">{formatServiceType(selectedLead.serviceType)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Source</div>
                  <div className="font-medium">{formatServiceType(selectedLead.source || 'Unknown')}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Estimated Value</div>
                  <div className="font-medium flex items-center">
                    <DollarSign className="h-4 w-4 mr-1 text-green-500" />
                    {selectedLead.estimatedValue ? formatCurrency(selectedLead.estimatedValue) : 'Not set'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Created</div>
                  <div className="font-medium flex items-center">
                    <Calendar className="h-4 w-4 mr-1 text-blue-500" />
                    {selectedLead.createdAt ? format(new Date(selectedLead.createdAt), 'MMM d, yyyy') : '-'}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                <div>
                  <div className="text-sm text-gray-500">Device</div>
                  <div className="font-medium flex items-center">
                    <Laptop className="h-4 w-4 mr-1 text-gray-400" />
                    {[selectedLead.deviceType, selectedLead.brandModel].filter(Boolean).join(' · ') || 'Not provided'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Operating System</div>
                  <div className="font-medium">{selectedLead.operatingSystem || 'Not provided'}</div>
                </div>
                {selectedLead.campaign && (
                  <div>
                    <div className="text-sm text-gray-500">How they heard about us</div>
                    <div className="font-medium">{selectedLead.campaign}</div>
                  </div>
                )}
                {selectedLead.assignedTo && (
                  <div>
                    <div className="text-sm text-gray-500">Assigned To</div>
                    <div className="font-medium">{selectedLead.assignedTo}</div>
                  </div>
                )}
              </div>

              {selectedLead.problemDescription && (
                <div className="pt-4 border-t">
                  <div className="text-sm text-gray-500 mb-1">Reported Problem</div>
                  <p className="whitespace-pre-wrap rounded bg-gray-50 p-2 text-sm">
                    {selectedLead.problemDescription}
                  </p>
                </div>
              )}

              {selectedLead.notes && (
                <div className="pt-4 border-t">
                  <div className="text-sm text-gray-500 mb-1">Notes</div>
                  <p className="text-sm whitespace-pre-wrap">{selectedLead.notes}</p>
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <Button variant="outline" onClick={() => setShowDetailDialog(false)}>
                  Close
                </Button>
                <Button onClick={() => { setShowDetailDialog(false); handleEdit(selectedLead); }}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Lead
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
