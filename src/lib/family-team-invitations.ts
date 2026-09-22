import { authPath } from "@/lib/auth-continuation";

const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FamilyInvitationSummary = {
  team_name: string;
  expires_at: string;
  invitation_status: "pending" | "accepted" | "revoked" | "expired";
};

export function isFamilyInvitationToken(value: string) {
  return tokenPattern.test(value);
}

export function familyInvitationPath(token: string) {
  return `/family-invite/${token}`;
}

export function familyInvitationLoginPath(token: string) {
  return authPath("/login", familyInvitationPath(token));
}

export function familyInvitationStatus(summary: Pick<FamilyInvitationSummary, "invitation_status" | "expires_at">) {
  if (summary.invitation_status === "pending" && Date.parse(summary.expires_at) <= Date.now()) return "expired";
  return summary.invitation_status;
}

export function normalizeFamilyInvitationEmail(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new Error("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email)) throw new Error("Enter a valid email address.");
  return email;
}

export function familyInvitationError() {
  return "The family invitation could not be created. Reload and review the invitation list before trying again.";
}
