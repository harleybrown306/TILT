import "server-only";

import { canonicalInvitationUrl, DisabledInvitationMailer, renderInvitationEmail, type InvitationKind, type InvitationMailer } from "@/lib/invitation-communication";
import { createOperationalReference, logOperationalFailure } from "@/lib/operational-log";
import { createServiceClient } from "@/lib/supabase/service";
import { getCurrentVerifiedAuthIdentity } from "@/lib/verified-auth-identity";

export type DeliveryBoundaryResult = "accepted" | "rejected" | "unavailable" | "ambiguous" | "rate_limited";

type DeliveryRequest = {
  kind: InvitationKind;
  invitationId: string;
  invitationPath: string;
  expiresAt: string;
  teamName?: string;
};

/**
 * Creation is already committed when this boundary is reached. A delivery
 * problem must never turn that successful creation into a failed action or
 * hide its manual copy-link fallback.
 */
export async function attemptCreatedInvitationDelivery(request: DeliveryRequest, mailer?: InvitationMailer): Promise<DeliveryBoundaryResult> {
  const reference = createOperationalReference();
  try {
    return await deliverCreatedInvitation(request, mailer, reference);
  } catch {
    logOperationalFailure({ reference, surface: "invitation_delivery", code: "invitation_delivery_unexpected_failure" });
    return "ambiguous";
  }
}

export function deliveryRequestMessage(result: DeliveryBoundaryResult) {
  if (result === "accepted") return "The delivery request was accepted by the transport. This does not confirm inbox delivery; keep the copy-link fallback available.";
  if (result === "rejected") return "The transport rejected delivery. Use the copy-link fallback.";
  if (result === "rate_limited") return "Delivery is temporarily rate limited. Use the copy-link fallback.";
  if (result === "unavailable") return "Delivery is not configured or could not be confirmed. Use the copy-link fallback.";
  return "Delivery could not be confirmed. Use the copy-link fallback.";
}

/**
 * Internal-only boundary for a future post-commit send-on-create path. It accepts
 * neither a recipient chosen at resend time nor a request origin. Call it only
 * after the corresponding invitation creation has committed.
 */
export async function deliverCreatedInvitation(request: DeliveryRequest, mailer: InvitationMailer = new DisabledInvitationMailer(), reference = createOperationalReference()): Promise<DeliveryBoundaryResult> {
  // A disabled transport must not require a service-role secret or reserve a
  // database attempt. The invitation remains usable through its copy-link
  // fallback until an explicitly selected provider adapter is enabled.
  if (mailer instanceof DisabledInvitationMailer) return "unavailable";
  const identity = await getCurrentVerifiedAuthIdentity();
  const invitationUrl = canonicalInvitationUrl(request.invitationPath);
  if (!identity || !invitationUrl) return "unavailable";
  const service = createServiceClient();
  const reserved = await service.rpc("server_reserve_invitation_delivery_attempt", {
    p_auth_user_id: identity.authUserId,
    p_verified_email: identity.verifiedEmail,
    p_invitation_kind: request.kind,
    p_invitation_id: request.invitationId,
  });
  const recipient = reserved.data?.[0]?.recipient;
  if (reserved.error) {
    logOperationalFailure({ reference, surface: "invitation_delivery", code: "invitation_delivery_reservation_failed" });
    return "ambiguous";
  }
  if (reserved.data?.[0]?.result === "unavailable") return "unavailable";
  if (reserved.data?.[0]?.result !== "reserved" || typeof recipient !== "string") return "rate_limited";
  const outcome = await mailer.send(renderInvitationEmail({ ...request, recipient, invitationUrl }));
  if (outcome.kind === "accepted") {
    // Provider acceptance is not inbox delivery confirmation.
    const acknowledged = await service.rpc("server_mark_invitation_delivery_accepted", {
      p_auth_user_id: identity.authUserId,
      p_verified_email: identity.verifiedEmail,
      p_invitation_kind: request.kind,
      p_invitation_id: request.invitationId,
    });
    if (acknowledged.error) {
      logOperationalFailure({ reference, surface: "invitation_delivery", code: "invitation_delivery_acknowledgement_failed" });
    }
  }
  return outcome.kind;
}
