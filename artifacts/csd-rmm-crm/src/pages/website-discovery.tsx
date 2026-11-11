import { WebsiteIntelligence } from "@/components/marketing/website-intelligence";

/** Standalone navigation entry for the same live Website Intelligence tool. */
export default function WebsiteDiscovery() {
  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5 p-4 md:p-6" data-testid="website-discovery-page">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Website Discovery &amp; Security Intelligence</h1>
        <p className="mt-1 text-sm text-gray-700">
          Find local businesses, review public website technology signals, and save prospects for follow-up.
        </p>
      </header>
      <WebsiteIntelligence />
    </div>
  );
}
