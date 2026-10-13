import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/di.dart';
import '../../core/error/error_mapper.dart';

/// 服务器地址配置页（首次启动 / 设置页进入）。
///
/// 地址解析链（app_config.dart）：
/// 编译期 --dart-define=API_BASE_URL > 本页手动配置 > 统一域名默认值（预留位）。
/// 统一域名接入后填 `AppConfig.unifiedApiDomain`，本页仅作联调兜底。
class ServerSetupPage extends ConsumerStatefulWidget {
  const ServerSetupPage({super.key});

  @override
  ConsumerState<ServerSetupPage> createState() => _ServerSetupPageState();
}

class _ServerSetupPageState extends ConsumerState<ServerSetupPage> {
  final _controller = TextEditingController();
  bool _selfSigned = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final config = ref.read(appConfigProvider);
    _controller.text = config.manualOverride ?? '';
    _selfSigned = config.allowSelfSignedDebug;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      final config = ref.read(appConfigProvider);
      await config.setManualOverride(_controller.text);
      if (kDebugMode) {
        await config.setAllowSelfSignedDebug(_selfSigned);
      }
      await ref.read(authControllerProvider.notifier).reconfigure();
      // 成功后由路由重定向接走
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(describeError(e))),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 清除手动配置 → 回退统一域名默认值（未设置时回到本页引导）。
  Future<void> _resetToBuiltIn() async {
    setState(() => _busy = true);
    try {
      final config = ref.read(appConfigProvider);
      await config.clearManualOverride();
      _controller.clear();
      await ref.read(authControllerProvider.notifier).reconfigure();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _statusRow(String label, String value, {Color? valueColor}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 108,
            child: Text(label, style: const TextStyle(fontSize: 12.5, color: Colors.grey)),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(fontSize: 12.5, color: valueColor),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.read(appConfigProvider);
    final locked = config.isLockedByBuildTime;
    final builtIn = config.builtInDomain;

    return Scaffold(
      appBar: AppBar(title: const Text('配置服务器')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('地址解析链',
                      style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  const SizedBox(height: 6),
                  _statusRow(
                    '编译期地址',
                    config.compileTimeBaseOrNull ?? '未设置（--dart-define=API_BASE_URL）',
                  ),
                  _statusRow(
                    '统一域名',
                    builtIn ?? '未设置（填 app_config.dart 的 unifiedApiDomain）',
                    valueColor: builtIn == null ? Colors.orange : null,
                  ),
                  _statusRow(
                    '手动覆盖',
                    config.manualOverride ?? '未配置',
                  ),
                  const Divider(height: 16),
                  _statusRow(
                    '当前生效',
                    config.effectiveBase ?? '尚未配置',
                    valueColor: Theme.of(context).colorScheme.primary,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            '与网页端共用同一套 APISIX 网关接口，无需移动端专用后端。'
            '正式部署由统一域名默认值兜底，本页仅用于联调覆盖。',
            style: TextStyle(color: Colors.grey, fontSize: 12.5),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _controller,
            enabled: !locked,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: '手动覆盖地址（可选）',
              hintText: 'https://your-domain.com',
              prefixIcon: Icon(Icons.dns),
            ),
          ),
          if (locked)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                '编译期已固化 API_BASE_URL，无法在此修改。',
                style: TextStyle(color: Colors.orange),
              ),
            ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('允许自签证书（仅调试构建）'),
            subtitle: const Text('release 构建强制关闭；正式联调请配置覆盖真机地址的证书 SAN'),
            value: kDebugMode && _selfSigned,
            onChanged: kDebugMode
                ? (v) => setState(() => _selfSigned = v)
                : null,
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Text(_busy ? '保存中...' : '保存并连接'),
          ),
          if (!locked && config.manualOverride != null) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: _busy ? null : _resetToBuiltIn,
              icon: const Icon(Icons.undo),
              label: const Text('清除手动配置，回退统一域名'),
            ),
          ],
        ],
      ),
    );
  }
}
