import "server-only";

import { canonicalInvitationUrl, DisabledInvitationMailer, renderInvitationEmail, type InvitationKind, type InvitationMailer } from "@/lib/invitation-communication";
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
  try {
    return await deliverCreatedInvitation(request, mailer);
  } catch {
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
export async function deliverCreatedInvitation(request: DeliveryRequest, mailer: InvitationMailer = new DisabledInvitationMailer()): Promise<DeliveryBoundaryResult> {
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
  if (reserved.error) return "ambiguous";
  if (reserved.data?.[0]?.result === "unavailable") return "unavailable";
  if (reserved.data?.[0]?.result !== "reserved" || typeof recipient !== "string") return "rate_limited";
  const outcome = await mailer.send(renderInvitationEmail({ ...request, recipient, invitationUrl }));
  if (outcome.kind === "accepted") {
    // Provider acceptance is not inbox delivery confirmation.
    await service.rpc("server_mark_invitation_delivery_accepted", {
      p_auth_user_id: identity.authUserId,
      p_verified_email: identity.verifiedEmail,
      p_invitation_kind: request.kind,
      p_invitation_id: request.invitationId,
    });
  }
  return outcome.kind;
}
