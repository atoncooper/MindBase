/**
 * QuizResumeStore — 断点续跑的计划快照（app-ts 生成编排的自有状态，存自有库）。
 *
 * 生成启动时写入"这份卷当初按什么计划在跑"（模式/主题/蓝本 id/目标分布/难度/
 * 个性化指令）；partial 后用户点「继续生成」时读回。注意职责边界：
 *  - 内容记忆（已落库题目）的权威是 app-quiz（checkpoint 行），这里不存题目；
 *  - 这里只存"计划上下文"，让续跑能用原蓝本/原主题重建续写计划；
 *  - 生命周期 = 一次出题任务，finalize 后删除。
 * 老卷（功能上线前创建）无快照 → 读到 null，续跑降级为分布对账（无蓝本 hint）。
 */
export interface QuizResumePlan {
  quizUuid: string;
  uid: string;
  /** 出题模式：free = AI 自由出题；wrong_answers = 错题强化 */
  mode: "free" | "wrong_answers";
  /** 用户主题（free 模式原始输入） */
  topic: string;
  /** 考试蓝本 id（standard/未选 = undefined） */
  style?: string;
  /** 用户自定义出题指令 */
  instructions?: string;
  /** 目标题量（蓝本展开或用户指定） */
  questionCount: number;
  /** 目标题型分布（写入 quiz_sets 的同款） */
  distribution: Record<string, number>;
  difficulty: string;
  createdAt: number;
}

export interface QuizResumeStore {
  save(plan: QuizResumePlan): Promise<void>;
  get(uid: string, quizUuid: string): Promise<QuizResumePlan | null>;
  remove(uid: string, quizUuid: string): Promise<void>;
}
