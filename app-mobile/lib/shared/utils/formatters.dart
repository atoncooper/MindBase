import 'package:intl/intl.dart';

/// 展示格式化（金额一律 long 分，仅在展示层格式化为元 —— 与后端约定一致）。

String formatCents(num cents) {
  final yuan = cents / 100;
  return yuan == yuan.roundToDouble()
      ? yuan.toStringAsFixed(0)
      : yuan.toStringAsFixed(2);
}

String formatDuration(int? seconds) {
  if (seconds == null || seconds <= 0) return '--:--';
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  final s = seconds % 60;
  if (h > 0) {
    return '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }
  return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
}

String formatBytes(int? bytes) {
  if (bytes == null || bytes < 0) return '-';
  if (bytes < 1024) return '$bytes B';
  final kb = bytes / 1024;
  if (kb < 1024) return '${kb.toStringAsFixed(1)} KB';
  final mb = kb / 1024;
  if (mb < 1024) return '${mb.toStringAsFixed(1)} MB';
  return '${(mb / 1024).toStringAsFixed(2)} GB';
}

/// ISO8601 → 本地 'yyyy-MM-dd HH:mm'；解析失败原样返回。
String formatDateTimeIso(String? iso) {
  if (iso == null || iso.isEmpty) return '-';
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  return DateFormat('yyyy-MM-dd HH:mm').format(dt.toLocal());
}

String formatPercent(double v) => '${(v * 100).clamp(0, 100).toStringAsFixed(0)}%';
