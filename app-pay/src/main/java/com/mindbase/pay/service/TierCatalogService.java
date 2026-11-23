package com.mindbase.pay.service;

import com.mindbase.pay.dto.PayDtos.TierView;
import com.mindbase.pay.dto.PayDtos.ComparisonRow;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 会员档位简介与权益对照 —— 文案唯一维护点（Java 侧）。
 *
 * <p>完整介绍以 Markdown 存放在 classpath:{@code tiers/FREE.md | VIP.md | SVIP.md}，
 * 启动时一次性加载（{@code @PostConstruct}），请求期零 IO；文档缺失直接拒绝启动。
 * 权益口径与各消费方对应：app-cloud quota.*、app-ts scheduling.tierWeights、quiz 每日配额。
 */
@Service
public class TierCatalogService {

    private static final Logger log = LoggerFactory.getLogger(TierCatalogService.class);

    private final List<TierView> tiers = new ArrayList<>();
    private final List<ComparisonRow> comparison = new ArrayList<>();

    @PostConstruct
    void load() {
        record Def(String tier, String name, String tagline, List<String> benefits, String mdPath) {
        }
        List<Def> defs = List.of(
                new Def("FREE", "免费用户", "基础能力全部可用",
                        List.of("收藏同步与知识库构建",
                                "AI 全能力共享标准 token：5 小时 6,000 / 每日 30,000 / 每月 300,000",
                                "约 ¥3 等值用量；不同模型按单价折算抵扣",
                                "定时出题任务 2 个",
                                "云盘 10GiB"),
                        "tiers/FREE.md"),
                new Def("VIP", "VIP 会员", "更高额度，会员队列",
                        List.of("AI 全能力共享标准 token：5 小时 32 万 / 每日 160 万 / 每月 4,800 万",
                                "¥48/月按 10× 权益配置，约 ¥480 等值用量；贵模型扣得更快",
                                "会员加权队列",
                                "定时出题任务 10 个",
                                "云盘 100GiB",
                                "专属 VIP 标识"),
                        "tiers/VIP.md"),
                new Def("SVIP", "SVIP 超级会员", "高用量与最高优先级",
                        List.of("AI 全能力共享标准 token：5 小时 98.6 万 / 每日 493.3 万 / 每月 1.48 亿",
                                "¥148/月按 10× 权益配置，约 ¥1,480 等值用量",
                                "最高优先级队列",
                                "定时出题任务 30 个",
                                "云盘 1TiB",
                                "专属 SVIP 标识 + 新功能优先体验"),
                        "tiers/SVIP.md"),
                new Def("PROMAX", "ProMax 会员", "重度使用，ProMax 专属队列",
                        List.of("AI 全能力共享标准 token：5 小时 165.3 万 / 每日 826.7 万 / 每月 2.48 亿",
                                "¥248/月按 10× 权益配置，约 ¥2,480 等值用量",
                                "ProMax 专属队列",
                                "定时出题任务 60 个",
                                "云盘 2TiB",
                                "专属 ProMax 标识 + 新功能优先体验"),
                        "tiers/PROMAX.md"));

        for (Def d : defs) {
            tiers.add(new TierView(d.tier(), d.name(), d.tagline(), d.benefits(), readClasspathText(d.mdPath())));
        }

        comparison.add(new ComparisonRow("收藏夹同步与知识库构建", "✓", "✓", "✓", "✓"));
        comparison.add(new ComparisonRow("AI 全能力共享 token 池", "✓", "✓", "✓", "✓"));
        comparison.add(new ComparisonRow("标准 token / 5 小时", "6,000", "32 万", "98.6 万", "165.3 万"));
        comparison.add(new ComparisonRow("标准 token / 每日", "3 万", "160 万", "493.3 万", "826.7 万"));
        comparison.add(new ComparisonRow("标准 token / 每月", "30 万", "4,800 万", "1.48 亿", "2.48 亿"));
        comparison.add(new ComparisonRow("年卡累计标准 token（12 个月）", "360 万", "5.76 亿", "17.76 亿", "29.76 亿"));
        comparison.add(new ComparisonRow("年卡累计原始 token（默认模型 5:1）", "≈0.29 亿", "≈46.6 亿", "≈143.6 亿", "≈240.6 亿"));
        comparison.add(new ComparisonRow("用量倍率（相对 VIP）", "—", "1×", "3.08×", "5.17×"));
        comparison.add(new ComparisonRow("等值用量（按 ¥10/百万 token）", "¥3", "¥480", "¥1,480", "¥2,480"));
        comparison.add(new ComparisonRow("模型抵扣", "按单价折算", "按单价折算", "按单价折算", "按单价折算"));
        comparison.add(new ComparisonRow("AI 对话调度队列", "标准队列", "会员加权队列", "最高优先级队列", "ProMax 专属队列"));
        comparison.add(new ComparisonRow("出题 / 批改", "共享 token 池", "共享 token 池", "共享 token 池", "共享 token 池"));
        comparison.add(new ComparisonRow("知识库构建 / 向量化 / OCR", "共享 token 池", "共享 token 池", "共享 token 池", "共享 token 池"));
        comparison.add(new ComparisonRow("定时出题任务", "2 个", "10 个", "30 个", "60 个"));
        comparison.add(new ComparisonRow("云盘存储容量", "10GiB", "100GiB", "1TiB", "2TiB"));
        comparison.add(new ComparisonRow("会员标识", "—", "✓", "✓", "✓"));
        comparison.add(new ComparisonRow("新功能优先体验", "—", "—", "✓", "✓"));

        log.info("[PAY] tier catalog loaded: {} tiers, {} comparison rows", tiers.size(), comparison.size());
    }

    /** 全部档位简介（顺序即展示顺序：FREE → VIP → SVIP → PROMAX）。 */
    public List<TierView> list() {
        return List.copyOf(tiers);
    }

    /** 权益对照表（行 = 能力，列 = 四档）。 */
    public List<ComparisonRow> comparison() {
        return List.copyOf(comparison);
    }

    private String readClasspathText(String path) {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(path)) {
            if (in == null) {
                throw new IllegalStateException("tier markdown missing on classpath: " + path);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("tier markdown unreadable: " + path, e);
        }
    }
}
