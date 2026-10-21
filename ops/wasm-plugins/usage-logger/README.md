# usage-logger — Higress Wasm 插件（网关侧用量上报，v0）

> 职责与 v0 边界（诚实声明）见 [main.go](main.go) 头部注释：请求头阶段 fire-and-forget 上报
> 归因元数据（x-uid / X-Request-Id / path / model）到主 app `/internal/ai-usage`，
> 与 backend 的 credential_usage 双账本对账；token 级数据由 ai-statistics 指标承接。

## 构建（产物不入库）

Higress Wasm 插件用 TinyGo 编译（产物 `*.wasm` 已 gitignore，不提交二进制）：

```bash
tinygo build -o usage-logger.wasm -scheduler=none -target=wasi ./main.go
```

## 加载

- Higress 控制台（http://127.0.0.1:18081）→ 插件 → 自定义插件上传 wasm，
  或 WasmPlugin CRD 挂载；配置项见 main.go 头部 `配置` 注释。
- 源码改动后必须重新编译并重新上传；仓库内不保存任何 .wasm 构建产物。
