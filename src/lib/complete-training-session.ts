type CompletionRpcRow = {
  result_id: string;
  already_completed: boolean;
};

type CompletionRpcClient = {
  rpc: (
    functionName: "complete_my_training_session",
    args: { p_session_id: string },
  ) => PromiseLike<{
    data: CompletionRpcRow[] | CompletionRpcRow | null;
    error: { message?: string } | null;
  }>;
};

export type CanonicalCompletion = {
  resultId: string;
  alreadyCompleted: boolean;
};

export async function completeTrainingSession(
  supabase: CompletionRpcClient,
  sessionId: string,
): Promise<CanonicalCompletion> {
  const { data, error } = await supabase.rpc(
    "complete_my_training_session",
    { p_session_id: sessionId },
  );

  if (error) {
    throw new Error("Unable to save workout. Retry safely.");
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.result_id !== "string" || typeof row.already_completed !== "boolean") {
    throw new Error("Unable to confirm workout completion. Retry safely.");
  }

  return {
    resultId: row.result_id,
    alreadyCompleted: row.already_completed,
  };
}
