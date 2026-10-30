import type { ListingSpecs } from "@/lib/marketplace";

// Seller-side spec capture for Windows machines. The seller runs one
// PowerShell line on the PC they're selling, pastes the output, and we fill
// the spec matrix. Emits JSON so parsing is deterministic; `Get-PhysicalDisk`
// is preferred (it knows SSD/HDD and NVMe) with `Win32_DiskDrive` as the
// fallback for older builds where the Storage module isn't available.
export const WINDOWS_SPECS_COMMAND = String.raw`$cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1).Name; $gpu=@(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name); $mem=@(Get-CimInstance Win32_PhysicalMemory); $ram=($mem | Measure-Object -Property Capacity -Sum).Sum; $memType=($mem | Select-Object -First 1).SMBIOSMemoryType; $memSpeed=($mem | Select-Object -First 1).Speed; try {$disks=@(Get-PhysicalDisk -ErrorAction Stop | Select-Object @{N='Model';E={$_.FriendlyName}},Size,MediaType,BusType)} catch {$disks=@(Get-CimInstance Win32_DiskDrive | Select-Object Model,Size,@{N='BusType';E={$_.InterfaceType}})}; $os=(Get-CimInstance Win32_OperatingSystem).Caption; [pscustomobject]@{CPU=$cpu;GPU=$gpu;RAMBytes=$ram;MemType=$memType;MemSpeed=$memSpeed;Disks=$disks;OS=$os} | ConvertTo-Json -Compress -Depth 3`;

export type WindowsSpecs = Partial<Pick<ListingSpecs, "cpu" | "gpu" | "ram" | "storage" | "os">>;

type RawDisk = { Model?: unknown; Size?: unknown; MediaType?: unknown; BusType?: unknown };
type RawReport = {
  CPU?: unknown;
  GPU?: unknown;
  RAMBytes?: unknown;
  MemType?: unknown;
  MemSpeed?: unknown;
  Disks?: unknown;
  OS?: unknown;
};

// SMBIOS type 17 "Memory Type" codes (DSP0134 §7.18.2).
const SMBIOS_MEMORY_TYPE: Record<number, string> = {
  20: "DDR", 21: "DDR2", 24: "DDR3", 26: "DDR4", 27: "LPDDR", 28: "LPDDR2", 29: "LPDDR3", 30: "LPDDR4", 34: "DDR5", 35: "LPDDR5",
};

const GB = 1024 ** 3;

const tidy = (s: string) => s.replace(/\((?:R|TM|C)\)/gi, "").replace(/[®™©]/g, "").replace(/\s+/g, " ").trim();

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const asNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
};
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** "Intel(R) Core(TM) i7-13700K CPU @ 3.40GHz" → "Intel Core i7-13700K". */
export function cleanCpuName(raw: string): string {
  return tidy(raw)
    .replace(/^\d+(?:st|nd|rd|th) Gen(?:eration)?\s+/i, "")
    .replace(/\s+CPU\b/i, "")
    .replace(/\s*@\s*[\d.]+\s*GHz.*$/i, "")
    .replace(/\s+\d+-Core Processor\b/i, "")
    .replace(/\s+Processor$/i, "")
    .replace(/\s+with Radeon Graphics$/i, "")
    .trim();
}

// Adapters that are never the card a buyer cares about.
const GPU_NOISE = /basic display|basic render|remote display|virtual|parsec|displaylink|citrix|vmware|hyper-v|teamviewer|spacedesk|idd|indirect display/i;
const GPU_DISCRETE = /geforce|\bRTX\b|\bGTX\b|quadro|radeon (?:rx|pro|vii)|\bArc\b|\bA\d{3,4}\b|titan/i;

/** Pick the discrete card when there's one, otherwise the first real adapter. */
export function pickGpu(names: string[]): string | null {
  const real = names.map(tidy).filter((n) => n && !GPU_NOISE.test(n));
  if (real.length === 0) return null;
  return real.find((n) => GPU_DISCRETE.test(n)) ?? real[0];
}

export function formatRam(bytes: number, memType?: number | null, speedMhz?: number | null): string {
  const gb = Math.round(bytes / GB);
  if (!gb) return "";
  const type = memType != null ? SMBIOS_MEMORY_TYPE[memType] : undefined;
  if (!type) return `${gb}GB`;
  return speedMhz && speedMhz > 0 ? `${gb}GB ${type}-${speedMhz}` : `${gb}GB ${type}`;
}

/** Marketing size: 1000204886016 → "1TB", 512110190592 → "512GB". */
export function formatDiskSize(bytes: number): string {
  const gb = Math.round(bytes / 1e9);
  if (gb >= 1000) {
    const tb = Math.round(gb / 500) / 2; // nearest half-terabyte
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)}TB`;
  }
  return `${gb}GB`;
}

function diskKind(model: string, mediaType: string | null, busType: string | null): string {
  const m = model.toLowerCase();
  const media = (mediaType ?? "").toLowerCase();
  const bus = (busType ?? "").toLowerCase();
  if (bus === "nvme" || /nvme/.test(m)) return "NVMe SSD";
  if (media === "ssd" || /\bssd\b/.test(m)) return "SSD";
  if (media === "hdd" || /\bhdd\b|hard disk/.test(m)) return "HDD";
  return "";
}

export function formatDisks(disks: Array<{ model: string; sizeBytes: number; mediaType?: string | null; busType?: string | null }>): string {
  const parts = disks
    .filter((d) => d.sizeBytes > 0 && !/^(usb|sd)$/i.test(d.busType ?? "") && !/usb|card reader|flash/i.test(d.model))
    .map((d) => {
      const kind = diskKind(d.model, d.mediaType ?? null, d.busType ?? null);
      return kind ? `${formatDiskSize(d.sizeBytes)} ${kind}` : formatDiskSize(d.sizeBytes);
    });
  return parts.join(" + ");
}

export function cleanOsName(raw: string): string {
  return tidy(raw).replace(/^Microsoft\s+/i, "").replace(/\s+\d+-bit$/i, "");
}

function fromReport(report: RawReport): WindowsSpecs {
  const out: WindowsSpecs = {};
  const cpu = asString(report.CPU);
  if (cpu) out.cpu = cleanCpuName(cpu);
  const gpu = pickGpu(asList(report.GPU).map((g) => asString(g) ?? "").filter(Boolean));
  if (gpu) out.gpu = gpu;
  const ramBytes = asNumber(report.RAMBytes);
  if (ramBytes) {
    const ram = formatRam(ramBytes, asNumber(report.MemType), asNumber(report.MemSpeed));
    if (ram) out.ram = ram;
  }
  const disks = asList(report.Disks)
    .filter((d): d is RawDisk => typeof d === "object" && d !== null)
    .map((d) => ({ model: asString(d.Model) ?? "", sizeBytes: asNumber(d.Size) ?? 0, mediaType: asString(d.MediaType), busType: asString(d.BusType) }));
  const storage = formatDisks(disks);
  if (storage) out.storage = storage;
  const os = asString(report.OS);
  if (os) out.os = cleanOsName(os);
  return out;
}

// Loose parse for sellers who ran the individual Get-CimInstance lines and
// pasted the console text instead of the JSON one-liner.
function fromConsoleText(text: string): WindowsSpecs {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: WindowsSpecs = {};

  const cpuLine = lines.find((l) => /\b(intel|amd|ryzen|core|xeon|athlon|pentium|celeron|snapdragon)\b/i.test(l) && !/graphics|radeon rx|geforce|nvidia/i.test(l) && !/\d{9,}/.test(l));
  if (cpuLine) out.cpu = cleanCpuName(cpuLine);

  const gpuLines = lines.filter((l) => /nvidia|geforce|radeon|\bintel\b.*(graphics|arc|iris|uhd)|quadro|display adapter|basic display/i.test(l) && !/\d{9,}/.test(l));
  const gpu = pickGpu(gpuLines);
  if (gpu) out.gpu = gpu;

  const sum = lines.map((l) => l.match(/^Sum\s*:\s*(\d+)/i)).find(Boolean);
  if (sum) {
    const ram = formatRam(Number(sum[1]));
    if (ram) out.ram = ram;
  }

  // `Model  Size` table: a model string followed by a byte count.
  const disks = lines
    .filter((l) => !/^\w+\s*:/.test(l)) // skip `Sum : 17179869184`-style property rows
    .map((l) => l.match(/^(.*?\S)\s+(\d{9,})$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ model: m[1], sizeBytes: Number(m[2]) }));
  const storage = formatDisks(disks);
  if (storage) out.storage = storage;

  const osLine = lines.find((l) => /^(microsoft )?windows \d+/i.test(l));
  if (osLine) out.os = cleanOsName(osLine);
  return out;
}

/**
 * Parse pasted PowerShell output into listing specs. Accepts the JSON emitted
 * by `WINDOWS_SPECS_COMMAND` (possibly with prompt noise around it) or the raw
 * console text of the individual commands. Returns null when nothing usable
 * was found.
 */
export function parseWindowsSpecs(text: string): WindowsSpecs | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as RawReport;
      const specs = fromReport(parsed);
      if (Object.keys(specs).length) return specs;
    } catch {
      // Not JSON — fall through to the console-text heuristics.
    }
  }
  const specs = fromConsoleText(trimmed);
  return Object.keys(specs).length ? specs : null;
}
