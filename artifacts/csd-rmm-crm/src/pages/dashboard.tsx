import { useAdminAccess } from "@/hooks/use-admin-access";
import { TechBoard } from "@/components/dashboard/tech-board/tech-board";

export default function Dashboard() {
  const { can } = useAdminAccess();
  return <TechBoard canViewCalls={can("communications")} can={can} />;
}
