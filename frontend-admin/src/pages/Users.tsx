import { useEffect, useState } from "react";
import {
  App as AntApp,
  Button,
  Descriptions,
  Drawer,
  Input,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api/client";
import type { RoleGrant, Uid, UserDetail, UserItem, UserQueryMode } from "../api/types";
import { formatTime } from "../components/format";
import { detectUserQuery } from "../components/user-query";

const STATUS_COLOR: Record<string, string> = {
  active: "green",
  normal: "green",
  banned: "red",
  disabled: "red",
};

/** 详情 roles 兜底：实测为对象数组；兼容后端旧形态（string[]） */
function normalizeGrants(detail: UserDetail): RoleGrant[] {
  const raw = detail as unknown as Record<string, unknown>;
  if (Array.isArray(raw.roles)) {
    const arr = raw.roles as unknown[];
    if (arr.every((x) => typeof x === "object" && x !== null)) return arr as RoleGrant[];
    return (arr as string[]).map((role) => ({ roleId: role, name: role, granted: null, isActive: true }));
  }
  if (Array.isArray(raw.roleDetails)) return raw.roleDetails as RoleGrant[];
  return [];
}

export default function Users() {
  const { message } = AntApp.useApp();
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState<{ value: string; mode: UserQueryMode } | null>(null);
  const [page, setPage] = useState(1);
  const detection = detectUserQuery(q);
  const [pageSize, setPageSize] = useState(20);

  const [items, setItems] = useState<UserItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [drawerUid, setDrawerUid] = useState<Uid | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .users({ q: applied?.value, mode: applied?.mode, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载用户列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, message]);

  useEffect(() => {
    if (drawerUid === null) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    api
      .userDetail(drawerUid)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载用户详情失败");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drawerUid, message]);

  const submitQuery = () => {
    const value = q.trim();
    if (!value) {
      setApplied(null);
      setPage(1);
      return;
    }
    const d = detectUserQuery(value);
    if (!d.mode) {
      message.warning(d.hint);
      return;
    }
    setApplied({ value, mode: d.mode });
    setPage(1);
  };

  const resetQuery = () => {
    setQ("");
    setApplied(null);
    setPage(1);
  };

  const columns: ColumnsType<UserItem> = [
    { title: "uid", dataIndex: "uid", width: 110 },
    { title: "邮箱", dataIndex: "email", ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "手机号", dataIndex: "phone", width: 140, render: (v: string | null) => v || "-" },
    { title: "昵称", dataIndex: "nickname", ellipsis: true, render: (v: string | null) => v || "-" },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? "default"}>{v || "-"}</Tag>,
    },
    {
      title: "角色",
      dataIndex: "roles",
      width: 260,
      render: (roles: string[] | undefined) =>
        roles && roles.length ? (
          <Space size={4} wrap>
            {roles.map((r) => (
              <Tag key={r} color="blue">
                {r}
              </Tag>
            ))}
          </Space>
        ) : (
          "-"
        ),
    },
    { title: "注册时间", dataIndex: "createdAt", width: 160, render: (v: string | null) => formatTime(v) },
  ];

  const grantColumns: ColumnsType<RoleGrant> = [
    { title: "角色", dataIndex: "name", width: 140, render: (v: string, r) => v || r.roleId },
    { title: "授予时间", dataIndex: "granted", width: 170, render: (v: string | null) => formatTime(v) },
    { title: "过期时间", dataIndex: "expires", width: 170, render: (v: string | null | undefined) => v ?? "永久" },
    {
      title: "生效",
      dataIndex: "isActive",
      width: 90,
      render: (v: boolean) => (v ? <Tag color="green">生效中</Tag> : <Tag color="default">已失效</Tag>),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }} align="start">
        <Space direction="vertical" size={2}>
          <Input
            allowClear
            placeholder="UID / 11 位手机号 / 邮箱（含 @）"
            value={q}
            status={q.trim() && !detection.valid ? "error" : undefined}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={submitQuery}
            style={{ width: 300 }}
          />
          {q.trim() ? (
            detection.mode ? (
              <Tag color="blue">按{detection.label}精确查询</Tag>
            ) : (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {detection.hint}
              </Typography.Text>
            )
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              自动识别：11 位手机号 / 含 @ 的邮箱 / 数字 UID
            </Typography.Text>
          )}
        </Space>
        <Tooltip title={detection.mode ? `后端会再校验查询方式（${detection.mode}）` : undefined}>
          <Button type="primary" onClick={submitQuery}>
            查询
          </Button>
        </Tooltip>
        <Button onClick={resetQuery}>重置</Button>
      </Space>

      <Table<UserItem>
        rowKey="uid"
        columns={columns}
        dataSource={items}
        loading={loading}
        onRow={(row) => ({
          onClick: () => setDrawerUid(row.uid),
          style: { cursor: "pointer" },
        })}
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

      <Drawer
        title={drawerUid !== null ? `用户 ${drawerUid}` : ""}
        open={drawerUid !== null}
        width={560}
        onClose={() => setDrawerUid(null)}
        destroyOnClose
      >
        {detailLoading || !detail ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <Spin />
          </div>
        ) : (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="uid">{detail.uid}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{detail.email || "-"}</Descriptions.Item>
              <Descriptions.Item label="手机号">{detail.phone || "-"}</Descriptions.Item>
              <Descriptions.Item label="昵称">{detail.nickname || "-"}</Descriptions.Item>
              <Descriptions.Item label="状态">{detail.status || "-"}</Descriptions.Item>
              <Descriptions.Item label="注册时间">{formatTime(detail.createdAt)}</Descriptions.Item>
            </Descriptions>
            <div style={{ fontWeight: 600, margin: "20px 0 8px" }}>角色明细</div>
            <Table<RoleGrant>
              size="small"
              rowKey="roleId"
              columns={grantColumns}
              dataSource={normalizeGrants(detail)}
              pagination={false}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}
