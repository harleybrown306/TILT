import "server-only";

export const invitationKinds = ["assistant_coach", "family_team", "guardian", "child_self_login"] as const;
export type InvitationKind = (typeof invitationKinds)[number];

export type CanonicalApplicationUrl = { origin: string };
export type CanonicalApplicationUrlResult =
  | { ok: true; value: CanonicalApplicationUrl }
  | { ok: false; reason: "missing" | "malformed" | "unsafe" };

export type InvitationEmail = {
  to: string;
  subject: string;
  text: string;
};

export type InvitationDeliveryOutcome =
  | { kind: "accepted" }
  | { kind: "rejected" }
  | { kind: "unavailable" }
  | { kind: "ambiguous" };

export interface InvitationMailer {
  send(message: InvitationEmail): Promise<InvitationDeliveryOutcome>;
}

const loopbackHosts = new Set(["localhost", "::1", "0.0.0.0", "127.0.0.1"]);

function isLoopback(hostname: string) {
  return loopbackHosts.has(hostname) || /^127\./.test(hostname) || /^::ffff:127\./i.test(hostname);
}

/** Validates an origin, never a request-derived URL. It intentionally returns no URL when unset. */
export function canonicalApplicationUrl(value = process.env.TILT_APP_URL, production = process.env.NODE_ENV === "production"): CanonicalApplicationUrlResult {
  if (!value) return { ok: false, reason: "missing" };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, reason: "malformed" }; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return { ok: false, reason: "unsafe" };
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "unsafe" };
  if (production && (url.protocol !== "https:" || isLoopback(url.hostname.toLowerCase()))) return { ok: false, reason: "unsafe" };
  return { ok: true, value: { origin: url.origin } };
}

export function canonicalInvitationUrl(path: string, configuration = canonicalApplicationUrl()): string | null {
  if (!configuration.ok || !/^\/(?:invite|family-invite|guardian-invite|child-login-invite)\/[A-Za-z0-9_-]{32,256}$/.test(path)) return null;
  return new URL(path, `${configuration.value.origin}/`).toString();
}

export function renderInvitationEmail(input: { kind: InvitationKind; recipient: string; invitationUrl: string; expiresAt: string; teamName?: string }): InvitationEmail {
  const expires = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(input.expiresAt));
  const team = input.teamName ? ` for ${input.teamName}` : "";
  const common = `\n\nUse the link before ${expires} UTC. Sign in or create a TILT account using this verified email address. If you did not expect this invitation, you can ignore this email.`;
  const copy: Record<InvitationKind, { subject: string; purpose: string }> = {
    assistant_coach: { subject: "TILT assistant coach invitation", purpose: `You have been invited to help manage a TILT team${team}.` },
    family_team: { subject: "TILT family team invitation", purpose: `You have been invited to add a family athlete to a TILT team${team}.` },
    guardian: { subject: "TILT guardian access invitation", purpose: "You have been invited to receive TILT guardian access." },
    child_self_login: { subject: "Your TILT login invitation", purpose: "You have been invited to claim TILT self-login access." },
  };
  const message = copy[input.kind];
  return { to: input.recipient, subject: message.subject, text: `TILT\n\n${message.purpose}\n\nOpen your invitation: ${input.invitationUrl}${common}` };
}

/** Production intentionally has no transport until Phase 23 chooses one. */
export class DisabledInvitationMailer implements InvitationMailer {
  async send(): Promise<InvitationDeliveryOutcome> { return { kind: "unavailable" }; }
}

/** Test-only in-memory transport. A caller owns the instance and its contents. */
export class FakeInvitationMailer implements InvitationMailer {
  private readonly sent: InvitationEmail[] = [];
  constructor(private readonly outcomes: InvitationDeliveryOutcome[] = [{ kind: "accepted" }]) {}
  async send(message: InvitationEmail): Promise<InvitationDeliveryOutcome> {
    this.sent.push({ ...message });
    return this.outcomes[Math.min(this.sent.length - 1, this.outcomes.length - 1)] ?? { kind: "ambiguous" };
  }
  messages(): readonly InvitationEmail[] { return this.sent.map((message) => ({ ...message })); }
}
