import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/di.dart';
import '../pay/tier_badge.dart';

/// 「我的」= 设置中心（卡片分组）：用户 / 功能 / 外观 / 账号与安全 / 服务器 / 关于。
class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  Future<void> _logout(BuildContext context, WidgetRef ref, bool all) async {
    HapticFeedback.mediumImpact();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(all ? '登出全部设备' : '登出当前设备'),
        content: Text(all ? '将吊销所有已登录设备的会话。' : '仅登出本设备。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('登出')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    HapticFeedback.mediumImpact();
    // controller 内本地凭据即时清理（状态先切），这里显式 go 登录页；
    // 服务端吊销由 controller 异步尽力而为
    unawaited(all
        ? ref.read(authControllerProvider.notifier).logoutAll()
        : ref.read(authControllerProvider.notifier).logoutCurrent());
    context.go('/login');
  }

  Future<void> _pickThemeMode(BuildContext context, WidgetRef ref) async {
    HapticFeedback.selectionClick();
    final current = ref.read(themeModeProvider);
    final picked = await showDialog<ThemeMode>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('外观主题'),
        children: [
          RadioGroup<ThemeMode>(
            groupValue: current,
            onChanged: (v) => Navigator.pop(ctx, v),
            child: Column(
              children: [
                for (final (mode, label, icon) in const [
                  (ThemeMode.system, '跟随系统', Icons.brightness_auto),
                  (ThemeMode.light, '浅色', Icons.light_mode_outlined),
                  (ThemeMode.dark, '深色', Icons.dark_mode_outlined),
                ])
                  RadioListTile<ThemeMode>(
                    value: mode,
                    title: Row(
                      children: [
                        Icon(icon, size: 18),
                        const SizedBox(width: 8),
                        Text(label),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
    if (picked == null || picked == current) return;
    HapticFeedback.selectionClick();
    await setThemeMode(ref.read(sharedPrefsProvider), picked);
    ref.read(themeModeProvider.notifier).state = picked;
  }

  Future<void> _clearImageCache(BuildContext context) async {
    HapticFeedback.selectionClick();
    PaintingBinding.instance.imageCache.clear();
    PaintingBinding.instance.imageCache.clearLiveImages();
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('图片缓存已清除')));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final user = auth.user;
    final avatar = user?.avatarUrl;
    final themeMode = ref.watch(themeModeProvider);
    final config = ref.read(appConfigProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: [
          // ---- 用户 ----
          Card(
            margin: const EdgeInsets.symmetric(vertical: 4),
            child: ListTile(
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              leading: avatar != null && avatar.isNotEmpty
                  ? CircleAvatar(
                      radius: 22,
                      backgroundImage: NetworkImage(
                        ref
                            .read(appConfigProvider)
                            .resolveAssetUrl(avatar),
                      ),
                      onBackgroundImageError: (_, __) {},
                    )
                  : const CircleAvatar(
                      radius: 22, child: Icon(Icons.person, size: 26)),
              title: Row(
                children: [
                  Text(user?.displayName ?? '未登录',
                      style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  const TierBadge(),
                ],
              ),
              subtitle: Text(
                user?.uid != null ? 'UID ${user!.uid} · 点按编辑资料' : '-',
                style: const TextStyle(fontSize: 12.5),
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push('/me/profile'),
            ),
          ),
          // ---- 功能 ----
          _section(context, '功能'),
          _card([
            _NavTile(icon: Icons.forum_outlined, title: '聊天', route: '/'),
            _tileDivider(),
            _NavTile(
                icon: Icons.video_library_outlined,
                title: '收藏夹',
                route: '/favorites'),
            _tileDivider(),
            _NavTile(
                icon: Icons.sticky_note_2_outlined, title: '笔记', route: '/notes'),
            _tileDivider(),
            _NavTile(icon: Icons.folder_outlined, title: '云盘', route: '/cloud'),
            _tileDivider(),
            _NavTile(icon: Icons.quiz_outlined, title: '测验', route: '/quiz'),
            _tileDivider(),
            _NavTile(
                icon: Icons.alarm_outlined, title: '定时测验', route: '/task-quiz'),
            _tileDivider(),
            _NavTile(
                icon: Icons.card_membership_outlined,
                title: '会员中心',
                route: '/membership'),
          ]),
          // ---- 外观 ----
          _section(context, '外观'),
          _card([
            ListTile(
              leading: const Icon(Icons.palette_outlined),
              title: const Text('外观主题'),
              subtitle: Text(
                switch (themeMode) {
                  ThemeMode.light => '浅色',
                  ThemeMode.dark => '深色',
                  _ => '跟随系统',
                },
                style: const TextStyle(fontSize: 12.5),
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _pickThemeMode(context, ref),
            ),
            _tileDivider(),
            ListTile(
              leading: const Icon(Icons.image_not_supported_outlined),
              title: const Text('清除图片缓存'),
              subtitle: const Text('头像 / 会话图片加载异常时可尝试',
                  style: TextStyle(fontSize: 12.5)),
              onTap: () => _clearImageCache(context),
            ),
          ]),
          // ---- 账号与安全 ----
          _section(context, '账号与安全'),
          _card([
            ListTile(
              leading: const Icon(Icons.person_outline),
              title: const Text('个人资料'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push('/me/profile'),
            ),
            _tileDivider(),
            ListTile(
              leading: const Icon(Icons.security_outlined),
              title: const Text('账号与安全'),
              subtitle: const Text('B站绑定 / 修改密码',
                  style: TextStyle(fontSize: 12.5)),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push('/me/security'),
            ),
            _tileDivider(),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('登出当前设备'),
              onTap: () => _logout(context, ref, false),
            ),
            _tileDivider(),
            ListTile(
              leading: const Icon(Icons.clear_all),
              title: const Text('登出全部设备'),
              onTap: () => _logout(context, ref, true),
            ),
          ]),
          // ---- 服务器 ----
          _section(context, '服务器'),
          _card([
            ListTile(
              leading: const Icon(Icons.dns),
              title: const Text('服务器配置'),
              subtitle: Text(config.effectiveBase ?? '未配置',
                  style: const TextStyle(fontSize: 12.5)),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push('/setup'),
            ),
            if (kDebugMode) ...[
              _tileDivider(),
              SwitchListTile(
                secondary: const Icon(Icons.security),
                title: const Text('允许自签证书（仅调试）'),
                subtitle: const Text('release 构建强制关闭',
                    style: TextStyle(fontSize: 12.5)),
                value: config.allowSelfSignedDebug,
                onChanged: (v) async {
                  await ref
                      .read(appConfigProvider)
                      .setAllowSelfSignedDebug(v);
                },
              ),
            ],
          ]),
          // ---- 关于 ----
          _section(context, '关于'),
          _card([
            const ListTile(
              leading: Icon(Icons.info_outline),
              title: Text('版本'),
              subtitle: Text('MindBase 移动端 · 0.1.0',
                  style: TextStyle(fontSize: 12.5)),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _section(BuildContext context, String label) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 14, 8, 4),
      child: Text(
        label,
        style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
            color: Theme.of(context).hintColor),
      ),
    );
  }

  Widget _card(List<Widget> children) {
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: Colors.grey.withValues(alpha: 0.15)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(children: children),
    );
  }

  Widget _tileDivider() =>
      const Divider(height: 1, indent: 16, endIndent: 16);
}

class _NavTile extends StatelessWidget {
  const _NavTile({required this.icon, required this.title, required this.route});

  final IconData icon;
  final String title;
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
      title: Text(title, style: const TextStyle(fontSize: 15)),
      trailing: Icon(
        Icons.chevron_right,
        size: 18,
        color: Theme.of(context).hintColor,
      ),
      onTap: () => context.push(route),
    );
  }
}
