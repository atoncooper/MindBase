import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:app_mobile/core/theme/app_theme.dart';
import 'package:app_mobile/shared/widgets/markdown_view.dart';

void _collectSpans(InlineSpan span, List<TextStyle> out) {
  final s = span.style;
  if (s != null) out.add(s);
  if (span is TextSpan) {
    span.children?.forEach((c) => _collectSpans(c, out));
  }
}

/// 在测试环境显式加载资产 MiSans（flutter_test 不会自动加载 pubspec 字体，
/// 与运行时的 FontManifest 加载路径等价），供宽度探针使用。
Future<void> _loadMiSans() async {
  final files = <int, String>{
    400: 'assets/fonts/MiSans-Regular.ttf',
    500: 'assets/fonts/MiSans-Medium.ttf',
    600: 'assets/fonts/MiSans-Demibold.ttf',
    700: 'assets/fonts/MiSans-Bold.ttf',
  };
  final loader = FontLoader('MiSans');
  for (final entry in files.entries) {
    loader.addFont(Future.value(await rootBundle.load(entry.value)));
  }
  await loader.load();
}

double _widthOf(TextStyle style, String text) {
  final tp = TextPainter(
    text: TextSpan(text: text, style: style),
    textDirection: TextDirection.ltr,
  )..layout();
  final w = tp.width;
  tp.dispose();
  return w;
}

const String _latinProbe = 'WidthProbe abcdefghijklmnopqrstuvwxyz 0123456789';

/// 字体渲染守护（歪扭修复回归）：
///
/// 1. markdown 强调（*…*）不得触发合成斜体 —— MiSans 无 italic 字形，
///    FontStyle.italic 会让汉字歪扭；此处遍历 span 断言无 italic；
/// 2. 代码 span 必须走跨平台等宽链（禁止裸 monospace：Windows/iOS 解析
///    失败会掉进雅黑/苹方，与全文 MiSans 混排）；
/// 3. 资产 MiSans 必须真实被解析（与「必然缺失字体」同宽 = 没加载）；
/// 4. 字重必须映射到真实字重文件 —— **合成加粗（faux bold）不改变 advance
///    宽度**，MiSans 各字重 Latin advance 有可测差异；宽度相等即伪粗体
///    （笔画糊/歪的经典来源）。
void main() {
  testWidgets('markdown emphasis is upright and code uses mono chain', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(600, 400);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const Scaffold(
          body: SingleChildScrollView(
            child: MarkdownView(
              selectable: false,
              data: '正文 *强调文字* 与 `inline code` 混排。\n\n'
                  '```dart\n// 中文注释\nfinal x = 1;\n```',
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final spans = <TextStyle>[];
    for (final w in find.byType(RichText).evaluate()) {
      _collectSpans((w.widget as RichText).text, spans);
    }
    expect(spans, isNotEmpty);

    for (final s in spans) {
      expect(s.fontStyle, isNot(FontStyle.italic),
          reason: '发现合成斜体 span：MiSans 无 italic，会渲染歪扭 → ${s.fontSize}px');
    }
    final families =
        spans.map((s) => s.fontFamily).whereType<String>().toSet();
    expect(families, contains(AppTheme.codeFontFamily),
        reason: '行内代码必须用 AppTheme.codeFontFamily 跨平台等宽链');
    expect(families, isNot(contains('monospace')),
        reason: '裸 monospace 在 Windows/iOS 解析失败，会与 MiSans 混排');
  });

  testWidgets('MiSans resolves from assets with real weights', (tester) async {
    await tester.runAsync(_loadMiSans);

    final miSans = _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20), _latinProbe);
    final missing = _widthOf(
        const TextStyle(fontFamily: 'DefinitelyMissingFont123', fontSize: 20), _latinProbe);
    expect(miSans, isNot(missing),
        reason: 'MiSans 与缺失字体同宽 → 资产字体没有被引擎解析，'
            '全文会回退系统字体造成不统一');

    final w400 = _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w400), _latinProbe);
    final w500 = _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w500), _latinProbe);
    final w600 = _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w600), _latinProbe);
    final w700 = _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w700), _latinProbe);
    expect(w600, isNot(w400),
        reason: 'w600 与 w400 同宽 → 伪粗体（合成加粗），笔画会糊/歪；'
            '说明 Demibold 文件没有按 600 注册');
    expect(w500, isNot(w400), reason: 'w500 应命中 Medium 真实字重');
    expect(w700, isNot(w600), reason: 'w700 应命中 Bold 真实字重');
  });

  testWidgets('ListTile/Chip keep MiSans (component theme styles must derive from textTheme)', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(600, 400);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const Scaffold(
        body: Column(
          children: [
            ListTile(
              title: Text('会话标题', style: TextStyle(fontSize: 15)),
              subtitle: Text('副标题文本'),
            ),
            ListTile(title: Text('纯默认标题')),
            Chip(label: Text('标签芯片')),
          ],
        ),
      ),
    ));
    await tester.pump();

    final spans = <TextStyle>[];
    for (final w in find.byType(RichText).evaluate()) {
      _collectSpans((w.widget as RichText).text, spans);
    }
    expect(spans, isNotEmpty);
    for (final s in spans) {
      expect(s.fontFamily, 'MiSans',
          reason: '组件主题 TextStyle 若手写而不从 textTheme 派生，'
              '会被组件整体替换环境样式（不做合并），断掉 MiSans 继承链，'
              '文字掉进系统默认字体与周边混排（侧边栏字体不统一的根源）');
    }
  });
}
