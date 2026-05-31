import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 允许加载外部图片
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.hdslb.com",
      },
      {
        protocol: "https",
        hostname: "**.bilivideo.com",
      },
      {
        protocol: "http",
        hostname: "localhost",
      },
    ],
  },
  // 环境变量
  env: {
    // Empty default = same-origin (reverse-proxy friendly).
    // SSR requests still reach backend via Docker network (api.ts fallback).
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "",
  },
};

export default nextConfig;
