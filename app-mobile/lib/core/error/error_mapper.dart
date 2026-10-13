import 'api_exception.dart';

/// 任意异常 → 用户可读文案（页面统一入口）。
String describeError(Object error) {
  if (error is ApiException) return error.message;
  return '请求失败：${error.toString()}';
}

/// status → 用户可读文案（对齐 web 端 sanitizeError 的语义）。
///
/// - 业务 detail 非空时优先透传（后端经常给出明确原因，如「当前模型不支持视觉」）
/// - 网关 HTML 错误页在 client 层已拦截为「服务暂时不可用」，不会走到这里
String friendlyMessage({int? status, String? detail}) {
  if (detail != null && detail.trim().isNotEmpty) {
    return detail.trim();
  }
  switch (status) {
    case null:
      return '无法连接服务器，请检查网络或服务器地址';
    case 400:
      return '请求参数有误';
    case 401:
      return '登录已过期，请重新登录';
    case 403:
      return '没有权限执行该操作';
    case 404:
      return '资源不存在或已被删除';
    case 409:
      return '内容已被修改，请刷新后重试';
    case 413:
      return '内容过大';
    case 429:
      return '请求太频繁，请稍后再试';
    default:
      if (status >= 500) {
        return '服务暂时不可用，请稍后重试';
      }
      return '请求失败（$status）';
  }
}
