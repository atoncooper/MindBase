import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:app_mobile/api/client.dart';
import 'package:app_mobile/api/notes.dart';
import 'package:app_mobile/core/config/app_config.dart';
import 'package:app_mobile/core/storage/token_store.dart';
import 'package:app_mobile/core/di.dart';
import 'package:app_mobile/core/theme/app_theme.dart';
import 'package:app_mobile/features/notes/notes_list_page.dart';

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

class _FakeNotesApi extends NotesApi {
  _FakeNotesApi(super.client);
  @override
  Future<({List<NoteMeta> items, int total})> list({
    String? targetType, String? targetId, int page = 1, int pageSize = 20,
  }) async => (
    items: [
      NoteMeta(uuid: 'n1', title: 'RAG 检索链路调研笔记', targetType: 'video', targetId: 'BV1', contentLength: 2450, isPinned: true, revisionCount: 4, createdAt: '2026-10-10T10:00:00', updatedAt: '2026-10-13T10:00:00'),
      NoteMeta(uuid: 'n2', title: 'Impeller 渲染管线学习摘要', targetType: 'video', targetId: 'BV1', contentLength: 1180, isPinned: false, revisionCount: 2, createdAt: '2026-10-11T10:00:00', updatedAt: '2026-10-12T18:30:00'),
      NoteMeta(uuid: 'n3', title: '', targetType: 'cloud_file', targetId: 'f1', contentLength: 320, isPinned: false, revisionCount: 0, createdAt: '2026-10-09T10:00:00', updatedAt: '2026-10-09T12:00:00'),
    ],
    total: 3,
  );
}

/// 笔记列表视觉金样：20 圆角卡片（对齐全局 CardTheme）+ 置顶图钉 + 全 MiSans。
/// 若 diff：先确认是设计变更（重新 --update-goldens）还是组件主题样式回退
/// （手写 TextStyle 断掉家族继承链，见 test/font_render_test.dart 的守护）。
void main() {
  testWidgets('NotesListPage renders theme cards in MiSans', (tester) async {
    tester.view.devicePixelRatio = 2.0;
    tester.view.physicalSize = const Size(824, 1400);
    addTearDown(tester.view.reset);
    await tester.runAsync(_loadMiSans);
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        sharedPrefsProvider.overrideWithValue(prefs),
        notesApiProvider.overrideWithValue(_FakeNotesApi(ApiClient(
          config: AppConfig(prefs),
          tokens: TokenStore(secure: FlutterSecureStorage(), prefs: prefs),
          onUnauthorized: () {},
        ))),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        home: const NotesListPage(),
      ),
    ));
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/notes_list.png'));
  });
}