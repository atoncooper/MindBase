# frontend-admin — MindBase 统一管理后台前端

独立管理后台前端（**Vite + React 18 + TypeScript + antd v5 + react-router-dom v6**）。
覆盖：云盘分享审核 + 沙箱控制台 + 支付运营（订单 / 会员 / 权益事件 / SKU / 补偿开通 / 退款复核）+ 控制台账户 + 审计日志。
唯一后端：`app-go/app-admin`（API）与 `docs/app-admin.md`（使用/API 文档）；原独立服务 `app-pay-admin` 已于 2026-11-03 合并退役。

> 与 `frontendv2/`（用户端 Next.js）严格分离：不共享组件、不共享 API 层、不挂 workspace。

## 运行

```bash
pnpm i
pnpm dev      # http://localhost:3001，dev 代理 /api -> app-admin 并改写为同源 Origin
pnpm build    # tsc --noEmit && vite build

# Docker Compose（从仓库根目录执行；app-admin 是完整 UI 入口，会启动 API 与 DB/schema 依赖）
docker compose up -d --build app-admin
# 浏览器访问 http://127.0.0.1:3001
```

后端：`app-go/app-admin`（compose 服务 `app-admin-api`，仅 127.0.0.1:8016 回环，不经 APISIX）。Compose `app-admin` 使用 Nginx 提供静态文件，并将同源 `/api` 代理至 `app-admin-api:8016`；UI 端口默认也仅绑定宿主机回环（`APP_ADMIN_WEB_PORT` 可改端口）。

## 页面

| 路由 | 说明 |
|------|------|
| `/login` | 登录；`mustChangePassword=true` 时强制先改密（POST /api/me/password） |
| `/shares` | 分享审核：筛选（审核状态/uid/关键词/是否已撤销/**内容状态**）+ 元数据 Table + **每行「查看」详情抽屉**（元数据 + 分享内文件列表 + 受控预览入口）+ 放行/封杀/解封（reason 弹窗，封杀必填；admin 角色）。**默认只看目标仍存在的可审核分享**；目标已删除的存量记录仅在「内容：全部/目标已删除」下展示，标记为不可审核 |
| `/users` | 用户只读：uid/email/phone/nickname/status/角色 Tag；行点击抽屉看角色明细。查询自动识别 **UID / 11 位手机号 / 邮箱**（前端正则判定并显示模式，后端再校验；不传 mode 后端也会推断） |
| `/sandbox` | 沙箱控制面板：概览 / 执行 / 租约 / 配额 / 审计（数据经 app-sandbox `/internal/admin/*`，viewer 只读、admin 可取消执行/回收租约） |
| `/pay/orders`、`/pay/orders/:orderNo` | 支付订单列表（订单号 / UID / 交易号 / 状态 / 渠道 / 创建时间范围）与详情（Descriptions + 渠道回调流水 Table） |
| `/pay/memberships`、`/pay/memberships/:uid/events` | 会员 UID 精确查询 / 全量分页；单人权益事件流 |
| `/pay/events` | 全局权益事件流（uid / type 筛选，ADMIN_GRANT 审计用） |
| `/pay/products` | SKU 商品只读（改价走 app-pay 运营流程） |
| `/pay/grants` | 补偿开通（admin）：表单 + 结果 Descriptions + 最近 ADMIN_GRANT；日额度超限 429 透传 |
| `/pay/refunds` | 退款复核（admin）：状态筛选 + 通过/驳回；未配置（后端 404）显示未配置提示 |
| `/accounts` | 控制台账户（admin）：列表 / 新建 / 重置密码 / 删除（不能删自己/最后一个 admin）；viewer 显示 403 且不发请求 |
| `/audit` | 审计日志倒序；操作下拉筛选 + 管理员筛选；操作中文标签、详情按动作格式化（审核/预览/登录改密/补偿开通/退款复核/账户动作）；「分享 #ID」跳转 `/shares?share=ID` 自动打开详情抽屉 |

## 请求层与红线

- **唯一请求层** `src/api/client.ts`（cookie 携带、`{detail}` 错误透传、401 清态踢回 `/login`）；组件禁止直接 `fetch`。
- **设备指纹**：`src/device.ts` 在 localStorage 生成并持久化 `X-Device-Id`，所有请求自动携带；后端将会话绑定到设备指纹 + IP，清浏览器存储/换设备/IP 异常需要重新登录。
- 按域拆分：`src/api/pay.ts`（支付，uid 一律 string、金额整数分）、`src/api/accounts.ts`（控制台账户）、`src/api/types.ts`（分享/用户/审计）。
- 任何页面不出现文件下载/内容导出能力；表格只展示名称/大小等元数据。
- 不直连 MinIO；登录态仅依赖 HttpOnly session cookie，前端不落 token 存储。
- 受控内容预览（Issue #154）：仅 admin 角色 + 分享范围；**审核员可查看任意分享内容**（含撤销/过期/banned/历史未确认《管理员内容审核告知》的分享）。图片/音视频/PDF 经 UI Nginx 同源 `/minio-proxy/` 内联展示（PDF iframe SAMEORIGIN）；docx/xlsx/pptx/html/md/txt 由后端提取纯文本展示；**无下载按钮、无 URL 复制**；每次预览后端落审计。
- 支付域资金写边界：本前端只调用 app-admin API；补偿开通是唯一可直写 `app_pay` 的操作，退款复核经 app-pay internal 端点执行，前端不做任何本地状态替代。
