import { useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ArrowLeftOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { payApi } from "../../api/pay";
import type { PayCallbackItem, PayOrderItem } from "../../api/pay";
import { formatCents, formatTime } from "../../components/format";
import { CHANNEL_LABEL, ORDER_STATUS_META } from "../../components/pay-meta";

/** 订单详情：Descriptions + 渠道回调流水 + 返回。 */
export default function PayOrderDetail() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { orderNo = "" } = useParams<{ orderNo: string }>();
  const [searchParams] = useSearchParams();
  const tradeNo = searchParams.get("tradeNo") ?? undefined;

  const [order, setOrder] = useState<PayOrderItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [cbItems, setCbItems] = useState<PayCallbackItem[]>([]);
  const [cbTotal, setCbTotal] = useState(0);
  const [cbPage, setCbPage] = useState(1);
  const [cbPageSize, setCbPageSize] = useState(10);
  const [cbLoading, setCbLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    payApi
      .order(orderNo, tradeNo)
      .then((res) => {
        if (!cancelled) setOrder(res.order);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setOrder(null);
          setNotFound(true);
          return;
        }
        const detail = err instanceof Error ? err.message : "加载订单详情失败";
        setError(detail);
        message.error(detail);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderNo, tradeNo, reloadToken, message]);

  // 切换订单时回调分页归位
  useEffect(() => {
    setCbPage(1);
  }, [orderNo]);

  const resolvedNo = order?.orderNo ?? orderNo;

  useEffect(() => {
    if (!resolvedNo || notFound) return;
    let cancelled = false;
    setCbLoading(true);
    payApi
      .orderCallbacks(resolvedNo, { page: cbPage, pageSize: cbPageSize })
      .then((res) => {
        if (cancelled) return;
        setCbItems(res.items ?? []);
        setCbTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载回调流水失败");
      })
      .finally(() => {
        if (!cancelled) setCbLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedNo, notFound, cbPage, cbPageSize, reloadToken, message]);

  const statusTag = (status: string) => {
    const meta = ORDER_STATUS_META[status];
    return <Tag color={meta?.color ?? "default"}>{meta?.label ?? status}</Tag>;
  };

  const callbackColumns: ColumnsType<PayCallbackItem> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "渠道",
      dataIndex: "channel",
      width: 100,
      render: (v: string) => CHANNEL_LABEL[v] ?? v,
    },
    { title: "验签结果", dataIndex: "signatureResult", width: 120 },
    { title: "处理结果", dataIndex: "handleResult", width: 140 },
    {
      title: "信息",
      dataIndex: "message",
      width: 220,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    {
      title: "脱敏报文",
      dataIndex: "payloadMasked",
      width: 280,
      render: (v: string | null) =>
        v ? (
          <Tooltip
            title={<pre style={{ margin: 0, whiteSpace: "pre-wrap", maxWidth: 520 }}>{v}</pre>}
          >
            <span
              style={{
                display: "inline-block",
                maxWidth: 240,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                verticalAlign: "bottom",
              }}
            >
              {v}
            </span>
          </Tooltip>
        ) : (
          "-"
        ),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/pay/orders")}>
          返回订单列表
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)}>
          刷新
        </Button>
        <Typography.Text type="secondary">
          {tradeNo ? "按渠道交易号兜底查询：" + tradeNo : "订单号：" + orderNo}
        </Typography.Text>
      </Space>

      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin />
        </div>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="加载订单详情失败"
          description={error}
          action={
            <Button size="small" onClick={() => setReloadToken((t) => t + 1)}>
              重试
            </Button>
          }
        />
      ) : notFound ? (
        <Alert
          type="warning"
          showIcon
          message="订单不存在"
          description={
            tradeNo
              ? "订单号 " + orderNo + " 与渠道交易号 " + tradeNo + " 均未匹配到订单。"
              : "订单号 " + orderNo + " 未匹配到订单。"
          }
          action={
            <Button size="small" onClick={() => navigate("/pay/orders")}>
              返回订单列表
            </Button>
          }
        />
      ) : order ? (
        <>
          <Descriptions column={2} size="small" bordered style={{ marginBottom: 24 }}>
            <Descriptions.Item label="订单号">{order.orderNo}</Descriptions.Item>
            <Descriptions.Item label="UID">
              <Link to={"/pay/memberships?uid=" + encodeURIComponent(order.uid)}>
                {order.uid}
              </Link>
            </Descriptions.Item>
            <Descriptions.Item label="商品">{order.productTitle}</Descriptions.Item>
            <Descriptions.Item label="SKU">{order.skuCode}</Descriptions.Item>
            <Descriptions.Item label="天数">{order.durationDays + " 天"}</Descriptions.Item>
            <Descriptions.Item label="金额">{formatCents(order.amountCents)}</Descriptions.Item>
            <Descriptions.Item label="渠道">
              {CHANNEL_LABEL[order.channel] ?? order.channel}
            </Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(order.status)}</Descriptions.Item>
            <Descriptions.Item label="版本">{order.version}</Descriptions.Item>
            <Descriptions.Item label="渠道交易号">{order.channelTradeNo || "-"}</Descriptions.Item>
            <Descriptions.Item label="幂等键">{order.idempotencyKey || "-"}</Descriptions.Item>
            <Descriptions.Item label="失败原因">{order.failReason || "-"}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{formatTime(order.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="过期时间">{formatTime(order.expiresAt)}</Descriptions.Item>
            <Descriptions.Item label="支付时间">{formatTime(order.paidAt)}</Descriptions.Item>
            <Descriptions.Item label="关闭时间">{formatTime(order.closedAt)}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{formatTime(order.updatedAt)}</Descriptions.Item>
          </Descriptions>

          <div style={{ fontWeight: 600, marginBottom: 8 }}>渠道回调流水</div>
          <Table<PayCallbackItem>
            rowKey={(r) => r.orderNo + "-" + r.createdAt + "-" + r.handleResult}
            size="small"
            columns={callbackColumns}
            dataSource={cbItems}
            loading={cbLoading}
            scroll={{ x: 1000 }}
            locale={{ emptyText: "暂无回调流水" }}
            pagination={{
              current: cbPage,
              pageSize: cbPageSize,
              total: cbTotal,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (t) => "共 " + t + " 条",
              onChange: (p, ps) => {
                setCbPage(p);
                setCbPageSize(ps);
              },
            }}
          />
        </>
      ) : null}
    </div>
  );
}
