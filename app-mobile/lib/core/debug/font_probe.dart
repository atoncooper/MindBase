import 'dart:convert' as convert;
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

/// 字体解析探针（仅 debug/profile 注册，release 恒为 no-op）。
///
/// 背景：运行时引擎（各平台 DirectWrite / CoreText / FreeType）的字体解析结果
/// 无法从 widget 层直接观察。这里用 [TextPainter] 宽度对比做白盒探测：
/// - `miSansWidth != missingWidth` → 资产 MiSans 被引擎真实解析（否则全回退
///   系统默认字体，即"字体不统一"的来源之一）；
/// - `w400Width != w600Width` → 字重映射到了真实字重文件。**合成加粗（faux
///   bold）不改变 advance 宽度**，MiSans 各字重 Latin advance 有可测差异，
///   因此该差值可以区分真字重与伪粗体（伪粗体是"笔画歪扭/糊"的经典来源）；
/// - `codeWidth` → codeFontFamily 链（Consolas→Menlo→monospace→MiSans）在
///   当前平台的解析宽度，用于代码混排排查。
///
/// 用法：应用运行中经 VM service 调用 `ext.app.fontProbe`：
/// `curl "http://127.0.0.1:<vmPort>/<auth>/ext.app.fontProbe"`
void registerFontProbeExtension() {
  if (kReleaseMode) return;
  developer.registerExtension('ext.app.fontProbe', _handle);
}

double _widthOf(TextStyle style, String text) {
  final tp = TextPainter(
    text: TextSpan(text: text, style: style),
    textDirection: TextDirection.ltr,
  )..layout();
  final w = tp.width;
  tp.dispose();
  return w;
}

const String _probeLatin = 'WidthProbe abcdefghijklmnopqrstuvwxyz 0123456789';
const String _probeCjk = '中文字体宽度测试';

Future<developer.ServiceExtensionResponse> _handle(
    String method, Map<String, String> params) async {
  final result = <String, Object>{
    'miSansWidth': _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20), _probeLatin),
    'missingWidth': _widthOf(const TextStyle(fontFamily: 'DefinitelyMissingFont123', fontSize: 20), _probeLatin),
    'defaultWidth': _widthOf(const TextStyle(fontSize: 20), _probeLatin),
    'w400Width': _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w400), _probeLatin),
    'w500Width': _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w500), _probeLatin),
    'w600Width': _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w600), _probeLatin),
    'w700Width': _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20, fontWeight: FontWeight.w700), _probeLatin),
    'codeWidth': _widthOf(
      const TextStyle(
        fontFamily: 'Consolas',
        fontFamilyFallback: ['Menlo', 'Courier New', 'monospace', 'MiSans'],
        fontSize: 13,
      ),
      _probeLatin,
    ),
    'cjkMiSansWidth': _widthOf(const TextStyle(fontFamily: 'MiSans', fontSize: 20), _probeCjk),
    'cjkDefaultWidth': _widthOf(const TextStyle(fontSize: 20), _probeCjk),
  };
  return developer.ServiceExtensionResponse.result(convert.jsonEncode(result));
}
