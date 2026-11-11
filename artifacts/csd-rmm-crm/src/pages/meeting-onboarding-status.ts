export type MeetingOnboardingPerson = {
  email: string | null;
  approvalStatus: "approved" | "pending" | "suspended" | null;
  invitationStatus?: "pending" | "expired" | "accepted" | "revoked" | null;
  requiresOwnerApproval?: boolean;
};

export function meetingOnboardingStatus(person: MeetingOnboardingPerson) {
  if (person.approvalStatus === "suspended") {
    return { label: "Suspended", guidance: "Review this account in Staff Access before restoring access." };
  }
  if (person.approvalStatus === "pending" && (person.requiresOwnerApproval || person.invitationStatus === "accepted")) {
    return { label: "Awaiting owner approval", guidance: "The invitation was accepted. Review the completed profile in Staff Access and approve only after verification." };
  }
  if (person.approvalStatus !== "approved") {
    if (person.invitationStatus === "pending") {
      return { label: "Invitation pending", guidance: "The recipient must accept the staff invitation using the invited verified email and complete their profile, then receive owner approval." };
    }
    return {
      label: "Not enrolled",
      guidance: `Sign-in alone does not enroll staff. ${person.invitationStatus === "expired" || person.invitationStatus === "revoked" ? "The invitation is no longer active. " : ""}Send an invitation in Staff Access; verified acceptance and owner approval are required.`,
    };
  }
  if (!person.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email.trim())) {
    return { label: "Missing email", guidance: "No valid staff email is on file. Confirm the person's verified sign-in identity in Staff Access; never guess an address from their name." };
  }
  return null;
}
