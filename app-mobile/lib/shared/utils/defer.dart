import 'dart:async';

import 'package:flutter/foundation.dart';

/// 把手势回调推迟到当前指针事件派发结束之后（微任务）执行。
///
/// 背景：onTap / onPressed 里**同步 setState 把被点控件移出树**（错误态→
/// 加载态、点目录行后该行随刷新消失等），会让被点 InkWell/按钮注册的
/// MouseTrackerAnnotation 在指针事件派发中途脱离，debug 模式触发
/// mouse_tracker 的 `!_debugDuringDeviceUpdate` 断言（release 无此断言，
/// 但行为统一推迟更稳）。
///
/// 用法：按钮的 onPressed 改为 `() => runAfterGesture(_doSomething)`；
/// 若回调内使用 State，先 `if (!mounted) return`。
void runAfterGesture(VoidCallback action) {
  scheduleMicrotask(action);
}
