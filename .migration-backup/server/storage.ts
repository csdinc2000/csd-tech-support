import {
  users, devices, alerts, tickets, clients, networkScans, automationScripts, csdIntakeRecords,
  remoteAccessSessions,
  emergencyContacts, helpdeskIntegrations,
  patchPolicies, devicePatches, patchJobs,
  crmContacts, crmLeads, crmJobs, crmInteractions, crmDeals, serviceLog,
  ariaConversations, ariaMessages,
  bookingResources, resourceTags, resourceTagAssignments,
  serviceCategories, services, serviceResourceRequirements,
  businessHours, resourceTimeOff, holidays,
  bookingSlotLocks, bookingSlotLockResources,
  appointments, appointmentResources,
  ticketDepartments, ticketTeams, ticketTeamMembers, ticketHelpTopics,
  slaPlans, ticketMessages, ticketActivity, ticketAttachments,
  cannedResponses, emailTemplates, ticketFilters, ticketSettings,
  type User, type InsertUser, type Device, type InsertDevice,
  type Alert, type InsertAlert, type Ticket, type InsertTicket,
  type Client, type InsertClient, type NetworkScan, type InsertNetworkScan,
  type AutomationScript, type InsertAutomationScript,
  type RemoteAccessSession, type InsertRemoteAccessSession,
  type EmergencyContact, type InsertEmergencyContact,
  type HelpdeskIntegration, type InsertHelpdeskIntegration,
  type PatchPolicy, type InsertPatchPolicy,
  type DevicePatch, type InsertDevicePatch,
  type PatchJob, type InsertPatchJob,
  type CsdIntakeRecord, type InsertCsdIntake,
  type CrmContact, type InsertCrmContact,
  type CrmLead, type InsertCrmLead,
  type CrmDeal, type InsertCrmDeal,
  type CrmJob, type InsertCrmJob,
  type CrmInteraction, type InsertCrmInteraction,
  type ServiceLog, type InsertServiceLog,
  a2pRejectionSuggestions, normalizeRejectionReason,
  type A2pRejectionSuggestion, type InsertA2pRejectionSuggestion,
  type AriaConversation, type InsertAriaConversation,
  type AriaMessage, type InsertAriaMessage,
  type BookingResource, type InsertBookingResource,
  type ResourceTag, type InsertResourceTag,
  type Service, type InsertService,
  type ServiceCategory, type InsertServiceCategory,
  type ServiceResourceRequirement, type InsertServiceResourceRequirement,
  type BusinessHours, type InsertBusinessHours,
  type ResourceTimeOff, type InsertResourceTimeOff,
  type Holiday, type InsertHoliday,
  type BookingSlotLock, type InsertBookingSlotLock,
  type BookingSlotLockResource, type InsertBookingSlotLockResource,
  type Appointment, type InsertAppointment,
  type AppointmentResource, type InsertAppointmentResource,
  type TicketDepartment, type InsertTicketDepartment,
  type TicketTeam, type InsertTicketTeam,
  type TicketTeamMember, type InsertTicketTeamMember,
  type TicketHelpTopic, type InsertTicketHelpTopic,
  type SlaPlan, type InsertSlaPlan,
  type TicketMessage, type InsertTicketMessage,
  type TicketActivity, type InsertTicketActivity,
  type TicketAttachment, type InsertTicketAttachment,
  type CannedResponse, type InsertCannedResponse,
  type EmailTemplate, type InsertEmailTemplate,
  type TicketFilter, type InsertTicketFilter,
  type TicketSettings, type InsertTicketSettings,
  APPOINTMENT_ACTIVE_STATUSES,
} from "@shared/schema";
import { db } from "./db";
import { eq, ne, desc, and, gte, lte, lt, gt, or, ilike, inArray, sql } from "drizzle-orm";

export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Devices
  getDevices(): Promise<Device[]>;
  getDevice(id: number): Promise<Device | undefined>;
  createDevice(device: InsertDevice): Promise<Device>;
  updateDevice(id: number, device: Partial<Device>): Promise<Device | undefined>;
  deleteDevice(id: number): Promise<boolean>;
  
  // Alerts
  getAlerts(): Promise<Alert[]>;
  getActiveAlerts(): Promise<Alert[]>;
  getAlert(id: number): Promise<Alert | undefined>;
  getAlertsBySource(source: string, limit?: number): Promise<Alert[]>;
  createAlert(alert: InsertAlert): Promise<Alert>;
  updateAlert(id: number, alert: Partial<Alert>): Promise<Alert | undefined>;
  
  // Tickets
  getTickets(): Promise<Ticket[]>;
  getOpenTickets(): Promise<Ticket[]>;
  getTicket(id: number): Promise<Ticket | undefined>;
  createTicket(ticket: InsertTicket): Promise<Ticket>;
  updateTicket(id: number, ticket: Partial<Ticket>): Promise<Ticket | undefined>;
  
  // Clients
  getClients(): Promise<Client[]>;
  getClient(id: number): Promise<Client | undefined>;
  createClient(client: InsertClient): Promise<Client>;
  updateClient(id: number, client: Partial<Client>): Promise<Client | undefined>;
  deleteClient(id: number): Promise<boolean>;

  // Emergency Contacts
  getEmergencyContacts(clientId?: number): Promise<EmergencyContact[]>;
  getEmergencyContact(id: number): Promise<EmergencyContact | undefined>;
  createEmergencyContact(c: InsertEmergencyContact): Promise<EmergencyContact>;
  updateEmergencyContact(id: number, c: Partial<EmergencyContact>): Promise<EmergencyContact | undefined>;
  deleteEmergencyContact(id: number): Promise<boolean>;

  // Helpdesk Integrations
  getHelpdeskIntegrations(clientId?: number): Promise<HelpdeskIntegration[]>;
  getHelpdeskIntegration(id: number): Promise<HelpdeskIntegration | undefined>;
  createHelpdeskIntegration(i: InsertHelpdeskIntegration): Promise<HelpdeskIntegration>;
  updateHelpdeskIntegration(id: number, i: Partial<HelpdeskIntegration>): Promise<HelpdeskIntegration | undefined>;
  deleteHelpdeskIntegration(id: number): Promise<boolean>;

  // Patch Management
  getPatchPolicies(): Promise<PatchPolicy[]>;
  getPatchPolicy(id: number): Promise<PatchPolicy | undefined>;
  createPatchPolicy(p: InsertPatchPolicy): Promise<PatchPolicy>;
  updatePatchPolicy(id: number, p: Partial<PatchPolicy>): Promise<PatchPolicy | undefined>;
  deletePatchPolicy(id: number): Promise<boolean>;
  getDevicePatches(opts?: { deviceId?: number; status?: string }): Promise<DevicePatch[]>;
  upsertDevicePatch(p: InsertDevicePatch): Promise<DevicePatch>;
  updateDevicePatch(id: number, p: Partial<DevicePatch>): Promise<DevicePatch | undefined>;
  createPatchJob(j: InsertPatchJob): Promise<PatchJob>;
  updatePatchJob(id: number, j: Partial<PatchJob>): Promise<PatchJob | undefined>;
  getPatchJobs(opts?: { status?: string }): Promise<PatchJob[]>;

  // Remote session recordings (subset of remote_access_sessions)
  getRemoteSessionRecordings(): Promise<RemoteAccessSession[]>;
  
  // Network Scans
  getNetworkScans(): Promise<NetworkScan[]>;
  createNetworkScan(scan: InsertNetworkScan): Promise<NetworkScan>;
  updateNetworkScan(id: number, scan: Partial<NetworkScan>): Promise<NetworkScan | undefined>;
  deleteNetworkScan(id: number): Promise<boolean>;
  
  // Automation Scripts
  getAutomationScripts(): Promise<AutomationScript[]>;
  getAutomationScript(id: number): Promise<AutomationScript | undefined>;
  createAutomationScript(script: InsertAutomationScript): Promise<AutomationScript>;
  updateAutomationScript(id: number, script: Partial<AutomationScript>): Promise<AutomationScript | undefined>;

  // Remote Access Sessions (MeshCentral + TeamViewer)
  createRemoteSession(session: InsertRemoteAccessSession): Promise<RemoteAccessSession>;
  endRemoteSession(id: number, update?: Partial<RemoteAccessSession>): Promise<RemoteAccessSession | undefined>;
  getActiveRemoteSessions(): Promise<RemoteAccessSession[]>;
  getRemoteSessionsByDevice(deviceId: number): Promise<RemoteAccessSession[]>;
  getRemoteSessionsBySource(sourceType: string, sourceId: number): Promise<RemoteAccessSession[]>;
  deleteRemoteSession(id: number): Promise<boolean>;

  // CSD Intake Records
  getCsdIntakes(): Promise<CsdIntakeRecord[]>;
  getCsdIntake(id: number): Promise<CsdIntakeRecord | undefined>;
  createCsdIntake(intake: InsertCsdIntake): Promise<CsdIntakeRecord>;
  updateCsdIntake(id: number, intake: Partial<CsdIntakeRecord>): Promise<CsdIntakeRecord | undefined>;
  getCsdIntakesByDateRange(startDate: Date, endDate: Date): Promise<CsdIntakeRecord[]>;
  getCsdIntakesBySource(source: string): Promise<CsdIntakeRecord[]>;
  deleteCsdIntake(id: number): Promise<boolean>;
  
  // CRM Contacts
  getCrmContacts(): Promise<CrmContact[]>;
  getCrmContact(id: number): Promise<CrmContact | undefined>;
  getCrmContactByPhoneOrEmail(phone: string | null, email: string | null): Promise<CrmContact | undefined>;
  getCrmContactByGoogleId(googleContactId: string): Promise<CrmContact | undefined>;
  createCrmContact(contact: InsertCrmContact): Promise<CrmContact>;
  updateCrmContact(id: number, contact: Partial<CrmContact>): Promise<CrmContact | undefined>;
  deleteCrmContact(id: number): Promise<boolean>;
  searchCrmContacts(query: string): Promise<CrmContact[]>;
  
  // CRM Leads
  getCrmLeads(): Promise<CrmLead[]>;
  getCrmLead(id: number): Promise<CrmLead | undefined>;
  createCrmLead(lead: InsertCrmLead): Promise<CrmLead>;
  updateCrmLead(id: number, lead: Partial<CrmLead>): Promise<CrmLead | undefined>;
  getCrmLeadsByStatus(status: string): Promise<CrmLead[]>;
  getCrmLeadsByContact(contactId: number): Promise<CrmLead[]>;

  // CRM Deals (sales pipeline)
  getCrmDeals(): Promise<CrmDeal[]>;
  getCrmDeal(id: number): Promise<CrmDeal | undefined>;
  createCrmDeal(deal: InsertCrmDeal): Promise<CrmDeal>;
  updateCrmDeal(id: number, deal: Partial<CrmDeal>): Promise<CrmDeal | undefined>;
  deleteCrmDeal(id: number): Promise<boolean>;
  getCrmDealsByStage(stage: string): Promise<CrmDeal[]>;
  getCrmDealsByContact(contactId: number): Promise<CrmDeal[]>;
  
  // CRM Jobs
  getCrmJobs(): Promise<CrmJob[]>;
  getCrmJob(id: number): Promise<CrmJob | undefined>;
  createCrmJob(job: InsertCrmJob): Promise<CrmJob>;
  updateCrmJob(id: number, job: Partial<CrmJob>): Promise<CrmJob | undefined>;
  getCrmJobsByStatus(status: string): Promise<CrmJob[]>;
  getCrmJobsByLead(leadId: number): Promise<CrmJob[]>;
  getNextJobNumber(): Promise<string>;
  
  // CRM Interactions
  getCrmInteractions(): Promise<CrmInteraction[]>;
  getCrmInteraction(id: number): Promise<CrmInteraction | undefined>;
  createCrmInteraction(interaction: InsertCrmInteraction): Promise<CrmInteraction>;
  getCrmInteractionsByContact(contactId: number): Promise<CrmInteraction[]>;
  getCrmInteractionsByLead(leadId: number): Promise<CrmInteraction[]>;
  getCrmInteractionsByJob(jobId: number): Promise<CrmInteraction[]>;
  
  // Service Logs
  getServiceLogs(): Promise<ServiceLog[]>;
  getServiceLog(id: number): Promise<ServiceLog | undefined>;
  createServiceLog(log: InsertServiceLog): Promise<ServiceLog>;
  updateServiceLog(id: number, log: Partial<ServiceLog>): Promise<ServiceLog | undefined>;
  getServiceLogsByContact(contactId: number): Promise<ServiceLog[]>;
  getServiceLogsByJob(jobId: number): Promise<ServiceLog[]>;
  deleteServiceLog(id: number): Promise<boolean>;

  // A2P Rejection Suggestions (staff-submitted plain-English fixes)
  createA2pRejectionSuggestion(s: InsertA2pRejectionSuggestion & { submittedBy?: string | null }): Promise<A2pRejectionSuggestion>;
  getPendingA2pRejectionSuggestionByReason(reasonText: string): Promise<A2pRejectionSuggestion | undefined>;
  getA2pRejectionSuggestions(opts?: { status?: string }): Promise<A2pRejectionSuggestion[]>;
  updateA2pRejectionSuggestion(id: number, update: Partial<A2pRejectionSuggestion>): Promise<A2pRejectionSuggestion | undefined>;

  // ARIA Conversations
  getAriaConversations(userId?: number): Promise<AriaConversation[]>;
  getAriaConversation(id: number): Promise<AriaConversation | undefined>;
  getAriaConversationBySession(sessionId: string): Promise<AriaConversation | undefined>;
  createAriaConversation(conversation: InsertAriaConversation): Promise<AriaConversation>;
  updateAriaConversation(id: number, update: Partial<AriaConversation>): Promise<AriaConversation | undefined>;
  deleteAriaConversation(id: number): Promise<boolean>;

  // ARIA Messages
  getAriaMessages(conversationId: number): Promise<AriaMessage[]>;
  createAriaMessage(message: InsertAriaMessage): Promise<AriaMessage>;

  // ===== BOOKING PLATFORM =====

  // Booking Resources (staff, rooms, equipment)
  getBookingResources(opts?: { activeOnly?: boolean }): Promise<BookingResource[]>;
  getBookingResource(id: number): Promise<BookingResource | undefined>;
  createBookingResource(resource: InsertBookingResource): Promise<BookingResource>;

  // Resource Tags
  getResourceTags(): Promise<ResourceTag[]>;
  getResourceTagBySlug(slug: string): Promise<ResourceTag | undefined>;
  createResourceTag(tag: InsertResourceTag): Promise<ResourceTag>;
  assignResourceTag(resourceId: number, tagId: number): Promise<void>;
  getResourceIdsByTag(tagId: number): Promise<number[]>;

  // Service Categories
  getServiceCategories(opts?: { activeOnly?: boolean }): Promise<ServiceCategory[]>;
  createServiceCategory(category: InsertServiceCategory): Promise<ServiceCategory>;

  // Services
  getServices(opts?: { publicOnly?: boolean }): Promise<Service[]>;
  getService(id: number): Promise<Service | undefined>;
  getServiceBySlug(slug: string): Promise<Service | undefined>;
  createService(service: InsertService): Promise<Service>;

  // Service Resource Requirements
  getServiceRequirements(serviceId: number): Promise<ServiceResourceRequirement[]>;
  createServiceRequirement(req: InsertServiceResourceRequirement): Promise<ServiceResourceRequirement>;

  // Business Hours
  getBusinessHoursForResource(resourceId: number): Promise<BusinessHours[]>;
  createBusinessHours(hours: InsertBusinessHours): Promise<BusinessHours>;

  // Time Off
  getResourceTimeOffInRange(resourceId: number, startsAt: Date, endsAt: Date): Promise<ResourceTimeOff[]>;

  // Holidays
  getHolidaysInRange(startDate: string, endDate: string): Promise<Holiday[]>;

  // Booking Slot Locks
  createBookingSlotLock(lock: InsertBookingSlotLock, resourceIds: number[]): Promise<BookingSlotLock>;
  getBookingSlotLockByToken(token: string): Promise<BookingSlotLock | undefined>;
  deleteBookingSlotLock(id: number): Promise<boolean>;
  sweepExpiredSlotLocks(): Promise<number>;
  getActiveLockResourceConflicts(resourceIds: number[], startsAt: Date, endsAt: Date, excludeLockId?: number): Promise<BookingSlotLockResource[]>;

  // Appointments
  createAppointment(appointment: InsertAppointment, resourceIds: { resourceId: number; requirementId?: number }[]): Promise<Appointment>;
  getAppointment(id: number): Promise<Appointment | undefined>;
  getAppointmentByReference(reference: string): Promise<Appointment | undefined>;
  getAppointments(opts?: { status?: string; from?: Date; to?: Date }): Promise<Appointment[]>;
  getActiveAppointmentResourceConflicts(resourceIds: number[], startsAt: Date, endsAt: Date): Promise<AppointmentResource[]>;

  // ===== HELPDESK =====
  // Ticket lookup helpers
  getTicketByNumber(ticketNumber: string): Promise<Ticket | undefined>;
  getTicketByEmailAndToken(email: string, accessToken: string): Promise<Ticket | undefined>;
  getOverdueTickets(): Promise<Ticket[]>;
  getNextTicketNumber(prefix: string): Promise<string>;

  // Departments
  getTicketDepartments(): Promise<TicketDepartment[]>;
  getTicketDepartment(id: number): Promise<TicketDepartment | undefined>;
  getDefaultTicketDepartment(): Promise<TicketDepartment | undefined>;
  createTicketDepartment(d: InsertTicketDepartment): Promise<TicketDepartment>;
  updateTicketDepartment(id: number, d: Partial<TicketDepartment>): Promise<TicketDepartment | undefined>;
  deleteTicketDepartment(id: number): Promise<boolean>;

  // Teams
  getTicketTeams(): Promise<TicketTeam[]>;
  getTicketTeam(id: number): Promise<TicketTeam | undefined>;
  createTicketTeam(t: InsertTicketTeam): Promise<TicketTeam>;
  updateTicketTeam(id: number, t: Partial<TicketTeam>): Promise<TicketTeam | undefined>;
  deleteTicketTeam(id: number): Promise<boolean>;
  getTicketTeamMembers(teamId: number): Promise<TicketTeamMember[]>;
  addTicketTeamMember(m: InsertTicketTeamMember): Promise<TicketTeamMember>;
  removeTicketTeamMember(teamId: number, userId: number): Promise<boolean>;

  // Help Topics
  getTicketHelpTopics(): Promise<TicketHelpTopic[]>;
  getTicketHelpTopic(id: number): Promise<TicketHelpTopic | undefined>;
  createTicketHelpTopic(t: InsertTicketHelpTopic): Promise<TicketHelpTopic>;
  updateTicketHelpTopic(id: number, t: Partial<TicketHelpTopic>): Promise<TicketHelpTopic | undefined>;
  deleteTicketHelpTopic(id: number): Promise<boolean>;

  // SLA Plans
  getSlaPlans(): Promise<SlaPlan[]>;
  getSlaPlan(id: number): Promise<SlaPlan | undefined>;
  createSlaPlan(p: InsertSlaPlan): Promise<SlaPlan>;
  updateSlaPlan(id: number, p: Partial<SlaPlan>): Promise<SlaPlan | undefined>;
  deleteSlaPlan(id: number): Promise<boolean>;

  // Messages / Notes
  getTicketMessages(ticketId: number, opts?: { includeInternal?: boolean }): Promise<TicketMessage[]>;
  createTicketMessage(m: InsertTicketMessage): Promise<TicketMessage>;

  // Activity log
  getTicketActivity(ticketId: number): Promise<TicketActivity[]>;
  createTicketActivity(a: InsertTicketActivity): Promise<TicketActivity>;

  // Attachments
  getTicketAttachments(ticketId: number): Promise<TicketAttachment[]>;
  createTicketAttachment(a: InsertTicketAttachment): Promise<TicketAttachment>;
  deleteTicketAttachment(id: number): Promise<boolean>;

  // Canned responses
  getCannedResponses(): Promise<CannedResponse[]>;
  getCannedResponse(id: number): Promise<CannedResponse | undefined>;
  createCannedResponse(c: InsertCannedResponse): Promise<CannedResponse>;
  updateCannedResponse(id: number, c: Partial<CannedResponse>): Promise<CannedResponse | undefined>;
  deleteCannedResponse(id: number): Promise<boolean>;

  // Email templates
  getEmailTemplates(): Promise<EmailTemplate[]>;
  getEmailTemplateByCode(code: string): Promise<EmailTemplate | undefined>;
  createEmailTemplate(t: InsertEmailTemplate): Promise<EmailTemplate>;
  updateEmailTemplate(id: number, t: Partial<EmailTemplate>): Promise<EmailTemplate | undefined>;
  deleteEmailTemplate(id: number): Promise<boolean>;

  // Filters
  getTicketFilters(): Promise<TicketFilter[]>;
  getTicketFilter(id: number): Promise<TicketFilter | undefined>;
  createTicketFilter(f: InsertTicketFilter): Promise<TicketFilter>;
  updateTicketFilter(id: number, f: Partial<TicketFilter>): Promise<TicketFilter | undefined>;
  deleteTicketFilter(id: number): Promise<boolean>;

  // Settings
  getTicketSettings(): Promise<TicketSettings | undefined>;
  updateTicketSettings(s: Partial<TicketSettings>): Promise<TicketSettings>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User> = new Map();
  private devices: Map<number, Device> = new Map();
  private alerts: Map<number, Alert> = new Map();
  private tickets: Map<number, Ticket> = new Map();
  private clients: Map<number, Client> = new Map();
  private networkScans: Map<number, NetworkScan> = new Map();
  private automationScripts: Map<number, AutomationScript> = new Map();
  private crmContactsMap: Map<number, CrmContact> = new Map();
  private crmLeadsMap: Map<number, CrmLead> = new Map();
  private crmDealsMap: Map<number, CrmDeal> = new Map();
  private crmJobsMap: Map<number, CrmJob> = new Map();
  private crmInteractionsMap: Map<number, CrmInteraction> = new Map();
  private serviceLogsMap: Map<number, ServiceLog> = new Map();
  
  private currentUserId = 1;
  private currentDeviceId = 1;
  private currentAlertId = 1;
  private currentTicketId = 1;
  private currentClientId = 1;
  private currentNetworkScanId = 1;
  private currentAutomationScriptId = 1;
  private currentCrmContactId = 1;
  private currentCrmLeadId = 1;
  private currentCrmDealId = 1;
  private currentCrmJobId = 1;
  private currentServiceLogId = 1;
  private currentCrmInteractionId = 1;
  private currentJobNumber = 1;

  constructor() {
    this.initializeData();
  }

  private initializeData() {
    // Initialize some sample data for the platform
    const now = new Date();
    
    // Create clients with all required fields
    const client1: Client = {
      id: this.currentClientId++,
      name: "Fort Lauderdale Legal Associates",
      contactEmail: "admin@fllegal.com",
      contactPhone: "954-555-0123",
      address: "123 Las Olas Blvd",
      city: "Fort Lauderdale",
      state: "FL",
      zipCode: "33301",
      createdAt: now,
      emergencyContactPhone: null,
      emergencyContactEmail: null,
      businessHours: null,
      timezone: null,
      criticalSystems: null,
      slaLevel: null,
      responseTimeMinutes: null,
      emergencyResponseEnabled: null,
      region: null,
      county: null,
      meshGroupId: null,
    };

    const client2: Client = {
      id: this.currentClientId++,
      name: "Coral Springs Medical Center",
      contactEmail: "it@csmedical.com",
      contactPhone: "954-555-0456",
      address: "456 University Dr",
      city: "Coral Springs",
      state: "FL",
      zipCode: "33071",
      createdAt: now,
      emergencyContactPhone: null,
      emergencyContactEmail: null,
      businessHours: null,
      timezone: null,
      criticalSystems: null,
      slaLevel: null,
      responseTimeMinutes: null,
      emergencyResponseEnabled: null,
      region: null,
      county: null,
      meshGroupId: null,
    };

    this.clients.set(client1.id, client1);
    this.clients.set(client2.id, client2);
    
    // Create devices with all required fields
    const devices: Device[] = [
      {
        id: this.currentDeviceId++,
        name: "SERVER-DC01",
        type: "server",
        status: "warning",
        ipAddress: "192.168.1.10",
        macAddress: "00:1B:44:11:3A:B7",
        operatingSystem: "Windows Server 2019",
        lastSeen: now,
        cpuUsage: 95,
        memoryUsage: 78,
        diskUsage: 65,
        clientId: client1.id,
        createdAt: now,
        meshId: null,
        meshNodeId: null,
        remoteAccessEnabled: false,
        teamviewerId: null,
        teamviewerAlias: null,
        preferredRemoteProvider: "meshcentral",
        networkLatency: null,
        uptimeHours: null,
        antivirusStatus: null,
        firewallStatus: null,
        patchStatus: "current",
        backupStatus: "unknown",
        lastBackup: null,
      },
      {
        id: this.currentDeviceId++,
        name: "WS-ACCOUNTING",
        type: "workstation",
        status: "warning",
        ipAddress: "192.168.1.25",
        macAddress: "00:1B:44:11:3A:C8",
        operatingSystem: "Windows 10 Pro",
        lastSeen: now,
        cpuUsage: 45,
        memoryUsage: 82,
        diskUsage: 92,
        clientId: client1.id,
        createdAt: now,
        meshId: null,
        meshNodeId: null,
        remoteAccessEnabled: false,
        teamviewerId: null,
        teamviewerAlias: null,
        preferredRemoteProvider: "meshcentral",
        networkLatency: null,
        uptimeHours: null,
        antivirusStatus: null,
        firewallStatus: null,
        patchStatus: "current",
        backupStatus: "unknown",
        lastBackup: null,
      },
      {
        id: this.currentDeviceId++,
        name: "LT-RECEPTION",
        type: "laptop",
        status: "online",
        ipAddress: "192.168.1.35",
        macAddress: "00:1B:44:11:3A:D9",
        operatingSystem: "Windows 10 Home",
        lastSeen: now,
        cpuUsage: 25,
        memoryUsage: 45,
        diskUsage: 55,
        clientId: client2.id,
        createdAt: now,
        meshId: null,
        meshNodeId: null,
        remoteAccessEnabled: false,
        teamviewerId: null,
        teamviewerAlias: null,
        preferredRemoteProvider: "meshcentral",
        networkLatency: null,
        uptimeHours: null,
        antivirusStatus: null,
        firewallStatus: null,
        patchStatus: "current",
        backupStatus: "unknown",
        lastBackup: null,
      },
    ];
    
    devices.forEach(device => this.devices.set(device.id, device));
    
    // Create alerts with all required fields
    const alerts: Alert[] = [
      {
        id: this.currentAlertId++,
        title: "High CPU Usage Detected",
        description: "Server-DC01 CPU usage at 95% for 5+ minutes",
        severity: "critical",
        deviceId: devices[0].id,
        status: "active",
        createdAt: new Date(now.getTime() - 2 * 60 * 1000),
        resolvedAt: null,
        clientId: client1.id,
        category: null,
        isEmergency: false,
        emergencyNotificationSent: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
        alertSource: "system",
        affectedServices: null,
        estimatedDowntime: null,
        businessImpact: null,
      },
      {
        id: this.currentAlertId++,
        title: "Low Disk Space Warning",
        description: "WS-ACCOUNTING disk C: only 8% free space remaining",
        severity: "warning",
        deviceId: devices[1].id,
        status: "active",
        createdAt: new Date(now.getTime() - 15 * 60 * 1000),
        resolvedAt: null,
        clientId: client1.id,
        category: null,
        isEmergency: false,
        emergencyNotificationSent: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
        alertSource: "system",
        affectedServices: null,
        estimatedDowntime: null,
        businessImpact: null,
      },
    ];
    
    alerts.forEach(alert => this.alerts.set(alert.id, alert));
    
    // Create tickets
    const tickets: Ticket[] = [
      {
        id: this.currentTicketId++,
        subject: "Email server down at Downtown Law Firm",
        description: "Email server experiencing connectivity issues",
        priority: "high",
        status: "in-progress",
        clientId: client1.id,
        assignedTo: null,
        ticketNumber: null,
        accessToken: null,
        requesterName: null,
        requesterEmail: null,
        requesterPhone: null,
        source: null,
        departmentId: null,
        teamId: null,
        helpTopicId: null,
        slaPlanId: null,
        dueAt: null,
        slaDueAt: null,
        firstResponseAt: null,
        lockedBy: null,
        lockedAt: null,
        overdueAlertSent: false,
        closedAt: null,
        createdAt: new Date(now.getTime() - 25 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 25 * 60 * 1000),
        gate1EnvironmentRecon: null,
        gate2ResourceExhaustion: null,
        gate3ThreatPerimeter: null,
        gate4ThermalPowerAudit: null,
        gate5OptimizationStrike: null,
        gate6ResilienceTest: null,
        gate7SecureHandover: null,
        diagnosticComplete: false,
        associatedDealId: null,
      },
      {
        id: this.currentTicketId++,
        subject: "Slow computer performance issues",
        description: "Multiple workstations experiencing slow performance",
        priority: "medium",
        status: "open",
        clientId: client2.id,
        assignedTo: null,
        ticketNumber: null,
        accessToken: null,
        requesterName: null,
        requesterEmail: null,
        requesterPhone: null,
        source: null,
        departmentId: null,
        teamId: null,
        helpTopicId: null,
        slaPlanId: null,
        dueAt: null,
        slaDueAt: null,
        firstResponseAt: null,
        lockedBy: null,
        lockedAt: null,
        overdueAlertSent: false,
        closedAt: null,
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
        gate1EnvironmentRecon: null,
        gate2ResourceExhaustion: null,
        gate3ThreatPerimeter: null,
        gate4ThermalPowerAudit: null,
        gate5OptimizationStrike: null,
        gate6ResilienceTest: null,
        gate7SecureHandover: null,
        diagnosticComplete: false,
        associatedDealId: null,
      },
    ];
    
    tickets.forEach(ticket => this.tickets.set(ticket.id, ticket));
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const user: User = {
      ...insertUser,
      id: this.currentUserId++,
      role: insertUser.role || "user",
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  // Device methods
  async getDevices(): Promise<Device[]> {
    return Array.from(this.devices.values());
  }

  async getDevice(id: number): Promise<Device | undefined> {
    return this.devices.get(id);
  }

  async createDevice(insertDevice: InsertDevice): Promise<Device> {
    const device: Device = {
      ...insertDevice,
      id: this.currentDeviceId++,
      status: insertDevice.status || "offline",
      ipAddress: insertDevice.ipAddress ?? null,
      macAddress: insertDevice.macAddress ?? null,
      operatingSystem: insertDevice.operatingSystem ?? null,
      cpuUsage: insertDevice.cpuUsage ?? null,
      memoryUsage: insertDevice.memoryUsage ?? null,
      diskUsage: insertDevice.diskUsage ?? null,
      clientId: insertDevice.clientId ?? null,
      createdAt: new Date(),
      lastSeen: new Date(),
      meshId: insertDevice.meshId ?? null,
      meshNodeId: insertDevice.meshNodeId ?? null,
      lastBackup: insertDevice.lastBackup ?? null,
      remoteAccessEnabled: insertDevice.remoteAccessEnabled ?? false,
      teamviewerId: insertDevice.teamviewerId ?? null,
      teamviewerAlias: insertDevice.teamviewerAlias ?? null,
      preferredRemoteProvider: insertDevice.preferredRemoteProvider ?? "meshcentral",
      networkLatency: insertDevice.networkLatency ?? null,
      uptimeHours: insertDevice.uptimeHours ?? null,
      antivirusStatus: insertDevice.antivirusStatus ?? null,
      firewallStatus: insertDevice.firewallStatus ?? null,
      patchStatus: insertDevice.patchStatus ?? "current",
      backupStatus: insertDevice.backupStatus ?? "unknown",
    };
    this.devices.set(device.id, device);
    return device;
  }

  async updateDevice(id: number, update: Partial<Device>): Promise<Device | undefined> {
    const device = this.devices.get(id);
    if (!device) return undefined;
    
    const updatedDevice = { ...device, ...update };
    this.devices.set(id, updatedDevice);
    return updatedDevice;
  }

  async deleteDevice(id: number): Promise<boolean> {
    return this.devices.delete(id);
  }

  // Alert methods
  async getAlerts(): Promise<Alert[]> {
    return Array.from(this.alerts.values());
  }

  async getActiveAlerts(): Promise<Alert[]> {
    return Array.from(this.alerts.values()).filter(alert => alert.status === "active");
  }

  async getAlert(id: number): Promise<Alert | undefined> {
    return this.alerts.get(id);
  }

  async getAlertsBySource(source: string, limit?: number): Promise<Alert[]> {
    const list = Array.from(this.alerts.values())
      .filter((a) => (a.alertSource ?? "system") === source)
      .sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      });
    return typeof limit === "number" ? list.slice(0, limit) : list;
  }

  async createAlert(insertAlert: InsertAlert): Promise<Alert> {
    const alert: Alert = {
      ...insertAlert,
      id: this.currentAlertId++,
      status: insertAlert.status || "active",
      description: insertAlert.description || null,
      category: insertAlert.category ?? null,
      deviceId: insertAlert.deviceId ?? null,
      clientId: insertAlert.clientId ?? null,
      isEmergency: insertAlert.isEmergency ?? false,
      emergencyNotificationSent: insertAlert.emergencyNotificationSent ?? false,
      acknowledgedBy: insertAlert.acknowledgedBy ?? null,
      acknowledgedAt: insertAlert.acknowledgedAt ?? null,
      alertSource: insertAlert.alertSource ?? "system",
      affectedServices: insertAlert.affectedServices ?? null,
      estimatedDowntime: insertAlert.estimatedDowntime ?? null,
      businessImpact: insertAlert.businessImpact ?? null,
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  async updateAlert(id: number, update: Partial<Alert>): Promise<Alert | undefined> {
    const alert = this.alerts.get(id);
    if (!alert) return undefined;
    
    const updatedAlert = { ...alert, ...update };
    this.alerts.set(id, updatedAlert);
    return updatedAlert;
  }

  // Ticket methods
  async getTickets(): Promise<Ticket[]> {
    return Array.from(this.tickets.values());
  }

  async getOpenTickets(): Promise<Ticket[]> {
    return Array.from(this.tickets.values()).filter(
      ticket => ticket.status === "open" || ticket.status === "in-progress"
    );
  }

  async getTicket(id: number): Promise<Ticket | undefined> {
    return this.tickets.get(id);
  }

  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    const ticket: Ticket = {
      ...insertTicket,
      id: this.currentTicketId++,
      status: insertTicket.status || "open",
      description: insertTicket.description || null,
      clientId: insertTicket.clientId ?? null,
      assignedTo: insertTicket.assignedTo ?? null,
      ticketNumber: insertTicket.ticketNumber ?? null,
      accessToken: insertTicket.accessToken ?? null,
      requesterName: insertTicket.requesterName ?? null,
      requesterEmail: insertTicket.requesterEmail ?? null,
      requesterPhone: insertTicket.requesterPhone ?? null,
      source: insertTicket.source ?? null,
      departmentId: insertTicket.departmentId ?? null,
      teamId: insertTicket.teamId ?? null,
      helpTopicId: insertTicket.helpTopicId ?? null,
      slaPlanId: insertTicket.slaPlanId ?? null,
      dueAt: insertTicket.dueAt ?? null,
      slaDueAt: insertTicket.slaDueAt ?? null,
      firstResponseAt: insertTicket.firstResponseAt ?? null,
      lockedBy: insertTicket.lockedBy ?? null,
      lockedAt: insertTicket.lockedAt ?? null,
      overdueAlertSent: insertTicket.overdueAlertSent ?? false,
      closedAt: insertTicket.closedAt ?? null,
      gate1EnvironmentRecon: insertTicket.gate1EnvironmentRecon ?? null,
      gate2ResourceExhaustion: insertTicket.gate2ResourceExhaustion ?? null,
      gate3ThreatPerimeter: insertTicket.gate3ThreatPerimeter ?? null,
      gate4ThermalPowerAudit: insertTicket.gate4ThermalPowerAudit ?? null,
      gate5OptimizationStrike: insertTicket.gate5OptimizationStrike ?? null,
      gate6ResilienceTest: insertTicket.gate6ResilienceTest ?? null,
      gate7SecureHandover: insertTicket.gate7SecureHandover ?? null,
      diagnosticComplete: insertTicket.diagnosticComplete ?? false,
      associatedDealId: insertTicket.associatedDealId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  async updateTicket(id: number, update: Partial<Ticket>): Promise<Ticket | undefined> {
    const ticket = this.tickets.get(id);
    if (!ticket) return undefined;
    
    const updatedTicket = { ...ticket, ...update, updatedAt: new Date() };
    this.tickets.set(id, updatedTicket);
    return updatedTicket;
  }

  // Client methods
  async getClients(): Promise<Client[]> {
    return Array.from(this.clients.values());
  }

  async getClient(id: number): Promise<Client | undefined> {
    return this.clients.get(id);
  }

  async createClient(insertClient: InsertClient): Promise<Client> {
    const client: Client = {
      ...insertClient,
      id: this.currentClientId++,
      contactPhone: insertClient.contactPhone ?? null,
      emergencyContactPhone: insertClient.emergencyContactPhone ?? null,
      emergencyContactEmail: insertClient.emergencyContactEmail ?? null,
      address: insertClient.address ?? null,
      city: insertClient.city ?? null,
      state: insertClient.state ?? null,
      zipCode: insertClient.zipCode ?? null,
      businessHours: insertClient.businessHours ?? null,
      timezone: insertClient.timezone ?? null,
      criticalSystems: insertClient.criticalSystems ?? null,
      slaLevel: insertClient.slaLevel ?? null,
      responseTimeMinutes: insertClient.responseTimeMinutes ?? null,
      emergencyResponseEnabled: insertClient.emergencyResponseEnabled ?? null,
      region: insertClient.region ?? null,
      county: insertClient.county ?? null,
      meshGroupId: insertClient.meshGroupId ?? null,
      createdAt: new Date(),
    };
    this.clients.set(client.id, client);
    return client;
  }

  async updateClient(id: number, update: Partial<Client>): Promise<Client | undefined> {
    const client = this.clients.get(id);
    if (!client) return undefined;
    
    const updatedClient = { ...client, ...update };
    this.clients.set(id, updatedClient);
    return updatedClient;
  }

  // Network Scan methods
  async getNetworkScans(): Promise<NetworkScan[]> {
    return Array.from(this.networkScans.values());
  }

  async createNetworkScan(insertScan: InsertNetworkScan): Promise<NetworkScan> {
    const scan: NetworkScan = {
      ...insertScan,
      id: this.currentNetworkScanId++,
      status: insertScan.status || "pending",
      devicesFound: insertScan.devicesFound ?? null,
      createdAt: new Date(),
      completedAt: null,
    };
    this.networkScans.set(scan.id, scan);
    return scan;
  }

  async updateNetworkScan(id: number, update: Partial<NetworkScan>): Promise<NetworkScan | undefined> {
    const scan = this.networkScans.get(id);
    if (!scan) return undefined;
    
    const updatedScan = { ...scan, ...update };
    this.networkScans.set(id, updatedScan);
    return updatedScan;
  }

  async deleteNetworkScan(id: number): Promise<boolean> {
    return this.networkScans.delete(id);
  }

  // Automation Script methods
  async getAutomationScripts(): Promise<AutomationScript[]> {
    return Array.from(this.automationScripts.values());
  }

  async getAutomationScript(id: number): Promise<AutomationScript | undefined> {
    return this.automationScripts.get(id);
  }

  async createAutomationScript(insertScript: InsertAutomationScript): Promise<AutomationScript> {
    const script: AutomationScript = {
      ...insertScript,
      id: this.currentAutomationScriptId++,
      description: insertScript.description ?? null,
      isActive: insertScript.isActive ?? true,
      createdAt: new Date(),
    };
    this.automationScripts.set(script.id, script);
    return script;
  }

  async updateAutomationScript(id: number, update: Partial<AutomationScript>): Promise<AutomationScript | undefined> {
    const script = this.automationScripts.get(id);
    if (!script) return undefined;
    
    const updatedScript = { ...script, ...update };
    this.automationScripts.set(id, updatedScript);
    return updatedScript;
  }

  // CSD Intake stubs (MemStorage - use DatabaseStorage in production)
  async getCsdIntakes(): Promise<CsdIntakeRecord[]> { return []; }
  async getCsdIntake(_id: number): Promise<CsdIntakeRecord | undefined> { return undefined; }
  async createCsdIntake(_intake: InsertCsdIntake): Promise<CsdIntakeRecord> { throw new Error("Use DatabaseStorage"); }
  async updateCsdIntake(_id: number, _intake: Partial<CsdIntakeRecord>): Promise<CsdIntakeRecord | undefined> { return undefined; }
  async getCsdIntakesByDateRange(_start: Date, _end: Date): Promise<CsdIntakeRecord[]> { return []; }
  async getCsdIntakesBySource(_source: string): Promise<CsdIntakeRecord[]> { return []; }
  async deleteCsdIntake(_id: number): Promise<boolean> { return false; }

  // CRM Contacts
  async getCrmContacts(): Promise<CrmContact[]> { 
    return Array.from(this.crmContactsMap.values()); 
  }
  async getCrmContact(id: number): Promise<CrmContact | undefined> { 
    return this.crmContactsMap.get(id); 
  }
  async getCrmContactByPhoneOrEmail(phone: string | null, email: string | null): Promise<CrmContact | undefined> {
    return Array.from(this.crmContactsMap.values()).find(c => 
      (phone && c.mobilePhone === phone) || (email && c.email === email)
    );
  }
  async getCrmContactByGoogleId(googleContactId: string): Promise<CrmContact | undefined> {
    return Array.from(this.crmContactsMap.values()).find(c => c.googleContactId === googleContactId);
  }
  async createCrmContact(insertContact: InsertCrmContact): Promise<CrmContact> {
    const contact: CrmContact = {
      ...insertContact,
      id: this.currentCrmContactId++,
      mobilePhone: insertContact.mobilePhone ?? null,
      officePhone: insertContact.officePhone ?? null,
      email: insertContact.email ?? null,
      company: insertContact.company ?? null,
      contactPreference: insertContact.contactPreference ?? "email",
      address: insertContact.address ?? null,
      city: insertContact.city ?? null,
      state: insertContact.state ?? null,
      zipCode: insertContact.zipCode ?? null,
      notes: insertContact.notes ?? null,
      tags: insertContact.tags ?? null,
      googleContactId: insertContact.googleContactId ?? null,
      clientId: insertContact.clientId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.crmContactsMap.set(contact.id, contact);
    return contact;
  }
  async updateCrmContact(id: number, update: Partial<CrmContact>): Promise<CrmContact | undefined> {
    const contact = this.crmContactsMap.get(id);
    if (!contact) return undefined;
    const updated = { ...contact, ...update, updatedAt: new Date() };
    this.crmContactsMap.set(id, updated);
    return updated;
  }
  async deleteCrmContact(id: number): Promise<boolean> {
    return this.crmContactsMap.delete(id);
  }
  async searchCrmContacts(query: string): Promise<CrmContact[]> {
    const q = query.toLowerCase();
    return Array.from(this.crmContactsMap.values()).filter(c =>
      c.fullName.toLowerCase().includes(q) ||
      (c.mobilePhone && c.mobilePhone.includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q))
    );
  }

  // CRM Leads
  async getCrmLeads(): Promise<CrmLead[]> { 
    return Array.from(this.crmLeadsMap.values()); 
  }
  async getCrmLead(id: number): Promise<CrmLead | undefined> { 
    return this.crmLeadsMap.get(id); 
  }
  async createCrmLead(insertLead: InsertCrmLead): Promise<CrmLead> {
    const lead: CrmLead = {
      ...insertLead,
      id: this.currentCrmLeadId++,
      contactId: insertLead.contactId ?? null,
      source: insertLead.source ?? "website_intake",
      campaign: insertLead.campaign ?? null,
      deviceType: insertLead.deviceType ?? null,
      brandModel: insertLead.brandModel ?? null,
      operatingSystem: insertLead.operatingSystem ?? null,
      problemDescription: insertLead.problemDescription ?? null,
      callId: insertLead.callId ?? null,
      status: insertLead.status ?? "new",
      priority: insertLead.priority ?? "normal",
      assignedTo: insertLead.assignedTo ?? null,
      estimatedValue: insertLead.estimatedValue ?? null,
      notes: insertLead.notes ?? null,
      intakeRecordId: insertLead.intakeRecordId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.crmLeadsMap.set(lead.id, lead);
    return lead;
  }
  async updateCrmLead(id: number, update: Partial<CrmLead>): Promise<CrmLead | undefined> {
    const lead = this.crmLeadsMap.get(id);
    if (!lead) return undefined;
    const updated = { ...lead, ...update, updatedAt: new Date() };
    this.crmLeadsMap.set(id, updated);
    return updated;
  }
  async getCrmLeadsByStatus(status: string): Promise<CrmLead[]> {
    return Array.from(this.crmLeadsMap.values()).filter(l => l.status === status);
  }
  async getCrmLeadsByContact(contactId: number): Promise<CrmLead[]> {
    return Array.from(this.crmLeadsMap.values()).filter(l => l.contactId === contactId);
  }

  // CRM Deals
  async getCrmDeals(): Promise<CrmDeal[]> {
    return Array.from(this.crmDealsMap.values());
  }
  async getCrmDeal(id: number): Promise<CrmDeal | undefined> {
    return this.crmDealsMap.get(id);
  }
  async createCrmDeal(insertDeal: InsertCrmDeal): Promise<CrmDeal> {
    const deal: CrmDeal = {
      ...insertDeal,
      id: this.currentCrmDealId++,
      stage: insertDeal.stage ?? "lead",
      estimatedMrr: insertDeal.estimatedMrr ?? "0",
      oneTimeFee: insertDeal.oneTimeFee ?? "0",
      primaryContactId: insertDeal.primaryContactId ?? null,
      leadId: insertDeal.leadId ?? null,
      assignedTechnicianId: insertDeal.assignedTechnicianId ?? null,
      notes: insertDeal.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.crmDealsMap.set(deal.id, deal);
    return deal;
  }
  async updateCrmDeal(id: number, update: Partial<CrmDeal>): Promise<CrmDeal | undefined> {
    const deal = this.crmDealsMap.get(id);
    if (!deal) return undefined;
    const updated = { ...deal, ...update, updatedAt: new Date() };
    this.crmDealsMap.set(id, updated);
    return updated;
  }
  async deleteCrmDeal(id: number): Promise<boolean> {
    return this.crmDealsMap.delete(id);
  }
  async getCrmDealsByStage(stage: string): Promise<CrmDeal[]> {
    return Array.from(this.crmDealsMap.values()).filter(d => d.stage === stage);
  }
  async getCrmDealsByContact(contactId: number): Promise<CrmDeal[]> {
    return Array.from(this.crmDealsMap.values()).filter(d => d.primaryContactId === contactId);
  }

  // CRM Jobs
  async getCrmJobs(): Promise<CrmJob[]> { 
    return Array.from(this.crmJobsMap.values()); 
  }
  async getCrmJob(id: number): Promise<CrmJob | undefined> { 
    return this.crmJobsMap.get(id); 
  }
  async createCrmJob(insertJob: InsertCrmJob): Promise<CrmJob> {
    const job: CrmJob = {
      ...insertJob,
      id: this.currentCrmJobId++,
      leadId: insertJob.leadId ?? null,
      contactId: insertJob.contactId ?? null,
      serviceType: insertJob.serviceType ?? "computer_repair",
      jobType: insertJob.jobType ?? "drop_off",
      priority: insertJob.priority ?? "normal",
      status: insertJob.status ?? "open",
      description: insertJob.description ?? null,
      notes: insertJob.notes ?? null,
      scheduledDateTime: insertJob.scheduledDateTime ?? null,
      completedDateTime: null,
      estimatedAmount: insertJob.estimatedAmount ?? null,
      finalAmount: insertJob.finalAmount ?? null,
      technicianNotes: insertJob.technicianNotes ?? null,
      assignedTo: insertJob.assignedTo ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.crmJobsMap.set(job.id, job);
    return job;
  }
  async updateCrmJob(id: number, update: Partial<CrmJob>): Promise<CrmJob | undefined> {
    const job = this.crmJobsMap.get(id);
    if (!job) return undefined;
    const updated = { ...job, ...update, updatedAt: new Date() };
    this.crmJobsMap.set(id, updated);
    return updated;
  }
  async getCrmJobsByStatus(status: string): Promise<CrmJob[]> {
    return Array.from(this.crmJobsMap.values()).filter(j => j.status === status);
  }
  async getCrmJobsByLead(leadId: number): Promise<CrmJob[]> {
    return Array.from(this.crmJobsMap.values()).filter(j => j.leadId === leadId);
  }
  async getNextJobNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const num = this.currentJobNumber++;
    return `CSD-${year}-${num.toString().padStart(4, '0')}`;
  }

  // CRM Interactions
  async getCrmInteractions(): Promise<CrmInteraction[]> { 
    return Array.from(this.crmInteractionsMap.values()); 
  }
  async getCrmInteraction(id: number): Promise<CrmInteraction | undefined> { 
    return this.crmInteractionsMap.get(id); 
  }
  async createCrmInteraction(insertInteraction: InsertCrmInteraction): Promise<CrmInteraction> {
    const interaction: CrmInteraction = {
      ...insertInteraction,
      id: this.currentCrmInteractionId++,
      contactId: insertInteraction.contactId ?? null,
      leadId: insertInteraction.leadId ?? null,
      jobId: insertInteraction.jobId ?? null,
      details: insertInteraction.details ?? null,
      performedBy: insertInteraction.performedBy ?? null,
      createdAt: new Date(),
    };
    this.crmInteractionsMap.set(interaction.id, interaction);
    return interaction;
  }
  async getCrmInteractionsByContact(contactId: number): Promise<CrmInteraction[]> {
    return Array.from(this.crmInteractionsMap.values()).filter(i => i.contactId === contactId);
  }
  async getCrmInteractionsByLead(leadId: number): Promise<CrmInteraction[]> {
    return Array.from(this.crmInteractionsMap.values()).filter(i => i.leadId === leadId);
  }
  async getCrmInteractionsByJob(jobId: number): Promise<CrmInteraction[]> {
    return Array.from(this.crmInteractionsMap.values()).filter(i => i.jobId === jobId);
  }
  
  // Service Logs
  async getServiceLogs(): Promise<ServiceLog[]> {
    return Array.from(this.serviceLogsMap.values()).sort((a, b) => 
      new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()
    );
  }
  
  async getServiceLog(id: number): Promise<ServiceLog | undefined> {
    return this.serviceLogsMap.get(id);
  }
  
  async createServiceLog(log: InsertServiceLog): Promise<ServiceLog> {
    const id = this.currentServiceLogId++;
    const now = new Date();
    const serviceLogRecord: ServiceLog = {
      ...log,
      id,
      contactId: log.contactId ?? null,
      jobId: log.jobId ?? null,
      hardwareAction: log.hardwareAction ?? null,
      hardwareResult: log.hardwareResult ?? null,
      securityAction: log.securityAction ?? null,
      securityResult: log.securityResult ?? null,
      optimizationAction: log.optimizationAction ?? null,
      optimizationResult: log.optimizationResult ?? null,
      gate1EnvironmentRecon: log.gate1EnvironmentRecon ?? null,
      gate2ResourceExhaustion: log.gate2ResourceExhaustion ?? null,
      gate3ThreatPerimeter: log.gate3ThreatPerimeter ?? null,
      gate4ThermalPowerAudit: log.gate4ThermalPowerAudit ?? null,
      gate5OptimizationStrike: log.gate5OptimizationStrike ?? null,
      gate6ResilienceTest: log.gate6ResilienceTest ?? null,
      gate7SecureHandover: log.gate7SecureHandover ?? null,
      securityHardened: log.securityHardened ?? false,
      googleContactSynced: log.googleContactSynced ?? false,
      technicianNotes: log.technicianNotes ?? null,
      performedBy: log.performedBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.serviceLogsMap.set(id, serviceLogRecord);
    return serviceLogRecord;
  }
  
  async updateServiceLog(id: number, log: Partial<ServiceLog>): Promise<ServiceLog | undefined> {
    const existing = this.serviceLogsMap.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...log, updatedAt: new Date() };
    this.serviceLogsMap.set(id, updated);
    return updated;
  }
  
  async getServiceLogsByContact(contactId: number): Promise<ServiceLog[]> {
    return Array.from(this.serviceLogsMap.values()).filter(l => l.contactId === contactId);
  }
  
  async getServiceLogsByJob(jobId: number): Promise<ServiceLog[]> {
    return Array.from(this.serviceLogsMap.values()).filter(l => l.jobId === jobId);
  }

  async deleteServiceLog(id: number): Promise<boolean> {
    return this.serviceLogsMap.delete(id);
  }

  // A2P rejection suggestion stubs (MemStorage - use DatabaseStorage in production)
  async createA2pRejectionSuggestion(_s: InsertA2pRejectionSuggestion & { submittedBy?: string | null }): Promise<A2pRejectionSuggestion> { throw new Error("Use DatabaseStorage"); }
  async getPendingA2pRejectionSuggestionByReason(_reasonText: string): Promise<A2pRejectionSuggestion | undefined> { return undefined; }
  async getA2pRejectionSuggestions(_opts?: { status?: string }): Promise<A2pRejectionSuggestion[]> { return []; }
  async updateA2pRejectionSuggestion(_id: number, _u: Partial<A2pRejectionSuggestion>): Promise<A2pRejectionSuggestion | undefined> { return undefined; }

  // ARIA stubs (MemStorage - use DatabaseStorage in production)
  async getAriaConversations(_userId?: number): Promise<AriaConversation[]> { return []; }
  async getAriaConversation(_id: number): Promise<AriaConversation | undefined> { return undefined; }
  async getAriaConversationBySession(_sessionId: string): Promise<AriaConversation | undefined> { return undefined; }
  async createAriaConversation(_conversation: InsertAriaConversation): Promise<AriaConversation> { throw new Error("Use DatabaseStorage"); }
  async updateAriaConversation(_id: number, _update: Partial<AriaConversation>): Promise<AriaConversation | undefined> { return undefined; }
  async deleteAriaConversation(_id: number): Promise<boolean> { return false; }
  async getAriaMessages(_conversationId: number): Promise<AriaMessage[]> { return []; }
  async createAriaMessage(_message: InsertAriaMessage): Promise<AriaMessage> { throw new Error("Use DatabaseStorage"); }

  // Booking platform stubs (MemStorage - use DatabaseStorage in production)
  async getBookingResources(): Promise<BookingResource[]> { throw new Error("Use DatabaseStorage"); }
  async getBookingResource(_id: number): Promise<BookingResource | undefined> { throw new Error("Use DatabaseStorage"); }
  async createBookingResource(_r: InsertBookingResource): Promise<BookingResource> { throw new Error("Use DatabaseStorage"); }
  async getResourceTags(): Promise<ResourceTag[]> { throw new Error("Use DatabaseStorage"); }
  async getResourceTagBySlug(_s: string): Promise<ResourceTag | undefined> { throw new Error("Use DatabaseStorage"); }
  async createResourceTag(_t: InsertResourceTag): Promise<ResourceTag> { throw new Error("Use DatabaseStorage"); }
  async assignResourceTag(_r: number, _t: number): Promise<void> { throw new Error("Use DatabaseStorage"); }
  async getResourceIdsByTag(_t: number): Promise<number[]> { throw new Error("Use DatabaseStorage"); }
  async getServiceCategories(): Promise<ServiceCategory[]> { throw new Error("Use DatabaseStorage"); }
  async createServiceCategory(_c: InsertServiceCategory): Promise<ServiceCategory> { throw new Error("Use DatabaseStorage"); }
  async getServices(): Promise<Service[]> { throw new Error("Use DatabaseStorage"); }
  async getService(_id: number): Promise<Service | undefined> { throw new Error("Use DatabaseStorage"); }
  async getServiceBySlug(_s: string): Promise<Service | undefined> { throw new Error("Use DatabaseStorage"); }
  async createService(_s: InsertService): Promise<Service> { throw new Error("Use DatabaseStorage"); }
  async getServiceRequirements(_s: number): Promise<ServiceResourceRequirement[]> { throw new Error("Use DatabaseStorage"); }
  async createServiceRequirement(_r: InsertServiceResourceRequirement): Promise<ServiceResourceRequirement> { throw new Error("Use DatabaseStorage"); }
  async getBusinessHoursForResource(_r: number): Promise<BusinessHours[]> { throw new Error("Use DatabaseStorage"); }
  async createBusinessHours(_h: InsertBusinessHours): Promise<BusinessHours> { throw new Error("Use DatabaseStorage"); }
  async getResourceTimeOffInRange(_r: number, _s: Date, _e: Date): Promise<ResourceTimeOff[]> { throw new Error("Use DatabaseStorage"); }
  async getHolidaysInRange(_s: string, _e: string): Promise<Holiday[]> { throw new Error("Use DatabaseStorage"); }
  async createRemoteSession(_s: InsertRemoteAccessSession): Promise<RemoteAccessSession> { throw new Error("Use DatabaseStorage"); }
  async endRemoteSession(_id: number, _u?: Partial<RemoteAccessSession>): Promise<RemoteAccessSession | undefined> { throw new Error("Use DatabaseStorage"); }
  async getActiveRemoteSessions(): Promise<RemoteAccessSession[]> { throw new Error("Use DatabaseStorage"); }
  async getRemoteSessionsByDevice(_id: number): Promise<RemoteAccessSession[]> { throw new Error("Use DatabaseStorage"); }
  async getRemoteSessionsBySource(_t: string, _id: number): Promise<RemoteAccessSession[]> { throw new Error("Use DatabaseStorage"); }
  async getRemoteSessionRecordings(): Promise<RemoteAccessSession[]> { throw new Error("Use DatabaseStorage"); }
  async deleteRemoteSession(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async deleteClient(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getEmergencyContacts(_id?: number): Promise<EmergencyContact[]> { throw new Error("Use DatabaseStorage"); }
  async getEmergencyContact(_id: number): Promise<EmergencyContact | undefined> { throw new Error("Use DatabaseStorage"); }
  async createEmergencyContact(_c: InsertEmergencyContact): Promise<EmergencyContact> { throw new Error("Use DatabaseStorage"); }
  async updateEmergencyContact(_id: number, _c: Partial<EmergencyContact>): Promise<EmergencyContact | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteEmergencyContact(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getHelpdeskIntegrations(_id?: number): Promise<HelpdeskIntegration[]> { throw new Error("Use DatabaseStorage"); }
  async getHelpdeskIntegration(_id: number): Promise<HelpdeskIntegration | undefined> { throw new Error("Use DatabaseStorage"); }
  async createHelpdeskIntegration(_i: InsertHelpdeskIntegration): Promise<HelpdeskIntegration> { throw new Error("Use DatabaseStorage"); }
  async updateHelpdeskIntegration(_id: number, _i: Partial<HelpdeskIntegration>): Promise<HelpdeskIntegration | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteHelpdeskIntegration(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getPatchPolicies(): Promise<PatchPolicy[]> { throw new Error("Use DatabaseStorage"); }
  async getPatchPolicy(_id: number): Promise<PatchPolicy | undefined> { throw new Error("Use DatabaseStorage"); }
  async createPatchPolicy(_p: InsertPatchPolicy): Promise<PatchPolicy> { throw new Error("Use DatabaseStorage"); }
  async updatePatchPolicy(_id: number, _p: Partial<PatchPolicy>): Promise<PatchPolicy | undefined> { throw new Error("Use DatabaseStorage"); }
  async deletePatchPolicy(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getDevicePatches(_opts?: { deviceId?: number; status?: string }): Promise<DevicePatch[]> { throw new Error("Use DatabaseStorage"); }
  async upsertDevicePatch(_p: InsertDevicePatch): Promise<DevicePatch> { throw new Error("Use DatabaseStorage"); }
  async updateDevicePatch(_id: number, _p: Partial<DevicePatch>): Promise<DevicePatch | undefined> { throw new Error("Use DatabaseStorage"); }
  async createPatchJob(_j: InsertPatchJob): Promise<PatchJob> { throw new Error("Use DatabaseStorage"); }
  async updatePatchJob(_id: number, _j: Partial<PatchJob>): Promise<PatchJob | undefined> { throw new Error("Use DatabaseStorage"); }
  async getPatchJobs(_opts?: { status?: string }): Promise<PatchJob[]> { throw new Error("Use DatabaseStorage"); }
  async createBookingSlotLock(_l: InsertBookingSlotLock, _r: number[]): Promise<BookingSlotLock> { throw new Error("Use DatabaseStorage"); }
  async getBookingSlotLockByToken(_t: string): Promise<BookingSlotLock | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteBookingSlotLock(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async sweepExpiredSlotLocks(): Promise<number> { throw new Error("Use DatabaseStorage"); }
  async getActiveLockResourceConflicts(_r: number[], _s: Date, _e: Date): Promise<BookingSlotLockResource[]> { throw new Error("Use DatabaseStorage"); }
  async createAppointment(_a: InsertAppointment, _r: { resourceId: number; requirementId?: number }[]): Promise<Appointment> { throw new Error("Use DatabaseStorage"); }
  async getAppointment(_id: number): Promise<Appointment | undefined> { throw new Error("Use DatabaseStorage"); }
  async getAppointmentByReference(_r: string): Promise<Appointment | undefined> { throw new Error("Use DatabaseStorage"); }
  async getAppointments(): Promise<Appointment[]> { throw new Error("Use DatabaseStorage"); }
  async getActiveAppointmentResourceConflicts(_r: number[], _s: Date, _e: Date): Promise<AppointmentResource[]> { throw new Error("Use DatabaseStorage"); }

  // Helpdesk stubs (MemStorage - use DatabaseStorage in production)
  async getTicketByNumber(_n: string): Promise<Ticket | undefined> { throw new Error("Use DatabaseStorage"); }
  async getTicketByEmailAndToken(_e: string, _t: string): Promise<Ticket | undefined> { throw new Error("Use DatabaseStorage"); }
  async getOverdueTickets(): Promise<Ticket[]> { throw new Error("Use DatabaseStorage"); }
  async getNextTicketNumber(_p: string): Promise<string> { throw new Error("Use DatabaseStorage"); }
  async getTicketDepartments(): Promise<TicketDepartment[]> { throw new Error("Use DatabaseStorage"); }
  async getTicketDepartment(_id: number): Promise<TicketDepartment | undefined> { throw new Error("Use DatabaseStorage"); }
  async getDefaultTicketDepartment(): Promise<TicketDepartment | undefined> { throw new Error("Use DatabaseStorage"); }
  async createTicketDepartment(_d: InsertTicketDepartment): Promise<TicketDepartment> { throw new Error("Use DatabaseStorage"); }
  async updateTicketDepartment(_id: number, _d: Partial<TicketDepartment>): Promise<TicketDepartment | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteTicketDepartment(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getTicketTeams(): Promise<TicketTeam[]> { throw new Error("Use DatabaseStorage"); }
  async getTicketTeam(_id: number): Promise<TicketTeam | undefined> { throw new Error("Use DatabaseStorage"); }
  async createTicketTeam(_t: InsertTicketTeam): Promise<TicketTeam> { throw new Error("Use DatabaseStorage"); }
  async updateTicketTeam(_id: number, _t: Partial<TicketTeam>): Promise<TicketTeam | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteTicketTeam(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getTicketTeamMembers(_id: number): Promise<TicketTeamMember[]> { throw new Error("Use DatabaseStorage"); }
  async addTicketTeamMember(_m: InsertTicketTeamMember): Promise<TicketTeamMember> { throw new Error("Use DatabaseStorage"); }
  async removeTicketTeamMember(_tid: number, _uid: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getTicketHelpTopics(): Promise<TicketHelpTopic[]> { throw new Error("Use DatabaseStorage"); }
  async getTicketHelpTopic(_id: number): Promise<TicketHelpTopic | undefined> { throw new Error("Use DatabaseStorage"); }
  async createTicketHelpTopic(_t: InsertTicketHelpTopic): Promise<TicketHelpTopic> { throw new Error("Use DatabaseStorage"); }
  async updateTicketHelpTopic(_id: number, _t: Partial<TicketHelpTopic>): Promise<TicketHelpTopic | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteTicketHelpTopic(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getSlaPlans(): Promise<SlaPlan[]> { throw new Error("Use DatabaseStorage"); }
  async getSlaPlan(_id: number): Promise<SlaPlan | undefined> { throw new Error("Use DatabaseStorage"); }
  async createSlaPlan(_p: InsertSlaPlan): Promise<SlaPlan> { throw new Error("Use DatabaseStorage"); }
  async updateSlaPlan(_id: number, _p: Partial<SlaPlan>): Promise<SlaPlan | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteSlaPlan(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getTicketMessages(_tid: number): Promise<TicketMessage[]> { throw new Error("Use DatabaseStorage"); }
  async createTicketMessage(_m: InsertTicketMessage): Promise<TicketMessage> { throw new Error("Use DatabaseStorage"); }
  async getTicketActivity(_tid: number): Promise<TicketActivity[]> { throw new Error("Use DatabaseStorage"); }
  async createTicketActivity(_a: InsertTicketActivity): Promise<TicketActivity> { throw new Error("Use DatabaseStorage"); }
  async getTicketAttachments(_tid: number): Promise<TicketAttachment[]> { throw new Error("Use DatabaseStorage"); }
  async createTicketAttachment(_a: InsertTicketAttachment): Promise<TicketAttachment> { throw new Error("Use DatabaseStorage"); }
  async deleteTicketAttachment(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getCannedResponses(): Promise<CannedResponse[]> { throw new Error("Use DatabaseStorage"); }
  async getCannedResponse(_id: number): Promise<CannedResponse | undefined> { throw new Error("Use DatabaseStorage"); }
  async createCannedResponse(_c: InsertCannedResponse): Promise<CannedResponse> { throw new Error("Use DatabaseStorage"); }
  async updateCannedResponse(_id: number, _c: Partial<CannedResponse>): Promise<CannedResponse | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteCannedResponse(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getEmailTemplates(): Promise<EmailTemplate[]> { throw new Error("Use DatabaseStorage"); }
  async getEmailTemplateByCode(_c: string): Promise<EmailTemplate | undefined> { throw new Error("Use DatabaseStorage"); }
  async createEmailTemplate(_t: InsertEmailTemplate): Promise<EmailTemplate> { throw new Error("Use DatabaseStorage"); }
  async updateEmailTemplate(_id: number, _t: Partial<EmailTemplate>): Promise<EmailTemplate | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteEmailTemplate(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getTicketFilters(): Promise<TicketFilter[]> { throw new Error("Use DatabaseStorage"); }
  async getTicketFilter(_id: number): Promise<TicketFilter | undefined> { throw new Error("Use DatabaseStorage"); }
  async createTicketFilter(_f: InsertTicketFilter): Promise<TicketFilter> { throw new Error("Use DatabaseStorage"); }
  async updateTicketFilter(_id: number, _f: Partial<TicketFilter>): Promise<TicketFilter | undefined> { throw new Error("Use DatabaseStorage"); }
  async deleteTicketFilter(_id: number): Promise<boolean> { throw new Error("Use DatabaseStorage"); }
  async getTicketSettings(): Promise<TicketSettings | undefined> { throw new Error("Use DatabaseStorage"); }
  async updateTicketSettings(_s: Partial<TicketSettings>): Promise<TicketSettings> { throw new Error("Use DatabaseStorage"); }
}

// Switch to database storage for production
export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(users.id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getDevices(): Promise<Device[]> {
    return await db.select().from(devices);
  }

  async getDevice(id: number): Promise<Device | undefined> {
    const [device] = await db.select().from(devices).where(eq(devices.id, id));
    return device || undefined;
  }

  async createDevice(insertDevice: InsertDevice): Promise<Device> {
    const [device] = await db
      .insert(devices)
      .values(insertDevice)
      .returning();
    return device;
  }

  async updateDevice(id: number, update: Partial<Device>): Promise<Device | undefined> {
    const [device] = await db
      .update(devices)
      .set(update)
      .where(eq(devices.id, id))
      .returning();
    return device || undefined;
  }

  async deleteDevice(id: number): Promise<boolean> {
    const result = await db.delete(devices).where(eq(devices.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getAlerts(): Promise<Alert[]> {
    return await db.select().from(alerts);
  }

  async getActiveAlerts(): Promise<Alert[]> {
    return await db.select().from(alerts).where(eq(alerts.status, "active"));
  }

  async getAlert(id: number): Promise<Alert | undefined> {
    const [alert] = await db.select().from(alerts).where(eq(alerts.id, id));
    return alert || undefined;
  }

  async getAlertsBySource(source: string, limit?: number): Promise<Alert[]> {
    const base = db
      .select()
      .from(alerts)
      .where(eq(alerts.alertSource, source))
      .orderBy(desc(alerts.createdAt));
    return typeof limit === "number" ? await base.limit(limit) : await base;
  }

  async createAlert(insertAlert: InsertAlert): Promise<Alert> {
    const [alert] = await db
      .insert(alerts)
      .values(insertAlert)
      .returning();
    return alert;
  }

  async updateAlert(id: number, update: Partial<Alert>): Promise<Alert | undefined> {
    const [alert] = await db
      .update(alerts)
      .set(update)
      .where(eq(alerts.id, id))
      .returning();
    return alert || undefined;
  }

  async getTickets(): Promise<Ticket[]> {
    return await db.select().from(tickets);
  }

  async getOpenTickets(): Promise<Ticket[]> {
    return await db.select().from(tickets).where(ne(tickets.status, "closed"));
  }

  async getTicket(id: number): Promise<Ticket | undefined> {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
    return ticket || undefined;
  }

  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    const [ticket] = await db
      .insert(tickets)
      .values(insertTicket)
      .returning();
    return ticket;
  }

  async updateTicket(id: number, update: Partial<Ticket>): Promise<Ticket | undefined> {
    const [ticket] = await db
      .update(tickets)
      .set(update)
      .where(eq(tickets.id, id))
      .returning();
    return ticket || undefined;
  }

  async getClients(): Promise<Client[]> {
    return await db.select().from(clients);
  }

  async getClient(id: number): Promise<Client | undefined> {
    const [client] = await db.select().from(clients).where(eq(clients.id, id));
    return client || undefined;
  }

  async createClient(insertClient: InsertClient): Promise<Client> {
    const [client] = await db
      .insert(clients)
      .values(insertClient)
      .returning();
    return client;
  }

  async updateClient(id: number, update: Partial<Client>): Promise<Client | undefined> {
    const [client] = await db
      .update(clients)
      .set(update)
      .where(eq(clients.id, id))
      .returning();
    return client || undefined;
  }

  async getNetworkScans(): Promise<NetworkScan[]> {
    return await db.select().from(networkScans);
  }

  async createNetworkScan(insertScan: InsertNetworkScan): Promise<NetworkScan> {
    const [scan] = await db
      .insert(networkScans)
      .values(insertScan)
      .returning();
    return scan;
  }

  async updateNetworkScan(id: number, update: Partial<NetworkScan>): Promise<NetworkScan | undefined> {
    const [scan] = await db
      .update(networkScans)
      .set(update)
      .where(eq(networkScans.id, id))
      .returning();
    return scan || undefined;
  }

  async deleteNetworkScan(id: number): Promise<boolean> {
    const result = await db.delete(networkScans).where(eq(networkScans.id, id)).returning({ id: networkScans.id });
    return result.length > 0;
  }

  async getAutomationScripts(): Promise<AutomationScript[]> {
    return await db.select().from(automationScripts);
  }

  async getAutomationScript(id: number): Promise<AutomationScript | undefined> {
    const [script] = await db.select().from(automationScripts).where(eq(automationScripts.id, id));
    return script || undefined;
  }

  async createAutomationScript(insertScript: InsertAutomationScript): Promise<AutomationScript> {
    const [script] = await db
      .insert(automationScripts)
      .values(insertScript)
      .returning();
    return script;
  }

  async updateAutomationScript(id: number, update: Partial<AutomationScript>): Promise<AutomationScript | undefined> {
    const [script] = await db
      .update(automationScripts)
      .set(update)
      .where(eq(automationScripts.id, id))
      .returning();
    return script || undefined;
  }

  // CSD Intake Methods
  async getCsdIntakes(): Promise<CsdIntakeRecord[]> {
    return await db.select().from(csdIntakeRecords).orderBy(desc(csdIntakeRecords.createdAt));
  }

  async getCsdIntake(id: number): Promise<CsdIntakeRecord | undefined> {
    const [intake] = await db.select().from(csdIntakeRecords).where(eq(csdIntakeRecords.id, id));
    return intake || undefined;
  }

  async createCsdIntake(insertIntake: InsertCsdIntake): Promise<CsdIntakeRecord> {
    const [intake] = await db
      .insert(csdIntakeRecords)
      .values(insertIntake)
      .returning();
    return intake;
  }

  async updateCsdIntake(id: number, update: Partial<CsdIntakeRecord>): Promise<CsdIntakeRecord | undefined> {
    const [intake] = await db
      .update(csdIntakeRecords)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(csdIntakeRecords.id, id))
      .returning();
    return intake || undefined;
  }

  async getCsdIntakesByDateRange(startDate: Date, endDate: Date): Promise<CsdIntakeRecord[]> {
    return await db
      .select()
      .from(csdIntakeRecords)
      .where(
        and(
          gte(csdIntakeRecords.createdAt, startDate),
          lte(csdIntakeRecords.createdAt, endDate)
        )
      )
      .orderBy(desc(csdIntakeRecords.createdAt));
  }

  async getCsdIntakesBySource(source: string): Promise<CsdIntakeRecord[]> {
    return await db
      .select()
      .from(csdIntakeRecords)
      .where(eq(csdIntakeRecords.source, source))
      .orderBy(desc(csdIntakeRecords.createdAt));
  }

  async deleteCsdIntake(id: number): Promise<boolean> {
    const result = await db.delete(csdIntakeRecords).where(eq(csdIntakeRecords.id, id)).returning({ id: csdIntakeRecords.id });
    return result.length > 0;
  }

  // CRM Contacts
  async getCrmContacts(): Promise<CrmContact[]> {
    return await db.select().from(crmContacts).orderBy(desc(crmContacts.createdAt));
  }

  async getCrmContact(id: number): Promise<CrmContact | undefined> {
    const [contact] = await db.select().from(crmContacts).where(eq(crmContacts.id, id));
    return contact || undefined;
  }

  async getCrmContactByPhoneOrEmail(phone: string | null, email: string | null): Promise<CrmContact | undefined> {
    if (!phone && !email) return undefined;
    const conditions = [];
    if (phone) conditions.push(eq(crmContacts.mobilePhone, phone));
    if (email) conditions.push(eq(crmContacts.email, email));
    const [contact] = await db.select().from(crmContacts).where(or(...conditions));
    return contact || undefined;
  }

  async getCrmContactByGoogleId(googleContactId: string): Promise<CrmContact | undefined> {
    const [contact] = await db.select().from(crmContacts).where(eq(crmContacts.googleContactId, googleContactId));
    return contact || undefined;
  }

  async createCrmContact(insertContact: InsertCrmContact): Promise<CrmContact> {
    const [contact] = await db
      .insert(crmContacts)
      .values(insertContact)
      .returning();
    return contact;
  }

  async updateCrmContact(id: number, update: Partial<CrmContact>): Promise<CrmContact | undefined> {
    const [contact] = await db
      .update(crmContacts)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(crmContacts.id, id))
      .returning();
    return contact || undefined;
  }

  async deleteCrmContact(id: number): Promise<boolean> {
    // Null out FK refs in dependent tables first (leads/jobs/interactions)
    // so the contact can be removed without violating constraints. The
    // historical records are preserved with contactId=null.
    await db.update(crmLeads).set({ contactId: null }).where(eq(crmLeads.contactId, id));
    await db.update(crmJobs).set({ contactId: null }).where(eq(crmJobs.contactId, id));
    await db.update(crmInteractions).set({ contactId: null }).where(eq(crmInteractions.contactId, id));
    const result = await db.delete(crmContacts).where(eq(crmContacts.id, id)).returning();
    return result.length > 0;
  }

  async searchCrmContacts(query: string): Promise<CrmContact[]> {
    return await db
      .select()
      .from(crmContacts)
      .where(
        or(
          ilike(crmContacts.fullName, `%${query}%`),
          ilike(crmContacts.mobilePhone, `%${query}%`),
          ilike(crmContacts.email, `%${query}%`)
        )
      )
      .orderBy(desc(crmContacts.createdAt));
  }

  // CRM Leads
  async getCrmLeads(): Promise<CrmLead[]> {
    return await db.select().from(crmLeads).orderBy(desc(crmLeads.createdAt));
  }

  async getCrmLead(id: number): Promise<CrmLead | undefined> {
    const [lead] = await db.select().from(crmLeads).where(eq(crmLeads.id, id));
    return lead || undefined;
  }

  async createCrmLead(insertLead: InsertCrmLead): Promise<CrmLead> {
    const [lead] = await db
      .insert(crmLeads)
      .values(insertLead)
      .returning();
    return lead;
  }

  async updateCrmLead(id: number, update: Partial<CrmLead>): Promise<CrmLead | undefined> {
    const [lead] = await db
      .update(crmLeads)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(crmLeads.id, id))
      .returning();
    return lead || undefined;
  }

  async getCrmLeadsByStatus(status: string): Promise<CrmLead[]> {
    return await db
      .select()
      .from(crmLeads)
      .where(eq(crmLeads.status, status))
      .orderBy(desc(crmLeads.createdAt));
  }

  async getCrmLeadsByContact(contactId: number): Promise<CrmLead[]> {
    return await db
      .select()
      .from(crmLeads)
      .where(eq(crmLeads.contactId, contactId))
      .orderBy(desc(crmLeads.createdAt));
  }

  // CRM Deals
  async getCrmDeals(): Promise<CrmDeal[]> {
    return await db.select().from(crmDeals).orderBy(desc(crmDeals.createdAt));
  }

  async getCrmDeal(id: number): Promise<CrmDeal | undefined> {
    const [deal] = await db.select().from(crmDeals).where(eq(crmDeals.id, id));
    return deal || undefined;
  }

  async createCrmDeal(insertDeal: InsertCrmDeal): Promise<CrmDeal> {
    const [deal] = await db
      .insert(crmDeals)
      .values(insertDeal)
      .returning();
    return deal;
  }

  async updateCrmDeal(id: number, update: Partial<CrmDeal>): Promise<CrmDeal | undefined> {
    const [deal] = await db
      .update(crmDeals)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(crmDeals.id, id))
      .returning();
    return deal || undefined;
  }

  async deleteCrmDeal(id: number): Promise<boolean> {
    const result = await db.delete(crmDeals).where(eq(crmDeals.id, id)).returning();
    return result.length > 0;
  }

  async getCrmDealsByStage(stage: string): Promise<CrmDeal[]> {
    return await db
      .select()
      .from(crmDeals)
      .where(eq(crmDeals.stage, stage))
      .orderBy(desc(crmDeals.createdAt));
  }

  async getCrmDealsByContact(contactId: number): Promise<CrmDeal[]> {
    return await db
      .select()
      .from(crmDeals)
      .where(eq(crmDeals.primaryContactId, contactId))
      .orderBy(desc(crmDeals.createdAt));
  }

  // CRM Jobs
  async getCrmJobs(): Promise<CrmJob[]> {
    return await db.select().from(crmJobs).orderBy(desc(crmJobs.createdAt));
  }

  async getCrmJob(id: number): Promise<CrmJob | undefined> {
    const [job] = await db.select().from(crmJobs).where(eq(crmJobs.id, id));
    return job || undefined;
  }

  async createCrmJob(insertJob: InsertCrmJob): Promise<CrmJob> {
    const [job] = await db
      .insert(crmJobs)
      .values(insertJob)
      .returning();
    return job;
  }

  async updateCrmJob(id: number, update: Partial<CrmJob>): Promise<CrmJob | undefined> {
    const [job] = await db
      .update(crmJobs)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(crmJobs.id, id))
      .returning();
    return job || undefined;
  }

  async getCrmJobsByStatus(status: string): Promise<CrmJob[]> {
    return await db
      .select()
      .from(crmJobs)
      .where(eq(crmJobs.status, status))
      .orderBy(desc(crmJobs.createdAt));
  }

  async getCrmJobsByLead(leadId: number): Promise<CrmJob[]> {
    return await db
      .select()
      .from(crmJobs)
      .where(eq(crmJobs.leadId, leadId))
      .orderBy(desc(crmJobs.createdAt));
  }

  async getNextJobNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const allJobs = await db.select().from(crmJobs);
    const currentYearJobs = allJobs.filter(j => j.jobNumber?.startsWith(`CSD-${year}`));
    const nextNum = currentYearJobs.length + 1;
    return `CSD-${year}-${nextNum.toString().padStart(4, '0')}`;
  }

  // CRM Interactions
  async getCrmInteractions(): Promise<CrmInteraction[]> {
    return await db.select().from(crmInteractions).orderBy(desc(crmInteractions.createdAt));
  }

  async getCrmInteraction(id: number): Promise<CrmInteraction | undefined> {
    const [interaction] = await db.select().from(crmInteractions).where(eq(crmInteractions.id, id));
    return interaction || undefined;
  }

  async createCrmInteraction(insertInteraction: InsertCrmInteraction): Promise<CrmInteraction> {
    const [interaction] = await db
      .insert(crmInteractions)
      .values(insertInteraction)
      .returning();
    return interaction;
  }

  async getCrmInteractionsByContact(contactId: number): Promise<CrmInteraction[]> {
    return await db
      .select()
      .from(crmInteractions)
      .where(eq(crmInteractions.contactId, contactId))
      .orderBy(desc(crmInteractions.createdAt));
  }

  async getCrmInteractionsByLead(leadId: number): Promise<CrmInteraction[]> {
    return await db
      .select()
      .from(crmInteractions)
      .where(eq(crmInteractions.leadId, leadId))
      .orderBy(desc(crmInteractions.createdAt));
  }

  async getCrmInteractionsByJob(jobId: number): Promise<CrmInteraction[]> {
    return await db
      .select()
      .from(crmInteractions)
      .where(eq(crmInteractions.jobId, jobId))
      .orderBy(desc(crmInteractions.createdAt));
  }
  
  // Service Logs
  async getServiceLogs(): Promise<ServiceLog[]> {
    return await db.select().from(serviceLog).orderBy(desc(serviceLog.createdAt));
  }
  
  async getServiceLog(id: number): Promise<ServiceLog | undefined> {
    const [log] = await db.select().from(serviceLog).where(eq(serviceLog.id, id));
    return log || undefined;
  }
  
  async createServiceLog(log: InsertServiceLog): Promise<ServiceLog> {
    const [created] = await db.insert(serviceLog).values(log).returning();
    return created;
  }
  
  async updateServiceLog(id: number, log: Partial<ServiceLog>): Promise<ServiceLog | undefined> {
    const [updated] = await db
      .update(serviceLog)
      .set({ ...log, updatedAt: new Date() })
      .where(eq(serviceLog.id, id))
      .returning();
    return updated || undefined;
  }
  
  async getServiceLogsByContact(contactId: number): Promise<ServiceLog[]> {
    return await db
      .select()
      .from(serviceLog)
      .where(eq(serviceLog.contactId, contactId))
      .orderBy(desc(serviceLog.createdAt));
  }
  
  async getServiceLogsByJob(jobId: number): Promise<ServiceLog[]> {
    return await db
      .select()
      .from(serviceLog)
      .where(eq(serviceLog.jobId, jobId))
      .orderBy(desc(serviceLog.createdAt));
  }

  async deleteServiceLog(id: number): Promise<boolean> {
    const result = await db.delete(serviceLog).where(eq(serviceLog.id, id)).returning({ id: serviceLog.id });
    return result.length > 0;
  }

  // ARIA Conversations
  async getAriaConversations(userId?: number): Promise<AriaConversation[]> {
    if (userId) {
      return await db
        .select()
        .from(ariaConversations)
        .where(eq(ariaConversations.userId, userId))
        .orderBy(desc(ariaConversations.updatedAt));
    }
    return await db
      .select()
      .from(ariaConversations)
      .orderBy(desc(ariaConversations.updatedAt));
  }

  async getAriaConversation(id: number): Promise<AriaConversation | undefined> {
    const [conversation] = await db
      .select()
      .from(ariaConversations)
      .where(eq(ariaConversations.id, id));
    return conversation || undefined;
  }

  async getAriaConversationBySession(sessionId: string): Promise<AriaConversation | undefined> {
    const [conversation] = await db
      .select()
      .from(ariaConversations)
      .where(eq(ariaConversations.sessionId, sessionId));
    return conversation || undefined;
  }

  async createAriaConversation(insertConversation: InsertAriaConversation): Promise<AriaConversation> {
    const [conversation] = await db
      .insert(ariaConversations)
      .values(insertConversation)
      .returning();
    return conversation;
  }

  async updateAriaConversation(id: number, update: Partial<AriaConversation>): Promise<AriaConversation | undefined> {
    const [conversation] = await db
      .update(ariaConversations)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(ariaConversations.id, id))
      .returning();
    return conversation || undefined;
  }

  async deleteAriaConversation(id: number): Promise<boolean> {
    // First delete associated messages
    await db.delete(ariaMessages).where(eq(ariaMessages.conversationId, id));
    // Then delete the conversation
    const result = await db.delete(ariaConversations).where(eq(ariaConversations.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ARIA Messages
  async getAriaMessages(conversationId: number): Promise<AriaMessage[]> {
    return await db
      .select()
      .from(ariaMessages)
      .where(eq(ariaMessages.conversationId, conversationId))
      .orderBy(ariaMessages.createdAt);
  }

  async createAriaMessage(insertMessage: InsertAriaMessage): Promise<AriaMessage> {
    const [message] = await db
      .insert(ariaMessages)
      .values(insertMessage)
      .returning();
    return message;
  }

  // ============================================================
  // BOOKING PLATFORM
  // ============================================================

  async getBookingResources(opts?: { activeOnly?: boolean }): Promise<BookingResource[]> {
    if (opts?.activeOnly) {
      return await db.select().from(bookingResources).where(eq(bookingResources.isActive, true));
    }
    return await db.select().from(bookingResources);
  }

  async getBookingResource(id: number): Promise<BookingResource | undefined> {
    const [r] = await db.select().from(bookingResources).where(eq(bookingResources.id, id));
    return r || undefined;
  }

  async createBookingResource(resource: InsertBookingResource): Promise<BookingResource> {
    const [r] = await db.insert(bookingResources).values(resource).returning();
    return r;
  }

  async getResourceTags(): Promise<ResourceTag[]> {
    return await db.select().from(resourceTags);
  }

  async getResourceTagBySlug(slug: string): Promise<ResourceTag | undefined> {
    const [t] = await db.select().from(resourceTags).where(eq(resourceTags.slug, slug));
    return t || undefined;
  }

  async createResourceTag(tag: InsertResourceTag): Promise<ResourceTag> {
    const [t] = await db.insert(resourceTags).values(tag).returning();
    return t;
  }

  async assignResourceTag(resourceId: number, tagId: number): Promise<void> {
    await db.insert(resourceTagAssignments)
      .values({ resourceId, tagId })
      .onConflictDoNothing();
  }

  async getResourceIdsByTag(tagId: number): Promise<number[]> {
    const rows = await db.select({ id: resourceTagAssignments.resourceId })
      .from(resourceTagAssignments)
      .where(eq(resourceTagAssignments.tagId, tagId));
    return rows.map(r => r.id);
  }

  async getServiceCategories(opts?: { activeOnly?: boolean }): Promise<ServiceCategory[]> {
    if (opts?.activeOnly) {
      return await db.select().from(serviceCategories)
        .where(eq(serviceCategories.isActive, true))
        .orderBy(serviceCategories.displayOrder);
    }
    return await db.select().from(serviceCategories).orderBy(serviceCategories.displayOrder);
  }

  async createServiceCategory(category: InsertServiceCategory): Promise<ServiceCategory> {
    const [c] = await db.insert(serviceCategories).values(category).returning();
    return c;
  }

  async getServices(opts?: { publicOnly?: boolean }): Promise<Service[]> {
    if (opts?.publicOnly) {
      return await db.select().from(services)
        .where(and(eq(services.isActive, true), eq(services.isPubliclyBookable, true)));
    }
    return await db.select().from(services);
  }

  async getService(id: number): Promise<Service | undefined> {
    const [s] = await db.select().from(services).where(eq(services.id, id));
    return s || undefined;
  }

  async getServiceBySlug(slug: string): Promise<Service | undefined> {
    const [s] = await db.select().from(services).where(eq(services.slug, slug));
    return s || undefined;
  }

  async createService(service: InsertService): Promise<Service> {
    const [s] = await db.insert(services).values(service).returning();
    return s;
  }

  async getServiceRequirements(serviceId: number): Promise<ServiceResourceRequirement[]> {
    return await db.select().from(serviceResourceRequirements)
      .where(eq(serviceResourceRequirements.serviceId, serviceId));
  }

  async createServiceRequirement(req: InsertServiceResourceRequirement): Promise<ServiceResourceRequirement> {
    const [r] = await db.insert(serviceResourceRequirements).values(req).returning();
    return r;
  }

  async getBusinessHoursForResource(resourceId: number): Promise<BusinessHours[]> {
    return await db.select().from(businessHours)
      .where(eq(businessHours.resourceId, resourceId))
      .orderBy(businessHours.dayOfWeek);
  }

  async createBusinessHours(hours: InsertBusinessHours): Promise<BusinessHours> {
    const [h] = await db.insert(businessHours).values(hours).returning();
    return h;
  }

  async getResourceTimeOffInRange(resourceId: number, startsAt: Date, endsAt: Date): Promise<ResourceTimeOff[]> {
    // Overlap predicate: row.startsAt < range.endsAt AND row.endsAt > range.startsAt
    return await db.select().from(resourceTimeOff)
      .where(and(
        eq(resourceTimeOff.resourceId, resourceId),
        lt(resourceTimeOff.startsAt, endsAt),
        gt(resourceTimeOff.endsAt, startsAt),
      ));
  }

  async getHolidaysInRange(startDate: string, endDate: string): Promise<Holiday[]> {
    return await db.select().from(holidays)
      .where(and(gte(holidays.date, startDate), lte(holidays.date, endDate)));
  }

  async createBookingSlotLock(lock: InsertBookingSlotLock, resourceIds: number[]): Promise<BookingSlotLock> {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(bookingSlotLocks).values(lock).returning();
      if (resourceIds.length > 0) {
        await tx.insert(bookingSlotLockResources).values(
          resourceIds.map(rid => ({
            lockId: created.id,
            resourceId: rid,
            startsAt: lock.startsAt,
            endsAt: lock.endsAt,
            expiresAt: lock.expiresAt,
          }))
        );
      }
      return created;
    });
  }

  async getBookingSlotLockByToken(token: string): Promise<BookingSlotLock | undefined> {
    const [l] = await db.select().from(bookingSlotLocks).where(eq(bookingSlotLocks.lockToken, token));
    return l || undefined;
  }

  async deleteBookingSlotLock(id: number): Promise<boolean> {
    const result = await db.delete(bookingSlotLocks).where(eq(bookingSlotLocks.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async sweepExpiredSlotLocks(): Promise<number> {
    const result = await db.delete(bookingSlotLocks)
      .where(lt(bookingSlotLocks.expiresAt, new Date()));
    return result.rowCount ?? 0;
  }

  async getActiveLockResourceConflicts(
    resourceIds: number[],
    startsAt: Date,
    endsAt: Date,
    excludeLockId?: number,
  ): Promise<BookingSlotLockResource[]> {
    if (resourceIds.length === 0) return [];
    const conditions = [
      inArray(bookingSlotLockResources.resourceId, resourceIds),
      lt(bookingSlotLockResources.startsAt, endsAt),
      gt(bookingSlotLockResources.endsAt, startsAt),
      gt(bookingSlotLockResources.expiresAt, new Date()),
    ];
    if (excludeLockId !== undefined) {
      conditions.push(ne(bookingSlotLockResources.lockId, excludeLockId));
    }
    return await db.select().from(bookingSlotLockResources).where(and(...conditions));
  }

  async createAppointment(
    appointment: InsertAppointment,
    resourceAssignments: { resourceId: number; requirementId?: number }[],
  ): Promise<Appointment> {
    return await db.transaction(async (tx) => {
      // Generate human-friendly reference: CSD-A-YYYY-NNNNNN
      const year = new Date().getUTCFullYear();
      const [{ count }] = await tx.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM appointments WHERE EXTRACT(YEAR FROM created_at AT TIME ZONE 'UTC') = ${year}`
      ) as any;
      const seq = (parseInt(count, 10) + 1).toString().padStart(6, '0');
      const reference = `CSD-A-${year}-${seq}`;

      const [created] = await tx.insert(appointments).values({
        ...appointment,
        reference,
      } as any).returning();

      if (resourceAssignments.length > 0) {
        await tx.insert(appointmentResources).values(
          resourceAssignments.map(a => ({
            appointmentId: created.id,
            resourceId: a.resourceId,
            requirementId: a.requirementId,
            startsAt: created.startsAt,
            endsAt: created.endsAt,
            status: created.status,
          }))
        );
      }
      return created;
    });
  }

  async getAppointment(id: number): Promise<Appointment | undefined> {
    const [a] = await db.select().from(appointments).where(eq(appointments.id, id));
    return a || undefined;
  }

  async getAppointmentByReference(reference: string): Promise<Appointment | undefined> {
    const [a] = await db.select().from(appointments).where(eq(appointments.reference, reference));
    return a || undefined;
  }

  async getAppointments(opts?: { status?: string; from?: Date; to?: Date }): Promise<Appointment[]> {
    const conditions = [] as any[];
    if (opts?.status) conditions.push(eq(appointments.status, opts.status));
    if (opts?.from) conditions.push(gte(appointments.startsAt, opts.from));
    if (opts?.to) conditions.push(lt(appointments.startsAt, opts.to));
    if (conditions.length > 0) {
      return await db.select().from(appointments).where(and(...conditions)).orderBy(appointments.startsAt);
    }
    return await db.select().from(appointments).orderBy(appointments.startsAt);
  }

  async getActiveAppointmentResourceConflicts(
    resourceIds: number[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<AppointmentResource[]> {
    if (resourceIds.length === 0) return [];
    return await db.select().from(appointmentResources)
      .where(and(
        inArray(appointmentResources.resourceId, resourceIds),
        inArray(appointmentResources.status, APPOINTMENT_ACTIVE_STATUSES as unknown as string[]),
        lt(appointmentResources.startsAt, endsAt),
        gt(appointmentResources.endsAt, startsAt),
      ));
  }

  // ===== Remote Access Sessions =====
  async createRemoteSession(session: InsertRemoteAccessSession): Promise<RemoteAccessSession> {
    const [row] = await db.insert(remoteAccessSessions).values(session).returning();
    return row;
  }

  async endRemoteSession(
    id: number,
    update: Partial<RemoteAccessSession> = {},
  ): Promise<RemoteAccessSession | undefined> {
    const endTime = update.endTime ?? new Date();
    const [existing] = await db.select().from(remoteAccessSessions).where(eq(remoteAccessSessions.id, id));
    if (!existing) return undefined;

    const startTime = existing.startTime ?? new Date();
    const duration = update.duration ?? Math.max(0, Math.floor((endTime.getTime() - startTime.getTime()) / 1000));

    const [row] = await db
      .update(remoteAccessSessions)
      .set({
        status: update.status ?? "ended",
        endTime,
        duration,
        ...update,
      })
      .where(eq(remoteAccessSessions.id, id))
      .returning();
    return row || undefined;
  }

  async getActiveRemoteSessions(): Promise<RemoteAccessSession[]> {
    return await db
      .select()
      .from(remoteAccessSessions)
      .where(eq(remoteAccessSessions.status, "active"))
      .orderBy(desc(remoteAccessSessions.startTime));
  }

  async getRemoteSessionsByDevice(deviceId: number): Promise<RemoteAccessSession[]> {
    return await db
      .select()
      .from(remoteAccessSessions)
      .where(eq(remoteAccessSessions.deviceId, deviceId))
      .orderBy(desc(remoteAccessSessions.startTime));
  }

  async getRemoteSessionsBySource(sourceType: string, sourceId: number): Promise<RemoteAccessSession[]> {
    return await db
      .select()
      .from(remoteAccessSessions)
      .where(and(eq(remoteAccessSessions.sourceType, sourceType), eq(remoteAccessSessions.sourceId, sourceId)))
      .orderBy(desc(remoteAccessSessions.startTime));
  }

  async getRemoteSessionRecordings(): Promise<RemoteAccessSession[]> {
    return await db
      .select()
      .from(remoteAccessSessions)
      .where(and(
        sql`${remoteAccessSessions.recordingPath} IS NOT NULL`,
        ne(remoteAccessSessions.status, "active"),
      ))
      .orderBy(desc(remoteAccessSessions.startTime));
  }

  async deleteRemoteSession(id: number): Promise<boolean> {
    const result = await db.delete(remoteAccessSessions).where(eq(remoteAccessSessions.id, id)).returning({ id: remoteAccessSessions.id });
    return result.length > 0;
  }

  // ===== Clients =====
  async deleteClient(id: number): Promise<boolean> {
    const result = await db.delete(clients).where(eq(clients.id, id)).returning({ id: clients.id });
    return result.length > 0;
  }

  // ===== Emergency Contacts =====
  async getEmergencyContacts(clientId?: number): Promise<EmergencyContact[]> {
    if (clientId !== undefined) {
      return await db
        .select()
        .from(emergencyContacts)
        .where(eq(emergencyContacts.clientId, clientId))
        .orderBy(emergencyContacts.priority, emergencyContacts.id);
    }
    return await db
      .select()
      .from(emergencyContacts)
      .orderBy(emergencyContacts.priority, emergencyContacts.id);
  }
  async getEmergencyContact(id: number): Promise<EmergencyContact | undefined> {
    const [row] = await db.select().from(emergencyContacts).where(eq(emergencyContacts.id, id));
    return row || undefined;
  }
  async createEmergencyContact(c: InsertEmergencyContact): Promise<EmergencyContact> {
    const [row] = await db.insert(emergencyContacts).values(c).returning();
    return row;
  }
  async updateEmergencyContact(id: number, c: Partial<EmergencyContact>): Promise<EmergencyContact | undefined> {
    const [row] = await db.update(emergencyContacts).set(c).where(eq(emergencyContacts.id, id)).returning();
    return row || undefined;
  }
  async deleteEmergencyContact(id: number): Promise<boolean> {
    const result = await db.delete(emergencyContacts).where(eq(emergencyContacts.id, id)).returning({ id: emergencyContacts.id });
    return result.length > 0;
  }

  // ===== Helpdesk Integrations =====
  async getHelpdeskIntegrations(clientId?: number): Promise<HelpdeskIntegration[]> {
    if (clientId !== undefined) {
      return await db
        .select()
        .from(helpdeskIntegrations)
        .where(eq(helpdeskIntegrations.clientId, clientId))
        .orderBy(helpdeskIntegrations.id);
    }
    return await db.select().from(helpdeskIntegrations).orderBy(helpdeskIntegrations.id);
  }
  async getHelpdeskIntegration(id: number): Promise<HelpdeskIntegration | undefined> {
    const [row] = await db.select().from(helpdeskIntegrations).where(eq(helpdeskIntegrations.id, id));
    return row || undefined;
  }
  async createHelpdeskIntegration(i: InsertHelpdeskIntegration): Promise<HelpdeskIntegration> {
    const [row] = await db.insert(helpdeskIntegrations).values(i).returning();
    return row;
  }
  async updateHelpdeskIntegration(id: number, i: Partial<HelpdeskIntegration>): Promise<HelpdeskIntegration | undefined> {
    const [row] = await db.update(helpdeskIntegrations).set(i).where(eq(helpdeskIntegrations.id, id)).returning();
    return row || undefined;
  }
  async deleteHelpdeskIntegration(id: number): Promise<boolean> {
    const result = await db.delete(helpdeskIntegrations).where(eq(helpdeskIntegrations.id, id)).returning({ id: helpdeskIntegrations.id });
    return result.length > 0;
  }

  // ===== Patch Management =====
  async getPatchPolicies(): Promise<PatchPolicy[]> {
    return await db.select().from(patchPolicies).orderBy(patchPolicies.id);
  }
  async getPatchPolicy(id: number): Promise<PatchPolicy | undefined> {
    const [row] = await db.select().from(patchPolicies).where(eq(patchPolicies.id, id));
    return row || undefined;
  }
  async createPatchPolicy(p: InsertPatchPolicy): Promise<PatchPolicy> {
    const [row] = await db.insert(patchPolicies).values(p).returning();
    return row;
  }
  async updatePatchPolicy(id: number, p: Partial<PatchPolicy>): Promise<PatchPolicy | undefined> {
    const [row] = await db.update(patchPolicies).set(p).where(eq(patchPolicies.id, id)).returning();
    return row || undefined;
  }
  async deletePatchPolicy(id: number): Promise<boolean> {
    const result = await db.delete(patchPolicies).where(eq(patchPolicies.id, id)).returning({ id: patchPolicies.id });
    return result.length > 0;
  }
  async getDevicePatches(opts?: { deviceId?: number; status?: string }): Promise<DevicePatch[]> {
    const conds: any[] = [];
    if (opts?.deviceId !== undefined) conds.push(eq(devicePatches.deviceId, opts.deviceId));
    if (opts?.status) conds.push(eq(devicePatches.status, opts.status));
    if (conds.length === 0) {
      return await db.select().from(devicePatches).orderBy(desc(devicePatches.updatedAt));
    }
    return await db
      .select()
      .from(devicePatches)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .orderBy(desc(devicePatches.updatedAt));
  }
  async upsertDevicePatch(p: InsertDevicePatch): Promise<DevicePatch> {
    const existing = await db
      .select()
      .from(devicePatches)
      .where(and(eq(devicePatches.deviceId, p.deviceId ?? 0), eq(devicePatches.kbId, p.kbId)));
    if (existing.length > 0) {
      const [row] = await db
        .update(devicePatches)
        .set({ ...p, updatedAt: new Date() })
        .where(eq(devicePatches.id, existing[0].id))
        .returning();
      return row;
    }
    const [row] = await db.insert(devicePatches).values(p).returning();
    return row;
  }
  async updateDevicePatch(id: number, p: Partial<DevicePatch>): Promise<DevicePatch | undefined> {
    const [row] = await db
      .update(devicePatches)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(devicePatches.id, id))
      .returning();
    return row || undefined;
  }
  async createPatchJob(j: InsertPatchJob): Promise<PatchJob> {
    const [row] = await db.insert(patchJobs).values(j).returning();
    return row;
  }
  async updatePatchJob(id: number, j: Partial<PatchJob>): Promise<PatchJob | undefined> {
    const [row] = await db.update(patchJobs).set(j).where(eq(patchJobs.id, id)).returning();
    return row || undefined;
  }
  async getPatchJobs(opts?: { status?: string }): Promise<PatchJob[]> {
    if (opts?.status) {
      return await db
        .select()
        .from(patchJobs)
        .where(eq(patchJobs.status, opts.status))
        .orderBy(desc(patchJobs.createdAt));
    }
    return await db.select().from(patchJobs).orderBy(desc(patchJobs.createdAt));
  }

  // ===== HELPDESK IMPLEMENTATIONS =====
  async getTicketByNumber(ticketNumber: string): Promise<Ticket | undefined> {
    const [t] = await db.select().from(tickets).where(eq(tickets.ticketNumber, ticketNumber));
    return t || undefined;
  }

  async getTicketByEmailAndToken(email: string, accessToken: string): Promise<Ticket | undefined> {
    const [t] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.requesterEmail, email), eq(tickets.accessToken, accessToken)));
    return t || undefined;
  }

  async getOverdueTickets(): Promise<Ticket[]> {
    const now = new Date();
    return await db
      .select()
      .from(tickets)
      .where(and(
        lt(tickets.slaDueAt, now),
        ne(tickets.status, "closed"),
        ne(tickets.status, "resolved"),
      ));
  }

  async getNextTicketNumber(prefix: string): Promise<string> {
    const year = new Date().getFullYear();
    // Find the highest existing number for this prefix+year
    const rows = await db
      .select({ ticketNumber: tickets.ticketNumber })
      .from(tickets)
      .where(and(
        ilike(tickets.ticketNumber, `${prefix}-${year}-%`),
      ))
      .orderBy(desc(tickets.id));
    let max = 0;
    for (const r of rows) {
      if (!r.ticketNumber) continue;
      const m = r.ticketNumber.match(/-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    const next = max + 1;
    return `${prefix}-${year}-${String(next).padStart(4, "0")}`;
  }

  // Departments
  async getTicketDepartments(): Promise<TicketDepartment[]> {
    return await db.select().from(ticketDepartments).orderBy(ticketDepartments.id);
  }
  async getTicketDepartment(id: number): Promise<TicketDepartment | undefined> {
    const [d] = await db.select().from(ticketDepartments).where(eq(ticketDepartments.id, id));
    return d || undefined;
  }
  async getDefaultTicketDepartment(): Promise<TicketDepartment | undefined> {
    const [d] = await db.select().from(ticketDepartments).where(eq(ticketDepartments.isDefault, true));
    if (d) return d;
    const [first] = await db.select().from(ticketDepartments).orderBy(ticketDepartments.id);
    return first || undefined;
  }
  async createTicketDepartment(d: InsertTicketDepartment): Promise<TicketDepartment> {
    const [row] = await db.insert(ticketDepartments).values(d).returning();
    return row;
  }
  async updateTicketDepartment(id: number, d: Partial<TicketDepartment>): Promise<TicketDepartment | undefined> {
    const [row] = await db.update(ticketDepartments).set(d).where(eq(ticketDepartments.id, id)).returning();
    return row || undefined;
  }
  async deleteTicketDepartment(id: number): Promise<boolean> {
    const rows = await db.delete(ticketDepartments).where(eq(ticketDepartments.id, id)).returning();
    return rows.length > 0;
  }

  // Teams
  async getTicketTeams(): Promise<TicketTeam[]> {
    return await db.select().from(ticketTeams).orderBy(ticketTeams.id);
  }
  async getTicketTeam(id: number): Promise<TicketTeam | undefined> {
    const [row] = await db.select().from(ticketTeams).where(eq(ticketTeams.id, id));
    return row || undefined;
  }
  async createTicketTeam(t: InsertTicketTeam): Promise<TicketTeam> {
    const [row] = await db.insert(ticketTeams).values(t).returning();
    return row;
  }
  async updateTicketTeam(id: number, t: Partial<TicketTeam>): Promise<TicketTeam | undefined> {
    const [row] = await db.update(ticketTeams).set(t).where(eq(ticketTeams.id, id)).returning();
    return row || undefined;
  }
  async deleteTicketTeam(id: number): Promise<boolean> {
    const rows = await db.delete(ticketTeams).where(eq(ticketTeams.id, id)).returning();
    return rows.length > 0;
  }
  async getTicketTeamMembers(teamId: number): Promise<TicketTeamMember[]> {
    return await db.select().from(ticketTeamMembers).where(eq(ticketTeamMembers.teamId, teamId));
  }
  async addTicketTeamMember(m: InsertTicketTeamMember): Promise<TicketTeamMember> {
    const [row] = await db.insert(ticketTeamMembers).values(m).returning();
    return row;
  }
  async removeTicketTeamMember(teamId: number, userId: number): Promise<boolean> {
    const rows = await db
      .delete(ticketTeamMembers)
      .where(and(eq(ticketTeamMembers.teamId, teamId), eq(ticketTeamMembers.userId, userId)))
      .returning();
    return rows.length > 0;
  }

  // Help topics
  async getTicketHelpTopics(): Promise<TicketHelpTopic[]> {
    return await db.select().from(ticketHelpTopics).orderBy(ticketHelpTopics.id);
  }
  async getTicketHelpTopic(id: number): Promise<TicketHelpTopic | undefined> {
    const [row] = await db.select().from(ticketHelpTopics).where(eq(ticketHelpTopics.id, id));
    return row || undefined;
  }
  async createTicketHelpTopic(t: InsertTicketHelpTopic): Promise<TicketHelpTopic> {
    const [row] = await db.insert(ticketHelpTopics).values(t).returning();
    return row;
  }
  async updateTicketHelpTopic(id: number, t: Partial<TicketHelpTopic>): Promise<TicketHelpTopic | undefined> {
    const [row] = await db.update(ticketHelpTopics).set(t).where(eq(ticketHelpTopics.id, id)).returning();
    return row || undefined;
  }
  async deleteTicketHelpTopic(id: number): Promise<boolean> {
    const rows = await db.delete(ticketHelpTopics).where(eq(ticketHelpTopics.id, id)).returning();
    return rows.length > 0;
  }

  // SLA plans
  async getSlaPlans(): Promise<SlaPlan[]> {
    return await db.select().from(slaPlans).orderBy(slaPlans.id);
  }
  async getSlaPlan(id: number): Promise<SlaPlan | undefined> {
    const [row] = await db.select().from(slaPlans).where(eq(slaPlans.id, id));
    return row || undefined;
  }
  async createSlaPlan(p: InsertSlaPlan): Promise<SlaPlan> {
    const [row] = await db.insert(slaPlans).values(p).returning();
    return row;
  }
  async updateSlaPlan(id: number, p: Partial<SlaPlan>): Promise<SlaPlan | undefined> {
    const [row] = await db.update(slaPlans).set(p).where(eq(slaPlans.id, id)).returning();
    return row || undefined;
  }
  async deleteSlaPlan(id: number): Promise<boolean> {
    const rows = await db.delete(slaPlans).where(eq(slaPlans.id, id)).returning();
    return rows.length > 0;
  }

  // Messages
  async getTicketMessages(ticketId: number, opts?: { includeInternal?: boolean }): Promise<TicketMessage[]> {
    const includeInternal = opts?.includeInternal ?? true;
    if (includeInternal) {
      return await db
        .select()
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, ticketId))
        .orderBy(ticketMessages.createdAt);
    }
    return await db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.isInternal, false)))
      .orderBy(ticketMessages.createdAt);
  }
  async createTicketMessage(m: InsertTicketMessage): Promise<TicketMessage> {
    const [row] = await db.insert(ticketMessages).values(m).returning();
    return row;
  }

  // Activity
  async getTicketActivity(ticketId: number): Promise<TicketActivity[]> {
    return await db
      .select()
      .from(ticketActivity)
      .where(eq(ticketActivity.ticketId, ticketId))
      .orderBy(desc(ticketActivity.createdAt));
  }
  async createTicketActivity(a: InsertTicketActivity): Promise<TicketActivity> {
    const [row] = await db.insert(ticketActivity).values(a).returning();
    return row;
  }

  // Attachments
  async getTicketAttachments(ticketId: number): Promise<TicketAttachment[]> {
    return await db
      .select()
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, ticketId))
      .orderBy(desc(ticketAttachments.createdAt));
  }
  async createTicketAttachment(a: InsertTicketAttachment): Promise<TicketAttachment> {
    const [row] = await db.insert(ticketAttachments).values(a).returning();
    return row;
  }
  async deleteTicketAttachment(id: number): Promise<boolean> {
    const rows = await db.delete(ticketAttachments).where(eq(ticketAttachments.id, id)).returning();
    return rows.length > 0;
  }

  // Canned responses
  async getCannedResponses(): Promise<CannedResponse[]> {
    return await db.select().from(cannedResponses).orderBy(cannedResponses.name);
  }
  async getCannedResponse(id: number): Promise<CannedResponse | undefined> {
    const [row] = await db.select().from(cannedResponses).where(eq(cannedResponses.id, id));
    return row || undefined;
  }
  async createCannedResponse(c: InsertCannedResponse): Promise<CannedResponse> {
    const [row] = await db.insert(cannedResponses).values(c).returning();
    return row;
  }
  async updateCannedResponse(id: number, c: Partial<CannedResponse>): Promise<CannedResponse | undefined> {
    const [row] = await db
      .update(cannedResponses)
      .set({ ...c, updatedAt: new Date() })
      .where(eq(cannedResponses.id, id))
      .returning();
    return row || undefined;
  }
  async deleteCannedResponse(id: number): Promise<boolean> {
    const rows = await db.delete(cannedResponses).where(eq(cannedResponses.id, id)).returning();
    return rows.length > 0;
  }

  // Email templates
  async getEmailTemplates(): Promise<EmailTemplate[]> {
    return await db.select().from(emailTemplates).orderBy(emailTemplates.code);
  }
  async getEmailTemplateByCode(code: string): Promise<EmailTemplate | undefined> {
    const [row] = await db.select().from(emailTemplates).where(eq(emailTemplates.code, code));
    return row || undefined;
  }
  async createEmailTemplate(t: InsertEmailTemplate): Promise<EmailTemplate> {
    const [row] = await db.insert(emailTemplates).values(t).returning();
    return row;
  }
  async updateEmailTemplate(id: number, t: Partial<EmailTemplate>): Promise<EmailTemplate | undefined> {
    const [row] = await db
      .update(emailTemplates)
      .set({ ...t, updatedAt: new Date() })
      .where(eq(emailTemplates.id, id))
      .returning();
    return row || undefined;
  }
  async deleteEmailTemplate(id: number): Promise<boolean> {
    const rows = await db.delete(emailTemplates).where(eq(emailTemplates.id, id)).returning();
    return rows.length > 0;
  }

  // Filters
  async getTicketFilters(): Promise<TicketFilter[]> {
    return await db.select().from(ticketFilters).orderBy(ticketFilters.priority);
  }
  async getTicketFilter(id: number): Promise<TicketFilter | undefined> {
    const [row] = await db.select().from(ticketFilters).where(eq(ticketFilters.id, id));
    return row || undefined;
  }
  async createTicketFilter(f: InsertTicketFilter): Promise<TicketFilter> {
    const [row] = await db.insert(ticketFilters).values(f).returning();
    return row;
  }
  async updateTicketFilter(id: number, f: Partial<TicketFilter>): Promise<TicketFilter | undefined> {
    const [row] = await db.update(ticketFilters).set(f).where(eq(ticketFilters.id, id)).returning();
    return row || undefined;
  }
  async deleteTicketFilter(id: number): Promise<boolean> {
    const rows = await db.delete(ticketFilters).where(eq(ticketFilters.id, id)).returning();
    return rows.length > 0;
  }

  // Settings (singleton row id=1)
  async getTicketSettings(): Promise<TicketSettings | undefined> {
    const [row] = await db.select().from(ticketSettings).where(eq(ticketSettings.id, 1));
    return row || undefined;
  }
  async updateTicketSettings(s: Partial<TicketSettings>): Promise<TicketSettings> {
    const existing = await this.getTicketSettings();
    if (existing) {
      const [row] = await db
        .update(ticketSettings)
        .set({ ...s, updatedAt: new Date() })
        .where(eq(ticketSettings.id, 1))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(ticketSettings)
      .values({ id: 1, ...s } as any)
      .returning();
    return row;
  }

  // A2P Rejection Suggestions
  async createA2pRejectionSuggestion(s: InsertA2pRejectionSuggestion & { submittedBy?: string | null }): Promise<A2pRejectionSuggestion> {
    const [row] = await db
      .insert(a2pRejectionSuggestions)
      .values({
        reasonText: s.reasonText,
        suggestedTitle: s.suggestedTitle,
        suggestedRemediation: s.suggestedRemediation,
        docUrl: s.docUrl || null,
        submittedBy: s.submittedBy ?? null,
      })
      .returning();
    return row;
  }
  async getPendingA2pRejectionSuggestionByReason(reasonText: string): Promise<A2pRejectionSuggestion | undefined> {
    const target = normalizeRejectionReason(reasonText);
    if (!target) return undefined;
    const pending = await db
      .select()
      .from(a2pRejectionSuggestions)
      .where(eq(a2pRejectionSuggestions.status, "pending"))
      .orderBy(desc(a2pRejectionSuggestions.createdAt));
    return pending.find((r) => normalizeRejectionReason(r.reasonText) === target);
  }
  async getA2pRejectionSuggestions(opts?: { status?: string }): Promise<A2pRejectionSuggestion[]> {
    if (opts?.status) {
      return await db
        .select()
        .from(a2pRejectionSuggestions)
        .where(eq(a2pRejectionSuggestions.status, opts.status))
        .orderBy(desc(a2pRejectionSuggestions.createdAt));
    }
    return await db
      .select()
      .from(a2pRejectionSuggestions)
      .orderBy(desc(a2pRejectionSuggestions.createdAt));
  }
  async updateA2pRejectionSuggestion(id: number, update: Partial<A2pRejectionSuggestion>): Promise<A2pRejectionSuggestion | undefined> {
    const [row] = await db
      .update(a2pRejectionSuggestions)
      .set(update)
      .where(eq(a2pRejectionSuggestions.id, id))
      .returning();
    return row || undefined;
  }
}

export const storage = new DatabaseStorage();
