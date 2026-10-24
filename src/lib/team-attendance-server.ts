import "server-only";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  athleteExerciseAdherenceInput,
  type AthleteAdherenceAttemptRow,
} from "./athlete-exercise-adherence";
import { isUuid, readAllRows } from "./training-assignment";
import type { AttendanceSession } from "./team-attendance";

type Related<T> = T | T[] | null;
type RosteredAthlete = { athlete_id: string; display_name: string };
type Result = {
  id: string;
  training_session_id: string;
  athlete_id: string | null;
  athlete_user_id: string | null;
  completed_at: string;
};
type Snapshot = {
  workout_name: string;
  prescribed_work_ms: number;
  schema_version: number;
  step_count: number;
};
type PerformedVariant = { selected_variant: "assigned" | "challenge" };
type Attempt = {
  workout_result_id: string | null;
  training_session_id: string;
  athlete_id: string | null;
  athlete_user_id: string | null;
  finalization_state: string;
  measurement_version: number;
  measurement_quality: string;
  prescribed_step_count: number;
  completed_work_blocks: number;
  skipped_work_blocks: number;
};
type Workout = { name: string };
type Session = {
  id: string;
  athlete_id: string | null;
  athlete_user_id: string | null;
  scheduled_date: string;
  status: string;
  workouts: Related<Workout>;
  training_session_prescriptions: Related<Snapshot>;
  training_session_challenge_prescriptions: Related<Snapshot>;
  training_session_performed_variants: Related<PerformedVariant>;
  workout_results: Related<Result>;
  workout_session_attempts: Related<Attempt>;
};

type AttentionRow = {
  as_of_date: string;
  session_id: string;
  athlete_id: string | null;
  scheduled_date: string;
  is_cancelled: boolean;
  has_canonical_completion: boolean;
  prescribed_work_ms: number | null;
  adherence_completed_work_blocks: number | null;
  adherence_prescribed_work_blocks: number | null;
};

type Team = { id: string; name: string };
type TeamMembership = { role: string };
type Profile = { platform_role: string | null };

/**
 * Verifies access before any team-analytics RPC is invoked. Keeping this
 * close to the server-side loaders prevents proxy/session-refresh behavior
 * from becoming an authorization boundary.
 */
export async function requireTeamAnalyticsAccess(teamId: string) {
  if (!isUuid(teamId)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) redirect("/login");

  const [
    { data: team, error: teamError },
    { data: membership, error: membershipError },
    { data: profile, error: profileError },
  ] = await Promise.all([
    supabase.from("teams").select("id,name").eq("id", teamId).maybeSingle(),
    supabase
      .from("team_memberships")
      .select("role")
      .eq("team_id", teamId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("profiles").select("platform_role").eq("id", user.id).maybeSingle(),
  ]);

  if (teamError || membershipError || profileError) {
    throw new Error("Unable to validate team analytics access.");
  }

  const isTeamStaff = ["coach", "assistant_coach"].includes(
    (membership as TeamMembership | null)?.role ?? "",
  );
  const isAdmin = (profile as Profile | null)?.platform_role === "admin";
  if (!team || (!isTeamStaff && !isAdmin)) notFound();

  return { supabase, team: team as Team, user };
}

function one<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export async function loadTeamAttendance(teamId: string) {
  const { supabase, team, user } = await requireTeamAnalyticsAccess(teamId);

  const [{ data: rawAthletes, error: athleteError }, rawSessions] = await Promise.all([
    supabase.rpc("list_my_team_rostered_athlete_identities", { p_team_id: teamId }),
    readAllRows<Session>((from, to) => supabase
      .from("training_sessions")
      .select(
        "id,athlete_id,athlete_user_id,scheduled_date,status,workouts(name),training_session_prescriptions(workout_name,prescribed_work_ms,schema_version,step_count),training_session_challenge_prescriptions(workout_name,prescribed_work_ms,schema_version,step_count),training_session_performed_variants(selected_variant),workout_results(id,training_session_id,athlete_id,athlete_user_id,completed_at),workout_session_attempts(workout_result_id,training_session_id,athlete_id,athlete_user_id,finalization_state,measurement_version,measurement_quality,prescribed_step_count,completed_work_blocks,skipped_work_blocks)"
      )
      .eq("team_id", teamId)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
    ).catch(() => null),
  ]);

  if (athleteError || !rawSessions) {
    throw new Error("Unable to load team attendance.");
  }

  const athletes = (rawAthletes ?? []) as RosteredAthlete[];
  const sessions = (rawSessions ?? []) as Session[];
  const names = new Map(
    athletes.map((athlete) => [
      athlete.athlete_id,
      athlete.display_name || "Unnamed athlete",
    ])
  );
  const normalized: AttendanceSession[] = sessions.map((session) => {
    // athlete_id is the durable identity. The legacy user-id fallback retains
    // pre-family records whose durable owner was not materialized.
    const athleteId = session.athlete_id ?? session.athlete_user_id ?? "";
    const result = one(session.workout_results);
    const assignedSnapshot = one(session.training_session_prescriptions);
    const challengeSnapshot = one(session.training_session_challenge_prescriptions);
    const snapshot = one(session.training_session_performed_variants)?.selected_variant === "challenge"
      ? challengeSnapshot
      : assignedSnapshot;
    const workout = one(session.workouts);
    const attempts = Array.isArray(session.workout_session_attempts)
      ? session.workout_session_attempts
      : session.workout_session_attempts
        ? [session.workout_session_attempts]
        : [];
    const exerciseAdherenceInput = athleteExerciseAdherenceInput({
      sessionId: session.id,
      athleteId,
      result: result
        ? {
            id: result.id,
            trainingSessionId: result.training_session_id,
            athleteId: result.athlete_id ?? athleteId,
          }
        : null,
      attempts: attempts.map((attempt): AthleteAdherenceAttemptRow => ({
        workoutResultId: attempt.workout_result_id,
        trainingSessionId: attempt.training_session_id,
        athleteId: attempt.athlete_id ?? athleteId,
        finalizationState: attempt.finalization_state,
        measurementVersion: attempt.measurement_version,
        measurementQuality: attempt.measurement_quality,
        prescribedStepCount: attempt.prescribed_step_count,
        completedWorkBlocks: attempt.completed_work_blocks,
        skippedWorkBlocks: attempt.skipped_work_blocks,
      })),
      prescription: snapshot
        ? {
            sessionId: session.id,
            schemaVersion: snapshot.schema_version,
            stepCount: snapshot.step_count,
          }
        : null,
    });

    return {
      id: session.id,
      athleteId,
      athleteName: names.get(athleteId) ?? "Former athlete",
      scheduledDate: session.scheduled_date,
      storedStatus: session.status,
      workoutName: snapshot?.workout_name ?? workout?.name ?? "Assigned workout",
      completedAt: result?.completed_at ?? null,
      prescribedWorkMs: snapshot?.prescribed_work_ms ?? null,
      exerciseAdherenceInput,
    };
  });

  return {
    team,
    user,
    sessions: normalized,
    athletes: [...names].map(([id, name]) => ({ id, name })),
  };
}

/**
 * The bounded coach-facing analytics projection. Unlike the historic schedule
 * loader above, this path never reads raw results or ACT-only attempts.
 */
export async function loadTeamAttentionAttendance(teamId: string) {
  const { supabase, team } = await requireTeamAnalyticsAccess(teamId);
  const { data: rawRows, error } = await supabase.rpc(
    "list_my_team_attention_sessions",
    { p_team_id: teamId },
  );
  if (error || !rawRows) throw new Error("Unable to load team attention analytics.");

  const rows = rawRows as AttentionRow[];
  let asOfDate: string;
  if (rows.length === 0) {
    const { data: anchor, error: anchorError } = await supabase.rpc(
      "get_team_attention_as_of_date",
      { p_team_id: teamId },
    );
    if (anchorError || typeof anchor !== "string") {
      throw new Error("Unable to load team attention calendar anchor.");
    }
    asOfDate = anchor;
  } else {
    const candidate = rows[0].as_of_date;
    if (typeof candidate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)
      || rows.some((row) => row.as_of_date !== candidate)) {
      throw new Error("Team attention analytics returned an invalid snapshot.");
    }
    asOfDate = candidate;
  }

  const { data: roster, error: rosterError } = await supabase.rpc(
    "list_my_team_rostered_athlete_identities",
    { p_team_id: teamId },
  );
  if (rosterError) throw new Error("Unable to load current team roster.");
  const athletes = (roster ?? []) as RosteredAthlete[];
  const names = new Map(athletes.map((athlete) => [athlete.athlete_id, athlete.display_name || "Unnamed athlete"]));

  const sessions: AttendanceSession[] = rows.map((row) => {
    const athleteId = row.athlete_id ?? "";
    const adherenceAvailable = row.adherence_completed_work_blocks !== null && row.adherence_prescribed_work_blocks !== null;
    return {
      id: row.session_id,
      athleteId,
      athleteName: athleteId ? names.get(athleteId) ?? "Unnamed athlete" : "Former athlete",
      scheduledDate: row.scheduled_date,
      storedStatus: row.is_cancelled ? "cancelled" : "scheduled",
      workoutName: "Assigned workout",
      completedAt: null,
      hasCanonicalCompletion: row.has_canonical_completion,
      prescribedWorkMs: row.prescribed_work_ms,
      exerciseAdherenceInput: adherenceAvailable ? {
        result: { id: row.session_id, trainingSessionId: row.session_id, athleteId },
        attempt: { workoutResultId: row.session_id, trainingSessionId: row.session_id, athleteId, finalizationState: "finalized_completed", measurementVersion: 1, measurementQuality: "complete", prescribedStepCount: row.adherence_prescribed_work_blocks!, completedWorkBlocks: row.adherence_completed_work_blocks!, skippedWorkBlocks: row.adherence_prescribed_work_blocks! - row.adherence_completed_work_blocks! },
        prescription: { sessionId: row.session_id, schemaVersion: 1, stepCount: row.adherence_prescribed_work_blocks! },
      } : undefined,
    };
  });
  return { team, asOfDate, sessions, athletes: athletes.map((athlete) => ({ id: athlete.athlete_id, name: athlete.display_name || "Unnamed athlete" })) };
}
