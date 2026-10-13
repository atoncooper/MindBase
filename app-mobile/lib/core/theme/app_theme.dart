import 'package:flutter/material.dart';

/// 白蓝主题：白底 + 蓝主色（亮色）/ 深灰底 + 亮蓝（暗色）。
///
/// 配色：主色蓝 #2563EB（亮）/ #7CA6F2（暗，同色相提亮保证对比度），
/// 亮色脚手架纯白，暗色 #16181D 近中性深灰；分隔线/输入底色带轻微冷灰蓝，
/// 让「白蓝」贯穿而不刺眼。
///
/// 字体策略（全平台统一 **MiSans**，随应用打包，免费商用）：
/// - Latin + CJK 一体，观感接近苹方（SF Pro 受苹果许可限制不可分发）
/// - 回退链：苹方（iOS）→ 微软雅黑（Windows）→ 系统无衬线
/// - 字重映射：400 Regular / 500 Medium / 600 Demibold / 700 Bold
/// - 斜体：MiSans 无 italic 字形，**全局禁用合成斜体**（markdown 强调改用字重）
/// - 代码/等宽：Consolas → Menlo → monospace → MiSans（见 codeFontFamily）
class AppTheme {
  AppTheme._();

  /// 品牌蓝（白蓝主色）—— 亮色主题主色。
  static const Color brandBlue = Color(0xFF2563EB);

  /// 暗色主题主色（同色相提亮）。
  static const Color brandBlueDark = Color(0xFF7CA6F2);

  // —— Gemini 风格设计令牌（参考 Google Gemini 的 Material 3 Expressive）——

  /// Gemini 签名浅表面色（输入框/建议卡/抽屉选中态的填充）。
  static const Color surfaceTintLight = Color(0xFFF0F4F9);

  /// 暗色对应填充。
  static const Color surfaceTintDark = Color(0xFF20232B);

  /// 用户消息气泡填充（比 [surfaceTintLight] 略深一档以区分）。
  static const Color userBubbleLight = Color(0xFFE7EDF7);

  static const Color userBubbleDark = Color(0xFF32353D);

  static const Color _seed = brandBlue;

  static ThemeData light() => _theme(Brightness.light);

  static ThemeData dark() => _theme(Brightness.dark);

  static const String _fontFamily = 'MiSans';

  /// 回退链（逐平台命中，未命中的名字被安全跳过）：
  /// - iOS/macOS: PingFang SC（苹方）
  /// - Windows: Microsoft YaHei UI / Microsoft YaHei
  /// - Android: MIUI 系统自带 MiSans（与资产同族，度量一致）→ Noto Sans SC /
  ///   Noto Sans CJK SC（原生 CJK）。旧链在 Android 上没有任何可命中名字，
  ///   CJK 全部落进逐字系统回退 —— Impeller 下不同 run 可能选中不同字重，
  ///   是「字体不统一/歪扭」在移动端的经典来源，故显式给出 Android 可命中的
  ///   家族名。
  /// - 兜底：通用无衬线。
  static List<String> get _fontFamilyFallback => const [
        'MiSans',
        'PingFang SC',
        'Noto Sans SC',
        'Noto Sans CJK SC',
        'Microsoft YaHei UI',
        'Microsoft YaHei',
        'sans-serif',
      ];

  /// 代码/等宽字体（行内代码、代码块、终端样文本）。
  ///
  /// 不要写裸 monospace：它不是真实字体家族名，Windows/iOS 解析失败后
  /// 会掉进系统回退（雅黑/苹方），与全文 MiSans 混排，观感割裂。
  /// 链路：Windows=Consolas → iOS/macOS=Menlo → Android=通用 monospace，
  /// 末位回退 MiSans，让代码里的中文注释与正文同族。
  /// 注意：代码块的 ASCII 与 CJK 天然跨字体（等宽字体不带汉字），这是所有
  /// 终端/编辑器的通用观感；中文注释走 MiSans 保证与正文一致。
  static const String codeFontFamily = 'Consolas';

  static const List<String> codeFontFamilyFallback = [
    'Menlo',
    'Courier New',
    'monospace',
    _fontFamily,
  ];

  static ThemeData _theme(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final scaffold = isDark ? const Color(0xFF16181D) : Colors.white;
    final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness)
        .copyWith(primary: isDark ? brandBlueDark : brandBlue);
    final divider = isDark
        ? Colors.white.withValues(alpha: 0.08)
        : const Color(0xFFE8ECF2);
    // Gemini 签名浅表面：输入框/卡片/Chip 的无边界填充
    final inputFill =
        isDark ? surfaceTintDark : surfaceTintLight;
    final cardFill =
        isDark ? const Color(0xFF1C1F27) : const Color(0xFFF5F8FC);

    final base = ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      fontFamily: _fontFamily,
      fontFamilyFallback: _fontFamilyFallback,
      scaffoldBackgroundColor: scaffold,
      splashFactory: InkSparkle.splashFactory,
    );

    return base.copyWith(
      // 全局字阶：标题 20/16 w600，正文 15/1.55，辅助 12.5/1.45，标签 11.5
      textTheme: base.textTheme.copyWith(
        titleLarge:
            base.textTheme.titleLarge?.copyWith(fontSize: 20, height: 1.3),
        titleMedium:
            base.textTheme.titleMedium?.copyWith(fontSize: 16, height: 1.3),
        titleSmall:
            base.textTheme.titleSmall?.copyWith(fontSize: 14, height: 1.35),
        bodyLarge: base.textTheme.bodyLarge?.copyWith(fontSize: 16, height: 1.55),
        bodyMedium:
            base.textTheme.bodyMedium?.copyWith(fontSize: 15, height: 1.55),
        bodySmall:
            base.textTheme.bodySmall?.copyWith(fontSize: 12.5, height: 1.45),
        labelSmall:
            base.textTheme.labelSmall?.copyWith(fontSize: 11, height: 1.3),
        labelMedium: base.textTheme.labelMedium?.copyWith(height: 1.35),
      ),
      // 统一页面转场：轻微右滑 + 淡入（克制动效），全平台一致
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: _FadeSlideTransitionsBuilder(),
          TargetPlatform.iOS: _FadeSlideTransitionsBuilder(),
          TargetPlatform.windows: _FadeSlideTransitionsBuilder(),
          TargetPlatform.macOS: _FadeSlideTransitionsBuilder(),
          TargetPlatform.linux: _FadeSlideTransitionsBuilder(),
        },
      ),
      appBarTheme: AppBarTheme(
        centerTitle: false,
        elevation: 0,
        scrolledUnderElevation: 0,
        backgroundColor: scaffold,
        foregroundColor: scheme.onSurface,
        titleTextStyle: base.textTheme.titleMedium?.copyWith(
          fontSize: 16.5,
          fontWeight: FontWeight.w600,
          color: scheme.onSurface,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        isDense: true,
        filled: true,
        fillColor: inputFill,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        // Gemini 风格：无边界胶囊填充，聚焦时仅描一圈主色
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(28),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(28),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(28),
          borderSide: BorderSide(color: scheme.primary, width: 1.3),
        ),
      ),
      // Gemini 风格卡片：无阴影、浅表面填充、20 圆角
      cardTheme: CardThemeData(
        elevation: 0,
        color: cardFill,
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: Colors.white,
          shape: const StadiumBorder(),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: scheme.primary,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
      chipTheme: base.chipTheme.copyWith(
        shape: const StadiumBorder(),
        side: BorderSide.none,
        backgroundColor: inputFill,
        labelStyle: base.textTheme.labelMedium
            ?.copyWith(fontSize: 12.5, color: scheme.onSurface),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: isDark ? const Color(0xFF1F232B) : Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
        titleTextStyle: base.textTheme.titleMedium?.copyWith(
          fontSize: 17,
          fontWeight: FontWeight.w600,
          color: scheme.onSurface,
        ),
      ),
      // ⚠️ 组件主题的 TextStyle 会被组件**整体替换**环境 DefaultTextStyle
      // （ListTile 源码：tileTheme.titleTextStyle ?? defaults.titleTextStyle!），
      // 不做合并 —— 手写 TextStyle(fontSize:...) 会断掉 MiSans 继承链，
      // ListTile 文字掉进系统默认字体，与周边混排（侧边栏"字体不统一"的根源）。
      // 因此所有组件主题样式一律从 textTheme 派生（copyWith），让家族与回退链
      // 携带在样式自身，无论组件合不合并都安全。
      listTileTheme: ListTileThemeData(
        iconColor: scheme.onSurface.withValues(alpha: 0.72),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        titleTextStyle: base.textTheme.bodyLarge?.copyWith(
            fontSize: 15,
            fontWeight: FontWeight.w500,
            color: scheme.onSurface),
        subtitleTextStyle: base.textTheme.bodySmall?.copyWith(
            fontSize: 12.5,
            color: scheme.onSurface.withValues(alpha: 0.55)),
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: scheme.primary,
        unselectedLabelColor: scheme.onSurface.withValues(alpha: 0.55),
        labelStyle: base.textTheme.titleSmall
            ?.copyWith(fontSize: 14, fontWeight: FontWeight.w600),
        unselectedLabelStyle: base.textTheme.titleSmall
            ?.copyWith(fontSize: 14, fontWeight: FontWeight.w500),
        indicatorColor: scheme.primary,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: divider,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      dividerTheme: DividerThemeData(color: divider, thickness: 0.6, space: 1),
    );
  }
}

/// 统一页面转场：轻微右滑 + 淡入（克制动效，替代系统默认的缩放/上滑）。
class _FadeSlideTransitionsBuilder extends PageTransitionsBuilder {
  const _FadeSlideTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final curved = CurvedAnimation(
      parent: animation,
      curve: Curves.easeOutCubic,
      reverseCurve: Curves.easeInCubic,
    );
    return FadeTransition(
      opacity: curved,
      child: SlideTransition(
        position: Tween(begin: const Offset(0.045, 0), end: Offset.zero)
            .animate(curved),
        child: child,
      ),
    );
  }
}
