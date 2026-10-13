import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/bilibili_bind.dart';
import 'favorites_controllers.dart';

/// 收藏夹页：文件夹列表 + 同步 + 选中（决定知识库构建范围）。
class FavoritesPage extends ConsumerWidget {
  const FavoritesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final folders = ref.watch(favoritesProvider);
    final notifier = ref.read(favoritesProvider.notifier);

    // 409 = B站未绑定：显示绑定引导而不是错误页（对齐 web 端语义）
    final err = folders.asError?.error;
    if (err is ApiException && err.isConflict) {
      return Scaffold(
        appBar: AppBar(title: const Text('收藏夹')),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: BilibiliBindCard(onBound: () => notifier.afterBind()),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('收藏夹'),
        actions: [
          IconButton(
            tooltip: '同步收藏夹',
            icon: const Icon(Icons.sync),
            onPressed: () async {
              try {
                await notifier.sync();
              } on ApiException catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(SnackBar(content: Text(e.message)));
                }
              }
            },
          ),
        ],
      ),
      body: folders.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(e is ApiException ? e.message : '加载失败'),
              const SizedBox(height: 12),
              OutlinedButton(
                  onPressed: () => runAfterGesture(notifier.refresh),
                  child: const Text('重试')),
            ],
          ),
        ),
        data: (list) => list.isEmpty
            ? const Center(
                child: Text('暂无收藏夹，先点右上角同步',
                    style: TextStyle(color: Colors.grey)))
            : RefreshIndicator(
                onRefresh: notifier.refresh,
                child: ListView.separated(
                  itemCount: list.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final f = list[i];
                    return ListTile(
                      leading: Icon(
                        f.isDefault ? Icons.star : Icons.folder_outlined,
                        color: f.isDefault ? Colors.amber : null,
                      ),
                      title: Text(f.title),
                      subtitle: Text(
                        '${f.mediaCount} 个视频 · 同步：${formatDateTimeIso(f.lastSyncAt)}',
                        style: const TextStyle(fontSize: 12.5),
                      ),
                      trailing: Switch(
                        value: f.isSelected,
                        onChanged: (_) => notifier.toggleSelected(f),
                      ),
                      onTap: () async {
                        await context.push(
                          '/favorites/videos/${f.mediaId}',
                          extra: f,
                        );
                        notifier.refresh();
                      },
                    );
                  },
                ),
              ),
      ),
    );
  }
}
