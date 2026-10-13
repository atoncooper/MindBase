import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/notes.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';

/// 笔记列表：分页 + 置顶 + 删除 + 新建（关联视频 BV 号）。
class NotesListPage extends ConsumerStatefulWidget {
  const NotesListPage({super.key});

  @override
  ConsumerState<NotesListPage> createState() => _NotesListPageState();
}

class _NotesListPageState extends ConsumerState<NotesListPage> {
  final List<NoteMeta> _items = [];
  int _total = 0;
  int _page = 0;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadMore();
  }

  bool get _hasMore => _items.length < _total;

  Future<void> _loadMore() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref
          .read(notesApiProvider)
          .list(page: _page + 1, pageSize: 20);
      if (!mounted) return;
      setState(() {
        if (_page == 0) _items.clear();
        _items.addAll(res.items);
        _total = res.total;
        _page += 1;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = e.message;
        });
      }
    }
  }

  Future<void> _refresh() async {
    setState(() {
      _page = 0;
      _total = 0;
    });
    await _loadMore();
  }

  Future<void> _togglePin(NoteMeta meta) async {
    try {
      await ref.read(notesApiProvider).update(
            meta.uuid,
            ifMatchUpdatedAt: meta.updatedAt,
            isPinned: !meta.isPinned,
          );
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _delete(NoteMeta meta) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除笔记'),
        content: Text('确定删除「${meta.title.isEmpty ? '无标题' : meta.title}」？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(notesApiProvider).delete(meta.uuid);
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('笔记')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final uuid = await showDialog<String>(
            context: context,
            builder: (ctx) => _CreateNoteDialog(api: ref.read(notesApiProvider)),
          );
          if (uuid != null && context.mounted) {
            await context.push('/notes/$uuid');
            _refresh();
          }
        },
        icon: const Icon(Icons.add),
        label: const Text('新建'),
      ),
      body: _error != null && _items.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_error!),
                  const SizedBox(height: 12),
                  OutlinedButton(
                      onPressed: () => runAfterGesture(_refresh),
                      child: const Text('重试')),
                ],
              ),
            )
          : _items.isEmpty && !_loading
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.sticky_note_2_outlined,
                          size: 44,
                          color: Theme.of(context).hintColor.withValues(alpha: 0.5)),
                      const SizedBox(height: 12),
                      Text('还没有笔记',
                          style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                              color: Theme.of(context).hintColor)),
                      const SizedBox(height: 4),
                      Text('右下角「新建」创建第一篇笔记',
                          style: TextStyle(
                              fontSize: 12.5, color: Theme.of(context).hintColor)),
                    ],
                  ),
                )
              : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                itemCount: _items.length + (_hasMore || _loading ? 1 : 0),
                itemBuilder: (context, i) {
                  if (i >= _items.length) {
                    if (_error != null) {
                      return TextButton(
                          onPressed: () => runAfterGesture(_loadMore),
                          child: const Text('加载失败，点此重试'));
                    }
                    // 构建期不能 setState：排到帧末再加载下一页
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted && !_loading && _hasMore) _loadMore();
                    });
                    return const Padding(
                      padding: EdgeInsets.all(16),
                      child: Center(
                          child: SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))),
                    );
                  }
                  final meta = _items[i];
                  // 卡片观感对齐全局 CardTheme：20 圆角 + cardFill + 发丝线描边，
                  // 去掉旧的 14 圆角双层容器（边框与内容错位、与全 app 卡片不一致）。
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Material(
                      color: Theme.of(context).cardTheme.color,
                      borderRadius: BorderRadius.circular(20),
                      clipBehavior: Clip.antiAlias,
                      child: InkWell(
                        onTap: () async {
                          await context.push('/notes/${meta.uuid}');
                          _refresh();
                        },
                        child: Container(
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(20),
                            border: Border.all(
                                color: Theme.of(context).dividerColor),
                          ),
                          child: ListTile(
                            contentPadding: const EdgeInsets.symmetric(
                                horizontal: 16, vertical: 6),
                            leading: Icon(
                              meta.isPinned
                                  ? Icons.push_pin
                                  : Icons.sticky_note_2_outlined,
                              size: 20,
                              color: meta.isPinned
                                  ? Colors.amber.shade700
                                  : Theme.of(context).hintColor,
                            ),
                            title: Text(
                              meta.title.isEmpty ? '无标题' : meta.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: Text(
                              '${formatDateTimeIso(meta.updatedAt)} · ${meta.contentLength} 字 · ${meta.revisionCount} 次修订',
                              style: TextStyle(
                                  fontSize: 12.5,
                                  color: Theme.of(context).hintColor),
                            ),
                            trailing: PopupMenuButton<String>(
                              onSelected: (v) {
                                if (v == 'pin') _togglePin(meta);
                                if (v == 'delete') _delete(meta);
                              },
                              itemBuilder: (_) => [
                                PopupMenuItem(
                                  value: 'pin',
                                  child: Text(meta.isPinned ? '取消置顶' : '置顶'),
                                ),
                                const PopupMenuItem(value: 'delete', child: Text('删除')),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
    );
  }
}

/// 新建笔记弹窗（自持控制器生命周期，返回新笔记 uuid）。
class _CreateNoteDialog extends ConsumerStatefulWidget {
  const _CreateNoteDialog({required this.api});

  final NotesApi api;

  @override
  ConsumerState<_CreateNoteDialog> createState() => _CreateNoteDialogState();
}

class _CreateNoteDialogState extends ConsumerState<_CreateNoteDialog> {
  final _titleCtrl = TextEditingController();
  final _bvidCtrl = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _titleCtrl.dispose();
    _bvidCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final bvid = _bvidCtrl.text.trim();
    if (bvid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请填写关联视频 BV 号（笔记必须挂在目标上）')),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      final detail = await widget.api.create(
        title: _titleCtrl.text.trim(),
        targetType: 'video',
        targetId: bvid,
      );
      if (mounted) Navigator.pop(context, detail.meta.uuid);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新建笔记'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _titleCtrl,
            autofocus: true,
            decoration: const InputDecoration(labelText: '标题'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _bvidCtrl,
            decoration: const InputDecoration(
              labelText: '关联视频 BV 号',
              hintText: 'BV1xxxx（收藏页进入可自动带上）',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(_busy ? '创建中...' : '创建'),
        ),
      ],
    );
  }
}
