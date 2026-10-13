import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/notes.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';

/// 笔记编辑页（纯 Markdown 明文编辑；web 端 BlockNote 富文本不适用于移动端）。
///
/// 编辑体验：
/// - 标题/正文无边框画布式输入（去表单感），正文 15/1.6 舒适行距
/// - 键盘上方 Markdown 快捷工具栏（标题/加粗/斜体/列表/引用/代码/链接），
///   对选区包裹或对当前行加前缀
/// - 底部实时字数
///
/// 乐观并发：保存必须带 If-Match（取自打开时的 updatedAt）；
/// 409 = 冲突 → 提示刷新（以服务端为准，避免覆盖他人修改）。
class NoteEditPage extends ConsumerStatefulWidget {
  const NoteEditPage({super.key, required this.detail});

  final NoteDetail detail;

  @override
  ConsumerState<NoteEditPage> createState() => _NoteEditPageState();
}

class _NoteEditPageState extends ConsumerState<NoteEditPage> {
  late final TextEditingController _titleCtrl;
  late final TextEditingController _contentCtrl;
  late String _ifMatch;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _titleCtrl = TextEditingController(text: widget.detail.meta.title);
    _contentCtrl = TextEditingController(text: widget.detail.contentMd);
    _ifMatch = widget.detail.updatedAt;
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _contentCtrl.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    try {
      final d = await ref.read(notesApiProvider).get(widget.detail.meta.uuid);
      if (!mounted) return;
      setState(() {
        _titleCtrl.text = d.meta.title;
        _contentCtrl.text = d.contentMd;
        _ifMatch = d.updatedAt;
      });
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await ref.read(notesApiProvider).update(
            widget.detail.meta.uuid,
            ifMatchUpdatedAt: _ifMatch,
            title: _titleCtrl.text.trim(),
            contentMd: _contentCtrl.text,
          );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.isConflict) {
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('内容冲突'),
            content: const Text(
              '这份笔记在其他端被修改过（If-Match 不匹配）。'
              '为避免覆盖他人修改，请刷新后基于最新内容再编辑。',
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
              FilledButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _reload();
                },
                child: const Text('刷新最新内容'),
              ),
            ],
          ),
        );
      } else {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ------------------------------------------------------------------
  // Markdown 快捷插入
  // ------------------------------------------------------------------

  int _clamp(int v, int lo, int hi) => v < lo ? lo : (v > hi ? hi : v);

  /// 用 [prefix]/[suffix] 包裹当前选区（无选区时插入占位符并选中）。
  void _wrapSelection(String prefix, String suffix, String placeholder) {
    final sel = _contentCtrl.selection;
    final text = _contentCtrl.text;
    final start = _clamp(sel.start, 0, text.length);
    final end = _clamp(sel.end, 0, text.length);
    final selected = text.substring(start, end);
    final inner = selected.isEmpty ? placeholder : selected;
    final next = text.replaceRange(start, end, '$prefix$inner$suffix');
    _contentCtrl.value = TextEditingValue(
      text: next,
      selection: TextSelection(
        baseOffset: start + prefix.length,
        extentOffset: start + prefix.length + inner.length,
      ),
    );
  }

  /// 给当前行（光标所在行 / 选区覆盖的行）加行首前缀。
  void _prefixLine(String prefix) {
    final sel = _contentCtrl.selection;
    final text = _contentCtrl.text;
    final start = _clamp(sel.start, 0, text.length);
    final lineStart = text.lastIndexOf('\n', start - 1 < 0 ? 0 : start - 1) + 1;
    final next = text.replaceRange(lineStart, lineStart, prefix);
    final shift = prefix.length;
    _contentCtrl.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: sel.baseOffset + shift),
    );
  }

  void _insertLink() {
    final sel = _contentCtrl.selection;
    final text = _contentCtrl.text;
    final start = _clamp(sel.start, 0, text.length);
    final end = _clamp(sel.end, 0, text.length);
    final selected = text.substring(start, end);
    final label = selected.isEmpty ? '链接文字' : selected;
    final snippet = '[$label](url)';
    final next = text.replaceRange(start, end, snippet);
    // 选中 url 便于直接输入地址
    final urlStart = start + label.length + 3;
    _contentCtrl.value = TextEditingValue(
      text: next,
      selection: TextSelection(
        baseOffset: urlStart,
        extentOffset: urlStart + 3,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final hint = Theme.of(context).hintColor;
    return Scaffold(
      appBar: AppBar(
        title: const Text('编辑笔记'),
        actions: [
          FilledButton(
            onPressed: _saving ? null : _save,
            style: FilledButton.styleFrom(
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 16),
            ),
            child: Text(_saving ? '保存中…' : '保存'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 标题：大字号无边框，去表单感
          TextField(
            controller: _titleCtrl,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600, height: 1.35),
            decoration: InputDecoration(
              hintText: '标题',
              hintStyle: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w600,
                  color: hint.withValues(alpha: 0.45)),
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              contentPadding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
            ),
            maxLines: 1,
            textInputAction: TextInputAction.next,
          ),
          Divider(height: 1, color: Theme.of(context).dividerColor),
          // 正文：无边框画布
          Expanded(
            child: TextField(
              controller: _contentCtrl,
              maxLines: null,
              expands: true,
              textAlignVertical: TextAlignVertical.top,
              keyboardType: TextInputType.multiline,
              style: const TextStyle(fontSize: 15, height: 1.6),
              decoration: InputDecoration(
                hintText: '开始编写 Markdown…',
                hintStyle: TextStyle(color: hint.withValues(alpha: 0.5)),
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.fromLTRB(20, 14, 20, 16),
              ),
            ),
          ),
          // 快捷工具栏（键盘上方）
          _buildToolbar(hint),
        ],
      ),
    );
  }

  Widget _buildToolbar(Color hint) {
    final items = <(IconData, String, VoidCallback)>[
      (Icons.title_outlined, '标题', () => _prefixLine('## ')),
      (Icons.format_bold, '加粗', () => _wrapSelection('**', '**', '加粗文字')),
      (Icons.format_italic, '斜体', () => _wrapSelection('*', '*', '斜体文字')),
      (Icons.format_list_bulleted, '列表', () => _prefixLine('- ')),
      (Icons.format_quote, '引用', () => _prefixLine('> ')),
      (Icons.code_outlined, '代码', () => _wrapSelection('`', '`', 'code')),
      (Icons.link_outlined, '链接', _insertLink),
    ];
    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).brightness == Brightness.dark
            ? Colors.white.withValues(alpha: 0.04)
            : const Color(0xFFF6F8FB),
        border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            for (final (icon, tooltip, onTap) in items)
              IconButton(
                tooltip: tooltip,
                visualDensity: VisualDensity.compact,
                icon: Icon(icon, size: 20, color: hint),
                onPressed: () {
                  HapticFeedback.selectionClick();
                  onTap();
                },
              ),
            const Spacer(),
            // 实时字数
            Padding(
              padding: const EdgeInsets.only(right: 14),
              child: ValueListenableBuilder<TextEditingValue>(
                valueListenable: _contentCtrl,
                builder: (context, v, _) => Text(
                  '${v.text.length} 字',
                  style: TextStyle(fontSize: 11, color: hint),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
