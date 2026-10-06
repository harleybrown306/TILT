import "server-only";

import { randomUUID } from "node:crypto";

export type OperationalSurface =
  | "auth_callback"
  | "invitation_delivery"
  | "workout_event_ingest"
  | "dashboard_load"
  | "training_session_load"
  | "team_group_load"
  | "team_group_detail_load"
  | "training_assignment"
  | "athlete_detail_load";

export type OperationalFailureCode =
  | "auth_exchange_failed"
  | "invitation_delivery_reservation_failed"
  | "invitation_delivery_acknowledgement_failed"
  | "invitation_delivery_unexpected_failure"
  | "workout_event_auth_unavailable"
  | "workout_event_session_verification_failed"
  | "workout_event_batch_retryable_failure"
  | "workout_event_unexpected_failure"
  | "dashboard_membership_load_failed"
  | "dashboard_session_load_failed"
  | "training_session_exercises_load_failed"
  | "team_groups_load_failed"
  | "team_group_athletes_load_failed"
  | "team_group_memberships_load_failed"
  | "training_assignment_rpc_failed"
  | "training_assignment_result_invalid"
  | "athlete_feedback_load_failed"
  | "athlete_sessions_load_failed";

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
