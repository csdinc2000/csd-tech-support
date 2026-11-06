import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";

export interface MyStaffProfile {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  jobTitle: string | null;
  department: string | null;
  role: string;
  avatar: { url: string; updatedAt: string } | null;
}

export const MY_STAFF_PROFILE_KEY = ["/api/staff-profile/me"] as const;

/** The signed-in staff member's own profile, including their profile picture. */
export function useMyStaffProfile() {
  const { isLoaded, isSignedIn } = useAuth();
  return useQuery<MyStaffProfile>({
    queryKey: MY_STAFF_PROFILE_KEY,
    enabled: isLoaded && Boolean(isSignedIn),
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
}
