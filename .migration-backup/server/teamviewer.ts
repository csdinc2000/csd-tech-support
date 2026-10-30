/**
 * TeamViewer integration — deep-link launcher.
 *
 * Builds the OS-level URI that hands control to a locally-installed TeamViewer
 * client. No API key required. Works on Windows/macOS/Linux as long as the
 * technician has TeamViewer (or TeamViewer QuickSupport / Tensor) installed.
 *
 * URI reference:
 *   teamviewer10://control?device=<id>&password=<optional>
 *   teamviewer://control?device=<id>
 *
 * The numeric `id` is the TeamViewer ID shown in the client (digits only).
 */

export type TeamViewerSessionType = "control" | "filetransfer" | "meeting";

export interface TeamViewerLaunchOptions {
  /** The numeric TeamViewer ID of the target device (digits only; spaces stripped). */
  teamviewerId: string;
  /** Session type. Defaults to "control" (full remote desktop). */
  sessionType?: TeamViewerSessionType;
  /** Optional one-time password to pre-fill in the TeamViewer client. */
  password?: string;
  /** URI scheme prefix to use. Defaults to "teamviewer10". */
  scheme?: "teamviewer" | "teamviewer8" | "teamviewer10";
}

const DIGITS_ONLY = /[^0-9]/g;

export function normalizeTeamviewerId(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(DIGITS_ONLY, "");
}

export function buildTeamviewerLaunchUrl(opts: TeamViewerLaunchOptions): string {
  const id = normalizeTeamviewerId(opts.teamviewerId);
  if (!id) {
    throw new Error("TeamViewer ID is required");
  }
  const scheme = opts.scheme ?? "teamviewer10";
  const action = opts.sessionType ?? "control";
  const params = new URLSearchParams({ device: id });
  if (opts.password) {
    params.set("password", opts.password);
  }
  return `${scheme}://${action}?${params.toString()}`;
}

/** Web fallback when TeamViewer client isn't installed — opens the install / web page. */
export function teamviewerInstallUrl(): string {
  return "https://www.teamviewer.com/download/";
}
