import 'client.dart';

/// Favorites API — 收藏夹 v2（Bearer 鉴权；v1 session_id 参数鉴权已废弃不接入）。
/// 契约对齐 frontendv2/lib/api/favorites.ts；响应经 client 统一 snake→camel。
///
/// ⚠️ listFolders 抛 409 = B站账号未绑定（弹绑定流程），不是登出。

class FavoriteFolder {
  FavoriteFolder({
    required this.id,
    required this.mediaId,
    required this.title,
    required this.mediaCount,
    required this.isDefault,
    required this.isSelected,
    this.lastSyncAt,
  });

  final int id;
  final int mediaId;
  final String title;
  final int mediaCount;
  final bool isDefault;
  final bool isSelected;
  final String? lastSyncAt;

  factory FavoriteFolder.fromMap(Map<String, dynamic> m) => FavoriteFolder(
        id: (m['id'] as num?)?.toInt() ?? 0,
        mediaId: (m['mediaId'] as num?)?.toInt() ?? 0,
        title: m['title'] as String? ?? '',
        mediaCount: (m['mediaCount'] as num?)?.toInt() ?? 0,
        isDefault: m['isDefault'] as bool? ?? false,
        isSelected: m['isSelected'] as bool? ?? false,
        lastSyncAt: m['lastSyncAt'] as String?,
      );
}

class FavoriteVideo {
  FavoriteVideo({
    required this.id,
    required this.bvid,
    required this.title,
    this.cover,
    this.duration,
    this.owner,
    this.cid,
    required this.isSelected,
    this.syncedAt,
  });

  final int id;
  final String bvid;
  final String title;
  final String? cover;
  final int? duration;
  final String? owner;
  final int? cid;
  final bool isSelected;
  final String? syncedAt;

  factory FavoriteVideo.fromMap(Map<String, dynamic> m) => FavoriteVideo(
        id: (m['id'] as num?)?.toInt() ?? 0,
        bvid: m['bvid'] as String? ?? '',
        title: m['title'] as String? ?? '',
        cover: m['cover'] as String?,
        duration: (m['duration'] as num?)?.toInt(),
        owner: m['owner'] as String?,
        cid: (m['cid'] as num?)?.toInt(),
        isSelected: m['isSelected'] as bool? ?? false,
        syncedAt: m['syncedAt'] as String?,
      );
}

class FavoriteVideoPage {
  FavoriteVideoPage({
    required this.folderId,
    required this.mediaId,
    required this.folderTitle,
    required this.videos,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.hasMore,
  });

  final int folderId;
  final int mediaId;
  final String folderTitle;
  final List<FavoriteVideo> videos;
  final int total;
  final int page;
  final int pageSize;
  final bool hasMore;

  factory FavoriteVideoPage.fromMap(Map<String, dynamic> m) =>
      FavoriteVideoPage(
        folderId: (m['folderId'] as num?)?.toInt() ?? 0,
        mediaId: (m['mediaId'] as num?)?.toInt() ?? 0,
        folderTitle: m['folderTitle'] as String? ?? '',
        videos: [
          for (final v in (m['videos'] as List? ?? const []))
            FavoriteVideo.fromMap(asMap(v)),
        ],
        total: (m['total'] as num?)?.toInt() ?? 0,
        page: (m['page'] as num?)?.toInt() ?? 1,
        pageSize: (m['pageSize'] as num?)?.toInt() ?? 20,
        hasMore: m['hasMore'] as bool? ?? false,
      );
}

/// 分P 向量化状态（isVectorized: pending/processing/done/failed）。
class VideoPageItem {
  VideoPageItem({
    required this.cid,
    required this.pageIndex,
    this.pageTitle,
    required this.isProcessed,
    required this.isVectorized,
    required this.vectorChunkCount,
  });

  final int cid;
  final int pageIndex;
  final String? pageTitle;
  final bool isProcessed;
  final String isVectorized;
  final int vectorChunkCount;

  factory VideoPageItem.fromMap(Map<String, dynamic> m) => VideoPageItem(
        cid: (m['cid'] as num?)?.toInt() ?? 0,
        pageIndex: (m['pageIndex'] as num?)?.toInt() ?? 0,
        pageTitle: m['pageTitle'] as String?,
        isProcessed: m['isProcessed'] as bool? ?? false,
        isVectorized: m['isVectorized'] as String? ?? 'pending',
        vectorChunkCount: (m['vectorChunkCount'] as num?)?.toInt() ?? 0,
      );
}

class VideoPageList {
  VideoPageList({
    required this.bvid,
    required this.pages,
    required this.pageCount,
    required this.isStored,
  });

  final String bvid;
  final List<VideoPageItem> pages;
  final int pageCount;
  final bool isStored;

  factory VideoPageList.fromMap(Map<String, dynamic> m) => VideoPageList(
        bvid: m['bvid'] as String? ?? '',
        pages: [
          for (final p in (m['pages'] as List? ?? const []))
            VideoPageItem.fromMap(asMap(p)),
        ],
        pageCount: (m['pageCount'] as num?)?.toInt() ?? 0,
        isStored: m['isStored'] as bool? ?? false,
      );
}

class FavoritesApi {
  FavoritesApi(this._client);

  final ApiClient _client;

  /// 收藏夹列表（409 = B站未绑定）。
  Future<List<FavoriteFolder>> listFolders() async {
    final raw = await _client.request('GET', '/favorites/v2/list');
    final list = raw is List ? raw : (asMap(raw)['folders'] as List? ?? const []);
    return [
      for (final e in list) FavoriteFolder.fromMap(asMap(e)),
    ];
  }

  /// 触发收藏夹同步（防误删机制在服务端；空返回不清本地）。
  Future<({List<FavoriteFolder> folders, int total})> syncFolders() async {
    final m = asMap(await _client.request('POST', '/favorites/v2/sync'));
    return (
      folders: [
        for (final e in (m['folders'] as List? ?? const []))
          FavoriteFolder.fromMap(asMap(e)),
      ],
      total: (m['total'] as num?)?.toInt() ?? 0,
    );
  }

  /// 选中/取消选中收藏夹（决定知识库构建范围）。
  Future<void> updateSelected(int folderId, bool isSelected) async {
    await _client.request(
      'PATCH',
      '/favorites/v2/$folderId/selected',
      query: {'is_selected': isSelected},
    );
  }

  Future<void> deleteFolder(int folderId) async {
    await _client.request('DELETE', '/favorites/v2/$folderId');
  }

  Future<FavoriteVideoPage> listVideos(
    int mediaId, {
    int page = 1,
    int pageSize = 20,
  }) async =>
      FavoriteVideoPage.fromMap(asMap(await _client.request(
        'GET',
        '/favorites/v2/media/$mediaId/videos',
        query: {'page': page, 'page_size': pageSize},
      )));

  /// 分P 列表（ASR/向量化状态）。
  Future<VideoPageList> listVideoPages(String bvid) async =>
      VideoPageList.fromMap(asMap(
        await _client.request('GET', '/favorites/v2/video/$bvid/pages'),
      ));
}
