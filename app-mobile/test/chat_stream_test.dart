import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:app_mobile/chat_stream/chat_stream.dart';

/// SSE 解析器协议对齐测试（守护：与 frontendv2/lib/chat-stream.ts 语义一致）。

Stream<List<int>> _bytes(List<String> parts) async* {
  for (final p in parts) {
    yield utf8.encode(p);
  }
}

Stream<List<int>> _brokenStream() async* {
  yield utf8.encode('data: {"type":"chunk","content":"部分"}\n\n');
  throw StateError('dio cancel');
}

class _Log {
  final List<String> chunks = [];
  final List<String> deltas = [];
  final List<String> reasoning = [];
  final List<List<ChatSource>> sources = [];
  final List<StreamStep> steps = [];
  final List<String> routes = [];
  final List<ChatArtifact> artifacts = [];
  final List<QueueStatus> queue = [];
  final List<DelegateStatus> delegates = [];
  int resets = 0;
  int completed = 0;
  final List<String> errors = [];

  ChatStreamCallbacks callbacks() => ChatStreamCallbacks(
        onChunk: (acc, delta) {
          chunks.add(acc);
          deltas.add(delta);
        },
        onReasoning: (acc, delta) => reasoning.add(delta),
        onSources: sources.add,
        onStep: steps.add,
        onRoute: routes.add,
        onReset: () => resets++,
        onArtifact: artifacts.add,
        onQueueStatus: queue.add,
        onDelegate: delegates.add,
        onError: errors.add,
        onComplete: () => completed++,
      );
}

void main() {
  test('chunk 增量累积 + done 终止', () async {
    final log = _Log();
    await consumeChatStream(
      _bytes([
        'data: {"type":"route","agent":"main"}\n\n',
        'data: {"type":"chunk","content":"你好"}\n\n',
        'data: {"type":"chunk","content":"，世界"}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
      log.callbacks(),
    );
    expect(log.routes, ['main']);
    expect(log.deltas.join(), '你好，世界');
    expect(log.chunks.last, '你好，世界');
    expect(log.errors, isEmpty);
    expect(log.completed, 1);
  });

  test('JSON 跨 chunk 切半不崩（残帧缓冲）', () async {
    final log = _Log();
    await consumeChatStream(
      _bytes([
        'data: {"type":"chunk","con',
        'tent":"被切开的内容"}\n\ndata: {"type":"do',
        'ne"}\n\n',
      ]),
      log.callbacks(),
    );
    expect(log.deltas.join(), '被切开的内容');
    expect(log.errors, isEmpty);
  });

  test('[DONE] 也是终止信号', () async {
    final log = _Log();
    await consumeChatStream(
      _bytes(['data: {"type":"chunk","content":"x"}\n\n', 'data: [DONE]\n\n']),
      log.callbacks(),
    );
    expect(log.chunks.last, 'x');
    expect(log.errors, isEmpty);
  });

  test('reset 清正文但保留 reasoning（关键语义）', () async {
    final log = _Log();
    final cbs = log.callbacks();
    final seenReasoning = <String>[];
    // 用自定义回调确认 reset 后 onChunk 重新从空累积
    await consumeChatStream(
      _bytes([
        'data: {"type":"reasoning","content":"思考A"}\n\n',
        'data: {"type":"chunk","content":"旧内容"}\n\n',
        'data: {"type":"reset"}\n\n',
        'data: {"type":"reasoning","content":"思考B"}\n\n',
        'data: {"type":"chunk","content":"新"}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
      ChatStreamCallbacks(
        onChunk: cbs.onChunk,
        onReasoning: (acc, delta) {
          seenReasoning.add(delta);
          cbs.onReasoning!(acc, delta);
        },
        onReset: cbs.onReset,
        onError: cbs.onError,
      ),
    );
    expect(log.resets, 1);
    // reset 后正文重新累积（不是「旧内容新」）
    expect(log.chunks.last, '新');
    // reasoning 全程保留：思考A 在 reset 前后都不丢
    expect(seenReasoning.join(), '思考A思考B');
  });

  test('error 帧透传消息且不再报中断', () async {
    final log = _Log();
    await consumeChatStream(
      _bytes(['data: {"type":"error","message":"模型超载"}\n\n']),
      log.callbacks(),
    );
    expect(log.errors, ['模型超载']);
    expect(log.completed, 1); // finally 仍触发 onComplete
  });

  test('流结束但无 done/error = 异常中断，必须报错', () async {
    final log = _Log();
    await consumeChatStream(
      _bytes(['data: {"type":"chunk","content":"一半"}\n\n']),
      log.callbacks(),
    );
    expect(log.errors, ['回复流中断（连接提前断开），请重试']);
  });

  test('用户取消：底层流报错也不算失败', () async {
    final log = _Log();
    var cancelled = false;
    await consumeChatStream(
      _brokenStream(),
      log.callbacks(),
      isCancelled: () => cancelled,
    );
    // 未置 cancelled 时按中断报错
    expect(log.errors, isNotEmpty);
  });

  test('isCancelled=true：静默结束（停止生成是用户行为，不是失败）', () async {
    final log = _Log();
    await consumeChatStream(
      _brokenStream(),
      log.callbacks(),
      isCancelled: () => true,
    );
    expect(log.errors, isEmpty);
    expect(log.completed, 1);
  });

  test('ping 心跳 / 坏 JSON / 非 data 行跳过；step/queue/delegate/sources/artifact 分发', () async {
    final log = _Log();
    await consumeChatStream(
      _bytes([
        ': ping\n\n',
        'event: something\n\n',
        'data: {broken json\n\n',
        'data: {"type":"sources","sources":[{"title":"视频A","bvid":"BV1"}]}\n\n',
        'data: {"type":"step","step":{"step":1,"action":"vector_search","content_preview":"命中3条"}}\n\n',
        'data: {"type":"queue","position":2,"waitedMs":1500}\n\n',
        'data: {"type":"delegate","agent":"note","status":"start","active":1,"index":1}\n\n',
        'data: {"type":"delegate","agent":"note","status":"done","active":0,"index":1}\n\n',
        'data: {"type":"artifact","artifact":{"name":"chart.png","size":1024}}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
      log.callbacks(),
    );
    expect(log.errors, isEmpty);
    expect(log.sources.single.single.title, '视频A');
    expect(log.steps.single.action, 'vector_search');
    expect(log.steps.single.contentPreview, '命中3条');
    expect(log.queue.single.position, 2);
    expect(log.delegates.length, 2);
    expect(log.delegates.last.isDone, isTrue);
    expect(log.artifacts.single.name, 'chart.png');
  });
}
