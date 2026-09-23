import { authPath } from "@/lib/auth-continuation";
import { isUuid } from "@/lib/training-assignment";

const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GuardianInvitationSummary = {
  athlete_display_name: string;
  expires_at: string;
  invitation_status: "pending" | "accepted" | "revoked" | "expired";
};

export type GuardianInvitationListItem = {
  invitation_id: string;
  invited_email: string;
  invitation_status: GuardianInvitationSummary["invitation_status"];
  expires_at: string;
  created_at: string;
};

const invitationStatuses = ["pending", "accepted", "revoked", "expired"] as const;
type GuardianInvitationStatus = (typeof invitationStatuses)[number];
const timestamptzPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGuardianInvitationStatus(value: unknown): value is GuardianInvitationStatus {
  return typeof value === "string" && invitationStatuses.includes(value as GuardianInvitationStatus);
}

export function isGuardianInvitationTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = timestamptzPattern.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , timezone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return false;
  if (timezone !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 15 || offsetMinute > 59) return false;
  }
  return true;
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function parseGuardianInvitationCreate(data: unknown): { invitation_id: string; expires_at: string } | null {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) return null;
  const row = data[0];
  return typeof row.invitation_id === "string" && isUuid(row.invitation_id) && isGuardianInvitationTimestamp(row.expires_at)
    ? { invitation_id: row.invitation_id, expires_at: row.expires_at }
    : null;
}

export function parseGuardianInvitationAcceptance(data: unknown): { athlete_id: string } | null {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) return null;
  return typeof data[0].athlete_id === "string" && isUuid(data[0].athlete_id) ? { athlete_id: data[0].athlete_id } : null;
}

function parseGuardianInvitationSummaryRow(value: unknown): GuardianInvitationSummary | null {
  if (!isRecord(value)) return null;
  return isNonemptyString(value.athlete_display_name) && isGuardianInvitationTimestamp(value.expires_at) && isGuardianInvitationStatus(value.invitation_status)
    ? { athlete_display_name: value.athlete_display_name, expires_at: value.expires_at, invitation_status: value.invitation_status }
    : null;
}

export function parseGuardianInvitationSummary(data: unknown):
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "summary"; value: GuardianInvitationSummary } {
  if (!Array.isArray(data)) return { kind: "malformed" };
  if (data.length === 0) return { kind: "none" };
  if (data.length !== 1) return { kind: "malformed" };
  const value = parseGuardianInvitationSummaryRow(data[0]);
  return value ? { kind: "summary", value } : { kind: "malformed" };
}

function parseGuardianInvitationListRow(value: unknown): GuardianInvitationListItem | null {
  if (!isRecord(value)) return null;
  return typeof value.invitation_id === "string" && isUuid(value.invitation_id) && isNonemptyString(value.invited_email) && isGuardianInvitationStatus(value.invitation_status) && isGuardianInvitationTimestamp(value.expires_at) && isGuardianInvitationTimestamp(value.created_at)
    ? { invitation_id: value.invitation_id, invited_email: value.invited_email, invitation_status: value.invitation_status, expires_at: value.expires_at, created_at: value.created_at }
    : null;
}

export function parseGuardianInvitationList(data: unknown): GuardianInvitationListItem[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map(parseGuardianInvitationListRow);
  return rows.every((row): row is GuardianInvitationListItem => row !== null) ? rows : null;
}

export function isGuardianInvitationToken(value: string) {
  return tokenPattern.test(value);
}

export function guardianInvitationPath(token: string) {
  return `/guardian-invite/${token}`;
}

export function guardianInvitationLoginPath(token: string) {
  return authPath("/login", guardianInvitationPath(token));
}

export function guardianInvitationStatus(summary: Pick<GuardianInvitationSummary, "invitation_status" | "expires_at">) {
  if (summary.invitation_status === "pending" && Date.parse(summary.expires_at) <= Date.now()) return "expired";
  return summary.invitation_status;
}

export function normalizeGuardianInvitationEmail(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new Error("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email)) throw new Error("Enter a valid email address.");
  return email;
}

export function guardianInvitationError() {
  return "The guardian invitation could not be confirmed. Reload and review the invitation list before trying again.";
}
