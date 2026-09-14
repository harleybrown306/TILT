import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  addAthleteToGroup,
  removeAthleteFromGroup,
} from "./actions";

type PageProps = {
  params: Promise<{
    teamId: string;
    groupId: string;
  }>;
};

type AthleteMembership = {
  id: string;
  user_id: string;
  profiles:
    | {
        id: string;
        full_name: string | null;
      }
    | {
        id: string;
        full_name: string | null;
      }[]
    | null;
};

type GroupMembership = {
  athlete_user_id: string;
};

export default async function TeamGroupPage({
  params,
}: PageProps) {
  const { teamId, groupId } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("team_memberships")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .single();

  if (
    !membership ||
    !["coach", "assistant_coach"].includes(membership.role)
  ) {
    redirect("/");
  }

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("id, name")
    .eq("id", teamId)
    .single();

  if (teamError || !team) {
    notFound();
  }

  const { data: group, error: groupError } = await supabase
    .from("team_groups")
    .select("id, name, description, category")
    .eq("id", groupId)
    .eq("team_id", teamId)
    .single();

  if (groupError || !group) {
    notFound();
  }

  const { data: athletes, error: athletesError } = await supabase
    .from("team_memberships")
    .select(`
      id,
      user_id,
      profiles!team_memberships_user_id_fkey (
        id,
        full_name
      )
    `)
    .eq("team_id", teamId)
    .eq("role", "athlete")
    .order("created_at", { ascending: true });

  if (athletesError) {
    console.error(
      "Unable to load team athletes:",
      athletesError.message
    );
  }

  const { data: groupMemberships, error: groupMembershipError } =
    await supabase
      .from("team_group_memberships")
      .select("athlete_user_id")
      .eq("team_group_id", groupId);

  if (groupMembershipError) {
    console.error(
      "Unable to load group memberships:",
      groupMembershipError.message
    );
  }

  const groupMemberIds = new Set(
    ((groupMemberships ?? []) as GroupMembership[]).map(
      (item) => item.athlete_user_id
    )
  );

  const athleteRows = (athletes ?? []) as AthleteMembership[];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <Link
          href={`/teams/${teamId}/groups`}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← Back to Groups
        </Link>

        <header className="mt-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
            {group.category ?? "custom"}
          </p>

          <h1 className="mt-2 text-4xl font-bold">
            {group.name}
          </h1>

          {group.description && (
            <p className="mt-3 text-slate-400">
              {group.description}
            </p>
          )}

          <p className="mt-2 text-sm text-slate-500">
            {team.name}
          </p>
        </header>

        <section className="mt-10">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">
                Athletes
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                Manage which athletes belong to this group.
              </p>
            </div>

            <div className="rounded-full bg-slate-800 px-4 py-2 text-sm text-slate-300">
              {groupMemberIds.size}{" "}
              {groupMemberIds.size === 1
                ? "athlete"
                : "athletes"}
            </div>
          </div>

          {athleteRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center">
              <p className="font-semibold">
                No athletes on this team
              </p>

              <p className="mt-2 text-sm text-slate-400">
                Add athletes to the team roster before managing group membership.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {athleteRows.map((athlete) => {
                const profile = Array.isArray(athlete.profiles)
                  ? athlete.profiles[0]
                  : athlete.profiles;

                const isMember = groupMemberIds.has(
                  athlete.user_id
                );

                return (
                  <div
                    key={athlete.id}
                    className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-semibold">
                        {profile?.full_name ?? "Unnamed athlete"}
                      </p>

                      <p className="mt-1 text-sm text-slate-400">
                        {isMember
                          ? "Currently in this group"
                          : "Not in this group"}
                      </p>
                    </div>

                    {isMember ? (
                      <form action={removeAthleteFromGroup}>
                        <input
                          type="hidden"
                          name="teamId"
                          value={teamId}
                        />

                        <input
                          type="hidden"
                          name="groupId"
                          value={groupId}
                        />

                        <input
                          type="hidden"
                          name="athleteUserId"
                          value={athlete.user_id}
                        />

                        <button
                          type="submit"
                          className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-300 transition hover:bg-rose-500/20"
                        >
                          Remove from group
                        </button>
                      </form>
                    ) : (
                      <form action={addAthleteToGroup}>
                        <input
                          type="hidden"
                          name="teamId"
                          value={teamId}
                        />

                        <input
                          type="hidden"
                          name="groupId"
                          value={groupId}
                        />

                        <input
                          type="hidden"
                          name="athleteUserId"
                          value={athlete.user_id}
                        />

                        <button
                          type="submit"
                          className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
                        >
                          Add to group
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}