# RMM Platform

## Overview

This is a comprehensive Remote Monitoring and Management (RMM) platform providing professional-grade IT management capabilities. The system includes device monitoring, helpdesk ticketing, remote access, automation, patch management, real-time monitoring, and detailed reporting features. All external branding has been removed for a clean, professional appearance.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript
- **Build Tool**: Vite for fast development and optimized production builds
- **UI Framework**: Tailwind CSS with shadcn/ui components
- **State Management**: TanStack Query (React Query) for server state management
- **Routing**: Wouter for lightweight client-side routing
- **Styling**: CSS custom properties with professional blue/gray theme

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ES modules
- **Database**: PostgreSQL with Drizzle ORM
- **Database Provider**: Replit-managed PostgreSQL (always-on, no auto-suspend)
- **API Style**: RESTful API with JSON responses
- **Development**: Hot module replacement with Vite middleware

### Database Schema
- **ORM**: Drizzle with PostgreSQL dialect
- **Migration**: Managed through drizzle-kit
- **Schema Location**: `shared/schema.ts` with centralized type definitions
- **Tables**: users, devices, alerts, tickets, clients, automation_scripts, remote_access_sessions, emergency_contacts, emergency_alerts, helpdesk_tickets, crm_contacts, crm_leads, crm_jobs, crm_interactions

## Key Components

### Core Modules
1. **Dashboard**: Metrics overview, alerts panel, device status, quick actions
2. **Device Management**: Inventory tracking, status monitoring, resource usage
3. **Helpdesk**: Ticket system with priority levels, SLA tracking, status management
4. **Remote Access**: MeshCentral integration for actual remote desktop connections with session recording
5. **Automation**: Advanced script management and execution with patch automation
6. **Reports**: Comprehensive analytics and system health reporting
7. **Client Management**: Multi-tenant client organization with emergency contacts
8. **Real-time Monitoring**: Live system performance tracking and alerting
9. **Patch Management**: Automated Windows Updates and security patch deployment
10. **Emergency Alerts**: SMS/Email notification system via Twilio and SendGrid

### CRM Modules (NEW)
11. **CRM Dashboard**: Pipeline overview, lead status tracking, KPI cards (Total Contacts, Active Leads, Open Jobs, Pipeline Value)
12. **Contact Management**: Full CRUD for contacts (individual/business), with phone, email, address, and notes tracking
13. **Lead Pipeline**: Visual pipeline with status stages (New → Contacted → Qualified → Quoted → Won/Lost), source tracking, service type categorization
14. **Jobs/Work Orders**: Work order management with job numbers (CSD-2025-XXXX), status tracking (Open → In Progress → Waiting Parts → Completed), priority levels, estimated amounts
15. **Interactions**: Activity logging for calls, emails, meetings, and notes tied to contacts and leads

### ARIA AI Assistant
- **Full Page**: `/aria` — full conversation interface with model selector, voice controls, conversation history
- **Floating Widget**: `AriaWidget` component — available on all pages via bottom-right bubble
- **Multi-Model**: Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google) — user can switch models per message
- **Voice Input**: Web Speech API (SpeechRecognition) — browser-native, no API key needed (Chrome/Edge)
- **Voice Output (TTS)**: OpenAI TTS API via server endpoint `/api/aria/tts` — natural voices (nova, shimmer, coral, sage, etc.). Falls back to browser SpeechSynthesis if OpenAI unavailable.
- **TTS Status**: `/api/aria/tts/status` — returns available voices and whether server TTS is configured
- **Key Files**: `server/aria-service.ts`, `client/src/hooks/use-aria.ts`, `client/src/hooks/use-voice.ts`, `client/src/pages/aria.tsx`, `client/src/components/aria/aria-widget.tsx`

### UI Components
- **Layout**: Fixed header with sidebar navigation
- **Components**: Extensive shadcn/ui component library
- **Responsive**: Mobile-first design with responsive breakpoints
- **Professional UI**: Clean, unbranded interface with system status indicators

### Data Models
- **Devices**: Type, status, resource usage, client association
- **Alerts**: Severity levels, device association, resolution tracking
- **Tickets**: Priority system, client assignment, status workflow
- **Clients**: Multi-tenant organization structure
- **Users**: Role-based access control
- **Automation**: Script storage and execution tracking

## Data Flow

### Client-Server Communication
1. **API Requests**: Frontend uses TanStack Query for data fetching
2. **Error Handling**: Centralized error handling with toast notifications
3. **Real-time Updates**: Polling-based updates for dashboard metrics
4. **Authentication**: Session-based authentication (middleware ready)

### Database Operations
1. **Query Layer**: Drizzle ORM with type-safe queries
2. **Storage Interface**: Abstracted storage layer for data operations
3. **Migrations**: Schema versioning through drizzle-kit
4. **Relationships**: Foreign key relationships between entities

## External Dependencies

### Core Dependencies
- **Database**: @neondatabase/serverless for PostgreSQL connection
- **ORM**: drizzle-orm with drizzle-zod for validation
- **UI**: Extensive Radix UI primitives with shadcn/ui components
- **Utilities**: date-fns for date handling, clsx for conditional classes

### Development Tools
- **Build**: Vite with React plugin and TypeScript support
- **Development**: tsx for TypeScript execution, esbuild for production builds
- **Styling**: PostCSS with Tailwind CSS and Autoprefixer
- **Type Checking**: TypeScript with strict mode enabled

## Deployment Strategy

### Build Process
1. **Frontend**: Vite builds React app to `dist/public`
2. **Backend**: esbuild bundles server code to `dist/index.js`
3. **Database**: Drizzle migrations applied via `db:push` command
4. **Environment**: DATABASE_URL required for PostgreSQL connection

### Production Configuration
- **Server**: Express serves built frontend and API routes
- **Database**: PostgreSQL connection via environment variable
- **Static Assets**: Served from `dist/public` directory
- **Error Handling**: Production error middleware with status codes

### Development Workflow
- **Hot Reload**: Vite HMR for frontend development
- **API Development**: Express server with automatic restarts
- **Database**: Local development with remote Neon database
- **Type Safety**: Shared types between frontend and backend via `shared/` directory
- **Testing**: `npm test` runs the server test suite (`tsx --test server/__tests__/*.test.ts`). Registered as the `test` validation check so failures block merge. New server tests added under `server/__tests__/*.test.ts` are picked up automatically.

The application follows a monorepo structure with clear separation between client, server, and shared code, enabling efficient development and deployment of the RMM platform.

### Tech Tools (Technician Toolbox)
- **Page**: `/tech-tools` (Operations group in sidebar) — tabbed utilities for technicians
- **Tools**: Network checker (DNS/web-server/port), Subnet/IP calculator, Storage & data converter + transfer-time estimator, Repair time & cost estimator, Password/passphrase generator, 7-Gate diagnostic checklist (localStorage), Cheat sheets (boot keys/CMD/shortcuts/stop codes/ports)
- **Backend**: `POST /api/tech-tools/network-check` — DNS lookup + TCP reachability + optional port test. SSRF-hardened: resolves host once, rejects private/loopback/link-local/metadata/reserved IPs and localhost, connects only to validated public IP. No DB.
- **Key files**: `client/src/pages/tech-tools.tsx`, `client/src/components/tech-tools/*`

## Recent Updates

### July 2026
- **Customer-facing "Aria" support chatbot (public site)**: New floating chat bubble on the public support pages that answers questions about CSD's services, location (5601 NW 13 St, Lauderhill FL 33313), phone (954-637-7300), guarantees, and how to use `/start-service`, `/download`, `/portal`. Uses a **restricted** customer-facing system prompt (`SUPPORT_ASSISTANT_PROMPT`) with **NO internal platform data** — it never touches tickets/clients/devices/leads, and defers account-specific questions to the portal or phone. Backend method `supportChat()` in `server/aria-service.ts` tries configured AI providers in order (Gemini → ChatGPT → Claude) with per-model fallback, so one bad key/quota/deprecation doesn't break the widget. Public route `POST /api/aria/support-chat` (`server/routes.ts`) has its own rate limiter (20/min), trims to the last 12 messages and caps each at 2000 chars; allowlisted as public in `server/index.ts`. Widget `client/src/components/aria/support-chat-widget.tsx` is mounted only on public paths in `client/src/App.tsx`. Also updated the Claude model id from the deprecated `claude-sonnet-4-20250514` to `claude-sonnet-4-5-20250929` (the old id now 404s), which also un-breaks the internal `/aria` assistant.

### June 2026
- **Always-on deployment for 24/7 phone calls**: Deployment target set to `vm` (Reserved VM, always-on) instead of `autoscale`. Autoscale scales to zero when idle, which dropped inbound Twilio call webhooks ("the app keeps turning off"). VM stays running 24/7 so calls to +19546377300 always reach the forwarding webhook. Republish from the main version to apply. Note: the app is Replit-coupled (Replit Auth + boot requires `REPL_ID`/`SESSION_SECRET`/`DATABASE_URL`), so it must run on Replit, not Fly.io.
- **24/7 call forwarding (hard-coded)**: Inbound voice routing in `server/twilio-forwarding.ts` now **always forwards** every call to the owner's cell regardless of business-hours settings — the per-call `action` is hardcoded to `"forward"`, so calls ring `forwardToNumber` (or a per-tracking override) and only fall through to voicemail on no-answer. `callForwardingEnabled` is still respected (if OFF, calls go to voicemail). Minimum ring time is enforced at 25s (`Math.max(dialTimeoutSeconds, 25)`). The business-hours UI/columns and `isWithinBusinessHours()` remain but no longer affect routing. `twilioSettings.afterHoursAction` default is also `forward`.
- **Customer Remote Support Agent download flow**: New public, no-login page at `/download` (OS auto-detect, primary + secondary download buttons, 3-step guide, safety note, phone 954-637-7300) plus a "Download Remote Support Agent" card on the customer portal. Backend auto-detects the MeshCentral agent device group (no hardcoded mesh ID): `GET /api/download/status` ({available}) and `GET /api/download/agent?platform=windows|mac|linux` (302 redirect straight to the installer; customers never see the MeshCentral dashboard). Both endpoints are public (GET-only, rate-limited) and validated to known platforms; the redirect URL is built server-side from trusted config + fixed agent type IDs (windows=4, mac=10005, linux=6). Override the auto-detected group with `MESHCENTRAL_DEFAULT_MESH_ID` if needed. Key files: `server/meshcentral.ts` (`getMeshes()`), `server/meshcentral-service.ts` (`resolveAgentMeshId`, `getAgentDownloadUrl`), `server/routes.ts`, `client/src/pages/download-agent.tsx`.
- **Delete capability added to 5 modules**: Service Logs, CSD Intakes, Messages (SMS — both per-conversation and per-message), Network Discovery scans, and Remote Access session recordings. Each has a confirm-before-delete prompt and refreshes its list after deletion.
- **CSD Admin data loading fix**: Corrected `apiRequest` calls on the CSD Intakes admin page to the standard `(method, url, data)` signature so the intake list, analytics, and status updates load correctly.

### December 2025
- **Complete CRM Integration**: Added full CRM module with Contacts, Leads, Jobs/Work Orders, and Interactions tracking
- **CRM Dashboard**: Visual lead pipeline with status cards and KPI metrics
- **Contact Management**: Full CRUD for individual and business contacts with address and notes fields
- **Lead Pipeline**: Visual pipeline (New → Contacted → Qualified → Quoted → Won/Lost) with filtering and status management
- **Jobs/Work Orders**: Work order tracking with job numbers (CSD-2025-XXXX), priority levels, and estimated amounts
- **Interactions Logging**: Activity tracking for calls, emails, meetings, and notes
- **Customer Intake Form Integration**: New intake form on CRM Dashboard that automatically creates Contact, Lead, and Interaction records in one submission. Includes Latest Intakes panel showing 5 most recent leads

### January 2025
- **Complete Rebranding**: Removed all external branding for clean, professional appearance
- **MeshCentral Integration**: Added real remote access capabilities with session recording
- **Advanced Monitoring**: Implemented real-time system performance tracking
- **Patch Management**: Automated Windows Updates and security patch deployment
- **Emergency Alerts**: SMS/Email notification system via Twilio and SendGrid APIs
- **Database Enhancement**: Added comprehensive schema for production-ready client management
- **Testing Suite**: Implemented comprehensive Playwright and Node.js testing framework
- **TypeScript Optimization**: Resolved type safety issues for production readiness

### Current Status
- **System Health**: 100% (22/22 tests passing)
- **API Endpoints**: All 11 endpoints operational
- **Frontend**: All 10 pages loading correctly  
- **Integration Tests**: All 4 scenarios passing
- **TypeScript**: Production-ready with proper type safety
- **Testing**: Comprehensive test suite with Node.js and browser validation
- **Features**: Complete RMM functionality ready for production deployment
- **Atera Integration**: Network discovery, advanced monitoring, and professional services automation added
- **Deployment Status**: Ready for production deployment

### January 2026
- **7-Gate Diagnostic Framework**: Integrated into helpdesk tickets for gaming PC diagnostics (Environment Recon, Resource Exhaustion Audit, Threat Perimeter Scan, Thermal/Power Audit, Optimization Strike, Resilience Testing, Secure Handover)
- **Service Logs**: Added service_logs table for detailed repair tracking with hardware/security/optimization categories
- **Service Logs UI**: Full 7-Gate framework form with action/result pairs and technician tracking
- **Google Contacts Sync**: Full Node.js implementation with OAuth2 flow, individual and bulk sync from CRM Contacts page. Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets. After OAuth, tokens are stored and contacts can be synced to Google People API with googleContactId tracking.

### External Service Integration
- **MeshCentral**: Client wired to a self-hosted MeshCentral server (see `docs/meshcentral-setup.md`). Set `MESHCENTRAL_URL`, `MESHCENTRAL_USERNAME`, `MESHCENTRAL_PASSWORD` (or `MESHCENTRAL_API_KEY`). When unset, `/api/meshcentral/status` returns `not_configured` and `/api/meshcentral/devices` returns `[]` — no mock data.
- **Emergency Alerts**: SMS/Email system via Twilio and SendGrid (API keys pending)
- **Slack Integration**: Team notifications ready (API keys pending)
- **Real-time Monitoring**: Advanced system performance tracking active
- **Professional Services**: Complete IT management automation suite
- **Google Contacts API**: Ready for People API integration (OAuth2 credentials needed)