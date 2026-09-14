export const TEAM_TIME_ZONE = "America/Chicago";

export type AttendanceStatus =
  | "completed"
  | "pending"
  | "upcoming"
  | "missed"
  | "cancelled";

export type AttendanceSession = {
  id: string;
  athleteUserId: string;
  athleteName: string;
  scheduledDate: string;
  storedStatus: string;
  workoutName: string;
  completedAt: string | null;
  prescribedWorkMs: number | null;
};

export function localDate(date: Date, timeZone = TEAM_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return shifted.toISOString().slice(0, 10);
}

export function attendanceStatus(
  session: Pick<AttendanceSession, "scheduledDate" | "storedStatus" | "completedAt">,
  today: string
): AttendanceStatus {
  if (session.storedStatus === "cancelled") return "cancelled";
  if (session.storedStatus === "completed" || session.completedAt) return "completed";
  if (session.scheduledDate > today) return "upcoming";
  if (session.scheduledDate === today) return "pending";

  return "missed";
}

export function completedLate(
  session: Pick<AttendanceSession, "scheduledDate" | "completedAt">
) {
  return Boolean(
    session.completedAt &&
      localDate(new Date(session.completedAt)) > session.scheduledDate
  );
}

export function attendanceSummary(
  sessions: AttendanceSession[],
  today: string,
  days: 7 | 30
) {
  const from = shiftDate(today, 1 - days);
  const eligible = sessions.filter((session) => {
    const status = attendanceStatus(session, today);

    return (
      session.scheduledDate >= from &&
      session.scheduledDate <= today &&
      status !== "cancelled" &&
      (session.scheduledDate < today || status === "completed")
    );
  });
  const completed = eligible.filter(
    (session) => attendanceStatus(session, today) === "completed"
  ).length;
  const missed = eligible.length - completed;

  return {
    expected: eligible.length,
    completed,
    missed,
    percent: eligible.length ? Math.round((completed / eligible.length) * 100) : null,
  };
}

export function formatScheduledDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}
