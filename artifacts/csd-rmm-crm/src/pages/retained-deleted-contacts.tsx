import { useQuery } from "@tanstack/react-query";
import { Archive, ArrowUpRight, Link2, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type LinkedRecord = {
  id: string;
  label: string;
  href: string | null;
  status: string | null;
  date: string | null;
};

type PlaceholderReference = {
  tableName: string;
  columnName: string;
  count: number;
  records: LinkedRecord[];
};

type PlaceholderReview = {
  id: number;
  fullName: string;
  references: PlaceholderReference[];
  totalReferences: number;
};

const referenceLabels: Record<string, string> = {
  invoices: "Invoices",
  appointments: "Bookings",
  booking_appointments: "Legacy bookings",
};

function labelForReference(reference: PlaceholderReference) {
  return referenceLabels[reference.tableName] ?? reference.tableName.replaceAll("_", " ");
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function RecordLink({ record }: { record: LinkedRecord }) {
  const content = (
    <>
      <span className="font-medium">{record.label}</span>
      {record.status && <span className="text-xs text-muted-foreground">{record.status}</span>}
      {record.date && <span className="text-xs text-muted-foreground">{formatDate(record.date)}</span>}
      {record.href && <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />}
    </>
  );

  if (!record.href) {
    return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">{content}</div>;
  }

  return (
    <a
      href={record.href}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-blue-700 hover:text-blue-900 hover:underline"
    >
      {content}
    </a>
  );
}

export default function RetainedDeletedContacts() {
  const { data: placeholders = [], isLoading, isError, refetch } = useQuery<PlaceholderReview[]>({
    queryKey: ["/api/crm/deleted-contact-placeholders"],
  });

  const totalReferences = placeholders.reduce((sum, placeholder) => sum + placeholder.totalReferences, 0);

  if (isLoading) {
    return (
      <main className="min-h-[calc(100dvh-4rem)] bg-gray-50 p-4 lg:p-7">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="h-9 w-80 animate-pulse rounded bg-gray-200" />
          <div className="h-28 animate-pulse rounded-xl bg-gray-200" />
          <div className="h-64 animate-pulse rounded-xl bg-gray-200" />
        </div>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="min-h-[calc(100dvh-4rem)] bg-gray-50 p-4 lg:p-7">
        <div className="mx-auto max-w-6xl">
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Retained contacts are unavailable</AlertTitle>
            <AlertDescription className="mt-2 flex flex-wrap items-center gap-3">
              We could not load the cleanup review.
              <button type="button" onClick={() => refetch()} className="font-semibold underline">
                Try again
              </button>
            </AlertDescription>
          </Alert>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-gray-50 p-4 lg:p-7">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="border-l-4 border-csd-red pl-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-csd-red">
            <Archive className="h-4 w-4" />
            CRM data stewardship
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Retained deleted contacts</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Legacy contact placeholders remain only when invoices or booking history still point to them.
            Review the relationships below without changing the historical records.
          </p>
        </header>

        <Alert className="border-amber-200 bg-amber-50 text-amber-950">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Read-only history protection</AlertTitle>
          <AlertDescription className="mt-1">
            Referenced placeholders cannot be deleted from this screen. The links below open the
            existing invoice or booking detail where one is available.
          </AlertDescription>
        </Alert>

        <section className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="rounded-lg bg-slate-100 p-3 text-slate-700"><Archive className="h-5 w-5" /></div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Retained placeholders</p>
                <p className="mt-1 text-2xl font-bold">{placeholders.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="rounded-lg bg-amber-100 p-3 text-amber-700"><Link2 className="h-5 w-5" /></div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Historical references</p>
                <p className="mt-1 text-2xl font-bold">{totalReferences}</p>
              </div>
            </CardContent>
          </Card>
        </section>

        {placeholders.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Archive className="mx-auto h-10 w-10 text-emerald-600" />
              <h2 className="mt-4 text-lg font-semibold">No retained placeholders</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The cleanup process has no deleted contacts that still need to preserve history.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {placeholders.map((placeholder) => {
              const referencedTypes = placeholder.references.filter((reference) => reference.count > 0);
              return (
                <Card key={placeholder.id} className="overflow-hidden">
                  <CardHeader className="border-b bg-white">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="text-lg">{placeholder.fullName || `Deleted contact #${placeholder.id}`}</CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">Placeholder ID #{placeholder.id}</p>
                      </div>
                      <Badge variant="outline" className="w-fit border-amber-300 bg-amber-50 text-amber-800">
                        {placeholder.totalReferences} {placeholder.totalReferences === 1 ? "reference" : "references"} retained
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Relationship</TableHead>
                          <TableHead className="w-28">Count</TableHead>
                          <TableHead>History</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {referencedTypes.map((reference) => (
                          <TableRow key={`${reference.tableName}.${reference.columnName}`}>
                            <TableCell className="font-medium capitalize">
                              {labelForReference(reference)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary">{reference.count}</Badge>
                            </TableCell>
                            <TableCell>
                              {reference.records.length > 0 ? (
                                <div className="space-y-2">
                                  {reference.records.map((record) => <RecordLink key={record.id} record={record} />)}
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">
                                  No detail view is available for these records.
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {referencedTypes.length === 0 && (
                      <div className="p-5 text-sm text-muted-foreground">
                        No active relationship rows were found. This placeholder can be removed by the cleanup command.
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}