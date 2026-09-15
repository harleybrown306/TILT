export type ResetPasswordState = { status: "idle" | "error" | "success"; message: string };

export const initialResetPasswordState: ResetPasswordState = {
  status: "idle",
  message: "",
};
