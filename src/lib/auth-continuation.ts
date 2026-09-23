const invitationPattern = /^\/(invite|family-invite|guardian-invite)\/([A-Za-z0-9_-]{32,256})$/;

/** Limits auth redirects to the small set of routes this lifecycle needs. */
export function safeAuthContinuation(value: string | null | undefined) {
  const invitation = value?.match(invitationPattern);
  if (invitation) return `/${invitation[1]}/${invitation[2]}`;
  return value === "/reset-password" ? "/reset-password" : "/";
}

export function authPath(pathname: "/login" | "/signup" | "/forgot-password", next: string | null | undefined) {
  const destination = safeAuthContinuation(next);
  return destination === "/" ? pathname : `${pathname}?next=${encodeURIComponent(destination)}`;
}
