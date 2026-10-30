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
  Briefcase,
  Clock,
  CheckCircle,
  AlertCircle,
  DollarSign,
  Calendar,
  Edit,
  Eye,
  Wrench
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CrmJob, CrmContact, InsertCrmJob } from "@shared/schema";
import { Link } from "wouter";
import { format } from "date-fns";

type JobStatus = 'open' | 'in_progress' | 'waiting_parts' | 'completed' | 'cancelled';
type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

const statusOptions: { value: JobStatus; label: string; color: string; icon: typeof Clock }[] = [
  { value: 'open', label: 'Open', color: 'bg-blue-100 text-blue-800', icon: Clock },
  { value: 'in_progress', label: 'In Progress', color: 'bg-amber-100 text-amber-800', icon: Wrench },
  { value: 'waiting_parts', label: 'Waiting Parts', color: 'bg-purple-100 text-purple-800', icon: AlertCircle },
  { value: 'completed', label: 'Completed', color: 'bg-green-100 text-green-800', icon: CheckCircle },
  { value: 'cancelled', label: 'Cancelled', color: 'bg-gray-100 text-gray-800', icon: AlertCircle },
];

const priorityOptions: { value: JobPriority; label: string; color: string }[] = [
  { value: 'low', label: 'Low', color: 'bg-gray-100 text-gray-800' },
  { value: 'normal', label: 'Normal', color: 'bg-blue-100 text-blue-800' },
  { value: 'high', label: 'High', color: 'bg-orange-100 text-orange-800' },
  { value: 'urgent', label: 'Urgent', color: 'bg-red-100 text-red-800' },
];

const serviceTypes = [
  'computer_repair',
  'network_setup', 
  'data_recovery',
  'virus_removal',
  'hardware_upgrade',
  'software_installation',
  'it_consulting',
  'managed_services',
  'on_site_service',
  'remote_support',
  'other',
];

export default function CrmJobs() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showJobDialog, setShowJobDialog] = useState(false);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [selectedJob, setSelectedJob] = useState<CrmJob | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const { toast } = useToast();

  const { data: jobs = [], isLoading: jobsLoading } = useQuery<CrmJob[]>({
    queryKey: ["/api/crm/jobs"],
  });

  const { data: contacts = [] } = useQuery<CrmContact[]>({
    queryKey: ["/api/crm/contacts"],
  });

  const createJobMutation = useMutation({
    mutationFn: async (data: Omit<InsertCrmJob, 'jobNumber'>) => {
      return await apiRequest("POST", "/api/crm/jobs", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Job created successfully" });
      setShowJobDialog(false);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to create job", variant: "destructive" });
    },
  });

  const updateJobMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<Omit<InsertCrmJob, 'jobNumber'>> & { completedDateTime?: string } }) => {
      return await apiRequest("PATCH", `/api/crm/jobs/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Job updated successfully" });
      setShowJobDialog(false);
      setShowDetailDialog(false);
      setSelectedJob(null);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to update job", variant: "destructive" });
    },
  });

  const [formData, setFormData] = useState({
    contactId: 0,
    leadId: undefined as number | undefined,
    serviceType: 'computer_repair',
    status: 'open' as JobStatus,
    priority: 'normal' as JobPriority,
    description: '',
    notes: '',
    estimatedAmount: 0,
  });

  const resetForm = () => {
    setFormData({
      contactId: 0,
      leadId: undefined,
      serviceType: 'computer_repair',
      status: 'open',
      priority: 'normal',
      description: '',
      notes: '',
      estimatedAmount: 0,
    });
    setIsEditing(false);
    setSelectedJob(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditing && selectedJob) {
      updateJobMutation.mutate({ id: selectedJob.id, data: formData });
    } else {
      createJobMutation.mutate(formData);
    }
  };

  const handleEdit = (job: CrmJob) => {
    setSelectedJob(job);
    setFormData({
      contactId: job.contactId || 0,
      leadId: job.leadId || undefined,
      serviceType: job.serviceType,
      status: (job.status || 'open') as JobStatus,
      priority: (job.priority || 'normal') as JobPriority,
      description: job.description || '',
      notes: job.notes || '',
      estimatedAmount: job.estimatedAmount || 0,
    });
    setIsEditing(true);
    setShowJobDialog(true);
  };

  const handleViewDetail = (job: CrmJob) => {
    setSelectedJob(job);
    setShowDetailDialog(true);
  };

  const handleStatusChange = (jobId: number, newStatus: JobStatus) => {
    const updates: { status: string; completedDateTime?: string } = { status: newStatus };
    if (newStatus === 'completed') {
      updates.completedDateTime = new Date().toISOString();
    }
    updateJobMutation.mutate({ id: jobId, data: updates });
  };

  const getContactName = (contactId: number | null) => {
    if (!contactId) return <span className="text-gray-500">Unknown</span>;
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return <span className="text-gray-500">Unknown</span>;
    if (contact.clientId) {
      return (
        <Link href={`/crm/customers/${contact.clientId}`} className="text-blue-600 hover:underline">
          {contact.fullName}
        </Link>
      );
    }
    return <span>{contact.fullName}</span>;
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
    }).format(amount / 100);
  };

  const formatServiceType = (type: string) => {
    return type.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  const filteredJobs = jobs.filter(job => {
    const contact = contacts.find(c => c.id === job.contactId);
    const contactName = (contact?.fullName || 'Unknown').toLowerCase();
    const matchesSearch = contactName.includes(searchTerm.toLowerCase()) ||
      job.jobNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      job.serviceType.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || job.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string | null) => {
    const option = statusOptions.find(o => o.value === status) || statusOptions[0];
    return <Badge className={option.color}>{option.label}</Badge>;
  };

  const getPriorityBadge = (priority: string | null) => {
    const option = priorityOptions.find(o => o.value === priority) || priorityOptions[1];
    return <Badge className={option.color}>{option.label}</Badge>;
  };

  if (jobsLoading) {
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
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-gray-900" data-testid="page-title">Jobs / Work Orders</h2>
            <p className="text-sm md:text-base text-gray-600">Manage service jobs and work orders</p>
          </div>
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
            <Input 
              placeholder="Search jobs..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-48 lg:w-64"
              data-testid="input-search-jobs"
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
                setShowJobDialog(true);
              }}
              data-testid="button-add-job"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Job
            </Button>
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {statusOptions.map(status => {
            const count = jobs.filter(j => j.status === status.value).length;
            const StatusIcon = status.icon;
            return (
              <Card 
                key={status.value} 
                className={`cursor-pointer transition-all ${statusFilter === status.value ? 'ring-2 ring-primary' : ''}`}
                onClick={() => setStatusFilter(statusFilter === status.value ? 'all' : status.value)}
                data-testid={`card-status-${status.value}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <StatusIcon className="h-5 w-5 text-gray-400" />
                    <span className="text-2xl font-bold">{count}</span>
                  </div>
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
                <Briefcase className="h-5 w-5 mr-2 text-amber-500" />
                Work Orders ({filteredJobs.length})
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-6">
            <div className="overflow-x-auto -mx-2 sm:mx-0">
              <Table className="min-w-[1100px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Job #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Service Type</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredJobs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-gray-500">
                        No jobs found. Click "Create Job" to add one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredJobs.map((job) => (
                      <TableRow key={job.id} data-testid={`row-job-${job.id}`}>
                        <TableCell>
                          <div className="font-mono text-sm font-medium text-blue-600">
                            {job.jobNumber}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{getContactName(job.contactId)}</div>
                        </TableCell>
                        <TableCell>{formatServiceType(job.serviceType)}</TableCell>
                        <TableCell>{getPriorityBadge(job.priority)}</TableCell>
                        <TableCell>
                          <Select 
                            value={job.status || 'open'} 
                            onValueChange={(value) => handleStatusChange(job.id, value as JobStatus)}
                          >
                            <SelectTrigger className="w-36 h-8" data-testid={`select-job-status-${job.id}`}>
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
                          {job.estimatedAmount ? formatCurrency(job.estimatedAmount) : '-'}
                        </TableCell>
                        <TableCell>
                          {job.createdAt ? format(new Date(job.createdAt), 'MMM d, yyyy') : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end space-x-2">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleViewDetail(job)}
                              data-testid={`button-view-job-${job.id}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleEdit(job)}
                              data-testid={`button-edit-job-${job.id}`}
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

      <Dialog open={showJobDialog} onOpenChange={setShowJobDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit Job' : 'Create New Job'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Customer</Label>
              <Select 
                value={formData.contactId.toString()} 
                onValueChange={(value) => setFormData({...formData, contactId: parseInt(value)})}
              >
                <SelectTrigger data-testid="select-job-contact">
                  <SelectValue placeholder="Select a customer" />
                </SelectTrigger>
                <SelectContent>
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
                  <SelectTrigger data-testid="select-job-service">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceTypes.map(type => (
                      <SelectItem key={type} value={type}>
                        {formatServiceType(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select 
                  value={formData.priority} 
                  onValueChange={(value) => setFormData({...formData, priority: value as JobPriority})}
                >
                  <SelectTrigger data-testid="select-job-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {priorityOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
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
                  onValueChange={(value) => setFormData({...formData, status: value as JobStatus})}
                >
                  <SelectTrigger data-testid="select-job-status">
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
                <Label>Estimated Amount (cents)</Label>
                <Input 
                  type="number"
                  value={formData.estimatedAmount}
                  onChange={(e) => setFormData({...formData, estimatedAmount: parseInt(e.target.value) || 0})}
                  placeholder="e.g., 15000 for $150"
                  data-testid="input-job-amount"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea 
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
                placeholder="Describe the work to be done..."
                rows={3}
                data-testid="textarea-job-description"
              />
            </div>

            <div className="space-y-2">
              <Label>Internal Notes</Label>
              <Textarea 
                value={formData.notes}
                onChange={(e) => setFormData({...formData, notes: e.target.value})}
                placeholder="Internal notes..."
                rows={2}
                data-testid="textarea-job-notes"
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setShowJobDialog(false)}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={createJobMutation.isPending || updateJobMutation.isPending}
                data-testid="button-save-job"
              >
                {isEditing ? 'Update Job' : 'Create Job'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Job Details</DialogTitle>
          </DialogHeader>
          {selectedJob && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-mono text-lg font-semibold text-blue-600">{selectedJob.jobNumber}</div>
                  <h3 className="text-lg font-medium mt-1">{getContactName(selectedJob.contactId)}</h3>
                </div>
                <div className="flex flex-col items-end space-y-1">
                  {getStatusBadge(selectedJob.status)}
                  {getPriorityBadge(selectedJob.priority)}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                <div>
                  <div className="text-sm text-gray-500">Service Type</div>
                  <div className="font-medium">{formatServiceType(selectedJob.serviceType)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Estimated Amount</div>
                  <div className="font-medium flex items-center">
                    <DollarSign className="h-4 w-4 mr-1 text-green-500" />
                    {selectedJob.estimatedAmount ? formatCurrency(selectedJob.estimatedAmount) : 'Not set'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Created</div>
                  <div className="font-medium flex items-center">
                    <Calendar className="h-4 w-4 mr-1 text-blue-500" />
                    {selectedJob.createdAt ? format(new Date(selectedJob.createdAt), 'MMM d, yyyy') : '-'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Completed</div>
                  <div className="font-medium flex items-center">
                    {selectedJob.completedDateTime ? (
                      <>
                        <CheckCircle className="h-4 w-4 mr-1 text-green-500" />
                        {format(new Date(selectedJob.completedDateTime), 'MMM d, yyyy')}
                      </>
                    ) : (
                      <span className="text-gray-400">Not completed</span>
                    )}
                  </div>
                </div>
              </div>

              {selectedJob.description && (
                <div className="pt-4 border-t">
                  <div className="text-sm text-gray-500 mb-1">Description</div>
                  <p className="text-sm">{selectedJob.description}</p>
                </div>
              )}

              {selectedJob.notes && (
                <div className="pt-4 border-t">
                  <div className="text-sm text-gray-500 mb-1">Internal Notes</div>
                  <p className="text-sm">{selectedJob.notes}</p>
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <Button variant="outline" onClick={() => setShowDetailDialog(false)}>
                  Close
                </Button>
                <Button onClick={() => { setShowDetailDialog(false); handleEdit(selectedJob); }}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Job
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
