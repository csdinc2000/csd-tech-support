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
  Users,
  Phone,
  Mail,
  MapPin,
  Building,
  Edit,
  Eye,
  MessageCircle,
  RefreshCw,
  CheckCircle,
  Cloud,
  Download,
  Trash2
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CrmContact, InsertCrmContact } from "@shared/schema";
import { format } from "date-fns";

type ContactPreference = 'call' | 'text' | 'email' | 'text_email';

const preferenceOptions: { value: ContactPreference; label: string }[] = [
  { value: 'call', label: 'Phone Call' },
  { value: 'text', label: 'Text Message' },
  { value: 'email', label: 'Email' },
  { value: 'text_email', label: 'Text & Email' },
];

export default function CrmContacts({ embedded = false }: { embedded?: boolean } = {}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showContactDialog, setShowContactDialog] = useState(false);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [selectedContact, setSelectedContact] = useState<CrmContact | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const { toast } = useToast();

  const { data: contacts = [], isLoading } = useQuery<CrmContact[]>({
    queryKey: ["/api/crm/contacts"],
  });

  const createContactMutation = useMutation({
    mutationFn: async (data: InsertCrmContact) => {
      return await apiRequest("POST", "/api/crm/contacts", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Contact created successfully" });
      setShowContactDialog(false);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to create contact", variant: "destructive" });
    },
  });

  const updateContactMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertCrmContact> }) => {
      return await apiRequest("PATCH", `/api/crm/contacts/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Contact updated successfully" });
      setShowContactDialog(false);
      setShowDetailDialog(false);
      setSelectedContact(null);
      resetForm();
    },
    onError: () => {
      toast({ title: "Failed to update contact", variant: "destructive" });
    },
  });

  const [contactToDelete, setContactToDelete] = useState<CrmContact | null>(null);

  const deleteContactMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/crm/contacts/${id}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ title: "Contact deleted" });
      setContactToDelete(null);
      setShowDetailDialog(false);
      setSelectedContact(null);
    },
    onError: (e: any) => {
      toast({ title: "Failed to delete contact", description: e?.message, variant: "destructive" });
    },
  });

  const { data: googleStatus } = useQuery<{ configured: boolean; hasCredentials: boolean; hasToken: boolean }>({
    queryKey: ["/api/google/status"],
  });

  const syncContactMutation = useMutation({
    mutationFn: async (contactId: number) => {
      const response = await apiRequest("POST", `/api/google/sync-contact/${contactId}`, {});
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      toast({ title: "Contact synced to Google Contacts" });
    },
    onError: (error: any) => {
      toast({ title: "Sync failed", description: error.message, variant: "destructive" });
    },
  });

  const syncAllContactsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/google/sync-all-contacts", {});
      return response.json();
    },
    onSuccess: (data: { synced: number; failed: number; skipped: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      toast({ 
        title: "Sync Complete", 
        description: `Synced: ${data.synced}, Skipped: ${data.skipped}, Failed: ${data.failed}` 
      });
    },
    onError: (error: any) => {
      toast({ title: "Sync failed", description: error.message, variant: "destructive" });
    },
  });

  const importGoogleContactsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/google/import-contacts", {});
      return response.json();
    },
    onSuccess: (data: { totalFromGoogle: number; imported: number; skipped: number; failed: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
      toast({ 
        title: "Import Complete", 
        description: `Found ${data.totalFromGoogle} contacts. Imported: ${data.imported}, Skipped: ${data.skipped}, Failed: ${data.failed}` 
      });
    },
    onError: (error: any) => {
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const connectGoogleMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/google/auth-url");
      const data = await response.json();
      if (data.authUrl) {
        window.open(data.authUrl, '_blank');
      } else {
        throw new Error(data.error || "Failed to get auth URL");
      }
    },
    onError: (error: any) => {
      toast({ title: "Connection failed", description: error.message, variant: "destructive" });
    },
  });

  const [formData, setFormData] = useState({
    fullName: '',
    mobilePhone: '',
    officePhone: '',
    email: '',
    company: '',
    address: '',
    city: '',
    state: 'FL',
    zip: '',
    contactPreference: 'text_email' as ContactPreference,
    notes: '',
  });

  const resetForm = () => {
    setFormData({
      fullName: '',
      mobilePhone: '',
      officePhone: '',
      email: '',
      company: '',
      address: '',
      city: '',
      state: 'FL',
      zip: '',
      contactPreference: 'text_email',
      notes: '',
    });
    setIsEditing(false);
    setSelectedContact(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditing && selectedContact) {
      updateContactMutation.mutate({ id: selectedContact.id, data: formData });
    } else {
      createContactMutation.mutate(formData);
    }
  };

  const handleEdit = (contact: CrmContact) => {
    setSelectedContact(contact);
    setFormData({
      fullName: contact.fullName,
      mobilePhone: contact.mobilePhone || '',
      officePhone: contact.officePhone || '',
      email: contact.email || '',
      company: contact.company || '',
      address: contact.address || '',
      city: contact.city || '',
      state: contact.state || 'FL',
      zip: contact.zipCode || '',
      contactPreference: (contact.contactPreference || 'text_email') as ContactPreference,
      notes: contact.notes || '',
    });
    setIsEditing(true);
    setShowContactDialog(true);
  };

  const handleViewDetail = (contact: CrmContact) => {
    setSelectedContact(contact);
    setShowDetailDialog(true);
  };

  const filteredContacts = contacts.filter(contact => {
    const searchLower = searchTerm.toLowerCase();
    return contact.fullName.toLowerCase().includes(searchLower) ||
      (contact.email && contact.email.toLowerCase().includes(searchLower)) ||
      (contact.company && contact.company.toLowerCase().includes(searchLower)) ||
      (contact.mobilePhone && contact.mobilePhone.includes(searchTerm));
  });

  const getPreferenceLabel = (pref: string | null) => {
    const option = preferenceOptions.find(o => o.value === pref);
    return option?.label || 'Text & Email';
  };

  if (isLoading) {
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
              <h2 className="text-xl md:text-2xl font-bold text-gray-900" data-testid="page-title">Contacts</h2>
              <p className="text-sm md:text-base text-gray-600">Manage customer contacts and information</p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:flex sm:flex-row gap-2 sm:gap-3 sm:space-y-0">
            <Input 
              placeholder="Search contacts..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-48 lg:w-64"
              data-testid="input-search-contacts"
            />
            {googleStatus?.configured ? (
              <>
                <Button 
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => importGoogleContactsMutation.mutate()}
                  disabled={importGoogleContactsMutation.isPending}
                >
                  {importGoogleContactsMutation.isPending ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Import from Google
                </Button>
                <Button 
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => syncAllContactsMutation.mutate()}
                  disabled={syncAllContactsMutation.isPending}
                >
                  {syncAllContactsMutation.isPending ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Cloud className="h-4 w-4 mr-2" />
                  )}
                  Sync to Google
                </Button>
              </>
            ) : googleStatus?.hasCredentials ? (
              <Button 
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => connectGoogleMutation.mutate()}
                disabled={connectGoogleMutation.isPending}
              >
                <Cloud className="h-4 w-4 mr-2" />
                Connect Google
              </Button>
            ) : null}
            <Button 
              className="w-full sm:w-auto bg-primary text-white hover:bg-primary/90"
              onClick={() => {
                resetForm();
                setShowContactDialog(true);
              }}
              data-testid="button-add-contact"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Contact
            </Button>
          </div>
        </div>
      </div>

      <div className={embedded ? "space-y-6" : "p-4 md:p-6 space-y-6"}>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-semibold">
              <div className="flex items-center">
                <Users className="h-5 w-5 mr-2 text-blue-500" />
                Contact Directory ({filteredContacts.length})
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-6">
            <div className="overflow-x-auto -mx-2 sm:mx-0">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Preference</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredContacts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-gray-500">
                        No contacts found. Click "Add Contact" to create one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredContacts.map((contact) => (
                      <TableRow key={contact.id} data-testid={`row-contact-${contact.id}`}>
                        <TableCell>
                          <div className="flex items-center">
                            <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-medium text-sm mr-3">
                              {contact.fullName.charAt(0).toUpperCase()}
                            </div>
                            <div className="font-medium">{contact.fullName}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {contact.company ? (
                            <div className="flex items-center text-sm">
                              <Building className="h-3 w-3 mr-1 text-gray-400" />
                              {contact.company}
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {contact.mobilePhone ? (
                            <div className="flex items-center text-sm">
                              <Phone className="h-3 w-3 mr-1 text-gray-400" />
                              {contact.mobilePhone}
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {contact.email ? (
                            <div className="flex items-center text-sm">
                              <Mail className="h-3 w-3 mr-1 text-gray-400" />
                              {contact.email}
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {contact.city ? (
                            <div className="flex items-center text-sm">
                              <MapPin className="h-3 w-3 mr-1 text-gray-400" />
                              {contact.city}, {contact.state || 'FL'}
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            <MessageCircle className="h-3 w-3 mr-1" />
                            {getPreferenceLabel(contact.contactPreference)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end items-center space-x-2">
                            {contact.googleContactId && (
                              <span title="Synced to Google">
                                <CheckCircle className="h-4 w-4 text-green-500" />
                              </span>
                            )}
                            {googleStatus?.configured && !contact.googleContactId && (
                              <Button 
                                variant="ghost" 
                                size="sm"
                                onClick={() => syncContactMutation.mutate(contact.id)}
                                disabled={syncContactMutation.isPending}
                                title="Sync to Google Contacts"
                              >
                                <Cloud className="h-4 w-4 text-blue-500" />
                              </Button>
                            )}
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleViewDetail(contact)}
                              data-testid={`button-view-contact-${contact.id}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleEdit(contact)}
                              data-testid={`button-edit-contact-${contact.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setContactToDelete(contact)}
                              data-testid={`button-delete-contact-${contact.id}`}
                              title="Delete contact"
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
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

      <Dialog open={showContactDialog} onOpenChange={setShowContactDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit Contact' : 'Add New Contact'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Full Name *</Label>
              <Input 
                value={formData.fullName}
                onChange={(e) => setFormData({...formData, fullName: e.target.value})}
                placeholder="John Smith"
                required
                data-testid="input-contact-name"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Mobile Phone</Label>
                <Input 
                  value={formData.mobilePhone}
                  onChange={(e) => setFormData({...formData, mobilePhone: e.target.value})}
                  placeholder="(555) 123-4567"
                  data-testid="input-contact-mobile"
                />
              </div>
              <div className="space-y-2">
                <Label>Office Phone</Label>
                <Input 
                  value={formData.officePhone}
                  onChange={(e) => setFormData({...formData, officePhone: e.target.value})}
                  placeholder="(555) 987-6543"
                  data-testid="input-contact-office"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input 
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({...formData, email: e.target.value})}
                  placeholder="john@example.com"
                  data-testid="input-contact-email"
                />
              </div>
              <div className="space-y-2">
                <Label>Company</Label>
                <Input 
                  value={formData.company}
                  onChange={(e) => setFormData({...formData, company: e.target.value})}
                  placeholder="Company Name"
                  data-testid="input-contact-company"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Address</Label>
              <Input 
                value={formData.address}
                onChange={(e) => setFormData({...formData, address: e.target.value})}
                placeholder="123 Main Street"
                data-testid="input-contact-address"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>City</Label>
                <Input 
                  value={formData.city}
                  onChange={(e) => setFormData({...formData, city: e.target.value})}
                  placeholder="Fort Lauderdale"
                  data-testid="input-contact-city"
                />
              </div>
              <div className="space-y-2">
                <Label>State</Label>
                <Input 
                  value={formData.state}
                  onChange={(e) => setFormData({...formData, state: e.target.value})}
                  placeholder="FL"
                  data-testid="input-contact-state"
                />
              </div>
              <div className="space-y-2">
                <Label>ZIP</Label>
                <Input 
                  value={formData.zip}
                  onChange={(e) => setFormData({...formData, zip: e.target.value})}
                  placeholder="33301"
                  data-testid="input-contact-zip"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Contact Preference</Label>
              <Select 
                value={formData.contactPreference} 
                onValueChange={(value) => setFormData({...formData, contactPreference: value as ContactPreference})}
              >
                <SelectTrigger data-testid="select-contact-preference">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {preferenceOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea 
                value={formData.notes}
                onChange={(e) => setFormData({...formData, notes: e.target.value})}
                placeholder="Additional notes about this contact..."
                rows={3}
                data-testid="textarea-contact-notes"
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setShowContactDialog(false)}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={createContactMutation.isPending || updateContactMutation.isPending}
                data-testid="button-save-contact"
              >
                {isEditing ? 'Update Contact' : 'Create Contact'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Contact Details</DialogTitle>
          </DialogHeader>
          {selectedContact && (
            <div className="space-y-4">
              <div className="flex items-center">
                <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-medium text-lg mr-4">
                  {selectedContact.fullName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{selectedContact.fullName}</h3>
                  {selectedContact.company && (
                    <div className="flex items-center text-sm text-gray-500">
                      <Building className="h-4 w-4 mr-1" />
                      {selectedContact.company}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                <div>
                  <div className="text-sm text-gray-500">Mobile Phone</div>
                  <div className="font-medium flex items-center">
                    <Phone className="h-4 w-4 mr-1 text-blue-500" />
                    {selectedContact.mobilePhone || 'Not set'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Office Phone</div>
                  <div className="font-medium flex items-center">
                    <Phone className="h-4 w-4 mr-1 text-gray-400" />
                    {selectedContact.officePhone || 'Not set'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Email</div>
                  <div className="font-medium flex items-center">
                    <Mail className="h-4 w-4 mr-1 text-blue-500" />
                    {selectedContact.email || 'Not set'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Preference</div>
                  <div className="font-medium flex items-center">
                    <MessageCircle className="h-4 w-4 mr-1 text-green-500" />
                    {getPreferenceLabel(selectedContact.contactPreference)}
                  </div>
                </div>
              </div>

              {(selectedContact.address || selectedContact.city) && (
                <div className="pt-4 border-t">
                  <div className="text-sm text-gray-500 mb-1">Address</div>
                  <div className="font-medium flex items-start">
                    <MapPin className="h-4 w-4 mr-1 mt-0.5 text-blue-500" />
                    <div>
                      {selectedContact.address && <div>{selectedContact.address}</div>}
                      {selectedContact.city && (
                        <div>{selectedContact.city}, {selectedContact.state || 'FL'} {selectedContact.zipCode}</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {selectedContact.notes && (
                <div className="pt-4 border-t">
                  <div className="text-sm text-gray-500 mb-1">Notes</div>
                  <p className="text-sm">{selectedContact.notes}</p>
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <Button variant="outline" onClick={() => setShowDetailDialog(false)}>
                  Close
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setContactToDelete(selectedContact)}
                  data-testid="button-delete-contact-detail"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
                <Button onClick={() => { setShowDetailDialog(false); handleEdit(selectedContact); }}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Contact
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!contactToDelete} onOpenChange={(open) => !open && setContactToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes <strong>{contactToDelete?.fullName}</strong> from your contacts.
              Any leads, jobs, or interactions tied to this person will be kept but unlinked. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => contactToDelete && deleteContactMutation.mutate(contactToDelete.id)}
              disabled={deleteContactMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete"
            >
              {deleteContactMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
