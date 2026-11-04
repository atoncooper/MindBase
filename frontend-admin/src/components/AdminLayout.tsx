import { useState } from "react";
import { Dropdown, Layout, Menu, Tag } from "antd";
import type { MenuProps } from "antd";
import {
  AuditOutlined,
  CloudServerOutlined,
  DownOutlined,
  GiftOutlined,
  HistoryOutlined,
  KeyOutlined,
  LogoutOutlined,
  PayCircleOutlined,
  ProfileOutlined,
  RollbackOutlined,
  ShareAltOutlined,
  TagsOutlined,
  TeamOutlined,
  UserOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { App as AntApp } from "antd";
import { api } from "../api/client";
import { setMe, useAuth } from "../auth";
import ChangePasswordModal from "./ChangePasswordModal";

const ROLE_LABEL: Record<string, string> = { admin: "管理员", viewer: "只读" };

/** 支付运营子菜单 key（SubMenu 不可导航，仅作为展开分组） */
const PAY_MENU_KEY = "pay";

/** pathname → 侧栏选中项：先精确匹配，再取最长路径前缀（/pay/orders/:no → /pay/orders）。 */
function selectedKeyFor(pathname: string): string {
  const keys = [
    "/shares",
    "/users",
    "/sandbox",
    "/pay/orders",
    "/pay/memberships",
    "/pay/events",
    "/pay/products",
    "/pay/grants",
    "/pay/refunds",
    "/accounts",
    "/audit",
  ];
  if (keys.includes(pathname)) return pathname;
  const prefixed = keys.filter((k) => pathname.startsWith(k + "/"));
  prefixed.sort((a, b) => b.length - a.length);
  return prefixed[0] ?? pathname;
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { me } = useAuth();
  const { modal } = AntApp.useApp();
  const [pwdOpen, setPwdOpen] = useState(false);

  const isAdmin = me?.role === "admin";

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

  // viewer 隐藏补偿开通 / 退款复核 / 账户（写操作或账户管理）
  const payChildren: MenuProps["items"] = [
    { key: "/pay/orders", icon: <ProfileOutlined />, label: "订单" },
    { key: "/pay/memberships", icon: <TeamOutlined />, label: "会员" },
    { key: "/pay/events", icon: <HistoryOutlined />, label: "权益事件" },
    { key: "/pay/products", icon: <TagsOutlined />, label: "SKU" },
    ...(isAdmin
      ? [
          { key: "/pay/grants", icon: <GiftOutlined />, label: "补偿开通" },
          { key: "/pay/refunds", icon: <RollbackOutlined />, label: "退款复核" },
        ]
      : []),
  ];

  const items: MenuProps["items"] = [
    { key: "/shares", icon: <ShareAltOutlined />, label: "分享审核" },
    { key: "/users", icon: <TeamOutlined />, label: "用户" },
    { key: "/sandbox", icon: <CloudServerOutlined />, label: "沙箱" },
    {
      key: PAY_MENU_KEY,
      icon: <PayCircleOutlined />,
      label: "支付运营",
      children: payChildren,
    },
    ...(isAdmin ? [{ key: "/accounts", icon: <UserSwitchOutlined />, label: "账户" }] : []),
    { key: "/audit", icon: <AuditOutlined />, label: "审计日志" },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider width={208} theme="light" style={{ borderRight: "1px solid #f0f0f0" }}>
        <div style={{ padding: "20px 16px 12px", fontWeight: 700, fontSize: 16 }}>
          MindBase 管理后台
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKeyFor(location.pathname)]}
          defaultOpenKeys={[PAY_MENU_KEY]}
          onClick={({ key }) => {
            if (key === PAY_MENU_KEY) return;
            navigate(key);
          }}
          items={items}
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
