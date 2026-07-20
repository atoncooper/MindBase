import type { Metadata } from "next";
import { ZCOOL_XiaoWei, Noto_Sans_SC, Geist, Roboto } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AuthProvider } from "@/lib/auth";
import { RouteGuard } from "@/components/RouteGuard";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const display = ZCOOL_XiaoWei({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
});

const body = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-roboto",
});

export const metadata: Metadata = {
  title: "MindBase - 知识库系统",
  description: "将你的 B站收藏夹变成可对话的知识库",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={cn("font-sans", "dark", geist.variable, roboto.variable)}>
      <body className={`${display.variable} ${body.variable} ${roboto.variable} antialiased`}>
        <ThemeProvider>
          <AuthProvider>
            <RouteGuard>{children}</RouteGuard>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
