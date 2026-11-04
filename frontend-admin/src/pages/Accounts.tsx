import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { ConsoleUserItem } from "../api/accounts";
import { accountsApi } from "../api/accounts";
import type { AdminRole } from "../api/types";
import { useAuth } from "../auth";
import { formatTime } from "../components/format";

const ROLE_META: Record<AdminRole, { label: string; color: string }> = {
  admin: { label: "管理员", color: "blue" },
  viewer: { label: "只读", color: "default" },
};

const ROLE_OPTIONS = [
  { value: "viewer", label: "只读（viewer）" },
  { value: "admin", label: "管理员（admin）" },
];

interface CreateFormValues {
  username: string;
  password: string;
  role: AdminRole;
}

interface PasswordFormValues {
  password: string;
}

export default function Accounts() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { message, modal } = AntApp.useApp();

  const [items, setItems] = useState<ConsoleUserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [saving, setSaving] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<ConsoleUserItem | null>(null);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [passwordForm] = Form.useForm<PasswordFormValues>();

  const load = useCallback(async () => {
    // viewer 不请求任何接口（页面主体也会直接给 403）
    if (!isAdmin) return;
    setLoading(true);
    try {
      const res = await accountsApi.list();
      setItems(res.items ?? []);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "加载控制台账户失败");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, message]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const submitCreate = async () => {
    const values = await createForm.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      const created = await accountsApi.create(values);
      message.success(`账户 ${created.username} 已创建（${ROLE_META[created.role]?.label ?? created.role}）`);
      setCreateOpen(false);
      createForm.resetFields();
      setReloadToken((t) => t + 1);
    } catch (err) {
      // 409 = 用户名已存在；400 = 参数校验，均透传后端 detail
      message.error(err instanceof Error ? err.message : "创建账户失败");
    } finally {
      setSaving(false);
    }
  };

  const submitResetPassword = async () => {
    if (!resetTarget) return;
    const values = await passwordForm.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      await accountsApi.resetPassword(resetTarget.id, values.password);
      message.success(`账户 ${resetTarget.username} 的密码已重置`);
      setResetTarget(null);
      passwordForm.resetFields();
      setReloadToken((t) => t + 1);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "重置密码失败");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (item: ConsoleUserItem) => {
    modal.confirm({
      title: `确认删除账户 ${item.username}？`,
      content: "删除后该账户的所有会话立即失效。不能删除当前登录账户，也不能删除最后一个管理员（后端会拦截）。",
      okText: "确认删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await accountsApi.remove(item.id);
          message.success(`账户 ${item.username} 已删除`);
          setReloadToken((t) => t + 1);
        } catch (err) {
          message.error(err instanceof Error ? err.message : "删除账户失败");
          // 抛出让 antd 保持弹窗打开，便于确认原因
          throw err;
        }
      },
    });
  };

  const columns: ColumnsType<ConsoleUserItem> = [
    { title: "ID", dataIndex: "id", width: 70, align: "right" },
    {
      title: "用户名",
      dataIndex: "username",
      width: 200,
      render: (v: string) => (
        <Space size={6}>
          <span>{v}</span>
          {v === me?.username ? <Tag color="processing">当前账户</Tag> : null}
        </Space>
      ),
    },
    {
      title: "角色",
      dataIndex: "role",
      width: 110,
      render: (v: AdminRole) => <Tag color={ROLE_META[v]?.color ?? "default"}>{ROLE_META[v]?.label ?? v}</Tag>,
    },
    {
      title: "密码状态",
      dataIndex: "mustChangePassword",
      width: 120,
      render: (v: boolean) => (v ? <Tag color="orange">需改密</Tag> : <Tag>正常</Tag>),
    },
    { title: "最近登录", dataIndex: "lastLoginAt", width: 170, render: (v: string | null) => formatTime(v) },
    { title: "创建时间", dataIndex: "createdAt", width: 170, render: (v: string | null) => formatTime(v) },
    {
      title: "操作",
      key: "action",
      width: 180,
      render: (_, row: ConsoleUserItem) => {
        const isSelf = row.username === me?.username;
        const deleteButton = (
          <Button size="small" danger disabled={isSelf} onClick={() => confirmDelete(row)}>
            删除
          </Button>
        );
        return (
          <Space size={4}>
            <Button
              size="small"
              onClick={() => {
                setResetTarget(row);
                passwordForm.resetFields();
              }}
            >
              重置密码
            </Button>
            {isSelf ? (<Tooltip title="不能删除当前登录账户"><span>{deleteButton}</span></Tooltip>) : (deleteButton)}
          </Space>
        );
      },
    },
  ];

  // viewer：直接 403，且不触发任何请求（effect 内已有 isAdmin 守卫）
  if (!isAdmin) {
    return (
      <Alert
        type="error"
        showIcon
        message="403 无权限访问"
        description="控制台账户管理仅管理员（admin）可访问；当前账户为只读角色（viewer）。"
      />
    );
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="控制台账户"
        description="用于登录本管理后台的唯一账户体系（admin 可写 / viewer 只读）。重置密码会强制该账户下次登录改密并使其现有会话全部失效；新建、重置、删除都会记入审计日志。"
      />

      <Space wrap style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建账户
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)}>
          刷新
        </Button>
      </Space>

      <Table<ConsoleUserItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1000 }}
        locale={{ emptyText: "暂无控制台账户" }}
        pagination={false}
      />

      <Modal
        title="新建控制台账户"
        open={createOpen}
        onOk={() => void submitCreate()}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnClose
      >
        <Form<CreateFormValues> form={createForm} layout="vertical" initialValues={{ role: "viewer" }} preserve={false}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: "用户名必填" },
              { min: 2, max: 64, message: "用户名长度需为 2..64 个字符" },
            ]}
          >
            <Input placeholder="2..64 个字符" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[
              { required: true, message: "初始密码必填" },
              { min: 8, max: 128, message: "密码长度需为 8..128 个字符" },
            ]}
          >
            <Input.Password placeholder="8..128 个字符" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={resetTarget ? `重置密码 · ${resetTarget.username}` : "重置密码"}
        open={resetTarget !== null}
        onOk={() => void submitResetPassword()}
        onCancel={() => {
          setResetTarget(null);
          passwordForm.resetFields();
        }}
        okText="确认重置"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="重置后该账户下次登录必须改密，且其现有会话全部失效。"
        />
        <Form<PasswordFormValues> form={passwordForm} layout="vertical">
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: "新密码必填" },
              { min: 8, max: 128, message: "密码长度需为 8..128 个字符" },
            ]}
          >
            <Input.Password placeholder="8..128 个字符" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
