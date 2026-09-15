import "server-only";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  athleteExerciseAdherenceInput,
  type AthleteAdherenceAttemptRow,
} from "./athlete-exercise-adherence";
import type { AttendanceSession } from "./team-attendance";

type Related<T> = T | T[] | null;
type Profile = { full_name: string | null };
type Member = { user_id: string; profiles: Related<Profile> };
type Result = {
  id: string;
  training_session_id: string;
  athlete_user_id: string;
  completed_at: string;
};
type Snapshot = {
  workout_name: string;
  prescribed_work_ms: number;
  schema_version: number;
  step_count: number;
};
type Attempt = {
  workout_result_id: string | null;
  training_session_id: string;
  athlete_user_id: string;
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
  athlete_user_id: string;
  scheduled_date: string;
  status: string;
  workouts: Related<Workout>;
  training_session_prescriptions: Related<Snapshot>;
  workout_results: Related<Result>;
  workout_session_attempts: Related<Attempt>;
};

function one<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export async function loadTeamAttendance(teamId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [
    { data: team, error: teamError },
    { data: membership },
    { data: profile },
  ] = await Promise.all([
    supabase.from("teams").select("id,name").eq("id", teamId).single(),
    supabase
      .from("team_memberships")
      .select("role")
      .eq("team_id", teamId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("profiles").select("platform_role").eq("id", user.id).single(),
  ]);

  if (teamError || !team) notFound();

  const isCoach = ["coach", "assistant_coach"].includes(membership?.role ?? "");
  if (!isCoach && profile?.platform_role !== "admin") notFound();

  const [
    { data: rawMembers, error: memberError },
    { data: rawSessions, error: sessionError },
  ] = await Promise.all([
    supabase
      .from("team_memberships")
      .select("user_id,role,profiles!team_memberships_user_id_fkey(full_name)")
      .eq("team_id", teamId)
      .eq("role", "athlete"),
    supabase
      .from("training_sessions")
      .select(
        "id,athlete_user_id,scheduled_date,status,workouts(name),training_session_prescriptions(workout_name,prescribed_work_ms,schema_version,step_count),workout_results(id,training_session_id,athlete_user_id,completed_at),workout_session_attempts(workout_result_id,training_session_id,athlete_user_id,finalization_state,measurement_version,measurement_quality,prescribed_step_count,completed_work_blocks,skipped_work_blocks)"
      )
      .eq("team_id", teamId)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  if (memberError || sessionError) {
    throw new Error("Unable to load team attendance.");
  }

  const members = (rawMembers ?? []) as Member[];
  const sessions = (rawSessions ?? []) as Session[];
  const names = new Map(
    members.map((member) => [
      member.user_id,
      one(member.profiles)?.full_name ?? "Unnamed athlete",
    ])
  );
  const normalized: AttendanceSession[] = sessions.map((session) => {
    const result = one(session.workout_results);
    const snapshot = one(session.training_session_prescriptions);
    const workout = one(session.workouts);
    const attempts = Array.isArray(session.workout_session_attempts)
      ? session.workout_session_attempts
      : session.workout_session_attempts
        ? [session.workout_session_attempts]
        : [];
    const exerciseAdherenceInput = athleteExerciseAdherenceInput({
      sessionId: session.id,
      athleteUserId: session.athlete_user_id,
      result: result
        ? {
            id: result.id,
            trainingSessionId: result.training_session_id,
            athleteUserId: result.athlete_user_id,
          }
        : null,
      attempts: attempts.map((attempt): AthleteAdherenceAttemptRow => ({
        workoutResultId: attempt.workout_result_id,
        trainingSessionId: attempt.training_session_id,
        athleteUserId: attempt.athlete_user_id,
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
      athleteUserId: session.athlete_user_id,
      athleteName: names.get(session.athlete_user_id) ?? "Former athlete",
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
