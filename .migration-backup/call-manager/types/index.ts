export type UserRole = 'owner' | 'tech' | 'viewer';

export type CallDirection = 'inbound' | 'outbound';

export type CallStatus =
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  phone: string | null;
  created_at: string;
}

export interface Call {
  id: string;
  twilio_call_sid: string;
  direction: CallDirection;
  from_number: string;
  to_number: string;
  status: CallStatus;
  duration_seconds: number | null;
  recording_url: string | null;
  recording_sid: string | null;
  ivr_selection: string | null;
  assigned_to_user_id: string | null;
  customer_name: string | null;
  ticket_number: string | null;
  notes: string | null;
  tags: string[] | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  assigned_user?: User;
}

export interface CallEvent {
  id: string;
  call_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
}

export interface CallListParams {
  from?: string;
  to?: string;
  direction?: CallDirection;
  status?: CallStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CallListResponse {
  data: Call[];
  total: number;
  page: number;
  limit: number;
}

export interface OutboundCallRequest {
  to_number: string;
}

export interface PatchCallRequest {
  notes?: string;
  tags?: string[];
  customer_name?: string;
  ticket_number?: string;
  assigned_to_user_id?: string | null;
}

export interface ApiError {
  error: string;
  details?: string;
}

// ─── Phase 2 ─────────────────────────────────────────────────────────────────

export type BusinessHoursState = 'open' | 'closed' | 'either';
export type IvrAction = 'forward' | 'voicemail' | 'submenu' | 'queue' | 'hangup' | 'ai_assistant';
export type QueueStrategy = 'ring_all' | 'round_robin' | 'least_recent';
export type QueueTimeoutAction = 'voicemail' | 'forward';

export interface BusinessHours {
  id: string;
  day_of_week: number; // 0–6, 0=Sunday
  open_time: string | null;  // 'HH:MM:SS' or null = closed
  close_time: string | null;
  timezone: string;
  created_at: string;
}

export interface Holiday {
  id: string;
  date: string; // 'YYYY-MM-DD'
  label: string;
  closed: boolean;
  created_at: string;
}

export interface IvrMenu {
  id: string;
  name: string;
  greeting_text: string;
  greeting_audio_url: string | null;
  timeout_seconds: number;
  is_default: boolean;
  business_hours_state: BusinessHoursState;
  created_at: string;
  updated_at: string;
  options?: IvrOption[];
}

export interface IvrOption {
  id: string;
  menu_id: string;
  digit: string;
  label: string;
  action: IvrAction;
  target: string | null;
  sort_order: number;
  created_at: string;
}

export interface CallQueue {
  id: string;
  name: string;
  strategy: QueueStrategy;
  max_wait_seconds: number;
  on_timeout_action: QueueTimeoutAction;
  on_timeout_target: string | null;
  created_at: string;
  members?: QueueMember[];
}

export interface QueueMember {
  queue_id: string;
  user_id: string;
  priority: number;
  created_at: string;
  user?: User;
}

export interface Voicemail {
  id: string;
  call_id: string;
  recording_sid: string | null;
  recording_url: string;
  transcription: string | null;
  duration_seconds: number;
  is_listened: boolean;
  listened_at: string | null;
  listened_by: string | null;
  notes: string | null;
  created_at: string;
  call?: Pick<Call, 'from_number' | 'to_number' | 'started_at'>;
  recording_signed_url?: string;
}

export interface AnalyticsSummary {
  from: string;
  to: string;
  total_calls: number;
  inbound_total: number;
  inbound_answered: number;
  inbound_missed: number;
  outbound_total: number;
  answered_pct: number;
  missed_pct: number;
  avg_duration_seconds: number;
  voicemails: number;
}

export interface TimeseriesPoint {
  bucket: string; // ISO date or hour
  inbound_answered: number;
  inbound_missed: number;
  outbound: number;
}

export interface IvrDistributionEntry {
  selection: string;
  count: number;
}

export interface TopNumberEntry {
  number: string;
  count: number;
  last_call: string;
}

export interface TechPerformanceEntry {
  user_id: string;
  full_name: string;
  email: string;
  calls_handled: number;
  avg_duration_seconds: number;
  voicemails_returned: number;
}

// ── Phase 5: AI ─────────────────────────────────────────────────────────────
export type AiAssistantPurpose = 'inbound_receptionist' | 'outbound_qualifier' | 'callback_scheduler' | 'custom';
export type AiTool = 'lookup_ticket' | 'schedule_callback' | 'transfer_to_human' | 'check_business_hours';
export type AiSessionOutcome = 'transferred' | 'scheduled_callback' | 'completed' | 'abandoned' | 'escalated';
export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed';
export type CampaignCallStatus = 'pending' | 'dialing' | 'completed' | 'failed' | 'dnc_blocked' | 'cooldown_blocked' | 'outside_hours';

export interface AiAssistant {
  id: string;
  vapi_assistant_id: string | null;
  name: string;
  purpose: AiAssistantPurpose;
  system_prompt: string;
  first_message: string;
  voice_id: string;
  model: string;
  tools_enabled: AiTool[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiCallSession {
  id: string;
  call_id: string | null;
  assistant_id: string | null;
  vapi_call_id: string | null;
  transcript: unknown;
  summary: string | null;
  extracted_data: Record<string, unknown> | null;
  outcome: AiSessionOutcome | null;
  cost_cents: number | null;
  duration_sec: number | null;
  created_at: string;
  ended_at: string | null;
}

export interface OutboundCampaign {
  id: string;
  name: string;
  assistant_id: string;
  status: CampaignStatus;
  target_list: Array<{ phone_number: string; customer_name?: string; custom_fields?: Record<string, unknown> }>;
  call_window_start: string;
  call_window_end: string;
  max_calls_per_hour: number;
  dnc_check_enabled: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CampaignCall {
  id: string;
  campaign_id: string;
  phone_number: string;
  customer_name: string | null;
  custom_fields: Record<string, unknown>;
  call_id: string | null;
  status: CampaignCallStatus;
  attempt_number: number;
  scheduled_at: string | null;
  attempted_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  owner_override: boolean;
}

export interface AiSpend {
  cap_cents: number;
  spent_today_cents: number;
  paused_for_cap: boolean;
}
