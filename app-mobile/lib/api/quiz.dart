import 'dart:convert';

import 'client.dart';

/// Quiz API — 测验生成 / 答题 / 历史 / 错题本 / 分享。
/// 契约对齐 frontendv2/lib/api/quiz.ts；响应经 client 统一 snake→camel。
///
/// ⚠️ Mongo 来的列表字段（options/keywords/correct_answer）可能是
/// JSON 编码字符串，需二次解析。

List<String> _stringList(dynamic v) {
  dynamic parsed = v;
  if (parsed is String) {
    final t = parsed.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        parsed = jsonDecode(t);
      } on FormatException {
        return <String>[];
      }
    } else if (t.isEmpty) {
      return const [];
    } else {
      return [t];
    }
  }
  if (parsed is List) return [for (final e in parsed) e.toString()];
  return const [];
}

class QuizQuestion {
  QuizQuestion({
    required this.questionUuid,
    required this.questionType,
    required this.difficulty,
    required this.questionText,
    this.options = const [],
    this.explanation,
    this.keywords = const [],
    this.correctAnswer,
  });

  final String questionUuid;

  /// choice | fill_blank | short_answer 等
  final String questionType;
  final String difficulty;
  final String questionText;
  final List<String> options;
  final String? explanation;
  final List<String> keywords;

  /// 可能是字符串或字符串列表（统一 join 展示；提交按原样发）。
  final dynamic correctAnswer;

  List<String> get correctAnswers {
    final v = correctAnswer;
    if (v is List) return [for (final e in v) e.toString()];
    if (v is String && v.isNotEmpty) return [v];
    return const [];
  }

  factory QuizQuestion.fromMap(Map<String, dynamic> m) => QuizQuestion(
        questionUuid: m['questionUuid'] as String? ?? '',
        questionType: m['questionType'] as String? ?? '',
        difficulty: m['difficulty'] as String? ?? '',
        questionText: m['questionText'] as String? ?? '',
        options: _stringList(m['options']),
        explanation: m['explanation'] as String?,
        keywords: _stringList(m['keywords']),
        correctAnswer: m['correctAnswer'],
      );
}

class QuizSet {
  QuizSet({
    required this.quizUuid,
    required this.title,
    required this.status,
    this.errorMessage,
    required this.questionCount,
    required this.difficulty,
    required this.totalScore,
    required this.passingScore,
    required this.questions,
    required this.createdAt,
  });

  final String quizUuid;
  final String title;
  final String status;
  final String? errorMessage;
  final int questionCount;
  final String difficulty;
  final int totalScore;
  final int passingScore;
  final List<QuizQuestion> questions;
  final String createdAt;

  factory QuizSet.fromMap(Map<String, dynamic> m) => QuizSet(
        quizUuid: m['quizUuid'] as String? ?? '',
        title: m['title'] as String? ?? '',
        status: m['status'] as String? ?? '',
        errorMessage: m['errorMessage'] as String?,
        questionCount: (m['questionCount'] as num?)?.toInt() ?? 0,
        difficulty: m['difficulty'] as String? ?? '',
        totalScore: (m['totalScore'] as num?)?.toInt() ?? 0,
        passingScore: (m['passingScore'] as num?)?.toInt() ?? 0,
        questions: [
          for (final q in (m['questions'] as List? ?? const []))
            QuizQuestion.fromMap(asMap(q)),
        ],
        createdAt: m['createdAt'] as String? ?? '',
      );
}

class QuizAnswerResult {
  QuizAnswerResult({
    required this.questionUuid,
    this.isCorrect,
    this.autoScore,
    this.needsManualGrading = false,
    this.correctAnswer,
    this.gradingNote,
  });

  final String questionUuid;
  final bool? isCorrect;
  final num? autoScore;
  final bool needsManualGrading;
  final dynamic correctAnswer;
  final String? gradingNote;

  factory QuizAnswerResult.fromMap(Map<String, dynamic> m) =>
      QuizAnswerResult(
        questionUuid: m['questionUuid'] as String? ?? '',
        isCorrect: m['isCorrect'] as bool?,
        autoScore: m['autoScore'] as num?,
        needsManualGrading: m['needsManualGrading'] as bool? ?? false,
        correctAnswer: m['correctAnswer'],
        gradingNote: m['gradingNote'] as String?,
      );
}

class QuizSubmissionResult {
  QuizSubmissionResult({
    required this.submissionUuid,
    this.score,
    this.passed,
    required this.correctCount,
    required this.totalCount,
    required this.results,
  });

  final String submissionUuid;
  final num? score;
  final bool? passed;
  final int correctCount;
  final int totalCount;
  final List<QuizAnswerResult> results;

  factory QuizSubmissionResult.fromMap(Map<String, dynamic> m) =>
      QuizSubmissionResult(
        submissionUuid: m['submissionUuid'] as String? ?? '',
        score: m['score'] as num?,
        passed: m['passed'] as bool?,
        correctCount: (m['correctCount'] as num?)?.toInt() ?? 0,
        totalCount: (m['totalCount'] as num?)?.toInt() ?? 0,
        results: [
          for (final r in (m['results'] as List? ?? const []))
            QuizAnswerResult.fromMap(asMap(r)),
        ],
      );
}

class QuizHistoryItem {
  QuizHistoryItem({
    required this.quizUuid,
    required this.title,
    required this.status,
    this.errorMessage,
    required this.questionCount,
    required this.difficulty,
    this.score,
    this.passed,
    required this.correctCount,
    required this.totalQuestionCount,
    this.timeSpentSeconds,
    required this.submittedAt,
  });

  final String quizUuid;
  final String title;
  final String status;
  final String? errorMessage;
  final int questionCount;
  final String difficulty;
  final num? score;
  final bool? passed;
  final int correctCount;
  final int totalQuestionCount;
  final int? timeSpentSeconds;
  final String submittedAt;

  factory QuizHistoryItem.fromMap(Map<String, dynamic> m) => QuizHistoryItem(
        quizUuid: m['quizUuid'] as String? ?? '',
        title: m['title'] as String? ?? '',
        status: m['status'] as String? ?? '',
        errorMessage: m['errorMessage'] as String?,
        questionCount: (m['questionCount'] as num?)?.toInt() ?? 0,
        difficulty: m['difficulty'] as String? ?? '',
        score: m['score'] as num?,
        passed: m['passed'] as bool?,
        correctCount: (m['correctCount'] as num?)?.toInt() ?? 0,
        totalQuestionCount: (m['totalQuestionCount'] as num?)?.toInt() ?? 0,
        timeSpentSeconds: (m['timeSpentSeconds'] as num?)?.toInt(),
        submittedAt: m['submittedAt'] as String? ?? '',
      );
}

class WrongAnswerItem {
  WrongAnswerItem({
    required this.questionUuid,
    required this.quizUuid,
    required this.questionType,
    required this.questionText,
    this.options = const [],
    required this.userAnswer,
    this.correctAnswer,
    this.explanation,
    required this.timesWrong,
  });

  final String questionUuid;
  final String quizUuid;
  final String questionType;
  final String questionText;
  final List<String> options;
  final String userAnswer;
  final dynamic correctAnswer;
  final String? explanation;
  final int timesWrong;

  factory WrongAnswerItem.fromMap(Map<String, dynamic> m) => WrongAnswerItem(
        questionUuid: m['questionUuid'] as String? ?? '',
        quizUuid: m['quizUuid'] as String? ?? '',
        questionType: m['questionType'] as String? ?? '',
        questionText: m['questionText'] as String? ?? '',
        options: _stringList(m['options']),
        userAnswer: m['userAnswer']?.toString() ?? '',
        correctAnswer: m['correctAnswer'],
        explanation: m['explanation'] as String?,
        timesWrong: (m['timesWrong'] as num?)?.toInt() ?? 0,
      );
}

class QuizApi {
  QuizApi(this._client);

  final ApiClient _client;

  /// 从收藏夹页面生成测验：query 带 folder_ids（CSV）/题数/难度/标题，
  /// body 是裸 JSON 数组（分P 列表）或无 body。
  Future<({String quizUuid, int questionCount})> generate({
    List<int>? folderIds,
    List<Map<String, dynamic>>? pages,
    int questionCount = 5,
    String? difficulty,
    String? title,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/quiz/generate',
      query: {
        if (folderIds != null && folderIds.isNotEmpty)
          'folder_ids': folderIds.join(','),
        'question_count': questionCount,
        if (difficulty != null) 'difficulty': difficulty,
        if (title != null) 'title': title,
      },
      body: pages,
    ));
    return (
      quizUuid: m['quizUuid'] as String? ?? '',
      questionCount: (m['questionCount'] as num?)?.toInt() ?? 0,
    );
  }

  /// 从当前对话摘要生成测验（聊天页入口）。
  Future<({String quizUuid, String status})> generateFromSummary({
    required String chatSessionId,
    int questionCount = 5,
    String? difficulty,
    String? title,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/quiz/generate-from-summary',
      body: {
        'chat_session_id': chatSessionId,
        'question_count': questionCount,
        if (difficulty != null) 'difficulty': difficulty,
        if (title != null) 'title': title,
      },
    ));
    return (
      quizUuid: m['quizUuid'] as String? ?? '',
      status: m['status'] as String? ?? '',
    );
  }

  /// AI 自由出题 / 错题重练。
  Future<({String quizUuid, String status})> generateAI({
    required String mode, // free | wrong_answers
    String? topic,
    int questionCount = 5,
    String? difficulty,
    String? title,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/quiz/generate-ai',
      body: {
        'mode': mode,
        if (topic != null) 'topic': topic,
        'question_count': questionCount,
        if (difficulty != null) 'difficulty': difficulty,
        if (title != null) 'title': title,
      },
    ));
    return (
      quizUuid: m['quizUuid'] as String? ?? '',
      status: m['status'] as String? ?? '',
    );
  }

  Future<QuizSet> getQuiz(String quizUuid) async =>
      QuizSet.fromMap(asMap(
        await _client.request('GET', '/quiz/$quizUuid'),
      ));

  Future<QuizSubmissionResult> submit({
    required String quizUuid,
    required List<Map<String, dynamic>> answers,
    int? timeSpentSeconds,
  }) async =>
      QuizSubmissionResult.fromMap(asMap(await _client.request(
        'POST',
        '/quiz/submit',
        body: {
          'quiz_uuid': quizUuid,
          'answers': answers,
          if (timeSpentSeconds != null) 'time_spent_seconds': timeSpentSeconds,
        },
      )));

  Future<List<QuizHistoryItem>> getHistory({
    int page = 1,
    int pageSize = 20,
  }) async {
    final m = asMap(await _client.request(
      'GET',
      '/quiz/history',
      query: {'page': page, 'page_size': pageSize},
    ));
    return [
      for (final e in (m['submissions'] as List? ?? const []))
        QuizHistoryItem.fromMap(asMap(e)),
    ];
  }

  Future<void> deleteQuiz(String quizUuid) async {
    await _client.request('DELETE', '/quiz/$quizUuid');
  }

  Future<List<WrongAnswerItem>> getWrongAnswers({List<int>? folderIds}) async {
    final m = asMap(await _client.request(
      'GET',
      '/quiz/wrong-answers',
      query: {
        if (folderIds != null && folderIds.isNotEmpty)
          'folder_ids': folderIds.join(','),
      },
    ));
    return [
      for (final e in (m['wrongAnswers'] as List? ?? const []))
        WrongAnswerItem.fromMap(asMap(e)),
    ];
  }

  Future<void> createShare(String quizUuid, {int? expiresInDays}) async {
    await _client.request(
      'POST',
      '/quiz/$quizUuid/share',
      body: {'expires_in_days': expiresInDays},
    );
  }

  Future<void> revokeShare(String quizUuid) async {
    await _client.request('DELETE', '/quiz/$quizUuid/share');
  }
}
