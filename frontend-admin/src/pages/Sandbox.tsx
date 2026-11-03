import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EyeOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { ApiError } from "../api/client";
import {
  sandboxApi,
  type SandboxAuditItem,
  type SandboxConfigView,
  type SandboxExecutionDetail,
  type SandboxExecutionItem,
  type SandboxLeaseItem,
  type SandboxOverview,
  type SandboxQuotaView,
  type SandboxUid,
} from "../api/sandbox";
import { useAuth } from "../auth";
import { formatSize, formatTime } from "../components/format";

const { RangePicker } = DatePicker;

type RangeValue = [Dayjs | null, Dayjs | null] | null;

const PRE_STYLE: CSSProperties = {
  maxHeight: 300,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#f5f5f7",
  padding: 12,
  borderRadius: 8,
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
};

/** 错误文案：client 已把 {detail} 转成 ApiError.message，其余异常兜底。 */
function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

function uidText(uid: SandboxUid): string {
  return String(uid);
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

/** 执行状态（控制层常量：timeout 而非 timed_out；概览计数键另为 timed_out）。 */
const EXEC_STATUS: Record<string, { label: string; color: string }> = {
  queued: { label: "排队中", color: "gold" },
  running: { label: "运行中", color: "processing" },
  succeeded: { label: "成功", color: "green" },
  failed: { label: "失败", color: "red" },
  timeout: { label: "超时", color: "orange" },
  timed_out: { label: "超时", color: "orange" },
  canceled: { label: "已取消", color: "default" },
};

const EXEC_STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "运行中" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "timeout", label: "超时" },
  { value: "canceled", label: "已取消" },
];

const LEASE_STATE: Record<string, { label: string; color: string }> = {
  creating: { label: "创建中", color: "processing" },
  ready: { label: "就绪", color: "green" },
  busy: { label: "忙碌", color: "geekblue" },
  idle: { label: "空闲", color: "cyan" },
  releasing: { label: "回收中", color: "orange" },
  terminated: { label: "已终止", color: "default" },
  failed: { label: "失败", color: "red" },
};

const LEASE_STATE_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "creating", label: "创建中" },
  { value: "ready", label: "就绪" },
  { value: "busy", label: "忙碌" },
  { value: "idle", label: "空闲" },
  { value: "releasing", label: "回收中" },
  { value: "terminated", label: "已终止" },
  { value: "failed", label: "失败" },
];

/** 沙箱审计动作 → 中文标签（未知 action 原样展示，不隐藏历史）。 */
const AUDIT_ACTION: Record<string, string> = {
  "execution.create": "创建执行",
  "execution.start": "开始执行",
  "execution.finish": "结束执行",
  "execution.cancel": "取消执行",
  "execution.deny": "拒绝执行",
  "lease.create": "创建租约",
  "lease.reuse": "复用租约",
  "lease.release": "回收租约",
  "artifact.upload": "产物上传",
  "artifact.deny": "产物拒绝",
};

const AUDIT_ACTION_OPTIONS = [
  { value: "", label: "全部动作" },
  ...Object.entries(AUDIT_ACTION).map(([value, label]) => ({ value, label })),
];

const OUTCOME: Record<string, { label: string; color: string }> = {
  success: { label: "成功", color: "green" },
  ok: { label: "成功", color: "green" },
  failed: { label: "失败", color: "red" },
  failure: { label: "失败", color: "red" },
  error: { label: "失败", color: "red" },
  deny: { label: "拒绝", color: "orange" },
  denied: { label: "拒绝", color: "orange" },
  timeout: { label: "超时", color: "orange" },
  canceled: { label: "已取消", color: "default" },
};

const TIER_LABEL: Record<string, string> = { free: "免费", vip: "VIP", svip: "SVIP" };

/** 审计动作发起者（控制层 actor 字段）→ 中文标签。 */
const ACTOR_LABEL: Record<string, string> = {
  agent: "智能体",
  user: "用户",
  system: "系统",
  admin: "管理员",
};

function renderUid(uid: SandboxUid): ReactNode {
  return <span style={{ fontFamily: "monospace" }}>{uidText(uid)}</span>;
}

function renderShortId(id: string): ReactNode {
  return (
    <Tooltip title={id}>
      <span style={{ fontFamily: "monospace" }}>{shortId(id)}</span>
    </Tooltip>
  );
}

function renderStatusTag(status: string): ReactNode {
  const meta = EXEC_STATUS[status];
  return <Tag color={meta?.color ?? "default"}>{meta?.label ?? status}</Tag>;
}

function renderLeaseState(state: string): ReactNode {
  const meta = LEASE_STATE[state];
  return <Tag color={meta?.color ?? "default"}>{meta?.label ?? state}</Tag>;
}

function renderOutcome(outcome: string | undefined): ReactNode {
  if (!outcome) return "-";
  const meta = OUTCOME[outcome.toLowerCase()];
  return <Tag color={meta?.color ?? "default"}>{meta?.label ?? outcome}</Tag>;
}

/** viewer 下把写操作包成禁用态 + 提示；admin 原样渲染。 */
function AdminGate({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  if (isAdmin) return <>{children}</>;
  return (
    <Tooltip title="需要 admin 角色">
      <span style={{ display: "inline-block" }}>{children}</span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

function OverviewTab() {
  const [overview, setOverview] = useState<SandboxOverview | null>(null);
  const [config, setConfig] = useState<SandboxConfigView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([sandboxApi.overview(), sandboxApi.config()])
      .then(([ov, cfg]) => {
        if (cancelled) return;
        setOverview(ov);
        setConfig(cfg);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err, "加载沙箱概览失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const leaseCounts = overview?.leases;
  const execCounts = overview?.executions;
  const failRate =
    overview && overview.last24h.executions > 0
      ? Math.round((overview.last24h.failures / overview.last24h.executions) * 1000) / 10
      : 0;

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadToken((t) => t + 1)}>
          刷新
        </Button>
        {overview && (
          <Typography.Text type="secondary">
            配额统计：{overview.quotaEnabled ? "已开启" : "已关闭"}
          </Typography.Text>
        )}
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
          action={<Button size="small" onClick={() => setReloadToken((t) => t + 1)}>重试</Button>}
        />
      )}

      <Spin spinning={loading}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card size="small" title="当前租约">
              <Statistic value={leaseCounts?.total ?? 0} suffix="个" />
              <Space wrap size={4} style={{ marginTop: 12 }}>
                <Tag color="processing">创建中 {leaseCounts?.creating ?? 0}</Tag>
                <Tag color="green">就绪 {leaseCounts?.ready ?? 0}</Tag>
                <Tag color="geekblue">忙碌 {leaseCounts?.busy ?? 0}</Tag>
                <Tag color="cyan">空闲 {leaseCounts?.idle ?? 0}</Tag>
                <Tag color="orange">回收中 {leaseCounts?.releasing ?? 0}</Tag>
                <Tag>已终止 {leaseCounts?.terminated ?? 0}</Tag>
                <Tag color="red">失败 {leaseCounts?.failed ?? 0}</Tag>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small" title="执行计数">
              <Statistic value={execCounts?.total ?? 0} suffix="次" />
              <Space wrap size={4} style={{ marginTop: 12 }}>
                <Tag color="gold">排队 {execCounts?.queued ?? 0}</Tag>
                <Tag color="processing">运行 {execCounts?.running ?? 0}</Tag>
                <Tag color="green">成功 {execCounts?.succeeded ?? 0}</Tag>
                <Tag color="red">失败 {execCounts?.failed ?? 0}</Tag>
                <Tag color="orange">超时 {execCounts?.timed_out ?? 0}</Tag>
                <Tag>取消 {execCounts?.canceled ?? 0}</Tag>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small" title="最近 24 小时">
              <Row gutter={8}>
                <Col span={12}>
                  <Statistic title="执行" value={overview?.last24h.executions ?? 0} suffix="次" />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="失败"
                    value={overview?.last24h.failures ?? 0}
                    suffix="次"
                    valueStyle={{ color: (overview?.last24h.failures ?? 0) > 0 ? "#cf1322" : undefined }}
                  />
                </Col>
              </Row>
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary">失败率 {failRate}%</Typography.Text>
              </div>
            </Card>
          </Col>
        </Row>

        <Card size="small" title="运行时配置（只读）" style={{ marginTop: 16 }}>
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="运行时">{config?.runtime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="镜像">{config?.image ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="CPU">
              {config?.resources?.cpu ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="内存">
              {config?.resources?.memory ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="租约 TTL">
              {config?.leaseTtlSeconds !== undefined ? config.leaseTtlSeconds + " 秒" : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="准入并发">
              {config?.admission?.maxConcurrent ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="单用户并发">
              {config?.admission?.maxPerUid ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="排队上限">
              {config?.admission?.queueSize ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="排队超时">
              {config?.admission?.queueTimeoutMs !== undefined
                ? config.admission.queueTimeoutMs + " ms"
                : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="配额">
              {overview ? (overview.quotaEnabled ? <Tag color="green">已开启</Tag> : <Tag>已关闭</Tag>) : "-"}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </Spin>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 执行记录
// ---------------------------------------------------------------------------

interface ExecFilters {
  uid?: string;
  projectId?: string;
  status?: string;
  from?: string;
  to?: string;
}

function ExecutionsTab({ isAdmin }: { isAdmin: boolean }) {
  const { message } = AntApp.useApp();
  const [fUid, setFUid] = useState("");
  const [fProject, setFProject] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [range, setRange] = useState<RangeValue>(null);
  const [applied, setApplied] = useState<ExecFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<SandboxExecutionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SandboxExecutionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);

  const query = () => {
    setApplied({
      uid: fUid.trim() || undefined,
      projectId: fProject.trim() || undefined,
      status: fStatus || undefined,
      from: range?.[0] ? range[0].toISOString() : undefined,
      to: range?.[1] ? range[1].toISOString() : undefined,
    });
    setPage(1);
  };

  const reset = () => {
    setFUid("");
    setFProject("");
    setFStatus("");
    setRange(null);
    setApplied({});
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sandboxApi
      .executions({ ...applied, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err, "加载执行记录失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, reloadToken]);

  const openDetail = useCallback(
    async (id: string) => {
      setDetailId(id);
      setDetail(null);
      setDetailLoading(true);
      try {
        setDetail(await sandboxApi.execution(id));
      } catch (err) {
        message.error(errText(err, "加载执行详情失败"));
        // 拉取失败时关闭抽屉，避免长期停在加载态
        setDetailId(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  const cancelExec = async (row: SandboxExecutionItem) => {
    setCancelBusyId(row.id);
    try {
      await sandboxApi.cancelExecution(row.id);
      message.success("已请求取消执行");
      setReloadToken((t) => t + 1);
      if (detailId === row.id) void openDetail(row.id);
    } catch (err) {
      message.error(errText(err, "取消执行失败"));
    } finally {
      setCancelBusyId(null);
    }
  };

  const columns: ColumnsType<SandboxExecutionItem> = [
    { title: "执行 ID", dataIndex: "id", width: 130, render: (id: string) => renderShortId(id) },
    { title: "uid", dataIndex: "uid", width: 170, render: (uid: SandboxUid) => renderUid(uid) },
    { title: "项目", dataIndex: "projectId", width: 150, ellipsis: true, render: (v: string) => v || "-" },
    { title: "语言", dataIndex: "language", width: 100 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => renderStatusTag(v) },
    {
      title: "exitCode",
      dataIndex: "exitCode",
      width: 90,
      align: "right",
      render: (v: number | null | undefined) => (v === null || v === undefined ? "-" : v),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      width: 100,
      align: "right",
      render: (v: number | null | undefined) => formatDuration(v),
    },
    {
      title: "产物",
      key: "artifacts",
      width: 130,
      render: (_: unknown, row) =>
        row.artifactCount !== undefined
          ? row.artifactCount + " 个 / " + formatSize(row.artifactBytes ?? 0)
          : "-",
    },
    { title: "创建时间", dataIndex: "createdAt", width: 170, render: (v: string) => formatTime(v) },
    {
      title: "操作",
      key: "action",
      width: 170,
      fixed: "right",
      render: (_: unknown, row) => {
        const active = row.status === "queued" || row.status === "running";
        return (
          <Space size={4}>
            <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => void openDetail(row.id)}>
              详情
            </Button>
            {active && (
              <AdminGate isAdmin={isAdmin}>
                <Popconfirm
                  title="取消该执行？"
                  description="将请求沙箱控制层取消（幂等，已结束的执行不受影响）。"
                  okText="确认取消"
                  cancelText="返回"
                  okButtonProps={{ danger: true }}
                  disabled={!isAdmin}
                  onConfirm={() => cancelExec(row)}
                >
                  <Button
                    size="small"
                    type="link"
                    danger
                    icon={<StopOutlined />}
                    disabled={!isAdmin}
                    loading={cancelBusyId === row.id}
                  >
                    取消执行
                  </Button>
                </Popconfirm>
              </AdminGate>
            )}
          </Space>
        );
      },
    },
  ];

  const detailEvents = detail?.audit ?? detail?.events ?? [];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="uid"
          value={fUid}
          onChange={(e) => setFUid(e.target.value.replace(/[^0-9]/g, ""))}
          onPressEnter={query}
          style={{ width: 150 }}
        />
        <Input
          allowClear
          placeholder="项目 ID"
          value={fProject}
          onChange={(e) => setFProject(e.target.value)}
          onPressEnter={query}
          style={{ width: 180 }}
        />
        <Select value={fStatus} onChange={setFStatus} style={{ width: 140 }} options={EXEC_STATUS_OPTIONS} />
        <RangePicker
          showTime
          value={range}
          onChange={(value) => setRange(value as RangeValue)}
          style={{ width: 360 }}
        />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
          action={<Button size="small" onClick={() => setReloadToken((t) => t + 1)}>重试</Button>}
        />
      )}

      <Table<SandboxExecutionItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1350 }}
        locale={{ emptyText: "暂无执行记录" }}
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

      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        width={920}
        destroyOnClose
        title={detailId ? "执行详情 " + shortId(detailId) : "执行详情"}
      >
        {detailLoading || !detail ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <Spin />
          </div>
        ) : (
          <>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="执行 ID" span={2}>
                <Typography.Text copyable style={{ fontFamily: "monospace" }}>
                  {detail.id}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="uid">{uidText(detail.uid)}</Descriptions.Item>
              <Descriptions.Item label="项目">{detail.projectId || "-"}</Descriptions.Item>
              <Descriptions.Item label="语言">{detail.language || "-"}</Descriptions.Item>
              <Descriptions.Item label="状态">{renderStatusTag(detail.status)}</Descriptions.Item>
              <Descriptions.Item label="exitCode">
                {detail.exitCode === null || detail.exitCode === undefined ? "-" : detail.exitCode}
              </Descriptions.Item>
              <Descriptions.Item label="耗时">{formatDuration(detail.durationMs)}</Descriptions.Item>
              <Descriptions.Item label="租约">{detail.leaseId || "-"}</Descriptions.Item>
              <Descriptions.Item label="错误码">{detail.errorCode || "-"}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{formatTime(detail.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{formatTime(detail.finishedAt)}</Descriptions.Item>
              <Descriptions.Item label="产物">
                {(detail.artifactCount ?? 0) + " 个 / " + formatSize(detail.artifactBytes ?? 0)}
              </Descriptions.Item>
            </Descriptions>

            <div style={{ fontWeight: 600, margin: "20px 0 8px" }}>stdout 预览</div>
            <pre style={PRE_STYLE}>{detail.stdoutPreview || "（空）"}</pre>
            <div style={{ fontWeight: 600, margin: "20px 0 8px" }}>stderr 预览</div>
            <pre style={PRE_STYLE}>{detail.stderrPreview || "（空）"}</pre>
            <Typography.Text type="secondary">
              仅展示截断预览，不含完整代码正文；产物字节存于对象存储，后台不提供下载。
            </Typography.Text>

            <div style={{ fontWeight: 600, margin: "20px 0 8px" }}>
              产物元数据（{(detail.artifacts ?? []).length}）
            </div>
            <Table
              size="small"
              rowKey={(r: { id?: string; name: string }) => r.id ?? r.name}
              dataSource={detail.artifacts ?? []}
              pagination={false}
              locale={{ emptyText: "无产物" }}
              columns={[
                { title: "名称", dataIndex: "name", ellipsis: true },
                {
                  title: "大小",
                  dataIndex: "sizeBytes",
                  width: 110,
                  align: "right" as const,
                  render: (v: number | undefined) => formatSize(v ?? 0),
                },
                {
                  title: "sha256",
                  dataIndex: "sha256",
                  width: 150,
                  render: (v: string | undefined) =>
                    v ? (
                      <Tooltip title={v}>
                        <span style={{ fontFamily: "monospace" }}>{v.slice(0, 12)}…</span>
                      </Tooltip>
                    ) : (
                      "-"
                    ),
                },
                { title: "类型", dataIndex: "contentType", width: 180, ellipsis: true, render: (v: string | undefined) => v || "-" },
                { title: "创建时间", dataIndex: "createdAt", width: 170, render: (v: string | undefined) => formatTime(v) },
              ]}
            />

            <div style={{ fontWeight: 600, margin: "20px 0 8px" }}>审计时间线（{detailEvents.length}）</div>
            {detailEvents.length === 0 ? (
              <Typography.Text type="secondary">暂无审计事件</Typography.Text>
            ) : (
              <Timeline
                items={detailEvents.map((event) => ({
                  children: (
                    <div>
                      <Space size={8} wrap>
                        <Tag color="blue">{AUDIT_ACTION[event.action] ?? event.action}</Tag>
                        {event.actor ? <Tag>{ACTOR_LABEL[event.actor] ?? event.actor}</Tag> : null}
                        {renderOutcome(event.outcome)}
                        <Typography.Text type="secondary">{formatTime(event.createdAt)}</Typography.Text>
                        {event.durationMs !== null && event.durationMs !== undefined && (
                          <Typography.Text type="secondary">
                            耗时 {formatDuration(event.durationMs)}
                          </Typography.Text>
                        )}
                      </Space>
                      {event.detail ? (
                        <div style={{ marginTop: 4, color: "#595959", fontSize: 12 }}>{event.detail}</div>
                      ) : null}
                      {event.requestId ? (
                        <div style={{ marginTop: 2, color: "#8c8c8c", fontSize: 12 }}>
                          requestId: {event.requestId}
                        </div>
                      ) : null}
                    </div>
                  ),
                }))}
              />
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 租约
// ---------------------------------------------------------------------------

function LeasesTab({ isAdmin }: { isAdmin: boolean }) {
  const { message } = AntApp.useApp();
  const [fUid, setFUid] = useState("");
  const [fState, setFState] = useState("");
  const [applied, setApplied] = useState<{ uid?: string; state?: string }>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<SandboxLeaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [releaseBusyId, setReleaseBusyId] = useState<string | null>(null);

  const query = () => {
    setApplied({ uid: fUid.trim() || undefined, state: fState || undefined });
    setPage(1);
  };

  const reset = () => {
    setFUid("");
    setFState("");
    setApplied({});
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sandboxApi
      .leases({ ...applied, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err, "加载租约失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, reloadToken]);

  const release = async (row: SandboxLeaseItem) => {
    setReleaseBusyId(row.id);
    try {
      await sandboxApi.releaseLease(row.id);
      message.success("已请求强制回收租约");
      setReloadToken((t) => t + 1);
    } catch (err) {
      message.error(errText(err, "强制回收失败"));
    } finally {
      setReleaseBusyId(null);
    }
  };

  const columns: ColumnsType<SandboxLeaseItem> = [
    { title: "租约 ID", dataIndex: "id", width: 130, render: (id: string) => renderShortId(id) },
    { title: "uid", dataIndex: "uid", width: 170, render: (uid: SandboxUid) => renderUid(uid) },
    { title: "项目", dataIndex: "projectId", width: 150, ellipsis: true, render: (v: string) => v || "-" },
    { title: "用途", dataIndex: "purpose", width: 120, ellipsis: true, render: (v: string) => v || "-" },
    { title: "状态", dataIndex: "state", width: 100, render: (v: string) => renderLeaseState(v) },
    { title: "运行时", dataIndex: "runtime", width: 110 },
    { title: "运行时 ID", dataIndex: "runtimeId", width: 160, ellipsis: true, render: (v: string) => v || "-" },
    { title: "创建时间", dataIndex: "createdAt", width: 170, render: (v: string) => formatTime(v) },
    { title: "过期时间", dataIndex: "expiresAt", width: 170, render: (v: string) => formatTime(v) },
    { title: "最近使用", dataIndex: "lastUsedAt", width: 170, render: (v: string) => formatTime(v) },
    {
      title: "操作",
      key: "action",
      width: 150,
      fixed: "right",
      render: (_: unknown, row) => (
        <AdminGate isAdmin={isAdmin}>
          <Popconfirm
            title="强制回收该租约？"
            description="将取消在飞执行并删除运行时沙箱，幂等且不可撤销。"
            okText="确认回收"
            cancelText="返回"
            okButtonProps={{ danger: true }}
            disabled={!isAdmin}
            onConfirm={() => release(row)}
          >
            <Button
              size="small"
              type="link"
              danger
              icon={<DeleteOutlined />}
              disabled={!isAdmin}
              loading={releaseBusyId === row.id}
            >
              强制回收
            </Button>
          </Popconfirm>
        </AdminGate>
      ),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="uid"
          value={fUid}
          onChange={(e) => setFUid(e.target.value.replace(/[^0-9]/g, ""))}
          onPressEnter={query}
          style={{ width: 150 }}
        />
        <Select value={fState} onChange={setFState} style={{ width: 150 }} options={LEASE_STATE_OPTIONS} />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
          action={<Button size="small" onClick={() => setReloadToken((t) => t + 1)}>重试</Button>}
        />
      )}

      <Table<SandboxLeaseItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1500 }}
        locale={{ emptyText: "暂无租约" }}
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

// ---------------------------------------------------------------------------
// 配额
// ---------------------------------------------------------------------------

function QuotaCard({
  title,
  used,
  limit,
  formatValue,
}: {
  title: string;
  used: number | null;
  limit: number | undefined;
  formatValue?: (n: number) => string;
}) {
  const fmt = formatValue ?? ((n: number) => String(n));
  const unlimited = limit === undefined || limit < 0;
  const percent =
    used === null || unlimited || !limit ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <Card size="small" title={title} style={{ height: "100%" }}>
      <Progress percent={percent} status={percent >= 100 ? "exception" : "normal"} showInfo={false} />
      <div style={{ marginTop: 8 }}>
        <Typography.Text strong>{used === null ? "实时用量未提供" : fmt(used)}</Typography.Text>
        <Typography.Text type="secondary">
          {" / "}
          {unlimited ? "不限" : fmt(limit ?? 0)}
        </Typography.Text>
      </div>
      <Typography.Text type="secondary">
        {unlimited ? "该维度不限量" : "用量 " + percent + "%"}
      </Typography.Text>
    </Card>
  );
}

function QuotaTab() {
  const [uid, setUid] = useState("");
  const [day, setDay] = useState<Dayjs>(() => dayjs());
  const [applied, setApplied] = useState<{ uid: string; day: string } | null>(null);
  const [data, setData] = useState<SandboxQuotaView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const query = () => {
    const trimmed = uid.trim();
    if (!trimmed) return;
    setApplied({ uid: trimmed, day: day.format("YYYY-MM-DD") });
  };

  useEffect(() => {
    if (!applied) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    sandboxApi
      .quota({ uid: applied.uid, day: applied.day })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err, "加载配额失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, reloadToken]);

  const limits = data?.limits;
  const cpuSeconds = data ? Math.round((data.cpuMillis / 1000) * 100) / 100 : 0;

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="uid（必填）"
          value={uid}
          onChange={(e) => setUid(e.target.value.replace(/[^0-9]/g, ""))}
          onPressEnter={query}
          style={{ width: 200 }}
        />
        <DatePicker
          value={day}
          onChange={(value) => {
            if (value) setDay(value);
          }}
          allowClear={false}
        />
        <Button type="primary" onClick={query} disabled={!uid.trim()}>
          查询
        </Button>
        <Button icon={<ReloadOutlined />} disabled={!applied} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
          action={
            <Button size="small" onClick={() => setReloadToken((t) => t + 1)}>
              重试
            </Button>
          }
        />
      )}

      {!applied ? (
        <Empty description="输入 uid 并选择日期后查询当日配额用量" />
      ) : (
        <Spin spinning={loading}>
          <Descriptions size="small" bordered column={3} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="uid">{uidText(data?.uid ?? applied.uid)}</Descriptions.Item>
            <Descriptions.Item label="日期">{data?.day ?? applied.day}</Descriptions.Item>
            <Descriptions.Item label="会员档位">
              {data?.tier ? <Tag color="blue">{TIER_LABEL[data.tier] ?? data.tier}</Tag> : "-"}
            </Descriptions.Item>
          </Descriptions>

          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <QuotaCard title="执行次数（academic_run）" used={data?.executions ?? 0} limit={limits?.academic_run} />
            </Col>
            <Col xs={24} md={12}>
              <QuotaCard title="CPU·秒（sandbox_cpu_seconds）" used={cpuSeconds} limit={limits?.sandbox_cpu_seconds} />
            </Col>
            <Col xs={24} md={12}>
              <QuotaCard
                title="产物字节（sandbox_artifact_bytes）"
                used={data?.artifactBytes ?? 0}
                limit={limits?.sandbox_artifact_bytes}
                formatValue={formatSize}
              />
            </Col>
            <Col xs={24} md={12}>
              <QuotaCard title="并发租约上限（sandbox_concurrent）" used={null} limit={limits?.sandbox_concurrent} />
            </Col>
          </Row>
        </Spin>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

interface AuditFilters {
  uid?: string;
  action?: string;
  from?: string;
  to?: string;
}

function AuditTab() {
  const [fUid, setFUid] = useState("");
  const [fAction, setFAction] = useState("");
  const [range, setRange] = useState<RangeValue>(null);
  const [applied, setApplied] = useState<AuditFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<SandboxAuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const query = () => {
    setApplied({
      uid: fUid.trim() || undefined,
      action: fAction || undefined,
      from: range?.[0] ? range[0].toISOString() : undefined,
      to: range?.[1] ? range[1].toISOString() : undefined,
    });
    setPage(1);
  };

  const reset = () => {
    setFUid("");
    setFAction("");
    setRange(null);
    setApplied({});
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sandboxApi
      .audit({ ...applied, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err, "加载沙箱审计失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, reloadToken]);

  const columns: ColumnsType<SandboxAuditItem> = [
    { title: "时间", dataIndex: "createdAt", width: 170, render: (v: string) => formatTime(v) },
    {
      title: "动作",
      dataIndex: "action",
      width: 130,
      render: (v: string) => <Tag color="blue">{AUDIT_ACTION[v] ?? v}</Tag>,
    },
    { title: "uid", dataIndex: "uid", width: 170, render: (uid: SandboxUid) => renderUid(uid) },
    {
      title: "执行",
      dataIndex: "executionId",
      width: 130,
      render: (v: string | undefined) => (v ? renderShortId(v) : "-"),
    },
    {
      title: "租约",
      dataIndex: "leaseId",
      width: 130,
      render: (v: string | undefined) => (v ? renderShortId(v) : "-"),
    },
    { title: "项目", dataIndex: "projectId", width: 140, ellipsis: true, render: (v: string | undefined) => v || "-" },
    { title: "结果", dataIndex: "outcome", width: 100, render: (v: string | undefined) => renderOutcome(v) },
    {
      title: "耗时",
      dataIndex: "durationMs",
      width: 100,
      align: "right",
      render: (v: number | null | undefined) => formatDuration(v),
    },
    {
      title: "exitCode",
      dataIndex: "exitCode",
      width: 90,
      align: "right",
      render: (v: number | null | undefined) => (v === null || v === undefined ? "-" : v),
    },
    {
      title: "详情",
      dataIndex: "detail",
      ellipsis: true,
      render: (v: string | undefined) =>
        v ? (
          <Tooltip title={v} placement="topLeft">
            <span>{v}</span>
          </Tooltip>
        ) : (
          "-"
        ),
    },
    {
      title: "requestId",
      dataIndex: "requestId",
      width: 140,
      ellipsis: true,
      render: (v: string | undefined) => (v ? v : "-"),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="uid"
          value={fUid}
          onChange={(e) => setFUid(e.target.value.replace(/[^0-9]/g, ""))}
          onPressEnter={query}
          style={{ width: 150 }}
        />
        <Select value={fAction} onChange={setFAction} style={{ width: 170 }} options={AUDIT_ACTION_OPTIONS} />
        <RangePicker
          showTime
          value={range}
          onChange={(value) => setRange(value as RangeValue)}
          style={{ width: 360 }}
        />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
          action={<Button size="small" onClick={() => setReloadToken((t) => t + 1)}>重试</Button>}
        />
      )}

      <Table<SandboxAuditItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1600 }}
        locale={{ emptyText: "暂无沙箱审计记录" }}
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

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function Sandbox() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [tab, setTab] = useState("overview");

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="沙箱控制层运维视图"
        description="执行记录、租约与配额为只读查询；取消执行 / 强制回收仅 admin 可操作，且写操作同时记入本后台与沙箱控制层双审计。不展示完整代码正文，stdout/stderr 为截断预览，产物仅展示元数据（无下载）。"
      />
      {!isAdmin && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="当前为只读账号（viewer）：写操作按钮已禁用，如需操作请使用 admin 账号。"
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "overview", label: "概览", children: <OverviewTab /> },
          { key: "executions", label: "执行", children: <ExecutionsTab isAdmin={isAdmin} /> },
          { key: "leases", label: "租约", children: <LeasesTab isAdmin={isAdmin} /> },
          { key: "quota", label: "配额", children: <QuotaTab /> },
          { key: "audit", label: "审计", children: <AuditTab /> },
        ]}
      />
    </div>
  );
}
