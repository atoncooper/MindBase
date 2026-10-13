import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/cloud.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';

/// 回收站：列表 / 恢复 / 彻底删除 / 清空。
class CloudTrashPage extends ConsumerStatefulWidget {
  const CloudTrashPage({super.key});

  @override
  ConsumerState<CloudTrashPage> createState() => _CloudTrashPageState();
}

class _CloudTrashPageState extends ConsumerState<CloudTrashPage> {
  List<CloudTrashItem> _items = [];
  bool _loading = true;
  String? _error;
  bool _emptying = false;

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
      final items = await ref.read(cloudApiProvider).listTrash();
      if (mounted) setState(() => _items = items);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _restore(CloudTrashItem t) async {
    try {
      await ref.read(cloudApiProvider).restoreTrash(t.uploadUuid);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('已恢复：${t.originalName}')));
      }
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _purge(CloudTrashItem t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('彻底删除'),
        content: Text('「${t.originalName}」将被永久删除，不可恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('彻底删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(cloudApiProvider).purgeTrashItem(t.uploadUuid);
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _emptyAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('清空回收站'),
        content: const Text('所有文件将被永久删除，不可恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('清空')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _emptying = true);
    try {
      final n = await ref.read(cloudApiProvider).emptyTrash();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('已清空 $n 个文件')));
      }
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _emptying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('回收站'),
        actions: [
          if (_items.isNotEmpty)
            TextButton(
              onPressed: _emptying ? null : _emptyAll,
              child: Text(_emptying ? '清空中...' : '清空'),
            ),
        ],
      ),
      body: _error != null
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
          : _loading
              ? const Center(child: CircularProgressIndicator())
              : _items.isEmpty
                  ? const Center(
                      child: Text('回收站是空的',
                          style: TextStyle(color: Colors.grey)))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        itemCount: _items.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final t = _items[i];
                          return ListTile(
                            leading:
                                const Icon(Icons.delete_outline, color: Colors.grey),
                            title: Text(t.originalName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis),
                            subtitle: Text(
                              '删除于 ${formatDateTimeIso(t.deletedAt)} · '
                              '将于 ${formatDateTimeIso(t.purgeAt)} 永久清除',
                              style: const TextStyle(fontSize: 11),
                            ),
                            isThreeLine: true,
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                TextButton(
                                    onPressed: () => _restore(t),
                                    child: const Text('恢复')),
                                TextButton(
                                    onPressed: () => _purge(t),
                                    child: const Text('彻底删除',
                                        style: TextStyle(color: Colors.red)),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
