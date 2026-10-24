import { useState } from "react";
import { Dropdown, Layout, Menu, Tag } from "antd";
import {
  AuditOutlined,
  DownOutlined,
  LogoutOutlined,
  KeyOutlined,
  ShareAltOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { App as AntApp } from "antd";
import { api } from "../api/client";
import { setMe, useAuth } from "../auth";
import ChangePasswordModal from "./ChangePasswordModal";

const ROLE_LABEL: Record<string, string> = { admin: "管理员", viewer: "只读" };

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { me } = useAuth();
  const { modal } = AntApp.useApp();
  const [pwdOpen, setPwdOpen] = useState(false);

  const logout = () => {
    modal.confirm({
      title: "确认退出登录？",
      onOk: async () => {
        try {
          await api.logout();
        } catch {
          // 忽略登出端点错误，本地清态兜底
        }
        setMe(null);
        navigate("/login", { replace: true });
      },
    });
  };

  const menu = (
    <Menu
      onClick={({ key }) => {
        if (key === "logout") logout();
        if (key === "password") setPwdOpen(true);
      }}
      items={[
        { key: "password", icon: <KeyOutlined />, label: "修改密码" },
        { type: "divider" },
        { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true },
      ]}
    />
  );

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider width={208} theme="light" style={{ borderRight: "1px solid #f0f0f0" }}>
        <div style={{ padding: "20px 16px 12px", fontWeight: 700, fontSize: 16 }}>
          MindBase 管理后台
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          onClick={({ key }) => navigate(key)}
          items={[
            { key: "/shares", icon: <ShareAltOutlined />, label: "分享审核" },
            { key: "/users", icon: <TeamOutlined />, label: "用户" },
            { key: "/audit", icon: <AuditOutlined />, label: "审计日志" },
          ]}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            borderBottom: "1px solid #f0f0f0",
            paddingInline: 24,
          }}
        >
          <Dropdown overlay={menu} trigger={["click"]}>
            <span style={{ cursor: "pointer", userSelect: "none" }}>
              <UserOutlined style={{ marginRight: 8 }} />
              {me?.username ?? "-"}
              {me?.role ? (
                <Tag style={{ marginLeft: 8 }} color={me.role === "admin" ? "blue" : "default"}>
                  {ROLE_LABEL[me.role] ?? me.role}
                </Tag>
              ) : null}
              <DownOutlined style={{ marginLeft: 8, fontSize: 12 }} />
            </span>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
      {/* 首登强制改密 */}
      {me?.mustChangePassword ? (
        <ChangePasswordModal mandatory open onClose={() => undefined} />
      ) : (
        <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
      )}
    </Layout>
  );
}
