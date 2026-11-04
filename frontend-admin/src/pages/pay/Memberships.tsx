import { useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Input,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { payApi } from "../../api/pay";
import type { PayMembershipItem } from "../../api/pay";
import { formatTime } from "../../components/format";
import { TIER_META } from "../../components/pay-meta";

/** 会员：UID 精确查询 + 全量分页；行操作「权益流水」跳单人事件流。 */
export default function PayMemberships() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialUid = searchParams.get("uid") ?? "";
  const [uidInput, setUidInput] = useState(initialUid);
  const [lookupUid, setLookupUid] = useState<string | null>(
    /^\d+$/.test(initialUid) ? initialUid : null,
  );
  const [reloadToken, setReloadToken] = useState(0);

  // 从其他页面带 ?uid= 进入时同步查询目标
  useEffect(() => {
    const uid = searchParams.get("uid") ?? "";
    if (!uid || !/^\d+$/.test(uid)) return;
    setUidInput(uid);
    setLookupUid(uid);
  }, [searchParams]);

  // 单人会员态
  const [membership, setMembership] = useState<PayMembershipItem | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupDone, setLookupDone] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // 全量列表
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<PayMembershipItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!lookupUid) {
      setMembership(null);
      setLookupDone(false);
      setLookupError(null);
      return;
    }
    let cancelled = false;
    setLookupLoading(true);
    setLookupDone(false);
    setLookupError(null);
    payApi
      .membership(lookupUid)
      .then((res) => {
        if (cancelled) return;
        setMembership(res.membership ?? null);
        setLookupDone(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : "加载会员信息失败";
        setLookupError(detail);
        message.error(detail);
      })
      .finally(() => {
        if (!cancelled) setLookupLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lookupUid, reloadToken, message]);

  useEffect(() => {
    if (lookupUid) return;
    let cancelled = false;
    setLoading(true);
    payApi
      .memberships({ page, pageSize })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setTotal(res.total ?? res.items?.length ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) message.error(err instanceof Error ? err.message : "加载会员列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lookupUid, page, pageSize, reloadToken, message]);

  const submitLookup = () => {
    const uid = uidInput.trim();
    if (!/^\d+$/.test(uid)) {
      message.warning("请输入正整数 UID");
      return;
    }
    setLookupUid(uid);
  };

  const clearLookup = () => {
    setLookupUid(null);
    setUidInput("");
    setPage(1);
  };

  const tierTag = (tier: string) => {
    const meta = TIER_META[tier];
    return <Tag color={meta?.color ?? "default"}>{meta?.label ?? tier}</Tag>;
  };

  const activeTag = (active: boolean) =>
    active ? <Tag color="green">生效中</Tag> : <Tag color="default">已过期</Tag>;

  const columns: ColumnsType<PayMembershipItem> = [
    {
      title: "UID",
      dataIndex: "uid",
      width: 150,
      render: (v: string) => <Link to={"/pay/memberships?uid=" + encodeURIComponent(v)}>{v}</Link>,
    },
    {
      title: "档位",
      dataIndex: "tier",
      width: 100,
      render: (v: string) => tierTag(v),
    },
    {
      title: "状态",
      dataIndex: "active",
      width: 100,
      render: (v: boolean) => activeTag(v),
    },
    {
      title: "到期时间",
      dataIndex: "expireAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "自动续费",
      dataIndex: "autoRenew",
      width: 100,
      render: (v: boolean) => (v ? "是" : "否"),
    },
    {
      title: "最近订单号",
      dataIndex: "lastOrderNo",
      width: 210,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
    {
      title: "操作",
      key: "op",
      width: 110,
      fixed: "right",
      render: (_, r) => (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          onClick={() => navigate("/pay/memberships/" + encodeURIComponent(r.uid) + "/events")}
        >
          权益流水
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder="按 UID 精确查询会员"
          value={uidInput}
          onChange={(e) => setUidInput(e.target.value)}
          onPressEnter={submitLookup}
          style={{ width: 240 }}
        />
        <Button type="primary" onClick={submitLookup}>
          查询会员
        </Button>
        {lookupUid ? <Button onClick={clearLookup}>查看全部会员</Button> : null}
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)} />
      </Space>

      {lookupUid ? (
        <Spin spinning={lookupLoading}>
          {lookupError ? (
            <Alert type="error" showIcon message="加载会员信息失败" description={lookupError} />
          ) : null}
          {lookupDone && !membership ? (
            <Alert
              type="info"
              showIcon
              message={"用户 " + lookupUid + " 暂无会员记录"}
              description="该 UID 在 pay_membership 中不存在；可到「补偿开通」为其开通会员。"
            />
          ) : null}
          {membership ? (
            <Card
              title={"会员 " + membership.uid}
              extra={
                <Space>
                  <Button
                    type="primary"
                    onClick={() =>
                      navigate("/pay/memberships/" + encodeURIComponent(membership.uid) + "/events")
                    }
                  >
                    权益流水
                  </Button>
                  <Button onClick={clearLookup}>返回列表</Button>
                </Space>
              }
            >
              <Descriptions column={2} size="small" bordered>
                <Descriptions.Item label="UID">{membership.uid}</Descriptions.Item>
                <Descriptions.Item label="档位">{tierTag(membership.tier)}</Descriptions.Item>
                <Descriptions.Item label="状态">{activeTag(membership.active)}</Descriptions.Item>
                <Descriptions.Item label="到期时间">{formatTime(membership.expireAt)}</Descriptions.Item>
                <Descriptions.Item label="自动续费">
                  {membership.autoRenew ? "是" : "否"}
                </Descriptions.Item>
                <Descriptions.Item label="最近订单号">
                  {membership.lastOrderNo || "-"}
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">{formatTime(membership.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="更新时间">{formatTime(membership.updatedAt)}</Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}
        </Spin>
      ) : (
        <Table<PayMembershipItem>
          rowKey="uid"
          columns={columns}
          dataSource={items}
          loading={loading}
          scroll={{ x: 1200 }}
          locale={{ emptyText: "暂无会员记录" }}
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
      )}
    </div>
  );
}
