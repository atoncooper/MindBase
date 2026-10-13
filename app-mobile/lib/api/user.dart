import 'package:dio/dio.dart';

import 'client.dart';

/// User API — 个人资料 / 安全概览 / 密码。
/// 契约对齐 frontendv2/lib/api/user.ts；响应经 client 统一 snake→camel。

class ProfileData {
  ProfileData({
    required this.uid,
    this.email,
    this.emailVerified = false,
    this.phone,
    this.nickname,
    this.avatar,
    this.bio,
    this.timezone,
    this.language,
    this.createdAt,
  });

  final int uid;
  final String? email;
  final bool emailVerified;
  final String? phone;
  final String? nickname;
  final String? avatar;
  final String? bio;
  final String? timezone;
  final String? language;
  final String? createdAt;

  factory ProfileData.fromMap(Map<String, dynamic> m) => ProfileData(
        uid: (m['uid'] as num?)?.toInt() ?? 0,
        email: m['email'] as String?,
        emailVerified: m['emailVerified'] as bool? ?? false,
        phone: m['phone'] as String?,
        nickname: m['nickname'] as String?,
        avatar: m['avatar'] as String?,
        bio: m['bio'] as String?,
        timezone: m['timezone'] as String?,
        language: m['language'] as String?,
        createdAt: m['createdAt'] as String?,
      );
}

class BilibiliBinding {
  BilibiliBinding({
    required this.bound,
    required this.valid,
    this.mid,
    this.nickname,
    this.avatar,
    this.message,
  });

  final bool bound;
  final bool valid;
  final int? mid;
  final String? nickname;
  final String? avatar;
  final String? message;

  factory BilibiliBinding.fromMap(Map<String, dynamic> m) => BilibiliBinding(
        bound: m['bound'] as bool? ?? false,
        valid: m['valid'] as bool? ?? false,
        mid: (m['mid'] as num?)?.toInt(),
        nickname: m['nickname'] as String?,
        avatar: m['avatar'] as String?,
        message: m['message'] as String?,
      );
}

class SecurityOverview {
  SecurityOverview({
    this.hasPassword = false,
    this.bilibili,
  });

  final bool hasPassword;
  final BilibiliBinding? bilibili;

  factory SecurityOverview.fromMap(Map<String, dynamic> m) =>
      SecurityOverview(
        hasPassword: m['hasPassword'] as bool? ?? false,
        bilibili: m['bilibili'] is Map
            ? BilibiliBinding.fromMap(asMap(m['bilibili']))
            : null,
      );
}

class UserApi {
  UserApi(this._client);

  final ApiClient _client;

  Future<ProfileData> getProfile() async =>
      ProfileData.fromMap(asMap(await _client.request('GET', '/auth/profile')));

  Future<ProfileData> updateProfile({
    String? nickname,
    String? bio,
    String? avatar,
    String? timezone,
    String? language,
  }) async =>
      ProfileData.fromMap(asMap(await _client.request(
        'PATCH',
        '/auth/profile',
        body: {
          if (nickname != null) 'nickname': nickname,
          if (bio != null) 'bio': bio,
          if (avatar != null) 'avatar': avatar,
          if (timezone != null) 'timezone': timezone,
          if (language != null) 'language': language,
        },
      )));

  Future<SecurityOverview> getSecurity() async => SecurityOverview.fromMap(
      asMap(await _client.request('GET', '/auth/security')));

  /// 头像上传（multipart 字段固定为 file，≤2MB PNG/JPG/WebP）。
  Future<String> uploadAvatar(MultipartFile file) async {
    final form = FormData()..files.add(MapEntry('file', file));
    final m = asMap(await _client.request('POST', '/avatar/upload', form: form));
    return m['url'] as String? ?? '';
  }

  /// 修改密码。
  Future<void> changePassword({
    required String oldPassword,
    required String newPassword,
  }) async {
    await _client.request(
      'PATCH',
      '/auth/password',
      body: {'old_password': oldPassword, 'new_password': newPassword},
    );
  }
}
