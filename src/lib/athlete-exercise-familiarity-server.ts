import "server-only";

type FamiliarityClient = {
  from: (table: "athlete_exercise_familiarity") => {
    select: (columns: "exercise_id") => {
      eq: (column: "athlete_id", value: string) => {
        in: (column: "exercise_id", values: string[]) => PromiseLike<{ data: { exercise_id: string }[] | null; error: unknown }>;
      };
    };
  };
};

/** Null means the bounded RLS read was indeterminate, never "all NEW". */
export async function loadFamiliarExerciseIds(
  supabase: FamiliarityClient,
  athleteId: string,
  semanticExerciseIds: readonly string[],
): Promise<string[] | null> {
  const exerciseIds = [...new Set(semanticExerciseIds)];
  if (!exerciseIds.length) return [];
  try {
    const { data, error } = await supabase
      .from("athlete_exercise_familiarity")
      .select("exercise_id")
      .eq("athlete_id", athleteId)
      .in("exercise_id", exerciseIds);
    return error ? null : [...new Set((data ?? []).map((row) => row.exercise_id))];
  } catch {
    return null;
  }
}
