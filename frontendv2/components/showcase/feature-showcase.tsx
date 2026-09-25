"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { ShowcaseSection, type ShowcaseCta } from "./showcase-section";
import { DemoChat } from "./demo-chat";
import { DemoPipeline } from "./demo-pipeline";
import { DemoMindmap } from "./demo-mindmap";
import { DemoQuiz } from "./demo-quiz";
import { DemoCloud } from "./demo-cloud";
import { DemoGraph } from "./demo-graph";

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

const revealItem = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_APPLE } },
};

interface FeatureShowcaseProps {
  /** Authed CTAs link to feature pages; anonymous CTAs open the login modal. */
  authed?: boolean;
  onShowQRLogin?: () => void;
}

/**
 * The four alternating Apple-style showcase bands (copy ⇄ animated demo)
 * plus the closing CTA. Shared by the anonymous landing and the logged-in
 * dashboard homepage; only the CTAs differ.
 */
export function FeatureShowcase({ authed = false, onShowQRLogin }: FeatureShowcaseProps) {
  // Anonymous CTAs open the login modal; skip CTA entirely if no handler.
  const cta = (label: string, href: string): ShowcaseCta | undefined => {
    if (authed) return { label, href };
    return onShowQRLogin ? { label, onClick: onShowQRLogin } : undefined;
  };

  return (
    <div className="w-full">
      <ShowcaseSection
        eyebrow="智能问答"
        title={
          <>
            问你的收藏夹，像问一位
            <br className="hidden md:block" />
            看过所有视频的朋友
          </>
        }
        description="MindBase 把视频转写成文本并建立语义索引。直接提问，回答流式生成、思考过程透明，每一条都有出处。"
        bullets={[
          "深度思考与检索步骤可展开查看",
          "回答附引用来源，一键跳转原视频时间点",
          "自动聚合多个视频，给出综合答案",
        ]}
        visual={<DemoChat />}
        tone="light"
        cta={cta("开始提问", "/chat")}
      />

      <ShowcaseSection
        eyebrow="知识库构建"
        title="一键把整个收藏夹，变成可检索的知识库"
        description="同步 B站收藏夹后自动下载音频、语音转写、语义分块并向量化入库。收藏不再吃灰，变成随取随用的第二大脑。"
        bullets={[
          "接入 B站收藏夹，防误删的可靠同步",
          "语音转写全文入库，官方字幕优先",
          "语义分块 + 向量索引，按含义而非关键词检索",
        ]}
        visual={<DemoPipeline />}
        flip
        tone="gray"
        cta={cta("去同步收藏夹", "/favorites")}
      />

      <ShowcaseSection
        eyebrow="整理与组织"
        title="笔记与思维导图，让知识自己长成树"
        description="AI 把视频要点整理成结构化笔记；对话里一句话，结论就能沉淀成导图节点，在画布上继续追问、补全。"
        bullets={[
          "对话 / 云盘文档一键整理成笔记",
          "板聊建议以幽灵节点插入导图，Tab 确认即保存",
          "修订历史、锚点与公开分享链接",
        ]}
        visual={<DemoMindmap />}
        tone="light"
        cta={cta("去整理笔记", "/notes")}
      />

      <ShowcaseSection
        eyebrow="练习与回顾"
        title="AI 出题检验，定时提醒，形成记忆闭环"
        description="根据知识库内容自动出题、自动批改；设定定时任务到点推送，答题结果反哺你的知识盲区地图。"
        bullets={[
          "按已学内容智能出题，逐题批改",
          "定时出题：到点自动执行并提醒",
          "知识盲区追踪，弱项看得见",
        ]}
        visual={<DemoQuiz />}
        flip
        tone="gray"
        cta={cta("去练习", "/quiz")}
      />

      <ShowcaseSection
        eyebrow="云端文档"
        title="文档和视频，收进同一个知识库"
        description="上传到云盘的 PDF / Word / Markdown 自动解析入库，音频文件自动转写。所有知识与 B站收藏在同一处语义检索。"
        bullets={[
          "PDF / Word / Markdown 自动解析入库",
          "音频文件自动语音转写",
          "与收藏视频共用同一套语义检索",
        ]}
        visual={<DemoCloud />}
        tone="light"
        cta={cta("打开云盘", "/cloud-drive")}
      />

      <ShowcaseSection
        eyebrow="知识图谱"
        title="知识连成网络，盲区一眼看穿"
        description="已学的知识点自动关联成图；哪些概念掌握扎实、哪些还是空白，图谱和盲区地图直接告诉你，学习路线不再靠感觉。"
        bullets={[
          "知识点自动关联，可视化浏览",
          "结合测验结果标记知识盲区",
          "按图索骥，规划下一步学什么",
        ]}
        visual={<DemoGraph />}
        flip
        tone="gray"
        cta={cta("查看知识图谱", "/graph")}
      />

      {/* Closing CTA band */}
      <div className="bg-surface">
        <motion.div
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.09 } } }}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="mx-auto flex w-full max-w-[720px] flex-col items-center px-6 py-24 text-center md:py-32"
        >
          <motion.h2
            variants={revealItem}
            className="display-hero text-[30px] text-foreground md:text-[44px]"
          >
            把<span className="text-gradient-ink">「收藏」</span>
            变成知识，从今天开始
          </motion.h2>
          <motion.p variants={revealItem} className="mt-4 max-w-[440px] text-[15px] leading-relaxed text-secondary md:text-[17px]">
            同步一个收藏夹只要几分钟，之后每一次提问、每一份笔记、每一场测验，都在为你的知识库添砖加瓦。
          </motion.p>
          <motion.div variants={revealItem} className="mt-8">
            {authed ? (
              <Link href="/chat" className="btn-pill btn-primary inline-flex h-11 items-center gap-1.5 px-7 text-[15px]">
                进入对话
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            ) : (
              onShowQRLogin && (
                <button onClick={onShowQRLogin} className="btn-pill btn-primary h-11 px-7 text-[15px]">
                  扫码登录开始构建
                </button>
              )
            )}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
