import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ShieldCheck,
  Monitor,
  Eye,
  MessageCircle,
  PhoneCall,
  Bot,
  Lock,
  ClipboardList,
  Users,
} from "lucide-react";

const notices = [
  {
    icon: Monitor,
    title: "RMM Authorization",
    body: "Monitoring and remote actions are available only for authorized customer devices covered by a service agreement, ticket approval, or written consent.",
  },
  {
    icon: Eye,
    title: "Remote Access Consent",
    body: "Start remote access only after client approval or under an active managed-service authorization. All remote sessions are logged, and MeshCentral sessions may be recorded.",
  },
  {
    icon: Bot,
    title: "ARIA AI Disclaimer",
    body: "ARIA provides AI-assisted support suggestions. ARIA does not provide legal, tax, medical, credit repair, or financial advice. Material technical actions require human review and authorization.",
  },
  {
    icon: MessageCircle,
    title: "SMS Consent",
    body: "Service messages may include appointment reminders, ticket updates, technician arrival notices, invoices, and account notices. Marketing messages require separate consent. Customers may opt out of non-essential texts by replying STOP.",
  },
  {
    icon: PhoneCall,
    title: "Call Recording",
    body: "Calls may be recorded or monitored for quality assurance, training, security, and service documentation where permitted and with required consent. Florida requires all-party consent for call recording.",
  },
  {
    icon: Lock,
    title: "Privacy & Security",
    body: "CSD uses reasonable administrative, technical, and physical safeguards to protect customer information. Access is limited to authorized personnel and service purposes. CSD does not guarantee perfect uptime, perfect security, perfect data recovery, or prevention of every breach.",
  },
];

export default function CompliancePage() {
  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6" data-testid="page-compliance">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Compliance Center</h1>
        <p className="text-gray-600">
          Authorization, consent, and disclosure standards for Computer Systems Depot Inc service
          operations. Compliance-aware guidance only — attorney review recommended before relying
          on this language.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {notices.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="h-4 w-4 text-csd-red" />
                {title}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-gray-600">{body}</CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4 text-csd-red" />
              Audit Trail
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gray-600">
            Per-action service records are kept in{" "}
            <Link href="/service-logs" className="font-medium text-csd-red hover:underline">
              Service Logs
            </Link>
            , and remote sessions are recorded on the Remote Access page. Log the user, timestamp,
            device, client, and result for every material action.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-csd-red" />
              Role-Based Access Control
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gray-600">
            Admin access is enforced server-side via the <code>ADMIN_EMAILS</code> allowlist
            (fails closed), with owner-only actions gated separately. Finer-grained roles
            (technician, billing, client, viewer) are planned: this module is prepared for secure
            implementation — connect backend services, permissions, and audit logging before
            production use.
          </CardContent>
        </Card>
      </div>

      <p className="flex items-start gap-2 text-xs text-gray-500">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-csd-red" />
        This page documents operating standards; it is not legal advice and does not guarantee
        legal compliance. Production review and attorney review are recommended before public
        launch.
      </p>
    </div>
  );
}
