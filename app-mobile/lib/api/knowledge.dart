import 'client.dart';

/// Knowledge API — 知识库统计 / 构建 / 向量化状态。
/// 契约对齐 frontendv2/lib/api/knowledge.ts（build/sync → app-bili；
/// stats/status/pages → app-ts）。响应经 client 统一 snake→camel。

class KnowledgeStats {
  KnowledgeStats({
    required this.totalChunks,
    required this.totalVideos,
    required this.collectionName,
  });

  final int totalChunks;
  final int totalVideos;
  final String collectionName;

  factory KnowledgeStats.fromMap(Map<String, dynamic> m) => KnowledgeStats(
        totalChunks: (m['totalChunks'] as num?)?.toInt() ?? 0,
        totalVideos: (m['totalVideos'] as num?)?.toInt() ?? 0,
        collectionName: m['collectionName'] as String? ?? '',
      );
}

/// 构建任务状态（pending/processing/running/done/completed/failed）。
class BuildStatus {
  BuildStatus({
    required this.taskId,
    required this.status,
    required this.progress,
    this.currentStep,
    this.totalVideos = 0,
    this.processedVideos = 0,
    this.message,
  });

  final String taskId;
  final String status;
  final int progress;
  final String? currentStep;
  final int totalVideos;
  final int processedVideos;
  final String? message;

  bool get isTerminal => status == 'done' || status == 'completed' || status == 'failed';

  factory BuildStatus.fromMap(Map<String, dynamic> m) => BuildStatus(
        taskId: m['taskId'] as String? ?? '',
        status: m['status'] as String? ?? 'pending',
        progress: (m['progress'] as num?)?.toInt() ?? 0,
        currentStep: m['currentStep'] as String?,
        totalVideos: (m['totalVideos'] as num?)?.toInt() ?? 0,
        processedVideos: (m['processedVideos'] as num?)?.toInt() ?? 0,
        message: m['message'] as String?,
      );
}

class FolderIndexStatus {
  FolderIndexStatus({
    required this.mediaId,
    required this.indexedCount,
    this.mediaCount,
    this.lastSyncAt,
  });

  final int mediaId;
  final int indexedCount;
  final int? mediaCount;
  final String? lastSyncAt;

  factory FolderIndexStatus.fromMap(Map<String, dynamic> m) =>
      FolderIndexStatus(
        mediaId: (m['mediaId'] as num?)?.toInt() ?? 0,
        indexedCount: (m['indexedCount'] as num?)?.toInt() ?? 0,
        mediaCount: (m['mediaCount'] as num?)?.toInt(),
        lastSyncAt: m['lastSyncAt'] as String?,
      );
}

class KnowledgeApi {
  KnowledgeApi(this._client);

  final ApiClient _client;

  Future<KnowledgeStats> getStats() async =>
      KnowledgeStats.fromMap(asMap(await _client.request('GET', '/knowledge/stats')));

  /// 触发知识库构建（选中的收藏夹 → ASR + 向量化）。
  Future<({String taskId, String message})> build({
    required List<int> folderIds,
    List<String>? excludeBvids,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/knowledge/build',
      body: {
        'folder_ids': folderIds,
        if (excludeBvids != null) 'exclude_bvids': excludeBvids,
      },
    ));
    return (
      taskId: m['taskId'] as String? ?? '',
      message: m['message'] as String? ?? '',
    );
  }

  /// 轮询构建状态（页面侧定时拉取直至 isTerminal）。
  Future<BuildStatus> getBuildStatus(String taskId) async =>
      BuildStatus.fromMap(asMap(
        await _client.request('GET', '/knowledge/build/status/$taskId'),
      ));

  Future<List<FolderIndexStatus>> getFolderStatus() async {
    final list = await _client.request('GET', '/knowledge/folders/status');
    return [
      for (final e in (list as List? ?? const []))
        FolderIndexStatus.fromMap(asMap(e)),
    ];
  }

  Future<({String taskId, String message})> syncFolders({
    List<int>? folderIds,
  }) async {
    final m = asMap(await _client.request(
      'POST',
      '/knowledge/folders/sync',
      body: {if (folderIds != null) 'folder_ids': folderIds},
    ));
    return (
      taskId: m['taskId'] as String? ?? '',
      message: m['message'] as String? ?? '',
    );
  }

  Future<void> deleteVideo(String bvid) async {
    await _client.request('DELETE', '/knowledge/video/$bvid');
  }
}
