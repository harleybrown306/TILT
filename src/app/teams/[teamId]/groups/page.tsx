import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createGroup } from "./actions/create-group";

type PageProps = {
  params: Promise<{
    teamId: string;
  }>;
};

type GroupMembership = {
  id: string;
};

type TeamGroup = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  team_group_memberships:
    | GroupMembership[]
    | null;
};

export default async function TeamGroupsPage({
  params,
}: PageProps) {
  const { teamId } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("id, name")
    .eq("id", teamId)
    .single();

  if (teamError || !team) {
    notFound();
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

  const { data: groups, error: groupError } = await supabase
    .from("team_groups")
    .select(`
      id,
      name,
      description,
      category,
      team_group_memberships (
        id
      )
    `)
    .eq("team_id", teamId)
    .order("name", { ascending: true });

  if (groupError) {
    console.error("Unable to load team groups:", groupError.message);
  }

  const teamGroups = (groups ?? []) as TeamGroup[];

  const positionGroupCount = teamGroups.filter(
    (group) => group.category === "position"
  ).length;

  const customGroupCount = teamGroups.filter(
    (group) =>
      !group.category ||
      group.category === "custom"
  ).length;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link
          href={`/teams/${teamId}`}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← Back to {team.name}
        </Link>

        <header className="mt-8 mb-10 grid gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-start">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Team Groups
            </p>

            <h1 className="mt-2 text-4xl font-bold">
              {team.name}
            </h1>

            <p className="mt-3 max-w-xl text-slate-400">
              Organize athletes by position, grade, skill level, or any custom grouping you want.
            </p>
          </div>

          <form
            action={createGroup}
            className="w-full rounded-2xl border border-slate-800 bg-slate-900 p-5"
          >
            <input
              type="hidden"
              name="teamId"
              value={teamId}
            />

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="name"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Group name
                </label>

                <input
                  id="name"
                  name="name"
                  type="text"
                  required
                  placeholder="Defense"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none transition placeholder:text-slate-600 focus:border-emerald-500"
                />
              </div>

              <div>
                <label
                  htmlFor="category"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Category
                </label>

                <select
                  id="category"
                  name="category"
                  defaultValue="custom"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-emerald-500"
                >
                  <option value="position">
                    Position
                  </option>

                  <option value="grade">
                    Grade
                  </option>

                  <option value="skill">
                    Skill
                  </option>

                  <option value="custom">
                    Custom
                  </option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="description"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Description
                </label>

                <textarea
                  id="description"
                  name="description"
                  rows={3}
                  placeholder="Optional description"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none transition placeholder:text-slate-600 focus:border-emerald-500"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-400"
              >
                Create group
              </button>
            </div>
          </form>
        </header>

        <section className="mb-10 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Total groups
            </p>

            <p className="mt-2 text-3xl font-bold">
              {teamGroups.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Position groups
            </p>

            <p className="mt-2 text-3xl font-bold">
              {positionGroupCount}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Custom groups
            </p>

            <p className="mt-2 text-3xl font-bold">
              {customGroupCount}
            </p>
          </div>
        </section>

        <section>
          <div className="mb-5">
            <h2 className="text-2xl font-semibold">
              Groups
            </h2>

            <p className="mt-1 text-sm text-slate-400">
              Athletes can belong to more than one group.
            </p>
          </div>

          {teamGroups.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center">
              <p className="text-lg font-semibold">
                No groups yet
              </p>

              <p className="mx-auto mt-2 max-w-lg text-sm text-slate-400">
                Create groups such as Defense, Goalies, Seniors, Advanced, or any custom set of athletes you want to manage together.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {teamGroups.map((group) => {
                const memberCount =
                  group.team_group_memberships?.length ?? 0;

                return (
                  <Link
                    key={group.id}
                    href={`/teams/${teamId}/groups/${group.id}`}
                    className="block rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">
                          {group.category ?? "custom"}
                        </p>

                        <h3 className="mt-2 text-xl font-semibold">
                          {group.name}
                        </h3>

                        {group.description && (
                          <p className="mt-2 text-sm text-slate-400">
                            {group.description}
                          </p>
                        )}
                      </div>

                      <div className="rounded-full bg-slate-800 px-3 py-1 text-sm font-medium text-slate-300">
                        {memberCount}{" "}
                        {memberCount === 1
                          ? "athlete"
                          : "athletes"}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}