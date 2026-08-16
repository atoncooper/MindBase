"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import type { UserInfo } from "@/lib/api";
import { NavBar } from "@/components/nav-bar";
import { HeroLanding } from "@/components/hero-landing";
import { DashboardShell } from "@/components/dashboard-shell";
import { LoginModal } from "@/components/login-modal";

export default function Home() {
  const { status, login } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginTab, setLoginTab] = useState<"qr" | "password">("qr");
  const [loginMode, setLoginMode] = useState<"password" | "register">("password");

  const handleLogin = (token: string, user: UserInfo) => {
    login(token, user);
    setLoginOpen(false);
  };

  const isAuthed = status === "authenticated";

  return (
    <>
      <NavBar onLoginClick={() => { setLoginTab("qr"); setLoginMode("password"); setLoginOpen(true); }} />

      {isAuthed ? <DashboardShell /> : <HeroLanding
        onShowQRLogin={() => { setLoginTab("qr"); setLoginMode("password"); setLoginOpen(true); }}
        onShowPasswordLogin={() => { setLoginTab("password"); setLoginMode("password"); setLoginOpen(true); }}
        onShowRegister={() => { setLoginTab("password"); setLoginMode("register"); setLoginOpen(true); }}
        onShowDemo={() => { setLoginTab("qr"); setLoginMode("password"); setLoginOpen(true); }}
      />}

      <LoginModal
        isOpen={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={handleLogin}
        initialTab={loginTab}
        initialMode={loginMode}
      />
    </>
  );
}
