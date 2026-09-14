import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignOutButton from "@/components/sign-out-button";

type Team = {
  id: string;
  name: string;
};

type Workout = {
  id: string;
  name: string;
};

type Membership = {
  id: string;
  role: "coach" | "assistant_coach" | "athlete";
  team_id: string;
  teams: Team | Team[] | null;
};

type TrainingSession = {
  id: string;
  scheduled_date: string;
  status: string;
  team_id: string;
  workout_id: string;
  workouts: Workout | Workout[] | null;
  teams: Team | Team[] | null;
};

function getOne<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function TrainingCard({
  session,
}: {
  session: TrainingSession;
}) {
  const workout = getOne(session.workouts);
  const team = getOne(session.teams);
  const completed = session.status === "completed";

  return (
    <div className="flex flex-col justify-between gap-5 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:flex-row sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-emerald-400">
            {formatDate(session.scheduled_date)}
          </p>

          <span
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
              completed
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-slate-800 text-slate-300"
            }`}
          >
            {session.status.replace("_", " ")}
          </span>
        </div>

        <h3 className="mt-3 text-xl font-semibold">
          {workout?.name ?? "Assigned workout"}
        </h3>

        <p className="mt-1 text-sm text-slate-400">
          {team?.name ?? "Team"}
        </p>
      </div>

      <Link
        href={`/training/${session.id}`}
        className={`rounded-lg px-5 py-3 text-center font-semibold transition ${
          completed
            ? "border border-slate-700 text-slate-200 hover:bg-slate-800"
            : "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
        }`}
      >
        {completed ? "View workout" : "Start workout"}
      </Link>
    </div>
  );
}

export default async function HomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: profile },
    { data: memberships, error: membershipError },
    { data: sessions, error: sessionError },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, platform_role")
      .eq("id", user.id)
      .single(),

    supabase
      .from("team_memberships")
      .select(`
        id,
        role,
        team_id,
        teams (
          id,
          name
        )
      `)
      .eq("user_id", user.id),

    supabase
      .from("training_sessions")
      .select(`
        id,
        scheduled_date,
        status,
        team_id,
        workout_id,
        workouts (
          id,
          name
        ),
        teams (
          id,
          name
        )
      `)
      .eq("athlete_user_id", user.id)
      .order("scheduled_date", { ascending: true }),
  ]);

  if (membershipError) {
    console.error(
      "Unable to load memberships:",
      membershipError.message
    );
  }

  if (sessionError) {
    console.error(
      "Unable to load training sessions:",
      sessionError.message
    );
  }

  const teamMemberships = (memberships ?? []) as Membership[];
  const trainingSessions = (sessions ?? []) as TrainingSession[];

  const coachMemberships = teamMemberships.filter(
    (membership) =>
      membership.role === "coach" ||
      membership.role === "assistant_coach"
  );

  const athleteMemberships = teamMemberships.filter(
    (membership) => membership.role === "athlete"
  );

  const displayName =
    profile?.full_name || user.email || "TILT User";

  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value;
  const today = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;

  const todaysTraining = trainingSessions.filter(
    (session) =>
      session.scheduled_date === today &&
      session.status !== "completed"
  );

  const upcomingTraining = trainingSessions.filter(
    (session) =>
      session.scheduled_date > today &&
      session.status !== "completed"
  );

  const recentActivity = trainingSessions
    .filter((session) => session.status === "completed")
    .sort((a, b) =>
      b.scheduled_date.localeCompare(a.scheduled_date)
    )
    .slice(0, 5);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              TILT
            </p>

            <h1 className="mt-2 text-4xl font-bold">
              Welcome, {displayName}
            </h1>

            <p className="mt-3 text-slate-400">
              Your Time Interval Lacrosse Training dashboard.
            </p>
          </div>

          <SignOutButton />
        </header>

        <section className="mb-10 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Teams
            </p>
            <p className="mt-2 text-3xl font-bold">
              {teamMemberships.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Coach roles
            </p>
            <p className="mt-2 text-3xl font-bold">
              {coachMemberships.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Athlete roles
            </p>
            <p className="mt-2 text-3xl font-bold">
              {athleteMemberships.length}
            </p>
          </div>
        </section>

        {athleteMemberships.length > 0 && (
          <>
            <section id="athlete-training" className="mb-10">
              <div className="mb-4">
                <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
                  Today
                </p>

                <h2 className="mt-1 text-2xl font-semibold">
                  Today&apos;s Training
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  What you need to complete today.
                </p>
              </div>

              {todaysTraining.length === 0 ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                  <p className="font-medium">
                    You&apos;re caught up for today.
                  </p>

                  <p className="mt-1 text-sm text-slate-400">
                    No unfinished training is scheduled for today.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {todaysTraining.map((session) => (
                    <TrainingCard
                      key={session.id}
                      session={session}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="mb-10">
              <div className="mb-4">
                <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
                  Schedule
                </p>

                <h2 className="mt-1 text-2xl font-semibold">
                  Upcoming Training
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  Training your coach has scheduled next.
                </p>
              </div>

              {upcomingTraining.length === 0 ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">
                  No upcoming workouts are currently scheduled.
                </div>
              ) : (
                <div className="space-y-4">
                  {upcomingTraining.map((session) => (
                    <TrainingCard
                      key={session.id}
                      session={session}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="mb-10">
              <div className="mb-4">
                <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
                  Progress
                </p>

                <h2 className="mt-1 text-2xl font-semibold">
                  Recent Activity
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  Workouts you&apos;ve completed recently.
                </p>
              </div>

              {recentActivity.length === 0 ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">
                  Completed workouts will appear here.
                </div>
              ) : (
                <div className="space-y-4">
                  {recentActivity.map((session) => (
                    <TrainingCard
                      key={session.id}
                      session={session}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <section>
          <div className="mb-4">
            <h2 className="text-2xl font-semibold">
              Your teams
            </h2>

            <p className="mt-1 text-sm text-slate-400">
              Your experience depends on your role within each team.
            </p>
          </div>

          {teamMemberships.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">
              You are not currently a member of a team.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {teamMemberships.map((membership) => {
                const team = getOne(membership.teams);

                return (
                  <Link
  key={membership.id}
  href={membership.role === "athlete" ? "/#athlete-training" : `/teams/${membership.team_id}`}
  className="block rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"
>
  <p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">
    {membership.role.replace("_", " ")}
  </p>

  <h3 className="mt-2 text-xl font-semibold">
    {team?.name ?? "Unnamed team"}
  </h3>

  <p className="mt-3 text-sm text-slate-400">
    {membership.role === "athlete"
      ? "View your assigned training"
      : "Open team management dashboard"}
  </p>
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