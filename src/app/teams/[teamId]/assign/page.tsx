import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readAllRows, resolveRecipientIds, type AssignmentAthlete, type AssignmentGroup } from "@/lib/training-assignment";
import AssignmentForm from "./assignment-form";

type LegacyAthleteRow = {
  user_id: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
};
type DurableRosterRow = { athlete_id: string };
type GroupRow = { id: string; name: string };
type GroupMemberRow = { team_group_id: string; athlete_user_id: string };
type PlanRow = { id: string; name: string; description: string | null };

export default async function AssignTrainingPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership, error: membershipError } = await supabase
    .from("team_memberships")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .single();
  if (membershipError || !membership ||
      !["coach", "assistant_coach"].includes(membership.role)) redirect("/");

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("id, name")
    .eq("id", teamId)
    .single();
  if (teamError || !team) notFound();

  let assignmentData: {
    plans: PlanRow[];
    athletes: AssignmentAthlete[];
    groups: AssignmentGroup[];
    defaultStartDate: string;
  } | null = null;
  try {
    const [plans, groups, legacyRoster, durableRoster] = await Promise.all([
      readAllRows<PlanRow>((from, to) => supabase
        .from("training_plans")
        .select("id, name, description")
        .eq("status", "active")
        .eq("kind", "coach")
        .eq("visibility", "private")
        .eq("owner_user_id", user.id)
        .order("name")
        .order("id")
        .range(from, to)),
      readAllRows<GroupRow>((from, to) => supabase
        .from("team_groups")
        .select("id, name")
        .eq("team_id", team.id)
        .order("name")
        .order("id")
        .range(from, to)),
      readAllRows<LegacyAthleteRow>((from, to) => supabase
        .from("team_memberships")
        .select("user_id, profiles!team_memberships_user_id_fkey(full_name)")
        .eq("team_id", team.id)
        .eq("role", "athlete")
        .order("id")
        .range(from, to)),
      readAllRows<DurableRosterRow>((from, to) => supabase
        .from("team_athlete_memberships")
        .select("athlete_id")
        .eq("team_id", team.id)
        .order("id")
        .range(from, to)),
    ]);

    const members = groups.length ? await readAllRows<GroupMemberRow>((from, to) => supabase
      .from("team_group_memberships")
      .select("team_group_id, athlete_user_id")
      .in("team_group_id", groups.map((group) => group.id))
      .order("id")
      .range(from, to)) : [];
    const durableAthleteIds = new Set(durableRoster.map((membership) => membership.athlete_id));
    // Legacy roster/profile rows provide the existing display names. A recipient
    // is emitted only from the durable roster; current legacy groups map through
    // this same-UUID overlap until group membership receives its own cutover.
    const athletes = legacyRoster.flatMap((row) => {
      if (!durableAthleteIds.has(row.user_id)) return [];
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return [{ athleteId: row.user_id, name: profile?.full_name || "Unnamed athlete" }];
    }).sort((a, b) => a.name.localeCompare(b.name));
    const memberIdsByGroup = new Map<string, string[]>();
    for (const member of members) {
      const ids = memberIdsByGroup.get(member.team_group_id) ?? [];
      ids.push(member.athlete_user_id);
      memberIdsByGroup.set(member.team_group_id, ids);
    }
    const teamAthleteIds = athletes.map((athlete) => athlete.athleteId);

    const dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value;
    const today = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;

    assignmentData = {
      plans,
      athletes,
      groups: groups.map((group) => ({
        ...group,
        athleteIds: resolveRecipientIds([], memberIdsByGroup.get(group.id) ?? [], teamAthleteIds),
      })),
      defaultStartDate: today,
    };
  } catch {
    assignmentData = null;
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href={`/teams/${team.id}`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">
          ← Back to team dashboard
        </Link>
        <header className="my-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">{team.name}</p>
          <h1 className="mt-2 text-4xl font-bold">Assign Training</h1>
          <p className="mt-3 text-slate-400">Choose an active plan from your coach library and select groups or athletes on {team.name}.</p>
        </header>
        {assignmentData ? <AssignmentForm teamId={team.id} {...assignmentData} /> : (
          <div role="alert" className="rounded-2xl border border-rose-900 bg-slate-900 p-6 text-rose-300">
            Unable to load training plans or recipients. Reload this page before assigning training.
          </div>
        )}
      </div>
    </main>
  );
}
