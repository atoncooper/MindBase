import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:app_mobile/api/auth.dart';
import 'package:app_mobile/api/chat.dart';
import 'package:app_mobile/core/auth/auth_controller.dart';
import 'package:app_mobile/core/di.dart';
import 'package:app_mobile/core/theme/app_theme.dart';
import 'package:app_mobile/features/chat/chat_controllers.dart';
import 'package:app_mobile/features/chat/chat_drawer.dart';

Future<void> _loadMiSans() async {
  final files = <int, String>{
    400: 'assets/fonts/MiSans-Regular.ttf',
    500: 'assets/fonts/MiSans-Medium.ttf',
    600: 'assets/fonts/MiSans-Demibold.ttf',
    700: 'assets/fonts/MiSans-Bold.ttf',
  };
  final loader = FontLoader('MiSans');
  for (final e in files.entries) {
    loader.addFont(Future.value(await rootBundle.load(e.value)));
  }
  await loader.load();
}

class _FakeSessions extends ChatSessionsNotifier {
  @override
  Future<List<ChatSession>> build() async => [
    ChatSession(chatSessionId: 's1', title: '帮我总结这个视频的要点', status: 'completed', createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:05:00Z'),
    ChatSession(chatSessionId: 's2', title: '🚀 RAG 系统架构讨论', status: 'completed', createdAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T09:10:00Z'),
    ChatSession(chatSessionId: 's3', title: 'bilibili 收藏夹整理方案', status: 'completed', createdAt: '2026-10-12T15:00:00Z', updatedAt: '2026-10-12T15:30:00Z'),
    ChatSession(chatSessionId: 's4', title: 'Weekly report 翻译与润色', status: 'completed', createdAt: '2026-10-10T11:00:00Z', updatedAt: '2026-10-10T11:20:00Z'),
    ChatSession(chatSessionId: 's5', title: '会员支付联调排期（SVIP 权益）', status: 'completed', createdAt: '2026-10-08T11:00:00Z', updatedAt: '2026-10-08T11:20:00Z'),
  ];
  @override
  Future<void> refresh() async {}
}

class _FakeAuth extends AuthController {
  @override
  AuthState build() => AuthState(
      phase: AuthPhase.loggedIn,
      user: UserInfo(uid: 1, nickname: '锐哥就是锐哥🌟'));
}

/// 侧边栏字体守护金样：抽屉内所有文字（会话标题/功能入口/用户页脚）必须与
/// 全 app 同族渲染。历史 bug：ListTileThemeData 等组件主题的 TextStyle 被组件
/// 整体替换环境样式（不做合并），手写样式断掉 MiSans 继承链 → ListTile 文字
/// 掉进系统默认字体，侧边栏内混排"歪歪扭扭/不统一"。
/// 修复后本金样锁定整栏 MiSans 观感；若金样 diff，先查组件主题样式是否漏派生。
void main() {
  testWidgets('ChatDrawer renders entirely in MiSans', (tester) async {
    tester.view.devicePixelRatio = 2.0;
    tester.view.physicalSize = const Size(640, 1400);
    addTearDown(tester.view.reset);
    await tester.runAsync(_loadMiSans);
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    await tester.pumpWidget(ProviderScope(
      overrides: [
        sharedPrefsProvider.overrideWithValue(prefs),
        chatSessionsProvider.overrideWith(_FakeSessions.new),
        authControllerProvider.overrideWith(_FakeAuth.new),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        home: const Scaffold(
          body: Row(
            children: [
              // Align 提供松约束：ChatDrawer 内 Drawer(width:) 的
              // BoxConstraints.expand 才会生效（紧约束下会被父级 tight 宽度覆盖）。
              Align(
                alignment: Alignment.topLeft,
                child: ChatDrawer(),
              ),
              Expanded(child: ColoredBox(color: Colors.blueGrey)),
            ],
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle(const Duration(milliseconds: 300));

    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_drawer.png'));
  });
}