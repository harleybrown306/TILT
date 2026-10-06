"use client";

import ErrorRecovery from "@/components/error-recovery";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorRecovery error={error} retry={retry} />;
}
