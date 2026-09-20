import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["yaml", "mysql2"],
};

export default nextConfig;
