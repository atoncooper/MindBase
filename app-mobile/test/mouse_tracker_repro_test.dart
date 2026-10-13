import 'dart:ui';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:app_mobile/api/chat.dart';
import 'package:app_mobile/api/client.dart';
import 'package:app_mobile/api/cloud.dart';
import 'package:app_mobile/api/notes.dart';
import 'package:app_mobile/core/config/app_config.dart';
import 'package:app_mobile/core/di.dart';
import 'package:app_mobile/core/storage/token_store.dart';
import 'package:app_mobile/core/theme/app_theme.dart';
import 'package:app_mobile/features/chat/chat_page.dart';
import 'package:app_mobile/features/notes/note_view_page.dart';
import 'package:app_mobile/features/cloud/cloud_page.dart';
import 'package:app_mobile/features/notes/notes_list_page.dart';

/// 复现 mouse_tracker '!_debugDuringDeviceUpdate' 断言：
/// 测试环境带真实 MouseTracker —— 模拟鼠标整屏扫动 + 点击改过的页面。
/// 全部通过 = 这些页面的悬停/点击路径不会触发该断言。

ApiClient _makeClient(SharedPreferences prefs) => ApiClient(
      // fake 永不触达真实网络；client 只是占位装配
      config: AppConfig(prefs),
      tokens: TokenStore(secure: FlutterSecureStorage(), prefs: prefs),
      onUnauthorized: () {},
    );

class _FakeCloudApi extends CloudApi {
  _FakeCloudApi(super.client);

  @override
  Future<List<CloudFolder>> listFolders() async => [
        CloudFolder(
          id: 1,
          name: '课程资料',
          videoCount: 2,
          children: [
            CloudFolder(id: 2, name: '第一章', videoCount: 0, children: const []),
          ],
        ),
        CloudFolder(id: 3, name: '录像', videoCount: 0, children: const []),
      ];

  @override
  Future<CloudVideoListResponse> listVideos({
    int page = 1,
    int pageSize = 20,
    int? folderId,
  }) async =>
      CloudVideoListResponse(
        videos: [for (var i = 0; i < 3; i++) _video(i)],
        total: 3,
        page: 1,
        pageSize: 20,
        hasMore: false,
      );

  @override
  Future<CloudQuota> getQuota() async =>
      CloudQuota(used: 1024, quota: 102400, tier: 'free', pending: 0);
}

CloudVideoItem _video(int i) => CloudVideoItem(
      uploadUuid: 'u$i',
      originalName: '视频$i.mp4',
      fileSize: 1024 * 1024,
      mimeType: 'video/mp4',
      asrStatus: 'done',
      vectorStatus: 'done',
      createdAt: '2026-01-01T00:00:00',
    );

class _FakeChatApi extends ChatApi {
  _FakeChatApi(super.client);

  @override
  Future<List<ChatSession>> listSessions() async => const [];

  @override
  Future<ChatSession> createSession({String? title}) async => ChatSession(
        chatSessionId: 's1',
        status: 'active',
        createdAt: '',
        updatedAt: '',
      );

  @override
  Future<ChatHistoryResponse> getHistory(
    String chatSessionId, {
    int page = 1,
    int pageSize = 50,
  }) async =>
      ChatHistoryResponse(
          messages: const [], total: 0, page: page, hasMore: false);
}

class _FakeNotesApi extends NotesApi {
  _FakeNotesApi(super.client);

  @override
  Future<NoteDetail> get(String uuid) async => NoteDetail(
        meta: NoteMeta(
          uuid: uuid,
          title: '笔记',
          targetType: 'video',
          targetId: 'BV1',
          contentLength: 10,
          isPinned: false,
          revisionCount: 0,
          createdAt: '2026-01-01T00:00:00',
          updatedAt: '2026-01-01T00:00:00',
        ),
        contentMd: '内容',
        anchors: const [],
      );

  @override
  Future<({List<NoteMeta> items, int total})> list({
    String? targetType,
    String? targetId,
    int page = 1,
    int pageSize = 20,
  }) async => (
        items: [
          for (var i = 0; i < 3; i++)
            NoteMeta(
              uuid: 'n$i',
              title: '笔记$i',
              targetType: 'video',
              targetId: 'BV1',
              contentLength: 100,
              isPinned: i == 0,
              revisionCount: 1,
              createdAt: '2026-01-01T00:00:00',
              updatedAt: '2026-01-01T00:00:00',
            ),
        ],
        total: 3,
      );
}

void main() {
  final collected = <String>[];

  setUp(() {
    collected.clear();
    final original = FlutterError.onError;
    FlutterError.onError = (details) {
      final s = details.exception.toString();
      collected.add(s);
      // mouse_tracker 类断言只记录不抛，避免中断后续交互模拟
      if (s.contains('_debugDuringDeviceUpdate') ||
          s.contains('Cannot hit test a render box')) {
        return;
      }
      original?.call(details);
    };
  });

  bool hasMouseAsserts() => collected
      .any((s) => s.contains('_debugDuringDeviceUpdate') || s.contains('no size'));

  Future<TestGesture> mouse(WidgetTester tester) async {
    final gesture =
        await tester.createGesture(kind: PointerDeviceKind.mouse, pointer: 7);
    await gesture.addPointer(location: Offset.zero);
    addTearDown(gesture.removePointer);
    return gesture;
  }

  Future<void> sweepMouse(WidgetTester tester, TestGesture gesture) async {
    final size = tester.view.physicalSize / tester.view.devicePixelRatio;
    for (var y = 10.0; y < size.height; y += 60) {
      for (var x = 10.0; x < size.width; x += 60) {
        await gesture.moveTo(Offset(x, y));
        await tester.pump();
      }
    }
    // 悬停静止 + 连续空帧（走 post-frame updateAllDevices 路径）
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
  }

  testWidgets('CloudPage: 鼠标扫动 + 目录行/面包屑点击', (tester) async {
    final gesture = await mouse(tester);
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({});
    final client = _makeClient(await SharedPreferences.getInstance());
    await tester.pumpWidget(ProviderScope(
      overrides: [cloudApiProvider.overrideWithValue(_FakeCloudApi(client))],
      child: MaterialApp(theme: AppTheme.light(), home: CloudPage()),
    ));
    await tester.pumpAndSettle();
    await sweepMouse(tester, gesture);

    final folder = find.text('课程资料');
    if (folder.evaluate().isNotEmpty) {
      await tester.tap(folder.first, warnIfMissed: false);
      await tester.pumpAndSettle();
    }
    await sweepMouse(tester, gesture);

    final crumb = find.text('根目录');
    if (crumb.evaluate().isNotEmpty) {
      await tester.tap(crumb.first, warnIfMissed: false);
      await tester.pumpAndSettle();
    }
    await sweepMouse(tester, gesture);

    expect(hasMouseAsserts(), isFalse,
        reason: 'mouse_tracker 断言触发：${collected.take(3).join(' || ')}',
    );
  });

  testWidgets('ChatPage 空态: 鼠标扫动 + 建议卡/新对话点击', (tester) async {
    final gesture = await mouse(tester);
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({});
    final client = _makeClient(await SharedPreferences.getInstance());
    await tester.pumpWidget(ProviderScope(
      overrides: [chatApiProvider.overrideWithValue(_FakeChatApi(client))],
      child: MaterialApp(theme: AppTheme.light(), home: ChatPage()),
    ));
    await tester.pumpAndSettle();
    await sweepMouse(tester, gesture);

    final card = find.text('总结一个视频讲了什么');
    if (card.evaluate().isNotEmpty) {
      await tester.tap(card.first, warnIfMissed: false);
      await tester.pump();
    }
    await sweepMouse(tester, gesture);

    final newChat = find.byTooltip('新对话');
    if (newChat.evaluate().isNotEmpty) {
      await tester.tap(newChat.first, warnIfMissed: false);
      await tester.pumpAndSettle();
    }
    await sweepMouse(tester, gesture);

    expect(hasMouseAsserts(), isFalse,
        reason: 'mouse_tracker 断言触发：${collected.take(3).join(' || ')}',
    );
  });

  testWidgets('NotesListPage: 鼠标扫动 + 卡片点击', (tester) async {
    final gesture = await mouse(tester);
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({});
    final client = _makeClient(await SharedPreferences.getInstance());
    final router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, __) => const NotesListPage()),
        GoRoute(
          path: '/notes/:uuid',
          builder: (_, __) => const NoteViewPage(uuid: 'n0'),
        ),
      ],
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [notesApiProvider.overrideWithValue(_FakeNotesApi(client))],
      child: MaterialApp.router(
        theme: AppTheme.light(),
        routerConfig: router,
      ),
    ));
    await tester.pumpAndSettle();
    await sweepMouse(tester, gesture);

    final card = find.text('笔记0');
    if (card.evaluate().isNotEmpty) {
      await tester.tap(card.first, warnIfMissed: false);
      await tester.pumpAndSettle();
    }
    await sweepMouse(tester, gesture);

    expect(hasMouseAsserts(), isFalse,
        reason: 'mouse_tracker 断言触发：${collected.take(3).join(' || ')}',
    );
  });
}
