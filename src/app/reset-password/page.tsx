import Link from "next/link";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import ResetPasswordForm from "./reset-password-form";

export default async function ResetPasswordPage() {
  const cookieStore = await cookies();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || cookieStore.get("tilt_password_recovery")?.value !== "1") return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white"><div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8"><h1 className="text-2xl font-bold">Reset link expired or invalid</h1><p className="mt-3 text-sm text-slate-400">Request a new password reset email to continue.</p><Link href="/forgot-password" className="mt-5 inline-block text-sm text-emerald-400">Request a new link</Link></div></main>;
  return <ResetPasswordForm />;
}
