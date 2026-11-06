import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";

/** Renders `value` as a scannable QR code (SVG, so it stays sharp at any size). */
export function QrCode({ value, className, label = "QR code" }: { value: string; className?: string; label?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: "svg", errorCorrectionLevel: "M", margin: 1 })
      .then((markup) => { if (!cancelled) setSvg(markup); })
      .catch(() => { if (!cancelled) setSvg(null); });
    return () => { cancelled = true; };
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("aspect-square bg-white [&>svg]:h-full [&>svg]:w-full", className)}
      data-testid="qr-code"
      // The SVG comes from the qrcode library for a URL we generated, not user HTML.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

/** Downloads a high-resolution PNG of the QR code (for printing or sharing as an image). */
export async function downloadQrPng(value: string, filename: string) {
  const dataUrl = await QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 1024 });
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
}
