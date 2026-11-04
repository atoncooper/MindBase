import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { setUnauthorizedHandler } from "./api/client";
import { refreshMe } from "./auth";
import AdminLayout from "./components/AdminLayout";
import RequireAuth from "./components/RequireAuth";
import Accounts from "./pages/Accounts";
import Audit from "./pages/Audit";
import Login from "./pages/Login";
import Sandbox from "./pages/Sandbox";
import Shares from "./pages/Shares";
import Users from "./pages/Users";
import Grants from "./pages/pay/Grants";
import PayEvents from "./pages/pay/Events";
import PayMemberEvents from "./pages/pay/MemberEvents";
import PayMemberships from "./pages/pay/Memberships";
import PayOrderDetail from "./pages/pay/OrderDetail";
import PayOrders from "./pages/pay/Orders";
import PayProducts from "./pages/pay/Products";
import Refunds from "./pages/pay/Refunds";

/** 401 统一清态踢回 /login（请求层） */
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
          <Route path="sandbox" element={<Sandbox />} />
          {/* 支付运营 */}
          <Route path="pay/orders" element={<PayOrders />} />
          <Route path="pay/orders/:orderNo" element={<PayOrderDetail />} />
          <Route path="pay/memberships" element={<PayMemberships />} />
          <Route path="pay/memberships/:uid/events" element={<PayMemberEvents />} />
          <Route path="pay/events" element={<PayEvents />} />
          <Route path="pay/products" element={<PayProducts />} />
          <Route path="pay/grants" element={<Grants />} />
          <Route path="pay/refunds" element={<Refunds />} />
          {/* 统一控制台账户管理 */}
          <Route path="accounts" element={<Accounts />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/shares" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
