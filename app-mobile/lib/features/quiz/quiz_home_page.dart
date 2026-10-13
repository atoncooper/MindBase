import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/quiz.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/status_badge.dart';
import 'quiz_take_page.dart';

/// 测验首页：历史 + 错题本 + AI 出题（自由主题 / 错题重练）。
class QuizHomePage extends ConsumerStatefulWidget {
  const QuizHomePage({super.key});

  @override
  ConsumerState<QuizHomePage> createState() => _QuizHomePageState();
}

class _QuizHomePageState extends ConsumerState<QuizHomePage>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  final List<QuizHistoryItem> _history = [];
  int _page = 0;
  bool _hasMore = true;
  bool _loading = false;
  String? _error;

  List<WrongAnswerItem>? _wrong;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _loadHistory();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref
          .read(quizApiProvider)
          .getHistory(page: _page + 1, pageSize: 20);
      if (!mounted) return;
      setState(() {
        _history.addAll(res);
        _page += 1;
        _hasMore = res.length >= 20;
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

  Future<void> _loadWrong() async {
    try {
      final list = await ref.read(quizApiProvider).getWrongAnswers();
      if (mounted) setState(() => _wrong = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _wrong = []);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// 打开测验：生成中的先轮询直至题目就绪。
  Future<void> _openQuiz(String quizUuid) async {
    try {
      var quiz = await ref.read(quizApiProvider).getQuiz(quizUuid);
      if (!mounted) return;
      if (quiz.questions.isEmpty && (quiz.status == 'generating' || quiz.status == 'pending')) {
        final ready = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (dialogCtx) => _PollQuizReadyDialog(
            quizUuid: quizUuid,
            onReady: () => Navigator.of(dialogCtx).pop(true),
          ),
        );
        if (ready != true) return;
        quiz = await ref.read(quizApiProvider).getQuiz(quizUuid);
      }
      if (!mounted) return;
      if (quiz.questions.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('题目尚未就绪（${quiz.errorMessage ?? quiz.status}）')));
        return;
      }
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => QuizTakePage(quiz: quiz),
      ));
      setState(() {
        _history.clear();
        _page = 0;
        _hasMore = true;
      });
      _loadHistory();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _aiGenerate() async {
    final created = await showDialog<String>(
      context: context,
      builder: (ctx) => const _AiGenerateDialog(),
    );
    if (created == null) return;
    await _openQuiz(created);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('测验'),
        bottom: TabBar(
          controller: _tabs,
          onTap: (i) {
            if (i == 1 && _wrong == null) _loadWrong();
          },
          tabs: const [Tab(text: '历史'), Tab(text: '错题本')],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _aiGenerate,
        icon: const Icon(Icons.fact_check_outlined),
        label: const Text('AI 出题'),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [_buildHistory(), _buildWrong()],
      ),
    );
  }

  Widget _buildHistory() {
    return RefreshIndicator(
      onRefresh: () async {
        setState(() {
          _history.clear();
          _page = 0;
          _hasMore = true;
        });
        await _loadHistory();
      },
      child: ListView.separated(
        itemCount: _history.length + (_hasMore || _loading ? 1 : 0),
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          if (i >= _history.length) {
            if (_error != null) {
              return Padding(
                padding: const EdgeInsets.all(16),
                child: Center(child: Text(_error!)),
              );
            }
            // 构建期不能 setState：排到帧末再加载下一页
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted && !_loading && _hasMore) _loadHistory();
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
          final h = _history[i];
          return ListTile(
            title: Text(h.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(
              '${formatDateTimeIso(h.submittedAt)} · 正确 ${h.correctCount}/${h.totalQuestionCount}'
              '${h.timeSpentSeconds != null ? ' · ${formatDuration(h.timeSpentSeconds)}' : ''}',
              style: const TextStyle(fontSize: 12.5),
            ),
            trailing: h.passed == null
                ? StatusBadge(status: h.status)
                : Icon(
                    h.passed == true ? Icons.check_circle : Icons.cancel,
                    color: h.passed == true ? Colors.green : Colors.red,
                  ),
            onTap: () => _openQuiz(h.quizUuid),
          );
        },
      ),
    );
  }

  Widget _buildWrong() {
    final wrong = _wrong;
    if (wrong == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (wrong.isEmpty) {
      return const Center(child: Text('太棒了，暂无错题', style: TextStyle(color: Colors.grey)));
    }
    return ListView.separated(
      itemCount: wrong.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final w = wrong[i];
        return ListTile(
          leading: Badge(
            label: Text('${w.timesWrong}'),
            child: const Icon(Icons.error_outline),
          ),
          title: Text(w.questionText, maxLines: 2, overflow: TextOverflow.ellipsis),
          subtitle: Text(
            '你的答案：${w.userAnswer.isEmpty ? '-' : w.userAnswer}',
            style: const TextStyle(fontSize: 12.5),
          ),
          onTap: () => showGlassSheet<void>(
            context: context,
            builder: (_) => SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(w.questionText,
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 12),
                    Text('你的答案：${w.userAnswer.isEmpty ? '-' : w.userAnswer}'),
                    Text('正确答案：${w.correctAnswer ?? '-'}'),
                    if (w.explanation != null) ...[
                      const SizedBox(height: 8),
                      Text(w.explanation!, style: const TextStyle(fontSize: 13)),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// AI 出题弹窗：mode = free（主题）/ wrong_answers（错题重练）。
class _AiGenerateDialog extends ConsumerStatefulWidget {
  const _AiGenerateDialog();

  @override
  ConsumerState<_AiGenerateDialog> createState() => _AiGenerateDialogState();
}

class _AiGenerateDialogState extends ConsumerState<_AiGenerateDialog> {
  String _mode = 'free';
  final _topicCtrl = TextEditingController();
  int _count = 5;
  String _difficulty = 'medium';
  bool _busy = false;

  @override
  void dispose() {
    _topicCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      final res = await ref.read(quizApiProvider).generateAI(
            mode: _mode,
            topic: _mode == 'free' ? _topicCtrl.text.trim() : null,
            questionCount: _count,
            difficulty: _difficulty,
          );
      if (mounted) Navigator.pop(context, res.quizUuid);
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
      title: const Text('AI 出题'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'free', label: Text('自由主题')),
              ButtonSegment(value: 'wrong_answers', label: Text('错题重练')),
            ],
            selected: {_mode},
            onSelectionChanged: (s) => setState(() => _mode = s.first),
          ),
          const SizedBox(height: 12),
          if (_mode == 'free')
            TextField(
              controller: _topicCtrl,
              decoration: const InputDecoration(labelText: '主题'),
            ),
          const SizedBox(height: 12),
          Row(
            children: [
              const Text('题数'),
              Expanded(
                child: Slider(
                  value: _count.toDouble(),
                  min: 1,
                  max: 10,
                  divisions: 9,
                  label: '$_count',
                  onChanged: (v) => setState(() => _count = v.round()),
                ),
              ),
            ],
          ),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'easy', label: Text('简单')),
              ButtonSegment(value: 'medium', label: Text('中等')),
              ButtonSegment(value: 'hard', label: Text('困难')),
            ],
            selected: {_difficulty},
            onSelectionChanged: (s) => setState(() => _difficulty = s.first),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(_busy ? '生成中...' : '生成'),
        ),
      ],
    );
  }
}

/// 轮询 AI 出题完成（题目就绪即回调）。
class _PollQuizReadyDialog extends ConsumerStatefulWidget {
  const _PollQuizReadyDialog({required this.quizUuid, required this.onReady});

  final String quizUuid;
  final VoidCallback onReady;

  @override
  ConsumerState<_PollQuizReadyDialog> createState() =>
      _PollQuizReadyDialogState();
}

class _PollQuizReadyDialogState extends ConsumerState<_PollQuizReadyDialog> {
  int _tries = 0;
  String _status = 'generating';

  @override
  void initState() {
    super.initState();
    _poll();
  }

  Future<void> _poll() async {
    if (!mounted) return;
    await Future<void>.delayed(const Duration(seconds: 3));
    if (!mounted) return;
    _tries++;
    if (_tries > 40) {
      if (mounted) Navigator.pop(context);
      return;
    }
    try {
      final quiz = await ref.read(quizApiProvider).getQuiz(widget.quizUuid);
      if (!mounted) return;
      setState(() => _status = quiz.status);
      if (quiz.questions.isNotEmpty ||
          quiz.status == 'done' ||
          quiz.status == 'completed' ||
          quiz.status == 'failed') {
        if (quiz.questions.isNotEmpty) widget.onReady();
        if (mounted) Navigator.pop(context);
        return;
      }
      _poll();
    } on ApiException catch (_) {
      if (mounted) _poll();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('AI 正在出题…'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const LinearProgressIndicator(),
          const SizedBox(height: 12),
          Text('状态：$_status'),
        ],
      ),
    );
  }
}
