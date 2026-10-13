import 'client.dart';

/// TaskQuiz API — 定时出题任务（app-task 执行器 + 主 app agent 出题）。
/// 契约对齐 frontendv2/lib/api/task-quiz.ts；响应经 client 统一 snake→camel。
///
/// ⚠️ 双状态词表：调度视角 pending/running/completed/failed；
/// 业务视角 generating/awaiting_answer/completed/overdue/failed。
/// trigger_time 前业务详情 404（行只在生成时创建）——用列表项兜底展示。

class TaskQuizListItem {
  TaskQuizListItem({
    required this.taskId,
    required this.taskType,
    required this.status,
    required this.triggerTime,
    this.prompt,
    this.difficulty,
    this.questionCount,
    this.ccEmails = const [],
  });

  final String taskId;
  final String taskType;
  final String status;
  final String triggerTime;

  // payload 展开（wire: payload.prompt / payload.difficulty / ...）
  final String? prompt;
  final String? difficulty;
  final int? questionCount;
  final List<String> ccEmails;

  factory TaskQuizListItem.fromMap(Map<String, dynamic> m) {
    final payload = m['payload'] is Map ? asMap(m['payload']) : null;
    return TaskQuizListItem(
      taskId: m['taskId'] as String? ?? '',
      taskType: m['taskType'] as String? ?? '',
      status: m['status'] as String? ?? '',
      triggerTime: m['triggerTime'] as String? ?? '',
      prompt: payload?['prompt'] as String?,
      difficulty: payload?['difficulty'] as String?,
      questionCount: (payload?['questionCount'] as num?)?.toInt(),
      ccEmails: [
        for (final e in (payload?['ccEmails'] as List? ?? const []))
          e.toString(),
      ],
    );
  }
}

class TaskQuizQuestion {
  TaskQuizQuestion({
    required this.question,
    required this.questionType,
    this.options,
    required this.difficulty,
    required this.answerTimeLimitSeconds,
  });

  final String question;

  /// choice | fill_blank | short_answer
  final String questionType;
  final List<String>? options;
  final String difficulty;
  final int answerTimeLimitSeconds;

  factory TaskQuizQuestion.fromMap(Map<String, dynamic> m) =>
      TaskQuizQuestion(
        question: m['question'] as String? ?? '',
        questionType: m['questionType'] as String? ?? '',
        options: (m['options'] as List?)?.map((e) => e.toString()).toList(),
        difficulty: m['difficulty'] as String? ?? '',
        answerTimeLimitSeconds:
            (m['answerTimeLimitSeconds'] as num?)?.toInt() ?? 0,
      );
}

class TaskQuizAnswerItem {
  TaskQuizAnswerItem({
    required this.questionIndex,
    required this.answer,
    this.isCorrect,
    required this.submittedAt,
  });

  final int questionIndex; // 0-based
  final String answer;
  final bool? isCorrect;
  final String submittedAt;

  factory TaskQuizAnswerItem.fromMap(Map<String, dynamic> m) =>
      TaskQuizAnswerItem(
        questionIndex: (m['questionIndex'] as num?)?.toInt() ?? 0,
        answer: m['answer'] as String? ?? '',
        isCorrect: m['isCorrect'] as bool?,
        submittedAt: m['submittedAt'] as String? ?? '',
      );
}

class TaskQuizDetail {
  TaskQuizDetail({
    required this.taskId,
    required this.prompt,
    required this.difficulty,
    required this.status,
    this.deadline,
    this.ccEmails = const [],
    this.questions = const [],
    this.answers = const [],
  });

  final String taskId;
  final String prompt;
  final String difficulty;
  final String status;
  final String? deadline;
  final List<String> ccEmails;
  final List<TaskQuizQuestion> questions;
  final List<TaskQuizAnswerItem> answers;

  factory TaskQuizDetail.fromMap(Map<String, dynamic> m) {
    final quiz = m['quiz'] is Map ? asMap(m['quiz']) : null;
    return TaskQuizDetail(
      taskId: m['taskId'] as String? ?? '',
      prompt: m['prompt'] as String? ?? '',
      difficulty: m['difficulty'] as String? ?? '',
      status: m['status'] as String? ?? '',
      deadline: m['deadline'] as String?,
      ccEmails: [
        for (final e in (m['ccEmails'] as List? ?? const [])) e.toString(),
      ],
      questions: [
        for (final q in (quiz?['questions'] as List? ?? const []))
          TaskQuizQuestion.fromMap(asMap(q)),
      ],
      answers: [
        for (final a in (m['answers'] as List? ?? const []))
          TaskQuizAnswerItem.fromMap(asMap(a)),
      ],
    );
  }
}

class TaskQuizApi {
  TaskQuizApi(this._client);

  final ApiClient _client;

  /// 注册定时出题任务（trigger_time 为 ISO8601 UTC）。
  Future<({String taskId, String status})> register({
    required String prompt,
    required String triggerTimeIsoUtc,
    required List<String> ccEmails,
    required String difficulty,
    required int questionCount,
    String? incompleteMessage,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/task-quiz/register',
      body: {
        'prompt': prompt,
        'trigger_time': triggerTimeIsoUtc,
        'cc_emails': ccEmails,
        'incomplete_message': incompleteMessage,
        'difficulty': difficulty,
        'question_count': questionCount,
      },
    ));
    return (
      taskId: m['taskId'] as String? ?? '',
      status: m['status'] as String? ?? '',
    );
  }

  /// 任务列表（过滤掉无 payload.prompt 的条目，对齐 web 端）。
  Future<List<TaskQuizListItem>> listTasks() async {
    final m = asMap(await _client.request(
      'GET',
      '/tasks',
      query: {'domain': 'task_quiz'},
    ));
    return [
      for (final e in (m['tasks'] as List? ?? const []))
        if (TaskQuizListItem.fromMap(asMap(e)).prompt != null)
          TaskQuizListItem.fromMap(asMap(e)),
    ];
  }

  Future<TaskQuizDetail> getTask(String taskId) async =>
      TaskQuizDetail.fromMap(asMap(
        await _client.request('GET', '/tasks/$taskId/detail'),
      ));

  /// 删除任务（生成中 409）。
  Future<void> deleteTask(String taskId) async {
    await _client.request('DELETE', '/tasks/$taskId');
  }

  /// 提交答案（question_index 0-based，注意与支付 PartNumber 的 1-based 区分）。
  Future<({String status, List<TaskQuizAnswerItem> results})> submitAnswer({
    required String taskId,
    required List<Map<String, dynamic>> answers,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/tasks/$taskId/answer',
      body: {'answers': answers},
    ));
    return (
      status: m['status'] as String? ?? '',
      results: [
        for (final r in (m['results'] as List? ?? const []))
          TaskQuizAnswerItem.fromMap(asMap(r)),
      ],
    );
  }

  /// 任务对话 SSE（帧为 chunk|tool|done|error 的简化协议；
  /// 复用 consumeChatStream：chunk/done/error 语义一致，tool 帧忽略）。
  Future<Stream<List<int>>> streamChat({required String message}) {
    return _client.streamPost('/task-quiz/chat', body: {'message': message});
  }
}
