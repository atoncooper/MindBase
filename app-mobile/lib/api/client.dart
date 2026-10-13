import 'dart:convert';
import 'dart:io' show HttpClient;

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../core/config/app_config.dart';
import '../core/error/api_exception.dart';
import '../core/error/error_mapper.dart';
import '../core/storage/token_store.dart';

/// 唯一网络出口（职责面对齐 frontendv2/lib/api/client.ts）：
/// - Bearer 注入：token 每次从 TokenStore 现读，登录/登出立即生效
/// - 401 统一处理：清本地凭据 + 广播（全 app 唯一处理点，页面不得重复处理）
/// - 错误归一化：业务 detail 透传；非 JSON（APISIX/openresty HTML 错误页）
///   = 网关层故障，按「服务暂时不可用」提示，不得误报成「无权限」
/// - 响应统一 snake→camel（DTO 只消费 camelCase key）
/// - 请求体是 Map 时由 dio 自动以 application/json 发送；FormData 由 dio
///   自带 multipart boundary —— 任何情况下不手工注入 Content-Type
///   （对齐 web 端「空 body 不能带 JSON 头」的 Fastify 规避）
class ApiClient {
  ApiClient({
    required AppConfig config,
    required TokenStore tokens,
    required void Function() onUnauthorized,
    Dio? dio,
  })  : _config = config,
        _tokens = tokens,
        _onUnauthorized = onUnauthorized,
        _dio = dio ?? _defaultDio(config);

  /// 默认 dio：自签证书调试开关在连接层动态读取（改开关立即生效）。
  /// allowSelfSignedDebug 在 release 恒为 false —— 平台红线只在代码里放行 debug。
  static Dio _defaultDio(AppConfig config) {
    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 60),
    ));
    dio.httpClientAdapter = IOHttpClientAdapter(
      createHttpClient: () {
        final client = HttpClient();
        client.badCertificateCallback =
            (_, __, ___) => config.allowSelfSignedDebug;
        return client;
      },
    );
    return dio;
  }

  final AppConfig _config;
  final TokenStore _tokens;
  final void Function() _onUnauthorized;
  final Dio _dio;

  // ------------------------------------------------------------------
  // 通用请求
  // ------------------------------------------------------------------

  /// 通用请求。返回已解析的 JSON（Map/List）或原始 String；204/空体返回 null。
  ///
  /// [camelKeys]：响应 key 是否 snake→camel（默认 true）。
  Future<dynamic> request(
    String method,
    String path, {
    Object? body,
    FormData? form,
    Map<String, dynamic>? query,
    Map<String, String>? headers,
    bool camelKeys = true,
  }) async {
    final response = await _send(
      method,
      path,
      data: form ?? body,
      query: query,
      headers: headers,
    );
    return _decode(response.data, camelKeys: camelKeys);
  }

  /// 带响应头的请求（如 notes 列表的 total 在 X-Total-Count 头里）。
  Future<ApiResponse> requestWithHeaders(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    Map<String, String>? headers,
    bool camelKeys = true,
  }) async {
    final response = await _send(method, path, data: body, query: query, headers: headers);
    final flat = <String, String>{
      for (final e in response.headers.map.entries)
        e.key.toLowerCase(): e.value.isEmpty ? '' : e.value.first,
    };
    return ApiResponse(_decode(response.data, camelKeys: camelKeys), flat);
  }

  /// 二进制响应（如支付收款码 PNG，需要 Bearer）。
  /// 网关偶发 404 抖动 → 默认重试 3 次 / 900ms（对齐 web 端 orderQrBlobUrl）。
  Future<List<int>> requestBytes(
    String path, {
    int retries = 3,
    Duration retryDelay = const Duration(milliseconds: 900),
  }) async {
    for (var attempt = 1;; attempt++) {
      try {
        final response =
            await _send('GET', path, responseType: ResponseType.bytes);
        final data = response.data;
        if (data is List<int>) return data;
        if (data is String && data.isNotEmpty) return utf8.encode(data);
        throw ApiException(null, '响应不是二进制内容');
      } on ApiException catch (e) {
        if (e.isCancelled || attempt >= retries) rethrow;
        await Future<void>.delayed(retryDelay);
      }
    }
  }

  /// POST 一个 SSE 流式端点，返回原始字节流（交给 chat_stream 解析）。
  ///
  /// - 停止生成：cancelToken.cancel() → 抛 [ApiException.isCancelled]
  /// - 401：与普通请求同一处理（清 token + 广播）
  /// - 非 2xx：读错误体解析业务 detail 后抛 [ApiException]
  Future<Stream<List<int>>> streamPost(
    String path, {
    required Object body,
    Map<String, String>? headers,
    CancelToken? cancelToken,
  }) async {
    final url = _requireBase(path);
    final token = await _tokens.readToken();
    final Response<ResponseBody> res;
    try {
      res = await _dio.post<ResponseBody>(
        url,
        data: body,
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          headers: {
            'Accept': 'text/event-stream',
            'X-Requested-With': 'XMLHttpRequest',
            if (token != null) 'Authorization': 'Bearer $token',
            ...?headers,
          },
          // SSE 长连接：读超时放宽（后端有 : ping 心跳，但网关/网络抖动下
          // 空闲间隔可能较长）；取消由 cancelToken 承担
          receiveTimeout: const Duration(minutes: 10),
        ),
      );
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        throw ApiException(ApiException.cancelledStatus, '已取消');
      }
      final status = e.response?.statusCode;
      if (status == 401) {
        await _handleUnauthorized();
      }
      var detail = _detailFromData(e.response?.data);
      if (detail == null && e.response?.data is ResponseBody) {
        try {
          final rb = e.response!.data! as ResponseBody;
          detail = _detailFromJsonText(await utf8.decodeStream(rb.stream));
        } on Exception {
          detail = null;
        }
      }
      if (detail == null && status != null && (status == 403 || status >= 500)) {
        throw ApiException(status, '流式接口不可用（服务暂时不可用，请稍后重试）');
      }
      throw ApiException(
        status,
        friendlyMessage(status: status, detail: detail ?? '流式接口不可用'),
      );
    }
    return res.data!.stream.cast<List<int>>();
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  Future<Response<dynamic>> _send(
    String method,
    String path, {
    Object? data,
    Map<String, dynamic>? query,
    Map<String, String>? headers,
    ResponseType? responseType,
  }) async {
    final url = _requireBase(path);
    final token = await _tokens.readToken();
    try {
      return await _dio.request<dynamic>(
        url,
        data: data,
        queryParameters: query,
        options: Options(
          method: method,
          responseType: responseType,
          headers: {
            // 全量携带（对齐 web 端）：nginx/dev-proxy 用它区分 XHR 与页面路由，
            // 公开分享端点强制要求；native 侧无副作用
            'X-Requested-With': 'XMLHttpRequest',
            if (token != null) 'Authorization': 'Bearer $token',
            ...?headers,
          },
        ),
      );
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        throw ApiException(ApiException.cancelledStatus, '已取消');
      }
      if (e.response?.statusCode == 401) {
        await _handleUnauthorized();
      }
      throw _normalize(e);
    }
  }

  /// 401 唯一处理点：仅当本地确有 token 时清凭据并广播（对齐 web 端行为：
  /// 无 token 的 401 是服务器地址错误之类，不走登出）。
  Future<void> _handleUnauthorized() async {
    final hadToken = await _tokens.readToken() != null;
    if (hadToken) {
      await _tokens.clearAll();
      _onUnauthorized();
      throw ApiException(401, '登录已过期，请重新登录');
    }
  }

  String _requireBase(String path) {
    try {
      return _config.url(path);
    } on StateError catch (_) {
      throw ApiException(null, '尚未配置服务器地址，请先在设置中填写');
    }
  }

  ApiException _normalize(DioException e) {
    if (e.type == DioExceptionType.connectionError ||
        e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.sendTimeout) {
      return ApiException(null, '无法连接服务器，请检查网络或服务器地址');
    }
    final status = e.response?.statusCode;
    final data = e.response?.data;
    final detail = _detailFromData(data);
    final bodyIsHtml = data is String && data.trimLeft().startsWith('<');
    if (bodyIsHtml && (status == 403 || (status != null && status >= 500))) {
      // 网关层 HTML 错误页（APISIX/openresty）：不是业务拒绝
      return ApiException(status, '服务暂时不可用，请稍后重试');
    }
    return ApiException(status, friendlyMessage(status: status, detail: detail));
  }

  dynamic _decode(dynamic data, {required bool camelKeys}) {
    if (data == null) return null;
    if (data is String) return data.isEmpty ? null : data;
    return camelKeys ? snakeToCamel(data) : data;
  }

  String? _detailFromData(dynamic data) {
    if (data is String) {
      if (data.trimLeft().startsWith('<')) return null;
      return _detailFromJsonText(data);
    }
    if (data is Map) {
      final d = data['detail'];
      return d is String ? d : null;
    }
    return null;
  }

  String? _detailFromJsonText(String text) {
    try {
      final parsed = jsonDecode(text);
      if (parsed is Map) {
        final d = parsed['detail'];
        return d is String ? d : null;
      }
    } on FormatException {
      return null;
    }
    return null;
  }
}

// ----------------------------------------------------------------------
// 响应转换
// ----------------------------------------------------------------------

/// 递归 snake_case → camelCase（对齐 web 端 requestCamel）。
final RegExp _snakeRe = RegExp('_([a-z])');

dynamic snakeToCamel(dynamic value) {
  if (value is List) {
    return [for (final e in value) snakeToCamel(e)];
  }
  if (value is Map) {
    return {
      for (final e in value.entries)
        e.key
            .toString()
            .replaceAllMapped(_snakeRe, (m) => m[1]!.toUpperCase()): snakeToCamel(e.value),
    };
  }
  return value;
}

/// 带响应头的响应（header key 已小写扁平化）。
class ApiResponse {
  ApiResponse(this.data, this.headers);

  final dynamic data;
  final Map<String, String> headers;

  int? intHeader(String key) {
    final v = headers[key];
    if (v == null) return null;
    return int.tryParse(v);
  }
}

/// 断言响应是 JSON object，否则视为协议错误。
Map<String, dynamic> asMap(dynamic v) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) {
    return {for (final e in v.entries) e.key.toString(): e.value};
  }
  throw ApiException(null, '响应格式错误（预期 JSON object）');
}

List<Map<String, dynamic>> asMapList(dynamic v) {
  if (v is! List) return const [];
  return [for (final e in v) asMap(e)];
}
