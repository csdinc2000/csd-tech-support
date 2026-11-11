import {
  Compass, HeadphonesIcon, LifeBuoy, MonitorSmartphone, ShieldCheck, Wrench, Workflow,
} from "lucide-react";

export type TrainingLesson = {
  id: string;
  title: string;
  /** What the new technician should take away. */
  points: string[];
  /** Hands-on step to do in the platform before marking the lesson done. */
  practice?: string;
  /** Ids from TECH_LINK_GROUPS (`lib/tech-support-links.ts`). */
  links?: string[];
};

export type TrainingModule = {
  id: string;
  title: string;
  summary: string;
  minutes: number;
  icon: React.ComponentType<{ className?: string }>;
  lessons: TrainingLesson[];
};

/**
 * New-technician onboarding path. Content only — edit freely; progress is
 * stored per lesson id, so keep ids stable when rewording a lesson.
 */
export const TRAINING_MODULES: TrainingModule[] = [
  {
    id: "orientation",
    title: "Welcome & platform tour",
    summary: "Get access sorted and learn where everything lives.",
    minutes: 20,
    icon: Compass,
    lessons: [
      {
        id: "orientation-access",
        title: "Your account and access",
        points: [
          "Every page is gated by a staff feature (CRM, Operations, Help Desk, Communications…). If a page says \"Feature approval required\", ask the owner to enable it in Staff Roles & Access.",
          "Never share your login. Each action in the platform is tied to your account for the audit trail.",
          "Shop line: 954-637-7300 · Hours Mon–Fri 5:00 PM – 11:00 PM.",
        ],
        practice: "Open the sidebar and note which groups you can see. Tell the owner about anything you expected but is missing.",
      },
      {
        id: "orientation-board",
        title: "The Technician Board",
        points: [
          "Left column: active jobs grouped by status. Center: the day's appointments and scheduled jobs. Right: new service requests and the call log.",
          "The counters across the top flag urgent, unassigned and new work — red means it needs someone.",
          "Click any row for the full record. The board refreshes every 30 seconds.",
        ],
        practice: "Open the board, click one job and one service request, and read the detail window.",
        links: ["jobs"],
      },
      {
        id: "orientation-links",
        title: "Finding things fast",
        points: [
          "Use the Quick links row on the board for the pages you'll use daily; \"All links\" opens the full list.",
          "Bookmark this Training Portal — every lesson links straight to the page it covers.",
        ],
        links: ["training", "tech-tools", "aria"],
      },
    ],
  },
  {
    id: "repair-workflow",
    title: "The repair workflow",
    summary: "From first contact to pickup: intake, job, diagnosis, service log, close-out.",
    minutes: 35,
    icon: Workflow,
    lessons: [
      {
        id: "workflow-intake",
        title: "1 · Intake",
        points: [
          "Every customer request starts as an intake — from the website, a phone call, or a walk-in using the intake form.",
          "Capture name, best contact method, device make/model, OS and the problem in the customer's own words.",
          "New intakes show on the board's right column until someone contacts the customer.",
        ],
        practice: "Open the public intake form and walk through it (don't submit) so you know what customers see.",
        links: ["intake", "customers"],
      },
      {
        id: "workflow-job",
        title: "2 · Create and own the job",
        points: [
          "Turn the intake into a job (work order) linked to the customer's contact record.",
          "Set service type, job type (drop-off, on-site, remote) and priority honestly — urgent is for business-down or data-at-risk.",
          "Assign yourself before you start so nobody duplicates work.",
        ],
        links: ["jobs"],
      },
      {
        id: "workflow-diagnose",
        title: "3 · Diagnose with the 7-Gate checklist",
        points: [
          "Follow the 7-Gate checklist in Tech Tools on every device so diagnoses are consistent.",
          "Back up or image customer data before any destructive step.",
          "Put findings in the job's technician notes as you go, not at the end.",
        ],
        links: ["tech-tools"],
      },
      {
        id: "workflow-log",
        title: "4 · Service log and status",
        points: [
          "Record hardware, security and optimization actions in Service Logs — it's the device's history for the next tech.",
          "Move the job status as you work: Open → In Progress → Waiting on Parts → Ready for Pickup → Completed.",
          "When it's Ready for Pickup, contact the customer the same day.",
        ],
        practice: "Find a completed job and read its service log to see what a good entry looks like.",
        links: ["service-logs", "jobs"],
      },
    ],
  },
  {
    id: "remote-support",
    title: "Remote support",
    summary: "Agents, devices and running a safe remote session.",
    minutes: 25,
    icon: MonitorSmartphone,
    lessons: [
      {
        id: "remote-agent",
        title: "Getting a customer enrolled",
        points: [
          "Send customers the Agent Download page link; once installed the machine appears in Device Management.",
          "Confirm the device name and owner match the customer record before connecting.",
        ],
        links: ["download-agent", "devices"],
      },
      {
        id: "remote-session",
        title: "Running a remote session",
        points: [
          "Get the customer's consent before every session and tell them when you connect and disconnect.",
          "Never browse personal files, email or photos beyond what the fix requires.",
          "Never leave a session unattended. Log what you did in the job or service log afterward.",
        ],
        links: ["remote-access"],
      },
      {
        id: "remote-monitoring",
        title: "Monitoring and patches",
        points: [
          "Real-Time Monitoring shows alerts for enrolled devices — check it at the start of each shift.",
          "Patch Management lists pending and failed updates; failed patches usually need a remote session.",
        ],
        links: ["monitoring", "patches", "network"],
      },
    ],
  },
  {
    id: "customer-comms",
    title: "Help desk & customer communication",
    summary: "Tickets, calls, texts and email — clear, fast, and documented.",
    minutes: 20,
    icon: HeadphonesIcon,
    lessons: [
      {
        id: "comms-tickets",
        title: "Working help desk tickets",
        points: [
          "Acknowledge new tickets quickly, even if it's just to say when you'll look at it.",
          "Write replies a non-technical customer understands: what happened, what you did, what they need to do.",
        ],
        links: ["helpdesk"],
      },
      {
        id: "comms-calls",
        title: "Calls, texts and missed calls",
        points: [
          "Missed calls are flagged in red on the board — call back or text within the shift.",
          "Use the Communications Hub so every call and text is tied to the customer record.",
          "Only text customers who opted in to SMS.",
        ],
        links: ["comms", "email"],
      },
    ],
  },
  {
    id: "security-privacy",
    title: "Security, privacy & scams",
    summary: "Protect customer data and help customers avoid scams.",
    minutes: 15,
    icon: ShieldCheck,
    lessons: [
      {
        id: "security-data",
        title: "Handling customer data",
        points: [
          "Customer devices and data are confidential. Don't copy data off a device except to back it up for the repair.",
          "Never ask for or write down full card numbers, and never put passwords in job notes.",
          "Generate strong passwords with the Password tool in Tech Tools when setting up accounts.",
        ],
        links: ["tech-tools"],
      },
      {
        id: "security-scams",
        title: "Recognizing scams",
        points: [
          "Many virus-removal customers were targeted by tech-support scams — ask if anyone else connected to the computer.",
          "Share the Scam Check Guide with customers so they know the warning signs.",
        ],
        links: ["scam-guide"],
      },
    ],
  },
  {
    id: "bench-tools",
    title: "Bench tools & diagnostics",
    summary: "The calculators, commands and references in Tech Tools.",
    minutes: 20,
    icon: Wrench,
    lessons: [
      {
        id: "bench-commands",
        title: "Bench commands and cheat sheets",
        points: [
          "Bench Commands holds tested Windows commands for intake, cleanup and repair — read before you run.",
          "Cheat Sheets cover common ports, shortcuts and quick commands.",
        ],
        practice: "Open Cheat Sheets and find the port for RDP.",
        links: ["tech-tools", "cheat-sheets"],
      },
      {
        id: "bench-network",
        title: "Network check, subnet and estimates",
        points: [
          "Network Check tests a host or domain from the server; Subnet / IP helps plan customer networks.",
          "Use the Estimator to give consistent repair quotes, then put the estimate on the job.",
        ],
        links: ["tech-tools", "network"],
      },
    ],
  },
  {
    id: "getting-help",
    title: "Getting help & escalating",
    summary: "Know when to ask, and who to ask.",
    minutes: 10,
    icon: LifeBuoy,
    lessons: [
      {
        id: "help-escalate",
        title: "When to escalate",
        points: [
          "Escalate to the owner right away for: data loss risk, a customer complaint, suspected fraud or a scam in progress, or anything involving money or refunds.",
          "If you're stuck more than 30 minutes on a diagnosis, ask — note what you've tried in the job first.",
          "ARIA can help with troubleshooting steps, but double-check anything destructive.",
        ],
        links: ["aria", "calendar"],
      },
    ],
  },
];

export const TRAINING_LESSON_COUNT = TRAINING_MODULES.reduce((sum, module) => sum + module.lessons.length, 0);
