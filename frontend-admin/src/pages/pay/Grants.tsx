import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../../api/client";
import type { GrantResult, PayMembershipEventItem } from "../../api/pay";
import { grantMembership, listEvents } from "../../api/pay";
import { useAuth } from "../../auth";
import { formatTime } from "../../components/format";

/** reason 列宽 VARCHAR(200)，"[操作人] reason" 总长按 rune 计 */
const REASON_MAX_RUNES = 200;

const TIER_LABEL: Record<string, string> = { VIP: "VIP", SVIP: "SVIP" };

interface GrantFormValues {
  uid: string;
  durationDays: number;
  tier?: "VIP" | "SVIP";
  reason: string;
}

export default function Grants() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<GrantFormValues>();

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GrantResult | null>(null);
  /** 503 = 支付模块未配置（任一 pay 请求都可能先撞到该 gate） */
  const [payDisabled, setPayDisabled] = useState(false);
  const [events, setEvents] = useState<PayMembershipEventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const loadEvents = useCallback(async () => {
    // viewer 不请求任何接口；支付模块未配置时不再重试
    if (!isAdmin || payDisabled) return;
    setEventsLoading(true);
    try {
      const res = await listEvents({ type: "ADMIN_GRANT", page, pageSize });
      setEvents(res.items ?? []);
      setTotal(res.total ?? res.items?.length ?? 0);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setPayDisabled(true);
        return;
      }
      message.error(err instanceof Error ? err.message : "加载最近补偿开通记录失败");
    } finally {
      setEventsLoading(false);
    }
  }, [isAdmin, payDisabled, page, pageSize, message]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents, reloadToken]);

  /** 与后端校验对齐：uid>0 整数、天数 1..3650、原因 trim 非空且含操作人前缀 ≤200 rune */
  const uidRule = {
    validator: (_: unknown, value: string | undefined) => {
      const v = (value ?? "").trim();
      if (!v) return Promise.reject(new Error("UID 必填"));
      if (!/^\d+$/.test(v)) return Promise.reject(new Error("UID 必须为正整数"));
      if (BigInt(v) <= 0n) return Promise.reject(new Error("UID 必须大于 0"));
      return Promise.resolve();
    },
  };

  const reasonRule = {
    validator: (_: unknown, value: string | undefined) => {
      const reason = (value ?? "").trim();
      if (!reason) return Promise.reject(new Error("原因必填（将写入权益事件与审计）"));
      const totalLen = Array.from(`[${me?.username ?? ""}] ${reason}`).length;
      if (totalLen > REASON_MAX_RUNES) {
        return Promise.reject(
          new Error(`含操作人前缀后总长不得超过 ${REASON_MAX_RUNES} 字（当前 ${totalLen}）`),
        );
      }
      return Promise.resolve();
    },
  };

  const onFinish = async (values: GrantFormValues) => {
    setSubmitting(true);
    try {
      const res = await grantMembership({
        uid: values.uid.trim(),
        durationDays: values.durationDays,
        reason: values.reason.trim(),
        ...(values.tier ? { tier: values.tier } : {}),
      });
      setResult(res);
      message.success(res.created ? "补偿开通成功（新建会员）" : "补偿开通成功（顺延会员）");
      form.setFieldsValue({ durationDays: 30, reason: "" });
      await loadEvents();
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setPayDisabled(true);
        return;
      }
      // 400 参数 / 429 日额度熔断 / 500：统一透传后端 detail
      message.error(err instanceof Error ? err.message : "补偿开通失败");
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<PayMembershipEventItem> = [
    { title: "时间", dataIndex: "createdAt", width: 170, render: (v: string) => formatTime(v) },
    { title: "UID", dataIndex: "uid", width: 190, ellipsis: true },
    {
      title: "类型",
      dataIndex: "type",
      width: 140,
      render: (v: string) => <Tag color="geekblue">{v}</Tag>,
    },
    { title: "天数", dataIndex: "days", width: 80, align: "right" },
    { title: "到期前", dataIndex: "expireBefore", width: 165, render: (v: string) => formatTime(v) },
    { title: "到期后", dataIndex: "expireAfter", width: 165, render: (v: string) => formatTime(v) },
    {
      title: "原因（含操作人）",
      dataIndex: "reason",
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
  ];

  // viewer：直接 403，且不触发任何请求（effect 内已有 isAdmin 守卫）
  if (!isAdmin) {
    return (
      <Alert
        type="error"
        showIcon
        message="403 无权限访问"
        description="补偿开通属于资金写操作，仅管理员（admin）可访问；当前账户为只读角色（viewer）。"
      />
    );
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="运营补偿开通"
        description="直写 app_pay 会员表并同事务写入 ADMIN_GRANT 权益事件，同时记入审计日志。未到期从原到期日顺延，已过期从当前时间起算；同一天的数量/天数受日额度熔断保护。"
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

      <Card size="small" title="补偿开通" style={{ marginBottom: 16 }}>
        <Form<GrantFormValues>
          form={form}
          layout="inline"
          initialValues={{ durationDays: 30 }}
          onFinish={onFinish}
          style={{ rowGap: 12 }}
        >
          <Form.Item name="uid" label="UID" rules={[uidRule]}>
            <Input allowClear placeholder="用户 UID（正整数）" style={{ width: 220 }} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="durationDays"
            label="开通天数"
            rules={[{ required: true, message: "开通天数必填" }]}
          >
            <InputNumber min={1} max={3650} precision={0} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="tier" label="档位">
            <Select
              allowClear
              placeholder="默认（VIP）"
              style={{ width: 150 }}
              options={[
                { value: "VIP", label: "VIP" },
                { value: "SVIP", label: "SVIP" },
              ]}
            />
          </Form.Item>
          <Form.Item name="reason" label="原因" rules={[reasonRule]} style={{ flex: 1, minWidth: 320 }}>
            <Input allowClear placeholder="运营原因（必填，将记入权益事件与审计）" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} disabled={payDisabled}>
              确认开通
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {result ? (
        <Card size="small" title="本次开通结果" style={{ marginBottom: 16 }}>
          <Descriptions
            size="small"
            column={2}
            bordered
            items={[
              { key: "uid", label: "UID", children: result.uid },
              { key: "tier", label: "档位", children: TIER_LABEL[result.tier] ?? result.tier },
              { key: "days", label: "本次天数", children: `${result.days} 天` },
              { key: "created", label: "处理方式", children: result.created ? "新建会员记录" : "顺延原会员" },
              { key: "before", label: "开通前到期时间", children: formatTime(result.expireBefore) },
              { key: "after", label: "开通后到期时间", children: formatTime(result.expireAfter) },
            ]}
          />
        </Card>
      ) : null}

      <Card
        size="small"
        title="最近 ADMIN_GRANT 记录"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => setReloadToken((t) => t + 1)}
              disabled={payDisabled}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Table<PayMembershipEventItem>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={events}
          loading={eventsLoading}
          scroll={{ x: 1000 }}
          locale={{ emptyText: payDisabled ? "支付管理未配置" : "暂无补偿开通记录" }}
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
      </Card>
    </div>
  );
}
