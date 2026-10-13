import 'dart:async';
import 'dart:math' as math;

import 'package:dio/dio.dart';

import '../core/error/api_exception.dart';
import 'client.dart';

/// Cloud API — 云盘（文件夹 / 视频 / 分片上传 / 配额 / 回收站）。
/// 契约对齐 frontendv2/lib/api/cloud.ts；响应经 client 统一 snake→camel
/// （后端原生 camelCase 的端点转换后恒等，安全）。
///
/// ⚠️ 分片上传：PUT 直达 MinIO 预签名 URL（绕过网关、不带 Bearer），
/// ETag 从 PUT 响应头读取；PartNumber = chunkIndex + 1（1-based）；
/// 上传期间每 60s 一次 heartbeat，否则上传会话过期。

class CloudFolder {
  CloudFolder({
    required this.id,
    this.parentId,
    required this.name,
    required this.videoCount,
    this.children = const [],
  });

  final int id;
  final int? parentId;
  final String name;
  final int videoCount;
  final List<CloudFolder> children;

  factory CloudFolder.fromMap(Map<String, dynamic> m) => CloudFolder(
        id: (m['id'] as num?)?.toInt() ?? 0,
        parentId: (m['parentId'] as num?)?.toInt(),
        name: m['name'] as String? ?? '',
        videoCount: (m['videoCount'] as num?)?.toInt() ?? 0,
        children: [
          for (final c in (m['children'] as List? ?? const []))
            CloudFolder.fromMap(asMap(c)),
        ],
      );
}

class CloudVideoItem {
  CloudVideoItem({
    required this.uploadUuid,
    required this.originalName,
    required this.fileSize,
    required this.mimeType,
    this.duration,
    required this.asrStatus,
    required this.vectorStatus,
    this.vectorChunkCount,
    this.title,
    this.coverUrl,
    required this.createdAt,
  });

  final String uploadUuid;
  final String originalName;
  final int fileSize;
  final String mimeType;
  final int? duration;
  final String asrStatus; // pending/processing/done/failed
  final String vectorStatus; // pending/processing/done/failed/not_supported
  final int? vectorChunkCount;
  final String? title;
  final String? coverUrl;
  final String createdAt;

  String get displayName {
    final t = title;
    if (t != null && t.trim().isNotEmpty) return t.trim();
    return originalName;
  }

  factory CloudVideoItem.fromMap(Map<String, dynamic> m) => CloudVideoItem(
        uploadUuid: m['uploadUuid'] as String? ?? '',
        originalName: m['originalName'] as String? ?? '',
        fileSize: (m['fileSize'] as num?)?.toInt() ?? 0,
        mimeType: m['mimeType'] as String? ?? '',
        duration: (m['duration'] as num?)?.toInt(),
        asrStatus: m['asrStatus'] as String? ?? 'pending',
        vectorStatus: m['vectorStatus'] as String? ?? 'pending',
        vectorChunkCount: (m['vectorChunkCount'] as num?)?.toInt(),
        title: m['title'] as String?,
        coverUrl: m['coverUrl'] as String?,
        createdAt: m['createdAt'] as String? ?? '',
      );
}

class CloudVideoListResponse {
  CloudVideoListResponse({
    required this.videos,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.hasMore,
  });

  final List<CloudVideoItem> videos;
  final int total;
  final int page;
  final int pageSize;
  final bool hasMore;

  factory CloudVideoListResponse.fromMap(Map<String, dynamic> m) =>
      CloudVideoListResponse(
        videos: [
          for (final v in (m['videos'] as List? ?? const []))
            CloudVideoItem.fromMap(asMap(v)),
        ],
        total: (m['total'] as num?)?.toInt() ?? 0,
        page: (m['page'] as num?)?.toInt() ?? 1,
        pageSize: (m['pageSize'] as num?)?.toInt() ?? 20,
        hasMore: m['hasMore'] as bool? ?? false,
      );
}

class CloudQuota {
  CloudQuota({
    required this.used,
    required this.quota,
    required this.tier,
    required this.pending,
  });

  final int used;
  final int quota;
  final String tier; // free | vip | svip（小写归一化在服务端）
  final int pending;

  factory CloudQuota.fromMap(Map<String, dynamic> m) => CloudQuota(
        used: (m['used'] as num?)?.toInt() ?? 0,
        quota: (m['quota'] as num?)?.toInt() ?? 0,
        tier: m['tier'] as String? ?? 'free',
        pending: (m['pending'] as num?)?.toInt() ?? 0,
      );
}

class PresignedChunk {
  PresignedChunk({
    required this.chunkIndex,
    required this.chunkSize,
    required this.url,
  });

  final int chunkIndex;
  final int chunkSize;
  final String url;

  factory PresignedChunk.fromMap(Map<String, dynamic> m) => PresignedChunk(
        chunkIndex: (m['chunkIndex'] as num?)?.toInt() ?? 0,
        chunkSize: (m['chunkSize'] as num?)?.toInt() ?? 0,
        url: m['url'] as String? ?? '',
      );
}

class CloudUploadInit {
  CloudUploadInit({
    required this.uploadUuid,
    required this.sessionUuid,
    required this.chunkCount,
    required this.chunkSize,
    required this.presignedUrls,
  });

  final String uploadUuid;
  final String sessionUuid;
  final int chunkCount;
  final int chunkSize;
  final List<PresignedChunk> presignedUrls;

  factory CloudUploadInit.fromMap(Map<String, dynamic> m) => CloudUploadInit(
        uploadUuid: m['uploadUuid'] as String? ?? '',
        sessionUuid: m['sessionUuid'] as String? ?? '',
        chunkCount: (m['chunkCount'] as num?)?.toInt() ?? 0,
        chunkSize: (m['chunkSize'] as num?)?.toInt() ?? 0,
        presignedUrls: [
          for (final p in (m['presignedUrls'] as List? ?? const []))
            PresignedChunk.fromMap(asMap(p)),
        ],
      );
}

class CloudVideoStatus {
  CloudVideoStatus({
    required this.asrStatus,
    required this.asrProgress,
    required this.vectorStatus,
    this.vectorChunkCount,
  });

  final String asrStatus;
  final int asrProgress;
  final String vectorStatus;
  final int? vectorChunkCount;

  factory CloudVideoStatus.fromMap(Map<String, dynamic> m) =>
      CloudVideoStatus(
        asrStatus: m['asrStatus'] as String? ?? 'pending',
        asrProgress: (m['asrProgress'] as num?)?.toInt() ?? 0,
        vectorStatus: m['vectorStatus'] as String? ?? 'pending',
        vectorChunkCount: (m['vectorChunkCount'] as num?)?.toInt(),
      );
}

/// raw 预览响应：presigned url（+ text-like 文件的内联 content）。
class CloudRawFile {
  CloudRawFile({
    required this.url,
    this.content,
    required this.mimeType,
    required this.fileName,
    required this.fileSize,
    required this.viewMode,
  });

  final String url;
  final String? content;
  final String mimeType;
  final String fileName;
  final int fileSize;

  /// image | video | audio | pdf | html | markdown | text | unsupported
  final String viewMode;

  factory CloudRawFile.fromMap(Map<String, dynamic> m) => CloudRawFile(
        url: m['url'] as String? ?? '',
        content: m['content'] as String?,
        mimeType: m['mimeType'] as String? ?? '',
        fileName: m['fileName'] as String? ?? '',
        fileSize: (m['fileSize'] as num?)?.toInt() ?? 0,
        viewMode: m['viewMode'] as String? ?? 'unsupported',
      );
}

class CloudTrashItem {
  CloudTrashItem({
    required this.uploadUuid,
    required this.originalName,
    required this.fileSize,
    required this.deletedAt,
    required this.purgeAt,
  });

  final String uploadUuid;
  final String originalName;
  final int fileSize;
  final String deletedAt;
  final String purgeAt;

  factory CloudTrashItem.fromMap(Map<String, dynamic> m) => CloudTrashItem(
        uploadUuid: m['uploadUuid'] as String? ?? '',
        originalName: m['originalName'] as String? ?? '',
        fileSize: (m['fileSize'] as num?)?.toInt() ?? 0,
        deletedAt: m['deletedAt'] as String? ?? '',
        purgeAt: m['purgeAt'] as String? ?? '',
      );
}

class CloudApi {
  CloudApi(this._client);

  final ApiClient _client;

  /// MinIO 直传专用 dio：不带 Bearer、独立超时（预签名 URL 自带鉴权）。
  static final Dio _minioDio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 30),
    sendTimeout: const Duration(minutes: 10),
    receiveTimeout: const Duration(minutes: 10),
  ));

  // ---- 文件夹 ----

  Future<List<CloudFolder>> listFolders() async {
    final m = asMap(await _client.request('GET', '/cloud/folders'));
    return [
      for (final f in (m['folders'] as List? ?? const []))
        CloudFolder.fromMap(asMap(f)),
    ];
  }

  Future<CloudFolder> createFolder({required String name, int? parentId}) async {
    final m = asMap(await _client.request(
      'POST',
      '/cloud/folders',
      body: {'name': name, if (parentId != null) 'parentId': parentId},
    ));
    return CloudFolder.fromMap(m);
  }

  Future<void> deleteFolder(int id, {bool force = false}) async {
    await _client.request('DELETE', '/cloud/folders/$id',
        query: {'force': force});
  }

  // ---- 视频 ----

  Future<CloudVideoListResponse> listVideos({
    int page = 1,
    int pageSize = 20,
    int? folderId,
  }) async =>
      CloudVideoListResponse.fromMap(asMap(await _client.request(
        'GET',
        '/cloud/videos',
        query: {
          'page': page,
          'pageSize': pageSize,
          'sort': 'created_at',
          'order': 'desc',
          if (folderId != null) 'folderId': folderId,
        },
      )));

  Future<void> deleteVideo(String uploadUuid) async {
    await _client.request('DELETE', '/cloud/video/$uploadUuid');
  }

  Future<CloudVideoStatus> getVideoStatus(String uploadUuid) async =>
      CloudVideoStatus.fromMap(asMap(
        await _client.request('GET', '/cloud/video/$uploadUuid/status'),
      ));

  /// 触发处理（ASR + 向量化）。
  Future<void> triggerProcess(String uploadUuid) async {
    await _client.request('POST', '/cloud/video/$uploadUuid/process');
  }

  Future<CloudQuota> getQuota() async =>
      CloudQuota.fromMap(asMap(await _client.request('GET', '/cloud/quota')));

  /// raw 预览（presigned url；image/video/audio/pdf 可直接加载/外跳，
  /// text/markdown/html 另带内联 content）。
  Future<CloudRawFile> getRawFile(String uploadUuid) async =>
      CloudRawFile.fromMap(asMap(
        await _client.request('GET', '/cloud/video/$uploadUuid/raw'),
      ));

  /// 按名称搜索文件。
  Future<({List<CloudVideoItem> results, int total})> searchFiles(
      String query) async {
    final m = asMap(await _client.request(
      'GET',
      '/cloud/search',
      query: {'q': query},
    ));
    return (
      results: [
        for (final v in (m['results'] as List? ?? const []))
          CloudVideoItem.fromMap(asMap(v)),
      ],
      total: (m['total'] as num?)?.toInt() ?? 0,
    );
  }

  // ---- 回收站 ----

  Future<List<CloudTrashItem>> listTrash() async {
    final m = asMap(await _client.request('GET', '/cloud/trash'));
    return [
      for (final t in (m['items'] as List? ?? const []))
        CloudTrashItem.fromMap(asMap(t)),
    ];
  }

  Future<void> restoreTrash(String uploadUuid) async {
    await _client.request('POST', '/cloud/trash/$uploadUuid/restore');
  }

  Future<void> purgeTrashItem(String uploadUuid) async {
    await _client.request('DELETE', '/cloud/trash/$uploadUuid');
  }

  /// 清空回收站，返回清掉的文件数。
  Future<int> emptyTrash() async {
    final m = asMap(await _client.request('DELETE', '/cloud/trash'));
    return (m['purged'] as num?)?.toInt() ?? 0;
  }

  // ---- 分片上传 ----

  Future<CloudUploadInit> initUpload({
    required String filename,
    required int fileSize,
    required String mimeType,
    int? folderId,
  }) async =>
      CloudUploadInit.fromMap(asMap(await _client.request(
        'POST',
        '/cloud/upload/init',
        body: {
          'filename': filename,
          'fileSize': fileSize,
          'mimeType': mimeType,
          if (folderId != null) 'folderId': folderId,
        },
      )));

  /// completeUpload：PartNumber = chunkIndex + 1（1-based，易错点）。
  Future<void> completeUpload({
    required String uploadUuid,
    required List<Map<String, dynamic>> parts,
  }) async {
    await _client.request(
      'POST',
      '/cloud/upload/$uploadUuid/complete',
      body: {'parts': parts},
    );
  }

  /// 上传会话心跳：上传期间每 60s 一次，否则会话过期。
  Future<bool> heartbeat({required String sessionUuid}) async {
    final m = asMap(await _client.request(
      'POST',
      '/cloud/upload/heartbeat',
      body: {'sessionUuid': sessionUuid},
    ));
    return m['ack'] as bool? ?? false;
  }

  /// PUT 分片直达 MinIO 预签名 URL（不带任何鉴权头），读 ETag 响应头。
  Future<String> _putChunk(String url, List<int> bytes) async {
    final res = await _minioDio.put<List<int>>(
      url,
      data: bytes,
      options: Options(responseType: ResponseType.bytes),
    );
    final etag = res.headers.value('etag');
    if (etag == null || etag.isEmpty) {
      throw ApiException(null, '分片上传失败（未返回 ETag）');
    }
    return etag;
  }

  /// 完整分片上传编排（对齐 web 端 uploadFile helper）：
  /// init → 逐片 PUT（直连 MinIO，读 ETag）→ complete。
  ///
  /// [readChunk](start, end) 由调用方提供文件字节（end 为开区间），
  /// [shouldAbort] 返回 true 时抛取消异常（云盘页的「取消上传」）。
  Future<void> uploadFile({
    required String filename,
    required int fileSize,
    required String mimeType,
    required Future<List<int>> Function(int start, int end) readChunk,
    int? folderId,
    void Function(double progress)? onProgress,
    Future<bool> Function()? shouldAbort,
  }) async {
    final init = await initUpload(
      filename: filename,
      fileSize: fileSize,
      mimeType: mimeType,
      folderId: folderId,
    );
    final parts = <Map<String, dynamic>>[];
    final total = init.chunkCount > 0 ? init.chunkCount : 1;
    final heartbeatTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      // 尽力而为：单次心跳失败不打断上传
      heartbeat(sessionUuid: init.sessionUuid).catchError((_) => false);
    });
    try {
      for (final chunk in init.presignedUrls) {
        if (await (shouldAbort?.call() ?? Future<bool>.value(false))) {
          throw ApiException(ApiException.cancelledStatus, '已取消');
        }
        final start = chunk.chunkIndex * chunk.chunkSize;
        final end = math.min(start + chunk.chunkSize, fileSize);
        final bytes = await readChunk(start, end);
        final etag = await _putChunk(chunk.url, bytes);
        parts.add({'PartNumber': chunk.chunkIndex + 1, 'ETag': etag});
        onProgress?.call(parts.length / total);
      }
      await completeUpload(uploadUuid: init.uploadUuid, parts: parts);
    } finally {
      heartbeatTimer.cancel();
    }
  }
}
