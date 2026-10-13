import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/auth.dart';
import '../api/chat.dart';
import '../api/client.dart';
import '../api/cloud.dart';
import '../api/favorites.dart';
import '../api/knowledge.dart';
import '../api/notes.dart';
import '../api/pay.dart';
import '../api/preferences.dart';
import '../api/quiz.dart';
import '../api/task_quiz.dart';
import '../api/user.dart';
import 'auth/unauthorized_signal.dart';
import 'config/app_config.dart';
import 'storage/token_store.dart';

/// Riverpod 组合根：全部基础设施装配集中在此，业务代码经 ref 读取。
/// 新增基础设施 / API 域：在这里注册，不要在页面里 new。

/// 由 main.dart overrideWithValue 注入（需等 platform channel 就绪）。
final sharedPrefsProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError('sharedPrefsProvider must be overridden in main'),
);

/// 外观主题（本地持久化：system / light / dark）。
final themeModeProvider = StateProvider<ThemeMode>((ref) {
  final raw = ref.read(sharedPrefsProvider).getString('theme_mode');
  switch (raw) {
    case 'light':
      return ThemeMode.light;
    case 'dark':
      return ThemeMode.dark;
    default:
      return ThemeMode.system;
  }
});

Future<void> setThemeMode(SharedPreferences prefs, ThemeMode mode) {
  final name = switch (mode) {
    ThemeMode.light => 'light',
    ThemeMode.dark => 'dark',
    _ => 'system',
  };
  return prefs.setString('theme_mode', name);
}

final appConfigProvider = Provider<AppConfig>(
  (ref) => AppConfig(ref.read(sharedPrefsProvider)),
);

final tokenStoreProvider = Provider<TokenStore>(
  (ref) => TokenStore(prefs: ref.read(sharedPrefsProvider)),
);

final unauthorizedSignalProvider = Provider<UnauthorizedSignal>((ref) {
  final signal = UnauthorizedSignal();
  ref.onDispose(signal.dispose);
  return signal;
});

/// 唯一网络出口。dio 实例不持有可变地址：每次请求经 AppConfig.url() 读当前值，
/// 服务器地址修改后立即生效，无需重建。
final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    config: ref.watch(appConfigProvider),
    tokens: ref.read(tokenStoreProvider),
    onUnauthorized: () => ref.read(unauthorizedSignalProvider).fire(),
  );
});

// ---- API 域（新增域在此注册）----
final authApiProvider = Provider<AuthApi>((ref) => AuthApi(ref.read(apiClientProvider)));
final chatApiProvider = Provider<ChatApi>((ref) => ChatApi(ref.read(apiClientProvider)));
final favoritesApiProvider = Provider<FavoritesApi>((ref) => FavoritesApi(ref.read(apiClientProvider)));
final knowledgeApiProvider = Provider<KnowledgeApi>((ref) => KnowledgeApi(ref.read(apiClientProvider)));
final notesApiProvider = Provider<NotesApi>((ref) => NotesApi(ref.read(apiClientProvider)));
final userApiProvider = Provider<UserApi>((ref) => UserApi(ref.read(apiClientProvider)));
final preferencesApiProvider = Provider<PreferencesApi>((ref) => PreferencesApi(ref.read(apiClientProvider)));
final cloudApiProvider = Provider<CloudApi>((ref) => CloudApi(ref.read(apiClientProvider)));
final payApiProvider = Provider<PayApi>((ref) => PayApi(ref.read(apiClientProvider)));
final quizApiProvider = Provider<QuizApi>((ref) => QuizApi(ref.read(apiClientProvider)));
final taskQuizApiProvider = Provider<TaskQuizApi>((ref) => TaskQuizApi(ref.read(apiClientProvider)));
