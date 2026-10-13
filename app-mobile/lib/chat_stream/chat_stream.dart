import 'dart:convert';

import 'chat_stream_models.dart';

/// 模型随解析器一起导出，调用方只需 import chat_stream.dart。
export 'chat_stream_models.dart';

/// SSE 帧回调 — 与 frontendv2/lib/chat-stream.ts 的 StreamCallbacks 一一对应。
class ChatStreamCallbacks {
  ChatStreamCallbacks({
    required this.onChunk,
    this.onSources,
    this.onError,
    this.onComplete,
    this.onStep,
    this.onRoute,
    this.onReset,
    this.onArtifact,
    this.onQueueStatus,
    this.onDelegate,
    this.onReasoning,
  });

  final void Function(String accumulated, String delta) onChunk;
  final void Function(List<ChatSource> sources)? onSources;
  final void Function(String message)? onError;
  final void Function()? onComplete;
  final void Function(StreamStep step)? onStep;
  final void Function(String agent)? onRoute;
  final void Function()? onReset;
  final void Function(ChatArtifact artifact)? onArtifact;
  final void Function(QueueStatus status)? onQueueStatus;
  final void Function(DelegateStatus status)? onDelegate;

  /// 思考增量（不计入正文）。reset 帧不清 reasoning —— 后端 reset 后
  /// 不重放思考内容，清空会导致 ReAct 循环中思考「消失」。
  final void Function(String accumulated, String delta)? onReasoning;
}

/// 消费聊天 SSE 字节流（frontendv2/lib/chat-stream.ts 的 Dart 移植，语义逐条对齐）。
///
/// - 帧按空行分割；尾部残帧保留在缓冲，JSON 永远不会切半解析
/// - `data: [DONE]` 与 `type=done` 是唯一可信终止信号
/// - 流结束但没收到终止帧 = 异常中断（代理空闲超时/断网/服务崩溃），必须报错，
///   否则死连接看起来像「回答完了」
/// - [isCancelled] 返回 true（用户点了停止 / dio cancel）→ 静默结束，不报错
/// - `data: ` 之外的行（`: ping` 心跳等）与坏 JSON 帧跳过
Future<void> consumeChatStream(
  Stream<List<int>> byteStream,
  ChatStreamCallbacks callbacks, {
  bool Function()? isCancelled,
}) async {
  var accumulated = '';
  var reasoningAccumulated = '';
  var buffer = '';
  var completed = false;
  var errored = false;

  void handleFrame(String frame) {
    final line = frame.trim();
    if (line.startsWith(':')) return; // SSE 注释 / 心跳
    if (!line.startsWith('data: ')) return;
    final dataStr = line.substring(6);
    if (dataStr == '[DONE]') {
      completed = true;
      return;
    }
    dynamic data;
    try {
      data = jsonDecode(dataStr);
    } on FormatException {
      return; // 容忍坏帧（SSE 可能跨 chunk）
    }
    if (data is! Map) return;
    final type = data['type'];
    if (type == 'chunk') {
      final delta = data['content'] is String ? data['content'] as String : '';
      accumulated += delta;
      callbacks.onChunk(accumulated, delta);
    } else if (type == 'reasoning') {
      final delta = data['content'] is String ? data['content'] as String : '';
      reasoningAccumulated += delta;
      callbacks.onReasoning?.call(reasoningAccumulated, delta);
    } else if (type == 'sources') {
      final list = data['sources'];
      callbacks.onSources?.call(list is List
          ? [for (final s in list) ChatSource.fromMap(s)]
          : <ChatSource>[]);
    } else if (type == 'step') {
      callbacks.onStep?.call(StreamStep.fromMap(data['step']));
    } else if (type == 'route') {
      callbacks.onRoute?.call(data['agent']?.toString() ?? '');
    } else if (type == 'reset') {
      // 重试的 LLM run 开始：清正文（后端会以 chunk 重放 run 前内容），
      // 保留 reasoning —— 后端 reset 后不重放思考内容。
      accumulated = '';
      callbacks.onReset?.call();
    } else if (type == 'artifact') {
      callbacks.onArtifact?.call(ChatArtifact.fromMap(data['artifact']));
    } else if (type == 'queue') {
      callbacks.onQueueStatus?.call(QueueStatus(
        position: data['position'] is num ? (data['position'] as num).toInt() : 0,
        waitedMs: data['waitedMs'] is num ? (data['waitedMs'] as num).toInt() : 0,
      ));
    } else if (type == 'delegate') {
      callbacks.onDelegate?.call(DelegateStatus(
        agent: data['agent']?.toString() ?? '',
        status: data['status'] == 'done' ? 'done' : 'start',
        active: data['active'] is num ? (data['active'] as num).toInt() : 0,
        index: data['index'] is num ? (data['index'] as num).toInt() : 0,
      ));
    } else if (type == 'error') {
      errored = true;
      final msg = data['message'] ?? data['error'] ?? '请求失败';
      callbacks.onError?.call(msg.toString());
    } else if (type == 'done') {
      completed = true;
    }
  }

  try {
    await for (final text in utf8.decoder.bind(byteStream)) {
      if (isCancelled?.call() ?? false) break;
      buffer += text;
      final frames = buffer.split('\n\n');
      buffer = frames.removeLast(); // 尾部残帧留待下一片
      for (final frame in frames) {
        handleFrame(frame);
        if (completed) break;
      }
      if (completed) break;
    }

    // 用户主动取消：不报错
    if (isCancelled?.call() ?? false) return;
    // 无终止帧即结束 = 异常中断
    if (!completed && !errored) {
      callbacks.onError?.call('回复流中断（连接提前断开），请重试');
    }
  } catch (_) {
    // 底层流异常（含 dio cancel 引发的流错误）：非用户取消才报错
    if (!(isCancelled?.call() ?? false) && !errored && !completed) {
      callbacks.onError?.call('回复流中断（连接提前断开），请重试');
    }
  } finally {
    callbacks.onComplete?.call();
  }
}
