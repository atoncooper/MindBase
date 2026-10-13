import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 服务器地址解析（对齐 frontendv2/lib/api/deployment.ts 的"运行时解析"思路）。
///
/// 优先级：
/// 1. 编译期 --dart-define=API_BASE_URL=...（CI / 发布固化，设置页锁定不可改）
/// 2. 用户在设置页保存的地址（本地持久化）
/// 两者都没有 → effectiveBase 为 null，路由重定向到服务器配置页。
///
/// 注意：请求每次调用都读 effectiveBase，修改地址后立即生效（无需重建 dio）。
class AppConfig {
  AppConfig(this._prefs);

  /// 编译期地址（--dart-define=API_BASE_URL=https://example.com）
  static const String compileTimeBase = String.fromEnvironment('API_BASE_URL');

  /// ⚠️ 统一 API 域名（预留位）。
  ///
  /// 接入统一域名后把地址填在这里（如 'https://api.mindbase.example.com'），
  /// 全端立即生效、无需用户手动配置；发布时也可用 --dart-define=API_BASE_URL
  /// 覆盖（优先级更高）。除本常量外，任何文件不得散落写服务器地址。
  static const String unifiedApiDomain = '';

  static const String _kOverrideKey = 'api_base_override';
  static const String _kSelfSignedKey = 'allow_self_signed';

  final SharedPreferences _prefs;

  String? get compileTimeBaseOrNull =>
      compileTimeBase.isEmpty ? null : normalize(compileTimeBase);

  String? get manualOverride {
    final v = _prefs.getString(_kOverrideKey);
    if (v == null || v.isEmpty) return null;
    return normalize(v);
  }

  /// 统一域名默认值（[unifiedApiDomain] 已填时非空）。
  String? get builtInDomain =>
      unifiedApiDomain.isEmpty ? null : normalize(unifiedApiDomain);

  /// 当前是否正在使用统一域名默认值（无编译期地址、无手动覆盖）。
  bool get usingBuiltInDomain =>
      compileTimeBaseOrNull == null && manualOverride == null && builtInDomain != null;

  /// 当前生效的 base url；null 表示尚未配置。
  ///
  /// 优先级：编译期 dart-define > 用户手动配置（设置页）> 统一域名默认值。
  String? get effectiveBase =>
      compileTimeBaseOrNull ?? manualOverride ?? builtInDomain;

  bool get isLockedByBuildTime => compileTimeBaseOrNull != null;

  /// 自签证书调试开关：仅 debug 构建生效，release 恒为 false（平台红线）。
  bool get allowSelfSignedDebug =>
      !kReleaseMode && _prefs.getBool(_kSelfSignedKey) == true;

  Future<void> setAllowSelfSignedDebug(bool value) =>
      _prefs.setBool(_kSelfSignedKey, value);

  /// 保存手动配置的地址。非法输入抛 [ArgumentError]（页面捕获后提示）。
  Future<void> setManualOverride(String raw) async {
    final normalized = normalize(raw);
    final uri = Uri.tryParse(normalized);
    if (uri == null ||
        (uri.scheme != 'https' && uri.scheme != 'http') ||
        uri.host.isEmpty) {
      throw ArgumentError('服务器地址必须是 http(s)://host[:port] 形式');
    }
    await _prefs.setString(_kOverrideKey, normalized);
  }

  Future<void> clearManualOverride() => _prefs.remove(_kOverrideKey);

  /// 归一化：去首尾空白、去末尾 "/"。
  static String normalize(String raw) {
    var v = raw.trim();
    while (v.endsWith('/')) {
      v = v.substring(0, v.length - 1);
    }
    return v;
  }

  /// 拼接请求地址（path 以 "/" 开头）。未配置时抛 [StateError]。
  String url(String path) {
    final base = effectiveBase;
    if (base == null) {
      throw StateError('服务器地址尚未配置');
    }
    return base + path;
  }

  /// 静态资源地址解析（头像 / 缩略图 / 预览 / 聊天图片等）。
  ///
  /// 后端（app-ts / app-cloud）的 MinIO 预签名链接在未配置 publicEndpoint
  /// 时是 **相对路径**（/minio-proxy/...）—— web 同源可直接吃，移动端必须
  /// 拼上网关地址；data: 与 http(s) 开头原样返回。
  String resolveAssetUrl(String url) {
    if (url.startsWith('/')) {
      final base = effectiveBase;
      if (base != null) return base + url;
    }
    return url;
  }
}
