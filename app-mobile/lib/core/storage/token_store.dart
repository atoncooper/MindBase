import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 身份态存储。
///
/// - token（bili_session）是敏感凭据，**只**进 Keychain / Keystore
///   （flutter_secure_storage）。禁止写 SharedPreferences / 日志 / 上报。
/// - 用户展示信息（昵称/头像等，对齐 web 端 localStorage 的 bili_user）
///   非敏感，放 SharedPreferences 作展示缓存。
class TokenStore {
  TokenStore({FlutterSecureStorage? secure, required SharedPreferences prefs})
      : _secure = secure ?? const FlutterSecureStorage(),
        _prefs = prefs;

  static const String _tokenKey = 'bili_session';
  static const String _userKey = 'bili_user';

  final FlutterSecureStorage _secure;
  final SharedPreferences _prefs;

  Future<String?> readToken() => _secure.read(key: _tokenKey);

  Future<void> writeToken(String token) =>
      _secure.write(key: _tokenKey, value: token);

  Future<void> clearToken() => _secure.delete(key: _tokenKey);

  Map<String, dynamic>? readUserCached() {
    final raw = _prefs.getString(_userKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> writeUserCached(Map<String, dynamic> user) =>
      _prefs.setString(_userKey, jsonEncode(user));

  Future<void> clearUserCached() => _prefs.remove(_userKey);

  Future<void> clearAll() async {
    await clearToken();
    await clearUserCached();
  }
}
