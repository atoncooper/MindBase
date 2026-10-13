/// API barrel — 用户侧代码统一从这里 import（对齐 frontendv2/lib/api/index.ts）。
/// 本文件只 re-export；不要在这里写逻辑。
library;

export 'auth.dart';
export 'chat.dart';
export 'client.dart';
export 'cloud.dart';
export 'favorites.dart';
export 'knowledge.dart';
export 'notes.dart';
export 'pay.dart';
export 'preferences.dart';
export 'quiz.dart';
export 'task_quiz.dart';
export 'user.dart';
