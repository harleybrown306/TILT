import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type PageProps = {
  params: Promise<{
    teamId: string;
  }>;
};

type Profile = {
  id: string;
  full_name: string | null;
};

type Membership = {
  id: string;
  role: "coach" | "assistant_coach" | "athlete";
  user_id: string;
  profiles: Profile | Profile[] | null;
};

type TrainingSession = {
  id: string;
  athlete_user_id: string;
  scheduled_date: string;
  status: string;
};

function getOne<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

export default async function TeamDashboardPage({
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

  const { data: currentMembership } = await supabase
    .from("team_memberships")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .single();

  if (
    !currentMembership ||
    !["coach", "assistant_coach"].includes(currentMembership.role)
  ) {
    redirect("/");
  }

  const [
    { data: memberships, error: membershipError },
    { data: sessions, error: sessionError },
  ] = await Promise.all([
    supabase
      .from("team_memberships")
      .select(`
        id,
        role,
        user_id,
        profiles!team_memberships_user_id_fkey (
  id,
  full_name
)
      `)
      .eq("team_id", teamId)
      .order("created_at", { ascending: true }),

    supabase
      .from("training_sessions")
      .select(`
        id,
        athlete_user_id,
        scheduled_date,
        status
      `)
      .eq("team_id", teamId),
  ]);

  if (membershipError) {
    console.error("Unable to load roster:", membershipError.message);
  }

  if (sessionError) {
    console.error("Unable to load team sessions:", sessionError.message);
  }

  const teamMemberships = (memberships ?? []) as Membership[];
  const teamSessions = (sessions ?? []) as TrainingSession[];

  const athletes = teamMemberships.filter(
    (membership) => membership.role === "athlete"
  );

  const coaches = teamMemberships.filter(
    (membership) =>
      membership.role === "coach" ||
      membership.role === "assistant_coach"
  );

  const completedSessions = teamSessions.filter(
    (session) => session.status === "completed"
  );

  const scheduledSessions = teamSessions.filter(
    (session) => session.status !== "completed"
  );

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/"
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← Back to dashboard
        </Link>

        <header className="mt-8 mb-10">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
            Coach Dashboard
          </p>

          <h1 className="mt-2 text-4xl font-bold">
            {team.name}
          </h1>

          <p className="mt-3 text-slate-400">
            Manage your roster, assignments, and athlete progress.
          </p>
        </header>

        <section className="mb-10 grid gap-4 sm:grid-cols-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">Athletes</p>
            <p className="mt-2 text-3xl font-bold">
              {athletes.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">Coaches</p>
            <p className="mt-2 text-3xl font-bold">
              {coaches.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">Scheduled</p>
            <p className="mt-2 text-3xl font-bold">
              {scheduledSessions.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">Completed</p>
            <p className="mt-2 text-3xl font-bold">
              {completedSessions.length}
            </p>
          </div>
        </section>

        <section className="mb-10">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Roster
            </p>

            <h2 className="mt-1 text-2xl font-semibold">
              Athletes
            </h2>

            <p className="mt-1 text-sm text-slate-400">
              View athlete activity and training status.
            </p>
          </div>

          {athletes.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">
              No athletes are currently on this team.
            </div>
          ) : (
            <div className="space-y-4">
              {athletes.map((membership) => {
                const profile = getOne(membership.profiles);

                const athleteSessions = teamSessions.filter(
                  (session) =>
                    session.athlete_user_id === membership.user_id
                );

                const completed = athleteSessions.filter(
                  (session) => session.status === "completed"
                ).length;

                const scheduled = athleteSessions.filter(
                  (session) => session.status !== "completed"
                ).length;

                return (
  <Link
    key={membership.id}
    href={`/teams/${teamId}/athletes/${membership.user_id}`}
    className="block rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"
  >
                    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                      <div>
                        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">
                          Athlete
                        </p>

                        <h3 className="mt-2 text-xl font-semibold">
                          {profile?.full_name ?? "Unnamed athlete"}
                        </h3>
                     </div>

                      <div className="flex gap-6 text-sm">
                        <div>
                          <p className="text-slate-500">
                            Scheduled
                          </p>
                          <p className="mt-1 text-lg font-semibold">
                            {scheduled}
                          </p>
                        </div>

                        <div>
                          <p className="text-slate-500">
                            Completed
                          </p>
                          <p className="mt-1 text-lg font-semibold">
                            {completed}
                          </p>
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Next
            </p>

            <h2 className="mt-1 text-2xl font-semibold">
              Coach Tools
            </h2>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
  <Link
    href={`/teams/${teamId}/plans`}
    className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"
  >
    <h3 className="text-lg font-semibold">Training Plans</h3>
    <p className="mt-2 text-sm text-slate-400">Manage your coach library, use TILT templates, and reuse plans across your teams.</p>
  </Link>
  <Link
    href={`/teams/${teamId}/groups`}
    className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"
  >
    <h3 className="text-lg font-semibold">
      Groups
    </h3>

    <p className="mt-2 text-sm text-slate-400">
      Organize athletes by position, grade, skill, or custom groups.
    </p>
  </Link>

  <Link
    href={`/teams/${teamId}/assign`}
    className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"
  >
    <h3 className="text-lg font-semibold">
      Assign Training
    </h3>
    <p className="mt-2 text-sm text-slate-400">
      Assign training plans to athletes.
    </p>
  </Link>

  <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
    <h3 className="text-lg font-semibold">
      Schedule
    </h3>
    <p className="mt-2 text-sm text-slate-400">
      Review upcoming team training.
    </p>
  </div>

  <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
    <h3 className="text-lg font-semibold">
      Adherence
    </h3>
    <p className="mt-2 text-sm text-slate-400">
      Track athlete completion and progress.
    </p>
  </div>
</div>
         
        </section>
      </div>
    </main>
  );
}
