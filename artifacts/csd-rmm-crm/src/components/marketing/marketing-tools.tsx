import { useMemo, useState } from "react";
import { Link } from "wouter";
import { formatDistanceToNowStrict } from "date-fns";
import { Building, Globe2, Link2, Mail, MessageSquare, PenSquare, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { humanize, type BoardJob, type ContactIndex } from "@/components/dashboard/tech-board/types";
import {
  CONTENT_TEMPLATES,
  REVIEW_TEMPLATES,
  SOCIAL_LIMITS,
  UTM_PRESETS,
  buildUtmUrl,
  fillTemplate,
  smsSegments,
  type BrandKit,
  type ContentIdea,
} from "@/lib/marketing";
import { CopyButton, MarketingCard, useBrandKit } from "./shared";
import { WebsiteIntelligence } from "./website-intelligence";

export type MarketingTool = "reviews" | "content" | "utm" | "brand" | "website";

const TOOLS: { id: MarketingTool; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }[] = [
  { id: "reviews", label: "Review requests", icon: Star, hint: "Ask recent customers for a review" },
  { id: "content", label: "Content studio", icon: PenSquare, hint: "Ready-to-post social copy" },
  { id: "utm", label: "Tracked links", icon: Link2, hint: "UTM links for every channel" },
  { id: "brand", label: "Brand kit", icon: Building, hint: "Details the tools fill in" },
  { id: "website", label: "Website intelligence", icon: Globe2, hint: "Local business websites and passive technology review" },
];

export function isMarketingTool(value: string | null): value is MarketingTool {
  return TOOLS.some((tool) => tool.id === value);
}

export function MarketingTools({
  tool,
  onToolChange,
  jobs,
  contacts,
  can,
}: {
  tool: MarketingTool;
  onToolChange: (tool: MarketingTool) => void;
  jobs: BoardJob[];
  contacts: ContactIndex;
  can: (feature: string) => boolean;
}) {
  const [kit, updateKit] = useBrandKit();
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]" data-testid="marketing-tools">
      <nav aria-label="Marketing tools" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {TOOLS.map((item) => {
          const Icon = item.icon;
          const active = tool === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onToolChange(item.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors lg:w-full",
                active ? "border-csd-red/30 bg-white text-csd-red shadow-sm" : "border-transparent text-gray-700 hover:bg-white hover:text-gray-900",
              )}
              data-testid={`mkt-tool-${item.id}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block font-medium">{item.label}</span>
                <span className="hidden truncate text-xs text-gray-500 lg:block">{item.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0">
        {tool === "reviews" && <ReviewRequests kit={kit} jobs={jobs} contacts={contacts} canMessage={can("communications")} onEditKit={() => onToolChange("brand")} />}
        {tool === "content" && <ContentStudio kit={kit} />}
        {tool === "utm" && <UtmBuilder kit={kit} />}
        {tool === "brand" && <BrandKitForm kit={kit} onChange={updateKit} />}
        {tool === "website" && <WebsiteIntelligence />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-gray-700">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}

function BrandKitForm({ kit, onChange }: { kit: BrandKit; onChange: (next: Partial<BrandKit>) => void }) {
  const fields: { key: keyof BrandKit; label: string; hint?: string; placeholder?: string }[] = [
    { key: "business", label: "Business name" },
    { key: "phone", label: "Phone" },
    { key: "website", label: "Website" },
    { key: "bookingLink", label: "Booking / intake link" },
    { key: "reviewLink", label: "Review link", hint: "Your Google Business “Ask for reviews” link (g.page/r/…).", placeholder: "https://g.page/r/…/review" },
    { key: "area", label: "Service area" },
  ];
  return (
    <MarketingCard icon={Building} title="Brand kit" description="Saved in this browser and filled into every template" testId="mkt-brand-kit">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <Field key={field.key} id={`kit-${field.key}`} label={field.label} hint={field.hint}>
            <Input
              id={`kit-${field.key}`}
              value={kit[field.key]}
              placeholder={field.placeholder}
              onChange={(event) => onChange({ [field.key]: event.target.value })}
            />
          </Field>
        ))}
      </div>
    </MarketingCard>
  );
}

// ---------------------------------------------------------------------------

const REVIEW_WINDOW_DAYS = 45;

function ReviewRequests({
  kit,
  jobs,
  contacts,
  canMessage,
  onEditKit,
}: {
  kit: BrandKit;
  jobs: BoardJob[];
  contacts: ContactIndex;
  canMessage: boolean;
  onEditKit: () => void;
}) {
  const recent = useMemo(() => {
    const cutoff = Date.now() - REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return jobs
      .filter((job) => job.status === "completed" && job.contactId != null && new Date(job.updatedAt ?? 0).getTime() >= cutoff)
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
      .slice(0, 25);
  }, [jobs]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState(REVIEW_TEMPLATES[0].id);
  const job = recent.find((j) => j.id === jobId) ?? recent[0];
  const contact = job?.contactId != null ? contacts.get(job.contactId) : undefined;
  const template = REVIEW_TEMPLATES.find((t) => t.id === templateId) ?? REVIEW_TEMPLATES[0];
  const vars = {
    ...kit,
    first: contact?.fullName?.split(/\s+/)[0] ?? "there",
    service: job ? humanize(job.serviceType).toLowerCase() : "repair",
  };
  const body = fillTemplate(template.body, vars);
  const subject = template.subject ? fillTemplate(template.subject, vars) : "";
  const sms = template.channel === "sms" ? smsSegments(body) : null;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5" data-testid="mkt-reviews">
      <MarketingCard
        icon={Star}
        title="Recently completed"
        description={`Jobs closed in the last ${REVIEW_WINDOW_DAYS} days`}
        className="xl:col-span-2"
        bodyClassName="p-0"
      >
        {recent.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500">No completed jobs with a linked customer yet.</p>
        ) : (
          <ul className="max-h-[26rem] divide-y divide-gray-100 overflow-y-auto">
            {recent.map((item) => {
              const person = item.contactId != null ? contacts.get(item.contactId) : undefined;
              const selected = item.id === job?.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setJobId(item.id)}
                    aria-pressed={selected}
                    className={cn("flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors", selected ? "bg-red-50/70" : "hover:bg-gray-50")}
                    data-testid={`mkt-review-job-${item.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-900">{person?.fullName ?? `Contact #${item.contactId}`}</span>
                      <span className="block truncate text-xs text-gray-500">{item.jobNumber} · {humanize(item.serviceType)}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-gray-400">
                      {item.updatedAt ? formatDistanceToNowStrict(new Date(item.updatedAt), { addSuffix: true }) : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </MarketingCard>

      <MarketingCard icon={MessageSquare} title="Message" description={contact ? `For ${contact.fullName}` : "Pick a customer"} className="xl:col-span-3">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Template">
            {REVIEW_TEMPLATES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.id === template.id}
                onClick={() => setTemplateId(option.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  option.id === template.id ? "border-csd-red bg-csd-red text-white" : "border-gray-200 bg-white text-gray-700 hover:border-csd-red/40",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {!kit.reviewLink && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Add your Google review link in the{" "}
              <button type="button" className="font-semibold underline" onClick={onEditKit}>brand kit</button>{" "}
              so the message includes it.
            </p>
          )}
          {subject && (
            <Field id="review-subject" label="Subject">
              <Input id="review-subject" value={subject} readOnly />
            </Field>
          )}
          <Field id="review-body" label="Message">
            <Textarea id="review-body" value={body} readOnly rows={template.channel === "email" ? 10 : 4} className="resize-none text-sm" data-testid="mkt-review-body" />
          </Field>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-gray-500">
              {sms ? `${sms.length} characters · ${sms.segments} SMS segment${sms.segments === 1 ? "" : "s"}` : "Send from the support inbox."}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={subject ? `${subject}\n\n${body}` : body} label={subject ? "Copy email" : "Copy text"} />
              {canMessage && template.channel === "sms" && (
                <Button asChild size="sm" className="bg-csd-red hover:bg-red-700">
                  <Link href="/messages"><MessageSquare className="mr-1.5 h-3.5 w-3.5" />Open Messages</Link>
                </Button>
              )}
              {canMessage && template.channel === "email" && (
                <Button asChild size="sm" className="bg-csd-red hover:bg-red-700">
                  <Link href={contact ? `/comms/email?contactId=${contact.id}` : "/comms/email"}><Mail className="mr-1.5 h-3.5 w-3.5" />Email from Support</Link>
                </Button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-gray-400">Only message customers who agreed to texts or email. Never offer anything in exchange for a review.</p>
        </div>
      </MarketingCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

const CATEGORIES = ["All", ...new Set(CONTENT_TEMPLATES.map((t) => t.category))] as const;

function ContentStudio({ kit }: { kit: BrandKit }) {
  const [category, setCategory] = useState<string>("All");
  const [ideaId, setIdeaId] = useState(CONTENT_TEMPLATES[0].id);
  const [service, setService] = useState("computer repair");
  const [offer, setOffer] = useState("");
  const [link, setLink] = useState(kit.bookingLink);
  const [includeTags, setIncludeTags] = useState(true);
  const ideas = CONTENT_TEMPLATES.filter((t) => category === "All" || t.category === category);
  const idea: ContentIdea = CONTENT_TEMPLATES.find((t) => t.id === ideaId) ?? CONTENT_TEMPLATES[0];
  const post = useMemo(() => {
    const text = fillTemplate(idea.body, { ...kit, service, offer, link: link || kit.bookingLink });
    return includeTags ? `${text}\n\n${idea.hashtags.map((tag) => `#${tag}`).join(" ")}` : text;
  }, [idea, kit, service, offer, link, includeTags]);
  const length = [...post].length;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5" data-testid="mkt-content">
      <MarketingCard icon={PenSquare} title="Post ideas" className="xl:col-span-2" bodyClassName="p-0">
        <div className="flex gap-1.5 overflow-x-auto border-b border-gray-100 px-4 py-2 [scrollbar-width:none]">
          {CATEGORIES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategory(name)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                category === name ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200",
              )}
            >
              {name}
            </button>
          ))}
        </div>
        <ul className="max-h-[24rem] divide-y divide-gray-100 overflow-y-auto">
          {ideas.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setIdeaId(item.id)}
                aria-pressed={item.id === idea.id}
                className={cn("flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm", item.id === idea.id ? "bg-red-50/70" : "hover:bg-gray-50")}
                data-testid={`mkt-idea-${item.id}`}
              >
                <span className="font-medium text-gray-900">{item.label}</span>
                <span className="shrink-0 text-[11px] text-gray-500">{item.category}</span>
              </button>
            </li>
          ))}
        </ul>
      </MarketingCard>

      <MarketingCard icon={MessageSquare} title="Compose" description={idea.label} className="xl:col-span-3">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="post-service" label="Service">
              <Input id="post-service" value={service} onChange={(e) => setService(e.target.value)} />
            </Field>
            <Field id="post-link" label="Link" hint="Tip: use a tracked link">
              <Input id="post-link" value={link} onChange={(e) => setLink(e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Field id="post-offer" label="Offer or quote" hint="Used by promotion, seasonal and review posts">
                <Input id="post-offer" value={offer} placeholder="e.g. $20 off virus removal through Sunday" onChange={(e) => setOffer(e.target.value)} />
              </Field>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={includeTags} onChange={(e) => setIncludeTags(e.target.checked)} className="h-4 w-4 accent-csd-red" />
            Include hashtags
          </label>
          <Textarea value={post} readOnly rows={7} className="resize-none text-sm" aria-label="Generated post" data-testid="mkt-post" />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <ul className="flex flex-wrap gap-1.5 text-[11px]" aria-label="Platform length limits">
              {SOCIAL_LIMITS.map((platform) => {
                const over = length > platform.limit;
                return (
                  <li key={platform.id} className={cn("rounded-full px-2 py-0.5 font-medium", over ? "bg-red-100 text-red-800" : "bg-emerald-50 text-emerald-800")}>
                    {platform.label} {over ? `over by ${length - platform.limit}` : "✓"}
                  </li>
                );
              })}
            </ul>
            <CopyButton text={post} label="Copy post" />
          </div>
        </div>
      </MarketingCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

function UtmBuilder({ kit }: { kit: BrandKit }) {
  const [url, setUrl] = useState(kit.bookingLink || kit.website);
  const [source, setSource] = useState("facebook");
  const [medium, setMedium] = useState("social");
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const result = buildUtmUrl({ url, source, medium, campaign, content });

  return (
    <MarketingCard icon={Link2} title="Tracked link builder" description="Tag links so every visit and intake shows which post or ad it came from" testId="mkt-utm">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5" aria-label="Presets">
          {UTM_PRESETS.map((preset) => {
            const active = preset.source === source && preset.medium === medium;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => { setSource(preset.source); setMedium(preset.medium); }}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  active ? "border-csd-red bg-csd-red text-white" : "border-gray-200 bg-white text-gray-700 hover:border-csd-red/40",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <Field id="utm-url" label="Page URL">
              <Input id="utm-url" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
            </Field>
          </div>
          <Field id="utm-source" label="Source" hint="Where: facebook, google, nextdoor…">
            <Input id="utm-source" value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <Field id="utm-medium" label="Medium" hint="How: social, email, cpc, print…">
            <Input id="utm-medium" value={medium} onChange={(e) => setMedium(e.target.value)} />
          </Field>
          <Field id="utm-campaign" label="Campaign" hint="Matches the campaign name on reports">
            <Input id="utm-campaign" value={campaign} placeholder="spring-tune-up" onChange={(e) => setCampaign(e.target.value)} />
          </Field>
          <Field id="utm-content" label="Content (optional)" hint="Tell variants apart: video, carousel…">
            <Input id="utm-content" value={content} onChange={(e) => setContent(e.target.value)} />
          </Field>
        </div>
        <div className={cn("rounded-lg border px-3 py-3", result.url ? "border-gray-200 bg-gray-50" : "border-amber-200 bg-amber-50")}>
          {result.url ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all text-xs text-gray-800" data-testid="mkt-utm-result">{result.url}</code>
              <CopyButton text={result.url} label="Copy link" className="shrink-0" />
            </div>
          ) : (
            <p className="text-xs text-amber-800" data-testid="mkt-utm-error">{result.error}</p>
          )}
        </div>
      </div>
    </MarketingCard>
  );
}
