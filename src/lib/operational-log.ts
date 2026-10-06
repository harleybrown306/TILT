import "server-only";

import { randomUUID } from "node:crypto";

export type OperationalSurface =
  | "auth_callback"
  | "invitation_delivery"
  | "workout_event_ingest";

export type OperationalFailureCode =
  | "auth_exchange_failed"
  | "invitation_delivery_reservation_failed"
  | "invitation_delivery_acknowledgement_failed"
  | "invitation_delivery_unexpected_failure"
  | "workout_event_auth_unavailable"
  | "workout_event_session_verification_failed"
  | "workout_event_batch_retryable_failure"
  | "workout_event_unexpected_failure";

/** An opaque, server-generated reference for one meaningful operation. */
export function createOperationalReference() {
  return randomUUID();
}

/**
 * Deliberately records only allowlisted operational facts. Do not add error
 * messages, request data, identity data, tokens, or provider payloads here.
 */
export function logOperationalFailure(input: {
  reference: string;
  surface: OperationalSurface;
  code: OperationalFailureCode;
}) {
  console.error("[TILT operational failure]", {
    reference: input.reference,
    surface: input.surface,
    code: input.code,
  });
}
