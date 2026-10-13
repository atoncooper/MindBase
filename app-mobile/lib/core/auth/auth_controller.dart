import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/auth.dart';
import '../error/api_exception.dart';
import '../di.dart';

enum AuthPhase { booting, serverUnconfigured, loggedOut, loggedIn }

class AuthState {
  const AuthState({required this.phase, this.user});

  final AuthPhase phase;
  final UserInfo? user;

  bool get isLoggedIn => phase == AuthPhase.loggedIn;
}

/// 会话状态机：
/// - bootstrap()：启动时校验 token（/auth/me），失败分类处理
/// - onLoginSuccess()：登录成功落 token（TokenStore）并切态
/// - 401 广播（UnauthorizedSignal）→ 强制切未登录（token 已由 api 层清除）
class AuthController extends Notifier<AuthState> {
  StreamSubscription<void>? _sub;

  @override
  AuthState build() {
    final signal = ref.read(unauthorizedSignalProvider);
    _sub = signal.stream.listen((_) {
      state = const AuthState(phase: AuthPhase.loggedOut);
    });
    ref.onDispose(() => _sub?.cancel());
    return const AuthState(phase: AuthPhase.booting);
  }

  Future<void> bootstrap() async {
    final config = ref.read(appConfigProvider);
    if (config.effectiveBase == null) {
      state = const AuthState(phase: AuthPhase.serverUnconfigured);
      return;
    }
    final tokens = ref.read(tokenStoreProvider);
    final token = await tokens.readToken();
    if (token == null) {
      state = const AuthState(phase: AuthPhase.loggedOut);
      return;
    }
    try {
      final me = await ref.read(authApiProvider).getMe();
      await tokens.writeUserCached(me.toCache());
      state = AuthState(phase: AuthPhase.loggedIn, user: me);
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        // token 已由 api 层清除，这里只切状态。
        state = const AuthState(phase: AuthPhase.loggedOut);
      } else {
        // 网络故障不登出：凭 token + 缓存用户进入主界面，请求失败时
        // 由各页面的 friendlyMessage 文案提示（离线不丢会话）。
        final cached = tokens.readUserCached();
        state = AuthState(
          phase: AuthPhase.loggedIn,
          user: cached == null ? null : UserInfo.fromCache(cached),
        );
      }
    }
  }

  Future<void> onLoginSuccess(TokenResponse res) async {
    final tokens = ref.read(tokenStoreProvider);
    await tokens.writeToken(res.sessionToken);
    await tokens.writeUserCached(res.userInfo.toCache());
    state = AuthState(phase: AuthPhase.loggedIn, user: res.userInfo);
  }

  /// 登出当前设备。**本地凭据先清、状态先切**（UI 秒回登录页），
  /// 服务端吊销异步尽力而为 —— 网络再差也不会卡在原地。
  Future<void> logoutCurrent() => _logout(_LogoutScope.current);

  /// 登出全部设备（同上语义）。
  Future<void> logoutAll() => _logout(_LogoutScope.all);

  Future<void> _logout(_LogoutScope scope) async {
    final tokens = ref.read(tokenStoreProvider);
    final token = await tokens.readToken();
    // 1. 本地立即清理 + 切态（路由重定向随之发生，用户即刻看到登录页）
    await tokens.clearAll();
    state = const AuthState(phase: AuthPhase.loggedOut);
    // 2. 服务端吊销：后台尽力而为，不阻塞 UI
    if (token != null) {
      unawaited(() async {
        try {
          if (scope == _LogoutScope.all) {
            await ref.read(authApiProvider).logoutAll();
          } else {
            await ref.read(authApiProvider).logoutCurrent();
          }
        } on ApiException catch (_) {
          // 吊销失败不阻塞（token 已本地清除，服务端有有效期兜底）
        }
      }());
    }
  }

  /// 资料/头像变更后刷新本地用户态（重新拉取 /auth/me 并写缓存）。
  Future<void> reloadUser() async {
    try {
      final me = await ref.read(authApiProvider).getMe();
      final tokens = ref.read(tokenStoreProvider);
      await tokens.writeUserCached(me.toCache());
      state = AuthState(phase: AuthPhase.loggedIn, user: me);
    } on ApiException catch (_) {
      // 尽力而为：失败保留旧态
    }
  }

  /// 服务器地址变更后重走 bootstrap。
  Future<void> reconfigure() => bootstrap();
}

enum _LogoutScope { current, all }

final authControllerProvider =
    NotifierProvider<AuthController, AuthState>(AuthController.new);
