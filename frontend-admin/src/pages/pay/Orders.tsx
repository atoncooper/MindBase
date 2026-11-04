import { useEffect, useState } from "react";
import {
  App as AntApp,
  Button,
  DatePicker,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { Link } from "react-router-dom";
import { payApi } from "../../api/pay";
import type { PayOrderItem, PayOrderQuery } from "../../api/pay";
import { formatCents, formatTime } from "../../components/format";
import {
  CHANNEL_LABEL,
  CHANNEL_OPTIONS,
  ORDER_STATUS_META,
  ORDER_STATUS_OPTIONS,
} from "../../components/pay-meta";

const { RangePicker } = DatePicker;

/** 订单列表：订单号/UID/交易号/状态/渠道/创建时间范围筛选 + 分页。 */
export default function PayOrders() {
  const { message } = AntApp.useApp();
  const [fOrderNo, setFOrderNo] = useState("");
  const [fUid, setFUid] = useState("");
  const [fTradeNo, setFTradeNo] = useState("");
  const [fStatus, setFStatus] = useState<string | undefined>(undefined);
  const [fChannel, setFChannel] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<[string, string] | null>(null);

  const [applied, setApplied] = useState<PayOrderQuery>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<PayOrderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const query = () => {
    const uid = fUid.trim();
    if (uid && !/^\d+$/.test(uid)) {
      message.warning("UID 必须是正整数");
      return;
    }
    setApplied({
      orderNo: fOrderNo.trim() || undefined,
      uid: uid || undefined,
      tradeNo: fTradeNo.trim() || undefined,
      status: fStatus || undefined,
      channel: fChannel || undefined,
      createdFrom: range?.[0],
      createdTo: range?.[1],
    });
    setPage(1);
  };

  const reset = () => {
    setFOrderNo("");
    setFUid("");
    setFTradeNo("");
    setFStatus(undefined);
    setFChannel(undefined);
    setRange(null);
    setApplied({});
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    payApi
      .orders({ ...applied, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载订单列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, reloadToken, message]);

  const columns: ColumnsType<PayOrderItem> = [
    {
      title: "订单号",
      dataIndex: "orderNo",
      width: 210,
      fixed: "left",
      render: (v: string) => <Link to={"/pay/orders/" + encodeURIComponent(v)}>{v}</Link>,
    },
    {
      title: "UID",
      dataIndex: "uid",
      width: 150,
      render: (v: string) => (
        <Tooltip title="查看该用户会员态">
          <Link to={"/pay/memberships?uid=" + encodeURIComponent(v)}>{v}</Link>
        </Tooltip>
      ),
    },
    {
      title: "商品",
      key: "product",
      width: 200,
      render: (_, r) => (
        <div>
          <div>{r.productTitle}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.skuCode}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "天数",
      dataIndex: "durationDays",
      width: 80,
      align: "right",
      render: (v: number) => v + " 天",
    },
    {
      title: "金额",
      dataIndex: "amountCents",
      width: 110,
      align: "right",
      render: (v: number) => formatCents(v),
    },
    {
      title: "渠道",
      dataIndex: "channel",
      width: 100,
      render: (v: string) => CHANNEL_LABEL[v] ?? v,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (v: string) => {
        const meta = ORDER_STATUS_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "支付时间",
      dataIndex: "paidAt",
      width: 170,
      render: (v: string | null) => formatTime(v),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="订单号（精确）"
          value={fOrderNo}
          onChange={(e) => setFOrderNo(e.target.value)}
          onPressEnter={query}
          style={{ width: 210 }}
        />
        <Input
          allowClear
          placeholder="UID（正整数）"
          value={fUid}
          onChange={(e) => setFUid(e.target.value)}
          onPressEnter={query}
          style={{ width: 160 }}
        />
        <Input
          allowClear
          placeholder="渠道交易号（精确）"
          value={fTradeNo}
          onChange={(e) => setFTradeNo(e.target.value)}
          onPressEnter={query}
          style={{ width: 210 }}
        />
        <Select
          allowClear
          placeholder="状态"
          value={fStatus}
          onChange={setFStatus}
          style={{ width: 130 }}
          options={ORDER_STATUS_OPTIONS}
        />
        <Select
          allowClear
          placeholder="渠道"
          value={fChannel}
          onChange={setFChannel}
          style={{ width: 120 }}
          options={CHANNEL_OPTIONS}
        />
        <RangePicker
          value={range ? [dayjs(range[0]), dayjs(range[1])] : null}
          onChange={(dates, dateStrings) => {
            setRange(dates && dates[0] && dates[1] ? [dateStrings[0], dateStrings[1]] : null);
          }}
        />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      <Table<PayOrderItem>
        rowKey="orderNo"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1400 }}
        locale={{ emptyText: "暂无订单" }}
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
