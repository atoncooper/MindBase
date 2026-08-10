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

  const handleLogin = (token: string, user: UserInfo) => {
    login(token, user);
    setLoginOpen(false);
  };

  const isAuthed = status === "authenticated";

  return (
    <>
      <NavBar onLoginClick={() => setLoginOpen(true)} />

      {isAuthed ? <DashboardShell /> : <HeroLanding
        onShowQRLogin={() => setLoginOpen(true)}
        onShowPasswordLogin={() => setLoginOpen(true)}
        onShowDemo={() => setLoginOpen(true)}
      />}

      <LoginModal
        isOpen={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={handleLogin}
      />
    </>
  );
}
