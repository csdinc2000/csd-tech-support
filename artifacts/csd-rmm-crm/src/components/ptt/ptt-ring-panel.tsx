import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Loader2, PhoneCall, PhoneOff, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import {
  isDirectChannel,
  pttRoleLabel,
  RING_STATUS_LABEL,
  type PttRosterEntry,
  type PttRosterResponse,
  type RingGroup,
  type RingStatus,
} from "@/lib/ptt-ring";

const STATUS_STYLES: Record<RingStatus, string> = {
  ringing: "text-amber-300",
  answered: "text-emerald-400",
  connected: "text-emerald-300",
  declined: "text-red-400",
  cancelled: "text-zinc-500",
  missed: "text-zinc-400",
  unavailable: "text-zinc-500",
};

type Props = {
  /** Channel the console is on; "ring everyone" uses it unless it's a private call. */
  currentChannelId: string;
  channels: Array<{ id: string; name: string }>;
  /** Move the console into the call so the caller is already there when people answer. */
  onJoinCall: (channelId: string, label?: string) => void;
};

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  // apiRequest errors look like `400: {"error":"…"}`.
  const match = raw.match(/"error"\s*:\s*"([^"]+)"/);
  return match?.[1] || fallback;
}

/**
 * "Ring staff" on the PTT console: call one person privately, a few people
 * together (private), or everyone at once on a shared talk group. Each of them
 * gets a ringing pop-up wherever they are in the app.
 */
export function PttRingPanel({ currentChannelId, channels, onJoinCall }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<RingGroup | null>(null);
  const [roleChoice, setRoleChoice] = useState("all");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const roster = useQuery<PttRosterResponse>({
    queryKey: ["/api/ptt/roster"],
    queryFn: async ({ signal }) => (await apiRequest("GET", "/api/ptt/roster", undefined, { signal })).json(),
    refetchInterval: 10_000,
    staleTime: 0,
  });
  const staff = roster.data?.staff ?? [];
  const canBroadcast = roster.data?.canBroadcast === true;
  const visibleStaff = staff.filter((entry) => {
    if (!canBroadcast && entry.role !== "field_technician") return false;
    return roleChoice === "all" || entry.role === roleChoice;
  });
  const roleOptions = [...new Set(staff.map((entry) => entry.role))].sort((a, b) => pttRoleLabel(a).localeCompare(pttRoleLabel(b)));

  const anyRinging = group?.pages.some((page) => page.status === "ringing") ?? false;
  const shouldPollStatus = group?.pages.some((page) =>
    page.status === "ringing" ||
    page.status === "answered" ||
    page.status === "connected" ||
    (page.status === "unavailable" && new Date(group.expiresAt).getTime() > Date.now()),
  ) ?? false;
  useEffect(() => {
    if (!group || !shouldPollStatus) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = (await (await apiRequest("GET", `/api/ptt/pages/groups/${group.groupId}`)).json()) as RingGroup;
        if (!cancelled) setGroup(next);
      } catch {
        // Keep the last known status; the next tick retries.
      }
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [group?.groupId, shouldPollStatus]);

  // Drop selections for people who are no longer on the roster.
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(staff.map((entry) => entry.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [staff]);

  const groupChannel = isDirectChannel(currentChannelId) ? "dispatch" : currentChannelId;
  const groupChannelName = channels.find((channel) => channel.id === groupChannel)?.name ?? "Dispatch";
  const onlineCount = useMemo(() => visibleStaff.filter((entry) => entry.online).length, [visibleStaff]);

  const ring = async (
    body: { targetUserIds?: string[]; everyone?: boolean; channelId?: string; targetRole?: string },
    label?: string,
  ) => {
    setSending(true);
    setError("");
    try {
      const created = (await (await apiRequest("POST", "/api/ptt/pages", body)).json()) as RingGroup;
      setGroup(created);
      setSelected(new Set());
      onJoinCall(created.channelId, label);
    } catch (err) {
      setError(errorMessage(err, "Unable to ring staff. Try again."));
    } finally {
      setSending(false);
    }
  };

  const callOne = (entry: PttRosterEntry) => void ring({ targetUserIds: [entry.id] }, entry.name);
  const ringSelected = () => {
    const names = staff.filter((entry) => selected.has(entry.id)).map((entry) => entry.name);
    const label = names.length <= 2 ? names.join(" & ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    void ring({ targetUserIds: [...selected] }, label);
  };
  const ringEveryone = () => void ring({ everyone: true, channelId: groupChannel });
  const ringRole = () => {
    void ring(
      { targetRole: roleChoice === "all" ? "all" : roleChoice },
      roleChoice === "all" ? "All approved staff" : `${pttRoleLabel(roleChoice)} group`,
    );
  };

  const cancel = async () => {
    if (!group) return;
    try {
      setGroup((await (await apiRequest("POST", `/api/ptt/pages/groups/${group.groupId}/cancel`)).json()) as RingGroup);
    } catch (err) {
      setError(errorMessage(err, "Unable to cancel the ring."));
    }
  };

  const toggle = (id: string) => setSelected((current) => {
    if (current.has(id)) {
      const next = new Set(current);
      next.delete(id);
      return next;
    }
    return canBroadcast ? new Set([...current, id]) : new Set([id]);
  });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 shadow-sm flex flex-col" data-testid="ptt-ring-panel">
      <div className="bg-zinc-950/50 p-4 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="font-bold text-zinc-300 uppercase tracking-widest text-xs flex items-center gap-2">
          <BellRing className="h-4 w-4 text-zinc-500" />
          Ring Staff
        </h2>
        <Badge variant="outline" className="border-zinc-700 bg-zinc-800 text-zinc-300">{onlineCount}/{visibleStaff.length} available</Badge>
      </div>

      <div className="max-h-[320px] overflow-y-auto p-2 space-y-1">
        {roster.isPending && <p className="p-3 text-xs text-zinc-500">Loading staff…</p>}
        {roster.isError && <p className="p-3 text-xs text-red-400">Unable to load staff with PTT access.</p>}
        {!roster.isPending && !roster.isError && visibleStaff.length === 0 && (
          <p className="p-3 text-xs text-zinc-500">
            {roleChoice === "all" && !canBroadcast
              ? "No approved technicians are available to call."
              : "Nobody in this role currently has PTT access."}
          </p>
        )}
        {canBroadcast && roleOptions.length > 0 && (
          <label className="block px-2 pb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            Filter by role
            <select
              value={roleChoice}
              onChange={(event) => setRoleChoice(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs font-medium normal-case tracking-normal text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              data-testid="ptt-role-filter"
            >
              <option value="all">All approved roles</option>
              {roleOptions.map((role) => <option key={role} value={role}>{pttRoleLabel(role)}</option>)}
            </select>
          </label>
        )}
        {visibleStaff.map((entry) => {
          const checked = selected.has(entry.id);
          const presence = entry.onPtt ? "On PTT" : entry.online ? "App open" : "Offline";
          return (
            <div
              key={entry.id}
              className={cn("flex items-center gap-2 rounded-lg border p-2", checked ? "border-orange-500/50 bg-zinc-800" : "border-transparent hover:bg-zinc-800/50")}
              data-testid={`ptt-ring-staff-${entry.id}`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-orange-500"
                checked={checked}
                onChange={() => toggle(entry.id)}
                aria-label={`Select ${entry.name}`}
              />
              <div className="relative shrink-0">
                {entry.avatarUrl
                  ? <img src={entry.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                  : <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-[11px] font-bold text-zinc-200">
                      {entry.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
                    </div>}
                <span
                  className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-900", entry.onPtt ? "bg-emerald-400" : entry.online ? "bg-sky-400" : "bg-zinc-600")}
                  aria-hidden
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-200">{entry.name}</p>
                <p className="truncate text-[11px] text-zinc-500">{pttRoleLabel(entry.role)} · {presence}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-emerald-600 hover:text-white"
                disabled={sending}
                onClick={() => callOne(entry)}
                aria-label={`Call ${entry.name} privately`}
                data-testid={`ptt-ring-call-${entry.id}`}
              >
                <PhoneCall className="mr-1 h-3.5 w-3.5" /> Call
              </Button>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 border-t border-zinc-800 p-3">
        <Button
          type="button"
          className="w-full bg-orange-600 text-white hover:bg-orange-500"
          disabled={sending || selected.size === 0 || (!canBroadcast && selected.size > 1)}
          onClick={ringSelected}
          data-testid="ptt-ring-selected"
        >
          {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PhoneCall className="mr-2 h-4 w-4" />}
          {canBroadcast ? "Call selected" : "Call technician"}
          {selected.size ? ` (${selected.size})` : ""} · private
        </Button>
        {canBroadcast && (
          <Button
            type="button"
            variant="outline"
            className="w-full border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            disabled={sending || visibleStaff.length === 0}
            onClick={ringRole}
            data-testid="ptt-ring-role"
          >
            <Users className="mr-2 h-4 w-4" />
            {roleChoice === "all" ? "Broadcast all staff" : `Call ${pttRoleLabel(roleChoice)} group`}
          </Button>
        )}
        {canBroadcast && (
          <Button
            type="button"
            variant="outline"
            className="w-full border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            disabled={sending || staff.length === 0}
            onClick={ringEveryone}
            data-testid="ptt-ring-everyone"
          >
            <Users className="mr-2 h-4 w-4" /> Ring talk group · {groupChannelName}
          </Button>
        )}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </div>

      {group && (
        <div className="border-t border-zinc-800 p-3" data-testid="ptt-ring-status">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
              {isDirectChannel(group.channelId) ? "Private call" : `All staff · ${channels.find((c) => c.id === group.channelId)?.name ?? group.channelId}`}
            </p>
            {anyRinging
              ? <Button type="button" size="sm" variant="ghost" className="h-7 text-red-400 hover:bg-red-500/10 hover:text-red-300" onClick={() => void cancel()} data-testid="ptt-ring-cancel">
                  <PhoneOff className="mr-1 h-3.5 w-3.5" /> Stop ringing
                </Button>
              : <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-zinc-500" onClick={() => setGroup(null)} aria-label="Hide call status">
                  <X className="h-3.5 w-3.5" />
                </Button>}
          </div>
          <ul className="space-y-1">
            {group.pages.map((page) => (
              <li key={page.id} className="flex items-center justify-between text-xs" data-testid={`ptt-ring-result-${page.targetUserId}`}>
                <span className="truncate text-zinc-300">{page.name} · {pttRoleLabel(page.role)}</span>
                <span className={cn("shrink-0 font-medium", STATUS_STYLES[page.status])}>{RING_STATUS_LABEL[page.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
