import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../api/pay.dart';

/// 会员档位（设置页 / 抽屉页脚徽标用；FutureProvider 进程内缓存）。
final membershipBadgeProvider = FutureProvider<PayMembership?>((ref) async {
  try {
    return await ref.read(payApiProvider).getMembership();
  } on ApiException {
    return null; // 未登录 / 服务不可达 → 不展示
  }
});
