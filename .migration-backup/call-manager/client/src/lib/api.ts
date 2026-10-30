import axios from 'axios';
import { supabase } from './supabase.js';
import type {
  Call,
  CallListResponse,
  CallListParams,
  PatchCallRequest,
  User,
  BusinessHours,
  Holiday,
  IvrMenu,
  IvrOption,
  CallQueue,
  Voicemail,
  AnalyticsSummary,
  TimeseriesPoint,
  IvrDistributionEntry,
  TopNumberEntry,
  TechPerformanceEntry,
} from '../../../types/index.js';

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  return { Authorization: `Bearer ${token}` };
}

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(async (config) => {
  const headers = await getAuthHeader();
  config.headers.Authorization = headers.Authorization;
  return config;
});

// ── Calls ─────────────────────────────────────────────────────────────────────

export async function listCalls(params: CallListParams): Promise<CallListResponse> {
  const { data } = await api.get<CallListResponse>('/calls', { params });
  return data;
}

export async function getCall(id: string): Promise<Call & { recording_signed_url?: string; events: unknown[] }> {
  const { data } = await api.get(`/calls/${id}`);
  return data;
}

export async function patchCall(id: string, body: PatchCallRequest): Promise<Call> {
  const { data } = await api.patch<Call>(`/calls/${id}`, body);
  return data;
}

export function buildCsvExportUrl(params: CallListParams): string {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
  return `/api/calls/export.csv?${q.toString()}`;
}

export async function initiateOutbound(toNumber: string): Promise<{ call_sid: string; call_id: string }> {
  const { data } = await api.post('/calls/outbound', { to_number: toNumber });
  return data;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function getMe(): Promise<User> {
  const { data } = await api.get<User>('/me');
  return data;
}

export async function listUsers(): Promise<User[]> {
  const { data } = await api.get<User[]>('/users');
  return data;
}

export async function updateUser(id: string, body: Partial<Pick<User, 'full_name' | 'phone' | 'role'>>): Promise<User> {
  const { data } = await api.patch<User>(`/users/${id}`, body);
  return data;
}

export async function inviteUser(email: string, role: string, full_name: string): Promise<void> {
  await api.post('/users/invite', { email, role, full_name });
}

// ── Phase 2: Admin — Business Hours ──────────────────────────────────────────

export async function listBusinessHours(): Promise<BusinessHours[]> {
  const { data } = await api.get<BusinessHours[]>('/admin/business-hours');
  return data;
}

export async function saveBusinessHours(rows: Array<Pick<BusinessHours, 'day_of_week' | 'open_time' | 'close_time' | 'timezone'>>): Promise<void> {
  await api.put('/admin/business-hours', rows);
}

// ── Phase 2: Admin — Holidays ────────────────────────────────────────────────

export async function listHolidays(): Promise<Holiday[]> {
  const { data } = await api.get<Holiday[]>('/admin/holidays');
  return data;
}

export async function addHoliday(date: string, label: string, closed = true): Promise<Holiday> {
  const { data } = await api.post<Holiday>('/admin/holidays', { date, label, closed });
  return data;
}

export async function deleteHoliday(id: string): Promise<void> {
  await api.delete(`/admin/holidays/${id}`);
}

// ── Phase 2: Admin — IVR ─────────────────────────────────────────────────────

export async function listIvrMenus(): Promise<IvrMenu[]> {
  const { data } = await api.get<IvrMenu[]>('/admin/ivr-menus');
  return data;
}

export async function createIvrMenu(menu: Partial<IvrMenu>): Promise<IvrMenu> {
  const { data } = await api.post<IvrMenu>('/admin/ivr-menus', menu);
  return data;
}

export async function updateIvrMenu(id: string, updates: Partial<IvrMenu>): Promise<IvrMenu> {
  const { data } = await api.patch<IvrMenu>(`/admin/ivr-menus/${id}`, updates);
  return data;
}

export async function deleteIvrMenu(id: string): Promise<void> {
  await api.delete(`/admin/ivr-menus/${id}`);
}

export async function createIvrOption(opt: Partial<IvrOption>): Promise<IvrOption> {
  const { data } = await api.post<IvrOption>('/admin/ivr-options', opt);
  return data;
}

export async function updateIvrOption(id: string, updates: Partial<IvrOption>): Promise<IvrOption> {
  const { data } = await api.patch<IvrOption>(`/admin/ivr-options/${id}`, updates);
  return data;
}

export async function deleteIvrOption(id: string): Promise<void> {
  await api.delete(`/admin/ivr-options/${id}`);
}

// ── Phase 2: Admin — Queues ──────────────────────────────────────────────────

export async function listQueues(): Promise<CallQueue[]> {
  const { data } = await api.get<CallQueue[]>('/admin/queues');
  return data;
}

export async function createQueue(q: Partial<CallQueue>): Promise<CallQueue> {
  const { data } = await api.post<CallQueue>('/admin/queues', q);
  return data;
}

export async function updateQueue(id: string, updates: Partial<CallQueue>): Promise<CallQueue> {
  const { data } = await api.patch<CallQueue>(`/admin/queues/${id}`, updates);
  return data;
}

export async function deleteQueue(id: string): Promise<void> {
  await api.delete(`/admin/queues/${id}`);
}

export async function addQueueMember(queueId: string, userId: string, priority = 0): Promise<void> {
  await api.post(`/admin/queues/${queueId}/members`, { user_id: userId, priority });
}

export async function removeQueueMember(queueId: string, userId: string): Promise<void> {
  await api.delete(`/admin/queues/${queueId}/members/${userId}`);
}

// ── Phase 2: Voicemails ──────────────────────────────────────────────────────

export async function listVoicemails(params: { unlistened?: boolean; from?: string; to?: string } = {}): Promise<Voicemail[]> {
  const { data } = await api.get<Voicemail[]>('/voicemails', { params });
  return data;
}

export async function patchVoicemail(id: string, body: { is_listened?: boolean; notes?: string }): Promise<Voicemail> {
  const { data } = await api.patch<Voicemail>(`/voicemails/${id}`, body);
  return data;
}

// ── Phase 2: Analytics ───────────────────────────────────────────────────────

export async function getAnalyticsSummary(from: string, to: string): Promise<AnalyticsSummary> {
  const { data } = await api.get<AnalyticsSummary>('/analytics/summary', { params: { from, to } });
  return data;
}

export async function getAnalyticsTimeseries(
  from: string,
  to: string,
  granularity: 'hour' | 'day' = 'day',
): Promise<{ granularity: string; points: TimeseriesPoint[]; hour_of_day: { hour: number; calls: number }[] }> {
  const { data } = await api.get('/analytics/timeseries', { params: { from, to, granularity } });
  return data;
}

export async function getIvrDistribution(from: string, to: string): Promise<IvrDistributionEntry[]> {
  const { data } = await api.get<IvrDistributionEntry[]>('/analytics/ivr-distribution', { params: { from, to } });
  return data;
}

export async function getTopNumbers(from: string, to: string): Promise<TopNumberEntry[]> {
  const { data } = await api.get<TopNumberEntry[]>('/analytics/top-numbers', { params: { from, to } });
  return data;
}

export async function getTechPerformance(from: string, to: string): Promise<TechPerformanceEntry[]> {
  const { data } = await api.get<TechPerformanceEntry[]>('/analytics/tech-performance', { params: { from, to } });
  return data;
}

export function buildAnalyticsCsvUrl(from: string, to: string): string {
  return `/api/analytics/export.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

// ── Phase 3: Messages ────────────────────────────────────────────────────────

export interface Message {
  id: string;
  twilio_message_sid: string | null;
  direction: 'inbound' | 'outbound';
  from_number: string;
  to_number: string;
  body: string;
  status: string;
  error_code: string | null;
  media_urls: string[] | null;
  sent_by_user_id: string | null;
  thread_key: string;
  related_call_id: string | null;
  created_at: string;
}

export interface MessageThreadSummary {
  thread_key: string;
  last_message: Message;
  total: number;
}

export async function listMessageThreads(): Promise<MessageThreadSummary[]> {
  const { data } = await api.get<MessageThreadSummary[]>('/messages');
  return data;
}

export async function getMessageThread(
  threadKey: string,
): Promise<{ thread_key: string; messages: Message[]; contact: { customer_name: string | null; ticket_number: string | null } }> {
  const { data } = await api.get(`/messages/thread/${encodeURIComponent(threadKey)}`);
  return data;
}

export async function sendMessage(payload: {
  to_number: string;
  body?: string;
  template_id?: string;
  media_urls?: string[];
}): Promise<Message> {
  const { data } = await api.post<Message>('/messages', payload);
  return data;
}

// ── Phase 3: Templates ───────────────────────────────────────────────────────

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  shared: boolean;
  created_by: string | null;
  created_at: string;
}

export async function listTemplates(): Promise<MessageTemplate[]> {
  const { data } = await api.get<MessageTemplate[]>('/templates');
  return data;
}
export async function createTemplate(t: { name: string; body: string; shared?: boolean }): Promise<MessageTemplate> {
  const { data } = await api.post<MessageTemplate>('/templates', t);
  return data;
}
export async function updateTemplate(id: string, t: Partial<{ name: string; body: string; shared: boolean }>): Promise<MessageTemplate> {
  const { data } = await api.patch<MessageTemplate>(`/templates/${id}`, t);
  return data;
}
export async function deleteTemplate(id: string): Promise<void> {
  await api.delete(`/templates/${id}`);
}

// ── Phase 3: Blacklist ───────────────────────────────────────────────────────

export interface BlacklistEntry {
  id: string;
  phone_number: string;
  reason: string | null;
  blocks_calls: boolean;
  blocks_sms: boolean;
  added_by: string | null;
  created_at: string;
}

export async function listBlacklist(): Promise<BlacklistEntry[]> {
  const { data } = await api.get<BlacklistEntry[]>('/blacklist');
  return data;
}
export async function addBlacklist(entry: {
  phone_number: string;
  reason?: string;
  blocks_calls?: boolean;
  blocks_sms?: boolean;
}): Promise<BlacklistEntry> {
  const { data } = await api.post<BlacklistEntry>('/blacklist', entry);
  return data;
}
export async function deleteBlacklist(id: string): Promise<void> {
  await api.delete(`/blacklist/${id}`);
}

// ── Phase 3: DNC ─────────────────────────────────────────────────────────────

export interface DncEntry {
  id: string;
  phone_number: string;
  source: 'manual' | 'customer_request' | 'national_dnc';
  notes: string | null;
  created_at: string;
}

export async function listDnc(): Promise<DncEntry[]> {
  const { data } = await api.get<DncEntry[]>('/dnc');
  return data;
}
export async function addDnc(entry: {
  phone_number: string;
  source?: 'manual' | 'customer_request' | 'national_dnc';
  notes?: string;
}): Promise<DncEntry> {
  const { data } = await api.post<DncEntry>('/dnc', entry);
  return data;
}
export async function importDncCsv(csv: string): Promise<{ imported: number }> {
  const { data } = await api.post<{ imported: number }>('/dnc/import', { csv });
  return data;
}
export async function deleteDnc(id: string): Promise<void> {
  await api.delete(`/dnc/${id}`);
}

// ── Phase 3: Spam ────────────────────────────────────────────────────────────

export interface SpamScore {
  phone_number: string;
  score: number;
  sources: Record<string, unknown>;
  cached?: boolean;
  last_checked: string;
}

export async function checkSpamApi(phone_number: string, force = false): Promise<SpamScore> {
  const { data } = await api.post<SpamScore>('/spam/check', { phone_number, force });
  return data;
}
export async function listRecentSpam(): Promise<SpamScore[]> {
  const { data } = await api.get<SpamScore[]>('/spam/recent');
  return data;
}
export async function getSpamSettings(): Promise<{ threshold: number; screening_enabled: boolean }> {
  const { data } = await api.get<{ threshold: number; screening_enabled: boolean }>('/spam/settings');
  return data;
}
export async function updateSpamSettings(s: { threshold?: number; screening_enabled?: boolean }): Promise<void> {
  await api.put('/spam/settings', s);
}

// ── Phase 3: SSE for real-time messages ──────────────────────────────────────

/**
 * Open an EventSource for real-time message updates. The browser EventSource
 * API doesn't support custom headers, so we pass the access token via a
 * one-time query string. The server route requireAuth must accept either.
 *
 * Caller is responsible for calling .close() on the returned EventSource.
 */
// ── Phase 4: Organizations ───────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  parent_org_id: string | null;
  twilio_subaccount_sid: string | null;
  settings: Record<string, unknown>;
  created_at: string;
}
export interface OrgMembership {
  role: 'owner' | 'admin' | 'tech' | 'viewer';
  org: Organization;
}
export async function listOrganizations(): Promise<Organization[]> {
  const { data } = await api.get<Organization[]>('/organizations');
  return data;
}
export async function listMyOrganizations(): Promise<OrgMembership[]> {
  const { data } = await api.get<OrgMembership[]>('/me/organizations');
  return data;
}
export async function createOrganization(o: Partial<Organization>): Promise<Organization> {
  const { data } = await api.post<Organization>('/organizations', o);
  return data;
}
export async function updateOrganization(id: string, o: Partial<Organization>): Promise<Organization> {
  const { data } = await api.patch<Organization>(`/organizations/${id}`, o);
  return data;
}
export async function deleteOrganization(id: string): Promise<void> {
  await api.delete(`/organizations/${id}`);
}
export async function listOrgMembers(orgId: string): Promise<Array<{ role: string; user: { id: string; email: string; full_name: string | null; phone: string | null; is_active: boolean } }>> {
  const { data } = await api.get(`/organizations/${orgId}/members`);
  return data;
}
export async function addOrgMember(orgId: string, userId: string, role: string): Promise<void> {
  await api.post(`/organizations/${orgId}/members`, { user_id: userId, role });
}
export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
  await api.delete(`/organizations/${orgId}/members/${userId}`);
}

// ── Phase 4: Invitations ─────────────────────────────────────────────────────

export interface Invitation {
  id: string;
  email: string;
  org_id: string;
  role: string;
  invited_by: string | null;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  org?: { id: string; name: string };
}
export async function listInvitations(): Promise<Invitation[]> {
  const { data } = await api.get<Invitation[]>('/invitations');
  return data;
}
export async function createInvitation(p: { email: string; role: string; org_id?: string }): Promise<{ invitation: Invitation; accept_url: string; email_sent: boolean; email_suppressed: boolean; email_error: string | null }> {
  const { data } = await api.post('/invitations', p);
  return data;
}
export async function acceptInvitation(p: { token: string; password: string; full_name: string }): Promise<{ ok: boolean; user_id: string }> {
  const { data } = await api.post('/invitations/accept', p);
  return data;
}
export async function deleteInvitation(id: string): Promise<void> {
  await api.delete(`/invitations/${id}`);
}

// ── Phase 4: Email Templates ─────────────────────────────────────────────────

export interface EmailTemplate {
  id: string;
  org_id: string | null;
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
  trigger: 'manual' | 'missed_call' | 'voicemail_received' | 'new_customer' | 'daily_digest' | 'invitation';
  created_at: string;
  updated_at: string;
}
export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const { data } = await api.get<EmailTemplate[]>('/email-templates');
  return data;
}
export async function createEmailTemplate(t: Partial<EmailTemplate>): Promise<EmailTemplate> {
  const { data } = await api.post<EmailTemplate>('/email-templates', t);
  return data;
}
export async function updateEmailTemplate(id: string, t: Partial<EmailTemplate>): Promise<EmailTemplate> {
  const { data } = await api.patch<EmailTemplate>(`/email-templates/${id}`, t);
  return data;
}
export async function deleteEmailTemplate(id: string): Promise<void> {
  await api.delete(`/email-templates/${id}`);
}
export async function previewEmailTemplate(p: { subject: string; body_html: string; body_text: string; context: Record<string, unknown> }): Promise<{ subject: string; body_html: string; body_text: string }> {
  const { data } = await api.post('/email-templates/preview', p);
  return data;
}
export async function testSendEmailTemplate(id: string, p: { to?: string; context?: Record<string, unknown> }): Promise<{ ok: boolean; suppressed: boolean; error: string | null; to: string }> {
  const { data } = await api.post(`/email-templates/${id}/test-send`, p);
  return data;
}

// ── Phase 4: Notification Settings ───────────────────────────────────────────

export interface NotificationSettings {
  user_id: string;
  missed_call_email: boolean;
  missed_call_sms: boolean;
  voicemail_email: boolean;
  voicemail_sms: boolean;
  daily_digest_email: boolean;
  daily_digest_time: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  unsubscribe_token: string;
  updated_at: string;
}
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const { data } = await api.get<NotificationSettings>('/notification-settings');
  return data;
}
export async function updateNotificationSettings(s: Partial<NotificationSettings>): Promise<NotificationSettings> {
  const { data } = await api.patch<NotificationSettings>('/notification-settings', s);
  return data;
}
export async function testNotification(channels: { email?: boolean; sms?: boolean }): Promise<{ queued: number; sent: number; failed: number }> {
  const { data } = await api.post('/notifications/test', { channels });
  return data;
}
export interface NotificationLogEntry {
  id: string;
  channel: 'email' | 'sms';
  trigger: string;
  to_address: string;
  subject: string | null;
  status: 'queued' | 'sent' | 'failed' | 'suppressed';
  delivered_at: string | null;
  error_message: string | null;
  created_at: string;
}
export async function listNotificationLog(): Promise<NotificationLogEntry[]> {
  const { data } = await api.get<NotificationLogEntry[]>('/notifications/log');
  return data;
}

// ── Phase 4: Integrations ────────────────────────────────────────────────────

export interface IntegrationsHealth {
  timestamp: string;
  supabase: { ok: boolean; error: string | null };
  twilio: { ok: boolean; account_sid?: string; friendly_name?: string; status?: string; phone_number?: string; error?: string };
  email: { ok: boolean; provider: string };
  last_voice_webhook: string | null;
  last_inbound_sms: string | null;
}
export async function getIntegrationsHealth(): Promise<IntegrationsHealth> {
  const { data } = await api.get<IntegrationsHealth>('/integrations/health');
  return data;
}
export async function testTwilio(): Promise<{ ok: boolean; account_sid?: string; friendly_name?: string; status?: string; error?: string }> {
  const { data } = await api.post('/integrations/twilio/test');
  return data;
}
export async function testEmail(to: string): Promise<{ ok: boolean; suppressed?: boolean; error?: string }> {
  const { data } = await api.post('/integrations/email/test', { to });
  return data;
}

// ── Phase 4: User extras (deactivate, role audit) ────────────────────────────

export async function setUserActive(id: string, is_active: boolean): Promise<void> {
  await api.patch(`/users/${id}`, { is_active });
}
export async function listRoleAudit(userId: string): Promise<Array<{ id: string; old_role: string | null; new_role: string; created_at: string; changer?: { email: string; full_name: string | null } }>> {
  const { data } = await api.get(`/users/${userId}/role-audit`);
  return data;
}

export async function openMessagesStream(): Promise<EventSource> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  // We use a header-based scheme; EventSource doesn't allow custom headers, so
  // we build a fetch-stream polyfill-friendly URL. Browsers will send the
  // Supabase cookie which the server will validate. As a fallback we include
  // the token as a query parameter (server can be extended to read it).
  const url = `/api/messages/stream?access_token=${encodeURIComponent(token)}`;
  return new EventSource(url, { withCredentials: true });
}

// ── Phase 5: AI assistants / sessions / campaigns ───────────────────────────
import type {
  AiAssistant, AiCallSession, OutboundCampaign, CampaignCall, AiSpend,
} from '../../../types/index.js';

export async function listAiAssistants(): Promise<{ items: AiAssistant[]; vapi_configured: boolean }> {
  const { data } = await api.get('/ai/assistants');
  return data;
}
export async function createAiAssistant(body: Partial<AiAssistant>): Promise<AiAssistant> {
  const { data } = await api.post('/ai/assistants', body);
  return data;
}
export async function updateAiAssistant(id: string, body: Partial<AiAssistant>): Promise<AiAssistant> {
  const { data } = await api.patch(`/ai/assistants/${id}`, body);
  return data;
}
export async function deleteAiAssistant(id: string): Promise<void> {
  await api.delete(`/ai/assistants/${id}`);
}
export async function testCallAssistant(id: string, to_number: string): Promise<{ ok: boolean; vapi_call_id?: string }> {
  const { data } = await api.post(`/ai/assistants/${id}/test-call`, { to_number });
  return data;
}

export async function listAiSessions(search?: string): Promise<{ items: AiCallSession[] }> {
  const { data } = await api.get('/ai/sessions', { params: search ? { search } : {} });
  return data;
}
export async function getAiSession(id: string): Promise<AiCallSession> {
  const { data } = await api.get(`/ai/sessions/${id}`);
  return data;
}
export async function getAiSpend(): Promise<AiSpend> {
  const { data } = await api.get('/ai/spend');
  return data;
}
export async function setAiSpendCap(cap_cents: number): Promise<{ cap_cents: number }> {
  const { data } = await api.post('/ai/spend/cap', { cap_cents });
  return data;
}

export async function listAiCampaigns(): Promise<{ items: OutboundCampaign[] }> {
  const { data } = await api.get('/ai/campaigns');
  return data;
}
export async function getAiCampaign(id: string): Promise<OutboundCampaign & { calls: CampaignCall[] }> {
  const { data } = await api.get(`/ai/campaigns/${id}`);
  return data;
}
export async function createAiCampaign(body: {
  name: string; assistant_id: string;
  call_window_start?: string; call_window_end?: string; max_calls_per_hour?: number;
  targets: Array<{ phone_number: string; customer_name?: string; owner_override?: boolean }>;
}): Promise<OutboundCampaign> {
  const { data } = await api.post('/ai/campaigns', body);
  return data;
}
export async function setAiCampaignStatus(id: string, status: 'draft' | 'running' | 'paused' | 'completed'): Promise<OutboundCampaign> {
  const { data } = await api.post(`/ai/campaigns/${id}/status`, { status });
  return data;
}
export async function deleteAiCampaign(id: string): Promise<void> {
  await api.delete(`/ai/campaigns/${id}`);
}
