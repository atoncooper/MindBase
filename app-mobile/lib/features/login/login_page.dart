import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/auth.dart';
import '../../core/auth/auth_controller.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../shared/widgets/glass.dart';

/// 登录页：B站扫码 + 密码登录。
///
/// 扫码悖论（手机上显示二维码给谁扫？）的移动端解法：
/// 1. 「复制链接」→ 剪贴板，在任意其他设备/浏览器打开完成授权
/// 2. 「唤起哔哩哔哩 App」→ qrcode_url 直接交给 B站 App 处理
/// 3. 密码登录兜底（图形验证码；验证码一次性消费，每次提交后强制刷新）
///
/// 轮询节奏与 web 端一致：2s/次；confirmed 后取 user_info.session_token
/// （退化 session_id），500ms 后进入主界面。
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  QRCodeResponse? _qr;
  String _qrStatus = 'waiting';
  String _qrMessage = '';
  Timer? _pollTimer;

  final _identifierCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _captchaCtrl = TextEditingController();
  CaptchaResponse? _captcha;
  bool _captchaLoading = false;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _tabController.addListener(_onTabChanged);
    _startQr();
  }

  @override
  void dispose() {
    _stopPolling();
    _tabController.removeListener(_onTabChanged);
    _tabController.dispose();
    _identifierCtrl.dispose();
    _passwordCtrl.dispose();
    _captchaCtrl.dispose();
    super.dispose();
  }

  void _onTabChanged() {
    if (_tabController.indexIsChanging && _tabController.index == 1) {
      _ensureCaptcha();
    }
  }

  // ---- 扫码登录 ----

  Future<void> _startQr() async {
    _stopPolling();
    setState(() {
      _qr = null;
      _qrStatus = 'waiting';
      _qrMessage = '';
    });
    try {
      final qr = await ref.read(authApiProvider).getQRCode();
      if (!mounted) return;
      setState(() => _qr = qr);
      _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) => _poll());
    } on ApiException catch (e) {
      if (mounted) setState(() => _qrMessage = e.message);
    }
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> _poll() async {
    final key = _qr?.qrcodeKey;
    if (key == null || key.isEmpty) return;
    try {
      final res = await ref.read(authApiProvider).pollQRCode(key);
      if (!mounted) return;
      setState(() {
        _qrStatus = res.status;
        _qrMessage = res.message;
      });
      if (res.isConfirmed) {
        _stopPolling();
        final token = res.extractToken();
        if (token == null || token.isEmpty) {
          setState(() => _qrMessage = '登录成功但未返回会话令牌');
          return;
        }
        // 对齐 web 端：confirmed 后 500ms 再进入主界面
        await Future<void>.delayed(const Duration(milliseconds: 500));
        if (!mounted) return;
        await ref.read(authControllerProvider.notifier).onLoginSuccess(
              TokenResponse(
                sessionToken: token,
                userInfo: res.userInfo ?? UserInfo(),
              ),
            );
      } else if (res.isExpired) {
        _stopPolling();
      }
    } on ApiException catch (e) {
      // 瞬时网络错误吞掉继续轮询（对齐 web 端行为）
      if (e.status == null) return;
    }
  }

  Future<void> _copyLink() async {
    final url = _qr?.qrcodeUrl;
    if (url == null) return;
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('登录链接已复制，请在其他设备打开完成扫码')),
      );
    }
  }

  Future<void> _launchBilibili() async {
    final url = _qr?.qrcodeUrl;
    if (url == null) return;
    final uri = Uri.tryParse(url);
    if (uri != null && await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  // ---- 密码登录 ----

  Future<void> _ensureCaptcha() async {
    if (_captcha != null || _captchaLoading) return;
    setState(() => _captchaLoading = true);
    try {
      final c = await ref.read(authApiProvider).getCaptcha();
      if (mounted) setState(() => _captcha = c);
    } on ApiException catch (_) {
      // 验证码闸门降级时接口可能不可用：按 required=false 处理
    } finally {
      if (mounted) setState(() => _captchaLoading = false);
    }
  }

  Future<void> _submitPassword() async {
    final identifier = _identifierCtrl.text.trim();
    final password = _passwordCtrl.text;
    if (identifier.isEmpty || password.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请填写账号与密码')),
      );
      return;
    }
    setState(() => _submitting = true);
    try {
      final hasAt = identifier.contains('@');
      CaptchaValue? captcha;
      if (_captcha != null && _captcha!.required) {
        captcha = CaptchaValue(
          captchaId: _captcha!.captchaId,
          captchaCode: _captchaCtrl.text.trim(),
        );
      }
      final res = await ref.read(authApiProvider).login(
            email: hasAt ? identifier : null,
            phone: hasAt ? null : identifier,
            password: password,
            captcha: captcha,
          );
      if (!mounted) return;
      await ref.read(authControllerProvider.notifier).onLoginSuccess(res);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message)),
        );
      }
    } finally {
      // 验证码一次性消费：无论成败都换新的（对齐 web 端）
      _captcha = null;
      _captchaCtrl.clear();
      await _ensureCaptcha();
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      backgroundColor: Colors.transparent,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        flexibleSpace: GlassContainer(blur: 18, child: const SizedBox.expand()),
        title: const Text('登录 MindBase'),
      ),
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: isDark
                ? const [Color(0xFF1C1C1E), Color(0xFF0E0E0F)]
                : const [Color(0xFFEEF1F6), Color(0xFFDCE3EE)],
          ),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            children: [
              SizedBox(height: MediaQuery.paddingOf(context).top + kToolbarHeight),
              TabBar(
                controller: _tabController,
                tabs: const [Tab(text: '扫码登录'), Tab(text: '密码登录')],
              ),
              Expanded(
                child: TabBarView(
                  controller: _tabController,
                  children: [_buildQrTab(), _buildPasswordTab()],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildQrTab() {
    final qr = _qr;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Center(
          child: GlassContainer(
            blur: 26,
            borderRadius: BorderRadius.circular(20),
            tint: Colors.white.withValues(alpha: 0.85),
            padding: const EdgeInsets.all(12),
            child: qr == null
                ? const SizedBox(
                    width: 200,
                    height: 200,
                    child: Center(child: CircularProgressIndicator()),
                  )
                : QrImageView(
                    data: qr.qrcodeUrl,
                    size: 200,
                    backgroundColor: Colors.white,
                  ),
          ),
        ),
        const SizedBox(height: 20),
        Center(
          child: Text(
            _qrStatus == 'expired'
                ? '二维码已过期'
                : _qrStatus == 'scanned'
                    ? '已扫描，请在手机上确认登录'
                    : '请使用哔哩哔哩 App 扫码登录',
            style: TextStyle(
              color: _qrStatus == 'expired' || _qrMessage.isNotEmpty
                  ? Theme.of(context).colorScheme.error
                  : null,
            ),
          ),
        ),
        if (_qrMessage.isNotEmpty) ...[
          const SizedBox(height: 8),
          Center(
            child: Text(
              _qrMessage,
              style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12.5),
              textAlign: TextAlign.center,
            ),
          ),
        ],
        const SizedBox(height: 20),
        if (_qrStatus == 'expired')
          FilledButton.icon(
            onPressed: _startQr,
            icon: const Icon(Icons.refresh),
            label: const Text('重新获取'),
          )
        else ...[
          OutlinedButton.icon(
            onPressed: qr == null ? null : _launchBilibili,
            icon: const Icon(Icons.open_in_new),
            label: const Text('唤起哔哩哔哩 App'),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: qr == null ? null : _copyLink,
            icon: const Icon(Icons.copy),
            label: const Text('复制登录链接（在其他设备打开）'),
          ),
        ],
      ],
    );
  }

  Widget _buildPasswordTab() {
    final captcha = _captcha;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        GlassContainer(
          blur: 24,
          borderRadius: BorderRadius.circular(20),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _identifierCtrl,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(
                  labelText: '邮箱或手机号',
                  prefixIcon: Icon(Icons.person_outline),
                ),
              ),
        const SizedBox(height: 16),
        TextField(
          controller: _passwordCtrl,
          obscureText: true,
          decoration: const InputDecoration(
            labelText: '密码',
            prefixIcon: Icon(Icons.lock_outline),
          ),
        ),
        if (_captchaLoading && captcha == null)
          const Padding(
            padding: EdgeInsets.only(top: 20),
            child: SizedBox(
              height: 44,
              child: Center(
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ),
          ),
        if (captcha != null && captcha.required) ...[
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _captchaCtrl,
                  decoration: const InputDecoration(labelText: '图形验证码'),
                ),
              ),
              const SizedBox(width: 12),
              // 点击换一张（验证码一次性消费，提交后也会强制刷新）
              GestureDetector(
                onTap: () {
                  setState(() => _captcha = null);
                  _ensureCaptcha();
                },
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: _CaptchaImage(dataUri: captcha.imageBase64),
                ),
              ),
            ],
          ),
        ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _submitting ? null : _submitPassword,
                child: Text(_submitting ? '登录中...' : '登录'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          '没有账号？邮箱注册请使用网页端完成（移动端暂不支持注册与短信验证码）。',
          style: TextStyle(fontSize: 12.5, color: Colors.grey),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}

/// 图形验证码。
///
/// 后端返回的是 **data URI**（`data:image/png;base64,...`，web 端 <img> 可直接吃），
/// 而 Flutter 的 Image.network/NetworkImage **不支持 data: 协议** —— 必须
/// base64 解码后走 Image.memory；兼容裸 base64 与 http URL 两种兜底形态。
class _CaptchaImage extends StatelessWidget {
  const _CaptchaImage({required this.dataUri});

  final String dataUri;

  Widget _errorPlaceholder() {
    return SizedBox(
      width: 100,
      height: 44,
      child: Center(
        child: Text('加载失败',
            style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final uri = dataUri.trim();
    Widget image;
    if (uri.startsWith('data:')) {
      final base64Part = uri.split(',').skip(1).join();
      try {
        image = Image.memory(
          base64Decode(base64Part),
          height: 44,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => _errorPlaceholder(),
        );
      } on FormatException {
        image = _errorPlaceholder();
      }
    } else if (uri.startsWith('http')) {
      image = Image.network(
        uri,
        height: 44,
        fit: BoxFit.contain,
        errorBuilder: (_, __, ___) => _errorPlaceholder(),
      );
    } else {
      // 兜底：裸 base64（无 data: 前缀）
      try {
        image = Image.memory(
          base64Decode(uri),
          height: 44,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => _errorPlaceholder(),
        );
      } on FormatException {
        image = _errorPlaceholder();
      }
    }
    return SizedBox(height: 44, child: image);
  }
}
