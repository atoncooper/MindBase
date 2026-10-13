import 'package:flutter/material.dart';

/// 状态徽章：ASR/向量化/构建任务/订单/定时任务等枚举的统一展示。
/// 词表对齐后端枚举（含大小写差异：订单状态为全大写）。
const Map<String, String> kStatusLabels = {
  'pending': '待处理',
  'processing': '处理中',
  'running': '进行中',
  'generating': '生成中',
  'awaiting_answer': '待作答',
  'done': '已完成',
  'completed': '已完成',
  'failed': '失败',
  'overdue': '已逾期',
  'not_supported': '不支持',
  'CREATED': '待支付',
  'PAID': '已支付',
  'DELIVERED': '已交付',
  'CLOSED': '已关闭',
  'REFUNDING': '退款中',
  'REFUNDED': '已退款',
};

const Map<String, Color> kStatusColors = {
  'pending': Color(0xFFF57C00),
  'processing': Color(0xFF1565C0),
  'running': Color(0xFF1565C0),
  'generating': Color(0xFF1565C0),
  'awaiting_answer': Color(0xFFF57C00),
  'done': Color(0xFF2E7D32),
  'completed': Color(0xFF2E7D32),
  'failed': Color(0xFFC62828),
  'overdue': Color(0xFFC62828),
  'not_supported': Color(0xFF757575),
  'CREATED': Color(0xFFF57C00),
  'PAID': Color(0xFF1565C0),
  'DELIVERED': Color(0xFF2E7D32),
  'CLOSED': Color(0xFF757575),
  'REFUNDING': Color(0xFFF57C00),
  'REFUNDED': Color(0xFF6A1B9A),
};

class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.status, this.showRawFallback = true});

  final String status;
  final bool showRawFallback;

  @override
  Widget build(BuildContext context) {
    final label = kStatusLabels[status] ?? (showRawFallback ? status : '');
    final color = kStatusColors[status] ?? const Color(0xFF757575);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600),
      ),
    );
  }
}
