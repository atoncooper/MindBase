import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../../api/client";
import { payApi } from "../../api/pay";
import type {
  PayProductItem,
  PayProductWrite,
  ProductStatus,
  ProductTier,
} from "../../api/pay";
import { useAuth } from "../../auth";
import { formatCents, formatTime } from "../../components/format";

/** 状态映射必须对齐 app-pay 的真实枚举（历史误写为 ON_SALE/OFF_SALE）。 */
const STATUS_META: Record<ProductStatus, { label: string; color: string }> = {
  ACTIVE: { label: "在售", color: "green" },
  DISABLED: { label: "已下架", color: "default" },
};

const TIER_META: Record<ProductTier, { label: string; color: string }> = {
  VIP: { label: "VIP", color: "blue" },
  SVIP: { label: "SVIP", color: "purple" },
  PROMAX: { label: "ProMax", color: "gold" },
};

const TIER_OPTIONS = (Object.keys(TIER_META) as ProductTier[]).map((value) => ({
  value,
  label: TIER_META[value].label,
}));

const STATUS_OPTIONS = (Object.keys(STATUS_META) as ProductStatus[]).map((value) => ({
  value,
  label: STATUS_META[value].label,
}));

/** 与后端一致：大写字母/数字/下划线，≤50 字符。 */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,49}$/;

interface ProductFormValues {
  code: string;
  title: string;
  durationDays: number;
  /** 表单按元录入，提交前换算为整数分 */
  priceYuan: number;
  tier: ProductTier;
  status: ProductStatus;
  sort: number;
}

/** 后端写模型：priceCents 整数分、code 更新时不可改。 */
function toWrite(values: ProductFormValues, status: ProductStatus): PayProductWrite {
  return {
    code: values.code.trim(),
    title: values.title.trim(),
    durationDays: values.durationDays,
    priceCents: Math.round(values.priceYuan * 100),
    tier: values.tier,
    status,
    sort: values.sort,
  };
}

/** 把现有行还原成表单值（编辑 / 上下架共用）。 */
function toFormValues(item: PayProductItem): ProductFormValues {
  return {
    code: item.code,
    title: item.title,
    durationDays: item.durationDays,
    priceYuan: item.priceCents / 100,
    tier: item.tier,
    status: item.status,
    sort: item.sort,
  };
}

/** SKU 商品目录：权威表 + 管理员 CRUD（viewer 只读）。 */
export default function PayProducts() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<ProductFormValues>();

  const [items, setItems] = useState<PayProductItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [payDisabled, setPayDisabled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PayProductItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mutatingId, setMutatingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await payApi.products();
      setItems(res.items ?? []);
      setPayDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setPayDisabled(true);
        return;
      }
      message.error(err instanceof Error ? err.message : "加载 SKU 目录失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      code: "",
      title: "",
      durationDays: 30,
      priceYuan: 18,
      tier: "VIP",
      status: "ACTIVE",
      sort: 0,
    });
    setModalOpen(true);
  };

  const openEdit = (item: PayProductItem) => {
    setEditing(item);
    form.resetFields();
    form.setFieldsValue(toFormValues(item));
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  const handleError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 503) {
      setPayDisabled(true);
      return;
    }
    // 400 校验 / 409 冲突（编码重复、最后一个在售商品）统一透传后端中文 detail
    message.error(err instanceof Error ? err.message : fallback);
  };

  const onFinish = async (values: ProductFormValues) => {
    const priceCents = Math.round(values.priceYuan * 100);
    if (priceCents <= 0) {
      message.error("商品价格必须大于 0");
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await payApi.updateProduct(editing.id, toWrite(values, values.status));
        message.success("商品已更新");
      } else {
        await payApi.createProduct(toWrite(values, values.status));
        message.success("商品已创建");
      }
      closeModal();
      await load();
    } catch (err) {
      handleError(err, editing ? "更新商品失败" : "创建商品失败");
    } finally {
      setSubmitting(false);
    }
  };

  /** 上架 / 下架：走 PUT 全量更新，状态翻转。 */
  const toggleStatus = async (item: PayProductItem) => {
    const next: ProductStatus = item.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    setMutatingId(item.id);
    try {
      await payApi.updateProduct(item.id, toWrite(toFormValues(item), next));
      message.success(next === "ACTIVE" ? "商品已上架" : "商品已下架");
      await load();
    } catch (err) {
      handleError(err, next === "ACTIVE" ? "上架失败" : "下架失败");
    } finally {
      setMutatingId(null);
    }
  };

  /** 删除：无订单引用才物理删除，否则后端自动转为 DISABLED。 */
  const removeProduct = async (item: PayProductItem) => {
    setMutatingId(item.id);
    try {
      const res = await payApi.deleteProduct(item.id);
      message.success(
        res.result === "deleted"
          ? "商品已删除"
          : "商品已被订单引用，未删除，已自动下架（DISABLED）",
      );
      await load();
    } catch (err) {
      handleError(err, "删除商品失败");
    } finally {
      setMutatingId(null);
    }
  };

  const columns: ColumnsType<PayProductItem> = [
    {
      title: "编码",
      dataIndex: "code",
      width: 180,
      render: (v: string) => <code>{v}</code>,
    },
    { title: "名称", dataIndex: "title", width: 220 },
    {
      title: "档位",
      dataIndex: "tier",
      width: 100,
      render: (v: ProductTier) => {
        const meta = TIER_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    {
      title: "天数",
      dataIndex: "durationDays",
      width: 90,
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
      render: (v: ProductStatus) => {
        const meta = STATUS_META[v];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? v}</Tag>;
      },
    },
    { title: "排序", dataIndex: "sort", width: 80, align: "right" },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 170,
      render: (v: string) => formatTime(v),
    },
  ];

  if (isAdmin) {
    columns.push({
      title: "操作",
      key: "actions",
      width: 220,
      fixed: "right",
      render: (_, record) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            loading={mutatingId === record.id}
            onClick={() => void toggleStatus(record)}
          >
            {record.status === "ACTIVE" ? "下架" : "上架"}
          </Button>
          <Popconfirm
            title="确认删除该商品？"
            description="有订单引用的商品不会物理删除，而是自动下架（DISABLED）。"
            okText="确认删除"
            cancelText="取消"
            onConfirm={() => void removeProduct(record)}
          >
            <Button size="small" type="link" danger disabled={mutatingId === record.id}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    });
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="商品目录为权威表：此处的增删改直接写入 app_pay.pay_product，app-pay 下单在 5 秒缓存 TTL 内生效。"
        description={
          isAdmin
            ? "删除时若有历史订单引用该编码，则保留记录并自动下架；目录中必须至少保留一个在售商品。"
            : "当前为只读角色（viewer），可查看目录；增删改需管理员（admin）。"
        }
      />
      {payDisabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="支付管理未配置：商品目录暂不可用。"
        />
      )}
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!isAdmin}
          onClick={openCreate}
        >
          新建商品
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadToken((t) => t + 1)}>
          刷新
        </Button>
      </Space>
      <Table<PayProductItem>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1200 }}
        locale={{ emptyText: "暂无商品" }}
        pagination={false}
      />

      <Modal
        title={editing ? "编辑商品" : "新建商品"}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText={editing ? "保存" : "创建"}
        cancelText="取消"
        destroyOnClose
        width={560}
      >
        <Form<ProductFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => void onFinish(values)}
          initialValues={{
            durationDays: 30,
            priceYuan: 18,
            tier: "VIP",
            status: "ACTIVE",
            sort: 0,
          }}
        >
          <Form.Item
            label="商品编码"
            name="code"
            tooltip="大写字母/数字/下划线，≤50 字符；创建后不可修改（订单历史按编码快照）"
            rules={[
              { required: true, message: "商品编码必填" },
              {
                validator: (_: unknown, value: string | undefined) => {
                  const v = (value ?? "").trim();
                  if (!v) return Promise.reject(new Error("商品编码必填"));
                  if (!CODE_PATTERN.test(v)) {
                    return Promise.reject(
                      new Error("只能包含大写字母/数字/下划线，且不超过 50 字符"),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="如 VIP_MONTHLY" disabled={!!editing} maxLength={50} />
          </Form.Item>
          <Form.Item
            label="商品名称"
            name="title"
            rules={[
              { required: true, message: "商品名称必填" },
              {
                validator: (_: unknown, value: string | undefined) => {
                  const v = (value ?? "").trim();
                  if (!v) return Promise.reject(new Error("商品名称必填"));
                  if (Array.from(v).length > 100) {
                    return Promise.reject(new Error("商品名称不能超过 100 字"));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="如 VIP 月卡" maxLength={100} />
          </Form.Item>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item
              label="有效天数"
              name="durationDays"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "有效天数必填" }]}
            >
              <InputNumber min={1} max={3650} precision={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="价格（元）"
              name="priceYuan"
              style={{ flex: 1 }}
              rules={[
                { required: true, message: "价格必填" },
                {
                  validator: (_: unknown, value: number | null | undefined) => {
                    if (value === null || value === undefined) {
                      return Promise.reject(new Error("价格必填"));
                    }
                    if (Math.round(value * 100) <= 0) {
                      return Promise.reject(new Error("价格必须大于 0"));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <InputNumber
                min={0.01}
                step={0.01}
                precision={2}
                style={{ width: "100%" }}
                addonBefore="¥"
              />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item
              label="会员档位"
              name="tier"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "档位必填" }]}
            >
              <Select options={TIER_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="状态"
              name="status"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "状态必填" }]}
            >
              <Select options={STATUS_OPTIONS} />
            </Form.Item>
            <Form.Item label="排序" name="sort" style={{ flex: 1 }}>
              <InputNumber min={0} max={1000000} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
