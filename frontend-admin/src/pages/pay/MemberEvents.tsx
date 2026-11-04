import { useEffect, useState } from "react";
import { App as AntApp, Button, Space, Table, Tag, Typography } from "antd";
import { ArrowLeftOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useNavigate, useParams } from "react-router-dom";
import { payApi } from "../../api/pay";
import type { PayMembershipEventItem } from "../../api/pay";
import { formatTime } from "../../components/format";
import { EVENT_TYPE_META } from "../../components/pay-meta";

/** 单人权益事件：/pay/memberships/:uid/events。 */
export default function PayMemberEvents() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { uid = "" } = useParams<{ uid: string }>();

  const [items, setItems] = useState<PayMembershipEventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    payApi
      .memberEvents(uid, { page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载权益事件失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, page, pageSize, reloadToken, message]);

  const columns: ColumnsType<PayMembershipEventItem> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "类型",
      dataIndex: "type",
      width: 130,
      render: (v: string) => {
        const meta = EVENT_TYPE_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    {
      title: "订单号",
      dataIndex: "orderNo",
      width: 210,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    {
      title: "天数",
      dataIndex: "days",
      width: 90,
      align: "right",
      render: (v: number) => v + " 天",
    },
    {
      title: "变更前到期",
      dataIndex: "expireBefore",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "变更后到期",
      dataIndex: "expireAfter",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "原因",
      dataIndex: "reason",
      width: 240,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    { title: "ID", dataIndex: "id", width: 80, align: "right" },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate("/pay/memberships?uid=" + encodeURIComponent(uid))}
        >
          返回会员
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)}>
          刷新
        </Button>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {"用户 " + uid + " 的权益流水"}
        </Typography.Title>
      </Space>

      <Table<PayMembershipEventItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1300 }}
        locale={{ emptyText: "暂无权益事件" }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          showTotal: (t) => "共 " + t + " 条",
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}
