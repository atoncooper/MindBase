import 'dart:ui';

import 'package:flutter/material.dart';

/// 毛玻璃容器（BackdropFilter + 半透明 tint + 细描边）。
///
/// 使用边界（app-mobile/AGENTS.md 约定）：**仅限悬浮层** —— 输入栏、悬浮钮、
/// 底部弹层、登录卡片、AppBar；列表项与正文区域禁用（性能与可读性）。
class GlassContainer extends StatelessWidget {
  const GlassContainer({
    super.key,
    required this.child,
    this.blur = 20,
    this.borderRadius,
    this.tint,
    this.border,
    this.padding,
  });

  final Widget child;
  final double blur;
  final BorderRadius? borderRadius;
  final Color? tint;
  final Border? border;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final effectiveTint = tint ??
        (isDark
            ? Colors.white.withValues(alpha: 0.07)
            : Colors.white.withValues(alpha: 0.62));
    final effectiveBorder = border ??
        Border.all(
          color: isDark
              ? Colors.white.withValues(alpha: 0.08)
              : Colors.white.withValues(alpha: 0.55),
        );
    return ClipRRect(
      borderRadius: borderRadius ?? BorderRadius.zero,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            color: effectiveTint,
            borderRadius: borderRadius,
            border: effectiveBorder,
          ),
          child: child,
        ),
      ),
    );
  }
}

/// 毛玻璃底部弹层（替代 showModalBottomSheet 的实色背景）。
///
/// [withHandle]：顶部拖动指示条；DraggableScrollableSheet 类自滚动内容
/// 传 false（它需要直接成为 GlassContainer 的唯一子级才有界）。
Future<T?> showGlassSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = false,
  bool withHandle = true,
}) {
  final isDark = Theme.of(context).brightness == Brightness.dark;
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: isScrollControlled,
    backgroundColor: Colors.transparent,
    barrierColor: isDark ? Colors.black45 : Colors.black26,
    builder: (ctx) => GlassContainer(
      blur: 20,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      tint: isDark
          ? const Color(0xD92C2C2E)
          : Colors.white.withValues(alpha: 0.72),
      child: withHandle
          ? Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(height: 10),
                Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 6),
                  decoration: BoxDecoration(
                    color: isDark ? Colors.white24 : Colors.black26,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                // 防溢出兜底：内容超过弹层最大高度时自动变为弹层内滚动
                Flexible(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: builder(ctx),
                  ),
                ),
              ],
            )
          : builder(ctx),
    ),
  );
}
