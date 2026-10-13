import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/error/error_mapper.dart';
import '../utils/defer.dart';

/// AsyncValue 统一渲染：loading / 错误重试 / 空态 / 数据。
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    super.key,
    required this.async,
    required this.builder,
    this.onRetry,
    this.isEmpty,
    this.emptyBuilder,
  });

  final AsyncValue<T> async;
  final Widget Function(BuildContext context, T data) builder;
  final Future<void> Function()? onRetry;
  final bool Function(T data)? isEmpty;
  final Widget Function(T data)? emptyBuilder;

  @override
  Widget build(BuildContext context) {
    return async.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => ErrorRetryView(message: describeError(e), onRetry: onRetry),
      data: (d) {
        if (isEmpty != null && isEmpty!(d)) {
          return emptyBuilder?.call(d) ?? const _EmptyView();
        }
        return builder(context, d);
      },
    );
  }
}

class ErrorRetryView extends StatelessWidget {
  const ErrorRetryView({super.key, required this.message, this.onRetry});

  final String message;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off, size: 40, color: Colors.grey),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                // 点击会同步把错误态换成加载态（自身移出树）→ 必须推迟到
                // 指针事件派发结束，否则 debug 触发 mouse_tracker 断言
                onPressed: () => runAfterGesture(onRetry!),
                icon: const Icon(Icons.refresh),
                label: const Text('重试'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Text('暂无数据', style: TextStyle(color: Colors.grey)),
      ),
    );
  }
}
