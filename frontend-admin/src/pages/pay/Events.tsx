import { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Input, Select, Space, Table, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { payApi } from "../../api/pay";
import type { PayEventQuery, PayMembershipEventItem } from "../../api/pay";
import { formatTime } from "../../components/format";
import { EVENT_TYPE_META, EVENT_TYPE_OPTIONS } from "../../components/pay-meta";

/** 全局权益事件：uid/type 筛选 + 分页，ADMIN_GRANT 运营审计入口。 */
export default function PayEvents() {
  const { message } = AntApp.useApp();
  const [fUid, setFUid] = useState("");
  const [fType, setFType] = useState<string | undefined>(undefined);
  const [applied, setApplied] = useState<PayEventQuery>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<PayMembershipEventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const query = () => {
    const uid = fUid.trim();
    if (uid && !/^\d+$/.test(uid)) {
      message.warning("UID 必须是正整数");
      return;
    }
    setApplied({ uid: uid || undefined, type: fType || undefined });
    setPage(1);
  };

  const reset = () => {
    setFUid("");
    setFType(undefined);
    setApplied({});
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    payApi
      .events({ ...applied, page, pageSize })
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
  }, [applied, page, pageSize, reloadToken, message]);

  const columns: ColumnsType<PayMembershipEventItem> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "UID",
      dataIndex: "uid",
      width: 150,
      render: (v: string) => (
        <Link to={"/pay/memberships?uid=" + encodeURIComponent(v)}>{v}</Link>
      ),
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
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="全局权益事件流：含开通/续费/运营补偿（ADMIN_GRANT）/退款回收；运营补偿在 reason 中带操作人前缀。"
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="UID（正整数）"
          value={fUid}
          onChange={(e) => setFUid(e.target.value)}
          onPressEnter={query}
          style={{ width: 180 }}
        />
        <Select
          allowClear
          placeholder="事件类型"
          value={fType}
          onChange={setFType}
          style={{ width: 180 }}
          options={EVENT_TYPE_OPTIONS}
        />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      <Table<PayMembershipEventItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1400 }}
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
