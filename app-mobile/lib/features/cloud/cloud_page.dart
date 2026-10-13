import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mime/mime.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/cloud.dart';
import '../../core/config/app_config.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/status_badge.dart';

/// 云盘（文件管理器式布局）：
/// - 面包屑路径条（根目录 › 子目录 › …）+ 目录树行内导航：点文件夹行进入，
///   点面包屑回跳 —— 不再是顶部横滑 chips 的「导航页签」观感
/// - 当前目录内：文件夹行在前、文件行在后；行内类型图标 / 封面 / 缩略图
/// - 点击预览：图片查看器 / 文本弹层 / 视频·音频·PDF 外跳
/// - 分片上传（直传 MinIO + 心跳 + 进度/取消）→ 当前目录
/// - 搜索（/cloud/search）与回收站入口在 AppBar
class CloudPage extends ConsumerStatefulWidget {
  const CloudPage({super.key});

  @override
  ConsumerState<CloudPage> createState() => _CloudPageState();
}

class _CloudPageState extends ConsumerState<CloudPage> {
  CloudQuota? _quota;
  List<CloudFolder> _folders = [];

  /// 面包屑栈：[] = 根目录；最后一位 = 当前所在文件夹
  final List<CloudFolder> _path = [];

  final List<CloudVideoItem> _videos = [];
  final Map<String, String> _rawUrlCache = {}; // uploadUuid → presigned url
  int _page = 0;
  bool _hasMore = true;
  bool _loading = false;
  bool _loaded = false;
  String? _error;

  AppConfig get _config => ref.read(appConfigProvider);

  /// 当前所在文件夹（null = 根目录，对应后端 folder_id IS NULL 语义）。
  CloudFolder? get _current => _path.isEmpty ? null : _path.last;

  /// 当前目录下的子文件夹（从目录树按面包屑逐层下钻）。
  List<CloudFolder> get _currentChildren {
    var level = _folders;
    for (final f in _path) {
      final hit = level.where((e) => e.id == f.id).toList();
      if (hit.isEmpty) return const [];
      level = hit.first.children;
    }
    return level;
  }

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _videos.clear();
      _page = 0;
      _hasMore = true;
      _loaded = false;
    });
    await _loadMore();
    try {
      final f = await ref.read(cloudApiProvider).listFolders();
      if (!mounted) return;
      setState(() {
        _folders = f;
        // 目录树刷新后面包屑里的目录可能已被其它端删除 → 回落到有效前缀
        while (_path.isNotEmpty && !_pathExists(_path)) {
          _path.removeLast();
        }
      });
    } on ApiException catch (_) {}
    try {
      final q = await ref.read(cloudApiProvider).getQuota();
      if (mounted) setState(() => _quota = q);
    } on ApiException catch (_) {}
  }

  bool _pathExists(List<CloudFolder> path) {
    var level = _folders;
    for (final f in path) {
      final hit = level.where((e) => e.id == f.id).toList();
      if (hit.isEmpty) return false;
      level = hit.first.children;
    }
    return true;
  }

  void _openFolder(CloudFolder folder) {
    // 被点的目录行会随刷新从列表消失 → 推迟到指针派发结束（mouse_tracker 断言）
    runAfterGesture(() {
      if (!mounted) return;
      setState(() => _path.add(folder));
      _refresh();
    });
  }

  /// 跳转到面包屑第 [index] 层（-1 = 根目录）。
  void _jumpTo(int index) {
    // 被点的面包屑会随路径收缩而消失 → 同上，推迟执行
    runAfterGesture(() {
      if (!mounted) return;
      if (index < 0) {
        if (_path.isEmpty) return;
        setState(() => _path.clear());
      } else {
        if (index >= _path.length - 1) return;
        _path.removeRange(index + 1, _path.length);
        setState(() {});
      }
      _refresh();
    });
  }

  Future<void> _createFolder() async {
    final nameCtrl = TextEditingController();
    String? name;
    final created = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新建文件夹'),
        content: TextField(
          controller: nameCtrl,
          autofocus: true,
          decoration: InputDecoration(
            labelText: '文件夹名称',
            helperText: _current == null ? '创建在根目录' : '创建在「${_current!.name}」内',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('创建')),
        ],
      ),
    );
    if (created == true) name = nameCtrl.text.trim();
    nameCtrl.dispose();
    if (name == null || name.isEmpty) return;
    try {
      await ref
          .read(cloudApiProvider)
          .createFolder(name: name, parentId: _current?.id);
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _deleteFolder(CloudFolder folder) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除文件夹'),
        content: Text('确定删除「${folder.name}」？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(cloudApiProvider).deleteFolder(folder.id);
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _loadMore() async {
    if (_loading || !_hasMore) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref
          .read(cloudApiProvider)
          .listVideos(page: _page + 1, pageSize: 20, folderId: _current?.id);
      if (!mounted) return;
      setState(() {
        _videos.addAll(res.videos);
        _page = res.page;
        _hasMore = res.hasMore;
        _loading = false;
        _loaded = true;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _loaded = true;
          _error = e.message;
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 上传（分片直传 + 心跳 + 进度/取消）
  // ------------------------------------------------------------------

  Future<void> _upload() async {
    final result = await FilePicker.platform.pickFiles(withData: false);
    if (!mounted) return;
    final file = result?.files.single;
    if (file == null || file.path == null) return;
    final path = file.path!;
    final length = File(path).lengthSync();

    var abort = false;
    final progress = ValueNotifier<double>(0);
    final uploadFuture = ref.read(cloudApiProvider).uploadFile(
          filename: file.name,
          fileSize: length,
          mimeType: lookupMimeType(file.name) ?? 'application/octet-stream',
          folderId: _current?.id,
          readChunk: (start, end) async {
            final raf = await File(path).open();
            try {
              await raf.setPosition(start);
              return await raf.read(end - start);
            } finally {
              await raf.close();
            }
          },
          onProgress: (p) => progress.value = p,
          shouldAbort: () async => abort,
        );

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) {
        var closed = false;
        unawaited(uploadFuture.whenComplete(() {
          if (!closed && dialogCtx.mounted) Navigator.of(dialogCtx).pop();
          closed = true;
        }));
        return AlertDialog(
          title: const Text('上传中（分片直传）'),
          content: ValueListenableBuilder<double>(
            valueListenable: progress,
            builder: (context, v, _) => Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                LinearProgressIndicator(value: v),
                const SizedBox(height: 8),
                Text('${(v * 100).toStringAsFixed(0)}% · ${formatBytes(length)}'),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => abort = true,
              child: const Text('取消上传'),
            ),
          ],
        );
      },
    );
    progress.dispose();

    try {
      await uploadFuture;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('上传完成，可在列表中触发处理（ASR/向量化）')),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (!e.isCancelled && mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _triggerProcess(CloudVideoItem v) async {
    try {
      await ref.read(cloudApiProvider).triggerProcess(v.uploadUuid);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('已触发处理')));
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _delete(CloudVideoItem v) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除文件'),
        content: Text('移入回收站：${v.displayName}？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(cloudApiProvider).deleteVideo(v.uploadUuid);
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  // ------------------------------------------------------------------
  // 搜索
  // ------------------------------------------------------------------

  Future<void> _openSearch() async {
    final qCtrl = TextEditingController();
    String? query;
    final submitted = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('搜索文件'),
        content: TextField(
          controller: qCtrl,
          autofocus: true,
          decoration: const InputDecoration(labelText: '文件名关键字'),
          onSubmitted: (_) => Navigator.pop(ctx, true),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('搜索')),
        ],
      ),
    );
    if (submitted == true) query = qCtrl.text.trim();
    qCtrl.dispose();
    if (query == null || query.isEmpty) return;

    try {
      final res = await ref.read(cloudApiProvider).searchFiles(query);
      if (!mounted) return;
      await showGlassSheet<void>(
        context: context,
        builder: (_) => SafeArea(
          child: res.results.isEmpty
              ? const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: Text('没有匹配的文件')),
                )
              : ListView.separated(
                  shrinkWrap: true,
                  itemCount: res.results.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final v = res.results[i];
                    return ListTile(
                      leading: _TypeIcon(mimeType: v.mimeType),
                      title: Text(v.displayName,
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(
                        '${formatBytes(v.fileSize)} · ${formatDateTimeIso(v.createdAt)}',
                        style: const TextStyle(fontSize: 11),
                      ),
                      onTap: () {
                        Navigator.pop(context);
                        _preview(v);
                      },
                    );
                  },
                ),
        ),
      );
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  // ------------------------------------------------------------------
  // 预览（点文件即预览）
  // ------------------------------------------------------------------

  Future<void> _preview(CloudVideoItem v) async {
    CloudRawFile raw;
    try {
      raw = await ref.read(cloudApiProvider).getRawFile(v.uploadUuid);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
      return;
    }
    if (!mounted) return;
    _rawUrlCache[v.uploadUuid] = raw.url; // 缩略图直接复用
    final url = _config.resolveAssetUrl(raw.url);

    switch (raw.viewMode) {
      case 'image':
        await showDialog<void>(
          context: context,
          barrierColor: Colors.black87,
          builder: (ctx) => Dialog(
            backgroundColor: Colors.transparent,
            insetPadding: EdgeInsets.zero,
            child: Stack(
              children: [
                Positioned.fill(
                  child: GestureDetector(
                    onTap: () => Navigator.pop(ctx),
                    child: InteractiveViewer(
                      maxScale: 4,
                      child: Center(
                        child: Image.network(url, fit: BoxFit.contain),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  top: MediaQuery.paddingOf(ctx).top + 8,
                  right: 12,
                  child: IconButton(
                    onPressed: () => Navigator.pop(ctx),
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.black38,
                      foregroundColor: Colors.white,
                    ),
                    icon: const Icon(Icons.close),
                  ),
                ),
              ],
            ),
          ),
        );
      case 'text' || 'markdown' || 'html':
        await showGlassSheet<void>(
          context: context,
          builder: (_) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: SelectableText(
                raw.content ?? '（空文件）',
                style: TextStyle(
                  fontSize: 13,
                  height: 1.5,
                  fontFamily: AppTheme.codeFontFamily,
                  fontFamilyFallback: AppTheme.codeFontFamilyFallback,
                ),
              ),
            ),
          ),
        );
      case 'video' || 'audio' || 'pdf':
        final uri = Uri.tryParse(url);
        var launched = false;
        if (uri != null) {
          launched = await canLaunchUrl(uri) &&
              await launchUrl(uri, mode: LaunchMode.externalApplication);
        }
        if (!launched && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('无法打开系统播放器/查看器')),
          );
        }
      default:
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('该类型暂不支持预览')),
        );
    }
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final quota = _quota;
    final folders = _currentChildren;
    return Scaffold(
      appBar: AppBar(
        title: const Text('云盘'),
        actions: [
          IconButton(
            tooltip: '搜索文件',
            icon: const Icon(Icons.search),
            onPressed: _openSearch,
          ),
          IconButton(
            tooltip: '新建文件夹',
            icon: const Icon(Icons.create_new_folder_outlined),
            onPressed: _createFolder,
          ),
          IconButton(
            tooltip: '回收站',
            icon: const Icon(Icons.delete_outline),
            onPressed: () => context.push('/cloud/trash'),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _upload,
        icon: const Icon(Icons.upload_file),
        label: const Text('上传'),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (quota != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Row(
                children: [
                  Text('配额 ${formatBytes(quota.used)} / ${formatBytes(quota.quota)}',
                      style: TextStyle(
                          fontSize: 12.5,
                          color: Theme.of(context).hintColor)),
                  const Spacer(),
                  StatusBadge(status: quota.tier),
                ],
              ),
            ),
          // 面包屑路径条（树状导航的“在哪里”）
          _buildBreadcrumb(),
          Expanded(child: _buildBody(folders)),
        ],
      ),
    );
  }

  /// 面包屑：根目录 › A › B（可横向滚动；点任意一层回跳）。
  Widget _buildBreadcrumb() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final hint = Theme.of(context).hintColor;
    final crumbs = <Widget>[
      _Crumb(
        label: '根目录',
        active: _path.isEmpty,
        onTap: () => _jumpTo(-1),
      ),
      for (var i = 0; i < _path.length; i++) ...[
        Icon(Icons.chevron_right, size: 16, color: hint),
        _Crumb(
          label: _path[i].name,
          active: i == _path.length - 1,
          onTap: () => _jumpTo(i),
        ),
      ],
    ];
    return Container(
      decoration: BoxDecoration(
        color: isDark ? Colors.white.withValues(alpha: 0.04) : const Color(0xFFF6F8FB),
        border: Border(
          bottom: BorderSide(color: Theme.of(context).dividerColor),
        ),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        // reverse 让深层目录时自动露出最右（当前位置）；子项随之倒序布局
        reverse: true,
        child: Row(children: crumbs.reversed.toList()),
      ),
    );
  }

  Widget _buildBody(List<CloudFolder> folders) {
    if (_videos.isEmpty && folders.isEmpty) {
      if (!_loaded) {
        return const Center(child: CircularProgressIndicator());
      }
      if (_error != null) {
        return Center(
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
        );
      }
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_open_outlined,
                size: 56, color: Theme.of(context).hintColor.withValues(alpha: 0.4)),
            const SizedBox(height: 12),
            Text(
              _current == null ? '根目录还没有内容' : '这个文件夹是空的',
              style: TextStyle(color: Theme.of(context).hintColor),
            ),
            const SizedBox(height: 4),
            Text(
              _current == null
                  ? '点右下角「上传」添加文件，或先新建文件夹'
                  : '点右下角「上传」把文件传进当前文件夹',
              style: TextStyle(fontSize: 12.5, color: Theme.of(context).hintColor.withValues(alpha: 0.7)),
            ),
          ],
        ),
      );
    }
    final hasHeader = folders.isNotEmpty && _videos.isNotEmpty;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        itemCount: folders.length +
            (hasHeader ? 1 : 0) +
            _videos.length +
            (_hasMore || _loading ? 1 : 0),
        itemBuilder: (context, i) {
          // 1) 子文件夹行（树状导航主体）
          if (i < folders.length) {
            return _FolderRow(
              folder: folders[i],
              onOpen: () => _openFolder(folders[i]),
              onDelete: () => _deleteFolder(folders[i]),
            );
          }
          var idx = i - folders.length;
          // 文件夹与文件的过渡标题
          if (hasHeader && idx == 0) {
            return Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text(
                '文件',
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: Theme.of(context).hintColor,
                ),
              ),
            );
          }
          if (hasHeader) idx -= 1;
          final fileIdx = idx;
          if (fileIdx >= 0 && fileIdx < _videos.length) {
            final v = _videos[fileIdx];
            return _FileRow(
              item: v,
              rawCache: _rawUrlCache,
              onPreview: () => _preview(v),
              onProcess: () => _triggerProcess(v),
              onDelete: () => _delete(v),
            );
          }
          // 尾部：加载更多
          if (_error != null) {
            return TextButton(
                onPressed: () => runAfterGesture(_loadMore),
                child: const Text('加载失败，点此重试'));
          }
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
        },
      ),
    );
  }
}

/// 面包屑节点。
class _Crumb extends StatelessWidget {
  const _Crumb({required this.label, required this.active, required this.onTap});

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final primary = Theme.of(context).colorScheme.primary;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 13,
            fontWeight: active ? FontWeight.w600 : FontWeight.w400,
            color: active ? primary : Theme.of(context).hintColor,
          ),
        ),
      ),
    );
  }
}

/// 目录树行：蓝色文件夹标识 + 名称 + 文件数 + 进入/删除。
class _FolderRow extends StatelessWidget {
  const _FolderRow({
    required this.folder,
    required this.onOpen,
    required this.onDelete,
  });

  final CloudFolder folder;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final primary = Theme.of(context).colorScheme.primary;
    return InkWell(
      onTap: onOpen,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 9, 8, 9),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: primary.withValues(alpha: isDark ? 0.16 : 0.10),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(Icons.folder_outlined, size: 22, color: primary),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    folder.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w500),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${folder.videoCount} 个文件',
                    style: TextStyle(
                        fontSize: 12.5, color: Theme.of(context).hintColor),
                  ),
                ],
              ),
            ),
            PopupMenuButton<String>(
              onSelected: (sel) {
                if (sel == 'delete') onDelete();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'delete', child: Text('删除文件夹')),
              ],
            ),
            Icon(Icons.chevron_right, size: 20, color: Theme.of(context).hintColor),
          ],
        ),
      ),
    );
  }
}

/// 文件行：缩略图 + 名称 + 状态徽章 + 元信息 + 操作菜单。
class _FileRow extends StatelessWidget {
  const _FileRow({
    required this.item,
    required this.rawCache,
    required this.onPreview,
    required this.onProcess,
    required this.onDelete,
  });

  final CloudVideoItem item;
  final Map<String, String> rawCache;
  final VoidCallback onPreview;
  final VoidCallback onProcess;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onPreview,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(
                color: Theme.of(context).dividerColor.withValues(alpha: 0.6)),
          ),
        ),
        child: Row(
          children: [
            _FileThumb(item: item, rawCache: rawCache, onPreview: onPreview),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w500),
                  ),
                  const SizedBox(height: 5),
                  Row(
                    children: [
                      StatusBadge(status: item.asrStatus),
                      const SizedBox(width: 6),
                      StatusBadge(status: item.vectorStatus),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          '${formatBytes(item.fileSize)} · ${formatDateTimeIso(item.createdAt)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 11, color: Theme.of(context).hintColor),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            PopupMenuButton<String>(
              onSelected: (sel) {
                if (sel == 'process') onProcess();
                if (sel == 'delete') onDelete();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'process', child: Text('触发处理（ASR/向量化）')),
                PopupMenuItem(value: 'delete', child: Text('删除')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 行首类型图标 / 封面 / 图片缩略图。
/// - 视频：coverUrl（服务端抽帧封面）
/// - 图片：懒加载 raw 预签名 URL（cache 复用，避免重复 presign）
/// - 其他：按 mime 的类型图标
class _FileThumb extends ConsumerStatefulWidget {
  const _FileThumb({
    required this.item,
    required this.rawCache,
    required this.onPreview,
  });

  final CloudVideoItem item;
  final Map<String, String> rawCache;
  final VoidCallback onPreview;

  @override
  ConsumerState<_FileThumb> createState() => _FileThumbState();
}

class _FileThumbState extends ConsumerState<_FileThumb> {
  bool _loadingRaw = false;

  AppConfig get _config => ref.read(appConfigProvider);

  @override
  Widget build(BuildContext context) {
    final v = widget.item;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final boxColor =
        isDark ? const Color(0xFF242936) : const Color(0xFFEFF3F9);

    Widget content;
    if (v.coverUrl != null && v.coverUrl!.isNotEmpty) {
      content = Image.network(
        _config.resolveAssetUrl(v.coverUrl!),
        width: 48,
        height: 48,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) =>
            _iconBox(boxColor, _iconFor(v.mimeType)),
      );
    } else if (v.mimeType.startsWith('image/')) {
      final cached = widget.rawCache[v.uploadUuid];
      if (cached != null) {
        content = Image.network(
          _config.resolveAssetUrl(cached),
          width: 48,
          height: 48,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _iconBox(boxColor, Icons.broken_image),
        );
      } else if (_loadingRaw) {
        content = _iconBox(boxColor, null);
      } else {
        // 懒加载 raw 预签名（每行一次 API，ListView 懒构建分摊）
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _loadingRaw) return;
          _loadRaw();
        });
        content = _iconBox(boxColor, Icons.photo_outlined);
      }
    } else {
      content = _iconBox(boxColor, _iconFor(v.mimeType));
    }

    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: GestureDetector(
        onTap: widget.onPreview,
        child: SizedBox(width: 48, height: 48, child: content),
      ),
    );
  }

  Future<void> _loadRaw() async {
    _loadingRaw = true;
    try {
      final raw = await ref
          .read(cloudApiProvider)
          .getRawFile(widget.item.uploadUuid);
      widget.rawCache[widget.item.uploadUuid] = raw.url;
      if (mounted) setState(() {});
    } on ApiException catch (_) {
      // 加载失败保持类型图标
    } finally {
      _loadingRaw = false;
    }
  }

  Widget _iconBox(Color color, IconData? icon) {
    return Container(
      color: color,
      alignment: Alignment.center,
      child: _loadingRaw && icon == null
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(icon ?? Icons.photo_outlined,
              size: 22, color: Theme.of(context).hintColor),
    );
  }

  IconData _iconFor(String mime) {
    if (mime.startsWith('image/')) return Icons.image_outlined;
    if (mime.startsWith('video/')) return Icons.movie_outlined;
    if (mime.startsWith('audio/')) return Icons.music_note_outlined;
    if (mime == 'application/pdf') return Icons.picture_as_pdf_outlined;
    if (mime.startsWith('text/') ||
        mime.contains('json') ||
        mime.contains('html')) {
      return Icons.description_outlined;
    }
    return Icons.insert_drive_file_outlined;
  }
}

/// 列表行的纯类型图标（搜索结果等无缩略图场景）——统一冷灰蓝，不再五颜六色。
class _TypeIcon extends StatelessWidget {
  const _TypeIcon({required this.mimeType});

  final String mimeType;

  @override
  Widget build(BuildContext context) {
    IconData icon = Icons.insert_drive_file_outlined;
    if (mimeType.startsWith('image/')) icon = Icons.image_outlined;
    if (mimeType.startsWith('video/')) icon = Icons.movie_outlined;
    if (mimeType.startsWith('audio/')) icon = Icons.music_note_outlined;
    if (mimeType == 'application/pdf') icon = Icons.picture_as_pdf_outlined;
    return Icon(icon,
        color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.75));
  }
}
