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
                        List.of("收藏同步与知识库构建", "AI 问答每日 30 条（前 15 条全量，其余省流）", "每日出题 3 批 / 批改 20 次", "定时出题任务 2 个", "云盘 10GiB"),
                        "tiers/FREE.md"),
                new Def("VIP", "VIP 会员", "更高配额，会员队列",
                        List.of("AI 问答每日 100 条 + 会员加权队列", "每日出题 20 批 / 批改 100 次", "定时出题任务 10 个", "云盘 100GiB", "专属 VIP 标识"),
                        "tiers/VIP.md"),
                new Def("SVIP", "SVIP 超级会员", "全部权益拉满",
                        List.of("AI 问答每日 300 条 + 最高优先级队列", "每日出题 60 批 / 批改 300 次", "定时出题任务 30 个", "云盘 1TiB", "专属标识 + 新功能优先体验"),
                        "tiers/SVIP.md"));

        for (Def d : defs) {
            tiers.add(new TierView(d.tier(), d.name(), d.tagline(), d.benefits(), readClasspathText(d.mdPath())));
        }

        comparison.add(new ComparisonRow("收藏夹同步与知识库构建", "✓", "✓", "✓"));
        comparison.add(new ComparisonRow("AI 问答与知识库检索", "✓", "✓", "✓"));
        comparison.add(new ComparisonRow("AI 问答（每日）", "30 条", "100 条", "300 条"));
        comparison.add(new ComparisonRow("AI 对话调度队列", "标准队列", "会员加权队列", "最高优先级队列"));
        comparison.add(new ComparisonRow("每日出题（批）", "3", "20", "60"));
        comparison.add(new ComparisonRow("每日批改（次）", "20", "100", "300"));
        comparison.add(new ComparisonRow("定时出题任务", "2 个", "10 个", "30 个"));
        comparison.add(new ComparisonRow("云盘存储容量", "10GiB", "100GiB", "1TiB"));
        comparison.add(new ComparisonRow("会员标识", "—", "✓", "✓"));
        comparison.add(new ComparisonRow("新功能优先体验", "—", "—", "✓"));

        log.info("[PAY] tier catalog loaded: {} tiers, {} comparison rows", tiers.size(), comparison.size());
    }

    /** 全部档位简介（顺序即展示顺序：FREE → VIP → SVIP）。 */
    public List<TierView> list() {
        return List.copyOf(tiers);
    }

    /** 权益对照表（行 = 能力，列 = 三档）。 */
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
