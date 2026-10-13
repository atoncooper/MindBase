import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:app_mobile/api/client.dart';
import 'package:app_mobile/api/pay.dart';
import 'package:app_mobile/core/config/app_config.dart';
import 'package:app_mobile/core/di.dart';
import 'package:app_mobile/core/storage/token_store.dart';
import 'package:app_mobile/core/theme/app_theme.dart';
import 'package:app_mobile/features/pay/membership_page.dart';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

Future<void> _loadMiSans() async {
  final files = <int, String>{
    400: 'assets/fonts/MiSans-Regular.ttf',
    500: 'assets/fonts/MiSans-Medium.ttf',
    600: 'assets/fonts/MiSans-Demibold.ttf',
    700: 'assets/fonts/MiSans-Bold.ttf',
  };
  final loader = FontLoader('MiSans');
  for (final e in files.entries) {
    loader.addFont(Future.value(await rootBundle.load(e.value)));
  }
  await loader.load();
}

class _FakePayApi extends PayApi {
  _FakePayApi(super.client);
  @override
  Future<PayMembership> getMembership() async => PayMembership(
      tier: 'SVIP', active: true, expireAt: '2026-11-20T00:00:00Z');
  @override
  Future<List<PayProduct>> products() async => [
    PayProduct(code: 'vip_m', title: 'VIP 月卡', durationDays: 30, priceCents: 1800, status: 'ON_SALE'),
    PayProduct(code: 'svip_y', title: 'SVIP 年卡', durationDays: 365, priceCents: 12800, status: 'ON_SALE'),
  ];
  @override
  Future<List<PayChannelInfo>> channels() async => [
    PayChannelInfo(code: 'ALIPAY', enabled: true),
    PayChannelInfo(code: 'MOCK', enabled: true),
  ];
  @override
  @override
  Future<List<PayOrder>> listOrders({int limit = 20}) async => const [];
}

/// 会员中心视觉金样：Google 式扁平 —— 身份卡（正常色文字）+ 选中式套餐卡 +
/// 底部统一 CTA（免费档无 CTA 选中态差异）。若 diff：确认是设计变更
/// （--update-goldens）还是组件主题样式回退（见 font_render_test.dart 守护）。
void main() {
  testWidgets('golden: membership hero + products (SVIP)', (tester) async {
    tester.view.devicePixelRatio = 2.0;
    tester.view.physicalSize = const Size(824, 1400);
    addTearDown(tester.view.reset);
    await tester.runAsync(_loadMiSans);
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final client = ApiClient(
      config: AppConfig(prefs),
      tokens: TokenStore(secure: FlutterSecureStorage(), prefs: prefs),
      onUnauthorized: () {},
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [
        sharedPrefsProvider.overrideWithValue(prefs),
        payApiProvider.overrideWithValue(_FakePayApi(client)),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        home: const MembershipPage(),
      ),
    ));
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/membership_svip.png'));
  });

  testWidgets('golden: membership free tier (brand blue hero)', (tester) async {
    tester.view.devicePixelRatio = 2.0;
    tester.view.physicalSize = const Size(824, 900);
    addTearDown(tester.view.reset);
    await tester.runAsync(_loadMiSans);
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final client = ApiClient(
      config: AppConfig(prefs),
      tokens: TokenStore(secure: FlutterSecureStorage(), prefs: prefs),
      onUnauthorized: () {},
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [
        sharedPrefsProvider.overrideWithValue(prefs),
        payApiProvider.overrideWithValue(_FreePayApi(client)),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        home: const MembershipPage(),
      ),
    ));
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/membership_free.png'));
  });
}

class _FreePayApi extends _FakePayApi {
  _FreePayApi(super.client);
  @override
  Future<PayMembership> getMembership() async =>
      PayMembership(tier: null, active: false);
}