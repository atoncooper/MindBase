import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/notes.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/markdown_view.dart';

/// 笔记查看页：Markdown 渲染 + 锚点 + 分享 + 修订。
class NoteViewPage extends ConsumerStatefulWidget {
  const NoteViewPage({super.key, required this.uuid});

  final String uuid;

  @override
  ConsumerState<NoteViewPage> createState() => _NoteViewPageState();
}

class _NoteViewPageState extends ConsumerState<NoteViewPage> {
  NoteDetail? _detail;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final d = await ref.read(notesApiProvider).get(widget.uuid);
      if (mounted) setState(() => _detail = d);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _share() async {
    final detail = _detail;
    if (detail == null) return;
    final daysCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('创建公开分享'),
        content: TextField(
          controller: daysCtrl,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            labelText: '有效天数（留空 = 永久）',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('创建')),
        ],
      ),
    );
    if (confirmed != true) return;
    final days = int.tryParse(daysCtrl.text.trim());
    daysCtrl.dispose();
    try {
      final info = await ref
          .read(notesApiProvider)
          .createShare(widget.uuid, expiresInDays: days);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('分享链接已创建'),
          content: SelectableText(info.shareUrl.isEmpty ? info.shareToken : info.shareUrl),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(
                    text: info.shareUrl.isEmpty ? info.shareToken : info.shareUrl));
              },
              child: const Text('复制'),
            ),
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('完成')),
          ],
        ),
      );
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _revisions() async {
    try {
      final list = await ref.read(notesApiProvider).listRevisions(widget.uuid);
      if (!mounted) return;
      final restoreId = await showGlassSheet<String>(
        context: context,
        builder: (ctx) => SafeArea(
          child: list.isEmpty
              ? const Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('暂无修订记录'))
              : ListView.separated(
                  shrinkWrap: true,
                  itemCount: list.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) => ListTile(
                    title: Text(list[i].revisionNote ?? '修订 #${i + 1}'),
                    subtitle: Text(formatDateTimeIso(list[i].createdAt)),
                    onTap: () => Navigator.pop(ctx, list[i].revisionId),
                  ),
                ),
        ),
      );
      if (restoreId == null) return;
      if (!mounted) return;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('恢复此修订'),
          content: const Text('当前内容将被该修订快照覆盖。'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('恢复')),
          ],
        ),
      );
      if (ok == true) {
        await ref
            .read(notesApiProvider)
            .restoreRevision(widget.uuid, restoreId);
        await _load();
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    return Scaffold(
      appBar: AppBar(
        title: Text(detail?.meta.title.isEmpty ?? true
            ? '笔记'
            : detail!.meta.title),
        actions: [
          IconButton(
            tooltip: '修订历史',
            icon: const Icon(Icons.history),
            onPressed: _revisions,
          ),
          IconButton(
            tooltip: '分享',
            icon: const Icon(Icons.share_outlined),
            onPressed: _share,
          ),
          IconButton(
            tooltip: '编辑',
            icon: const Icon(Icons.edit_outlined),
            onPressed: detail == null
                ? null
                : () async {
                    await context.push('/notes/${detail.meta.uuid}/edit',
                        extra: detail);
                    _load();
                  },
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!),
                      const SizedBox(height: 12),
                      OutlinedButton(
                          onPressed: () => runAfterGesture(_load),
                          child: const Text('重试')),
                    ],
                  ),
                )
              : detail == null
                  ? const SizedBox.shrink()
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 40),
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (detail.meta.isPinned) ...[
                              Icon(Icons.push_pin,
                                  size: 18, color: Colors.amber.shade700),
                              const SizedBox(width: 6),
                            ],
                            Expanded(
                              child: Text(
                                detail.meta.title.isEmpty
                                    ? '无标题'
                                    : detail.meta.title,
                                style: const TextStyle(
                                    fontSize: 22,
                                    fontWeight: FontWeight.w600,
                                    height: 1.3),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '${formatDateTimeIso(detail.meta.updatedAt)} · ${detail.meta.contentLength} 字 · ${detail.meta.revisionCount} 次修订',
                          style: TextStyle(
                              fontSize: 12.5, color: Theme.of(context).hintColor),
                        ),
                        const SizedBox(height: 12),
                        Divider(color: Theme.of(context).dividerColor, height: 1),
                        const SizedBox(height: 16),
                        MarkdownView(data: detail.contentMd),
                        if (detail.anchors.isNotEmpty) ...[
                          const Divider(height: 32),
                          Text('锚点（${detail.anchors.length}）',
                              style: const TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 8),
                          for (final a in detail.anchors)
                            ListTile(
                              dense: true,
                              contentPadding: EdgeInsets.zero,
                              leading: const Icon(Icons.bookmark_border, size: 18),
                              title: Text(a.label ?? a.blockId),
                              subtitle: Text('位置 ${a.position}',
                                  style: const TextStyle(fontSize: 11)),
                            ),
                        ],
                      ],
                    ),
    );
  }
}
