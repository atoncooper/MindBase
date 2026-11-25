# Google OAuth 2.0 登录

> 用户端登录弹窗的「使用 Google 账号登录」按钮。
> 只有配置了 Google Client ID / Secret 后才显示；未配置时为隐藏状态。

## 流程

~~~text
登录弹窗
  → GET /auth/google/options（创建一次性 state）
  → 打开 Google 同意页
  → Google 回调 /oauth/google/callback?code&state
  → 回调页 POST /auth/google/login {code,state}
  → app-user 服务端 exchange code
  → userinfo 校验 sub/name/picture
  → EnsureUserFromOAuth("google", sub, ...)
  → 返回 session token；回调页 postMessage 给登录弹窗
~~~

- state 存 Redis，10 分钟有效，一次性消费
- code 只在服务端换取 token，不经过前端日志
- session token 只在 popup 的同源 postMessage 中传给父窗口，不进入 URL
- Google 账号首次登录自动创建 MindBase 用户并绑定 user_oauth(provider=google)
- 已登录用户可走 /auth/google/bind 绑定

## Google Cloud 配置

1. Google Cloud Console → APIs & Services → Credentials
2. 创建 OAuth client ID，类型 Web application
3. Authorized JavaScript origins：
   ~~~text
   https://localhost
   ~~~
4. Authorized redirect URIs：
   ~~~text
   https://localhost/oauth/google/callback
   ~~~
5. 把 Client ID / Client Secret 写入 .env：

~~~bash
GOOGLE__ENABLED=true
GOOGLE__CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE__CLIENT_SECRET=xxxx
GOOGLE__REDIRECT_URI=https://localhost/oauth/google/callback
~~~

6. 重启 app-user：

~~~bash
docker compose up -d --no-deps --force-recreate app-user
~~~

7. 验证：

~~~bash
curl -k https://localhost/mindbase/api/v1/auth/features
# google_enabled: true
curl -k https://localhost/mindbase/api/v1/auth/google/options
# enabled: true, url: https://accounts.google.com/...
~~~

## 配置项

| YAML | 环境变量 | 说明 |
|---|---|---|
| auth.google.enabled | GOOGLE__ENABLED | 总开关 |
| auth.google.client_id | GOOGLE__CLIENT_ID | OAuth Web Client ID |
| auth.google.client_secret | GOOGLE__CLIENT_SECRET | OAuth Web Client Secret |
| auth.google.redirect_uri | GOOGLE__REDIRECT_URI | 必须与 Google Console 完全一致 |

## 代码位置

- app-go/app-user/internal/service/auth/google_service.go
- app-go/app-user/internal/router/auth/auth_google.go
- frontendv2/app/oauth/google/callback/page.tsx
- frontendv2/components/login-modal.tsx
