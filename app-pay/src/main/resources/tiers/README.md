# tiers/

会员档位介绍 Markdown（FREE.md / VIP.md / SVIP.md）。

- 由 app-pay 启动时从 classpath 加载（TierCatalogService），经 `GET /pay/tiers` 下发。
- 修改文案后需重新构建 app-pay 镜像并重启生效。
- 权益口径与各消费方的档位化配额保持一致：app-cloud `quota.*`、app-ts `scheduling.tierWeights`、主应用 quiz 每日配额。
