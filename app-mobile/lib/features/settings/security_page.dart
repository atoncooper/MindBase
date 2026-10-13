import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/user.dart';
import '../../core/di.dart';
import '../../shared/utils/defer.dart';
import '../../core/error/api_exception.dart';
import '../../shared/widgets/bilibili_bind.dart';

/// 账号与安全：B站绑定状态（绑定/换绑扫码）+ 修改密码。
class SecurityPage extends ConsumerStatefulWidget {
  const SecurityPage({super.key});

  @override
  ConsumerState<SecurityPage> createState() => _SecurityPageState();
}

class _SecurityPageState extends ConsumerState<SecurityPage> {
  SecurityOverview? _security;
  bool _loading = true;
  String? _error;
  bool _showBind = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final s = await ref.read(userApiProvider).getSecurity();
      if (!mounted) return;
      setState(() {
        _security = s;
        _loading = false;
        // 未绑定 → 直接展开绑定卡
        _showBind = !(_security?.bilibili?.bound ?? false);
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bili = _security?.bilibili;
    return Scaffold(
      appBar: AppBar(title: const Text('账号与安全')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!),
                      const SizedBox(height: 12),
                      OutlinedButton(
                          onPressed: () => runAfterGesture(_load),
                          child: const Text('重试')),
                    ],
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const Text('哔哩哔哩账号',
                        style: TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 13)),
                    const SizedBox(height: 8),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(
                                  (bili?.bound ?? false)
                                      ? (bili!.valid
                                          ? Icons.verified
                                          : Icons.warning_amber_rounded)
                                      : Icons.link_off,
                                  size: 18,
                                  color: (bili?.bound ?? false)
                                      ? (bili!.valid
                                          ? Colors.green
                                          : Colors.orange)
                                      : Colors.grey,
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    !(bili?.bound ?? false)
                                        ? '未绑定'
                                        : (bili!.valid
                                            ? '已绑定 · ${bili.nickname ?? ''}（mid ${bili.mid ?? '-'}）'
                                            : '已绑定但授权已失效，请重新绑定'),
                                    style: const TextStyle(fontSize: 13),
                                  ),
                                ),
                                if (bili?.bound ?? false)
                                  TextButton(
                                    onPressed: () => setState(
                                        () => _showBind = !_showBind),
                                    child: Text(bili!.valid ? '换绑' : '重新绑定'),
                                  ),
                              ],
                            ),
                            if (_showBind ||
                                !(bili?.bound ?? false)) ...[
                              const SizedBox(height: 12),
                              BilibiliBindCard(
                                title: (bili?.bound ?? false)
                                    ? '重新扫码授权'
                                    : '绑定哔哩哔哩账号',
                                onBound: () => _load(),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    const Text('修改密码',
                        style: TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 13)),
                    const SizedBox(height: 8),
                    const _ChangePasswordCard(),
                    const SizedBox(height: 12),
                    const Text(
                      '首次设置密码（含邮箱验证码两步验证）请使用网页端完成。',
                      style: TextStyle(fontSize: 11, color: Colors.grey),
                    ),
                  ],
                ),
    );
  }
}

/// 修改密码卡片（旧密码 + 新密码 + 确认）。
class _ChangePasswordCard extends ConsumerStatefulWidget {
  const _ChangePasswordCard();

  @override
  ConsumerState<_ChangePasswordCard> createState() =>
      _ChangePasswordCardState();
}

class _ChangePasswordCardState extends ConsumerState<_ChangePasswordCard> {
  final _oldCtrl = TextEditingController();
  final _newCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _oldCtrl.dispose();
    _newCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final oldPwd = _oldCtrl.text;
    final newPwd = _newCtrl.text;
    if (oldPwd.isEmpty || newPwd.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请填写旧密码与新密码')));
      return;
    }
    if (newPwd != _confirmCtrl.text) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('两次输入的新密码不一致')));
      return;
    }
    if (newPwd.length < 8) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('新密码至少 8 位')));
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(userApiProvider).changePassword(
            oldPassword: oldPwd,
            newPassword: newPwd,
          );
      if (!mounted) return;
      _oldCtrl.clear();
      _newCtrl.clear();
      _confirmCtrl.clear();
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('密码已修改，其他设备需重新登录')));
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _oldCtrl,
              obscureText: true,
              decoration: const InputDecoration(labelText: '当前密码'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _newCtrl,
              obscureText: true,
              decoration: const InputDecoration(labelText: '新密码（至少 8 位）'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _confirmCtrl,
              obscureText: true,
              decoration: const InputDecoration(labelText: '确认新密码'),
            ),
            const SizedBox(height: 14),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? '提交中...' : '修改密码'),
            ),
          ],
        ),
      ),
    );
  }
}
