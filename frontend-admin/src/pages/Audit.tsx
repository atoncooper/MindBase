import { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Input, Select, Space, Table, Tag, Tooltip } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { AuditItem } from "../api/types";
import { formatTime } from "../components/format";

/** 操作 → 中文标签 / 颜色（未知 action 原样展示，不隐藏历史记录）。 */
const ACTION_META: Record<string, { label: string; color: string }> = {
  ban: { label: "封杀", color: "red" },
  unban: { label: "解封", color: "green" },
  approve: { label: "放行", color: "blue" },
  preview_content: { label: "预览内容", color: "geekblue" },
  login: { label: "登录", color: "default" },
  logout: { label: "登出", color: "default" },
  change_password: { label: "修改密码", color: "gold" },
  // 登录安全事件（失败/新设备/新 IP/会话绑定不匹配）
  login_failed: { label: "登录失败", color: "red" },
  login_new_device: { label: "新设备登录", color: "orange" },
  login_new_ip: { label: "新 IP 登录", color: "orange" },
  session_device_mismatch: { label: "设备不匹配", color: "volcano" },
  session_ip_mismatch: { label: "IP 不匹配", color: "volcano" },
  // 支付运营与统一控制台账户管理
  pay_grant: { label: "补偿开通", color: "volcano" },
  pay_refund_approve: { label: "退款通过", color: "green" },
  pay_refund_reject: { label: "退款驳回", color: "red" },
  account_create: { label: "新建账户", color: "cyan" },
  account_password_reset: { label: "重置账户密码", color: "gold" },
  account_delete: { label: "删除账户", color: "red" },
};

const ACTION_OPTIONS = [
  { value: "", label: "全部操作" },
  { value: "ban", label: "封杀" },
  { value: "unban", label: "解封" },
  { value: "approve", label: "放行" },
  { value: "preview_content", label: "预览内容" },
  { value: "login", label: "登录" },
  { value: "logout", label: "登出" },
  { value: "change_password", label: "修改密码" },
  { value: "login_failed", label: "登录失败" },
  { value: "login_new_device", label: "新设备登录" },
  { value: "login_new_ip", label: "新 IP 登录" },
  { value: "session_device_mismatch", label: "设备不匹配" },
  { value: "session_ip_mismatch", label: "IP 不匹配" },
  { value: "pay_grant", label: "补偿开通" },
  { value: "pay_refund_approve", label: "退款通过" },
  { value: "pay_refund_reject", label: "退款驳回" },
  { value: "account_create", label: "新建账户" },
  { value: "account_password_reset", label: "重置账户密码" },
  { value: "account_delete", label: "删除账户" },
];

/** 审计目标类型 → 中文标签（未知类型原样展示）。 */
const TARGET_TYPE_LABEL: Record<string, string> = {
  share: "分享",
  membership: "会员",
  admin_user: "账户",
  pay_refund: "退款单",
  session: "会话",
};

const VIEW_MODE_LABEL: Record<string, string> = {
  text: "文本预览",
  markdown: "Markdown 预览",
  html: "HTML 文本预览",
  pdf: "PDF 预览",
  image: "图片预览",
  video: "视频预览",
  audio: "音频预览",
  unsupported: "无法预览",
};

/** 从 UA 中提取可读的浏览器/客户端 + 系统，避免表格里塞整段 UA。 */
function uaSummary(ua: string): string {
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : /curl\//.test(ua) ? "curl"
    : /^node\b/i.test(ua) ? "Node"
    : /python-requests/i.test(ua) ? "Python"
    : ua.slice(0, 20) + (ua.length > 20 ? "…" : "");
  const os =
    /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad/i.test(ua) ? "iOS"
    : /Linux/i.test(ua) ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
}

/** 把后端 audit.detail 的原始串按 action 解释成审核员一眼能读懂的信息。 */
function prettyDetail(item: AuditItem): string {
  const raw = (item.detail ?? "").trim();
  switch (item.action) {
    case "ban":
      return raw ? `原因：${raw}` : "原因：-";
    case "unban":
    case "approve": {
      const reason = raw.match(/reason:\s*(.*)$/i)?.[1]?.trim();
      return reason && reason !== "(no reason given)" ? `原因：${reason}` : "原因：-";
    }
    case "preview_content": {
      const fileId = raw.match(/file_id=(\d+)/)?.[1];
      const mode = raw.match(/viewMode=(\w+)/)?.[1] ?? "";
      const name = raw.match(/file_name=(.+)$/)?.[1]?.trim();
      const parts = [
        name ? `文件：${name}` : fileId ? `文件 #${fileId}` : "",
        mode ? VIEW_MODE_LABEL[mode] ?? mode : "",
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : raw;
    }
    case "login": {
      const ip = raw.match(/ip=(\S+)/)?.[1];
      const ua = raw.match(/ua=(.*)$/)?.[1]?.trim();
      const client = ua ? uaSummary(ua) : "";
      return [ip ? `IP：${ip}` : "", client].filter(Boolean).join(" · ") || "登录";
    }
    case "logout": {
      const ip = raw.match(/ip=(\S+)/)?.[1];
      return ip ? `IP：${ip}` : "登出";
    }
    case "change_password":
      return "自助修改密码";
    case "login_failed":
    case "login_new_device":
    case "login_new_ip":
    case "session_device_mismatch":
    case "session_ip_mismatch": {
      const ip = raw.match(/ip=(\S+)/)?.[1];
      const device = raw.match(/device=(\w+)/)?.[1];
      const parts = [
        ip ? "IP：" + ip : "",
        device ? "设备：" + device : "",
      ].filter(Boolean);
      if (item.action === "login_failed") return "登录失败" + (parts.length ? " · " + parts.join(" · ") : "");
      if (item.action === "login_new_device") return "首次在该设备登录" + (parts.length ? " · " + parts.join(" · ") : "");
      if (item.action === "login_new_ip") return "首次在该 IP 登录" + (parts.length ? " · " + parts.join(" · ") : "");
      return (item.action === "session_device_mismatch" ? "会话设备不匹配，已强制退出" : "会话 IP 不匹配，已强制退出") +
        (parts.length ? " · " + parts.join(" · ") : "");
    }
    case "pay_grant": {
      // admin_audit detail = "days=.. tier=.. reason=.."
      const days = raw.match(/days=(\d+)/)?.[1];
      const tier = raw.match(/tier=(\w+)/)?.[1];
      const reason = raw.match(/reason=(.*)$/)?.[1]?.trim();
      return [
        days ? "补偿开通 " + days + " 天" : "补偿开通",
        tier ? "档位 " + tier : "",
        reason ? "原因：" + reason : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "pay_refund_approve":
    case "pay_refund_reject": {
      const label = item.action === "pay_refund_approve" ? "退款复核通过" : "退款复核驳回";
      const reason = raw.match(/reason=(.*)$/)?.[1]?.trim();
      return reason ? label + " · 原因：" + reason : label;
    }
    case "account_create": {
      const username = raw.match(/username=(\S+)/)?.[1];
      const role = raw.match(/role=(\w+)/)?.[1];
      if (username) return "新建账户 " + username + (role ? "（" + role + "）" : "");
      return raw || "新建账户";
    }
    case "account_password_reset":
      return "重置账户密码" + (item.targetId ? " #" + item.targetId : "");
    case "account_delete":
      return "删除账户" + (item.targetId ? " #" + item.targetId : "");
    default:
      return raw || "-";
  }
}

export default function Audit() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [fAction, setFAction] = useState("");
  const [fAdmin, setFAdmin] = useState("");
  const [applied, setApplied] = useState<{ action?: string; admin?: string }>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const query = () => {
    setApplied({ action: fAction || undefined, admin: fAdmin.trim() || undefined });
    setPage(1);
  };

  const reset = () => {
    setFAction("");
    setFAdmin("");
    setApplied({});
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .audit({ ...applied, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载审计日志失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, reloadToken, message]);

  const columns: ColumnsType<AuditItem> = [
    { title: "时间", dataIndex: "createdAt", width: 170, render: (v: string | null) => formatTime(v) },
    {
      title: "操作",
      dataIndex: "action",
      width: 120,
      render: (v: string) => {
        const meta = ACTION_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    { title: "管理员", dataIndex: "admin", width: 130, ellipsis: true },
    {
      title: "目标",
      key: "target",
      width: 130,
      render: (_, r) => {
        if (r.targetType === "share" && r.targetId) {
          const id = Number(r.targetId);
          return Number.isInteger(id) && id > 0 ? (
            <Tooltip title="打开该分享详情">
              <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => navigate(`/shares?share=${id}`)}>
                分享 #{id}
              </Button>
            </Tooltip>
          ) : (
            `分享 #${r.targetId}`
          );
        }
        if (r.targetType === "admin_user" && r.targetId) return "账户 #" + r.targetId;
        if (r.targetType === "pay_refund" && r.targetId) {
          const orderNo = r.targetId;
          return (
            <Tooltip title="打开该订单详情">
              <Button
                type="link"
                size="small"
                style={{ paddingInline: 0 }}
                onClick={() => navigate("/pay/orders/" + encodeURIComponent(orderNo))}
              >
                退款单 {orderNo}
              </Button>
            </Tooltip>
          );
        }
        if (r.targetType === "membership" && r.targetId) {
          const uid = r.targetId;
          return (
            <Tooltip title="查看该用户会员态">
              <Button
                type="link"
                size="small"
                style={{ paddingInline: 0 }}
                onClick={() => navigate("/pay/memberships?uid=" + encodeURIComponent(uid))}
              >
                会员 #{uid}
              </Button>
            </Tooltip>
          );
        }
        if (r.targetType || r.targetId) {
          const typeLabel = TARGET_TYPE_LABEL[r.targetType ?? ""] ?? r.targetType ?? "-";
          return typeLabel + "#" + (r.targetId ?? "-");
        }
        return "-";
      },
    },
    {
      title: "详情",
      key: "detail",
      render: (_, r) => {
        const pretty = prettyDetail(r);
        const raw = (r.detail ?? "").trim();
        return (
          <Tooltip title={raw && raw !== pretty ? raw : undefined} placement="topLeft">
            <span>{pretty}</span>
          </Tooltip>
        );
      },
    },
    { title: "ID", dataIndex: "id", width: 80, align: "right" },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="审核操作、内容预览、支付运营（补偿开通/退款复核）、账户管理、登录与改密都会记入本日志；点击「分享 #ID」「会员 #UID」可直接打开对应详情。"
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          value={fAction}
          onChange={setFAction}
          style={{ width: 160 }}
          options={ACTION_OPTIONS}
        />
        <Input
          allowClear
          placeholder="管理员用户名（精确匹配）"
          value={fAdmin}
          onChange={(e) => setFAdmin(e.target.value)}
          onPressEnter={query}
          style={{ width: 200 }}
        />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      <Table<AuditItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1000 }}
        locale={{ emptyText: "暂无审核记录" }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}
