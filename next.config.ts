import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/child-login-invite/:path*",
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    }];
  },
};

export default nextConfig;
