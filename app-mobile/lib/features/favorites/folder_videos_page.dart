import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/favorites.dart';
import '../../api/knowledge.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/status_badge.dart';
import '../quiz/quiz_take_page.dart';

/// 收藏夹内视频列表（分页）+ 分P 向量化状态 + 知识库构建入口。
class FolderVideosPage extends ConsumerStatefulWidget {
  const FolderVideosPage({super.key, required this.folder});

  final FavoriteFolder folder;

  @override
  ConsumerState<FolderVideosPage> createState() => _FolderVideosPageState();
}

class _FolderVideosPageState extends ConsumerState<FolderVideosPage> {
  final List<FavoriteVideo> _videos = [];
  int _page = 0;
  bool _hasMore = true;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_loading || !_hasMore) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref
          .read(favoritesApiProvider)
          .listVideos(widget.folder.mediaId, page: _page + 1, pageSize: 20);
      if (!mounted) return;
      setState(() {
        _videos.addAll(res.videos);
        _page = res.page;
        _hasMore = res.hasMore;
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

  /// 触发知识库构建并轮询进度。
  Future<void> _buildKnowledge() async {
    try {
      final res = await ref
          .read(knowledgeApiProvider)
          .build(folderIds: [widget.folder.id]);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (_) => _BuildProgressDialog(taskId: res.taskId),
      );
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
      appBar: AppBar(
        title: Text(widget.folder.title),
        actions: [
          IconButton(
            tooltip: '构建知识库（ASR+向量化）',
            icon: const Icon(Icons.model_training),
            onPressed: _buildKnowledge,
          ),
        ],
      ),
      body: _error != null && _videos.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_error!),
                  const SizedBox(height: 12),
                  OutlinedButton(
                      onPressed: () => runAfterGesture(_loadMore),
                      child: const Text('重试')),
                ],
              ),
            )
          : ListView.builder(
              itemCount: _videos.length + (_hasMore || _loading ? 1 : 0),
              itemBuilder: (context, i) {
                if (i >= _videos.length) {
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
                final v = _videos[i];
                return ListTile(
                  leading: v.cover != null && v.cover!.isNotEmpty
                      ? ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: Image.network(
                            v.cover!,
                            width: 72,
                            height: 44,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) =>
                                const SizedBox(width: 72, height: 44),
                          ),
                        )
                      : const Icon(Icons.movie_outlined),
                  title: Text(v.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                    [v.owner, formatDuration(v.duration)]
                        .whereType<String>()
                        .where((s) => s.isNotEmpty)
                        .join(' · '),
                    style: const TextStyle(fontSize: 12.5),
                  ),
                  onTap: () => _showPages(v),
                );
              },
            ),
    );
  }

  Future<void> _showPages(FavoriteVideo v) async {
    await showGlassSheet<void>(
      context: context,
      builder: (_) => _VideoPagesSheet(video: v, folderId: widget.folder.id),
    );
  }
}

/// 分P 状态面板：ASR（is_processed）+ 向量化状态 + 笔记/移除入口。
class _VideoPagesSheet extends ConsumerStatefulWidget {
  const _VideoPagesSheet({required this.video, required this.folderId});

  final FavoriteVideo video;
  final int folderId;

  @override
  ConsumerState<_VideoPagesSheet> createState() => _VideoPagesSheetState();
}

class _VideoPagesSheetState extends ConsumerState<_VideoPagesSheet> {
  VideoPageList? _pages;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final pages =
          await ref.read(favoritesApiProvider).listVideoPages(widget.video.bvid);
      if (mounted) setState(() => _pages = pages);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.video;
    return SafeArea(
      child: _error != null
          ? Padding(
              padding: const EdgeInsets.all(24),
              child: Text(_error!, textAlign: TextAlign.center))
          : _pages == null
              ? const Padding(
                  padding: EdgeInsets.all(32),
                  child: Center(child: CircularProgressIndicator()))
              : ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  children: [
                    Text(v.title,
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(v.bvid, style: const TextStyle(fontSize: 12.5, color: Colors.grey)),
                    const SizedBox(height: 12),
                    for (final p in _pages!.pages)
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        leading: Text('P${p.pageIndex + 1}'),
                        title: Text(p.pageTitle ?? v.title,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(
                          'ASR: ${p.isProcessed ? '已完成' : '未处理'}'
                          '${p.vectorChunkCount > 0 ? ' · 向量块 ${p.vectorChunkCount}' : ''}',
                          style: const TextStyle(fontSize: 11),
                        ),
                        trailing: StatusBadge(status: p.isVectorized),
                      ),
                    const Divider(),
                    Wrap(
                      spacing: 10,
                      children: [
                        OutlinedButton.icon(
                          icon: const Icon(Icons.note_add, size: 16),
                          label: const Text('为该视频写笔记'),
                          onPressed: () async {
                            Navigator.pop(context);
                            final uuid = await _createNoteForVideo(context);
                            if (uuid != null && context.mounted) {
                              await Navigator.of(context)
                                  .pushNamed('/notes/$uuid');
                            }
                          },
                        ),
                        OutlinedButton.icon(
                          icon: const Icon(Icons.quiz_outlined, size: 16),
                          label: const Text('为该视频出题'),
                          onPressed: () async {
                            Navigator.pop(context);
                            await _generateQuizForVideo(context);
                          },
                        ),
                        OutlinedButton.icon(
                          icon: const Icon(Icons.delete_outline, size: 16),
                          label: const Text('从知识库移除'),
                          onPressed: () async {
                            final ok = await showDialog<bool>(
                              context: context,
                              builder: (ctx) => AlertDialog(
                                title: const Text('移除出知识库'),
                                content: Text('删除 ${v.bvid} 的全部向量数据？'),
                                actions: [
                                  TextButton(
                                      onPressed: () => Navigator.pop(ctx, false),
                                      child: const Text('取消')),
                                  FilledButton(
                                      onPressed: () => Navigator.pop(ctx, true),
                                      child: const Text('删除')),
                                ],
                              ),
                            );
                            if (ok == true) {
                              try {
                                await ref
                                    .read(knowledgeApiProvider)
                                    .deleteVideo(v.bvid);
                                if (context.mounted) Navigator.pop(context);
                              } on ApiException catch (e) {
                                if (context.mounted) {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(content: Text(e.message)));
                                }
                              }
                            }
                          },
                        ),
                      ],
                    ),
                  ],
                ),
    );
  }

  Future<String?> _createNoteForVideo(BuildContext context) async {
    try {
      final detail = await ref.read(notesApiProvider).create(
            targetType: 'video',
            targetId: widget.video.bvid,
            title: widget.video.title,
          );
      return detail.meta.uuid;
    } on ApiException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
      return null;
    }
  }

  /// 为该视频出题：quiz.generate（folder_ids CSV + 本视频分P 数组），
  /// 轮询生成完成后进入答题页。
  Future<void> _generateQuizForVideo(BuildContext context) async {
    final pages = _pages;
    if (pages == null || pages.pages.isEmpty) return;
    try {
      final res = await ref.read(quizApiProvider).generate(
            folderIds: [widget.folderId],
            pages: [
              for (final p in pages.pages)
                {
                  'bvid': widget.video.bvid,
                  'cid': p.cid,
                  'page_index': p.pageIndex,
                  if (p.pageTitle != null) 'page_title': p.pageTitle,
                },
            ],
            title: widget.video.title,
          );
      if (!context.mounted) return;

      var pollStarted = false;
      final ready = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (dialogCtx) {
          if (!pollStarted) {
            pollStarted = true;
            Future<void>.microtask(() async {
              var quiz =
                  await ref.read(quizApiProvider).getQuiz(res.quizUuid);
              var tries = 0;
              while (quiz.questions.isEmpty &&
                  quiz.status == 'generating' &&
                  tries < 40) {
                await Future<void>.delayed(const Duration(seconds: 3));
                quiz =
                    await ref.read(quizApiProvider).getQuiz(res.quizUuid);
                tries++;
              }
              if (dialogCtx.mounted) {
                Navigator.pop(dialogCtx, quiz.questions.isNotEmpty);
              }
            });
          }
          return const AlertDialog(
            title: Text('AI 正在出题…'),
            content: SizedBox(
              width: 160,
              child: LinearProgressIndicator(),
            ),
          );
        },
      );
      if (ready != true || !context.mounted) return;

      final quiz = await ref.read(quizApiProvider).getQuiz(res.quizUuid);
      if (!context.mounted) return;
      if (quiz.questions.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('题目尚未就绪，稍后可在测验页重试')),
        );
        return;
      }
      await Navigator.of(context, rootNavigator: true).push(
        MaterialPageRoute(builder: (_) => QuizTakePage(quiz: quiz)),
      );
    } on ApiException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }
}

/// 知识库构建进度弹窗（轮询 /knowledge/build/status/{taskId}）。
class _BuildProgressDialog extends ConsumerStatefulWidget {
  const _BuildProgressDialog({required this.taskId});

  final String taskId;

  @override
  ConsumerState<_BuildProgressDialog> createState() =>
      _BuildProgressDialogState();
}

class _BuildProgressDialogState extends ConsumerState<_BuildProgressDialog> {
  BuildStatus? _status;
  bool _dismissed = false;

  @override
  void initState() {
    super.initState();
    _poll();
  }

  @override
  void dispose() {
    _dismissed = true;
    super.dispose();
  }

  Future<void> _poll() async {
    await Future<void>.delayed(const Duration(seconds: 3));
    if (_dismissed || !mounted) return;
    try {
      final s =
          await ref.read(knowledgeApiProvider).getBuildStatus(widget.taskId);
      if (!mounted) return;
      setState(() => _status = s);
      if (s.isTerminal) {
        await Future<void>.delayed(const Duration(milliseconds: 800));
        if (mounted && !_dismissed) Navigator.pop(context);
      } else {
        _poll();
      }
    } on ApiException catch (_) {
      if (mounted && !_dismissed) _poll();
    }
  }

  @override
  Widget build(BuildContext context) => _Body(status: _status);
}

class _Body extends StatelessWidget {
  const _Body({this.status});

  final BuildStatus? status;

  @override
  Widget build(BuildContext context) {
    final s = status;
    return AlertDialog(
      title: const Text('知识库构建'),
      content: s == null
          ? const SizedBox(
              width: 200,
              child: Center(child: CircularProgressIndicator()))
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    StatusBadge(status: s.status),
                    const Spacer(),
                    Text('${s.processedVideos}/${s.totalVideos}'),
                  ],
                ),
                const SizedBox(height: 12),
                LinearProgressIndicator(value: s.progress / 100),
                const SizedBox(height: 8),
                if (s.currentStep != null && s.currentStep!.isNotEmpty)
                  Text(s.currentStep!, style: const TextStyle(fontSize: 12.5)),
                if (s.message != null && s.message!.isNotEmpty)
                  Text(s.message!, style: const TextStyle(fontSize: 12.5)),
              ],
            ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
      ],
    );
  }
}
