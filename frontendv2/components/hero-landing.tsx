"use client";

import { motion } from "framer-motion";
import { AnimatedVisual } from "./animated-visual";
import { FeatureShowcase } from "./showcase/feature-showcase";

interface HeroLandingProps {
  onShowQRLogin: () => void;
  onShowPasswordLogin: () => void;
  onShowRegister: () => void;
  onShowDemo: () => void;
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};
const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.28, 0.11, 0.32, 1] as const } },
};

export function HeroLanding({ onShowQRLogin, onShowPasswordLogin, onShowRegister, onShowDemo }: HeroLandingProps) {
  return (
    <section className="relative flex flex-1 flex-col">
      {/* Animated visual sits behind/around the hero copy */}
      <div className="absolute inset-x-0 top-0">
        <AnimatedVisual />
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="relative mx-auto flex w-full max-w-[820px] flex-col items-center px-6 pb-20 pt-20 text-center md:pb-28 md:pt-28"
      >
        <motion.span
          variants={item}
          className="mb-5 rounded-full border border-border bg-surface/60 px-3.5 py-1 text-[12px] text-secondary backdrop-blur"
        >
          让你的 B站收藏夹不再吃灰
        </motion.span>

        <motion.h1
          variants={item}
          className="display-hero max-w-[680px] text-[40px] text-foreground md:text-[64px]"
        >
          把<span className="text-gradient-ink">「收藏」</span>
          <br className="hidden md:block" />
          变成真正可用的知识
        </motion.h1>

        <motion.p
          variants={item}
          className="mt-6 max-w-[560px] text-[17px] leading-relaxed text-secondary md:text-[19px]"
        >
          很多人收藏了大量学习视频，却迟迟没看、没整理、也找不到重点。
          MindBase 把碎片化内容接入 AI：自动提炼、语义检索、对话式回顾，
          让收藏真正提升效率。
        </motion.p>

        <motion.div variants={item} className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <button onClick={onShowQRLogin} className="btn-pill btn-primary h-11 px-7 text-[15px]">
            扫码登录开始构建
          </button>
          <button onClick={onShowPasswordLogin} className="btn-pill btn-ghost h-11 px-6 text-[15px]">
            账号登录
          </button>
          <button onClick={onShowRegister} className="btn-pill btn-ghost h-11 px-6 text-[15px]">
            注册
          </button>
          <button onClick={onShowDemo} className="btn-pill btn-ghost h-11 px-6 text-[15px]">
            体验检索流程
          </button>
        </motion.div>
      </motion.div>

      {/* Alternating feature showcase bands (copy ⇄ animated demo) + closing CTA */}
      <FeatureShowcase authed={false} onShowQRLogin={onShowQRLogin} />
    </section>
  );
}
