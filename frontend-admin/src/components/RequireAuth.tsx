import { Navigate } from "react-router-dom";
import { Spin } from "antd";
import type { ReactNode } from "react";
import { useAuth } from "../auth";

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spin tip="正在恢复会话…" size="large" />
      </div>
    );
  }
  if (status !== "authed") {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
