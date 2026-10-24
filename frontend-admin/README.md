# frontend-admin — MindBase 管理后台

独立管理后台前端（**Vite + React 18 + TypeScript + antd v5 + react-router-dom v6**）。
唯一契约：`plan/1.0.16-ShareModeration/1.0.16-ShareModeration.md`（§2 选型偏离记录 / §5 API / §7 本前端契约）。

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
| `/audit` | 审计日志倒序；操作下拉筛选 + 管理员筛选；操作中文标签、详情按动作格式化（原因/预览文件与模式/登录 IP 与客户端/改密）；「分享 #ID」跳转 `/shares?share=ID` 自动打开详情抽屉 |

## 红线（契约 §7）

- 任何页面不出现文件下载/内容导出能力；表格只展示名称/大小等元数据。
- 不直连 MinIO；登录态仅依赖 HttpOnly session cookie，前端不落 token 存储。
- `{detail}` 错误透传；401 统一清态踢回 `/login`。
- 受控内容预览（Issue #154）：仅 admin 角色 + 分享范围；**审核员可查看任意分享内容**（含撤销/过期/banned/历史未确认《管理员内容审核告知》的分享）。图片/音视频/PDF 经 UI Nginx 同源 `/minio-proxy/` 内联展示（PDF iframe SAMEORIGIN）；docx/xlsx/pptx/html/md/txt 由后端提取纯文本展示（xlsx 单元格文本已解码）；**无下载按钮、无 URL 复制**；每次预览后端落审计。用户告知状态仅作展示，不阻断预览。
