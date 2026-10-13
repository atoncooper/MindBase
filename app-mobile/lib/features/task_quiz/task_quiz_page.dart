import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/task_quiz.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/status_badge.dart';

/// 定时测验任务：列表 / 详情作答 / 新建任务。
class TaskQuizPage extends ConsumerStatefulWidget {
  const TaskQuizPage({super.key});

  @override
  ConsumerState<TaskQuizPage> createState() => _TaskQuizPageState();
}

class _TaskQuizPageState extends ConsumerState<TaskQuizPage> {
  List<TaskQuizListItem>? _tasks;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final tasks = await ref.read(taskQuizApiProvider).listTasks();
      if (mounted) setState(() => _tasks = tasks);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _create() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (ctx) => const _CreateTaskDialog(),
    );
    if (created == true) _load();
  }

  Future<void> _delete(TaskQuizListItem t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除任务'),
        content: const Text('确定删除该定时出题任务？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(taskQuizApiProvider).deleteTask(t.taskId);
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _openDetail(TaskQuizListItem item) async {
    try {
      final detail = await ref.read(taskQuizApiProvider).getTask(item.taskId);
      if (!mounted) return;
      await showGlassSheet<void>(
        context: context,
        isScrollControlled: true,
        withHandle: false,
        builder: (_) => _TaskDetailSheet(detail: detail),
      );
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.isNotFound) {
        // trigger_time 前业务详情 404：用列表项兜底展示（对齐 web 端）
        await showGlassSheet<void>(
          context: context,
          builder: (_) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item.prompt ?? '',
                      style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  Text('触发时间：${formatDateTimeIso(item.triggerTime)}'),
                  Text('状态：${kStatusLabels[item.status] ?? item.status}'),
                  const SizedBox(height: 8),
                  const Text('题目将在触发时间生成，稍后回来作答。',
                      style: TextStyle(color: Colors.grey, fontSize: 12.5)),
                ],
              ),
            ),
          ),
        );
        return;
      }
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final tasks = _tasks;
    return Scaffold(
      appBar: AppBar(title: const Text('定时测验')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.alarm_add),
        label: const Text('新建任务'),
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
          : tasks == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: tasks.isEmpty
                      ? ListView(children: const [
                          Padding(
                            padding: EdgeInsets.all(40),
                            child: Center(
                                child: Text('暂无任务，点右下角新建',
                                    style: TextStyle(color: Colors.grey))),
                          ),
                        ])
                      : ListView.separated(
                          itemCount: tasks.length,
                          separatorBuilder: (_, __) => const Divider(height: 1),
                          itemBuilder: (context, i) {
                            final t = tasks[i];
                            return ListTile(
                              title: Text(t.prompt ?? '',
                                  maxLines: 2, overflow: TextOverflow.ellipsis),
                              subtitle: Text(
                                '触发：${formatDateTimeIso(t.triggerTime)}'
                                '${t.questionCount != null ? ' · ${t.questionCount} 题' : ''}',
                                style: const TextStyle(fontSize: 12.5),
                              ),
                              trailing: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  StatusBadge(status: t.status),
                                  PopupMenuButton<String>(
                                    onSelected: (v) {
                                      if (v == 'delete') _delete(t);
                                    },
                                    itemBuilder: (_) => const [
                                      PopupMenuItem(value: 'delete', child: Text('删除')),
                                    ],
                                  ),
                                ],
                              ),
                              onTap: () => _openDetail(t),
                            );
                          },
                        ),
                ),
    );
  }
}

/// 任务详情 + 作答面板（填空/简答文本框；选择题选项单选）。
class _TaskDetailSheet extends ConsumerStatefulWidget {
  const _TaskDetailSheet({required this.detail});

  final TaskQuizDetail detail;

  @override
  ConsumerState<_TaskDetailSheet> createState() => _TaskDetailSheetState();
}

class _TaskDetailSheetState extends ConsumerState<_TaskDetailSheet> {
  late final List<String?> _answers;
  bool _submitting = false;
  String? _resultMessage;

  @override
  void initState() {
    super.initState();
    _answers = List<String?>.filled(widget.detail.questions.length, null);
  }

  Future<void> _submit() async {
    final unanswered = <int>[];
    for (var i = 0; i < _answers.length; i++) {
      if (_answers[i] == null || _answers[i]!.trim().isEmpty) unanswered.add(i);
    }
    if (unanswered.isNotEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('还有 ${unanswered.length} 题未作答，全部作答后才能提交')));
      return;
    }
    setState(() => _submitting = true);
    try {
      final res = await ref.read(taskQuizApiProvider).submitAnswer(
            taskId: widget.detail.taskId,
            answers: [
              for (var i = 0; i < _answers.length; i++)
                {'question_index': i, 'answer': _answers[i]!.trim()},
            ],
          );
      if (!mounted) return;
      setState(() {
        _resultMessage =
            '已提交（${res.status}）· 正确 ${res.results.where((r) => r.isCorrect == true).length}/${res.results.length}';
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _resultMessage = e.message);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.detail;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      builder: (context, scrollCtrl) => ListView(
        controller: scrollCtrl,
        padding: const EdgeInsets.all(20),
        children: [
          Text(d.prompt, style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Row(
            children: [
              StatusBadge(status: d.status),
              const SizedBox(width: 8),
              if (d.deadline != null)
                Text('截止：${formatDateTimeIso(d.deadline)}',
                    style: const TextStyle(fontSize: 12.5, color: Colors.grey)),
            ],
          ),
          const Divider(height: 24),
          if (d.questions.isEmpty)
            const Text('题目尚未生成', style: TextStyle(color: Colors.grey))
          else ...[
            for (var i = 0; i < d.questions.length; i++)
              _buildQuestion(i, d.questions[i]),
            const SizedBox(height: 12),
            if (_resultMessage != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_resultMessage!),
              ),
            FilledButton(
              onPressed: _submitting || d.questions.isEmpty ? null : _submit,
              child: Text(_submitting ? '提交中...' : '提交答案'),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildQuestion(int index, TaskQuizQuestion q) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${index + 1}. ${q.question}',
                style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text('${q.questionType} · ${q.difficulty} · 限时 ${q.answerTimeLimitSeconds}s',
                style: const TextStyle(fontSize: 11, color: Colors.grey)),
            const SizedBox(height: 8),
            if (q.options != null && q.options!.isNotEmpty)
              RadioGroup<String>(
                groupValue: _answers[index],
                onChanged: (v) => setState(() => _answers[index] = v),
                child: Column(
                  children: [
                    for (final opt in q.options!)
                      RadioListTile<String>(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        value: opt,
                        title: Text(opt),
                      ),
                  ],
                ),
              )
            else
              TextField(
                maxLines: q.questionType == 'short_answer' ? 3 : 1,
                onChanged: (v) => _answers[index] = v,
                decoration: const InputDecoration(hintText: '输入答案'),
              ),
          ],
        ),
      ),
    );
  }
}

/// 新建定时出题任务。
class _CreateTaskDialog extends ConsumerStatefulWidget {
  const _CreateTaskDialog();

  @override
  ConsumerState<_CreateTaskDialog> createState() => _CreateTaskDialogState();
}

class _CreateTaskDialogState extends ConsumerState<_CreateTaskDialog> {
  final _promptCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  DateTime _trigger = DateTime.now().add(const Duration(hours: 1));
  String _difficulty = 'medium';
  int _count = 3;
  bool _busy = false;

  @override
  void dispose() {
    _promptCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _trigger,
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_trigger),
    );
    if (time == null || !mounted) return;
    setState(() {
      _trigger = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    });
  }

  Future<void> _submit() async {
    final prompt = _promptCtrl.text.trim();
    if (prompt.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请填写出题要求')));
      return;
    }
    setState(() => _busy = true);
    try {
      final emails = _emailCtrl.text
          .split(',')
          .map((e) => e.trim())
          .where((e) => e.isNotEmpty)
          .toList();
      await ref.read(taskQuizApiProvider).register(
            prompt: prompt,
            triggerTimeIsoUtc: _trigger.toUtc().toIso8601String(),
            ccEmails: emails,
            difficulty: _difficulty,
            questionCount: _count,
          );
      if (mounted) Navigator.pop(context, true);
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
      title: const Text('新建定时出题'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _promptCtrl,
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: '出题要求',
                hintText: '例如：围绕 B 站上收藏的 RAG 相关视频出 3 道选择题',
              ),
            ),
            const SizedBox(height: 12),
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: const Icon(Icons.schedule),
              title: Text(formatDateTimeIso(_trigger.toIso8601String())),
              onTap: _pickTime,
            ),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'easy', label: Text('简单')),
                ButtonSegment(value: 'medium', label: Text('中等')),
                ButtonSegment(value: 'hard', label: Text('困难')),
              ],
              selected: {_difficulty},
              onSelectionChanged: (s) => setState(() => _difficulty = s.first),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                const Text('题数'),
                Expanded(
                  child: Slider(
                    value: _count.toDouble(),
                    min: 1,
                    max: 5,
                    divisions: 4,
                    label: '$_count',
                    onChanged: (v) => setState(() => _count = v.round()),
                  ),
                ),
              ],
            ),
            TextField(
              controller: _emailCtrl,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: '抄送邮箱（可选，逗号分隔）',
              ),
            ),
          ],
        ),
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
