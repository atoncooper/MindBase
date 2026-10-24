import { useState } from "react";
import { App as AntApp, Button, Card, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { setMe, useAuth } from "../auth";
import type { LoginResult } from "../api/types";
import ChangePasswordModal from "../components/ChangePasswordModal";

export default function Login() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { status } = useAuth();
  const [loading, setLoading] = useState(false);
  const [forcePwd, setForcePwd] = useState<LoginResult | null>(null);

  if (status === "authed" && !forcePwd) {
    return <Navigate to="/shares" replace />;
  }

  const submit = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const result = await api.login(values.username, values.password);
      setMe(result);
      if (result.mustChangePassword) {
        // 首登强制改密：先改密（POST /api/me/password），再进后台
        setForcePwd(result);
      } else {
        navigate("/shares", { replace: true });
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f5f5f7",
      }}
    >
      <Card style={{ width: 380 }} styles={{ body: { padding: "32px 32px 24px" } }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>MindBase 管理后台</div>
          <div style={{ color: "#888", marginTop: 4, fontSize: 13 }}>
            仅限管理员（RBAC admin / viewer 角色）
          </div>
        </div>
        <Form onFinish={submit} autoComplete="off">
          <Form.Item name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoFocus autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
      {forcePwd ? (
        <ChangePasswordModal
          mandatory
          open
          onClose={() => {
            setForcePwd(null);
            navigate("/shares", { replace: true });
          }}
        />
      ) : null}
    </div>
  );
}
