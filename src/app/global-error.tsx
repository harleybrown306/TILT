"use client";

import ErrorRecovery from "@/components/error-recovery";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorRecovery error={error} retry={retry} />
      </body>
    </html>
  );
}
