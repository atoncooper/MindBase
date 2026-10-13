import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'pay_controllers.dart';

/// 会员档位小徽标：免费 → 灰字；VIP → 金色；SVIP → 紫色。
/// 加载失败 / 未登录时整体不占位。
class TierBadge extends ConsumerWidget {
  const TierBadge({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final membership = ref.watch(membershipBadgeProvider).value;
    final m = membership;
    if (m == null || m.isFree) {
      return const Text('免费',
          style: TextStyle(fontSize: 11, color: Colors.grey));
    }
    final isSvip = m.tier == 'SVIP';
    final color = isSvip ? const Color(0xFF6A1B9A) : const Color(0xFFB8860B);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        m.tier ?? '',
        style: TextStyle(
            fontSize: 11, fontWeight: FontWeight.w600, color: color),
      ),
    );
  }
}
