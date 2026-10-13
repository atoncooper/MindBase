import 'dart:async';

/// 401 全局广播：api 层清完本地凭据后 fire()，AuthController 监听后切换到
/// 未登录态，路由重定向统一跳登录页（对齐 web 端 `auth:unauthorized` 事件）。
class UnauthorizedSignal {
  final _controller = StreamController<void>.broadcast();

  Stream<void> get stream => _controller.stream;

  void fire() {
    if (!_controller.isClosed) {
      _controller.add(null);
    }
  }

  void dispose() => _controller.close();
}
