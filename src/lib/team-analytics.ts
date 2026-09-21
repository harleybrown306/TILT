import { attendanceStatus, shiftDate, type AttendanceSession } from "./team-attendance";

export function analyticsWindow(today: string, days: 7 | 30) {
  return { from: shiftDate(today, 1 - days), to: today };
}

export function inAnalyticsWindow(session: AttendanceSession, today: string, days: 7 | 30) {
  const { from, to } = analyticsWindow(today, days);
  return session.scheduledDate >= from && session.scheduledDate <= to;
}

export function completedInWindow(session: AttendanceSession, today: string, days: 7 | 30) {
  return inAnalyticsWindow(session, today, days) && attendanceStatus(session, today) === "completed";
}

export function teamAnalytics(sessions: AttendanceSession[], today: string, days: 7 | 30) {
  const completed = sessions.filter((session) => completedInWindow(session, today, days));
  const expected = sessions.filter((session) => {
    const status = attendanceStatus(session, today);
    return inAnalyticsWindow(session, today, days) && status !== "cancelled" && (session.scheduledDate < today || status === "completed");
  });
  const completedExpected = expected.filter((session) => attendanceStatus(session, today) === "completed");
  const prescribedWorkMs = completed.reduce((total, session) => total + (session.prescribedWorkMs ?? 0), 0);

  return {
    completedWorkouts: completed.length,
    prescribedWorkMs,
    trainingDays: new Set(completed.map((session) => session.scheduledDate)).size,
    expected: expected.length,
    completedExpected: completedExpected.length,
    missed: expected.length - completedExpected.length,
    attendance: expected.length ? Math.round((completedExpected.length / expected.length) * 100) : null,
    activeAthletes: new Set(completed.map((session) => session.athleteId)).size,
  };
}

export function teamTrend(sessions: AttendanceSession[], today: string, days: 7 | 30) {
  const { from } = analyticsWindow(today, days);
  const dates = Array.from({ length: days }, (_, index) => shiftDate(from, index));
  const totals = new Map(dates.map((date) => [date, 0]));
  sessions.filter((session) => completedInWindow(session, today, days)).forEach((session) => {
    totals.set(session.scheduledDate, (totals.get(session.scheduledDate) ?? 0) + (session.prescribedWorkMs ?? 0));
  });
  return dates.map((date) => ({ date, prescribedWorkMs: totals.get(date) ?? 0 }));
}
