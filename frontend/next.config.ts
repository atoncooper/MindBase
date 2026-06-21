import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.hdslb.com" },
      { protocol: "https", hostname: "**.bilivideo.com" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  // 开发模式代理：将 API 请求转发到本地后端
  // 生产环境由 nginx 处理，此 rewrite 不生效（NEXT_PUBLIC_API_URL="" 时跳过）
  async rewrites() {
    const backend = process.env.NEXT_PUBLIC_API_URL;
    if (backend) return []; // 生产模式：nginx 代理，不需要 rewrite
    // fallback 阶段：让 Next.js 先匹配静态资源、页面、动态路由（如 /quiz/shared/[token]）
    // 只有没有匹配上的路径才代理到后端，避免动态页面被代理成 JSON
    return {
      fallback: [
        {
          source: "/:path((?!_next|favicon).*)",
          destination: "http://localhost:8000/:path*",
        },
      ],
    };
  },
};

export default nextConfig;
