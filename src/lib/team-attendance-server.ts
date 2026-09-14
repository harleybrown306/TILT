import "server-only";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AttendanceSession } from "./team-attendance";

type Related<T> = T | T[] | null;
type Profile = { full_name: string | null };
type Member = { user_id: string; profiles: Related<Profile> };
type Result = { completed_at: string };
type Snapshot = { workout_name: string };
type Workout = { name: string };
type Session = {
  id: string;
  athlete_user_id: string;
  scheduled_date: string;
  status: string;
  workouts: Related<Workout>;
  training_session_prescriptions: Related<Snapshot>;
  workout_results: Related<Result>;
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
        "id,athlete_user_id,scheduled_date,status,workouts(name),training_session_prescriptions(workout_name),workout_results(completed_at)"
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

    return {
      id: session.id,
      athleteUserId: session.athlete_user_id,
      athleteName: names.get(session.athlete_user_id) ?? "Former athlete",
      scheduledDate: session.scheduled_date,
      storedStatus: session.status,
      workoutName: snapshot?.workout_name ?? workout?.name ?? "Assigned workout",
      completedAt: result?.completed_at ?? null,
    };
  });

  return {
    team,
    user,
    sessions: normalized,
    athletes: [...names].map(([id, name]) => ({ id, name })),
  };
}
