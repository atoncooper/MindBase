import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/chat.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';

/// 会话列表状态（权威永远是后端；本地不做增量合并）。
class ChatSessionsNotifier extends AsyncNotifier<List<ChatSession>> {
  @override
  Future<List<ChatSession>> build() => _load();

  /// 拉取会话列表。网关偶发 5xx/HTML 错误页抖动时静默重试一次；
  /// 二次仍失败抛给 provider（抽屉显示重试），不外溢为未处理异常。
  Future<List<ChatSession>> _load() async {
    try {
      return await ref.read(chatApiProvider).listSessions();
    } on ApiException {
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      return ref.read(chatApiProvider).listSessions();
    }
  }

  /// 刷新会话列表。**必须自捕获**：调用点多是 unawaited / 微任务，
  /// 异常外溢会成为 Unhandled Exception（控制台刷屏、debug 闪红屏）。
  /// 已有数据时保持旧列表（下次打开抽屉再试）；无数据落到错误态（抽屉重试）。
  Future<void> refresh() async {
    try {
      state = AsyncData(await _load());
    } on ApiException catch (e, st) {
      if (state.valueOrNull == null) state = AsyncError(e, st);
    } catch (e, st) {
      if (state.valueOrNull == null) {
        state = AsyncError(ApiException(null, '加载会话列表失败'), st);
      }
    }
  }

  Future<void> rename(String chatSessionId, String title) async {
    await ref.read(chatApiProvider).updateSession(chatSessionId, title);
    await refresh();
  }

  Future<void> remove(String chatSessionId) async {
    await ref.read(chatApiProvider).deleteSession(chatSessionId);
    await refresh();
  }
}

final chatSessionsProvider =
    AsyncNotifierProvider<ChatSessionsNotifier, List<ChatSession>>(
        ChatSessionsNotifier.new);

/// 当前打开的会话（null = 新对话空态）。
/// ChatGPT 式导航：主页即聊天，抽屉切换会话直接驱动本状态。
final currentSessionProvider = StateProvider<ChatSession?>((ref) => null);
