import 'package:dio/dio.dart';

import '../chat_stream/chat_stream_models.dart';
import 'client.dart';

/// Chat API — 问答流式 / 会话管理 / 历史消息 / 会话文档。
/// 契约对齐 frontendv2/lib/api/chat.ts（响应经 snake→camel）。

/// 聊天会话（app-ts；唯一身份是 chatSessionId 字符串）。
class ChatSession {
  ChatSession({
    required this.chatSessionId,
    this.title,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.lastMessageAt,
  });

  final String chatSessionId;
  final String? title;
  final String status;
  final String createdAt;
  final String updatedAt;
  final String? lastMessageAt;

  String get displayTitle {
    final t = title;
    if (t != null && t.trim().isNotEmpty) return t.trim();
    return '新对话';
  }

  factory ChatSession.fromMap(Map<String, dynamic> m) => ChatSession(
        chatSessionId: m['chatSessionId'] as String? ?? '',
        title: m['title'] as String?,
        status: m['status'] as String? ?? '',
        createdAt: m['createdAt'] as String? ?? '',
        updatedAt: m['updatedAt'] as String? ?? '',
        lastMessageAt: m['lastMessageAt'] as String?,
      );
}

/// 聊天消息（v2: MongoDB-backed，msgId 为字符串）。
class ChatMessage {
  ChatMessage({
    required this.msgId,
    required this.role,
    required this.content,
    required this.status,
    this.sources = const [],
    this.images = const [],
    this.artifacts = const [],
    this.tokensUsed,
    this.model,
    this.latencyMs,
    this.error,
    required this.createdAt,
  });

  final String msgId;

  /// user | assistant | system
  final String role;
  final String content;

  /// pending | completed | failed
  final String status;
  final List<ChatSource> sources;
  final List<String> images;
  final List<ChatArtifact> artifacts;
  final int? tokensUsed;
  final String? model;
  final int? latencyMs;
  final String? error;
  final String createdAt;

  bool get isUser => role == 'user';
  bool get isAssistant => role == 'assistant';
  bool get isFailed => status == 'failed';

  factory ChatMessage.fromMap(Map<String, dynamic> m) => ChatMessage(
        msgId: m['msgId'] as String? ?? '',
        role: m['role'] as String? ?? 'user',
        content: m['content'] as String? ?? '',
        status: m['status'] as String? ?? 'completed',
        sources: [
          for (final s in (m['sources'] as List? ?? const []))
            if (s is Map)
              ChatSource(
                title: s['title']?.toString() ?? '',
                url: s['url']?.toString(),
                bvid: s['bvid']?.toString(),
              ),
        ],
        images: [
          for (final i in (m['images'] as List? ?? const [])) i.toString(),
        ],
        artifacts: [
          for (final a in (m['artifacts'] as List? ?? const []))
            ChatArtifact.fromMap(a),
        ],
        tokensUsed: (m['tokensUsed'] as num?)?.toInt(),
        model: m['model'] as String?,
        latencyMs: (m['latencyMs'] as num?)?.toInt(),
        error: m['error'] as String?,
        createdAt: m['createdAt'] as String? ?? '',
      );
}

class ChatHistoryResponse {
  ChatHistoryResponse({
    required this.messages,
    required this.total,
    this.page = 1,
    required this.hasMore,
    this.nextCursor,
  });

  final List<ChatMessage> messages;
  final int total;

  /// 当前页号（后端升序分页：第 1 页 = 最早的消息）。
  final int page;
  final bool hasMore;
  final String? nextCursor;

  factory ChatHistoryResponse.fromMap(Map<String, dynamic> m) =>
      ChatHistoryResponse(
        messages: [
          for (final e in (m['messages'] as List? ?? const []))
            ChatMessage.fromMap(asMap(e)),
        ],
        total: (m['total'] as num?)?.toInt() ?? 0,
        page: (m['page'] as num?)?.toInt() ?? 1,
        hasMore: m['hasMore'] as bool? ?? false,
        nextCursor: m['nextCursor'] as String?,
      );
}

/// 会话文档（pdf/docx/pptx/txt/md/html，随会话检索，不进全局向量库）。
class SessionDocument {
  SessionDocument({
    required this.id,
    required this.sessionId,
    required this.filename,
    required this.sizeBytes,
    required this.chunkCount,
    required this.createdAt,
    this.downloadUrl,
  });

  final String id;
  final String sessionId;
  final String filename;
  final int sizeBytes;
  final int chunkCount;
  final int createdAt;
  final String? downloadUrl;

  factory SessionDocument.fromMap(Map<String, dynamic> m) => SessionDocument(
        id: m['id'] as String? ?? '',
        sessionId: m['sessionId'] as String? ?? '',
        filename: m['filename'] as String? ?? '',
        sizeBytes: (m['sizeBytes'] as num?)?.toInt() ?? 0,
        chunkCount: (m['chunkCount'] as num?)?.toInt() ?? 0,
        createdAt: (m['createdAt'] as num?)?.toInt() ?? 0,
        downloadUrl: m['downloadUrl'] as String?,
      );
}

/// 工作区分P（chat 请求可选的检索作用域之一）。
Map<String, dynamic> workspacePagePayload({
  required String bvid,
  required int cid,
  required int pageIndex,
  String? pageTitle,
}) =>
    {
      'bvid': bvid,
      'cid': cid,
      'page_index': pageIndex,
      if (pageTitle != null) 'page_title': pageTitle,
    };

class ChatApi {
  ChatApi(this._client);

  final ApiClient _client;

  // === 流式接口（唯一问答入口）===

  /// POST /chat/ask/agent/stream → SSE 字节流。
  ///
  /// [cancelToken] 用于「停止生成」；取消后 client 抛
  /// [ApiException.isCancelled]，consumeChatStream 视为正常停止。
  ///
  /// 请求体 snake_case（服务端契约）；检索路由由后端 AgentHarness 决策，
  /// 客户端只透传作用域（folder_ids / workspace_pages）。
  Future<Stream<List<int>>> askStream({
    required String question,
    String? chatSessionId,
    List<int>? folderIds,
    List<Map<String, dynamic>>? workspacePages,
    List<String>? images,
    CancelToken? cancelToken,
  }) {
    return _client.streamPost(
      '/chat/ask/agent/stream',
      cancelToken: cancelToken,
      body: {
        'question': question,
        if (chatSessionId != null) 'chat_session_id': chatSessionId,
        if (folderIds != null && folderIds.isNotEmpty) 'folder_ids': folderIds,
        if (workspacePages != null && workspacePages.isNotEmpty)
          'workspace_pages': workspacePages,
        if (images != null && images.isNotEmpty) 'images': images,
      },
    );
  }

  // === 会话管理 ===

  Future<ChatSession> createSession({String? title}) async =>
      ChatSession.fromMap(asMap(await _client.request(
        'POST',
        '/chat/sessions',
        body: {if (title != null) 'title': title},
      )));

  Future<List<ChatSession>> listSessions() async {
    final m = asMap(await _client.request('GET', '/chat/sessions'));
    return [
      for (final s in (m['sessions'] as List? ?? const []))
        ChatSession.fromMap(asMap(s)),
    ];
  }

  Future<ChatSession> updateSession(String chatSessionId, String title) async =>
      ChatSession.fromMap(asMap(await _client.request(
        'PATCH',
        '/chat/sessions/${Uri.encodeComponent(chatSessionId)}',
        body: {'title': title},
      )));

  Future<void> deleteSession(String chatSessionId) async {
    await _client.request(
      'DELETE',
      '/chat/sessions/${Uri.encodeComponent(chatSessionId)}',
    );
  }

  // === 历史消息 ===

  Future<ChatHistoryResponse> getHistory(
    String chatSessionId, {
    int page = 1,
    int pageSize = 50,
  }) async =>
      ChatHistoryResponse.fromMap(asMap(await _client.request(
        'GET',
        '/chat/history',
        query: {
          'chat_session_id': chatSessionId,
          'page': page,
          'page_size': pageSize,
        },
      )));

  Future<void> clearHistory(String chatSessionId) async {
    await _client.request(
      'DELETE',
      '/chat/history',
      query: {'chat_session_id': chatSessionId},
    );
  }

  /// 删除 msgId 及其后消息（单轮重新生成：先截断再重问）。
  Future<void> truncateHistoryFrom(String chatSessionId, String msgId) async {
    await _client.request(
      'DELETE',
      '/chat/history/from/${Uri.encodeComponent(msgId)}',
      query: {'chat_session_id': chatSessionId},
    );
  }

  // === 会话文档 ===

  Future<SessionDocument> uploadDocument({
    required MultipartFile file,
    required String sessionId,
  }) async {
    final form = FormData()
      ..files.add(MapEntry('file', file))
      ..fields.add(MapEntry('session_id', sessionId));
    return SessionDocument.fromMap(asMap(
      await _client.request('POST', '/chat/documents', form: form),
    ));
  }

  Future<List<SessionDocument>> listDocuments(String sessionId) async {
    final m = asMap(await _client.request(
      'GET',
      '/chat/documents',
      query: {'session_id': sessionId},
    ));
    return [
      for (final d in (m['documents'] as List? ?? const []))
        SessionDocument.fromMap(asMap(d)),
    ];
  }

  Future<void> deleteDocument(String sessionId, String docId) async {
    await _client.request(
      'DELETE',
      '/chat/documents',
      query: {'session_id': sessionId, 'id': docId},
    );
  }
}
