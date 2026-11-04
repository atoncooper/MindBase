import { useCallback, useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Input, Modal, Select, Space, Table, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../../api/client";
import type { RefundApprovalStatus, RefundItem } from "../../api/pay";
import { approveRefund, listRefunds, rejectRefund } from "../../api/pay";
import { useAuth } from "../../auth";
import { formatTime } from "../../components/format";

const STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING: { label: "待复核", color: "orange" },
  APPROVED: { label: "已通过", color: "green" },
  REJECTED: { label: "已驳回", color: "red" },
};

const STATUS_OPTIONS = [
  { value: "PENDING", label: "待复核" },
  { value: "APPROVED", label: "已通过" },
  { value: "REJECTED", label: "已驳回" },
  { value: "ALL", label: "全部状态" },
];

/** approve 的 reason 可选，缺省记为「复核通过」 */
const DEFAULT_APPROVE_REASON = "复核通过";

export default function Refunds() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { message, modal } = AntApp.useApp();

  // 默认待复核；「全部状态」显式发送 ALL（后端缺省值是 PENDING，空串会被当成缺省）
  const [status, setStatus] = useState<RefundApprovalStatus>("PENDING");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<RefundItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 404 = 退款复核未配置（整组隐身） */
  const [notConfigured, setNotConfigured] = useState(false);
  /** 503 = 支付模块未配置（pay_rdbms.url 缺失 / PayDB 不可用） */
  const [payDisabled, setPayDisabled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [approveTarget, setApproveTarget] = useState<RefundItem | null>(null);
  const [approveReason, setApproveReason] = useState("");
  const [approving, setApproving] = useState(false);
  const [rejectingOrderNo, setRejectingOrderNo] = useState<string | null>(null);

  const load = useCallback(async () => {
    // viewer 不请求任何接口；未配置 / 支付不可用时不重试
    if (!isAdmin || notConfigured || payDisabled) return;
    setLoading(true);
    try {
      const res = await listRefunds({ status, page, pageSize });
      setItems(res.items ?? []);
      setTotal(res.total ?? res.items?.length ?? 0);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotConfigured(true);
        return;
      }
      if (err instanceof ApiError && err.status === 503) {
        setPayDisabled(true);
        return;
      }
      message.error(err instanceof Error ? err.message : "加载退款复核列表失败");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, notConfigured, payDisabled, status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const submitApprove = async () => {
    if (!approveTarget) return;
    const reason = approveReason.trim() || DEFAULT_APPROVE_REASON;
    setApproving(true);
    try {
      await approveRefund(approveTarget.orderNo, reason);
      message.success(`订单 ${approveTarget.orderNo} 已确认退款`);
      setApproveTarget(null);
      setApproveReason("");
      setReloadToken((t) => t + 1);
    } catch (err) {
      // 上游失败 → 502，detail 直接展示
      if (err instanceof ApiError && err.status === 404) {
        setApproveTarget(null);
        setNotConfigured(true);
        return;
      }
      message.error(err instanceof Error ? err.message : "确认退款失败");
    } finally {
      setApproving(false);
    }
  };

  /** 驳回不带 reason（app-pay 端点只接受 operator），仅确认弹窗，body 发 {} */
  const confirmReject = (item: RefundItem) => {
    modal.confirm({
      title: "确认驳回该退款复核？",
      content: `订单 ${item.orderNo}：驳回后该笔退款不再执行，操作会记入审计日志。`,
      okText: "确认驳回",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setRejectingOrderNo(item.orderNo);
        try {
          await rejectRefund(item.orderNo);
          message.success(`订单 ${item.orderNo} 已驳回`);
          setReloadToken((t) => t + 1);
        } catch (err) {
          message.error(err instanceof Error ? err.message : "驳回退款复核失败");
          // 抛出让 antd 保持弹窗打开，便于重试
          throw err;
        } finally {
          setRejectingOrderNo(null);
        }
      },
    });
  };

  const columns: ColumnsType<RefundItem> = [
    { title: "订单号", dataIndex: "orderNo", width: 220, ellipsis: true },
    { title: "申请人", dataIndex: "maker", width: 120, ellipsis: true },
    { title: "申请原因", dataIndex: "makerReason", ellipsis: true, render: (v: string) => v || "-" },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string) => {
        const meta = STATUS_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    { title: "申请时间", dataIndex: "createdAt", width: 170, render: (v: string) => formatTime(v) },
    { title: "复核人", dataIndex: "checker", width: 120, render: (v: string | null) => v || "-" },
    { title: "复核时间", dataIndex: "decidedAt", width: 170, render: (v: string | null) => formatTime(v) },
    { title: "复核原因", dataIndex: "checkReason", ellipsis: true, render: (v: string | null) => v || "-" },
    {
      title: "操作",
      key: "action",
      width: 160,
      fixed: "right",
      render: (_, row: RefundItem) =>
        row.status === "PENDING" ? (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              loading={approving && approveTarget?.orderNo === row.orderNo}
              onClick={() => {
                setApproveTarget(row);
                setApproveReason("");
              }}
            >
              通过
            </Button>
            <Button
              size="small"
              danger
              loading={rejectingOrderNo === row.orderNo}
              onClick={() => confirmReject(row)}
            >
              驳回
            </Button>
          </Space>
        ) : (
          "-"
        ),
    },
  ];

  // viewer：直接 403，且不触发任何请求（effect 内已有 isAdmin 守卫）
  if (!isAdmin) {
    return (
      <Alert
        type="error"
        showIcon
        message="403 无权限访问"
        description="退款复核属于资金操作，仅管理员（admin）可访问；当前账户为只读角色（viewer）。"
      />
    );
  }

  if (notConfigured) {
    return (
      <Alert
        type="warning"
        showIcon
        message="退款复核未配置"
        description="后端未启用退款复核（需配置 pay.ops.refund_review_enabled=true 且 pay.ops.base_url / pay.ops.key 齐全），该功能当前不可用。"
      />
    );
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="退款复核"
        description="展示待复核的退款申请；「通过」经 app-pay 内部端点执行渠道退款并回收会员，「驳回」仅终止本次复核。两者都会记入审计日志。"
      />

      {payDisabled ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="支付管理未配置"
          description="后端未配置 pay_rdbms.url 或支付库不可用，支付相关接口暂时不可用。"
        />
      ) : null}

      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          value={status}
          onChange={(v) => {
            setStatus(v as RefundApprovalStatus);
            setPage(1);
          }}
          options={STATUS_OPTIONS}
          style={{ width: 160 }}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => setReloadToken((t) => t + 1)}
          disabled={payDisabled}
        >
          刷新
        </Button>
      </Space>

      <Table<RefundItem>
        rowKey="orderNo"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1400 }}
        locale={{ emptyText: payDisabled ? "支付管理未配置" : "暂无需复核的退款申请" }}
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

      <Modal
        title={approveTarget ? `确认退款 · ${approveTarget.orderNo}` : "确认退款"}
        open={approveTarget !== null}
        okText="确认退款"
        cancelText="取消"
        confirmLoading={approving}
        onOk={() => void submitApprove()}
        onCancel={() => {
          setApproveTarget(null);
          setApproveReason("");
        }}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="确认后将调用 app-pay 执行渠道退款并回收会员权益，操作记入审计日志。"
        />
        <Input.TextArea
          rows={3}
          maxLength={200}
          showCount
          value={approveReason}
          onChange={(e) => setApproveReason(e.target.value)}
          placeholder={`复核通过原因（选填，默认「${DEFAULT_APPROVE_REASON}」）`}
        />
      </Modal>
    </div>
  );
}
