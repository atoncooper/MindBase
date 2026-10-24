import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { setUnauthorizedHandler } from "./api/client";
import { refreshMe } from "./auth";
import AdminLayout from "./components/AdminLayout";
import RequireAuth from "./components/RequireAuth";
import Audit from "./pages/Audit";
import Login from "./pages/Login";
import Shares from "./pages/Shares";
import Users from "./pages/Users";

/** 401 统一清态踢回 /login（契约 §7 请求层） */
function AuthGate() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => navigate("/login", { replace: true }));
    void refreshMe();
    return () => setUnauthorizedHandler(null);
  }, [navigate]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AdminLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/shares" replace />} />
          <Route path="shares" element={<Shares />} />
          <Route path="users" element={<Users />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/shares" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
