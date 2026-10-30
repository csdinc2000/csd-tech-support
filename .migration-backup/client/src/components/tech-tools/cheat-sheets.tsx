import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { BookOpen, Search, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { WINDOWS_QUICK_COMMANDS } from "@/components/tech-tools/windows-commands";

type Entry = { key: string; value: string; command?: string; changesSystem?: boolean };
type Sheet = { id: string; title: string; entries: Entry[] };

const SHEETS: Sheet[] = [
  {
    id: "speed-quick",
    title: "Speed up Windows 10/11 — Quick wins",
    entries: [
      { key: "Restart first", value: "A full restart (not just sleep/shutdown) clears RAM and pending updates. Always do this before deeper work." },
       { key: "Reduce startup apps", value: "Inventory startup entries, then disable only reviewed non-essential apps. The command intentionally does not disable security, RMM, backup, or driver software automatically.", command: WINDOWS_QUICK_COMMANDS.startup },
       { key: "Close background apps", value: "Force-deny Microsoft Store apps from running in the background. Requires an elevated PowerShell window.", command: WINDOWS_QUICK_COMMANDS.backgroundApps, changesSystem: true },
       { key: "Free up disk space", value: "Enable Storage Sense for the current user and by machine policy. Keep 15–20% of the drive free.", command: WINDOWS_QUICK_COMMANDS.storageSense, changesSystem: true },
       { key: "Disk Cleanup (deep)", value: "Choose approved Disk Cleanup categories once, then run that saved cleanup profile.", command: WINDOWS_QUICK_COMMANDS.diskCleanup, changesSystem: true },
      { key: "Uninstall bloatware", value: "Settings → Apps → remove trialware, toolbars, manufacturer junk, unused programs." },
       { key: "Pause/limit OneDrive", value: "Pause OneDrive until it is launched again; use Files On-Demand for a longer-term fix.", command: WINDOWS_QUICK_COMMANDS.oneDrive, changesSystem: true },
       { key: "Disable search indexing on slow disks", value: "Set Windows Search to Manual only when PowerShell detects a physical HDD. SSD-only systems are left unchanged.", command: WINDOWS_QUICK_COMMANDS.searchOnHdd, changesSystem: true },
    ],
  },
  {
    id: "speed-startup",
    title: "Speed up Windows — Startup & services",
    entries: [
      { key: "msconfig", value: "Run 'msconfig' → Boot tab → optionally set Timeout to 3s; Services tab → Hide all Microsoft services → disable unneeded third-party services." },
      { key: "Fast Startup", value: "Control Panel → Power Options → 'Choose what the power buttons do' → enable 'Turn on fast startup' (skip if dual-boot or sleep issues)." },
      { key: "Delay non-essential services", value: "services.msc → set rarely-needed services (e.g. printer/3rd-party updaters) to 'Automatic (Delayed Start)' or Manual." },
      { key: "Startup folder check", value: "Run 'shell:startup' (user) and 'shell:common startup' (all users) → remove unwanted shortcuts." },
      { key: "Scheduled tasks", value: "Task Scheduler → disable aggressive 3rd-party updater/telemetry tasks that run at logon." },
      { key: "Measure boot impact", value: "Task Manager → Startup → 'Last BIOS time' shows firmware delay; high values point to BIOS/Fast Boot or too many devices." },
    ],
  },
  {
    id: "speed-performance",
    title: "Speed up Windows — Performance settings",
    entries: [
      { key: "Adjust for best performance", value: "Run 'sysdm.cpl' → Advanced → Performance → Settings → 'Adjust for best performance' (or keep 'Smooth edges of screen fonts')." },
      { key: "Turn off transparency/animations", value: "Settings → Accessibility → Visual effects → off Transparency & Animation effects. Big help on weak GPUs." },
      { key: "High performance power plan", value: "Control Panel → Power Options → High performance (or Ultimate). Run 'powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61' to unlock Ultimate." },
      { key: "Game Mode", value: "Settings → Gaming → Game Mode ON for gaming PCs; reduces background interference during play." },
      { key: "Virtual memory / pagefile", value: "sysdm.cpl → Advanced → Performance → Advanced → Virtual memory. Let Windows manage, or set 1.5×–3× RAM on the fastest drive if low on RAM." },
      { key: "GPU scheduling", value: "Settings → System → Display → Graphics → Change default graphics settings → Hardware-accelerated GPU scheduling ON (modern GPUs)." },
      { key: "Per-app GPU", value: "Settings → Graphics → set demanding apps to 'High performance' (use the dGPU on laptops)." },
    ],
  },
  {
    id: "speed-maintenance",
    title: "Speed up Windows — Maintenance & repair",
    entries: [
      { key: "Update Windows", value: "Settings → Windows Update — install all updates; outdated builds are often slower and buggier." },
      { key: "Update drivers", value: "Update GPU, chipset, and storage drivers from the maker's site (NVIDIA/AMD/Intel/OEM), not just Windows Update." },
      { key: "SSD TRIM / optimize", value: "Run 'dfrgui' (Optimize Drives) → Optimize. TRIMs SSDs and defrags HDDs. Confirm schedule is weekly." },
      { key: "Repair system files", value: "Admin CMD: 'sfc /scannow', then 'DISM /Online /Cleanup-Image /RestoreHealth'. Fixes corruption that slows the OS." },
      { key: "Check disk health", value: "'chkdsk C: /f /r' for errors; check SMART status (CrystalDiskInfo). A dying drive is a top cause of slowness." },
      { key: "Reset Windows Update cache", value: "Stop wuauserv & bits, delete C:\\Windows\\SoftwareDistribution, restart services — fixes stuck/looping updates." },
      { key: "Clear temp files", value: "Run 'temp', '%temp%', and 'prefetch' → delete contents. Safe to clear; Windows rebuilds them." },
      { key: "Browser cleanup", value: "Remove unused extensions, clear cache, limit open tabs — browsers are a huge RAM/CPU drain." },
    ],
  },
  {
    id: "speed-security",
    title: "Speed up Windows — Malware & background load",
    entries: [
      { key: "Full malware scan", value: "Run full Defender scan + a second-opinion scan (Malwarebytes). Malware/cryptominers are a leading cause of slowdowns." },
      { key: "Check resource hogs", value: "Task Manager → sort by CPU / Memory / Disk / GPU → identify and stop the offending process or app." },
      { key: "Remove PUPs/toolbars", value: "Uninstall potentially unwanted programs, browser hijackers, and 'PC cleaner' scamware." },
      { key: "Disable telemetry/3rd-party updaters", value: "Quiet noisy background updaters (Adobe, manufacturer suites) that run constantly." },
      { key: "Limit notifications/widgets", value: "Win 11: turn off Widgets and noisy notifications that wake background processes." },
      { key: "Reset a bloated browser", value: "If a browser is the problem, reset to defaults or create a fresh profile." },
    ],
  },
  {
    id: "speed-hardware",
    title: "Speed up Windows — Hardware upgrades",
    entries: [
      { key: "HDD → SSD (biggest win)", value: "Cloning an old hard drive to an SSD (SATA or NVMe) is the single biggest real-world speed boost. Always recommend first." },
      { key: "Add RAM", value: "8GB minimum, 16GB comfortable. Heavy multitasking / Chrome / design work → 32GB. Match speed & dual-channel." },
      { key: "Clean dust + repaste", value: "Overheating causes thermal throttling (slowness under load). Clean fans/vents; repaste CPU/GPU if temps are high." },
      { key: "Check thermals under load", value: "Monitor temps (HWMonitor). >90°C under load = throttling — fix cooling before blaming software." },
      { key: "Verify RAM speed (XMP/EXPO)", value: "Enable XMP/EXPO in BIOS so RAM runs at rated speed, not slow default." },
      { key: "PSU / power delivery", value: "Failing PSU or bad laptop charger can cause throttling/instability — verify on bench." },
      { key: "NVMe over SATA", value: "On supported boards, an NVMe SSD is far faster than SATA for boot and large file work." },
    ],
  },
  {
    id: "speed-nuclear",
    title: "Speed up Windows — Last-resort fixes",
    entries: [
      { key: "Reset this PC", value: "Settings → System → Recovery → Reset this PC → 'Keep my files'. Clears software rot while keeping documents." },
      { key: "Clean install", value: "Fresh Windows install (back up data first) — best result for badly degraded systems. Reinstall only needed apps." },
      { key: "Create a new user profile", value: "A corrupt user profile causes slow logon/Explorer. Test a new local account before reinstalling." },
      { key: "Disable startup boost throttling", value: "Check for OEM 'eco/quiet' modes in BIOS or vendor apps (Lenovo Vantage, MyASUS) that cap performance." },
      { key: "Roll back a bad update", value: "If slowdown started after an update: Settings → Windows Update → Update history → Uninstall updates." },
      { key: "Document & back up first", value: "Always image/back up before resets or clean installs. Note the baseline so you can prove the improvement." },
    ],
  },
  {
    id: "boot",
    title: "Boot & BIOS keys",
    entries: [
      { key: "Dell", value: "F2 (BIOS), F12 (boot menu)" },
      { key: "HP", value: "F10 (BIOS), Esc or F9 (boot menu)" },
      { key: "Lenovo", value: "F1 / F2 (BIOS), F12 (boot menu)" },
      { key: "ASUS", value: "F2 / Del (BIOS), F8 (boot menu)" },
      { key: "Acer", value: "F2 (BIOS), F12 (boot menu)" },
      { key: "MSI", value: "Del (BIOS), F11 (boot menu)" },
      { key: "Generic motherboard", value: "Del or F2 for BIOS/UEFI" },
      { key: "Windows Safe Mode", value: "Hold Shift + Restart → Troubleshoot → Advanced" },
    ],
  },
  {
    id: "cmd",
    title: "Windows command line",
    entries: [
      { key: "sfc /scannow", value: "Repair corrupt system files" },
      { key: "DISM /Online /Cleanup-Image /RestoreHealth", value: "Repair Windows image" },
      { key: "chkdsk C: /f /r", value: "Check and repair disk errors" },
      { key: "ipconfig /all", value: "Full network adapter info" },
      { key: "ipconfig /flushdns", value: "Clear DNS cache" },
      { key: "ipconfig /release && ipconfig /renew", value: "Renew DHCP lease" },
      { key: "sfc /verifyonly", value: "Scan integrity without repair" },
      { key: "netsh winsock reset", value: "Reset network stack (reboot after)" },
      { key: "powercfg /batteryreport", value: "Generate battery health report" },
      { key: "systeminfo", value: "Full system + uptime info" },
      { key: "wmic diskdrive get status", value: "Quick drive health check" },
      { key: "tasklist / taskkill /PID", value: "List / kill processes" },
    ],
  },
  {
    id: "shortcuts",
    title: "Windows shortcuts",
    entries: [
      { key: "Win + R", value: "Run dialog" },
      { key: "Win + X", value: "Power user menu (Device Mgr, etc.)" },
      { key: "Win + I", value: "Settings" },
      { key: "Win + Pause", value: "System properties" },
      { key: "Ctrl + Shift + Esc", value: "Task Manager directly" },
      { key: "Win + L", value: "Lock screen" },
      { key: "Win + Shift + S", value: "Snip screenshot" },
      { key: "Win + . (period)", value: "Emoji / symbol picker" },
      { key: "Win + V", value: "Clipboard history" },
      { key: "F8 / Shift+F8", value: "Recovery menu (legacy boot)" },
    ],
  },
  {
    id: "bsod",
    title: "Common stop / error codes",
    entries: [
      { key: "MEMORY_MANAGEMENT", value: "Bad RAM or driver — run MemTest86" },
      { key: "IRQL_NOT_LESS_OR_EQUAL", value: "Driver or RAM issue" },
      { key: "DPC_WATCHDOG_VIOLATION", value: "Old SSD firmware / SATA driver" },
      { key: "CRITICAL_PROCESS_DIED", value: "Corrupt system files — sfc/DISM" },
      { key: "INACCESSIBLE_BOOT_DEVICE", value: "Storage driver / boot config" },
      { key: "VIDEO_TDR_FAILURE", value: "GPU driver crash" },
      { key: "0x0000007B", value: "Boot device inaccessible (AHCI/RAID)" },
      { key: "0xc000000e / 0xc0000225", value: "Boot config (BCD) damaged" },
      { key: "WHEA_UNCORRECTABLE_ERROR", value: "Hardware fault — CPU/PSU/heat" },
    ],
  },
  {
    id: "ports",
    title: "Common ports",
    entries: [
      { key: "20 / 21", value: "FTP" },
      { key: "22", value: "SSH / SFTP" },
      { key: "23", value: "Telnet" },
      { key: "25 / 587", value: "SMTP (email send)" },
      { key: "53", value: "DNS" },
      { key: "80", value: "HTTP" },
      { key: "110 / 995", value: "POP3 / POP3 SSL" },
      { key: "143 / 993", value: "IMAP / IMAP SSL" },
      { key: "443", value: "HTTPS" },
      { key: "3389", value: "Remote Desktop (RDP)" },
      { key: "445", value: "SMB / file sharing" },
      { key: "3306 / 5432", value: "MySQL / PostgreSQL" },
    ],
  },
];

export default function CheatSheets() {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const { toast } = useToast();

  const copyCommand = async (key: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(key);
      toast({ title: "Command copied", description: "Review it before running in an elevated PowerShell window." });
      window.setTimeout(() => setCopied((current) => current === key ? null : current), 1800);
    } catch {
      toast({ title: "Copy unavailable", description: "Clipboard access was blocked. Select the command manually.", variant: "destructive" });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHEETS;
    return SHEETS.map((s) => ({
      ...s,
      entries: s.entries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)),
    })).filter((s) => s.entries.length > 0 || s.title.toLowerCase().includes(q));
  }, [query]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-csd-red" /> Cheat Sheets
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, codes, shortcuts…"
            className="pl-9"
            data-testid="input-cheatsheet-search"
          />
        </div>

        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">No matches found.</p>
        ) : (
          <Accordion type="multiple" defaultValue={query ? filtered.map((s) => s.id) : [SHEETS[0].id]} className="w-full">
            {filtered.map((sheet) => (
              <AccordionItem key={sheet.id} value={sheet.id}>
                <AccordionTrigger className="text-sm font-semibold" data-testid={`cheatsheet-${sheet.id}`}>
                  {sheet.title}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="overflow-hidden rounded-md border">
                    <table className="w-full text-sm">
                      <tbody>
                        {sheet.entries.map((e, i) => (
                          <tr key={e.key} className={i % 2 ? "bg-gray-50" : ""}>
                            <td className="whitespace-nowrap px-3 py-2 font-mono font-medium align-top">{e.key}</td>
                            <td className="px-3 py-2 text-gray-600">
                              <div>{e.value}</div>
                              {e.command && (
                                <div className="mt-2 flex flex-col gap-2 rounded border border-slate-200 bg-slate-50 p-2 sm:flex-row sm:items-start sm:justify-between">
                                   <div className="min-w-0">
                                     <Badge variant={e.changesSystem ? "destructive" : "secondary"} className="mb-1 text-[9px]">
                                       {e.changesSystem ? "MAKES CHANGES" : "READ ONLY"}
                                     </Badge>
                                     <code className="block max-h-12 overflow-auto font-mono text-[10px] leading-relaxed text-slate-700">{e.command}</code>
                                   </div>
                                  <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => copyCommand(e.key, e.command!)}>
                                    {copied === e.key ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                                    {copied === e.key ? "Copied" : "Copy command"}
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
