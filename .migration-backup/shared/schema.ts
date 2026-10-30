import { pgTable, text, serial, integer, boolean, timestamp, jsonb, numeric, date, uniqueIndex, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Export auth schema for Replit Auth (Google OAuth, etc.)
export * from "./models/auth";

// Export booking platform schema (resources, services, availability, appointments)
export * from "./booking";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // server, workstation, laptop, network
  status: text("status").notNull().default("online"), // online, offline, warning, error
  ipAddress: text("ip_address"),
  macAddress: text("mac_address"),
  operatingSystem: text("operating_system"),
  lastSeen: timestamp("last_seen").defaultNow(),
  cpuUsage: integer("cpu_usage").default(0),
  memoryUsage: integer("memory_usage").default(0),
  diskUsage: integer("disk_usage").default(0),
  clientId: integer("client_id").references(() => clients.id),
  // MeshCentral integration fields
  meshId: text("mesh_id"), // MeshCentral device ID
  meshNodeId: text("mesh_node_id"), // MeshCentral node ID
  remoteAccessEnabled: boolean("remote_access_enabled").default(true),
  // TeamViewer integration fields
  teamviewerId: text("teamviewer_id"), // TeamViewer ID for the local client (e.g. "1 234 567 890")
  teamviewerAlias: text("teamviewer_alias"), // Optional account-side alias for the device
  preferredRemoteProvider: text("preferred_remote_provider").default("meshcentral"), // meshcentral | teamviewer
  // Enhanced monitoring fields
  networkLatency: integer("network_latency").default(0),
  uptimeHours: integer("uptime_hours").default(0),
  antivirusStatus: text("antivirus_status").default("unknown"), // protected, unprotected, unknown
  firewallStatus: text("firewall_status").default("unknown"), // enabled, disabled, unknown
  patchStatus: text("patch_status").default("current"), // current, outdated, critical
  backupStatus: text("backup_status").default("unknown"), // success, failed, pending, unknown
  lastBackup: timestamp("last_backup"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").notNull(), // critical, high, medium, low, info
  category: text("category").default("general"), // security, performance, hardware, network, backup, general
  deviceId: integer("device_id").references(() => devices.id),
  clientId: integer("client_id").references(() => clients.id),
  status: text("status").notNull().default("active"), // active, acknowledged, resolved, dismissed
  // Emergency alert fields
  isEmergency: boolean("is_emergency").default(false),
  emergencyNotificationSent: boolean("emergency_notification_sent").default(false),
  acknowledgedBy: integer("acknowledged_by").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at"),
  // Alert metadata
  alertSource: text("alert_source").default("system"), // system, monitoring, manual, external
  affectedServices: text("affected_services"), // JSON array of affected services
  estimatedDowntime: integer("estimated_downtime"), // in minutes
  businessImpact: text("business_impact"), // high, medium, low
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  subject: text("subject").notNull(),
  description: text("description"),
  priority: text("priority").notNull(), // high, medium, low
  status: text("status").notNull().default("open"), // open, in-progress, resolved, closed
  clientId: integer("client_id").references(() => clients.id),
  assignedTo: integer("assigned_to").references(() => users.id),

  // Helpdesk-style fields (osTicket parity)
  ticketNumber: text("ticket_number"), // public-facing e.g. CSD-2026-0042
  accessToken: text("access_token"), // 32-char secret for customer-portal access
  requesterName: text("requester_name"),
  requesterEmail: text("requester_email"),
  requesterPhone: text("requester_phone"),
  source: text("source").default("web"), // web, email, phone, portal, api
  departmentId: integer("department_id"),
  teamId: integer("team_id"),
  helpTopicId: integer("help_topic_id"),
  slaPlanId: integer("sla_plan_id"),
  dueAt: timestamp("due_at"),
  slaDueAt: timestamp("sla_due_at"),
  firstResponseAt: timestamp("first_response_at"),
  lockedBy: integer("locked_by").references(() => users.id),
  lockedAt: timestamp("locked_at"),
  overdueAlertSent: boolean("overdue_alert_sent").default(false),
  closedAt: timestamp("closed_at"),

  // 7-Gate Diagnostic Framework fields
  gate1EnvironmentRecon: text("gate1_environment_recon"), // OS, hardware specs (CPU/GPU/RAM), security posture
  gate2ResourceExhaustion: text("gate2_resource_exhaustion"), // Hidden processes sweeping resources
  gate3ThreatPerimeter: text("gate3_threat_perimeter"), // Spyware, keyloggers, miners, malicious extensions
  gate4ThermalPowerAudit: text("gate4_thermal_power_audit"), // Thermal throttling, fan curves, power delivery
  gate5OptimizationStrike: text("gate5_optimization_strike"), // Bloatware removal, OS hardening, driver updates
  gate6ResilienceTest: text("gate6_resilience_test"), // Benchmarks (3DMark, Cinebench), stability verification
  gate7SecureHandover: text("gate7_secure_handover"), // CSD Security Checklist, Google Contact Sync
  diagnosticComplete: boolean("diagnostic_complete").default(false),

  // CRM pipeline link — set when a ticket belongs to a deal (e.g. the
  // auto-generated onboarding ticket when a deal is marked won)
  associatedDealId: integer("associated_deal_id"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Helpdesk: departments (Support, Billing, Sales, …)
export const ticketDepartments = pgTable("ticket_departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"), // department's inbox / from-address
  isDefault: boolean("is_default").default(false),
  autoresponderEnabled: boolean("autoresponder_enabled").default(true),
  signOff: text("sign_off"), // appended to outbound emails
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: teams within a department
export const ticketTeams = pgTable("ticket_teams", {
  id: serial("id").primaryKey(),
  departmentId: integer("department_id").references(() => ticketDepartments.id),
  name: text("name").notNull(),
  leadUserId: integer("lead_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ticketTeamMembers = pgTable("ticket_team_members", {
  id: serial("id").primaryKey(),
  teamId: integer("team_id").notNull().references(() => ticketTeams.id),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: help topics (drives routing + SLA + assignment)
export const ticketHelpTopics = pgTable("ticket_help_topics", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  departmentId: integer("department_id").references(() => ticketDepartments.id),
  slaPlanId: integer("sla_plan_id"),
  autoAssignTeamId: integer("auto_assign_team_id").references(() => ticketTeams.id),
  autoAssignUserId: integer("auto_assign_user_id").references(() => users.id),
  priority: text("priority").default("medium"), // low/medium/high
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: SLA plans
export const slaPlans = pgTable("sla_plans", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  responseTimeMinutes: integer("response_time_minutes").notNull().default(60),
  resolveTimeMinutes: integer("resolve_time_minutes").notNull().default(1440),
  businessHoursOnly: boolean("business_hours_only").default(false),
  gracePeriodMinutes: integer("grace_period_minutes").default(0),
  escalatePriority: boolean("escalate_priority").default(true),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: thread messages — interleaves customer replies, staff replies, internal notes, system events
export const ticketMessages = pgTable("ticket_messages", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(), // staff, customer, system
  authorId: integer("author_id"),
  authorName: text("author_name"),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  isInternal: boolean("is_internal").default(false), // internal note vs public reply
  cannedResponseId: integer("canned_response_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: ticket activity log
export const ticketActivity = pgTable("ticket_activity", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  actorType: text("actor_type").notNull(), // staff, customer, system
  actorId: integer("actor_id"),
  actorName: text("actor_name"),
  action: text("action").notNull(), // created, assigned, transferred, status_changed, locked, unlocked, reply, note, attachment_added, sla_breach, autoresponder_sent, etc.
  details: text("details"), // JSON or text snippet
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: attachments
export const ticketAttachments = pgTable("ticket_attachments", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  messageId: integer("message_id").references(() => ticketMessages.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes").default(0),
  storagePath: text("storage_path").notNull(),
  uploadedByType: text("uploaded_by_type").default("staff"), // staff, customer, system
  uploadedById: integer("uploaded_by_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: canned responses
export const cannedResponses = pgTable("canned_responses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  departmentId: integer("department_id").references(() => ticketDepartments.id),
  isActive: boolean("is_active").default(true),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Helpdesk: email templates (auto-reply, alert, notice)
export const emailTemplates = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // ticket.autoreply, ticket.new_reply, ticket.assigned, ticket.overdue, ticket.resolved, ticket.staff_new
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Helpdesk: ticket filters (routing rules)
export const ticketFilters = pgTable("ticket_filters", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  isActive: boolean("is_active").default(true),
  priority: integer("priority").default(100), // lower = applied first
  matchType: text("match_type").notNull().default("all"), // all, any
  conditions: jsonb("conditions").notNull(), // [{field, op, value}]
  actions: jsonb("actions").notNull(), // {assignToUserId, assignToTeamId, setPriority, setDepartmentId, setHelpTopicId, setStatus, stopProcessing}
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk: global settings (singleton row id=1)
export const ticketSettings = pgTable("ticket_settings", {
  id: serial("id").primaryKey(),
  autoresponderEnabled: boolean("autoresponder_enabled").default(true),
  defaultDepartmentId: integer("default_department_id").references(() => ticketDepartments.id),
  defaultSlaPlanId: integer("default_sla_plan_id").references(() => slaPlans.id),
  maxAttachmentBytes: integer("max_attachment_bytes").default(10485760), // 10 MB
  allowedMimeTypes: text("allowed_mime_types").default(
    "image/png,image/jpeg,image/gif,application/pdf,text/plain,application/zip"
  ),
  lockExpiryMinutes: integer("lock_expiry_minutes").default(15),
  overdueAlertEnabled: boolean("overdue_alert_enabled").default(true),
  portalEnabled: boolean("portal_enabled").default(true),
  ticketNumberPrefix: text("ticket_number_prefix").default("CSD"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Owner-managed recipients for ticket/call dispatch. These definitions mirror
// runtime-safe CREATE TABLE statements in server/staff-dispatch.ts because this
// deployment cannot currently rely on drizzle-kit push.
export const staffDispatchRecipients = pgTable("staff_dispatch_recipients", {
  id: serial("id").primaryKey(),
  displayName: text("display_name").notNull(),
  phone: text("phone").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  onDuty: boolean("on_duty").notNull().default(true),
  receiveCalls: boolean("receive_calls").notNull().default(false),
  receiveMessages: boolean("receive_messages").notNull().default(true),
  canUseCommands: boolean("can_use_commands").notNull().default(true),
  linkedUserId: integer("linked_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffDispatchCorrelations = pgTable("staff_dispatch_correlations", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  recipientId: integer("recipient_id").references(() => staffDispatchRecipients.id, { onDelete: "set null" }),
  recipientPhone: text("recipient_phone").notNull(),
  dispatchedAt: timestamp("dispatched_at").notNull().defaultNow(),
  claimedAt: timestamp("claimed_at"),
});

export const staffDispatchAudit = pgTable("staff_dispatch_audit", {
  id: serial("id").primaryKey(),
  actorType: text("actor_type").notNull(),
  actorIdentity: text("actor_identity").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(),
  recipientId: integer("recipient_id"),
  ticketId: integer("ticket_id"),
  beforeSummary: jsonb("before_summary"),
  afterSummary: jsonb("after_summary"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  contactEmail: text("contact_email").notNull(),
  contactPhone: text("contact_phone"),
  emergencyContactPhone: text("emergency_contact_phone"),
  emergencyContactEmail: text("emergency_contact_email"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  // Business information
  businessHours: text("business_hours").default("9:00-17:00"), // JSON or simple format
  timezone: text("timezone").default("America/New_York"),
  criticalSystems: text("critical_systems"), // JSON array of critical system names
  // Service level agreement
  slaLevel: text("sla_level").default("standard"), // premium, standard, basic
  responseTimeMinutes: integer("response_time_minutes").default(60),
  emergencyResponseEnabled: boolean("emergency_response_enabled").default(true),
  // South Florida specific
  region: text("region").default("South Florida"),
  county: text("county"), // Broward, Dade, Palm Beach
  // MeshCentral mesh assignment
  meshGroupId: text("mesh_group_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const networkScans = pgTable("network_scans", {
  id: serial("id").primaryKey(),
  networkRange: text("network_range").notNull(),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed
  devicesFound: integer("devices_found").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

// Remote access sessions table (MeshCentral and TeamViewer)
export const remoteAccessSessions = pgTable("remote_access_sessions", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id").notNull().references(() => devices.id),
  userId: integer("user_id").references(() => users.id),
  clientId: integer("client_id").references(() => clients.id),
  provider: text("provider").notNull().default("meshcentral"), // meshcentral | teamviewer
  sessionType: text("session_type").notNull(), // desktop, terminal, files, chat
  // MeshCentral-specific
  meshSessionId: text("mesh_session_id"),
  // TeamViewer-specific
  teamviewerSessionCode: text("teamviewer_session_code"),
  teamviewerLaunchUrl: text("teamviewer_launch_url"),
  // Source context (where the session was launched from)
  sourceType: text("source_type"), // device | alert | ticket | manual
  sourceId: integer("source_id"),
  // Timing & status
  startTime: timestamp("start_time").defaultNow(),
  endTime: timestamp("end_time"),
  duration: integer("duration"), // in seconds
  status: text("status").notNull().default("active"), // active, ended, disconnected, failed
  recordingEnabled: boolean("recording_enabled").default(true),
  recordingPath: text("recording_path"),
  clientIpAddress: text("client_ip_address"),
  userAgent: text("user_agent"),
  connectionQuality: text("connection_quality"), // excellent, good, poor, unstable
  createdAt: timestamp("created_at").defaultNow(),
});

// Emergency contacts and escalation procedures
export const emergencyContacts = pgTable("emergency_contacts", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id),
  name: text("name").notNull(),
  role: text("role"), // primary, secondary, technical, management
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  priority: integer("priority").default(1), // 1 = highest priority
  availableHours: text("available_hours").default("24/7"),
  notificationMethods: text("notification_methods").default("phone,sms,email"), // JSON array
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Emergency alert log
export const emergencyAlertLog = pgTable("emergency_alert_log", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id").notNull().references(() => alerts.id),
  contactId: integer("contact_id").references(() => emergencyContacts.id),
  notificationMethod: text("notification_method").notNull(), // phone, sms, email, slack
  status: text("status").notNull(), // sent, delivered, failed, acknowledged
  attemptNumber: integer("attempt_number").default(1),
  responseReceived: boolean("response_received").default(false),
  responseTime: timestamp("response_time"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Helpdesk integration
export const helpdeskIntegrations = pgTable("helpdesk_integrations", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").references(() => clients.id),
  integrationType: text("integration_type").notNull(), // zendesk, freshdesk, servicenow, custom
  apiEndpoint: text("api_endpoint"),
  authMethod: text("auth_method"), // api_key, oauth2, basic_auth
  isActive: boolean("is_active").default(true),
  syncEnabled: boolean("sync_enabled").default(true),
  lastSyncAt: timestamp("last_sync_at"),
  syncStatus: text("sync_status").default("pending"), // success, failed, pending
  syncedTicketsCount: integer("synced_tickets_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// Patch management — admin-configured policies that drive auto-install / scheduling
export const patchPolicies = pgTable("patch_policies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  autoInstall: boolean("auto_install").default(false),
  maintenanceWindow: text("maintenance_window").default("02:00-06:00"),
  severityFilter: text("severity_filter").default("critical,important"), // CSV
  excludePatches: text("exclude_patches").default(""), // CSV of KB IDs
  testGroupPercentage: integer("test_group_percentage").default(10),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Patches observed/applied on devices (populated by MeshCentral agent reports)
export const devicePatches = pgTable("device_patches", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id").references(() => devices.id),
  kbId: text("kb_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").default("moderate"), // critical, important, moderate, low
  category: text("category").default("security"), // security, feature, driver, definition
  sizeBytes: integer("size_bytes").default(0),
  installTimeMinutes: integer("install_time_minutes").default(0),
  requiresReboot: boolean("requires_reboot").default(false),
  status: text("status").notNull().default("available"), // available, downloading, downloaded, installing, installed, failed
  releaseDate: timestamp("release_date"),
  installedAt: timestamp("installed_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Patch install/download jobs (queued operations against devices via MeshCentral)
export const patchJobs = pgTable("patch_jobs", {
  id: serial("id").primaryKey(),
  jobType: text("job_type").notNull(), // install | download
  patchIds: text("patch_ids").notNull(), // CSV of KB IDs
  deviceIds: text("device_ids").notNull(), // CSV of device row IDs
  status: text("status").notNull().default("scheduled"), // scheduled, running, completed, failed, cancelled
  scheduledFor: timestamp("scheduled_for"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  progress: integer("progress").default(0),
  errorMessage: text("error_message"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// System monitoring thresholds for automatic alerting  
export const monitoringThresholds = pgTable("monitoring_thresholds", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id").references(() => devices.id),
  clientId: integer("client_id").references(() => clients.id),
  metricType: text("metric_type").notNull(), // cpu, memory, disk, network, uptime
  warningThreshold: integer("warning_threshold").notNull(),
  criticalThreshold: integer("critical_threshold").notNull(),
  emergencyThreshold: integer("emergency_threshold"), // triggers emergency alerts
  checkInterval: integer("check_interval").default(300), // seconds
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const automationScripts = pgTable("automation_scripts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  scriptType: text("script_type").notNull(), // powershell, batch, bash
  scriptContent: text("script_content").notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertDeviceSchema = createInsertSchema(devices).omit({
  id: true,
  createdAt: true,
  lastSeen: true,
});

export const insertAlertSchema = createInsertSchema(alerts).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});

export const insertTicketSchema = createInsertSchema(tickets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertClientSchema = createInsertSchema(clients).omit({
  id: true,
  createdAt: true,
});

export const insertNetworkScanSchema = createInsertSchema(networkScans).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export const insertAutomationScriptSchema = createInsertSchema(automationScripts).omit({
  id: true,
  createdAt: true,
});

export const insertRemoteAccessSessionSchema = createInsertSchema(remoteAccessSessions).omit({
  id: true,
  createdAt: true,
  startTime: true,
  endTime: true,
  duration: true,
});

export const insertEmergencyContactSchema = createInsertSchema(emergencyContacts).omit({
  id: true,
  createdAt: true,
});
export type InsertEmergencyContact = z.infer<typeof insertEmergencyContactSchema>;
export type EmergencyContact = typeof emergencyContacts.$inferSelect;

export const insertHelpdeskIntegrationSchema = createInsertSchema(helpdeskIntegrations).omit({
  id: true,
  createdAt: true,
  lastSyncAt: true,
  syncedTicketsCount: true,
});
export type InsertHelpdeskIntegration = z.infer<typeof insertHelpdeskIntegrationSchema>;
export type HelpdeskIntegration = typeof helpdeskIntegrations.$inferSelect;

export const insertPatchPolicySchema = createInsertSchema(patchPolicies).omit({
  id: true,
  createdAt: true,
});
export type InsertPatchPolicy = z.infer<typeof insertPatchPolicySchema>;
export type PatchPolicy = typeof patchPolicies.$inferSelect;

export const insertDevicePatchSchema = createInsertSchema(devicePatches).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDevicePatch = z.infer<typeof insertDevicePatchSchema>;
export type DevicePatch = typeof devicePatches.$inferSelect;

export const insertPatchJobSchema = createInsertSchema(patchJobs).omit({
  id: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  progress: true,
});
export type InsertPatchJob = z.infer<typeof insertPatchJobSchema>;
export type PatchJob = typeof patchJobs.$inferSelect;

// CRM - Contacts (individual people)
export const crmContacts = pgTable("crm_contacts", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  mobilePhone: text("mobile_phone"),
  officePhone: text("office_phone"),
  email: text("email"),
  company: text("company"),
  contactPreference: text("contact_preference").default("text_email"), // call, text, email, text_email
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  notes: text("notes"),
  tags: text("tags"), // comma-separated or JSON array
  googleContactId: text("google_contact_id"), // Google People API resource name
  clientId: integer("client_id").references(() => clients.id), // optional link to organization
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// CRM - Leads (sales opportunities from contacts)
export const crmLeads = pgTable("crm_leads", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => crmContacts.id),
  source: text("source").notNull().default("website_intake"), // website_intake, phone_call, google_ads, referral
  campaign: text("campaign"),
  serviceType: text("service_type").notNull(),
  deviceType: text("device_type"),
  brandModel: text("brand_model"),
  operatingSystem: text("operating_system"),
  problemDescription: text("problem_description"),
  callId: text("call_id"),
  status: text("status").notNull().default("new"), // new, contacted, qualified, quoted, won, lost
  priority: text("priority").default("normal"), // low, normal, high
  assignedTo: text("assigned_to"), // technician name
  estimatedValue: integer("estimated_value"),
  notes: text("notes"),
  intakeRecordId: integer("intake_record_id"), // link to original intake if applicable
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// CRM - Jobs / Work Orders
export const crmJobs = pgTable("crm_jobs", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => crmLeads.id),
  contactId: integer("contact_id").references(() => crmContacts.id),
  jobNumber: text("job_number").notNull(), // e.g. CSD-2025-0001
  serviceType: text("service_type").notNull().default("computer_repair"),
  jobType: text("job_type").notNull().default("drop_off"), // on_site, remote, drop_off, pickup_return
  priority: text("priority").default("normal"), // low, normal, high, urgent
  status: text("status").notNull().default("open"), // open, in_progress, waiting_parts, ready_pickup, completed, cancelled
  description: text("description"),
  notes: text("notes"),
  scheduledDateTime: timestamp("scheduled_date_time"),
  completedDateTime: timestamp("completed_date_time"),
  estimatedAmount: integer("estimated_amount"),
  finalAmount: integer("final_amount"),
  technicianNotes: text("technician_notes"),
  assignedTo: text("assigned_to"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Owner-issued customer invoices. Runtime-safe DDL in server/invoice-routes.ts
// mirrors these definitions because drizzle-kit push is unavailable.
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull(),
  contactId: integer("contact_id").notNull().references(() => crmContacts.id, { onDelete: "restrict" }),
  jobId: integer("job_id").references(() => crmJobs.id, { onDelete: "set null" }),
  status: text("status").notNull().default("draft"),
  currency: text("currency").notNull().default("USD"),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  clientAddress: text("client_address"),
  jobNumber: text("job_number"),
  dueDate: date("due_date"),
  notes: text("notes"),
  paypalCheckoutUrl: text("paypal_checkout_url"),
  subtotalCents: integer("subtotal_cents").notNull(),
  taxRateBps: integer("tax_rate_bps").notNull().default(0),
  taxCents: integer("tax_cents").notNull(),
  discountCents: integer("discount_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  publicTokenHash: text("public_token_hash"),
  stripeProductId: text("stripe_product_id"),
  stripePriceId: text("stripe_price_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  checkoutCreating: boolean("checkout_creating").notNull().default(false),
  stripeCheckoutIdempotencyKey: text("stripe_checkout_idempotency_key"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  invoiceNumberUnique: uniqueIndex("invoices_invoice_number_uidx").on(table.invoiceNumber),
  publicTokenUnique: uniqueIndex("invoices_public_token_hash_uidx").on(table.publicTokenHash),
  checkoutSessionUnique: uniqueIndex("invoices_stripe_checkout_session_uidx").on(table.stripeCheckoutSessionId),
  statusCheck: check("invoices_status_check", sql`${table.status} IN ('draft','sent','paid','void')`),
  currencyCheck: check("invoices_currency_check", sql`${table.currency} = 'USD'`),
  amountsCheck: check("invoices_amounts_check", sql`${table.subtotalCents} >= 0 AND ${table.taxCents} >= 0 AND ${table.discountCents} >= 0 AND ${table.totalCents} >= 0 AND ${table.totalCents} = ${table.subtotalCents} + ${table.taxCents} - ${table.discountCents} AND ${table.taxRateBps} BETWEEN 0 AND 10000`),
}));

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitAmountCents: integer("unit_amount_cents").notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  invoicePositionUnique: uniqueIndex("invoice_line_items_invoice_position_uidx").on(table.invoiceId, table.position),
  valuesCheck: check("invoice_line_items_values_check", sql`${table.position} >= 0 AND length(${table.description}) BETWEEN 1 AND 500 AND ${table.quantity} > 0 AND ${table.unitAmountCents} >= 0 AND ${table.amountCents} = ${table.quantity} * ${table.unitAmountCents}`),
}));

export const invoicePayments = pgTable("invoice_payments", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerPaymentId: text("provider_payment_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  verified: boolean("verified").notNull().default(false),
  recordedBy: text("recorded_by"),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerPaymentUnique: uniqueIndex("invoice_payments_provider_payment_uidx").on(table.provider, table.providerPaymentId),
  invoiceIndex: index("invoice_payments_invoice_idx").on(table.invoiceId),
  providerCheck: check("invoice_payments_provider_check", sql`${table.provider} IN ('stripe','manual','paypal')`),
  valuesCheck: check("invoice_payments_values_check", sql`${table.amountCents} >= 0 AND ${table.currency} = 'USD'`),
}));

export const invoiceAuditRecords = pgTable("invoice_audit_records", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  invoiceIndex: index("invoice_audit_records_invoice_idx").on(table.invoiceId),
}));

// CRM - Interactions / Activity Log
export const crmInteractions = pgTable("crm_interactions", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => crmContacts.id),
  leadId: integer("lead_id").references(() => crmLeads.id),
  jobId: integer("job_id").references(() => crmJobs.id),
  type: text("type").notNull(), // call_in, call_out, sms, email, note, appointment, status_change, intake_form
  summary: text("summary").notNull(),
  details: text("details"),
  performedBy: text("performed_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCrmContactSchema = createInsertSchema(crmContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCrmLeadSchema = createInsertSchema(crmLeads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCrmJobSchema = createInsertSchema(crmJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedDateTime: true,
});

export const insertCrmInteractionSchema = createInsertSchema(crmInteractions).omit({
  id: true,
  createdAt: true,
});

// CRM - Deals (sales pipeline with MRR tracking; links calls/voicemails/tickets
// into one 360° timeline via their associated_deal_id columns)
export const DEAL_STAGES = ["lead", "discovery", "proposal", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const crmDeals = pgTable("crm_deals", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  companyName: text("company_name").notNull(),
  stage: text("stage").notNull().default("lead"), // lead, discovery, proposal, won, lost
  estimatedMrr: numeric("estimated_mrr", { precision: 10, scale: 2 }).notNull().default("0"),
  oneTimeFee: numeric("one_time_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  primaryContactId: integer("primary_contact_id").references(() => crmContacts.id),
  leadId: integer("lead_id").references(() => crmLeads.id), // optional origin lead
  assignedTechnicianId: integer("assigned_technician_id").references(() => users.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCrmDealSchema = createInsertSchema(crmDeals)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    stage: z.enum(DEAL_STAGES).default("lead"),
  });
export const updateCrmDealSchema = insertCrmDealSchema.partial();
export type InsertCrmDeal = z.infer<typeof insertCrmDealSchema>;
export type UpdateCrmDeal = z.infer<typeof updateCrmDealSchema>;
export type CrmDeal = typeof crmDeals.$inferSelect;

// CSD Service Logs - Repair history tracking
export const serviceLog = pgTable("service_logs", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => crmContacts.id),
  jobId: integer("job_id").references(() => crmJobs.id),
  clientName: text("client_name").notNull(),
  deviceModel: text("device_model").notNull(),
  
  // Service categories and actions
  hardwareAction: text("hardware_action"),
  hardwareResult: text("hardware_result"),
  securityAction: text("security_action"),
  securityResult: text("security_result"),
  optimizationAction: text("optimization_action"),
  optimizationResult: text("optimization_result"),
  
  // 7-Gate Diagnostic results
  gate1EnvironmentRecon: text("gate1_environment_recon"), // OS, hardware specs, security posture
  gate2ResourceExhaustion: text("gate2_resource_exhaustion"), // Hidden processes analysis
  gate3ThreatPerimeter: text("gate3_threat_perimeter"), // Spyware/malware scan results
  gate4ThermalPowerAudit: text("gate4_thermal_power_audit"), // Thermal/power issues
  gate5OptimizationStrike: text("gate5_optimization_strike"), // Bloatware removal, hardening
  gate6ResilienceTest: text("gate6_resilience_test"), // Benchmark results
  gate7SecureHandover: text("gate7_secure_handover"), // Final checklist, contact sync
  
  // Status flags
  securityHardened: boolean("security_hardened").default(false),
  googleContactSynced: boolean("google_contact_synced").default(false),
  
  // Additional notes
  technicianNotes: text("technician_notes"),
  performedBy: text("performed_by"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertServiceLogSchema = createInsertSchema(serviceLog).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Computer Systems Depot intake records
export const csdIntakeRecords = pgTable("csd_intake_records", {
  id: serial("id").primaryKey(),
  // Customer information
  customerName: text("customer_name").notNull(),
  phoneNumber: text("phone_number").notNull(),
  emailAddress: text("email_address").notNull(),
  contactPreference: text("contact_preference").notNull(), // call, text, email
  
  // Service details
  serviceType: text("service_type").notNull(),
  serviceTypeOther: text("service_type_other"), // when "Other" is selected
  deviceType: text("device_type").notNull(),
  deviceBrandModel: text("device_brand_model").notNull(),
  operatingSystem: text("operating_system").notNull(),
  problemDescription: text("problem_description").notNull(),
  
  // Marketing/source tracking
  howDidYouHear: text("how_did_you_hear").notNull(),
  
  // Call tracking
  isFromActiveCall: boolean("is_from_active_call").notNull(),
  callNotes: text("call_notes"),
  callId: text("call_id"), // Unique identifier to tie with phone system
  
  // Metadata
  source: text("source").notNull().default("Website Intake Form"), // Website Intake Form, Phone Link, etc.
  campaign: text("campaign"), // tracking campaign parameter
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  referrerUrl: text("referrer_url"),
  
  // Processing status
  status: text("status").notNull().default("new"), // new, contacted, scheduled, completed, cancelled
  assignedTo: integer("assigned_to").references(() => users.id),
  internalNotes: text("internal_notes"),
  followUpDate: timestamp("follow_up_date"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCsdIntakeSchema = createInsertSchema(csdIntakeRecords).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  assignedTo: true,
  internalNotes: true,
  followUpDate: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devices.$inferSelect;

export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alerts.$inferSelect;

export type InsertTicket = z.infer<typeof insertTicketSchema>;
export type Ticket = typeof tickets.$inferSelect;

export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clients.$inferSelect;

export type InsertNetworkScan = z.infer<typeof insertNetworkScanSchema>;
export type NetworkScan = typeof networkScans.$inferSelect;

export type InsertAutomationScript = z.infer<typeof insertAutomationScriptSchema>;
export type AutomationScript = typeof automationScripts.$inferSelect;

export type InsertRemoteAccessSession = z.infer<typeof insertRemoteAccessSessionSchema>;
export type RemoteAccessSession = typeof remoteAccessSessions.$inferSelect;

export type InsertCsdIntake = z.infer<typeof insertCsdIntakeSchema>;
export type CsdIntakeRecord = typeof csdIntakeRecords.$inferSelect;

// Helpdesk insert schemas
export const insertTicketDepartmentSchema = createInsertSchema(ticketDepartments).omit({
  id: true,
  createdAt: true,
});
export const insertTicketTeamSchema = createInsertSchema(ticketTeams).omit({
  id: true,
  createdAt: true,
});
export const insertTicketTeamMemberSchema = createInsertSchema(ticketTeamMembers).omit({
  id: true,
  createdAt: true,
});
export const insertTicketHelpTopicSchema = createInsertSchema(ticketHelpTopics).omit({
  id: true,
  createdAt: true,
});
export const insertSlaPlanSchema = createInsertSchema(slaPlans).omit({
  id: true,
  createdAt: true,
});
export const insertTicketMessageSchema = createInsertSchema(ticketMessages).omit({
  id: true,
  createdAt: true,
});
export const insertTicketActivitySchema = createInsertSchema(ticketActivity).omit({
  id: true,
  createdAt: true,
});
export const insertTicketAttachmentSchema = createInsertSchema(ticketAttachments).omit({
  id: true,
  createdAt: true,
});
export const insertCannedResponseSchema = createInsertSchema(cannedResponses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEmailTemplateSchema = createInsertSchema(emailTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTicketFilterSchema = createInsertSchema(ticketFilters).omit({
  id: true,
  createdAt: true,
});
export const insertTicketSettingsSchema = createInsertSchema(ticketSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertTicketDepartment = z.infer<typeof insertTicketDepartmentSchema>;
export type TicketDepartment = typeof ticketDepartments.$inferSelect;
export type InsertTicketTeam = z.infer<typeof insertTicketTeamSchema>;
export type TicketTeam = typeof ticketTeams.$inferSelect;
export type InsertTicketTeamMember = z.infer<typeof insertTicketTeamMemberSchema>;
export type TicketTeamMember = typeof ticketTeamMembers.$inferSelect;
export type InsertTicketHelpTopic = z.infer<typeof insertTicketHelpTopicSchema>;
export type TicketHelpTopic = typeof ticketHelpTopics.$inferSelect;
export type InsertSlaPlan = z.infer<typeof insertSlaPlanSchema>;
export type SlaPlan = typeof slaPlans.$inferSelect;
export type InsertTicketMessage = z.infer<typeof insertTicketMessageSchema>;
export type TicketMessage = typeof ticketMessages.$inferSelect;
export type InsertTicketActivity = z.infer<typeof insertTicketActivitySchema>;
export type TicketActivity = typeof ticketActivity.$inferSelect;
export type InsertTicketAttachment = z.infer<typeof insertTicketAttachmentSchema>;
export type TicketAttachment = typeof ticketAttachments.$inferSelect;
export type InsertCannedResponse = z.infer<typeof insertCannedResponseSchema>;
export type CannedResponse = typeof cannedResponses.$inferSelect;
export type InsertEmailTemplate = z.infer<typeof insertEmailTemplateSchema>;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type InsertTicketFilter = z.infer<typeof insertTicketFilterSchema>;
export type TicketFilter = typeof ticketFilters.$inferSelect;
export type InsertTicketSettings = z.infer<typeof insertTicketSettingsSchema>;
export type TicketSettings = typeof ticketSettings.$inferSelect;

export type InsertCrmContact = z.infer<typeof insertCrmContactSchema>;
export type CrmContact = typeof crmContacts.$inferSelect;

export type InsertCrmLead = z.infer<typeof insertCrmLeadSchema>;
export type CrmLead = typeof crmLeads.$inferSelect;

export type InsertCrmJob = z.infer<typeof insertCrmJobSchema>;
export type CrmJob = typeof crmJobs.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type InvoiceAuditRecord = typeof invoiceAuditRecords.$inferSelect;

export type InsertCrmInteraction = z.infer<typeof insertCrmInteractionSchema>;
export type CrmInteraction = typeof crmInteractions.$inferSelect;

export type InsertServiceLog = z.infer<typeof insertServiceLogSchema>;
export type ServiceLog = typeof serviceLog.$inferSelect;

// ARIA AI Assistant - Conversations
export const ariaConversations = pgTable("aria_conversations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  sessionId: text("session_id").notNull().unique(),
  title: text("title"),
  status: text("status").notNull().default("active"), // active, archived
  metadata: text("metadata"), // JSON: module used, context flags, etc.
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ARIA AI Assistant - Messages
export const ariaMessages = pgTable("aria_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => ariaConversations.id),
  role: text("role").notNull(), // user, assistant, system
  content: text("content").notNull(),
  contextRefs: text("context_refs"), // JSON: [{type: "client", id: 5}, {type: "ticket", id: 12}]
  moduleUsed: text("module_used"), // social_media, phone_scripts, sales, lead_tracker, faq
  tokensUsed: integer("tokens_used"),
  modelVersion: text("model_version"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAriaConversationSchema = createInsertSchema(ariaConversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertAriaMessageSchema = createInsertSchema(ariaMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertAriaConversation = z.infer<typeof insertAriaConversationSchema>;
export type AriaConversation = typeof ariaConversations.$inferSelect;

export type InsertAriaMessage = z.infer<typeof insertAriaMessageSchema>;
export type AriaMessage = typeof ariaMessages.$inferSelect;

// ===== TWILIO PHONE / SMS SETTINGS =====
// Single-row config (id=1) controlling the call/SMS forwarding pipeline.
export const twilioSettings = pgTable("twilio_settings", {
  id: serial("id").primaryKey(),
  // Phone numbers
  twilioPhoneNumber: text("twilio_phone_number").notNull().default("+19546377300"),
  forwardToNumber: text("forward_to_number").notNull().default("+19542533135"),
  // Optional fallback numbers to ring in order if the preceding number doesn't answer.
  backupForwardNumber: text("backup_forward_number").notNull().default(""),
  backupForwardNumber2: text("backup_forward_number_2").notNull().default(""),
  // Retained for database compatibility; the active call flow uses only two
  // backups, for three total forwarding numbers.
  backupForwardNumber3: text("backup_forward_number_3").notNull().default(""),
  smsForwardToNumber: text("sms_forward_to_number").notNull().default("+19542533135"),
  voicemailNotifyNumber: text("voicemail_notify_number").notNull().default("+19542533135"),
  // Voice / call flow
  callForwardingEnabled: boolean("call_forwarding_enabled").notNull().default(true),
  dialTimeoutSeconds: integer("dial_timeout_seconds").notNull().default(25),
  whisperEnabled: boolean("whisper_enabled").notNull().default(true),
  whisperVoice: text("whisper_voice").notNull().default("Polly.Joanna-Neural"),
  whisperText: text("whisper_text").notNull().default("You have a call from C S D Call Tracker."),
  // When true, the forwarded leg shows the original caller's number on your phone
  // (instead of your own Twilio number). Recommended ON.
  showCallerIdOnForward: boolean("show_caller_id_on_forward").notNull().default(true),
  // When true, the whisper announcement will include the caller's phone number
  // (e.g. "Call from 9 5 4 5 5 5 1 2 1 2") so you know who's calling before you accept.
  whisperAnnounceCaller: boolean("whisper_announce_caller").notNull().default(true),
  // Voicemail
  voicemailEnabled: boolean("voicemail_enabled").notNull().default(true),
  voicemailGreeting: text("voicemail_greeting").notNull().default(
    "Thank you for calling Computer Systems Depot. We're sorry we missed your call. Please leave your name, number, and a brief message after the tone, and we'll get back to you as soon as possible.",
  ),
  voicemailGreetingVoice: text("voicemail_greeting_voice").notNull().default("Polly.Joanna-Neural"),
  voicemailMaxLengthSeconds: integer("voicemail_max_length_seconds").notNull().default(120),
  voicemailTranscriptionEnabled: boolean("voicemail_transcription_enabled").notNull().default(true),
  // SMS forwarding + auto-reply
  smsForwardEnabled: boolean("sms_forward_enabled").notNull().default(true),
  smsAutoReplyEnabled: boolean("sms_auto_reply_enabled").notNull().default(true),
  smsAutoReplyText: text("sms_auto_reply_text").notNull().default(
    "Hi, this is Computer Systems Depot Inc. Thanks for reaching out. To get started, please complete our quick intake form: https://bit.ly/4tZm0g5\n\nWe'll follow up shortly. — CSD",
  ),
  // Post-call SMS
  postCallSmsEnabled: boolean("post_call_sms_enabled").notNull().default(true),
  postCallSmsText: text("post_call_sms_text").notNull().default(
    "Hi, this is Computer Systems Depot Inc. Thanks for calling. To get started, please complete our quick intake form: https://bit.ly/4tZm0g5\n\nWe'll follow up shortly. — CSD",
  ),
  // Intake form thank-you SMS (sent automatically after a customer submits the intake form)
  // Use {{name}} as a placeholder for the customer's first name.
  intakeSmsEnabled: boolean("intake_sms_enabled").notNull().default(true),
  intakeSmsText: text("intake_sms_text").notNull().default(
    "Hi {{name}}, this is Computer Systems Depot. Thanks for submitting your service request — we received it and will reach out shortly. Reply STOP to opt out.",
  ),
  // Business hours (Monday–Friday only by default; weekends are treated as after-hours)
  businessHoursEnabled: boolean("business_hours_enabled").notNull().default(false),
  businessHoursStart: text("business_hours_start").notNull().default("05:00"),
  businessHoursEnd: text("business_hours_end").notNull().default("23:00"),
  businessHoursTimezone: text("business_hours_timezone").notNull().default("America/New_York"),
  // CSV of weekday numbers where 1=Mon … 7=Sun (ISO). Default Mon–Fri.
  businessHoursDays: text("business_hours_days").notNull().default("1,2,3,4,5"),
  // Default to "forward" so that even when business hours are enforced, off-hours
  // and weekend callers still ring your cell first (falling through to voicemail
  // only if you miss it). Avoids the common surprise of weekend calls going
  // straight to voicemail. Options: forward | voicemail | sms_only.
  afterHoursAction: text("after_hours_action").notNull().default("forward"),
  // Google Calendar attached for the scheduling/booking flow. The id is the
  // Google calendarId (typically the email address, e.g. csdinc2000@gmail.com).
  schedulingCalendarId: text("scheduling_calendar_id"),
  // When true, busy times on the attached calendar block availability slots.
  schedulingCalendarBlockBusy: boolean("scheduling_calendar_block_busy").notNull().default(true),
  // When true, confirmed appointments are pushed to the attached calendar.
  schedulingCalendarPushEvents: boolean("scheduling_calendar_push_events").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTwilioSettingsSchema = createInsertSchema(twilioSettings).omit({
  id: true,
  updatedAt: true,
});
export const updateTwilioSettingsSchema = insertTwilioSettingsSchema.partial();
export type InsertTwilioSettings = z.infer<typeof insertTwilioSettingsSchema>;
export type UpdateTwilioSettings = z.infer<typeof updateTwilioSettingsSchema>;
export type TwilioSettings = typeof twilioSettings.$inferSelect;

// Voicemail recordings
export const voicemails = pgTable("voicemails", {
  id: serial("id").primaryKey(),
  callSid: text("call_sid").notNull(),
  recordingSid: text("recording_sid"),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  recordingUrl: text("recording_url"),
  durationSeconds: integer("duration_seconds"),
  transcription: text("transcription"),
  transcriptionStatus: text("transcription_status").default("pending"), // pending | completed | failed | disabled
  listened: boolean("listened").notNull().default(false),
  associatedDealId: integer("associated_deal_id"), // CRM pipeline link
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertVoicemailSchema = createInsertSchema(voicemails).omit({
  id: true,
  createdAt: true,
});
export type InsertVoicemail = z.infer<typeof insertVoicemailSchema>;
export type Voicemail = typeof voicemails.$inferSelect;

// Inbound call log (every Twilio call to our number)
export const callLog = pgTable("call_log", {
  id: serial("id").primaryKey(),
  callSid: text("call_sid").notNull().unique(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  fromCity: text("from_city"),
  fromState: text("from_state"),
  fromCountry: text("from_country"),
  status: text("status").notNull().default("ringing"), // ringing | in-progress | completed | no-answer | busy | failed | canceled
  direction: text("direction").default("inbound"),
  durationSeconds: integer("duration_seconds").default(0),
  hadVoicemail: boolean("had_voicemail").notNull().default(false),
  // Call-tracking attribution (populated when the To number matches a tracking_numbers row)
  trackingNumberId: integer("tracking_number_id"),
  sourceChannel: text("source_channel"),
  keywords: text("keywords"),
  recordingUrl: text("recording_url"),
  associatedDealId: integer("associated_deal_id"), // CRM pipeline link
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLog).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLog.$inferSelect;

// ===== CALL TRACKING (CallRail-style) =====
// Reusable multi-step call-handling rules. Stored as a JSON array of step objects.
// Step shapes (discriminated by `type`):
//   { type: "say",   text: string, voice?: string }
//   { type: "menu",  prompt: string, voice?: string, timeout?: number, options: [{ digit: "1", goto: number }] }
//   { type: "dial",  to: string, timeout?: number, whisper?: boolean, callerId?: "original"|"tracking" }
//   { type: "voicemail", greeting: string, voice?: string, maxLength?: number, transcribe?: boolean }
//   { type: "sms",   body: string }
//   { type: "hangup" }
//   { type: "goto",  step: number }
export const callFlows = pgTable("call_flows", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  steps: jsonb("steps").notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCallFlowSchema = createInsertSchema(callFlows).omit({ id: true, createdAt: true, updatedAt: true });
export const updateCallFlowSchema = insertCallFlowSchema.partial();
export type InsertCallFlow = z.infer<typeof insertCallFlowSchema>;
export type CallFlow = typeof callFlows.$inferSelect;

// Tracking phone numbers — each provisioned Twilio number with attribution metadata.
export const trackingNumbers = pgTable("tracking_numbers", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),  // E.164
  friendlyName: text("friendly_name"),
  twilioSid: text("twilio_sid"),                          // PNxxxx, present if provisioned via Twilio API
  numberType: text("number_type").notNull().default("local"), // local | tollfree
  // Marketing attribution
  campaignName: text("campaign_name"),
  sourceChannel: text("source_channel"),  // e.g. Google PPC, Facebook, Direct Mail, Yelp
  sourceMedium: text("source_medium"),    // cpc, organic, email, etc.
  keywords: text("keywords"),
  // Routing
  callFlowId: integer("call_flow_id"),    // FK → call_flows.id (nullable: falls back to global settings)
  forwardToNumber: text("forward_to_number"),
  smsAutoReplyEnabled: boolean("sms_auto_reply_enabled").notNull().default(false),
  smsAutoReplyText: text("sms_auto_reply_text"),
  voicemailGreeting: text("voicemail_greeting"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTrackingNumberSchema = createInsertSchema(trackingNumbers).omit({ id: true, createdAt: true, updatedAt: true });
export const updateTrackingNumberSchema = insertTrackingNumberSchema.partial();
export type InsertTrackingNumber = z.infer<typeof insertTrackingNumberSchema>;
export type TrackingNumber = typeof trackingNumbers.$inferSelect;

// SMS conversation log
export const smsMessages = pgTable("sms_messages", {
  id: serial("id").primaryKey(),
  messageSid: text("message_sid").unique(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  body: text("body").notNull(),
  direction: text("direction").notNull(), // inbound | outbound
  status: text("status").default("sent"), // queued | sent | delivered | failed | received
  errorCode: text("error_code"), // Twilio carrier error code, e.g. 30034 (unregistered A2P sender)
  trackingNumberId: integer("tracking_number_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSmsMessageSchema = createInsertSchema(smsMessages).omit({ id: true, createdAt: true });
export type InsertSmsMessage = z.infer<typeof insertSmsMessageSchema>;
export type SmsMessage = typeof smsMessages.$inferSelect;

// Staff-submitted suggestions for plain-English remediation notes for Twilio
// A2P rejection reasons that don't match any pattern in the curated KB at
// `client/src/lib/a2p-rejections.ts`. Owners/admins review these and use them
// to extend the KB in a follow-up code change.
export const a2pRejectionSuggestions = pgTable("a2p_rejection_suggestions", {
  id: serial("id").primaryKey(),
  reasonText: text("reason_text").notNull(),
  suggestedTitle: text("suggested_title").notNull(),
  suggestedRemediation: text("suggested_remediation").notNull(),
  docUrl: text("doc_url"),
  submittedBy: text("submitted_by"),
  status: text("status").notNull().default("pending"), // pending | reviewed | merged | dismissed
  reviewerNotes: text("reviewer_notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertA2pRejectionSuggestionSchema = createInsertSchema(a2pRejectionSuggestions)
  .omit({ id: true, createdAt: true, status: true, reviewerNotes: true, submittedBy: true })
  .extend({
    reasonText: z.string().trim().min(1, "Paste the rejection reason").max(2000),
    suggestedTitle: z.string().trim().min(3, "Give it a short title").max(200),
    suggestedRemediation: z.string().trim().min(10, "Add a plain-English explanation").max(2000),
    docUrl: z.string().trim().url("Must be a valid URL").max(500).optional().or(z.literal("")),
  });
export type InsertA2pRejectionSuggestion = z.infer<typeof insertA2pRejectionSuggestionSchema>;
export type A2pRejectionSuggestion = typeof a2pRejectionSuggestions.$inferSelect;

// Normalize a rejection reason for de-duplication / grouping: trim, lowercase,
// and collapse internal whitespace. Shared by the server's create-suggestion
// dedup guard and the review panel's card grouping so "verbatim" matches and
// near-identical strings (differing only in case/spacing) are treated the same.
export function normalizeRejectionReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ");
}
