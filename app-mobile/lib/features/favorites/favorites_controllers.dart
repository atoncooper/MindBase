import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/favorites.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';

/// 收藏夹列表状态。
/// ⚠️ listFolders 抛 409 = B站未绑定（页面据此弹绑定流程），不是登出。
class FavoritesNotifier extends AsyncNotifier<List<FavoriteFolder>> {
  @override
  Future<List<FavoriteFolder>> build() =>
      ref.read(favoritesApiProvider).listFolders();

  /// 刷新收藏夹列表。自捕获：无数据时落到错误态，已有数据保持旧列表，
  /// 不让异常外溢成 Unhandled Exception（409 绑定提示语义不变）。
  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(favoritesApiProvider).listFolders());
    } on ApiException catch (e, st) {
      if (state.valueOrNull == null) state = AsyncError(e, st);
    }
  }

  /// 触发收藏夹同步（防误删机制在服务端）。
  Future<void> sync() async {
    await ref.read(favoritesApiProvider).syncFolders();
    await refresh();
  }

  Future<void> toggleSelected(FavoriteFolder folder) async {
    await ref
        .read(favoritesApiProvider)
        .updateSelected(folder.id, !folder.isSelected);
    await refresh();
  }

  Future<void> remove(FavoriteFolder folder) async {
    await ref.read(favoritesApiProvider).deleteFolder(folder.id);
    await refresh();
  }

  /// 绑定成功后强制刷新（清掉 409 错误态）。
  Future<void> afterBind() async {
    state = const AsyncLoading();
    await refresh();
  }
}

final favoritesProvider =
    AsyncNotifierProvider<FavoritesNotifier, List<FavoriteFolder>>(
        FavoritesNotifier.new);
