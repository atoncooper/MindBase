import 'client.dart';

/// Notes API — 笔记 CRUD / 锚点 / 修订 / 分享。
/// 契约对齐 frontendv2/lib/api/notes.ts（web 端 requestCamel；本端 client 统一转换）。
///
/// ⚠️ 乐观并发：update 必须带 `If-Match: <updatedAt>`（取自最近一次读取/更新的
/// 响应），冲突返回 409。列表响应体是裸数组、total 在 X-Total-Count 响应头里
/// （以 frontendv2/lib/api/notes.ts fetchNotesList 为权威）。

class NoteMeta {
  NoteMeta({
    required this.uuid,
    required this.title,
    required this.targetType,
    required this.targetId,
    required this.contentLength,
    required this.isPinned,
    required this.revisionCount,
    required this.createdAt,
    required this.updatedAt,
  });

  final String uuid;
  final String title;
  final String targetType; // video | cloud_file
  final String targetId;
  final int contentLength;
  final bool isPinned;
  final int revisionCount;
  final String createdAt;
  final String updatedAt;

  factory NoteMeta.fromMap(Map<String, dynamic> m) => NoteMeta(
        uuid: m['uuid'] as String? ?? '',
        title: m['title'] as String? ?? '',
        targetType: m['targetType'] as String? ?? 'video',
        targetId: m['targetId'] as String? ?? '',
        contentLength: (m['contentLength'] as num?)?.toInt() ?? 0,
        isPinned: m['isPinned'] as bool? ?? false,
        revisionCount: (m['revisionCount'] as num?)?.toInt() ?? 0,
        createdAt: m['createdAt'] as String? ?? '',
        updatedAt: m['updatedAt'] as String? ?? '',
      );
}

class NoteAnchor {
  NoteAnchor({
    required this.id,
    required this.blockId,
    required this.position,
    this.label,
    required this.createdAt,
  });

  final int id;
  final String blockId;
  final int position;
  final String? label;
  final String createdAt;

  factory NoteAnchor.fromMap(Map<String, dynamic> m) => NoteAnchor(
        id: (m['id'] as num?)?.toInt() ?? 0,
        blockId: m['blockId'] as String? ?? '',
        position: (m['position'] as num?)?.toInt() ?? 0,
        label: m['label'] as String?,
        createdAt: m['createdAt'] as String? ?? '',
      );
}

class NoteDetail {
  NoteDetail({
    required this.meta,
    required this.contentMd,
    required this.anchors,
    this.shareToken,
    this.shareExpiresAt,
  });

  final NoteMeta meta;
  final String contentMd;
  final List<NoteAnchor> anchors;
  final String? shareToken;
  final String? shareExpiresAt;

  String get updatedAt => meta.updatedAt;

  factory NoteDetail.fromMap(Map<String, dynamic> m) => NoteDetail(
        meta: NoteMeta.fromMap(m),
        contentMd: m['contentMd'] as String? ?? '',
        anchors: [
          for (final a in (m['anchors'] as List? ?? const []))
            NoteAnchor.fromMap(asMap(a)),
        ],
        shareToken: m['shareToken'] as String?,
        shareExpiresAt: m['shareExpiresAt'] as String?,
      );
}

class NoteShareInfo {
  NoteShareInfo({
    required this.shareToken,
    required this.shareUrl,
    this.expiresAt,
  });

  final String shareToken;
  final String shareUrl;
  final String? expiresAt;

  factory NoteShareInfo.fromMap(Map<String, dynamic> m) => NoteShareInfo(
        shareToken: m['shareToken'] as String? ?? '',
        shareUrl: m['shareUrl'] as String? ?? '',
        expiresAt: m['expiresAt'] as String?,
      );
}

class NoteRevision {
  NoteRevision({
    required this.revisionId,
    this.revisionNote,
    required this.createdAt,
  });

  final String revisionId;
  final String? revisionNote;
  final String createdAt;

  factory NoteRevision.fromMap(Map<String, dynamic> m) => NoteRevision(
        revisionId: m['revisionId'] as String? ?? '',
        revisionNote: m['revisionNote'] as String?,
        createdAt: m['createdAt'] as String? ?? '',
      );
}

class NotesApi {
  NotesApi(this._client);

  final ApiClient _client;

  /// 笔记列表。
  ///
  /// ⚠️ 响应体是**裸数组**（对齐 web 端 fetchNotesList：total 只在
  /// `X-Total-Count` 响应头里，body 没有 {items,total} 包装）；
  /// 这里对裸数组 / 包装两种形态都做兼容。
  Future<({List<NoteMeta> items, int total})> list({
    String? targetType,
    String? targetId,
    int page = 1,
    int pageSize = 20,
  }) async {
    final res = await _client.requestWithHeaders(
      'GET',
      '/notes',
      query: {
        if (targetType != null) 'target_type': targetType,
        if (targetId != null) 'target_id': targetId,
        'page': page,
        'page_size': pageSize,
      },
    );
    final raw = res.data;
    var items = const <dynamic>[];
    var bodyTotal = 0;
    if (raw is List) {
      items = raw;
    } else if (raw is Map) {
      items = (raw['items'] as List?) ?? const [];
      bodyTotal = (raw['total'] as num?)?.toInt() ?? 0;
    }
    final total = res.intHeader('x-total-count') ?? bodyTotal;
    return (
      items: [
        for (final e in items) NoteMeta.fromMap(asMap(e)),
      ],
      total: total,
    );
  }

  Future<NoteDetail> create({
    String? title,
    required String targetType,
    required String targetId,
    String? contentMd,
  }) async =>
      NoteDetail.fromMap(asMap(await _client.request(
        'POST',
        '/notes',
        body: {
          if (title != null) 'title': title,
          'target_type': targetType,
          'target_id': targetId,
          if (contentMd != null) 'content_md': contentMd,
        },
      )));

  Future<NoteDetail> get(String uuid) async =>
      NoteDetail.fromMap(asMap(await _client.request('GET', '/notes/$uuid')));

  /// 更新（If-Match 乐观并发；409 = 冲突，调用方提示刷新）。
  Future<NoteDetail> update(
    String uuid, {
    required String ifMatchUpdatedAt,
    String? title,
    String? contentMd,
    bool? isPinned,
  }) async =>
      NoteDetail.fromMap(asMap(await _client.request(
        'PATCH',
        '/notes/$uuid',
        headers: {'If-Match': ifMatchUpdatedAt},
        body: {
          if (title != null) 'title': title,
          if (contentMd != null) 'content_md': contentMd,
          if (isPinned != null) 'is_pinned': isPinned,
        },
      )));

  Future<void> delete(String uuid) async {
    await _client.request('DELETE', '/notes/$uuid');
  }

  Future<NoteAnchor> addAnchor(
    String uuid, {
    required String blockId,
    required int position,
    String? label,
  }) async =>
      NoteAnchor.fromMap(asMap(await _client.request(
        'POST',
        '/notes/$uuid/anchors',
        body: {
          'block_id': blockId,
          'position': position,
          if (label != null) 'label': label,
        },
      )));

  Future<void> deleteAnchor(String uuid, int anchorId) async {
    await _client.request('DELETE', '/notes/$uuid/anchors/$anchorId');
  }

  Future<List<NoteRevision>> listRevisions(String uuid) async {
    final list = await _client.request('GET', '/notes/$uuid/revisions');
    return [
      for (final e in (list as List? ?? const []))
        NoteRevision.fromMap(asMap(e)),
    ];
  }

  Future<NoteDetail> restoreRevision(String uuid, String revisionId) async =>
      NoteDetail.fromMap(asMap(await _client.request(
        'POST',
        '/notes/$uuid/revisions/restore/$revisionId',
      )));

  Future<NoteShareInfo> createShare(String uuid, {int? expiresInDays}) async =>
      NoteShareInfo.fromMap(asMap(await _client.request(
        'POST',
        '/notes/$uuid/share',
        body: {'expires_in_days': expiresInDays},
      )));

  Future<void> revokeShare(String uuid) async {
    await _client.request('DELETE', '/notes/$uuid/share');
  }
}
