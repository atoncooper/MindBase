import { useState } from "react";
import { App as AntApp, Button, Form, Input } from "antd";
import {
  AuditOutlined,
  CloudServerOutlined,
  LockOutlined,
  PayCircleOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { setMe, useAuth } from "../auth";
import type { LoginResult } from "../api/types";
import ChangePasswordModal from "../components/ChangePasswordModal";

/**
 * Admin login: split brand/form card. The form is intentionally quiet — the
 * console is loopback-only, so the page prioritises clarity over marketing.
 */
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
        // First login must rotate the seeded password before entering the console.
        setForcePwd(result);
      } else {
        navigate("/shares", { replace: true });
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "登录失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-shell">
        <aside className="login-brand">
          <div>
            <div className="login-mark">MB</div>
            <h1>MindBase 管理后台</h1>
            <p>分享审核 · 支付运营 · 审计追溯</p>
            <ul className="login-features">
              <li>
                <SafetyCertificateOutlined /> 分享内容审核与放行
              </li>
              <li>
                <CloudServerOutlined /> 沙箱执行、租约与配额
              </li>
              <li>
                <PayCircleOutlined /> 支付订单 / 补偿开通 / 退款复核
              </li>
              <li>
                <AuditOutlined /> 管理操作全量审计
              </li>
            </ul>
          </div>
          <div className="login-brand-foot">仅回环访问 · 所有管理操作留痕</div>
        </aside>

        <section className="login-panel">
          <div className="login-panel-head">
            <h2>登录</h2>
            <p>使用管理员账户继续</p>
          </div>
          <Form layout="vertical" requiredMark={false} onFinish={submit} autoComplete="off" size="large">
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: "请输入用户名" }]}
            >
              <Input prefix={<UserOutlined />} placeholder="admin" autoFocus autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
          <div className="login-hint">
            首次登录需修改初始密码；账户与角色由管理员在控制台维护。
            登录会绑定当前设备与网络，清理浏览器存储、更换设备或跨网段后需重新登录。
            若持续返回 502，请确认 app-admin-api 容器状态。
          </div>
        </section>
      </div>
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
