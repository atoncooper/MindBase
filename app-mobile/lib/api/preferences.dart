import 'client.dart';

/// Preferences API — 用户偏好（开放 map；壁纸等 web 专属项移动端暂不消费）。
/// 契约对齐 frontendv2/lib/api/preferences.ts。

class PreferencesApi {
  PreferencesApi(this._client);

  final ApiClient _client;

  /// 读取偏好（开放结构：{preferences: {...}}）。
  Future<Map<String, dynamic>> get() async {
    final m = asMap(await _client.request('GET', '/preferences'));
    final prefs = m['preferences'];
    return prefs is Map
        ? {for (final e in prefs.entries) e.key.toString(): e.value}
        : <String, dynamic>{};
  }

  /// 局部更新偏好（合并语义由服务端保证）。
  Future<Map<String, dynamic>> update(Map<String, dynamic> patch) async {
    final m = asMap(await _client.request(
      'PATCH',
      '/preferences',
      body: {'preferences': patch},
    ));
    final prefs = m['preferences'];
    return prefs is Map
        ? {for (final e in prefs.entries) e.key.toString(): e.value}
        : <String, dynamic>{};
  }
}
