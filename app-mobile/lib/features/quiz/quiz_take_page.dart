import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/quiz.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';

/// 答题页：选择/填空/简答 → 提交 → 逐题结果（对错/正确答案/解析）。
class QuizTakePage extends ConsumerStatefulWidget {
  const QuizTakePage({super.key, required this.quiz});

  final QuizSet quiz;

  @override
  ConsumerState<QuizTakePage> createState() => _QuizTakePageState();
}

class _QuizTakePageState extends ConsumerState<QuizTakePage> {
  final Map<String, String> _answers = {};
  final Map<String, TextEditingController> _textCtrls = {};
  late final DateTime _startedAt;
  QuizSubmissionResult? _result;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _startedAt = DateTime.now();
    for (final q in widget.quiz.questions) {
      _textCtrls[q.questionUuid] = TextEditingController();
    }
  }

  @override
  void dispose() {
    for (final c in _textCtrls.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    final unanswered =
        widget.quiz.questions.where((q) => (_answers[q.questionUuid] ?? '').isEmpty);
    if (unanswered.isNotEmpty) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('还有 ${unanswered.length} 题未作答'),
          content: const Text('未答题目将按错误计分，确定提交？'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('继续作答')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('提交')),
          ],
        ),
      );
      if (ok != true) return;
    }
    setState(() => _submitting = true);
    try {
      final res = await ref.read(quizApiProvider).submit(
            quizUuid: widget.quiz.quizUuid,
            answers: [
              for (final q in widget.quiz.questions)
                {'question_uuid': q.questionUuid, 'answer': _answers[q.questionUuid] ?? ''},
            ],
            timeSpentSeconds: DateTime.now().difference(_startedAt).inSeconds,
          );
      if (mounted) setState(() => _result = res);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.quiz.title),
        actions: [
          if (result == null)
            TextButton(
              onPressed: _submitting ? null : _submit,
              child: Text(_submitting ? '提交中...' : '交卷'),
            ),
        ],
      ),
      body: result == null ? _buildQuestions() : _buildResult(result),
    );
  }

  Widget _buildQuestions() {
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: widget.quiz.questions.length,
      itemBuilder: (context, i) {
        final q = widget.quiz.questions[i];
        return Card(
          margin: const EdgeInsets.only(bottom: 12),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${i + 1}. ${q.questionText}',
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text('${q.questionType} · ${q.difficulty}',
                    style: const TextStyle(fontSize: 11, color: Colors.grey)),
                const SizedBox(height: 8),
                if (q.options.isNotEmpty)
                  RadioGroup<String>(
                    groupValue: _answers[q.questionUuid],
                    onChanged: (v) =>
                        setState(() => _answers[q.questionUuid] = v ?? ''),
                    child: Column(
                      children: [
                        for (final opt in q.options)
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
                    controller: _textCtrls[q.questionUuid],
                    maxLines: q.questionType == 'short_answer' ? 3 : 1,
                    onChanged: (v) => _answers[q.questionUuid] = v,
                    decoration: const InputDecoration(hintText: '输入答案'),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildResult(QuizSubmissionResult r) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                Icon(
                  r.passed == true ? Icons.emoji_events : Icons.flag,
                  size: 44,
                  color: r.passed == true ? Colors.amber : Colors.grey,
                ),
                const SizedBox(height: 8),
                Text(
                  '${r.score ?? '-'} 分 / ${widget.quiz.totalScore} 分',
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
                Text('正确 ${r.correctCount}/${r.totalCount} · '
                    '${r.passed == true ? '通过' : (r.passed == null ? '待批改' : '未通过（及格 ${widget.quiz.passingScore} 分）')}'),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        for (final item in r.results)
          _buildOneResult(item),
      ],
    );
  }

  Widget _buildOneResult(QuizAnswerResult item) {
    QuizQuestion? q;
    for (final x in widget.quiz.questions) {
      if (x.questionUuid == item.questionUuid) {
        q = x;
        break;
      }
    }
    final corrects = item.correctAnswer is List
        ? [for (final e in (item.correctAnswer as List)) e.toString()]
        : (item.correctAnswer is String && (item.correctAnswer as String).isNotEmpty
            ? [item.correctAnswer as String]
            : const <String>[]);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: Icon(
          item.needsManualGrading
              ? Icons.hourglass_top
              : (item.isCorrect == true ? Icons.check_circle : Icons.cancel),
          color: item.needsManualGrading
              ? Colors.orange
              : (item.isCorrect == true ? Colors.green : Colors.red),
        ),
        title: Text(q?.questionText ?? item.questionUuid,
            maxLines: 2, overflow: TextOverflow.ellipsis),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('你的答案：${_answers[item.questionUuid] ?? '-'}',
                style: const TextStyle(fontSize: 12.5)),
            if (corrects.isNotEmpty)
              Text('正确答案：${corrects.join('；')}',
                  style: const TextStyle(fontSize: 12.5)),
            if (item.gradingNote != null)
              Text(item.gradingNote!, style: const TextStyle(fontSize: 12.5)),
            if (q?.explanation != null && q!.explanation!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(q.explanation!,
                    style: const TextStyle(fontSize: 12.5, color: Colors.grey)),
              ),
          ],
        ),
      ),
    );
  }
}
