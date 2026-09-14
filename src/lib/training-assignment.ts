export type AssignmentState = {
  status: "idle" | "error" | "success" | "review_required";
  message: string;
  recipientCount?: number;
};

export type AssignmentAthlete = { id: string; name: string };
export type AssignmentGroup = {
  id: string;
  name: string;
  athleteIds: string[];
};
export type AssignmentPlan = { id: string; name: string; description: string | null };

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function resolveRecipientIds(
  individualIds: string[],
  groupAthleteIds: string[],
  teamAthleteIds: string[],
) {
  const eligible = new Set(teamAthleteIds);
  return [...new Set([...individualIds, ...groupAthleteIds])]
    .filter((id) => eligible.has(id))
    .sort();
}

// Supabase limits rows per response. Never silently resolve only the first page.
export async function readAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 100;
  for (let from = 0; ; ) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error || !data) throw new Error("Unable to load assignment data.");
    rows.push(...data);
    if (data.length === 0) return rows;
    // Even a short page can reflect a configured API cap smaller than pageSize.
    from += data.length;
  }
}
