import type { NextConfig } from "next";

const APISIX_HOST = process.env.NEXT_PUBLIC_APISIX_HOST || "localhost:9080";
// MinIO 同源代理目标（Next 服务器可达的 nginx 地址）
const MINIO_PROXY_DEST = process.env.MINIO_PROXY_DEST || "http://localhost";

const nextConfig: NextConfig = {
  output: "standalone",
  // 开发模式代理：将 API 请求转发到 APISIX。
  // 生产环境（NEXT_PUBLIC_API_URL 设值）跳过 API rewrite（由 nginx 处理），
  // 但 MinIO 同源代理 rewrite 两种模式都保留（媒体元素需要同源嵌入）。
  async rewrites() {
    const backend = process.env.NEXT_PUBLIC_API_URL;
    // MinIO 同源代理：后端把 presigned URL 改写到 nginx 的 /minio-proxy 前缀
    // （浏览器可达），但页面源与该前缀不同源时（页面 :3000 vs 代理 :80），
    // nginx 的 X-Frame-Options: SAMEORIGIN 会拒绝 <iframe>/<video> 嵌入。
    // 前端把 raw.url 归一化成同源相对路径，由 Next 服务端转发，媒体元素即可
    // 保持同源。前后端约定：只要路径带 /minio-proxy/ 前缀就走此代理。
    const minioProxy = {
      source: "/minio-proxy/:path*",
      destination: `${MINIO_PROXY_DEST}/minio-proxy/:path*`,
    };
    if (backend) return { beforeFiles: [minioProxy] }; // 生产模式：仅保留 minio 代理
    // dev: /tasks/* 和 /task-quiz/* 既是 Next.js 页面路由又是后端 API 路径。
    // fallback rewrites 在页面路由之后，会让 API fetch 命中页面返回 HTML（JSON parse 失败）。
    // 用 beforeFiles + X-Requested-With header 区分：
    //   fetch(API，带 header) -> APISIX（页面前拦截）
    //   页面导航（无 header）-> Next.js 页面路由
    return {
      beforeFiles: [
        minioProxy,
        {
          source: "/tasks",
          destination: `http://${APISIX_HOST}/tasks`,
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
        {
          source: "/tasks/:path*",
          destination: `http://${APISIX_HOST}/tasks/:path*`,
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
        {
          source: "/task-quiz/:path*",
          destination: `http://${APISIX_HOST}/task-quiz/:path*`,
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
        // /notes 既是页面路由 (app/notes/page.tsx) 又是后端 API 根路径 (GET /notes)。
        // 不加 beforeFiles 的话 fallback 在页面路由之后，fetch("/notes") 会命中页面返回
        // HTML，JSON parse 失败 -> 列表空。靠 X-Requested-With 区分 API fetch 与页面导航。
        {
          source: "/notes",
          destination: `http://${APISIX_HOST}/notes`,
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
        {
          source: "/notes/:path*",
          destination: `http://${APISIX_HOST}/notes/:path*`,
          has: [{ type: "header", key: "X-Requested-With", value: "XMLHttpRequest" }],
        },
      ],
      fallback: [
        // 其他非页面路由的 API（/chat /favorites /knowledge 等）-> APISIX
        {
          source: "/:path((?!_next|favicon).*)",
          destination: `http://${APISIX_HOST}/:path*`, // via APISIX data plane (forward-auth injects X-Uid)
        },
      ],
    };
  },
};

export default nextConfig;
