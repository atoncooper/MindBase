import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/auth.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import 'glass.dart';

/// B站扫码绑定卡（purpose=bind，2s 轮询）。
/// 用于：收藏夹未绑定的引导（409）、账号与安全页的绑定/换绑。
class BilibiliBindCard extends ConsumerStatefulWidget {
  const BilibiliBindCard({super.key, this.title = '绑定哔哩哔哩账号', this.onBound});

  final String title;
  final VoidCallback? onBound;

  @override
  ConsumerState<BilibiliBindCard> createState() => _BilibiliBindCardState();
}

class _BilibiliBindCardState extends ConsumerState<BilibiliBindCard> {
  QRCodeResponse? _qr;
  String _status = 'waiting';
  String _message = '';
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    _timer?.cancel();
    setState(() {
      _qr = null;
      _status = 'waiting';
      _message = '';
    });
    try {
      final qr = await ref.read(authApiProvider).getQRCode();
      if (!mounted) return;
      setState(() => _qr = qr);
      _timer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => _poll(qr.qrcodeKey),
      );
    } on ApiException catch (e) {
      if (mounted) setState(() => _message = e.message);
    }
  }

  Future<void> _poll(String key) async {
    try {
      final res = await ref.read(authApiProvider).pollQRCodeForBinding(key);
      if (!mounted) return;
      setState(() {
        _status = res.status;
        _message = res.message;
      });
      if (res.isConfirmed) {
        _timer?.cancel();
        widget.onBound?.call();
      } else if (res.isExpired) {
        _timer?.cancel();
      }
    } on ApiException catch (e) {
      if (e.status == null) return; // 瞬时网络错误继续轮询
      if (mounted) setState(() => _message = e.message);
    }
  }

  Future<void> _copyLink() async {
    final url = _qr?.qrcodeUrl;
    if (url == null) return;
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('链接已复制，在其他设备打开完成绑定')),
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

  @override
  Widget build(BuildContext context) {
    final qr = _qr;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          widget.title,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        Center(
          child: GlassContainer(
            blur: 26,
            borderRadius: BorderRadius.circular(20),
            tint: Colors.white.withValues(alpha: 0.85),
            padding: const EdgeInsets.all(12),
            child: qr == null
                ? const SizedBox(
                    width: 180,
                    height: 180,
                    child: Center(child: CircularProgressIndicator()),
                  )
                : QrImageView(
                    data: qr.qrcodeUrl,
                    size: 180,
                    backgroundColor: Colors.white,
                  ),
          ),
        ),
        const SizedBox(height: 14),
        Text(
          _status == 'confirmed'
              ? '绑定成功！'
              : _status == 'expired'
                  ? '二维码已过期'
                  : _status == 'scanned'
                      ? '已扫描，请在手机上确认'
                      : '请使用哔哩哔哩 App 扫码绑定',
          style: TextStyle(
            fontSize: 13,
            color: _status == 'confirmed'
                ? Colors.green
                : (_status == 'expired' || _message.isNotEmpty
                    ? Theme.of(context).colorScheme.error
                    : null),
          ),
        ),
        if (_message.isNotEmpty && _status != 'confirmed')
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              _message,
              style: TextStyle(
                  fontSize: 12.5, color: Theme.of(context).colorScheme.error),
              textAlign: TextAlign.center,
            ),
          ),
        const SizedBox(height: 14),
        if (_status == 'expired')
          FilledButton.icon(
            onPressed: _start,
            icon: const Icon(Icons.refresh),
            label: const Text('重新获取'),
          )
        else if (_status != 'confirmed') ...[
          OutlinedButton.icon(
            onPressed: qr == null ? null : _launchBilibili,
            icon: const Icon(Icons.open_in_new),
            label: const Text('唤起哔哩哔哩 App'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: qr == null ? null : _copyLink,
            icon: const Icon(Icons.copy),
            label: const Text('复制链接（在其他设备打开）'),
          ),
        ],
      ],
    );
  }
}
