import type { Metadata, Viewport } from "next";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./globals.css";
import "katex/dist/katex.min.css";
import { AuthProvider } from "@/lib/auth";
import { AppToastProvider } from "@/lib/app-toast";
import { RouteGuard } from "@/components/route-guard";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";

export const metadata: Metadata = {
  title: "MindBase - 让收藏变成知识",
  description: "把你的 B站收藏夹变成可对话的知识库：自动提炼、语义检索、对话式回顾。",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#fbfbfd",
  width: "device-width",
  initialScale: 1,
  // Android 键盘弹出时压缩布局视口（iOS 由 100dvh 自行处理）
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <AppRouterCacheProvider options={{ key: "mui" }}>
        <AuthProvider>
          <AppToastProvider>
            <RouteGuard>{children}</RouteGuard>
          </AppToastProvider>
        </AuthProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
