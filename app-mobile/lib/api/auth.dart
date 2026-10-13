import 'client.dart';

/// Auth API — B站扫码 / 密码登录 / token 管理。
/// 契约对齐 frontendv2/lib/api/auth.ts（响应经 snake→camel）。

class UserInfo {
  UserInfo({
    this.uid,
    this.mid,
    this.uname,
    this.nickname,
    this.face,
    this.avatar,
    this.level,
    this.roles = const [],
    this.sessionToken,
  });

  final int? uid;
  final int? mid;
  final String? uname;
  final String? nickname;
  final String? face;
  final String? avatar;
  final int? level;
  final List<String> roles;
  final String? sessionToken;

  factory UserInfo.fromMap(Map<String, dynamic> m) => UserInfo(
        uid: (m['uid'] as num?)?.toInt(),
        mid: (m['mid'] as num?)?.toInt(),
        uname: m['uname'] as String?,
        nickname: m['nickname'] as String?,
        face: m['face'] as String?,
        avatar: m['avatar'] as String?,
        level: (m['level'] as num?)?.toInt(),
        roles: (m['roles'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        sessionToken: m['sessionToken'] as String?,
      );

  /// 展示昵称：nickname > uname > 用户uid。
  String get displayName {
    final n = nickname;
    if (n != null && n.isNotEmpty) return n;
    final u = uname;
    if (u != null && u.isNotEmpty) return u;
    return '用户${uid ?? mid ?? 0}';
  }

  String? get avatarUrl => avatar ?? face;

  /// 展示缓存（camelCase 落 SharedPreferences，非敏感信息）。
  Map<String, dynamic> toCache() => {
        if (uid != null) 'uid': uid,
        if (mid != null) 'mid': mid,
        if (uname != null) 'uname': uname,
        if (nickname != null) 'nickname': nickname,
        if (face != null) 'face': face,
        if (avatar != null) 'avatar': avatar,
        if (level != null) 'level': level,
        'roles': roles,
      };

  factory UserInfo.fromCache(Map<String, dynamic> m) => UserInfo.fromMap(m);
}

class QRCodeResponse {
  QRCodeResponse({
    required this.qrcodeKey,
    required this.qrcodeUrl,
    this.qrcodeImageBase64,
  });

  final String qrcodeKey;
  final String qrcodeUrl;
  final String? qrcodeImageBase64;

  factory QRCodeResponse.fromMap(Map<String, dynamic> m) => QRCodeResponse(
        qrcodeKey: m['qrcodeKey'] as String? ?? '',
        qrcodeUrl: m['qrcodeUrl'] as String? ?? '',
        qrcodeImageBase64: m['qrcodeImageBase64'] as String?,
      );
}

class CaptchaResponse {
  CaptchaResponse({
    required this.captchaId,
    required this.imageBase64,
    required this.expiresIn,
    required this.required,
  });

  final String captchaId;
  /// data URL（data:image/png;base64,...）可直接给 Image.network
  final String imageBase64;
  final int expiresIn;
  /// false = 验证码闸门降级（未启用 / Redis 故障），隐藏输入框
  final bool required;

  factory CaptchaResponse.fromMap(Map<String, dynamic> m) => CaptchaResponse(
        captchaId: m['captchaId'] as String? ?? '',
        imageBase64: m['imageBase64'] as String? ?? '',
        expiresIn: (m['expiresIn'] as num?)?.toInt() ?? 0,
        required: m['required'] as bool? ?? false,
      );
}

class CaptchaValue {
  const CaptchaValue({required this.captchaId, required this.captchaCode});

  final String captchaId;
  final String captchaCode;
}

class AuthFeatures {
  AuthFeatures({required this.emailRegisterEnabled, required this.smsEnabled});

  final bool emailRegisterEnabled;
  final bool smsEnabled;

  factory AuthFeatures.fromMap(Map<String, dynamic> m) => AuthFeatures(
        emailRegisterEnabled: m['emailRegisterEnabled'] as bool? ?? false,
        smsEnabled: m['smsEnabled'] as bool? ?? false,
      );
}

class LoginStatusResponse {
  LoginStatusResponse({
    required this.status,
    required this.message,
    this.userInfo,
    this.sessionId,
  });

  /// waiting | scanned | confirmed | expired
  final String status;
  final String message;
  final UserInfo? userInfo;

  /// @deprecated legacy（对齐 web 端兜底逻辑）
  final String? sessionId;

  bool get isConfirmed => status == 'confirmed';
  bool get isExpired => status == 'expired';
  bool get isScanned => status == 'scanned';

  /// confirmed 后的会话令牌提取：user_info.session_token 优先，
  /// 退化用 session_id（legacy），对齐 web 端 login-modal。
  String? extractToken() =>
      userInfo?.sessionToken ?? sessionId;

  factory LoginStatusResponse.fromMap(Map<String, dynamic> m) =>
      LoginStatusResponse(
        status: m['status'] as String? ?? 'waiting',
        message: m['message'] as String? ?? '',
        userInfo: m['userInfo'] is Map ? UserInfo.fromMap(asMap(m['userInfo'])) : null,
        sessionId: m['sessionId'] as String?,
      );
}

class TokenResponse {
  TokenResponse({
    required this.sessionToken,
    required this.userInfo,
    this.tokenType,
    this.expiresAt,
  });

  final String sessionToken;
  final UserInfo userInfo;
  final String? tokenType;
  final String? expiresAt;

  factory TokenResponse.fromMap(Map<String, dynamic> m) => TokenResponse(
        sessionToken:
            m['sessionToken'] as String? ?? m['userInfo']?['sessionToken'] as String? ?? '',
        tokenType: m['tokenType'] as String?,
        expiresAt: m['expiresAt'] as String?,
        userInfo: UserInfo.fromMap(asMap(m['userInfo'])),
      );
}

class AuthApi {
  AuthApi(this._client);

  final ApiClient _client;

  /// 获取登录二维码。
  Future<QRCodeResponse> getQRCode() async =>
      QRCodeResponse.fromMap(asMap(await _client.request('GET', '/auth/qrcode')));

  /// 轮询登录状态（移动端轮询节奏见 login_page：2s）。
  Future<LoginStatusResponse> pollQRCode(String qrcodeKey) async =>
      LoginStatusResponse.fromMap(asMap(
        await _client.request('GET', '/auth/qrcode/poll/$qrcodeKey'),
      ));

  /// 已登录用户扫码绑定/刷新 B站授权（purpose=bind；Bearer 由 client 注入）。
  Future<LoginStatusResponse> pollQRCodeForBinding(String qrcodeKey) async =>
      LoginStatusResponse.fromMap(asMap(
        await _client.request(
          'GET',
          '/auth/qrcode/poll/$qrcodeKey',
          query: {'purpose': 'bind'},
        ),
      ));

  /// 图形验证码（密码登录前的人机校验）。
  Future<CaptchaResponse> getCaptcha() async =>
      CaptchaResponse.fromMap(asMap(await _client.request('GET', '/auth/captcha')));

  /// 登录/注册能力探测（未配置渠道的入口据此隐藏）。
  Future<AuthFeatures> getFeatures() async =>
      AuthFeatures.fromMap(asMap(await _client.request('GET', '/auth/features')));

  /// 邮箱或手机号 + 密码登录（二选一；captcha 一次性消费）。
  Future<TokenResponse> login({
    String? email,
    String? phone,
    required String password,
    CaptchaValue? captcha,
  }) async {
    return TokenResponse.fromMap(asMap(await _client.request(
      'POST',
      '/auth/login',
      body: {
        if (email != null && email.isNotEmpty) 'email': email,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
        'password': password,
        if (captcha != null) 'captcha_id': captcha.captchaId,
        if (captcha != null) 'captcha_code': captcha.captchaCode,
      },
    )));
  }

  /// 当前用户（Bearer 由 client 从 TokenStore 注入）。
  Future<UserInfo> getMe() async =>
      UserInfo.fromMap(asMap(await _client.request('GET', '/auth/me')));

  /// 登出当前设备。
  Future<void> logoutCurrent() async {
    await _client.request('DELETE', '/auth/token');
  }

  /// 登出全部设备。
  Future<void> logoutAll() async {
    await _client.request('DELETE', '/auth/tokens');
  }
}
