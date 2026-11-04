import { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Space, Table, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { payApi } from "../../api/pay";
import type { PayProductItem } from "../../api/pay";
import { formatCents, formatTime } from "../../components/format";

const PRODUCT_STATUS_META: Record<string, { label: string; color: string }> = {
  ON_SALE: { label: "在售", color: "green" },
  OFF_SALE: { label: "下架", color: "default" },
};

/** SKU 目录：只读，改价走 app-pay 运营改库流程。 */
export default function PayProducts() {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<PayProductItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    payApi
      .products()
      .then((res) => {
        if (!cancelled) setItems(res.items ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载 SKU 目录失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken, message]);

  const columns: ColumnsType<PayProductItem> = [
    { title: "编码", dataIndex: "code", width: 180 },
    { title: "名称", dataIndex: "title", width: 220 },
    {
      title: "天数",
      dataIndex: "durationDays",
      width: 100,
      align: "right",
      render: (v: number) => v + " 天",
    },
    {
      title: "价格",
      dataIndex: "priceCents",
      width: 120,
      align: "right",
      render: (v: number) => formatCents(v),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string) => {
        const meta = PRODUCT_STATUS_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    { title: "排序", dataIndex: "sort", width: 80, align: "right" },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="SKU 目录只读；定价/上下架请走 app-pay 运营改库流程（本控制台不提供写入口）。"
      />
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)}>
          刷新
        </Button>
      </Space>
      <Table<PayProductItem>
        rowKey="code"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1100 }}
        locale={{ emptyText: "暂无 SKU" }}
        pagination={false}
      />
    </div>
  );
}
