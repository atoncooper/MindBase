import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:highlight/highlight.dart' as hl;
import 'package:markdown/markdown.dart' as md;

import '../../core/theme/app_theme.dart';

/// markdown `pre` 代码块自定义渲染（ChatGPT 风格）：
/// 语言头栏 + 一键复制 + highlight.js 语法高亮（GitHub 配色，明暗两套）+ 横向滚动。
///
/// 注册方式：MarkdownBody(builders: {'pre': CodeBlockBuilder()})。
/// 语言来自 fenced info string —— markdown 包会写入
/// `code.attributes['class'] = 'language-x'`。
class CodeBlockBuilder extends MarkdownElementBuilder {
  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    var language = '';
    final children = element.children;
    if (children != null && children.isNotEmpty) {
      final first = children.first;
      if (first is md.Element) {
        final cls = first.attributes['class'] ?? '';
        if (cls.startsWith('language-')) {
          language = cls.substring('language-'.length);
        }
      }
    }
    final code = element.textContent;
    return _CodeBlock(
      code: code.endsWith('\n') ? code.substring(0, code.length - 1) : code,
      language: language,
    );
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.code, required this.language});

  final String code;
  final String language;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final bg = isDark ? const Color(0xFF1B1B1F) : const Color(0xFFF6F8FA);
    final borderColor = isDark
        ? Colors.white.withValues(alpha: 0.06)
        : const Color(0xFFE4E8EE);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(12, 5, 4, 5),
            decoration:
                BoxDecoration(border: Border(bottom: BorderSide(color: borderColor))),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    language.isEmpty ? 'text' : language,
                    style: TextStyle(
                        fontSize: 11, color: Theme.of(context).hintColor),
                  ),
                ),
                _CopyButton(code: code),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(12),
            child: Text.rich(
              _spans(isDark),
              style: TextStyle(
                fontSize: 13,
                height: 1.5,
                fontFamily: AppTheme.codeFontFamily,
                fontFamilyFallback: AppTheme.codeFontFamilyFallback,
                color: isDark
                    ? const Color(0xFFE6EDF3)
                    : const Color(0xFF24292F),
              ),
            ),
          ),
        ],
      ),
    );
  }

  TextSpan _spans(bool isDark) {
    hl.Result? result;
    try {
      result = language.isNotEmpty
          ? hl.highlight.parse(code, language: language)
          : hl.highlight.parse(code, autoDetection: true);
    } catch (_) {
      result = null;
    }
    final nodes = result?.nodes;
    if (nodes == null || nodes.isEmpty) {
      return TextSpan(text: code);
    }
    return TextSpan(children: [for (final n in nodes) _nodeSpan(n, isDark)]);
  }

  TextSpan _nodeSpan(hl.Node node, bool isDark) {
    TextStyle? style;
    for (final c in (node.className ?? '').split(' ')) {
      if (c.isEmpty) continue;
      style ??= _codeStyleFor(c, isDark);
    }
    final children = node.children;
    if (children == null || children.isEmpty) {
      return TextSpan(text: node.value, style: style);
    }
    return TextSpan(
      text: node.value,
      style: style,
      children: [for (final c in children) _nodeSpan(c, isDark)],
    );
  }
}

class _CopyButton extends StatelessWidget {
  const _CopyButton({required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: code));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('代码已复制'),
              duration: Duration(milliseconds: 800),
            ),
          );
        }
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.copy, size: 13, color: Theme.of(context).hintColor),
            const SizedBox(width: 4),
            Text('复制',
                style:
                    TextStyle(fontSize: 11, color: Theme.of(context).hintColor)),
          ],
        ),
      ),
    );
  }
}

// 代码高亮配色（GitHub 风，明暗两套；key 对应 highlight.js 的 className）
TextStyle? _codeStyleFor(String className, bool isDark) {
  final color =
      isDark ? _darkCodeColors[className] : _lightCodeColors[className];
  if (color == null) return null;
  return TextStyle(color: color);
}

const Map<String, Color> _lightCodeColors = {
  'keyword': Color(0xFFCF222E),
  'built_in': Color(0xFFE36209),
  'string': Color(0xFF0A3069),
  'number': Color(0xFF0550AE),
  'literal': Color(0xFF0550AE),
  'comment': Color(0xFF6E7781),
  'title': Color(0xFF8250DF),
  'function': Color(0xFF8250DF),
  'type': Color(0xFF953800),
  'class': Color(0xFF953800),
  'attr': Color(0xFF0550AE),
  'attribute': Color(0xFF0550AE),
  'variable': Color(0xFF953800),
  'meta': Color(0xFF116329),
  'tag': Color(0xFF116329),
  'name': Color(0xFF116329),
  'symbol': Color(0xFF0550AE),
  'operator': Color(0xFF0550AE),
  'section': Color(0xFF0550AE),
  'selector-tag': Color(0xFFCF222E),
  'selector-id': Color(0xFF8250DF),
  'selector-class': Color(0xFF953800),
};

const Map<String, Color> _darkCodeColors = {
  'keyword': Color(0xFFFF7B72),
  'built_in': Color(0xFFFFA657),
  'string': Color(0xFFA5D6FF),
  'number': Color(0xFF79C0FF),
  'literal': Color(0xFF79C0FF),
  'comment': Color(0xFF8B949E),
  'title': Color(0xFFD2A8FF),
  'function': Color(0xFFD2A8FF),
  'type': Color(0xFFFFA657),
  'class': Color(0xFFFFA657),
  'attr': Color(0xFF79C0FF),
  'attribute': Color(0xFF79C0FF),
  'variable': Color(0xFFFFA657),
  'meta': Color(0xFF7EE787),
  'tag': Color(0xFF7EE787),
  'name': Color(0xFF7EE787),
  'symbol': Color(0xFF79C0FF),
  'operator': Color(0xFFFF7B72),
  'section': Color(0xFF79C0FF),
  'selector-tag': Color(0xFFFF7B72),
  'selector-id': Color(0xFFD2A8FF),
  'selector-class': Color(0xFFFFA657),
};
