import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme/app_theme.dart';
import 'code_block.dart';

/// Markdown 渲染（flutter_markdown_plus，flutter_markdown 的维护版 fork）。
///
/// 纵深防御的最后一层：服务端写入前已二次消毒（剥 script/iframe、危险 URL），
/// 客户端再禁用一切 HTML 扩展 —— 原始 HTML 块按纯文本降级，只注册链接点击。
///
/// 排版对齐 ChatGPT 正文：15px / 1.55 行高；代码块带语言头栏 + 复制 +
/// 语法高亮（builders {'pre': CodeBlockBuilder()}）；表格 / 引用块完整样式。
class MarkdownView extends StatelessWidget {
  const MarkdownView({
    super.key,
    required this.data,
    this.selectable = true,
  });

  final String data;
  final bool selectable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final codeBg = theme.colorScheme.surfaceContainerHighest;
    final base = MarkdownStyleSheet.fromTheme(theme);
    final pStyle =
        theme.textTheme.bodyMedium?.copyWith(fontSize: 15, height: 1.55);
    return MarkdownBody(
      data: data,
      selectable: selectable,
      softLineBreak: true,
      builders: {'pre': CodeBlockBuilder()},
      styleSheet: base.copyWith(
        p: pStyle,
        listBullet: pStyle,
        // 强调（*…*）禁用斜体：MiSans 未附带 italic 字形，FontStyle.italic 会
        // 触发合成斜切，汉字歪歪扭扭。统一用字重（w500）表达强调。
        em: pStyle?.copyWith(fontWeight: FontWeight.w500),
        h1: theme.textTheme.titleLarge
            ?.copyWith(fontSize: 20, fontWeight: FontWeight.w600),
        h2: theme.textTheme.titleLarge
            ?.copyWith(fontSize: 18, fontWeight: FontWeight.w600),
        h3: theme.textTheme.titleMedium
            ?.copyWith(fontSize: 16, fontWeight: FontWeight.w600),
        h4: theme.textTheme.titleMedium
            ?.copyWith(fontSize: 15, fontWeight: FontWeight.w600),
        h5: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
        h6: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
        blockSpacing: 10,
        listIndent: 20,
        // 引用块：左侧竖条 + 浅底
        blockquote: theme.textTheme.bodyMedium
            ?.copyWith(fontSize: 13, color: theme.hintColor),
        blockquoteDecoration: BoxDecoration(
          border:
              Border(left: BorderSide(color: theme.dividerColor, width: 3)),
          color: theme.colorScheme.surfaceContainerHighest
              .withValues(alpha: 0.5),
        ),
        blockquotePadding:
            const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        // 表格：圆角描边 + 表头加粗
        tableHead: theme.textTheme.bodyMedium
            ?.copyWith(fontSize: 13, fontWeight: FontWeight.w600),
        tableBody: theme.textTheme.bodyMedium?.copyWith(fontSize: 13),
        tableHeadAlign: TextAlign.left,
        tableBorder: TableBorder.all(
          color: theme.dividerColor,
          width: 0.6,
          borderRadius: BorderRadius.circular(10),
        ),
        tableCellsPadding:
            const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        // 行内代码（围栏代码块由 CodeBlockBuilder 接管）
        code: theme.textTheme.bodyMedium?.copyWith(
          fontSize: 13,
          fontFamily: AppTheme.codeFontFamily,
          fontFamilyFallback: AppTheme.codeFontFamilyFallback,
          backgroundColor: codeBg,
        ),
        codeblockDecoration: BoxDecoration(
          color: codeBg,
          borderRadius: BorderRadius.circular(10),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: theme.dividerColor)),
        ),
      ),
      onTapLink: (text, href, title) async {
        final uri = Uri.tryParse(href ?? '');
        if (uri == null) return;
        if (await canLaunchUrl(uri)) {
          await launchUrl(uri, mode: LaunchMode.externalApplication);
        }
      },
    );
  }
}
