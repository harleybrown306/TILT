import Link from "next/link";

export type TeamTool = {
  href: string;
  label: string;
  description: string;
  featured?: boolean;
};

const statusToneClasses = {
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  amber: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  sky: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  slate: "border-slate-700 bg-slate-800 text-slate-300",
};

export function TeamWorkspaceHeader({ teamId, teamName }: { teamId: string; teamName: string }) {
  const navigation = [
    { href: `/teams/${teamId}`, label: "Overview", current: true },
    { href: `/teams/${teamId}/roster`, label: "Team" },
    { href: `/teams/${teamId}/plans`, label: "Plans" },
    { href: `/teams/${teamId}/assign`, label: "Assign" },
    { href: `/teams/${teamId}/schedule`, label: "Review" },
  ];

  return (
    <header className="mb-8 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900 shadow-2xl shadow-slate-950/20">
      <div className="flex flex-col gap-6 px-5 py-6 sm:px-7 sm:py-7 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-emerald-300">
            <span aria-hidden="true">←</span>
            Coach dashboard
          </Link>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Coach workspace</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">{teamName}</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">A focused view of your team’s current training work, roster, and follow-up.</p>
        </div>
        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-4 lg:min-w-52">
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-300">Next action</p>
          <Link href={`/teams/${teamId}/assign`} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-900">
            Assign training
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
      <nav aria-label="Team workspace" className="border-t border-slate-800 px-5 sm:px-7">
        <div className="flex min-w-max gap-1 overflow-x-auto py-3">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={item.current
                ? "rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950"
                : "rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300"}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}

export function TeamMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
      <p className="text-sm font-medium text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-white">{value}</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>
    </div>
  );
}

export function TeamStatusPill({ children, tone = "slate" }: { children: React.ReactNode; tone?: keyof typeof statusToneClasses }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusToneClasses[tone]}`}>{children}</span>;
}

export function TeamToolGroup({ eyebrow, title, description, tools }: { eyebrow: string; title: string; description: string; tools: TeamTool[] }) {
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 sm:p-6" aria-labelledby={`${eyebrow.toLowerCase()}-tools-heading`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">{eyebrow}</p>
      <h3 id={`${eyebrow.toLowerCase()}-tools-heading`} className="mt-2 text-xl font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tools.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className={tool.featured
              ? "group rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4 transition hover:border-emerald-300 hover:bg-emerald-400/15 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              : "group rounded-2xl border border-slate-800 bg-slate-950/60 p-4 transition hover:border-emerald-400/60 hover:bg-slate-800/80 focus:outline-none focus:ring-2 focus:ring-emerald-300"}
          >
            <span className="flex items-center justify-between gap-3 text-base font-semibold text-white">
              {tool.label}
              <span aria-hidden="true" className="text-emerald-400 transition group-hover:translate-x-0.5">→</span>
            </span>
            <span className="mt-2 block text-sm leading-5 text-slate-400">{tool.description}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
