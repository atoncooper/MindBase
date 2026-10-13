import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mime/mime.dart';

import '../../api/user.dart';
import '../../core/auth/auth_controller.dart';
import '../../core/di.dart';
import '../../shared/utils/defer.dart';
import '../../core/error/api_exception.dart';

/// 个人资料编辑：头像上传（≤2MB PNG/JPG/WebP，multipart 固定字段 file）
/// + 昵称 / 简介（PATCH /auth/profile）。
class ProfileEditPage extends ConsumerStatefulWidget {
  const ProfileEditPage({super.key});

  @override
  ConsumerState<ProfileEditPage> createState() => _ProfileEditPageState();
}

class _ProfileEditPageState extends ConsumerState<ProfileEditPage> {
  ProfileData? _profile;
  bool _loading = true;
  String? _error;

  final _nicknameCtrl = TextEditingController();
  final _bioCtrl = TextEditingController();
  bool _saving = false;
  bool _uploadingAvatar = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nicknameCtrl.dispose();
    _bioCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final p = await ref.read(userApiProvider).getProfile();
      if (!mounted) return;
      setState(() {
        _profile = p;
        _nicknameCtrl.text = p.nickname ?? '';
        _bioCtrl.text = p.bio ?? '';
        _loading = false;
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

  Future<void> _pickAvatar() async {
    if (_uploadingAvatar) return;
    final result = await FilePicker.platform.pickFiles(
      type: FileType.image,
      withData: true,
    );
    if (!mounted) return;
    final file = result?.files.single;
    if (file == null || file.bytes == null) return;
    if (file.bytes!.lengthInBytes > 2 * 1024 * 1024) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('头像不能超过 2MB')),
      );
      return;
    }
    final mime = lookupMimeType(file.name, headerBytes: file.bytes) ?? 'image/png';
    if (mime != 'image/png' && mime != 'image/jpeg' && mime != 'image/webp') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('仅支持 PNG / JPG / WebP')),
      );
      return;
    }
    setState(() => _uploadingAvatar = true);
    try {
      final part = MultipartFile.fromBytes(
        file.bytes!,
        filename: file.name,
        contentType: DioMediaType(mime.split('/')[0], mime.split('/')[1]),
      );
      final url = await ref.read(userApiProvider).uploadAvatar(part);
      await ref.read(userApiProvider).updateProfile(avatar: url);
      await ref.read(authControllerProvider.notifier).reloadUser();
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('头像已更新')));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _uploadingAvatar = false);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await ref.read(userApiProvider).updateProfile(
            nickname: _nicknameCtrl.text.trim(),
            bio: _bioCtrl.text.trim(),
          );
      await ref.read(authControllerProvider.notifier).reloadUser();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('资料已保存')));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _profile;
    final avatar = p?.avatar;
    return Scaffold(
      appBar: AppBar(
        title: const Text('个人资料'),
        actions: [
          TextButton(
            onPressed: _loading || _saving ? null : _save,
            child: Text(_saving ? '保存中...' : '保存'),
          ),
        ],
      ),
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
                    Center(
                      child: Stack(
                        children: [
                          CircleAvatar(
                            radius: 40,
                            backgroundImage:
                                avatar != null && avatar.isNotEmpty
                                    ? NetworkImage(
                                        ref
                                            .read(appConfigProvider)
                                            .resolveAssetUrl(avatar),
                                      )
                                    : null,
                            child: (avatar == null || avatar.isEmpty)
                                ? const Icon(Icons.person, size: 36)
                                : null,
                          ),
                          Positioned(
                            right: 0,
                            bottom: 0,
                            child: InkWell(
                              onTap: _pickAvatar,
                              borderRadius: BorderRadius.circular(14),
                              child: Container(
                                padding: const EdgeInsets.all(5),
                                decoration: BoxDecoration(
                                  color: Theme.of(context).colorScheme.primary,
                                  shape: BoxShape.circle,
                                ),
                                child: _uploadingAvatar
                                    ? const SizedBox(
                                        width: 12,
                                        height: 12,
                                        child: CircularProgressIndicator(
                                            strokeWidth: 2))
                                    : const Icon(Icons.camera_alt,
                                        size: 14, color: Colors.white),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    Center(
                      child: Text(
                        '点击相机图标更换头像（≤2MB PNG/JPG/WebP）',
                        style: TextStyle(
                            fontSize: 11, color: Theme.of(context).hintColor),
                      ),
                    ),
                    const SizedBox(height: 20),
                    TextField(
                      controller: _nicknameCtrl,
                      decoration: const InputDecoration(labelText: '昵称'),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: _bioCtrl,
                      maxLines: 3,
                      decoration: const InputDecoration(
                          labelText: '个人简介', hintText: '介绍一下自己…'),
                    ),
                    const SizedBox(height: 14),
                    if (p?.email != null && p!.email!.isNotEmpty)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.mail_outline),
                        title: const Text('邮箱', style: TextStyle(fontSize: 15)),
                        subtitle: Text(
                          '${p.email}${p.emailVerified ? '（已验证）' : '（未验证）'}',
                          style: const TextStyle(fontSize: 12.5),
                        ),
                        trailing: p.emailVerified
                            ? const Icon(Icons.verified, color: Colors.green)
                            : const Icon(Icons.pending, color: Colors.orange),
                      ),
                  ],
                ),
    );
  }
}
