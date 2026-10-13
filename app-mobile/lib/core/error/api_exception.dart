/// 统一网络业务异常。
///
/// - [status] 为 null：连接失败 / DNS 失败 / 未配置服务器地址（网络层，非业务层）
/// - [message] 已是用户可读文案（由 friendlyMessage 归一化）
class ApiException implements Exception {
  ApiException(this.status, this.message);

  final int? status;
  final String message;

  /// 用户主动取消（停止生成/取消上传）的哨兵 status。
  static const int cancelledStatus = -1;

  bool get isCancelled => status == cancelledStatus;
  bool get isUnauthorized => status == 401;
  bool get isConflict => status == 409;
  bool get isNotFound => status == 404;

  @override
  String toString() => message;
}
