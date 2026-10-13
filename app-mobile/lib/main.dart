import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/debug/font_probe.dart';
import 'core/di.dart';

/// 入口：等 SharedPreferences（platform channel）就绪后注入组合根。
/// token 不在这里读 —— 只由 TokenStore（安全存储）管理。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 字体解析探针：debug/profile 下注册 ext.app.fontProbe（release 恒为 no-op）。
  registerFontProbeExtension();
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: [sharedPrefsProvider.overrideWithValue(prefs)],
      child: const MindBaseApp(),
    ),
  );
}
