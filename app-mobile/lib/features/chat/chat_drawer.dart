import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/chat.dart';
import '../../core/auth/auth_controller.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../core/error/error_mapper.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/widgets/async_view.dart';
import '../../shared/widgets/gemini_spark.dart';
import '../pay/tier_badge.dart';
import 'chat_controllers.dart';

/// ChatGPT 风格侧边抽屉：
/// 新对话 / 搜索 / 按日期分组的历史会话 / 功能入口 / 用户页脚。
class ChatDrawer extends ConsumerStatefulWidget {
  const ChatDrawer({super.key});

  @override
  ConsumerState<ChatDrawer> createState() => _ChatDrawerState();
}

class _ChatDrawerState extends ConsumerState<ChatDrawer> {
  String _search = '';

  @override
  void initState() {
    super.initState();
    // 抽屉打开时顺带刷新会话列表（尽力而为）
    Future<void>.microtask(() {
      ref.read(chatSessionsProvider.notifier).refresh();
    });
  }

  void _newChat() {
    ref.read(currentSessionProvider.notifier).state = null;
    Navigator.pop(context);
  }

  void _open(ChatSession s) {
    ref.read(currentSessionProvider.notifier).state = s;
    Navigator.pop(context);
  }

  Future<void> _rename(ChatSession s) async {
    final ctrl = TextEditingController(text: s.title ?? '');
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名对话'),
        content: TextField(controller: ctrl, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (title == null || title.isEmpty) return;
    try {
      await ref.read(chatSessionsProvider.notifier).rename(s.chatSessionId, title);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _delete(ChatSession s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除对话'),
        content: Text('确定删除「${s.displayTitle}」及其历史消息？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(chatSessionsProvider.notifier).remove(s.chatSessionId);
      // 删除的是当前会话 → 回到空态
      final current = ref.read(currentSessionProvider);
      if (current?.chatSessionId == s.chatSessionId) {
        ref.read(currentSessionProvider.notifier).state = null;
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  String _groupLabel(DateTime t) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(t.year, t.month, t.day);
    if (day == today) return '今天';
    if (day == today.subtract(const Duration(days: 1))) return '昨天';
    if (now.difference(t).inDays < 7) return '过去 7 天';
    if (now.difference(t).inDays < 30) return '过去 30 天';
    return '更早';
  }

  @override
  Widget build(BuildContext context) {
    final sessionsAsync = ref.watch(chatSessionsProvider);
    final current = ref.watch(currentSessionProvider);
    final auth = ref.watch(authControllerProvider);
    final user = auth.user;
    final avatar = user?.avatarUrl;
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Drawer(
      // 宽度 = 屏幕的 50%（桌面/平板正好半屏）；手机窄屏 50% 不可用 → 下限 280，
      // 超宽视口上限 640 防止失焦。约定见 AGENTS.md「导航」。
      width: (MediaQuery.sizeOf(context).width * 0.5).clamp(280.0, 640.0),
      backgroundColor: isDark ? const Color(0xFF171A20) : const Color(0xFFF7F9FC),
      child: SafeArea(
        child: Column(
          children: [
            // 顶栏：logo + 关闭
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 4, 4),
              child: Row(
                children: [
                  const GeminiSpark(size: 22),
                  const SizedBox(width: 10),
                  const Text('MindBase',
                      style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            // Gemini 风格「新对话」药丸按钮（浅蓝填充 + 主色文字）
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
              child: Material(
                color: isDark
                    ? Theme.of(context)
                        .colorScheme
                        .primary
                        .withValues(alpha: 0.20)
                    : const Color(0xFFD9E6FC),
                borderRadius: BorderRadius.circular(24),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  borderRadius: BorderRadius.circular(24),
                  onTap: _newChat,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 16, vertical: 11),
                    child: Row(
                      children: [
                        Icon(Icons.mode_edit_outline_outlined,
                            size: 19, color: Theme.of(context).colorScheme.primary),
                        const SizedBox(width: 10),
                        Text('新对话',
                            style: TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                                color:
                                    Theme.of(context).colorScheme.primary)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            // 搜索
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
              child: TextField(
                onChanged: (v) => setState(() => _search = v.trim()),
                decoration: InputDecoration(
                  hintText: '搜索对话',
                  hintStyle: TextStyle(
                      fontSize: 13, color: Theme.of(context).hintColor),
                  prefixIcon: const Icon(Icons.search, size: 18),
                  isDense: true,
                  filled: true,
                  fillColor:
                      isDark ? Colors.white.withValues(alpha: 0.06) : Colors.white,
                  contentPadding: const EdgeInsets.symmetric(vertical: 8),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            // 历史会话（按日期分组）
            Expanded(
              child: sessionsAsync.when(
                loading: () =>
                    const Center(child: CircularProgressIndicator(strokeWidth: 2)),
                error: (e, _) => ErrorRetryView(
                  message: describeError(e),
                  onRetry: () =>
                      ref.read(chatSessionsProvider.notifier).refresh(),
                ),
                data: (list) {
                  final kw = _search.toLowerCase();
                  final filtered = kw.isEmpty
                      ? list
                      : list
                          .where((s) =>
                              s.displayTitle.toLowerCase().contains(kw))
                          .toList();
                  if (filtered.isEmpty) {
                    return const Center(
                      child: Text('暂无对话',
                          style: TextStyle(color: Colors.grey, fontSize: 13)),
                    );
                  }
                  final sections = <String, List<ChatSession>>{};
                  final order = <String>[];
                  for (final s in filtered) {
                    final t =
                        DateTime.tryParse(s.lastMessageAt ?? s.updatedAt);
                    final label = t == null ? '更早' : _groupLabel(t);
                    if (!sections.containsKey(label)) {
                      sections[label] = [];
                      order.add(label);
                    }
                    sections[label]!.add(s);
                  }
                  final children = <Widget>[];
                  for (final label in order) {
                    children.add(Padding(
                      padding: const EdgeInsets.fromLTRB(10, 14, 10, 2),
                      child: Text(
                        label,
                        style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: Theme.of(context).hintColor),
                      ),
                    ));
                    for (final s in sections[label]!) {
                      final selected =
                          current?.chatSessionId == s.chatSessionId;
                      children.add(ListTile(
                        dense: true,
                        selected: selected,
                        selectedTileColor: isDark
                            ? Colors.white.withValues(alpha: 0.07)
                            : AppTheme.surfaceTintLight,
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(24)),
                        title: Text(s.displayTitle,
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 15, fontWeight: FontWeight.w500)),
                        trailing: PopupMenuButton<String>(
                          padding: EdgeInsets.zero,
                          onSelected: (v) {
                            if (v == 'rename') _rename(s);
                            if (v == 'delete') _delete(s);
                          },
                          itemBuilder: (_) => const [
                            PopupMenuItem(value: 'rename', child: Text('重命名')),
                            PopupMenuItem(value: 'delete', child: Text('删除')),
                          ],
                        ),
                        onTap: () => _open(s),
                      ));
                    }
                  }
                  return ListView(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      children: children);
                },
              ),
            ),
            const Divider(height: 1),
            // 功能入口
            _FeatureTile(
                icon: Icons.video_library_outlined,
                label: '收藏夹',
                route: '/favorites'),
            _FeatureTile(
                icon: Icons.sticky_note_2_outlined,
                label: '笔记',
                route: '/notes'),
            _FeatureTile(
                icon: Icons.folder_outlined, label: '云盘', route: '/cloud'),
            _FeatureTile(icon: Icons.quiz_outlined, label: '测验', route: '/quiz'),
            _FeatureTile(
                icon: Icons.card_membership_outlined,
                label: '会员中心',
                route: '/membership'),
            const Divider(height: 1),
            // 用户页脚
            ListTile(
              dense: true,
              leading: avatar != null && avatar.isNotEmpty
                  ? CircleAvatar(
                      radius: 14,
                      backgroundImage: NetworkImage(
                        ref
                            .read(appConfigProvider)
                            .resolveAssetUrl(avatar),
                      ),
                      onBackgroundImageError: (_, __) {})
                  : const CircleAvatar(
                      radius: 14, child: Icon(Icons.person_outline, size: 15)),
              title: Text(user?.displayName ?? '未登录',
                  style: const TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w500)),
              subtitle: Text('设置与会员',
                  style: TextStyle(
                      fontSize: 11, color: Theme.of(context).hintColor)),
              trailing: const TierBadge(),
              shape:
                  RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
              // 不关抽屉直接 push：返回时侧边栏保持打开（ChatGPT 式导航），
              // 被推入的页面盖在抽屉之上，pop 后露出的是打开状态的侧边栏。
              onTap: () => context.push('/me'),
            ),
          ],
        ),
      ),
    );
  }
}

class _FeatureTile extends StatelessWidget {
  const _FeatureTile({
    required this.icon,
    required this.label,
    required this.route,
  });

  final IconData icon;
  final String label;
  final String route;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      dense: true,
      leading: Icon(
        icon,
        size: 20,
        color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.72),
      ),
      title: Text(label, style: const TextStyle(fontSize: 15)),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      // 同用户页脚：push 不关抽屉，返回时仍停留在侧边栏。
      onTap: () => context.push(route),
    );
  }
}
