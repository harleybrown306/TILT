import { authPath } from "@/lib/auth-continuation";
import { isUuid } from "@/lib/training-assignment";

const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const invitationStatuses = ["pending", "accepted", "revoked", "expired"] as const;
const timestamptzPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

export type ChildLoginInvitationStatus = (typeof invitationStatuses)[number];

export type ChildLoginInvitationListItem = {
  invitation_id: string;
  invited_email: string;
  invitation_status: ChildLoginInvitationStatus;
  expires_at: string;
  created_at: string;
};

export type ChildLoginInvitationSummary = {
  athlete_display_name: string;
  expires_at: string;
  invitation_status: ChildLoginInvitationStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isTimestamp(value: unknown): value is string {
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
  if (timezone !== "Z" && (Number(offsetHourText) > 15 || Number(offsetMinuteText) > 59)) return false;
  return true;
}

function isStatus(value: unknown): value is ChildLoginInvitationStatus {
  return typeof value === "string" && invitationStatuses.includes(value as ChildLoginInvitationStatus);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function normalizeChildLoginInvitationEmail(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new Error("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email)) throw new Error("Enter a valid email address.");
  return email;
}

export function parseChildLoginInvitationCreate(data: unknown): { invitation_id: string; expires_at: string } | null {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) return null;
  const row = data[0];
  return hasExactKeys(row, ["expires_at", "invitation_id"])
    && typeof row.invitation_id === "string" && isUuid(row.invitation_id) && isTimestamp(row.expires_at)
    ? { invitation_id: row.invitation_id, expires_at: row.expires_at }
    : null;
}

function parseListRow(value: unknown): ChildLoginInvitationListItem | null {
  if (!isRecord(value)) return null;
  return hasExactKeys(value, ["created_at", "expires_at", "invitation_id", "invitation_status", "invited_email"])
    && typeof value.invitation_id === "string" && isUuid(value.invitation_id)
    && isNonemptyString(value.invited_email) && isStatus(value.invitation_status)
    && isTimestamp(value.expires_at) && isTimestamp(value.created_at)
    ? {
      invitation_id: value.invitation_id,
      invited_email: value.invited_email,
      invitation_status: value.invitation_status,
      expires_at: value.expires_at,
      created_at: value.created_at,
    }
    : null;
}

export function parseChildLoginInvitationList(data: unknown): ChildLoginInvitationListItem[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map(parseListRow);
  return rows.every((row): row is ChildLoginInvitationListItem => row !== null) ? rows : null;
}

export function parseChildLoginInvitationSummary(data: unknown):
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "summary"; value: ChildLoginInvitationSummary } {
  if (!Array.isArray(data)) return { kind: "malformed" };
  if (data.length === 0) return { kind: "none" };
  if (data.length !== 1 || !isRecord(data[0])) return { kind: "malformed" };
  const row = data[0];
  return hasExactKeys(row, ["athlete_display_name", "expires_at", "invitation_status"])
    && isNonemptyString(row.athlete_display_name) && isTimestamp(row.expires_at) && isStatus(row.invitation_status)
    ? { kind: "summary", value: { athlete_display_name: row.athlete_display_name, expires_at: row.expires_at, invitation_status: row.invitation_status } }
    : { kind: "malformed" };
}

export function parseChildLoginInvitationAcceptance(data: unknown): { athlete_id: string } | null {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) return null;
  const row = data[0];
  return hasExactKeys(row, ["athlete_id"]) && typeof row.athlete_id === "string" && isUuid(row.athlete_id)
    ? { athlete_id: row.athlete_id }
    : null;
}

export function isChildLoginInvitationToken(value: string) {
  return tokenPattern.test(value);
}

export function childLoginInvitationPath(token: string) {
  return `/child-login-invite/${token}`;
}

export function childLoginInvitationLoginPath(token: string) {
  return authPath("/login", childLoginInvitationPath(token));
}

export function childLoginInvitationStatus(summary: Pick<ChildLoginInvitationSummary, "invitation_status" | "expires_at">) {
  if (summary.invitation_status === "pending" && Date.parse(summary.expires_at) <= Date.now()) return "expired";
  return summary.invitation_status;
}

export function childLoginInvitationError() {
  return "The child login invitation could not be confirmed. Reload and review the invitation list before trying again.";
}
