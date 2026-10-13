import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mime/mime.dart';

import '../../api/chat.dart';
import '../../chat_stream/chat_stream.dart';
import '../../core/auth/auth_controller.dart';
import '../../core/di.dart';
import '../../core/error/api_exception.dart';
import '../../core/theme/app_theme.dart';
import '../../shared/utils/defer.dart';
import '../../shared/widgets/async_view.dart';
import '../../shared/widgets/gemini_spark.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/markdown_view.dart';
import '../quiz/quiz_take_page.dart';
import 'chat_controllers.dart';
import 'chat_drawer.dart';

/// 聊天主页（Google Gemini 移动端风格）：
/// - 主界面即对话；抽屉（ChatDrawer）负责会话切换/搜索/分组，无底部 Tab
/// - 用户消息浅表面气泡居右（右下收窄），回答无气泡、渐变星标头像 + 全宽 Markdown
/// - 空态：渐变星标 + 大问候语 + 浅表面带图标建议卡（20 圆角）
/// - 毛玻璃胶囊输入栏：附加图片 + 渐变发送/停止圆钮
///
/// SSE 协议语义完整保留（route/queue/delegate/step/reasoning/reset/artifact/
/// sources/error/done/停止生成/单轮重新生成），详见 consumeChatStream。
class ChatPage extends ConsumerStatefulWidget {
  const ChatPage({super.key});

  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage> {
  ChatSession? _session;

  final List<ChatMessage> _messages = [];
  final TextEditingController _inputCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();

  bool _loadingHistory = false;
  String? _historyError;
  bool _hasMore = false;
  int _page = 0;
  bool _hasText = false;
  bool _showScrollDown = false;

  // 流式瞬态
  bool _streaming = false;
  String _streamedText = '';
  String _reasoningText = '';
  final List<StreamStep> _steps = [];
  List<ChatSource> _sources = [];
  final List<ChatArtifact> _artifacts = [];
  String? _routeAgent;
  QueueStatus? _queue;
  DelegateStatus? _delegate;
  String? _streamError;
  bool _showReasoning = false;

  CancelToken? _cancelToken;
  bool _cancelled = false;

  /// 待发送图片（data URL；是否支持视觉由后端按当前模型裁决）
  final List<String> _pendingImages = [];

  // 流式节流缓冲：chunk 高频到达时先落缓冲，按帧批量刷 UI
  String _pendingText = '';
  String _pendingReasoning = '';
  bool _flushScheduled = false;

  ChatApi get _api => ref.read(chatApiProvider);

  @override
  void initState() {
    super.initState();
    _session = ref.read(currentSessionProvider);
    // 抽屉切换会话 → 切换对话（地址相同则忽略）
    ref.listenManual(currentSessionProvider, (prev, next) {
      if ((next?.chatSessionId ?? '') != (_session?.chatSessionId ?? '')) {
        _switchTo(next);
      }
    });
    // 上滑查看历史时出现「回到底部」悬浮钮
    _scrollCtrl.addListener(_onScroll);
    if (_session != null) {
      _loadingHistory = true;
      unawaited(_loadHistory());
    }
  }

  @override
  void dispose() {
    _cancelled = true;
    _cancelToken?.cancel();
    _scrollCtrl.removeListener(_onScroll);
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollCtrl.hasClients) return;
    final distance =
        _scrollCtrl.position.maxScrollExtent - _scrollCtrl.position.pixels;
    final show = distance > 300;
    if (show != _showScrollDown) {
      setState(() => _showScrollDown = show);
    }
  }

  /// 切换会话：清空全部瞬态并加载目标历史。
  void _switchTo(ChatSession? next) {
    _cancelled = true;
    _cancelToken?.cancel();
    setState(() {
      _session = next;
      _messages.clear();
      _page = 0;
      _hasMore = false;
      _historyError = null;
      _loadingHistory = next != null;
      _streaming = false;
      _streamedText = '';
      _reasoningText = '';
      _steps.clear();
      _sources = [];
      _artifacts.clear();
      _routeAgent = null;
      _queue = null;
      _delegate = null;
      _streamError = null;
      _showReasoning = false;
      _cancelled = false;
      _pendingImages.clear();
      _hasText = false;
    });
    _inputCtrl.clear();
    if (next != null) {
      unawaited(_loadHistory());
    }
  }

  /// 加载历史消息。
  ///
  /// ⚠️ 后端 /chat/history 是**升序分页**（第 1 页 = 最早的 50 条），
  /// 打开会话必须先探首页、再跳到最后一页，才能看到最近的对话；
  /// 只拉第 1 页会让长会话永远停在最早的消息上（web 端同款处理）。
  Future<void> _loadHistory({bool more = false}) async {
    final session = _session;
    if (session == null) return;
    if (more && _page <= 1) return;
    try {
      final ChatHistoryResponse res;
      if (more) {
        // 更早消息 = 当前页的上一页（升序分页）
        res = await _api.getHistory(
          session.chatSessionId,
          page: _page - 1,
          pageSize: 50,
        );
      } else {
        var first = await _api.getHistory(session.chatSessionId, pageSize: 50);
        if (first.hasMore && first.messages.length == 50) {
          final lastPage = (first.total + 49) ~/ 50;
          first = await _api.getHistory(
            session.chatSessionId,
            page: lastPage,
            pageSize: 50,
          );
        }
        res = first;
      }
      if (!mounted) return;
      setState(() {
        if (more) {
          _messages.insertAll(0, res.messages);
          _page = _page - 1;
        } else {
          _messages
            ..clear()
            ..addAll(res.messages);
          _page = res.page > 0 ? res.page : 1;
        }
        // 后端 hasMore 语义是「更晚的消息还有」，此处关心的是「更早的还有」
        _hasMore = _page > 1;
        _historyError = null;
        _loadingHistory = false;
      });
      if (!more) _scrollToBottom();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _loadingHistory = false;
          _historyError = e.message;
        });
      }
    } catch (_) {
      // 解析/类型异常也要落地为可见错误，避免永远转圈
      if (mounted) {
        setState(() {
          _loadingHistory = false;
          _historyError = '加载历史消息失败，请重试';
        });
      }
    }
  }

  /// 单轮结束后的回读：拿服务端真实 msgId（重新生成依赖），不做整页替换。
  /// 与 web 端 backfillMessageIds 同语义 —— 仅当服务端与本地**条数一致且
  /// 逐条 role 对齐**时回填，否则保留本地（服务端可能尚未落库）。
  Future<void> _backfillMsgIds() async {
    final session = _session;
    if (session == null || _messages.isEmpty) return;
    try {
      var res = await _api.getHistory(session.chatSessionId, pageSize: 50);
      if (res.hasMore && res.messages.length == 50) {
        final lastPage = (res.total + 49) ~/ 50;
        res = await _api.getHistory(
          session.chatSessionId,
          page: lastPage,
          pageSize: 50,
        );
      }
      final server = res.messages;
      if (!mounted || server.length != _messages.length) return;
      final patched = List<ChatMessage>.of(_messages);
      for (var i = 0; i < patched.length; i++) {
        final sm = server[i];
        final local = patched[i];
        if (sm.role != local.role) return; // 未对齐：整体放弃，保留本地
        if (local.msgId.isEmpty && sm.msgId.isNotEmpty) {
          patched[i] = ChatMessage(
            msgId: sm.msgId,
            role: local.role,
            content: local.content,
            status: local.status,
            sources: local.sources,
            images: local.images,
            artifacts: local.artifacts,
            tokensUsed: local.tokensUsed,
            model: local.model,
            latencyMs: local.latencyMs,
            error: local.error,
            createdAt: local.createdAt,
          );
        }
      }
      if (mounted) {
        setState(() => _messages
          ..clear()
          ..addAll(patched));
      }
    } catch (_) {
      // 回读是尽力而为：失败只影响「重新生成」入口，不影响展示
    }
  }

  /// 帧级节流：把缓冲文本一次性刷进 UI（每帧最多一次 setState）。
  void _scheduleFlush() {
    if (_flushScheduled) return;
    _flushScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _flushScheduled = false;
      if (!mounted || _cancelled) return;
      setState(() {
        _streamedText = _pendingText;
        _reasoningText = _pendingReasoning;
      });
      _scrollToBottom();
    });
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollCtrl.hasClients) return;
      _scrollCtrl.animateTo(
        _scrollCtrl.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  // ------------------------------------------------------------------
  // 发送 / 停止 / 重新生成
  // ------------------------------------------------------------------

  Future<void> _send({bool addUserMessage = true, String? overrideQuestion}) async {
    if (_streaming) return;
    final question = (overrideQuestion ?? _inputCtrl.text).trim();
    if (question.isEmpty) return;
    HapticFeedback.lightImpact();

    // ChatGPT 式：新对话在首条消息发送时才真正创建会话
    if (_session == null) {
      try {
        final s = await _api.createSession();
        if (!mounted) return;
        if (s.chatSessionId.isEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('会话创建失败（未返回会话 ID）')),
          );
          return;
        }
        setState(() => _session = s);
        ref.read(currentSessionProvider.notifier).state = s;
        unawaited(ref.read(chatSessionsProvider.notifier).refresh());
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(e.message)));
        }
        return;
      }
    }

    final images = List<String>.of(_pendingImages);
    setState(() {
      _streaming = true;
      _streamedText = '';
      _reasoningText = '';
      _steps.clear();
      _sources = [];
      _artifacts.clear();
      _routeAgent = null;
      _queue = null;
      _delegate = null;
      _streamError = null;
      _showReasoning = false;
      _cancelled = false;
      _pendingImages.clear();
      _pendingText = '';
      _pendingReasoning = '';
      _hasText = false;
      if (addUserMessage) {
        _messages.add(ChatMessage(
          msgId: '',
          role: 'user',
          content: question,
          status: 'completed',
          images: images,
          createdAt: '',
        ));
      }
    });
    _inputCtrl.clear();
    _scrollToBottom();

    _cancelToken = CancelToken();
    Stream<List<int>> stream;
    try {
      stream = await _api.askStream(
        question: question,
        chatSessionId: _session!.chatSessionId,
        images: images.isNotEmpty ? images : null,
        cancelToken: _cancelToken,
      );
    } on ApiException catch (e) {
      if (!e.isCancelled && mounted) {
        setState(() {
          _streamError = e.message;
          _streaming = false;
        });
      }
      return;
    }

    await consumeChatStream(
      stream,
      ChatStreamCallbacks(
        onChunk: (acc, delta) {
          // 高频 chunk：落缓冲 + 帧级节流，避免每 token 全页 setState
          _pendingText = acc;
          _queue = null;
          _scheduleFlush();
        },
        onReasoning: (acc, _) {
          _pendingReasoning = acc;
          _scheduleFlush();
        },
        onSources: (s) {
          if (mounted) setState(() => _sources = s);
        },
        onStep: (s) {
          if (mounted) {
            setState(() => _steps.add(s));
            _scrollToBottom();
          }
        },
        onRoute: (a) {
          if (mounted) {
            setState(() {
              _routeAgent = a;
              _queue = null;
            });
          }
        },
        onReset: () {
          // 清正文，保留 reasoning（对齐 web 端关键语义）
          if (mounted) setState(() => _streamedText = '');
        },
        onArtifact: (a) {
          if (mounted) setState(() => _artifacts.add(a));
        },
        onQueueStatus: (q) {
          if (mounted) setState(() => _queue = q);
        },
        onDelegate: (d) {
          if (mounted) {
            setState(() {
              _delegate = (d.isDone && d.active == 0) ? null : d;
            });
          }
        },
        onError: (m) {
          if (mounted) setState(() => _streamError = m);
        },
      ),
      isCancelled: () => _cancelled,
    );

    // 收尾：消费节流缓冲，落成一条 assistant 消息并回读历史拿真实 msgId
    if (!mounted) return;
    final text = _pendingText.isNotEmpty ? _pendingText : _streamedText;
    setState(() {
      _streaming = false;
      _streamedText = '';
      _reasoningText = '';
      _pendingText = '';
      _pendingReasoning = '';
      _steps.clear();
      if (text.isNotEmpty || _streamError != null) {
        _messages.add(ChatMessage(
          msgId: '',
          role: 'assistant',
          content: text,
          status: _streamError == null ? 'completed' : 'failed',
          sources: _sources,
          artifacts: List.of(_artifacts),
          error: _streamError,
          createdAt: '',
        ));
      }
      _sources = [];
      _artifacts.clear();
      _routeAgent = null;
      _queue = null;
      _delegate = null;
    });
    _scrollToBottom();
    // 回读历史拿服务端 msgId（重新生成依赖真实 msgId）；等待服务端落库
    await Future<void>.delayed(const Duration(milliseconds: 600));
    if (mounted && !_streaming) unawaited(_backfillMsgIds());
  }

  Future<void> _stop() async {
    HapticFeedback.lightImpact();
    _cancelled = true;
    _cancelToken?.cancel();
  }

  /// 单轮重新生成：截断该回答及其后消息（服务端删除），再重问。
  Future<void> _regenerate(ChatMessage assistantMsg) async {
    if (_streaming || assistantMsg.msgId.isEmpty) return;
    final idx = _messages.indexOf(assistantMsg);
    String? question;
    for (var i = idx - 1; i >= 0; i--) {
      if (_messages[i].isUser) {
        question = _messages[i].content;
        break;
      }
    }
    if (question == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重新生成本轮回答'),
        content: const Text('该回答及其之后的消息将被删除并重新生成。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _api.truncateHistoryFrom(
        _session!.chatSessionId,
        assistantMsg.msgId,
      );
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
        return;
      }
    }
    await _loadHistory();
    if (mounted) {
      unawaited(_send(addUserMessage: false, overrideQuestion: question));
    }
  }

  /// 选择图片并转 data URL（多模态：随消息附带，不支持时由后端流内报原因）。
  /// 从当前对话生成测验（generate-from-summary → 轮询就绪 → 答题页）。
  Future<void> _generateQuizFromChat() async {
    final session = _session;
    if (session == null) return;
    HapticFeedback.selectionClick();
    try {
      final res = await ref.read(quizApiProvider).generateFromSummary(
            chatSessionId: session.chatSessionId,
            title: session.displayTitle,
          );
      if (!mounted) return;

      var pollStarted = false;
      final ready = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (dialogCtx) {
          if (!pollStarted) {
            pollStarted = true;
            unawaited(() async {
              var quiz =
                  await ref.read(quizApiProvider).getQuiz(res.quizUuid);
              var tries = 0;
              while (quiz.questions.isEmpty &&
                  quiz.status == 'generating' &&
                  tries < 40) {
                await Future<void>.delayed(const Duration(seconds: 3));
                quiz = await ref.read(quizApiProvider).getQuiz(res.quizUuid);
                tries++;
              }
              if (dialogCtx.mounted) {
                Navigator.pop(dialogCtx, quiz.questions.isNotEmpty);
              }
            }());
          }
          return AlertDialog(
            title: const Text('AI 正在从对话出题…'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: const [
                LinearProgressIndicator(),
                SizedBox(height: 12),
                Text('通常需要十几秒，请稍候',
                    style: TextStyle(fontSize: 12.5, color: Colors.grey)),
              ],
            ),
          );
        },
      );
      if (ready != true || !mounted) return;

      final quiz = await ref.read(quizApiProvider).getQuiz(res.quizUuid);
      if (!mounted) return;
      if (quiz.questions.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('题目尚未就绪，稍后可在测验页重试')),
        );
        return;
      }
      await Navigator.of(context, rootNavigator: true).push(
        MaterialPageRoute(builder: (_) => QuizTakePage(quiz: quiz)),
      );
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _attachImages() async {
    // 桌面无相机（image_picker Windows 不支持 camera），直接走文件选择；
    // 移动端弹层三选：拍照 / 相册 / 文件。
    if (_isDesktop) {
      await _attachFromFiles();
      return;
    }
    final source = await showModalBottomSheet<_AttachSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 6),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('拍照'),
              onTap: () => Navigator.pop(ctx, _AttachSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('从相册选择'),
              onTap: () => Navigator.pop(ctx, _AttachSource.gallery),
            ),
            ListTile(
              leading: const Icon(Icons.insert_drive_file_outlined),
              title: const Text('从文件选择'),
              onTap: () => Navigator.pop(ctx, _AttachSource.files),
            ),
            const SizedBox(height: 6),
          ],
        ),
      ),
    );
    if (source == null || !mounted) return;
    switch (source) {
      case _AttachSource.camera:
        await _attachFromCamera();
      case _AttachSource.gallery:
        await _attachFromGallery();
      case _AttachSource.files:
        await _attachFromFiles();
    }
  }

  /// 拍照：系统相机；质量 88 + 最长边约束，避免直出原图超 5MB 被拒。
  Future<void> _attachFromCamera() async {
    try {
      final shot = await ImagePicker().pickImage(
        source: ImageSource.camera,
        imageQuality: 88,
        maxWidth: 2560,
      );
      if (shot == null) return;
      final bytes = await shot.readAsBytes();
      if (!mounted) return;
      _addImageBytes(bytes, shot.name);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('相机不可用或已取消')),
        );
      }
    }
  }

  /// 相册多选：受剩余附件位约束。
  Future<void> _attachFromGallery() async {
    try {
      final remaining = 4 - _pendingImages.length;
      if (remaining <= 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('最多附带 4 张图片')),
        );
        return;
      }
      final shots = await ImagePicker().pickMultiImage(
        imageQuality: 88,
        maxWidth: 2560,
        limit: remaining,
      );
      for (final shot in shots) {
        final bytes = await shot.readAsBytes();
        if (!mounted) return;
        _addImageBytes(bytes, shot.name);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('相册不可用或已取消')),
        );
      }
    }
  }

  /// 文件选择（桌面主路径，移动端兜底）。
  Future<void> _attachFromFiles() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.image,
      withData: true,
      allowMultiple: true,
    );
    if (!mounted) return;
    final files = result?.files ?? const <PlatformFile>[];
    for (final f in files) {
      if (f.bytes == null) continue;
      _addImageBytes(f.bytes!, f.name);
    }
  }

  /// 统一入口：4 张上限 + 5MB 单图限制 + data URL 转换。
  void _addImageBytes(Uint8List bytes, String name) {
    if (_pendingImages.length >= 4) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('最多附带 4 张图片')),
      );
      return;
    }
    if (bytes.lengthInBytes > 5 * 1024 * 1024) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$name 超过 5MB，已跳过')),
      );
      return;
    }
    final mime = lookupMimeType(name, headerBytes: bytes) ?? 'image/jpeg';
    setState(() {
      _pendingImages.add('data:$mime;base64,${base64Encode(bytes)}');
    });
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // Scaffold + drawer 自动提供左上角菜单按钮
      drawer: const ChatDrawer(),
      // 右滑打开侧边栏：默认 20px 边缘太窄，放宽到 80px（手指自然落在
      // 屏幕左缘即可触发；列表本身无横向手势，不会误触）
      drawerEdgeDragWidth: 80,
      // 毛玻璃布局：列表延伸到 AppBar 与输入栏之下（blur 才有内容可透）
      extendBody: true,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        // 性能取舍：AppBar 只做半透明 tint 不做 blur —— 长列表滚动时
        // BackdropFilter 逐帧重模糊是全局卡顿的大头；玻璃质感保留在输入栏
        backgroundColor: Colors.transparent,
        flexibleSpace: DecoratedBox(
          decoration: BoxDecoration(
            color: Theme.of(context).brightness == Brightness.dark
                ? Colors.black.withValues(alpha: 0.45)
                : Colors.white.withValues(alpha: 0.65),
          ),
        ),
        title: Text(
          _session?.displayTitle ?? 'MindBase',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          IconButton(
            tooltip: '从对话出题',
            icon: const Icon(Icons.quiz_outlined),
            onPressed: _session == null ? null : _generateQuizFromChat,
          ),
          IconButton(
            tooltip: '新对话',
            icon: const Icon(Icons.mode_edit_outline_outlined),
            onPressed: () => ref.read(currentSessionProvider.notifier).state = null,
          ),
        ],
      ),
      body: Stack(
        children: [
          Positioned.fill(
            // 会话切换 / 空态↔消息：淡入淡出过渡（key 变化触发）
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              switchInCurve: Curves.easeOut,
              switchOutCurve: Curves.easeIn,
              child: KeyedSubtree(
                key: ValueKey(
                    'chat-${_session?.chatSessionId ?? 'new'}-$_loadingHistory-${_historyError != null}'),
                child: _loadingHistory
                    ? const Center(child: CircularProgressIndicator())
                    : _historyError != null
                        ? ErrorRetryView(
                            message: _historyError!,
                            onRetry: () async {
                              setState(() {
                                _loadingHistory = true;
                                _historyError = null;
                              });
                              await _loadHistory();
                            },
                          )
                        : (_messages.isEmpty && !_streaming && _streamError == null)
                            ? _buildEmptyState()
                            : _buildMessageList(),
              ),
            ),
          ),
          if (_showScrollDown)
            Positioned(
              right: 16,
              bottom: 104,
              child: _ScrollDownButton(onTap: _scrollToBottom),
            ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: _buildInputBar(),
          ),
        ],
      ),
    );
  }

  /// 空态（Gemini 风格）：渐变星标 + 大问候 + 带图标浅表面建议卡
  /// （点击填入输入框，不直接发送）。
  Widget _buildEmptyState() {
    final user = ref.watch(authControllerProvider).user;
    const suggestions = [
      ('总结一个视频讲了什么', Icons.smart_display_outlined),
      ('把这段对话整理成笔记', Icons.edit_note_outlined),
      ('根据我的收藏出一套测验', Icons.quiz_outlined),
      ('我的知识盲区有哪些', Icons.travel_explore_outlined),
    ];
    return Center(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          24,
          MediaQuery.paddingOf(context).top + kToolbarHeight + 24,
          24,
          150,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Center(child: GeminiSpark(size: 44)),
            const SizedBox(height: 18),
            Text(
              user == null ? '你好' : '你好，${user.displayName}',
              style: const TextStyle(
                  fontSize: 28, fontWeight: FontWeight.w500),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              '有什么可以帮忙的？',
              style: TextStyle(
                  fontSize: 14.5, color: Theme.of(context).hintColor),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 32),
            for (var i = 0; i < suggestions.length; i += 2)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                // IntrinsicHeight：滚动区内高度无界，Row 的 stretch 需要
                // 先解析出内容高度（否则 BoxConstraints forces infinite height）
                child: IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        child: _suggestionCard(
                            suggestions[i].$1, suggestions[i].$2),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: i + 1 < suggestions.length
                            ? _suggestionCard(
                                suggestions[i + 1].$1, suggestions[i + 1].$2)
                            : const SizedBox.shrink(),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Gemini 式建议卡：浅表面填充（无描边）、20 圆角、左侧功能图标。
  Widget _suggestionCard(String text, IconData icon) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: () {
        _inputCtrl.text = text;
        setState(() => _hasText = true);
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          color: isDark
              ? AppTheme.surfaceTintDark
              : AppTheme.surfaceTintLight,
        ),
        child: Row(
          children: [
            Icon(icon,
                size: 20,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.72)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                text,
                style: const TextStyle(fontSize: 13.5, height: 1.4),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList() {
    final showStreamArea = _streaming || _streamError != null;
    return ListView.builder(
      controller: _scrollCtrl,
      // 底部留出毛玻璃输入栏的透出空间；顶部避让毛玻璃 AppBar
      padding: EdgeInsets.fromLTRB(
        16,
        MediaQuery.paddingOf(context).top + kToolbarHeight + 8,
        16,
        132,
      ),
      itemCount: _messages.length + (_hasMore ? 1 : 0) + (showStreamArea ? 1 : 0),
      itemBuilder: (context, i) {
        if (_hasMore && i == 0) {
          return TextButton(
            onPressed: () =>
                runAfterGesture(() => unawaited(_loadHistory(more: true))),
            child: const Text('加载更早消息', style: TextStyle(fontSize: 12.5)),
          );
        }
        final offset = _hasMore ? 1 : 0;
        final msgIndex = i - offset;
        if (msgIndex < _messages.length) {
          return _buildMessage(_messages[msgIndex]);
        }
        return _buildStreamingBubble();
      },
    );
  }

  Widget _buildMessage(ChatMessage m) {
    if (m.isUser) {
      final isDark = Theme.of(context).brightness == Brightness.dark;
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.fromLTRB(56, 8, 4, 8),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          constraints:
              BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
          decoration: BoxDecoration(
            color: isDark
                ? AppTheme.userBubbleDark
                : AppTheme.userBubbleLight,
            // Gemini 气泡：大圆角 + 右下角收窄
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(24),
              topRight: Radius.circular(24),
              bottomLeft: Radius.circular(24),
              bottomRight: Radius.circular(6),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              SelectableText(m.content, style: const TextStyle(height: 1.35)),
              _buildImageStrip(m.images),
            ],
          ),
        ),
      );
    }
    // Gemini 回答：无气泡，左侧渐变星标头像 + 全宽正文
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 10, 16, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 3),
            child: GeminiSpark(size: 16),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (m.isFailed && (m.error?.isNotEmpty ?? false))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Text(
                      m.error!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                          fontSize: 12.5),
                    ),
                  ),
                MarkdownView(data: m.content),
                _buildImageStrip(m.images),
                _buildMessageFooter(m),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMessageFooter(ChatMessage m) {
    final children = <Widget>[
      Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _IconAction(
            icon: Icons.copy,
            tooltip: '复制',
            onTap: () {
              HapticFeedback.selectionClick();
              Clipboard.setData(ClipboardData(text: m.content));
            },
          ),
          if (m.msgId.isNotEmpty)
            _IconAction(
              icon: Icons.refresh,
              tooltip: '重新生成本轮回答',
              onTap: _streaming ? null : () => unawaited(_regenerate(m)),
            ),
        ],
      ),
    ];
    if (m.sources.isNotEmpty) {
      children.add(Wrap(
        spacing: 6,
        runSpacing: 4,
        children: [
          for (final s in m.sources)
            ActionChip(
              label: Text(s.title, style: const TextStyle(fontSize: 11)),
              visualDensity: VisualDensity.compact,
              side: BorderSide(color: Theme.of(context).dividerColor),
              onPressed: () => showGlassSheet(
                context: context,
                builder: (_) => _SourceSheet(sources: m.sources),
              ),
            ),
        ],
      ));
    }
    for (final a in m.artifacts) {
      if (a.url != null && (a.contentType?.startsWith('image/') ?? false)) {
        children.add(Padding(
          padding: const EdgeInsets.only(top: 6),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.network(_resolveImageUrl(a.url!), width: 220),
          ),
        ));
      }
    }
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
  }

  /// 流式中的回答区（Gemini 布局：星标头像 + 正文，样式从简）。
  Widget _buildStreamingBubble() {
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 10, 16, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 3),
            child: GeminiSpark(size: 16),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
          if (_routeAgent != null && _routeAgent!.isNotEmpty)
            Text('智能体：$_routeAgent',
                style: TextStyle(
                    fontSize: 11, color: Theme.of(context).hintColor)),
          if (_queue != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '排队中（第 ${_queue!.position} 位）',
                    style: TextStyle(
                        fontSize: 12.5, color: Theme.of(context).hintColor),
                  ),
                ],
              ),
            ),
          if (_delegate != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '子代理 ${_delegate!.agent} 处理中…',
                style: TextStyle(
                    fontSize: 12.5, color: Theme.of(context).hintColor),
              ),
            ),
          if (_steps.isNotEmpty) _buildSteps(),
          if (_reasoningText.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => setState(() => _showReasoning = !_showReasoning),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        _showReasoning ? Icons.expand_less : Icons.expand_more,
                        size: 15,
                        color: Theme.of(context).hintColor,
                      ),
                      const SizedBox(width: 4),
                      Text('思考过程',
                          style: TextStyle(
                              fontSize: 12.5, color: Theme.of(context).hintColor)),
                    ],
                  ),
                ),
              ),
            ),
          // 思考面板展开/收起：尺寸动画（对齐 ChatGPT 的平滑感）
          AnimatedSize(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOut,
            alignment: Alignment.topLeft,
            child: _showReasoning && _reasoningText.isNotEmpty
                ? Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(top: 4, bottom: 6),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color:
                          Theme.of(context).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      _reasoningText,
                      style: TextStyle(
                          fontSize: 12.5,
                          color: Theme.of(context).hintColor,
                          height: 1.4),
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
          if (_streamedText.isEmpty && _streamError == null && _steps.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 10),
              child: _ThinkingDots(),
            )
          else ...[
            // 流式中用纯文本 + 光标（Markdown 全量解析是卡顿大头），
            // 收尾瞬间切换为格式化 Markdown 渲染
            SelectableText(
              _streamedText,
              style: const TextStyle(fontSize: 15, height: 1.55),
            ),
            if (_streaming) const _BlinkingCursor(),
          ],
          if (_artifacts.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Wrap(
                spacing: 6,
                children: [
                  for (final a in _artifacts)
                    InputChip(
                      label: Text(a.name, style: const TextStyle(fontSize: 11)),
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
            ),
          if (_streamError != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _streamError!,
                style: TextStyle(
                    color: Theme.of(context).colorScheme.error, fontSize: 12.5),
              ),
            ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSteps() {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 6),
        initiallyExpanded: false,
        title: Text(
          '已检索 ${_steps.length} 步',
          style: TextStyle(fontSize: 12.5, color: Theme.of(context).hintColor),
        ),
        children: [
          for (final s in _steps)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Text('${s.step}',
                  style: TextStyle(color: Theme.of(context).hintColor)),
              title: Text(s.action, style: const TextStyle(fontSize: 12.5)),
              subtitle: s.query != null || s.contentPreview != null
                  ? Text(
                      [s.query, s.contentPreview].whereType<String>().join(' · '),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11),
                    )
                  : null,
              trailing: s.durationMs != null
                  ? Text('${s.durationMs}ms',
                      style: TextStyle(
                          fontSize: 11, color: Theme.of(context).hintColor))
                  : null,
            ),
        ],
      ),
    );
  }

  /// 毛玻璃胶囊输入栏：附件预览 + [附加图片 | 文本 | 发送/停止]。
  /// 桌面端（Windows/macOS/Linux）启用 Enter 发送；移动端走发送按钮。
  bool get _isDesktop {
    switch (defaultTargetPlatform) {
      case TargetPlatform.windows:
      case TargetPlatform.macOS:
      case TargetPlatform.linux:
        return true;
      default:
        return false;
    }
  }

  Widget _buildInputBar() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_pendingImages.isNotEmpty)
              SizedBox(
                height: 62,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    for (var i = 0; i < _pendingImages.length; i++)
                      Stack(
                        children: [
                          Padding(
                            padding: const EdgeInsets.only(right: 8, bottom: 4),
                            child: _ChatImage(url: _pendingImages[i], size: 54),
                          ),
                          Positioned(
                            right: 0,
                            top: 0,
                            child: GestureDetector(
                              onTap: () =>
                                  setState(() => _pendingImages.removeAt(i)),
                              child: Container(
                                decoration: BoxDecoration(
                                  color: Colors.black54,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: const Icon(Icons.close,
                                    size: 14, color: Colors.white),
                              ),
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            GlassContainer(
              blur: 14,
              borderRadius: BorderRadius.circular(30),
              tint: isDark
                  ? Colors.white.withValues(alpha: 0.10)
                  : Colors.white.withValues(alpha: 0.68),
              padding: const EdgeInsets.fromLTRB(4, 4, 6, 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    icon: const Icon(Icons.add, size: 24),
                    tooltip: '添加图片（拍照 / 相册 / 文件，需模型支持视觉）',
                    onPressed: _streaming ? null : _attachImages,
                  ),
                  Expanded(
                    // 流式生成时保持可输入：用户可预编辑下一条消息，
                    // 发送按钮此时已切换为「停止」，Enter 不会误发。
                    child: Focus(
                      onKeyEvent: _isDesktop
                          ? (node, event) {
                              // 桌面端：Enter 发送，Shift+Enter 换行；
                              // 移动端保持 Enter=换行（输入法友好），发送走按钮。
                              if (event is! KeyDownEvent) return KeyEventResult.ignored;
                              final key = event.logicalKey;
                              final isEnter = key == LogicalKeyboardKey.enter ||
                                  key == LogicalKeyboardKey.numpadEnter;
                              if (!isEnter) return KeyEventResult.ignored;
                              if (HardwareKeyboard.instance.isShiftPressed) {
                                return KeyEventResult.ignored;
                              }
                              if (_streaming || !_hasText) {
                                return KeyEventResult.ignored;
                              }
                              _send();
                              return KeyEventResult.handled;
                            }
                          : null,
                      child: TextField(
                        controller: _inputCtrl,
                        minLines: 1,
                        maxLines: 5,
                        onChanged: (v) {
                          final has = v.trim().isNotEmpty;
                          if (has != _hasText) setState(() => _hasText = has);
                        },
                        onSubmitted: (_) => _send(),
                        textInputAction: TextInputAction.newline,
                        style: const TextStyle(fontSize: 15, height: 1.4),
                        decoration: const InputDecoration(
                          hintText: '给 MindBase 发消息…',
                          border: InputBorder.none,
                          isDense: true,
                          // 文字与玻璃容器左右边缘留出距离（多行与光标不贴边）
                          contentPadding: EdgeInsets.fromLTRB(10, 12, 10, 12),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 180),
                    switchInCurve: Curves.easeOutBack,
                    transitionBuilder: (child, anim) =>
                        ScaleTransition(scale: anim, child: child),
                    child: _streaming
                        ? _ChatCircleButton(
                            key: const ValueKey('stop'),
                            tooltip: '停止生成',
                            backgroundColor:
                                Theme.of(context).colorScheme.onSurface,
                            foregroundColor:
                                Theme.of(context).colorScheme.surface,
                            icon: Icons.stop,
                            onTap: _stop,
                          )
                        : _ChatCircleButton(
                            key: const ValueKey('send'),
                            tooltip: '发送',
                            gradient: _hasText,
                            icon: Icons.arrow_upward,
                            onTap: _hasText ? () => _send() : null,
                          ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 图片地址补全：统一走 AppConfig.resolveAssetUrl（相对 /minio-proxy/...）。
  String _resolveImageUrl(String url) =>
      ref.read(appConfigProvider).resolveAssetUrl(url);

  /// 消息图片条：历史为预签名 MinIO URL（可能为相对路径），本地新附为 data URL。
  Widget _buildImageStrip(List<String> images) {
    if (images.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final url in images) _ChatImage(url: _resolveImageUrl(url)),
        ],
      ),
    );
  }
}

/// 输入栏圆形动作钮：启用时为 Gemini 渐变，禁用为浅表面灰。
class _ChatCircleButton extends StatelessWidget {
  const _ChatCircleButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onTap,
    this.backgroundColor,
    this.foregroundColor,
    this.gradient = false,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onTap;
  final Color? backgroundColor;
  final Color? foregroundColor;
  final bool gradient;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = onTap != null;
    final fg = foregroundColor ??
        (enabled ? Colors.white : scheme.onSurface.withValues(alpha: 0.38));
    final Widget child = Container(
      width: 38,
      height: 38,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: gradient && enabled ? GeminiGradients.linear : null,
      ),
      child: Icon(icon, size: 20, color: fg),
    );
    return Tooltip(
      message: tooltip,
      child: Material(
        color: gradient && enabled
            ? Colors.transparent
            : (backgroundColor ??
                scheme.surfaceContainerHighest.withValues(alpha: 0.7)),
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: child,
        ),
      ),
    );
  }
}

/// ChatGPT 式「正在思考」三点呼吸动画。
class _ThinkingDots extends StatefulWidget {
  const _ThinkingDots();

  @override
  State<_ThinkingDots> createState() => _ThinkingDotsState();
}

class _ThinkingDotsState extends State<_ThinkingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < 3; i++)
          FadeTransition(
            opacity: Tween<double>(begin: 0.15, end: 1).animate(
              CurvedAnimation(
                parent: _c,
                curve: Interval(i * 0.25, i * 0.25 + 0.5,
                    curve: Curves.easeInOut),
              ),
            ),
            child: Container(
              width: 7,
              height: 7,
              margin: const EdgeInsets.only(right: 5),
              decoration: BoxDecoration(
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.75),
                shape: BoxShape.circle,
              ),
            ),
          ),
        const SizedBox(width: 4),
        Text(
          '正在思考…',
          style: TextStyle(fontSize: 12.5, color: Theme.of(context).hintColor),
        ),
      ],
    );
  }
}

/// 流式输出末尾的闪烁光标。
class _BlinkingCursor extends StatefulWidget {
  const _BlinkingCursor();

  @override
  State<_BlinkingCursor> createState() => _BlinkingCursorState();
}

class _BlinkingCursorState extends State<_BlinkingCursor>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.1, end: 1).animate(_c),
      child: Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text(
          '▍',
          style: TextStyle(
            fontSize: 15,
            height: 1.2,
            color: Theme.of(context).colorScheme.onSurface,
          ),
        ),
      ),
    );
  }
}

/// 滚动到最新消息的毛玻璃悬浮小钮（上滑查看历史时出现）。
class _ScrollDownButton extends StatelessWidget {
  const _ScrollDownButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GlassContainer(
      blur: 14,
      borderRadius: BorderRadius.circular(19),
      tint: Theme.of(context).brightness == Brightness.dark
          ? Colors.white.withValues(alpha: 0.12)
          : Colors.white.withValues(alpha: 0.75),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 38,
          height: 38,
          child: Icon(Icons.arrow_downward,
              size: 17, color: Theme.of(context).colorScheme.onSurface),
        ),
      ),
    );
  }
}

/// 小图标操作钮（复制 / 重新生成）。
class _IconAction extends StatelessWidget {
  const _IconAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: Icon(
            icon,
            size: 15,
            color: onTap == null
                ? Theme.of(context).disabledColor
                : Theme.of(context).hintColor,
          ),
        ),
      ),
    );
  }
}

/// 会话图片：data URL 走内存解码，http(s) 走网络（历史消息为预签名 URL，
/// 7 天有效期，过期后重新拉取历史即续期）。
/// 加载失败 → 可点击重试（瞬时网络问题）。
class _ChatImage extends StatefulWidget {
  const _ChatImage({required this.url, this.size = 96});

  final String url;
  final double size;

  @override
  State<_ChatImage> createState() => _ChatImageState();
}

class _ChatImageState extends State<_ChatImage> {
  int _attempt = 0;

  @override
  Widget build(BuildContext context) {
    final url = widget.url;
    final ImageProvider provider;
    if (url.startsWith('data:')) {
      provider = Image.memory(base64Decode(url.split(',').skip(1).join())).image;
    } else {
      provider = NetworkImage(url);
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        child: Image(
          key: ValueKey('img-$_attempt'),
          image: provider,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => GestureDetector(
            onTap: () => setState(() => _attempt++),
            child: Container(
              color: Colors.grey.shade300,
              alignment: Alignment.center,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.broken_image, size: 16, color: Colors.grey),
                  const SizedBox(height: 2),
                  Text(
                    '点击重试',
                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 来源面板。
class _SourceSheet extends StatelessWidget {
  const _SourceSheet({required this.sources});

  final List<ChatSource> sources;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView.separated(
        shrinkWrap: true,
        padding: const EdgeInsets.all(16),
        itemCount: sources.length,
        separatorBuilder: (_, __) => const Divider(),
        itemBuilder: (context, i) {
          final s = sources[i];
          return ListTile(
            leading: const Icon(Icons.video_library_outlined),
            title: Text(s.title),
            subtitle: s.bvid != null ? Text(s.bvid!) : null,
          );
        },
      ),
    );
  }
}

/// 附件来源（移动端底部弹层选项）。
enum _AttachSource { camera, gallery, files }
