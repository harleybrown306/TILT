export type InvitationRole = "athlete" | "assistant_coach";
export type RosterState = {
  status: "idle" | "error" | "success" | "review_required";
  message: string;
  invitationPath?: string;
  email?: string;
  role?: InvitationRole;
  expiresAt?: string;
};
export type InvitationSummary = {
  team_name: string;
  invitation_role: InvitationRole;
  expires_at: string;
  invitation_status: "pending" | "accepted" | "revoked" | "expired";
};
export function normalizeInvitationEmail(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new Error("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  return email;
}
export function canManageInvitation(managerRole: string, targetRole: string) {
  return (managerRole === "coach" && ["athlete", "assistant_coach"].includes(targetRole)) ||
    (managerRole === "assistant_coach" && targetRole === "athlete");
}
export function canRemoveMember(managerRole: string, target: { user_id: string; role: string }, userId: string, creatorId: string) {
  return target.user_id !== userId && target.user_id !== creatorId && canManageInvitation(managerRole, target.role);
}
export function isInvitationToken(token: string) { return /^[A-Za-z0-9_-]{32,256}$/.test(token); }
export function invitationLoginPath(token: string) {
  return `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
}
export function safeInvitationDestination(value: string | null) {
  const match = value?.match(/^\/invite\/([A-Za-z0-9_-]{32,256})$/);
  return match ? `/invite/${match[1]}` : "/";
}
export function canAcceptInvitation(summary: InvitationSummary, now = Date.now()) {
  return summary.invitation_status === "pending" && Date.parse(summary.expires_at) > now && ["athlete", "assistant_coach"].includes(summary.invitation_role);
}
export function effectiveInvitationStatus(status: string, expiresAt: string, now = Date.now()) {
  return status === "pending" && !(Date.parse(expiresAt) > now) ? "expired" : status;
}
export function invitationError(message: string) {
  if (/email does not match|account has no email/i.test(message)) return "Sign in with the account associated with this invitation. The signed-in account does not match.";
  if (/already a member/i.test(message)) return "You are already a member of this team. Your existing membership is unchanged.";
  if (/has expired/i.test(message)) return "This invitation has expired. Ask the coach for a new invitation.";
  if (/no longer pending/i.test(message)) return "This invitation has already been accepted, revoked, or expired. It cannot be used again.";
  if (/not found/i.test(message)) return "This invitation is invalid or unavailable.";
  if (/no longer has permission/i.test(message)) return "The inviter no longer has permission to add you. Ask a current coach for a new invitation.";
  return "The invitation could not be accepted. Check its status and the signed-in account before trying again.";
}
export function formatInvitationDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
