import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  EyeOutlined,
  ProfileOutlined,
  ReloadOutlined,
  StopOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ModerationStatus, PreviewGrant, ShareDetail, ShareItem, ShareFileMeta } from "../api/types";
import { useAuth } from "../auth";
import { formatSize, formatTime } from "../components/format";

const MODERATION: Record<ModerationStatus, { label: string; color: string }> = {
  active: { label: "待审核", color: "orange" },
  "": { label: "待审核", color: "orange" },
  approved: { label: "已放行", color: "green" },
  banned: { label: "已封杀", color: "red" },
};

const ACTION_META = {
  ban: { title: "封杀分享", okText: "确认封杀", required: true, danger: true, placeholder: "封杀原因（必填，将记入审计）" },
  unban: { title: "解封分享", okText: "确认解封", required: false, danger: false, placeholder: "原因（选填，将记入审计）" },
  approve: { title: "放行分享", okText: "确认放行", required: false, danger: false, placeholder: "备注（选填，将记入审计）" },
} as const;
type ActionType = keyof typeof ACTION_META;

interface ShareFilters {
  status?: ModerationStatus;
  uid?: number | string;
  q?: string;
  revoked?: boolean;
  /** true = 仅目标仍存在的可审核分享（默认）；false = 仅目标已删除的存量记录 */
  available?: boolean;
}

/** 文件元数据表（仅元数据 + admin 受控预览；无下载能力） */
function FileMetaTable({
  files,
  shareId,
  isAdmin,
  onPreview,
  notify,
}: {
  files: ShareFileMeta[];
  shareId: number;
  isAdmin: boolean;
  onPreview: (grant: PreviewGrant) => void;
  notify: (err: unknown) => void;
}) {
  const [previewId, setPreviewId] = useState<number | null>(null);
  const columns: ColumnsType<ShareFileMeta> = [
    { title: "文件名", dataIndex: "name", ellipsis: true },
    { title: "大小", dataIndex: "size", width: 110, render: (v: number) => formatSize(v) },
    { title: "MIME", dataIndex: "mimeType", width: 160, ellipsis: true },
    { title: "相对路径", dataIndex: "path", width: 220, ellipsis: true, render: (v: string) => v || "-" },
    ...(isAdmin
      ? [
          {
            title: "内容",
            key: "preview",
            width: 90,
            render: (_: unknown, r: ShareFileMeta) => (
              <Button
                size="small"
                type="link"
                icon={<EyeOutlined />}
                loading={previewId === r.fileId}
                onClick={async () => {
                  setPreviewId(r.fileId);
                  try {
                    onPreview(await api.previewShareFile(shareId, r.fileId));
                  } catch (err) {
                    notify(err);
                  } finally {
                    setPreviewId(null);
                  }
                }}
              >
                预览
              </Button>
            ),
          } satisfies ColumnsType<ShareFileMeta>[number],
        ]
      : []),
  ];
  return (
    <Table<ShareFileMeta>
      size="small"
      rowKey={(r) => `f-${r.fileId}`}
      columns={columns}
      dataSource={files}
      pagination={files.length > 10 ? { pageSize: 10, size: "small" } : false}
    />
  );
}

/**
 * 受控预览弹层：短时效内联授权，按 viewMode 渲染。红线：
 * - pdf / image / audio / video 走短时效内联 URL；
 * - 文档（docx/xlsx/pptx/html/markdown/txt 等）由后端提取纯文本后返回，不生成
 *   任何对象 URL，也不渲染 HTML（防存储型 XSS）；
 * - 绝不提供下载按钮；关闭弹层即丢弃，不缓存不转发。
 */
function PreviewModal({ grant, onClose }: { grant: PreviewGrant | null; onClose: () => void }) {
  const isText = grant?.viewMode === "text";
  const inline = grant && (isText || ["pdf", "video", "audio", "image"].includes(grant.viewMode));
  return (
    <Modal
      open={!!grant}
      onCancel={onClose}
      footer={null}
      width={860}
      title={grant ? `内容审核预览：${grant.fileName}` : ""}
      destroyOnClose
    >
      {!grant ? null : !inline ? (
        <Typography.Text type="secondary">
          该文件类型（{grant.mimeType}）不支持安全内联预览，无法在线审核内容。
        </Typography.Text>
      ) : isText ? (
        <div>
          <pre
            style={{
              maxHeight: 520,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#f5f5f7",
              padding: 12,
              borderRadius: 8,
              margin: 0,
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {grant.text}
          </pre>
          {grant.truncated && (
            <Typography.Text type="warning" style={{ display: "block", marginTop: 8 }}>
              内容较长，仅展示前 12 万字符。
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
            文档文本预览（仅用于内容审核，不含排版，不提供下载）。
          </Typography.Text>
        </div>
      ) : grant.viewMode === "image" ? (
        <img src={grant.url} alt={grant.fileName} style={{ maxWidth: "100%" }} />
      ) : grant.viewMode === "video" ? (
        <video src={grant.url} controls style={{ width: "100%", maxHeight: 480 }} />
      ) : grant.viewMode === "audio" ? (
        <audio src={grant.url} controls style={{ width: "100%" }} />
      ) : (
        <iframe src={grant.url} title={grant.fileName} style={{ width: "100%", height: 560, border: 0 }} />
      )}
      {grant && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {isText
            ? "本次文本查看已记入审计日志。"
            : `预览授权约 ${Math.round(grant.expiresIn / 60)} 分钟后失效；本次查看已记入审计日志。`}
        </Typography.Paragraph>
      )}
    </Modal>
  );
}

/**
 * 分享详情抽屉：审核前查看「分享到底是什么」的明确入口。
 * 元数据（文件名/大小/类型/相对路径）始终可见；文件内容仅在用户已确认
 * 《管理员内容审核告知》时，admin 可逐个发起受控预览（每次预览落审计）。
 */
function ShareDetailDrawer({
  share,
  detail,
  loading,
  isAdmin,
  onClose,
  onPreview,
  notify,
}: {
  share: ShareItem | null;
  detail: ShareDetail | null;
  loading: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onPreview: (grant: PreviewGrant) => void;
  notify: (err: unknown) => void;
}) {
  const ack = detail?.contentReviewAck ?? share?.contentReviewAck ?? false;
  const files = detail?.files ?? [];
  return (
    <Drawer
      open={!!share}
      onClose={onClose}
      width={920}
      destroyOnClose
      title={share ? `查看分享 #${share.id} · ${share.name}` : "查看分享"}
    >
      {loading || !detail ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin />
        </div>
      ) : (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="类型">
              <Tag color={detail.targetType === "folder" ? "purple" : "blue"}>
                {detail.targetType === "folder" ? "文件夹" : "文件"}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="审核状态">
              <Tag color={MODERATION[detail.moderationStatus]?.color ?? "default"}>
                {MODERATION[detail.moderationStatus]?.label ?? (detail.moderationStatus || "-")}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="名称">{detail.name || "-"}</Descriptions.Item>
            <Descriptions.Item label="属主">
              {detail.ownerNickname ?? "-"} ({detail.ownerUid})
            </Descriptions.Item>
            <Descriptions.Item label="文件数">{detail.fileCount}</Descriptions.Item>
            <Descriptions.Item label="总大小">{formatSize(detail.totalSize)}</Descriptions.Item>
            <Descriptions.Item label="提取码">{detail.hasCode ? "有（受保护）" : "无"}</Descriptions.Item>
            <Descriptions.Item label="有效期">
              {detail.expiresAt ? formatTime(detail.expiresAt) : "永久"}
            </Descriptions.Item>
            <Descriptions.Item label="浏览 / 下载">
              {detail.viewCount} / {detail.downloadCount}
            </Descriptions.Item>
            <Descriptions.Item label="已撤销">{detail.isRevoked ? "是" : "否"}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{formatTime(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="审核时间">{formatTime(detail.moderationTime)}</Descriptions.Item>
            {detail.moderationReason ? (
              <Descriptions.Item label="审核原因" span={2}>
                {detail.moderationReason}
              </Descriptions.Item>
            ) : null}
            {detail.moderationBy ? (
              <Descriptions.Item label="审核人" span={2}>
                {detail.moderationBy}
              </Descriptions.Item>
            ) : null}
          </Descriptions>

          {!detail.contentAvailable ? (
            <Alert
              style={{ marginTop: 16 }}
              type="warning"
              showIcon
              message="分享目标文件已不存在（已删除），无可审核内容"
              description="该分享不需要审核，也不会出现在默认审核队列中；记录仅保留供审计查询。文件元数据仍可查看，但内容无法预览。"
            />
          ) : (
            <>
              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                message={
                  ack
                    ? "用户已确认《管理员内容审核告知》"
                    : "用户未确认《管理员内容审核告知》— 审核员仍可依职责查看"
                }
                description={
                  ack
                    ? "可对分享内文件逐个发起受控预览（仅内联展示，不提供下载/链接复制；每次查看都会记入审计日志）。"
                    : "为履行内容审核职责，管理员仍可查看该分享的文件内容；每次预览都会记入审计日志，仅限审核用途，禁止下载、转发或外泄。"
                }
              />

              <div style={{ fontWeight: 600, margin: "20px 0 8px" }}>
                分享内文件（{files.length}
                {detail.truncated ? "+（仅展示前 2000 个）" : ""}）
              </div>
              <FileMetaTable
                files={files}
                shareId={detail.id}
                isAdmin={isAdmin}
                onPreview={onPreview}
                notify={notify}
              />
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

export default function Shares() {
  const { message } = AntApp.useApp();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";

  const [fStatus, setFStatus] = useState<ModerationStatus | "">("");
  const [fUid, setFUid] = useState("");
  const [fQ, setFQ] = useState("");
  const [fRevoked, setFRevoked] = useState<"" | "true" | "false">("");
  // 默认只看「目标仍存在」的可审核分享；目标已删除的存量记录仅供审计查看
  const [fAvailable, setFAvailable] = useState<"1" | "0" | "">("1");
  const [applied, setApplied] = useState<ShareFilters>({ available: true });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [reloadToken, setReloadToken] = useState(0);

  const [items, setItems] = useState<ShareItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [details, setDetails] = useState<Record<number, ShareDetail | undefined>>({});
  const [detailLoading, setDetailLoading] = useState<Set<number>>(new Set());

  const [action, setAction] = useState<{ type: ActionType; share: ShareItem } | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<PreviewGrant | null>(null);
  // 查看抽屉：审核前先看清「分享里到底有什么」（元数据 + 受控预览入口）
  const [viewing, setViewing] = useState<ShareItem | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  // 审计日志「分享 #ID」深链：/shares?share=10 自动打开详情抽屉
  const [searchParams] = useSearchParams();
  const openedDeepLink = useRef("");

  const query = () => {
    setApplied({
      status: fStatus || undefined,
      uid: fUid.trim() || undefined,
      q: fQ.trim() || undefined,
      revoked: fRevoked === "" ? undefined : fRevoked === "true",
      available: fAvailable === "" ? undefined : fAvailable === "1",
    });
    setPage(1);
  };

  const reset = () => {
    setFStatus("");
    setFUid("");
    setFQ("");
    setFRevoked("");
    setFAvailable("1");
    setApplied({ available: true });
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .shares({ ...applied, page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载分享列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, pageSize, reloadToken, message]);

  const loadDetail = useCallback(
    async (id: number) => {
      setDetailLoading((prev) => new Set(prev).add(id));
      try {
        const d = await api.shareDetail(id);
        setDetails((prev) => ({ ...prev, [id]: d }));
      } catch (err) {
        message.error(err instanceof Error ? err.message : "加载分享详情失败");
      } finally {
        setDetailLoading((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [message],
  );

  const openView = useCallback(
    async (row: ShareItem) => {
      setViewing(row);
      if (details[row.id]) {
        setViewLoading(false);
        return;
      }
      setViewLoading(true);
      try {
        const d = await api.shareDetail(row.id);
        setDetails((prev) => ({ ...prev, [row.id]: d }));
      } catch (err) {
        message.error(err instanceof Error ? err.message : "加载分享详情失败");
        setViewing(null);
      } finally {
        setViewLoading(false);
      }
    },
    [details, message],
  );

  useEffect(() => {
    const raw = searchParams.get("share");
    if (!raw || raw === openedDeepLink.current) return;
    openedDeepLink.current = raw;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    void (async () => {
      try {
        const d = await api.shareDetail(id);
        setDetails((prev) => ({ ...prev, [id]: d }));
        setViewing(d);
      } catch (err) {
        message.error(err instanceof Error ? err.message : "加载分享详情失败");
      }
    })();
  }, [searchParams, message]);

  const openAction = (type: ActionType, share: ShareItem) => {
    setReason("");
    setAction({ type, share });
  };

  const submitAction = async () => {
    if (!action) return;
    const meta = ACTION_META[action.type];
    if (meta.required && !reason.trim()) {
      message.warning("原因必填");
      return;
    }
    setSubmitting(true);
    try {
      if (action.type === "ban") await api.banShare(action.share.id, reason.trim());
      if (action.type === "unban") await api.unbanShare(action.share.id, reason.trim() || undefined);
      if (action.type === "approve") await api.approveShare(action.share.id, reason.trim() || undefined);
      message.success(`${meta.title}成功`);
      setAction(null);
      setDetails((prev) => {
        const next = { ...prev };
        delete next[action.share.id];
        return next;
      });
      setReloadToken((t) => t + 1);
    } catch (err) {
      message.error(err instanceof Error ? err.message : `${meta.title}失败`);
    } finally {
      setSubmitting(false);
    }
  };

  const actionButtons = (row: ShareItem) => {
    const gate = (node: React.ReactNode) =>
      isAdmin ? node : (
        <Tooltip title="需要 admin 角色">
          <span>{node}</span>
        </Tooltip>
      );
    return (
      <Space size={4}>
        <Button size="small" type="link" icon={<ProfileOutlined />} onClick={() => void openView(row)}>
          查看
        </Button>
        {row.moderationStatus !== "approved" &&
          gate(
            <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => openAction("approve", row)}>
              放行
            </Button>,
          )}
        {row.moderationStatus === "banned" &&
          gate(
            <Button size="small" type="link" icon={<UndoOutlined />} onClick={() => openAction("unban", row)}>
              解封
            </Button>,
          )}
        {row.moderationStatus !== "banned" &&
          gate(
            <Button size="small" type="link" danger icon={<StopOutlined />} onClick={() => openAction("ban", row)}>
              封杀
            </Button>,
          )}
      </Space>
    );
  };

  const columns: ColumnsType<ShareItem> = [
    { title: "ID", dataIndex: "id", width: 70 },
    {
      title: "类型",
      dataIndex: "targetType",
      width: 84,
      render: (t: string) => (
        <Tag color={t === "folder" ? "purple" : "blue"}>{t === "folder" ? "文件夹" : "文件"}</Tag>
      ),
    },
    { title: "名称", dataIndex: "name", ellipsis: true },
    {
      title: "目标内容",
      dataIndex: "contentAvailable",
      width: 110,
      render: (v: boolean) =>
        v ? <Tag color="green">可审核</Tag> : <Tag color="default">目标已删除</Tag>,
    },
    {
      title: "属主",
      key: "owner",
      width: 180,
      ellipsis: true,
      render: (_, r) => `${r.ownerNickname ?? "-"} (${r.ownerUid})`,
    },
    { title: "文件数", dataIndex: "fileCount", width: 80, align: "right" },
    { title: "总大小", dataIndex: "totalSize", width: 100, align: "right", render: (v: number) => formatSize(v) },
    { title: "浏览", dataIndex: "viewCount", width: 70, align: "right" },
    { title: "下载", dataIndex: "downloadCount", width: 70, align: "right" },
    {
      title: "审核状态",
      dataIndex: "moderationStatus",
      width: 110,
      render: (v: ModerationStatus, r) => (
        <Tooltip title={r.moderationReason ? `原因：${r.moderationReason}` : undefined}>
          <Tag color={MODERATION[v]?.color ?? "default"}>{MODERATION[v]?.label ?? v}</Tag>
        </Tooltip>
      ),
    },
    {
      title: "已撤销",
      dataIndex: "isRevoked",
      width: 84,
      render: (v: boolean) => (v ? <Tag>已撤销</Tag> : "-"),
    },
    { title: "创建时间", dataIndex: "createdAt", width: 160, render: (v: string | null) => formatTime(v) },
    { title: "审核时间", dataIndex: "moderationTime", width: 160, render: (v: string | null) => formatTime(v) },
    { title: "操作", key: "action", width: 260, fixed: "right", render: (_, row) => actionButtons(row) },
  ];

  const meta = action ? ACTION_META[action.type] : null;

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select<ModerationStatus | "">
          value={fStatus}
          onChange={setFStatus}
          style={{ width: 140 }}
          options={[
            { value: "", label: "全部状态" },
            { value: "active", label: "待审核" },
            { value: "approved", label: "已放行" },
            { value: "banned", label: "已封杀" },
          ]}
        />
        <Input
          allowClear
          placeholder="属主 uid"
          value={fUid}
          onChange={(e) => setFUid(e.target.value.replace(/[^0-9]/g, ""))}
          style={{ width: 140 }}
        />
        <Input
          allowClear
          placeholder="关键词（名称/属主昵称）"
          value={fQ}
          onChange={(e) => setFQ(e.target.value)}
          onPressEnter={query}
          style={{ width: 200 }}
        />
        <Select<"" | "true" | "false">
          value={fRevoked}
          onChange={setFRevoked}
          style={{ width: 130 }}
          options={[
            { value: "", label: "撤销：全部" },
            { value: "false", label: "未撤销" },
            { value: "true", label: "已撤销" },
          ]}
        />
        <Select<"1" | "0" | "">
          value={fAvailable}
          onChange={setFAvailable}
          style={{ width: 150 }}
          options={[
            { value: "1", label: "内容：可审核" },
            { value: "0", label: "内容：目标已删除" },
            { value: "", label: "内容：全部" },
          ]}
        />
        <Button type="primary" onClick={query}>
          查询
        </Button>
        <Button onClick={reset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      <Table<ShareItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1500 }}
        expandedRowRender={(row) => {
          const d = details[row.id];
          if (!d || detailLoading.has(row.id)) return <Spin size="small" />;
          return (
            <div>
              <div style={{ marginBottom: 8 }}>
                {d.contentAvailable ? (
                  <Tag color="green">目标内容存在</Tag>
                ) : (
                  <Tag color="default">目标文件已删除，无可审核内容</Tag>
                )}
                {d.contentReviewAck ? (
                  <Tag color="cyan">用户已确认内容审核告知</Tag>
                ) : (
                  <Tag color="default">用户未确认内容审核告知（审核员仍可依职责查看）</Tag>
                )}
              </div>
              <FileMetaTable
                files={d.files ?? []}
                shareId={row.id}
                isAdmin={isAdmin}
                onPreview={setPreview}
                notify={(err) =>
                  message.error(err instanceof Error ? err.message : "预览失败")
                }
              />
            </div>
          );
        }}
        onExpand={(expanded, row) => {
          if (expanded && !details[row.id]) void loadDetail(row.id);
        }}
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
        title={meta?.title}
        open={action !== null}
        confirmLoading={submitting}
        okText={meta?.okText}
        okButtonProps={meta?.danger ? { danger: true } : undefined}
        cancelText="取消"
        onOk={submitAction}
        onCancel={() => setAction(null)}
        destroyOnClose
      >
        {action ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            分享 #{action.share.id}（${action.share.name} · 属主 ${action.share.ownerUid}）
            {action.type === "ban" ? "。封杀后公开访问立即 404，不影响属主的撤销语义。" : ""}
          </Typography.Paragraph>
        ) : null}
        <Input.TextArea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={meta?.placeholder}
          maxLength={500}
          showCount={meta?.required}
        />
      </Modal>

      <PreviewModal grant={preview} onClose={() => setPreview(null)} />

      <ShareDetailDrawer
        share={viewing}
        detail={viewing ? details[viewing.id] ?? null : null}
        loading={viewLoading}
        isAdmin={isAdmin}
        onClose={() => setViewing(null)}
        onPreview={setPreview}
        notify={(err) => message.error(err instanceof Error ? err.message : "预览失败")}
      />
    </div>
  );
}
