import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/auth/auth_controller.dart';
import 'core/di.dart';
import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';

/// 应用壳：主题（石墨黑主色，明暗跟随系统）+ 路由 + 启动会话引导。
class MindBaseApp extends ConsumerStatefulWidget {
  const MindBaseApp({super.key});

  @override
  ConsumerState<MindBaseApp> createState() => _MindBaseAppState();
}

class _MindBaseAppState extends ConsumerState<MindBaseApp> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(authControllerProvider.notifier).bootstrap();
    });
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      title: 'MindBase',
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: router,
    );
  }
}
