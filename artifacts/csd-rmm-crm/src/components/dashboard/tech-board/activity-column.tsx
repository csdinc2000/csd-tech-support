import { formatDistanceToNowStrict } from "date-fns";
import { Inbox, Lock, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Voicemail } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BoardColumn, BoardEmpty, BoardRow, BoardSkeletonRows, Pill } from "./column";
import {
  CALL_TONE,
  INTAKE_TONE,
  formatDuration,
  formatPhone,
  humanize,
  type BoardCall,
  type BoardIntake,
  type BoardSelection,
} from "./types";

export const MISSED_CALL_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);

function ago(value: string | Date | null | undefined): string {
  if (!value) return "";
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

export function ActivityColumn({
  intakes,
  intakesLoading,
  calls,
  callsLoading,
  canViewCalls,
  onSelect,
  className,
}: {
  intakes: BoardIntake[];
  intakesLoading: boolean;
  calls: BoardCall[];
  callsLoading: boolean;
  /** Call logs sit behind the "communications" staff feature. */
  canViewCalls: boolean;
  onSelect: (selection: BoardSelection) => void;
  className?: string;
}) {
  const newRequests = intakes.filter((intake) => intake.status === "new").length;
  const missedCalls = calls.filter((call) => MISSED_CALL_STATUSES.has(call.status)).length;

  return (
    <BoardColumn
      icon={Inbox}
      title="Recent Activity"
      subtitle="Service requests and incoming calls"
      className={className}
      testId="board-activity"
    >
      <Tabs defaultValue="requests" className="flex h-full flex-col">
        <TabsList className="mx-3 mt-2 grid h-9 grid-cols-2">
          <TabsTrigger value="requests" className="gap-1.5 text-xs" data-testid="board-tab-requests">
            Service Requests
            {newRequests > 0 && <CountBadge>{newRequests}</CountBadge>}
          </TabsTrigger>
          <TabsTrigger value="calls" className="gap-1.5 text-xs" data-testid="board-tab-calls">
            Call Log
            {missedCalls > 0 && <CountBadge tone="bg-red-100 text-red-800">{missedCalls}</CountBadge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {intakesLoading ? (
            <BoardSkeletonRows />
          ) : intakes.length === 0 ? (
            <BoardEmpty icon={Inbox} text="No service requests yet." />
          ) : (
            intakes.map((intake) => (
              <BoardRow
                key={intake.id}
                testId={`board-intake-${intake.id}`}
                onClick={() => onSelect({ kind: "intake", item: intake })}
                title={intake.customerName}
                meta={
                  <>
                    {intake.serviceType === "Other" && intake.serviceTypeOther ? intake.serviceTypeOther : humanize(intake.serviceType)}
                    {" · "}
                    <span className="text-gray-700">{intake.problemDescription}</span>
                  </>
                }
                trailing={
                  <div className="flex flex-col items-end gap-1">
                    <Pill tone={INTAKE_TONE[intake.status] ?? INTAKE_TONE.new}>{humanize(intake.status)}</Pill>
                    {intake.campaign === "voice_intake" && (
                      <Pill tone="bg-violet-100 text-violet-800">Voice</Pill>
                    )}
                    <span className="text-[11px] text-gray-400">{ago(intake.createdAt)}</span>
                  </div>
                }
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="calls" className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {!canViewCalls ? (
            <BoardEmpty icon={Lock} text="Call logs require approved Communications access." />
          ) : callsLoading ? (
            <BoardSkeletonRows />
          ) : calls.length === 0 ? (
            <BoardEmpty icon={PhoneCall} text="No calls logged yet." />
          ) : (
            calls.map((call) => {
              const missed = MISSED_CALL_STATUSES.has(call.status);
              const Icon = missed ? PhoneMissed : call.direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
              return (
                <BoardRow
                  key={call.id}
                  testId={`board-call-${call.id}`}
                  onClick={() => onSelect({ kind: "call", item: call })}
                  leading={
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full",
                        missed ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                  }
                  title={call.contactName ?? formatPhone(call.fromNumber)}
                  meta={
                    <>
                      {call.contactName ? `${formatPhone(call.fromNumber)} · ` : ""}
                      {call.clientName ?? call.campaignName ?? humanize(call.sourceChannel) }
                      {call.hadVoicemail && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-gray-700">
                          <Voicemail className="h-3 w-3" /> voicemail
                        </span>
                      )}
                    </>
                  }
                  trailing={
                    <div className="flex flex-col items-end gap-1">
                      <Pill tone={CALL_TONE[call.status] ?? CALL_TONE.completed}>
                        {missed ? humanize(call.status) : formatDuration(call.durationSeconds)}
                      </Pill>
                      <span className="text-[11px] text-gray-400">{ago(call.createdAt)}</span>
                    </div>
                  }
                />
              );
            })
          )}
        </TabsContent>
      </Tabs>
    </BoardColumn>
  );
}

function CountBadge({ children, tone = "bg-csd-red text-white" }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums", tone)}>
      {children}
    </span>
  );
}
