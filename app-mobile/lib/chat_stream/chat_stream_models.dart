/// SSE 帧载荷模型 — 与 frontendv2/lib/chat-stream.ts 的 interface 一一对应。
/// 字段解析同时容忍 snake_case 与 camelCase（后端两种风格并存）。
library;

class ChatSource {
  ChatSource({required this.title, this.url, this.bvid});

  final String title;
  final String? url;
  final String? bvid;

  factory ChatSource.fromMap(dynamic raw) {
    final m = raw is Map ? raw : const <String, dynamic>{};
    return ChatSource(
      title: m['title']?.toString() ?? '',
      url: m['url']?.toString(),
      bvid: m['bvid']?.toString(),
    );
  }
}

/// 二进制产物（如 code agent 输出的图片）。
class ChatArtifact {
  ChatArtifact({
    required this.name,
    this.url,
    this.minioKey,
    this.contentType,
    this.size,
  });

  final String name;
  final String? url;
  final String? minioKey;
  final String? contentType;
  final int? size;

  factory ChatArtifact.fromMap(dynamic raw) {
    final m = raw is Map ? raw : const <String, dynamic>{};
    return ChatArtifact(
      name: m['name']?.toString() ?? '',
      url: m['url']?.toString(),
      minioKey: (m['minio_key'] ?? m['minioKey'])?.toString(),
      contentType: (m['content_type'] ?? m['contentType'])?.toString(),
      size: m['size'] is num ? (m['size'] as num).toInt() : null,
    );
  }
}

/// 检索/工具步骤（step 帧）。
class StreamStep {
  StreamStep({
    required this.step,
    required this.action,
    this.query,
    this.reasoning,
    this.sources,
    this.contentPreview,
    this.args,
    this.durationMs,
  });

  final int step;
  final String action;
  final String? query;
  final String? reasoning;
  final List<ChatSource>? sources;
  final String? contentPreview;

  /// 紧凑 JSON 参数预览（截断；done 帧省略）
  final String? args;

  /// 工具执行耗时 ms（仅 done 帧）
  final int? durationMs;

  factory StreamStep.fromMap(dynamic raw) {
    final m = raw is Map ? raw : const <String, dynamic>{};
    return StreamStep(
      step: m['step'] is num ? (m['step'] as num).toInt() : 0,
      action: m['action']?.toString() ?? '',
      query: m['query']?.toString(),
      reasoning: m['reasoning']?.toString(),
      sources: m['sources'] is List
          ? [for (final s in (m['sources'] as List)) ChatSource.fromMap(s)]
          : null,
      contentPreview: (m['content_preview'] ?? m['contentPreview'])?.toString(),
      args: m['args']?.toString(),
      durationMs: m['durationMs'] is num
          ? (m['durationMs'] as num).toInt()
          : (m['duration_ms'] is num ? (m['duration_ms'] as num).toInt() : null),
    );
  }
}

/// 排队状态（queue 帧：后端 admission 并发闸门）。
class QueueStatus {
  QueueStatus({required this.position, required this.waitedMs});

  final int position;
  final int waitedMs;
}

/// 子代理委派括号（delegate 帧）。
class DelegateStatus {
  DelegateStatus({
    required this.agent,
    required this.status,
    required this.active,
    required this.index,
  });

  final String agent;

  /// start | done
  final String status;
  final int active;
  final int index;

  bool get isDone => status == 'done';
}
