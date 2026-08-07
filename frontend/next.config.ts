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
  // 开发模式代理：将 API 请求转发到 APISIX
  // 生产环境由 nginx 处理，此 rewrite 不生效（NEXT_PUBLIC_API_URL 设值时跳过）
  async rewrites() {
    const backend = process.env.NEXT_PUBLIC_API_URL;
    if (backend) return []; // 生产模式：nginx 代理，不需要 rewrite
    // dev: /tasks/* 和 /task-quiz/* 既是 Next.js 页面路由又是后端 API 路径。
    // fallback rewrites 在页面路由之后，会让 API fetch 命中页面返回 HTML（JSON parse 失败）。
    // 用 beforeFiles + X-Requested-With header 区分：
    //   fetch(API，带 header) -> APISIX（页面前拦截）
    //   页面导航（无 header）-> Next.js 页面路由
    return {
      beforeFiles: [
        {
          source: "/tasks",
          destination: "http://192.168.138.128:9080/tasks",
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
        {
          source: "/tasks/:path*",
          destination: "http://192.168.138.128:9080/tasks/:path*",
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
        {
          source: "/task-quiz/:path*",
          destination: "http://192.168.138.128:9080/task-quiz/:path*",
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
      ],
      fallback: [
        // 其他非页面路由的 API（/chat /favorites /knowledge 等）-> APISIX
        {
          source: "/:path((?!_next|favicon).*)",
          destination: "http://192.168.138.128:9080/:path*",  // via APISIX data plane (forward-auth injects X-Uid)
        },
      ],
    };
  },
};

export default nextConfig;
