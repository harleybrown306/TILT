export const MAX_TEAM_NAME_LENGTH = 100;
export type TeamCreationState = {
  status: "idle" | "error" | "review_required";
  message: string;
  teamUrl?: string;
};

export function readTeamName(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new Error("Enter a team name.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a team name.");
  if (name.length > MAX_TEAM_NAME_LENGTH) throw new Error(`Team names must be ${MAX_TEAM_NAME_LENGTH} characters or fewer.`);
  return name;
}
