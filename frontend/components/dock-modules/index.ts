import { BarChart3, BookOpen, Cloud, FolderHeart, MessageCircle, MessageSquareText, Settings, User, Activity } from "lucide-react";
import { DockModule } from "@/lib/dock-registry";
import ChatDockPanel from "@/components/chat/ChatDockPanel";
import FavoritesPanel from "./favorites";
import ChatHistoryPanel from "./chat-history";
import SettingsPanel from "./settings";
import AccountPanel from "./account";
import TasksPanel from "./tasks";
import BillingPanel from "./billing";
import QuizPanel from "./quiz";
import CloudDrivePanel from "./cloud-drive";

export const dockModules: DockModule[] = [
  {
    id: "chat",
    icon: MessageCircle,
    title: "对话",
    panel: ChatDockPanel,
    defaultSize: { width: 1156, height: 680 },
  },
  {
    id: "chat-history",
    icon: MessageSquareText,
    title: "历史会话",
    panel: ChatHistoryPanel,
    defaultSize: { width: 640, height: 520 },
  },
  {
    id: "quiz",
    icon: BookOpen,
    title: "题目练习",
    panel: QuizPanel,
    defaultSize: { width: 720, height: 700 },
  },
  {
    id: "favorites",
    icon: FolderHeart,
    title: "收藏夹",
    panel: FavoritesPanel,
    defaultSize: { width: 880, height: 680 },
  },
  {
    id: "cloud-drive",
    icon: Cloud,
    title: "云盘",
    panel: CloudDrivePanel,
    defaultSize: { width: 900, height: 640 },
  },
  {
    id: "settings",
    icon: Settings,
    title: "API 设置",
    panel: SettingsPanel,
    defaultSize: { width: 1296, height: 806 },
  },
  {
    id: "account",
    icon: User,
    title: "个人中心",
    panel: AccountPanel,
    defaultSize: { width: 660, height: 740 },
  },
  {
    id: "tasks",
    icon: Activity,
    title: "任务监控",
    panel: TasksPanel,
    defaultSize: { width: 520, height: 560 },
  },
  {
    id: "billing",
    icon: BarChart3,
    title: "用量计费",
    panel: BillingPanel,
    defaultSize: { width: 1156, height: 672 },
  },
];
