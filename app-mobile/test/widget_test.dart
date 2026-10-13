import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:app_mobile/app.dart';
import 'package:app_mobile/core/di.dart';

/// 应用壳冒烟测试：
/// 1. booting 阶段渲染 splash
/// 2. 无服务器配置 → 重定向到服务器配置页
void main() {
  testWidgets('启动 → 未配置服务器 → 进入配置页', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [sharedPrefsProvider.overrideWithValue(prefs)],
        child: const MindBaseApp(),
      ),
    );
    // splash（booting 阶段）
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // bootstrap 判定未配置 → 路由重定向 /setup
    await tester.pump();
    await tester.pump();
    expect(find.text('配置服务器'), findsOneWidget);
  });
}
