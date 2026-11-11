/** Deterministic, provider-independent interpretation of website technology observations.
 * This module does not send network requests or actively scan third-party systems.
 */
export type TechnologyObservation = {
  name: string;
  category: "cms" | "language" | "plugin" | "theme" | "server" | "other";
  version?: string;
  source: string;
  observedAt: string;
  confidence: "confirmed" | "probable";
  supportedStatus?: "supported" | "outdated" | "unknown";
  advisoryUrl?: string;
};
export type WebsiteProspect = {
  domain: string;
  technologies: TechnologyObservation[];
  mobileUsability?: "good" | "needs-review" | "unknown";
  performance?: "good" | "needs-review" | "unknown";
};
export type Opportunity = {
  kind: "maintenance" | "redesign" | "security-review";
  priority: "high" | "medium" | "low";
  rationale: string;
  evidence: string[];
  assessmentRequired: boolean;
};
export function assessWebsite(prospect: WebsiteProspect) {
  const domain = prospect.domain.trim().toLowerCase();
  // Accept DNS names only, not a URL, IP address, or network address.
  if (domain.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) || !/[a-z]/.test(domain.split(".").at(-1) ?? "")) {
    throw new Error("A valid public website domain is required");
  }
  const opportunities: Opportunity[] = [];
  const cms = prospect.technologies.find(t => t.category === "cms");
  if (cms) opportunities.push({
    kind: "maintenance", priority: "low", assessmentRequired: true,
    rationale: "Offer a website maintenance consultation.",
    evidence: [`${cms.name} identified by ${cms.source} (${cms.confidence})`],
  });
  const outdated = prospect.technologies.filter(t => t.supportedStatus === "outdated" && t.confidence === "confirmed" && t.version && t.advisoryUrl?.startsWith("https://"));
  if (outdated.length) opportunities.push({
    kind: "security-review", priority: "high", assessmentRequired: true,
    rationale: "Offer an owner-authorized version and security assessment. Public version information may be incomplete.",
    evidence: outdated.map(t => `${t.name} ${t.version}: ${t.advisoryUrl}`),
  });
  if (prospect.mobileUsability === "needs-review" || prospect.performance === "needs-review") {
    opportunities.push({
      kind: "redesign", priority: "medium", assessmentRequired: true,
      rationale: "Offer a website performance and mobile experience consultation.",
      evidence: [
        ...(prospect.mobileUsability === "needs-review" ? ["Mobile usability requires review"] : []),
        ...(prospect.performance === "needs-review" ? ["Performance requires review"] : []),
      ],
    });
  }
  return {
    domain, technologies: prospect.technologies, opportunities,
    disclaimer: "Technology detection is not a vulnerability assessment. Hidden PHP and WordPress versions may not be externally observable. Active tests require explicit authorization.",
  };
}
export type ProposalLine = { label: string; unitPriceCents: number; quantity: number };
/** Only accepts pricing explicitly provided from the CSD-approved catalog. */
export function draftProposal(lines: ProposalLine[]) {
  if (lines.length === 0) throw new Error("A proposal needs at least one catalog item");
  const items = lines.map(line => {
    if (!line.label.trim() || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0 || !Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new Error("Invalid proposal line");
    const totalCents = line.unitPriceCents * line.quantity;
    if (!Number.isSafeInteger(totalCents)) throw new Error("Invalid proposal total");
    return { ...line, totalCents };
  });
  const subtotalCents = items.reduce((total, line) => total + line.totalCents, 0);
  if (!Number.isSafeInteger(subtotalCents)) throw new Error("Invalid proposal subtotal");
  return { items, subtotalCents, status: "draft-needs-review" as const };
}
