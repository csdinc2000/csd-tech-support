import { cn } from "@/lib/utils";

export function PageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-h-[calc(100vh-4rem)] bg-gray-50", className)}>
      <div className="mx-auto w-full max-w-screen-2xl">{children}</div>
    </div>
  );
}

export function PageContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("space-y-4 p-4 md:space-y-6 md:p-6", className)}>{children}</div>;
}
