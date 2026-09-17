type CompletedEventQuery = PromiseLike<{
  data: { id: string }[] | null;
  error: { message?: string } | null;
}> & {
  eq: (column: "session_id" | "attempt_id" | "event_type", value: string) => CompletedEventQuery;
};

type AttemptFinalizationClient = {
  from: (table: "workout_session_events") => { select: (columns: "id") => CompletedEventQuery };
  rpc: (functionName: "finalize_my_workout_session_attempt", args: { p_attempt_id: string }) =>
    PromiseLike<{ error: { message?: string } | null }>;
};

export async function finalizePersistedWorkoutAttempt(
  supabase: unknown,
  sessionId: string,
  attemptId: string,
) {
  // The generated Supabase client has deeply recursive overloads. Keep this
  // boundary structural so calling it does not force those overloads through
  // React's callback inference.
  const client = supabase as AttemptFinalizationClient;
  const { data, error: eventError } = await client
    .from("workout_session_events")
    .select("id")
    .eq("session_id", sessionId)
    .eq("attempt_id", attemptId)
    .eq("event_type", "workout_completed");

  if (eventError || !data?.length) {
    throw new Error("Workout completion telemetry is not persisted yet.");
  }

  const { error } = await client.rpc(
    "finalize_my_workout_session_attempt",
    { p_attempt_id: attemptId },
  );

  if (error) {
    throw new Error("Workout attempt finalization needs retry.");
  }
}
