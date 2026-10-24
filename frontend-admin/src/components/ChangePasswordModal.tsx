import { useEffect } from "react";
import { App as AntApp, Form, Input, Modal } from "antd";
import { api } from "../api/client";
import { setMe, useAuth } from "../auth";

interface Props {
  /** 首登强制改密：不可关闭，必须改完才能进后台 */
  mandatory?: boolean;
  open: boolean;
  onClose: () => void;
}

interface FormValues {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

/** 首登强制改密（契约 §3.3 must_change_password → POST /api/me/password） */
export default function ChangePasswordModal({ mandatory = false, open, onClose }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const { me } = useAuth();

  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const submit = async (values: FormValues) => {
    try {
      await api.changePassword(values.oldPassword, values.newPassword);
      message.success("密码已更新");
      if (me) setMe({ ...me, mustChangePassword: false });
      form.resetFields();
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "修改密码失败");
    }
  };

  return (
    <Modal
      title={mandatory ? "首次登录，必须修改初始密码" : "修改密码"}
      open={open}
      confirmLoading={false}
      closable={!mandatory}
      keyboard={!mandatory}
      maskClosable={false}
      cancelButtonProps={{ style: mandatory ? { display: "none" } : undefined }}
      okText="确认修改"
      cancelText="取消"
      onOk={() => form.submit()}
      onCancel={() => {
        if (!mandatory) onClose();
      }}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={submit} autoComplete="off">
        <Form.Item
          name="oldPassword"
          label="当前密码"
          rules={[{ required: true, message: "请输入当前密码" }]}
        >
          <Input.Password autoFocus autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: "请输入新密码" },
            { min: 6, message: "新密码至少 6 位" },
            { validator: (_, v: string) => (v && v === form.getFieldValue("oldPassword") ? Promise.reject(new Error("新密码不能与当前密码相同")) : Promise.resolve()) },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={["newPassword"]}
          rules={[
            { required: true, message: "请再次输入新密码" },
            ({ getFieldValue }) => ({
              validator: (_, v: string) =>
                !v || v === getFieldValue("newPassword") ? Promise.resolve() : Promise.reject(new Error("两次输入不一致")),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
