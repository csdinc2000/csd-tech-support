import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "wouter";
import {
  TrendingUp,
  Users,
  Briefcase,
  DollarSign,
  ArrowUp,
  ArrowRight,
  UserPlus,
  CheckCircle,
  Clock,
  Target,
  Plus,
  FileText,
  Wrench,
  PackageSearch,
} from "lucide-react";
import CsdIntakeForm from "@/components/forms/csd-intake-form";
import type { CrmLead } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell, PageContent } from "@/components/layout/page-shell";
import { cn } from "@/lib/utils";

interface DashboardData {
  totalContacts: number;
  totalLeads: number;
  totalJobs: number;
  newLeadsLast7Days: number;
  completedJobsLast30Days: number;
  pipelineValue: number;
  conversionRate: number;
  leadsByStatus: {
    new: number;
    contacted: number;
    qualified: number;
    quoted: number;
    won: number;
    lost: number;
  };
  jobsByStatus: {
    open: number;
    in_progress: number;
    waiting_parts: number;
    completed: number;
  };
}

const EMPTY_DATA: DashboardData = {
  totalContacts: 0,
  totalLeads: 0,
  totalJobs: 0,
  newLeadsLast7Days: 0,
  completedJobsLast30Days: 0,
  pipelineValue: 0,
  conversionRate: 0,
  leadsByStatus: { new: 0, contacted: 0, qualified: 0, quoted: 0, won: 0, lost: 0 },
  jobsByStatus: { open: 0, in_progress: 0, waiting_parts: 0, completed: 0 },
};

type Stat = {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "blue" | "green" | "amber" | "purple";
  hint?: React.ReactNode;
  testId: string;
  valueTestId: string;
};

const toneClasses: Record<Stat["tone"], { tile: string; icon: string }> = {
  blue: { tile: "bg-blue-50 ring-blue-100", icon: "text-blue-600" },
  green: { tile: "bg-green-50 ring-green-100", icon: "text-green-600" },
  amber: { tile: "bg-amber-50 ring-amber-100", icon: "text-amber-600" },
  purple: { tile: "bg-purple-50 ring-purple-100", icon: "text-purple-600" },
};

function StatCard({ stat }: { stat: Stat }) {
  const Icon = stat.icon;
  const tone = toneClasses[stat.tone];
  return (
    <Card data-testid={stat.testId} className="border-gray-200/80 transition-shadow hover:shadow-md">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{stat.label}</div>
            <div className="mt-1 text-2xl font-bold text-gray-900" data-testid={stat.valueTestId}>
              {stat.value}
            </div>
            {stat.hint && <div className="mt-2 text-xs text-gray-600">{stat.hint}</div>}
          </div>
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1", tone.tile)}>
            <Icon className={cn("h-5 w-5", tone.icon)} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CrmDashboardSkeleton({ embedded = false }: { embedded?: boolean }) {
  return (
    <PageShell className={embedded ? "min-h-0 bg-transparent" : undefined}>
      {!embedded && (
        <div className="border-b border-gray-200 bg-white px-4 py-5 md:px-6">
          <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
          <div className="mt-2 h-4 w-72 animate-pulse rounded bg-gray-100" />
        </div>
      )}
      <PageContent className={embedded ? "p-0" : undefined}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-white shadow-sm" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-lg bg-white shadow-sm" />
          <div className="h-72 animate-pulse rounded-lg bg-white shadow-sm" />
        </div>
      </PageContent>
    </PageShell>
  );
}

const stageColor: Record<string, { bar: string; text: string }> = {
  new: { bar: "bg-blue-500", text: "text-blue-700" },
  contacted: { bar: "bg-indigo-500", text: "text-indigo-700" },
  qualified: { bar: "bg-purple-500", text: "text-purple-700" },
  quoted: { bar: "bg-amber-500", text: "text-amber-700" },
  won: { bar: "bg-green-500", text: "text-green-700" },
  lost: { bar: "bg-gray-400", text: "text-gray-600" },
};

const leadBadgeClasses: Record<string, string> = {
  new: "bg-blue-100 text-blue-700 hover:bg-blue-100",
  contacted: "bg-indigo-100 text-indigo-700 hover:bg-indigo-100",
  qualified: "bg-purple-100 text-purple-700 hover:bg-purple-100",
  quoted: "bg-amber-100 text-amber-700 hover:bg-amber-100",
  won: "bg-green-100 text-green-700 hover:bg-green-100",
  lost: "bg-gray-100 text-gray-700 hover:bg-gray-100",
};

function formatTitle(s: string | null | undefined, fallback: string) {
  if (!s) return fallback;
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function CrmDashboard({ embedded = false }: { embedded?: boolean } = {}) {
  const [showIntakeDialog, setShowIntakeDialog] = useState(false);

  const { data: dashboardData, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/crm/dashboard"],
  });

  const { data: latestLeads = [] } = useQuery<CrmLead[]>({
    queryKey: ["/api/crm/leads"],
  });

  const handleIntakeSuccess = () => {
    setShowIntakeDialog(false);
    queryClient.invalidateQueries({ queryKey: ["/api/crm/dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["/api/crm/leads"] });
    queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
  };

  const recentLeads = [...latestLeads]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, 5);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount / 100);

  if (isLoading) return <CrmDashboardSkeleton embedded={embedded} />;

  const data = dashboardData || EMPTY_DATA;
  const activeJobs = data.jobsByStatus.open + data.jobsByStatus.in_progress + data.jobsByStatus.waiting_parts;

  const pipelineStages: { key: keyof DashboardData["leadsByStatus"]; name: string }[] = [
    { key: "new", name: "New" },
    { key: "contacted", name: "Contacted" },
    { key: "qualified", name: "Qualified" },
    { key: "quoted", name: "Quoted" },
    { key: "won", name: "Won" },
    { key: "lost", name: "Lost" },
  ];

  const totalPipelineLeads = pipelineStages.reduce((sum, s) => sum + data.leadsByStatus[s.key], 0);

  const stats: Stat[] = [
    {
      label: "Total Leads",
      value: data.totalLeads,
      icon: Target,
      tone: "blue",
      testId: "card-total-leads",
      valueTestId: "text-total-leads",
      hint: (
        <span className="inline-flex items-center text-green-600">
          <ArrowUp className="mr-1 h-3 w-3" />
          <span data-testid="text-new-leads-week">{data.newLeadsLast7Days} new this week</span>
        </span>
      ),
    },
    {
      label: "Pipeline Value",
      value: formatCurrency(data.pipelineValue),
      icon: DollarSign,
      tone: "green",
      testId: "card-pipeline-value",
      valueTestId: "text-pipeline-value",
      hint: "Active opportunities",
    },
    {
      label: "Active Jobs",
      value: activeJobs,
      icon: Briefcase,
      tone: "amber",
      testId: "card-total-jobs",
      valueTestId: "text-active-jobs",
      hint: (
        <span className="inline-flex items-center text-gray-600">
          <CheckCircle className="mr-1 h-3 w-3 text-green-500" />
          <span data-testid="text-completed-jobs-month">
            {data.completedJobsLast30Days} completed this month
          </span>
        </span>
      ),
    },
    {
      label: "Conversion Rate",
      value: `${data.conversionRate}%`,
      icon: TrendingUp,
      tone: "purple",
      testId: "card-conversion-rate",
      valueTestId: "text-conversion-rate",
      hint: "Lead to customer",
    },
  ];

  return (
    <PageShell className={embedded ? "min-h-0 bg-transparent" : undefined}>
      <PageHeader
        embedded={embedded}
        icon={TrendingUp}
        eyebrow="CRM & Sales"
        title="CRM Dashboard"
        description="Sales pipeline and customer relationship overview."
        actions={
          <>
            <Button
              onClick={() => setShowIntakeDialog(true)}
              className="w-full sm:w-auto bg-green-600 text-white hover:bg-green-700"
              data-testid="button-new-intake"
            >
              <Plus className="mr-2 h-4 w-4" />
              New Intake
            </Button>
            <Link href="/crm/leads" className="w-full sm:w-auto">
              <Button variant="outline" className="w-full sm:w-auto" data-testid="button-view-leads">
                <Target className="mr-2 h-4 w-4" />
                View Leads
              </Button>
            </Link>
            <Link href="/crm/jobs" className="w-full sm:w-auto">
              <Button className="w-full sm:w-auto bg-csd-red text-white hover:bg-red-700" data-testid="button-view-jobs">
                <Briefcase className="mr-2 h-4 w-4" />
                View Jobs
              </Button>
            </Link>
          </>
        }
      />

      <PageContent className={embedded ? "p-0" : undefined}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <StatCard key={s.label} stat={s} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
          {/* Pipeline */}
          <Card data-testid="card-lead-pipeline" className="border-gray-200/80">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Lead Pipeline</CardTitle>
                <Link href="/crm/leads">
                  <Button variant="ghost" size="sm" data-testid="button-pipeline-details">
                    View Details <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex items-center justify-between text-xs text-gray-500">
                <span>Stage distribution</span>
                <span>{totalPipelineLeads} total</span>
              </div>
              <div className="space-y-3">
                {pipelineStages.map((stage) => {
                  const count = data.leadsByStatus[stage.key];
                  const pct = totalPipelineLeads > 0 ? (count / totalPipelineLeads) * 100 : 0;
                  const colors = stageColor[stage.key];
                  return (
                    <div
                      key={stage.name}
                      className="flex items-center gap-3"
                      data-testid={`pipeline-stage-${stage.name.toLowerCase()}`}
                    >
                      <div className={cn("w-20 text-xs font-medium", colors.text)}>{stage.name}</div>
                      <div className="flex-1">
                        <div className="h-2.5 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className={cn("h-full rounded-full transition-all duration-500", colors.bar)}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <Badge variant="secondary" className="min-w-[2.25rem] justify-center">
                        {count}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Job Status */}
          <Card data-testid="card-job-status" className="border-gray-200/80">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Job Status Overview</CardTitle>
                <Link href="/crm/jobs">
                  <Button variant="ghost" size="sm" data-testid="button-jobs-details">
                    View Details <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <JobTile
                  label="Open"
                  count={data.jobsByStatus.open}
                  icon={Clock}
                  tone="blue"
                  testId="job-status-open"
                />
                <JobTile
                  label="In Progress"
                  count={data.jobsByStatus.in_progress}
                  icon={Wrench}
                  tone="amber"
                  testId="job-status-in-progress"
                />
                <JobTile
                  label="Waiting Parts"
                  count={data.jobsByStatus.waiting_parts}
                  icon={PackageSearch}
                  tone="purple"
                  testId="job-status-waiting-parts"
                />
                <JobTile
                  label="Completed"
                  count={data.jobsByStatus.completed}
                  icon={CheckCircle}
                  tone="green"
                  testId="job-status-completed"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
          {/* Quick actions */}
          <Card data-testid="card-quick-actions" className="border-gray-200/80">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800"
                onClick={() => setShowIntakeDialog(true)}
                data-testid="button-quick-intake"
              >
                <Plus className="mr-2 h-4 w-4" />
                New Intake
              </Button>
              <Link href="/crm/leads">
                <Button variant="outline" className="w-full justify-start" data-testid="button-add-lead">
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add New Lead
                </Button>
              </Link>
              <Link href="/crm/jobs">
                <Button variant="outline" className="w-full justify-start" data-testid="button-create-job">
                  <Briefcase className="mr-2 h-4 w-4" />
                  Create Work Order
                </Button>
              </Link>
              <Link href="/crm/contacts">
                <Button variant="outline" className="w-full justify-start" data-testid="button-add-contact">
                  <Users className="mr-2 h-4 w-4" />
                  Add Contact
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Latest intakes */}
          <Card className="border-gray-200/80 lg:col-span-2" data-testid="card-latest-intakes">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Latest Intakes</CardTitle>
                <Link href="/crm/leads">
                  <Button variant="ghost" size="sm" data-testid="button-view-all-leads">
                    View All <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {recentLeads.length === 0 ? (
                <div className="rounded-lg border-2 border-dashed border-gray-200 py-10 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                    <FileText className="h-6 w-6 text-gray-400" />
                  </div>
                  <p className="text-sm font-medium text-gray-700">No recent intakes</p>
                  <p className="mt-1 text-xs text-gray-500">
                    New intakes from /intake and the form below will appear here.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={() => setShowIntakeDialog(true)}
                    data-testid="button-create-first-intake"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create First Intake
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {recentLeads.map((lead) => {
                    const status = (lead.status || "new").toLowerCase();
                    return (
                      <Link key={lead.id} href="/crm/leads">
                        <div
                          className="group flex cursor-pointer items-center justify-between rounded-lg border border-gray-200/70 bg-white p-3 transition-all hover:border-csd-red/30 hover:bg-red-50/30"
                          data-testid={`intake-item-${lead.id}`}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 ring-1 ring-blue-100">
                              <FileText className="h-4 w-4 text-blue-600" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-gray-900 group-hover:text-csd-red">
                                {formatTitle(lead.serviceType, "Service")}
                              </div>
                              <div className="truncate text-xs text-gray-500">
                                {lead.source || "Website"} ·{" "}
                                {lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : "Recent"}
                              </div>
                            </div>
                          </div>
                          <Badge className={cn("shrink-0", leadBadgeClasses[status] || leadBadgeClasses.new)}>
                            {status.charAt(0).toUpperCase() + status.slice(1)}
                          </Badge>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </PageContent>

      <Dialog open={showIntakeDialog} onOpenChange={setShowIntakeDialog}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Customer Intake</DialogTitle>
          </DialogHeader>
          <CsdIntakeForm embedded={true} voiceIntake={false} onSuccess={handleIntakeSuccess} className="border-0 shadow-none" />
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function JobTile({
  label,
  count,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "blue" | "amber" | "purple" | "green";
  testId: string;
}) {
  const tones: Record<typeof tone, { bg: string; text: string; icon: string; ring: string }> = {
    blue: { bg: "bg-blue-50", text: "text-blue-900", icon: "text-blue-600", ring: "ring-blue-100" },
    amber: { bg: "bg-amber-50", text: "text-amber-900", icon: "text-amber-600", ring: "ring-amber-100" },
    purple: { bg: "bg-purple-50", text: "text-purple-900", icon: "text-purple-600", ring: "ring-purple-100" },
    green: { bg: "bg-green-50", text: "text-green-900", icon: "text-green-600", ring: "ring-green-100" },
  };
  const t = tones[tone];
  return (
    <div className={cn("rounded-lg p-3 ring-1", t.bg, t.ring)} data-testid={testId}>
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium", t.text)}>{label}</span>
        <Icon className={cn("h-4 w-4", t.icon)} />
      </div>
      <div className={cn("mt-1.5 text-2xl font-bold", t.text)}>{count}</div>
    </div>
  );
}
