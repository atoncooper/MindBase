import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/favorites.dart';
import '../../api/notes.dart';
import '../../features/chat/chat_page.dart';
import '../../features/cloud/cloud_page.dart';
import '../../features/cloud/cloud_trash_page.dart';
import '../../features/favorites/favorites_page.dart';
import '../../features/favorites/folder_videos_page.dart';
import '../../features/login/login_page.dart';
import '../../features/notes/note_edit_page.dart';
import '../../features/notes/note_view_page.dart';
import '../../features/notes/notes_list_page.dart';
import '../../features/pay/membership_page.dart';
import '../../features/quiz/quiz_home_page.dart';
import '../../features/server/server_setup_page.dart';
import '../../features/settings/profile_edit_page.dart';
import '../../features/settings/security_page.dart';
import '../../features/settings/settings_page.dart';
import '../../features/task_quiz/task_quiz_page.dart';
import '../auth/auth_controller.dart';

/// 全局路由 + 认证重定向。
///
/// ChatGPT 式导航：`/` 即聊天主页（抽屉管理会话），无底部 Tab；
/// 收藏/笔记/云盘/测验/会员经抽屉入口进入。
final appRouterProvider = Provider<GoRouter>((ref) {
  // authController 状态变化时触发 go_router 重新执行 redirect
  final refresh = ValueNotifier(0);
  ref.listen(authControllerProvider, (_, __) => refresh.value++);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: '/splash',
    refreshListenable: refresh,
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final path = state.uri.path;
      final atSplash = path == '/splash';
      final atSetup = path == '/setup';
      final atLogin = path == '/login';

      if (auth.phase == AuthPhase.booting) {
        return atSplash ? null : '/splash';
      }
      if (auth.phase == AuthPhase.serverUnconfigured) {
        return atSetup ? null : '/setup';
      }
      if (!auth.isLoggedIn) {
        return atLogin ? null : '/login';
      }
      if (atSplash || atLogin || atSetup) return '/';
      return null;
    },
    routes: [
      GoRoute(
        path: '/splash',
        builder: (_, __) => const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
      ),
      GoRoute(path: '/setup', builder: (_, __) => const ServerSetupPage()),
      GoRoute(path: '/login', builder: (_, __) => const LoginPage()),
      // 聊天主页（抽屉管理会话）
      GoRoute(path: '/', builder: (_, __) => const ChatPage()),
      GoRoute(path: '/favorites', builder: (_, __) => const FavoritesPage()),
      GoRoute(
        path: '/favorites/videos/:mediaId',
        builder: (_, s) {
          final folder =
              s.extra is FavoriteFolder ? s.extra! as FavoriteFolder : null;
          if (folder == null) return const FavoritesPage();
          return FolderVideosPage(folder: folder);
        },
      ),
      GoRoute(path: '/notes', builder: (_, __) => const NotesListPage()),
      GoRoute(
        path: '/notes/:uuid',
        builder: (_, s) => NoteViewPage(uuid: s.pathParameters['uuid']!),
      ),
      GoRoute(
        path: '/notes/:uuid/edit',
        builder: (_, s) {
          final detail = s.extra is NoteDetail ? s.extra! as NoteDetail : null;
          final uuid = s.pathParameters['uuid']!;
          if (detail == null) return NoteViewPage(uuid: uuid);
          return NoteEditPage(detail: detail);
        },
      ),
      GoRoute(path: '/membership', builder: (_, __) => const MembershipPage()),
      GoRoute(path: '/cloud', builder: (_, __) => const CloudPage()),
      GoRoute(
          path: '/cloud/trash', builder: (_, __) => const CloudTrashPage()),
      GoRoute(path: '/quiz', builder: (_, __) => const QuizHomePage()),
      GoRoute(path: '/task-quiz', builder: (_, __) => const TaskQuizPage()),
      GoRoute(path: '/me', builder: (_, __) => const SettingsPage()),
      GoRoute(path: '/me/profile', builder: (_, __) => const ProfileEditPage()),
      GoRoute(path: '/me/security', builder: (_, __) => const SecurityPage()),
    ],
  );
});
