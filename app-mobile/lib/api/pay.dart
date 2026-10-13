import 'client.dart';

/// Pay API — 会员 / 订单 / 支付（Java 后端原生 camelCase，转换后恒等）。
/// 契约对齐 frontendv2/lib/api/pay.ts。金额一律 long 分，仅在展示层格式化为元。
///
/// 渠道由 GET /pay/channels 决定，UI 不硬编码 MOCK；
/// ALIPAY 当面付：展示收款码 PNG + 轮询 getOrder 直至 DELIVERED。

class PayProduct {
  PayProduct({
    required this.code,
    required this.title,
    required this.durationDays,
    required this.priceCents,
    required this.status,
  });

  final String code;
  final String title;
  final int durationDays;
  final int priceCents;
  final String status;

  factory PayProduct.fromMap(Map<String, dynamic> m) => PayProduct(
        code: m['code'] as String? ?? '',
        title: m['title'] as String? ?? '',
        durationDays: (m['durationDays'] as num?)?.toInt() ?? 0,
        priceCents: (m['priceCents'] as num?)?.toInt() ?? 0,
        status: m['status'] as String? ?? '',
      );
}

class PayChannelInfo {
  PayChannelInfo({required this.code, required this.enabled});

  /// MOCK | WECHAT_PAY | ALIPAY
  final String code;
  final bool enabled;

  factory PayChannelInfo.fromMap(Map<String, dynamic> m) => PayChannelInfo(
        code: m['code'] as String? ?? '',
        enabled: m['enabled'] as bool? ?? false,
      );
}

class PayOrder {
  PayOrder({
    required this.orderNo,
    required this.productTitle,
    required this.durationDays,
    required this.amountCents,
    required this.channel,
    required this.status,
    this.paidAt,
    this.expiresAt,
    required this.createdAt,
  });

  final String orderNo;
  final String productTitle;
  final int durationDays;
  final int amountCents;
  final String channel;
  final String status; // CREATED|PAID|DELIVERED|CLOSED|REFUNDING|REFUNDED
  final String? paidAt;
  final String? expiresAt;
  final String createdAt;

  bool get isCreated => status == 'CREATED';
  bool get isDelivered => status == 'DELIVERED';
  bool get isClosed => status == 'CLOSED';

  factory PayOrder.fromMap(Map<String, dynamic> m) => PayOrder(
        orderNo: m['orderNo'] as String? ?? '',
        productTitle: m['productTitle'] as String? ?? '',
        durationDays: (m['durationDays'] as num?)?.toInt() ?? 0,
        amountCents: (m['amountCents'] as num?)?.toInt() ?? 0,
        channel: m['channel'] as String? ?? '',
        status: m['status'] as String? ?? 'CREATED',
        paidAt: m['paidAt'] as String?,
        expiresAt: m['expiresAt'] as String?,
        createdAt: m['createdAt'] as String? ?? '',
      );
}

class PayMembership {
  PayMembership({
    required this.tier,
    required this.active,
    this.expireAt,
    this.autoRenew = false,
  });

  /// VIP | SVIP | null（null 或 active:false = free）
  final String? tier;
  final bool active;
  final String? expireAt;
  final bool autoRenew;

  bool get isFree => !active || tier == null;

  factory PayMembership.fromMap(Map<String, dynamic> m) => PayMembership(
        tier: m['tier'] as String?,
        active: m['active'] as bool? ?? false,
        expireAt: m['expireAt'] as String?,
        autoRenew: m['autoRenew'] as bool? ?? false,
      );
}

class PayApi {
  PayApi(this._client);

  final ApiClient _client;

  Future<List<PayProduct>> products() async {
    final list = await _client.request('GET', '/pay/products');
    return [
      for (final e in (list as List? ?? const [])) PayProduct.fromMap(asMap(e)),
    ];
  }

  /// 当前启用渠道（前端不硬编码 MOCK）。
  Future<List<PayChannelInfo>> channels() async {
    final list = await _client.request('GET', '/pay/channels');
    return [
      for (final e in (list as List? ?? const []))
        PayChannelInfo.fromMap(asMap(e)),
    ];
  }

  Future<List<PayOrder>> listOrders({int limit = 20}) async {
    final list = await _client.request('GET', '/pay/orders',
        query: {'limit': limit > 50 ? 50 : limit});
    return [
      for (final e in (list as List? ?? const [])) PayOrder.fromMap(asMap(e)),
    ];
  }

  Future<PayOrder> createOrder({
    required String skuCode,
    required String channel,
    required String idempotencyKey,
  }) async =>
      PayOrder.fromMap(asMap(await _client.request(
        'POST',
        '/pay/orders',
        body: {
          'skuCode': skuCode,
          'channel': channel,
          'idempotencyKey': idempotencyKey,
        },
      )));

  Future<PayOrder> getOrder(String orderNo) async =>
      PayOrder.fromMap(asMap(
        await _client.request('GET', '/pay/orders/$orderNo'),
      ));

  Future<PayOrder> cancelOrder(String orderNo) async =>
      PayOrder.fromMap(asMap(await _client.request(
        'POST',
        '/pay/orders/$orderNo/cancel',
      )));

  /// 待支付订单收款码 PNG（二进制，需 Bearer；client 内置 3 次重试）。
  Future<List<int>> orderQrPng(String orderNo) =>
      _client.requestBytes('/pay/orders/$orderNo/qr');

  Future<PayMembership> getMembership() async =>
      PayMembership.fromMap(asMap(
        await _client.request('GET', '/pay/membership'),
      ));

  /// M1/测试形态专用；生产 pay.mock.enabled=false 时服务端拒绝。
  Future<PayOrder> mockConfirm(String orderNo) async =>
      PayOrder.fromMap(asMap(await _client.request(
        'POST',
        '/pay/mock/confirm',
        body: {'orderNo': orderNo},
      )));
}
