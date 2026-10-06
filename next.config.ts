import type { NextConfig } from "next";

const sensitiveInvitationResponseHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      "/invite/:path*",
      "/family-invite/:path*",
      "/guardian-invite/:path*",
      "/child-login-invite/:path*",
    ].map((source) => ({ source, headers: sensitiveInvitationResponseHeaders }));
  },
};

export default nextConfig;
