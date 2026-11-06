import { Calendar, Download, Globe, Mail, Phone, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhone, telHref, type BusinessCardData } from "@/lib/business-card";
import { QrCode } from "./qr-code";

function initials(card: BusinessCardData) {
  const value = `${card.firstName?.[0] ?? ""}${card.lastName?.[0] ?? ""}`.toUpperCase();
  return value || card.name[0]?.toUpperCase() || "?";
}

interface BusinessCardViewProps {
  card: BusinessCardData;
  /** Show the QR code on the card itself (public page and previews). */
  showQr?: boolean;
  /** Preview inside the staff app: links are shown but not the save button. */
  preview?: boolean;
  className?: string;
}

// The digital business card itself. Shared by the public /card page and the
// preview on My Profile so the technician sees exactly what customers see.
export function BusinessCardView({ card, showQr = true, preview = false, className }: BusinessCardViewProps) {
  const navy = card.company.accentColor === "navy";
  const accentBg = navy ? "from-blue-900 to-blue-700" : "from-red-700 to-red-500";
  const accentText = navy ? "text-blue-800" : "text-red-700";
  const accentButton = navy ? "bg-blue-800 hover:bg-blue-900" : "bg-red-700 hover:bg-red-800";
  const website = card.company.website.replace(/^https?:\/\//, "");

  const rows: Array<{ icon: typeof Phone; label: string; value: string; href: string; testId: string }> = [];
  if (card.directPhone) rows.push({ icon: Smartphone, label: "Direct", value: formatPhone(card.directPhone), href: telHref(card.directPhone), testId: "card-direct-phone" });
  if (card.company.phone) rows.push({ icon: Phone, label: "Office", value: formatPhone(card.company.phone), href: telHref(card.company.phone), testId: "card-company-phone" });
  if (card.email) rows.push({ icon: Mail, label: "Email", value: card.email, href: `mailto:${card.email}`, testId: "card-email" });
  else if (card.company.email) rows.push({ icon: Mail, label: "Email", value: card.company.email, href: `mailto:${card.company.email}`, testId: "card-company-email" });
  rows.push({ icon: Globe, label: "Web", value: website, href: card.company.website, testId: "card-website" });

  return (
    <div className={cn("w-full max-w-sm overflow-hidden rounded-2xl bg-white text-gray-900 shadow-xl ring-1 ring-black/5", className)} data-testid="business-card">
      <div className={cn("relative h-24 bg-gradient-to-br", accentBg)}>
        <div className="absolute left-4 top-3 text-xs font-semibold uppercase tracking-widest text-white/90">{card.company.name}</div>
      </div>
      <div className="relative -mt-14 flex flex-col items-center px-6 pb-6 text-center">
        <div className="h-28 w-28 overflow-hidden rounded-full border-4 border-white bg-gray-100 shadow-md">
          {card.photoUrl ? (
            <img src={card.photoUrl} alt={card.name} className="h-full w-full object-cover" />
          ) : (
            <div className={cn("flex h-full w-full items-center justify-center bg-gradient-to-br text-3xl font-semibold text-white", accentBg)}>
              {initials(card)}
            </div>
          )}
        </div>
        <h1 className="mt-3 text-2xl font-bold" data-testid="card-name">{card.name}</h1>
        <p className={cn("text-sm font-medium", accentText)} data-testid="card-title">{card.title}</p>
        {card.headline && <p className="mt-2 text-sm text-gray-600" data-testid="card-headline">{card.headline}</p>}

        <div className="mt-5 w-full space-y-2 text-left">
          {rows.map(({ icon: Icon, label, value, href, testId }) => (
            <a
              key={testId}
              href={href}
              target={href.startsWith("http") ? "_blank" : undefined}
              rel="noreferrer"
              className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5 transition hover:bg-gray-50"
              data-testid={testId}
            >
              <Icon className={cn("h-4 w-4 shrink-0", accentText)} />
              <span className="w-12 shrink-0 text-xs text-gray-500">{label}</span>
              <span className="min-w-0 truncate text-sm font-medium">{value}</span>
            </a>
          ))}
        </div>

        {!preview && (
          <div className="mt-5 grid w-full gap-2">
            <a
              href={card.vcardUrl}
              className={cn("flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white shadow", accentButton)}
              data-testid="button-save-contact"
            >
              <Download className="h-4 w-4" />
              Save to contacts
            </a>
            <a
              href={card.bookingUrl}
              className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
              data-testid="button-request-service"
            >
              <Calendar className="h-4 w-4" />
              Request service
            </a>
          </div>
        )}

        {showQr && (
          <div className="mt-6 flex flex-col items-center">
            <QrCode value={card.cardUrl} className="h-36 w-36 rounded-lg p-1 ring-1 ring-gray-200" label={`QR code for ${card.name}'s card`} />
            <p className="mt-2 text-xs text-gray-500">Scan to open this card on your phone</p>
          </div>
        )}
      </div>
    </div>
  );
}
