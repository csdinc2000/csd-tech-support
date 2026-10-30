# RMM + CRM Platform Design Guidelines

## Design Approach
**System:** Material Design with enterprise dashboard patterns, inspired by Linear's clean data presentation and Salesforce's CRM layouts.

**Principles:** Information density balanced with clarity, hierarchical data presentation, efficient workflows, professional credibility.

---

## Typography
- **Primary Font:** Inter (via Google Fonts CDN)
- **Monospace Font:** JetBrains Mono (for device IDs, IP addresses, logs)

**Hierarchy:**
- Hero Headlines: 3xl/4xl, semibold
- Section Titles: xl/2xl, semibold
- Card Headers: lg, medium
- Body Text: base, regular
- Data Labels: sm, medium
- Metrics/Stats: 2xl-4xl, bold
- Technical Data: sm, mono

---

## Layout System
**Spacing Primitives:** Tailwind units 2, 4, 6, 8, 12, 16
- Card padding: p-6
- Section spacing: py-12 to py-16
- Grid gaps: gap-4 to gap-6
- Component margins: mb-4 to mb-8

**Container Structure:**
- Dashboard main: max-w-7xl
- Sidebar: 16rem to 20rem width
- Data tables: full-width within container
- Forms: max-w-2xl

---

## Core Components

**Navigation:**
- Top header: Logo, search bar, notifications bell, user avatar (h-16)
- Sidebar navigation: Collapsible sections (Dashboard, Devices, Tickets, Remote, CRM, Settings)
- Mobile: Hamburger menu with slide-out drawer

**Dashboard Cards:**
- Elevated cards with subtle borders
- Stat cards: Icon + number + trend indicator + label (min-h-32)
- Chart cards: Header with date picker + visualization area (min-h-64)
- List cards: Header + scrollable content area

**Data Tables:**
- Sticky headers
- Sortable columns
- Row actions (ellipsis menu)
- Bulk selection checkboxes
- Status badges (online/offline, open/closed, active/inactive)
- Pagination footer

**Forms & Inputs:**
- Floating labels for text fields
- Grouped field sections with dividers
- Inline validation messages
- Action buttons aligned right
- Rich text editor for ticket descriptions/notes

**CRM-Specific Components:**
- Lead cards: Contact info + status pipeline + activity timeline
- Contact detail panels: Split view (info left, activity feed right)
- Work order cards: Job details + assigned tech + status + time tracking
- Activity feed: Timeline with icons, timestamps, user avatars

**Monitoring Components:**
- Device grid/list toggle view
- Device cards: Status indicator + name + specs + last seen + quick actions
- Alert banners: Color-coded severity (info/warning/critical)
- Live status indicators: Pulsing dot animations

**Ticketing Components:**
- Kanban board view: Columns for New/In Progress/Resolved
- Ticket cards: Priority flag + title + assignee avatar + timestamp
- Quick filters: Status, priority, assignee, date range
- Ticket detail: Full-page modal with comment thread

---

## Page Layouts

**Landing/Marketing Page:**
- Hero section (80vh): Large hero image showing modern IT workspace or dashboard screenshot mockup, headline "Complete RMM & CRM Platform for IT Service Providers", subtitle about unified management, two CTAs (Start Free Trial, Schedule Demo) with blurred backgrounds
- Stats bar: 4-column grid showing key metrics (devices managed, tickets resolved, uptime percentage, clients served)
- Features section: 3-column grid with icons - RMM capabilities, CRM integration, automation tools
- Platform overview: 2-column split (screenshot + feature list)
- Use case section: Tabs or cards for different business sizes
- Integration showcase: Logo grid of supported tools
- Testimonials: 2-column cards with customer photos
- Pricing table: 3-tier comparison
- Final CTA section: Dark background, centered content
- Footer: 4-column (Product, Company, Resources, Contact) + newsletter signup

**Dashboard (Logged In):**
- Header + sidebar layout
- Top metrics row: 4 stat cards (total devices, active tickets, pending leads, open jobs)
- 2-column main area:
  - Left (60%): Recent activity feed + critical alerts
  - Right (40%): Quick actions + team status
- Below: Recent tickets table
- Widget-based: Draggable/customizable

**Devices Page:**
- Filter bar: Search + status dropdown + tags
- Toggle between grid and table view
- Grid: 3-4 columns of device cards
- Table: Sortable columns (name, status, IP, last seen, OS, uptime)

**CRM Dashboard:**
- Pipeline visualization: Horizontal stages with lead counts
- Lead table: Contact, company, status, value, last contact
- Quick add lead button (floating action button)
- Activity timeline sidebar

**Ticket Detail:**
- Full-width modal or dedicated page
- Left column: Ticket info, assignee, priority, status
- Main area: Description + comment thread
- Right sidebar: Activity log + related devices/customers

---

## Images

**Hero Image:** Professional IT operations center or modern office with monitors displaying dashboards. Should convey enterprise-grade reliability and technology. Place as full-width background with gradient overlay for text readability.

**Feature Screenshots:** Dashboard interface mockups showing real data visualizations, device grids, and ticket management. Use throughout features section.

**Icons:** Material Icons via CDN for all UI icons (devices, tickets, users, settings, charts).

---

## Mobile Responsiveness
- Stack all multi-column layouts to single column
- Collapsible sidebar to hamburger menu
- Horizontal scrolling for wide tables with sticky first column
- Bottom navigation bar for primary actions
- Reduced padding: p-4 instead of p-6
- Larger touch targets: min-h-12 for buttons
- Sheet modals instead of sidebar panels