import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../api/pay.dart';
import '../../core/di.dart';
import '../../core/theme/app_theme.dart';
import '../../core/error/api_exception.dart';
import '../../shared/utils/defer.dart';
import '../../shared/utils/formatters.dart';
import '../../shared/widgets/glass.dart';
import '../../shared/widgets/status_badge.dart';

/// 会员中心：会员态 + 商品 + 渠道由 /pay/channels 决定（不硬编码 MOCK）+ 订单。
class MembershipPage extends ConsumerStatefulWidget {
  const MembershipPage({super.key});

  @override
  ConsumerState<MembershipPage> createState() => _MembershipPageState();
}

class _MembershipPageState extends ConsumerState<MembershipPage> {
  PayMembership? _membership;
  List<PayProduct> _products = [];
  String? _selectedSku;
  List<PayChannelInfo> _channels = [];
  List<PayOrder> _orders = [];
  bool _loading = true;
  String? _error;

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
      final api = ref.read(payApiProvider);
      final membership = await api.getMembership();
      final products = await api.products();
      final channels = await api.channels();
      final orders = await api.listOrders();
      if (!mounted) return;
      setState(() {
        _membership = membership;
        _products = products;
        _channels = channels;
        _orders = orders;
        if (_selectedSku == null ||
            !products.any((x) => x.code == _selectedSku)) {
          _selectedSku = products.isNotEmpty ? products.first.code : null;
        }
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

  Future<void> _buy(PayProduct product) async {
    // 渠道统一经 /pay/channels 准入；优先 ALIPAY
    final enabled = _channels.where((c) => c.enabled).toList();
    if (enabled.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('当前没有可用的支付渠道')));
      return;
    }
    final channel = enabled.any((c) => c.code == 'ALIPAY')
        ? 'ALIPAY'
        : enabled.first.code;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('确认购买'),
        content: Text(
            '${product.title} · ${product.durationDays} 天 · ¥${formatCents(product.priceCents)}'
            '\n渠道：${channel == 'MOCK' ? '模拟支付' : channel}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('去支付')),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      final order = await ref.read(payApiProvider).createOrder(
            skuCode: product.code,
            channel: channel,
            // 幂等键：每次购买意图一个 uuid（≤64 字符）
            idempotencyKey: const Uuid().v4(),
          );
      if (!mounted) return;
      if (channel == 'MOCK') {
        final ok = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('模拟支付'),
            content: Text('订单 ${order.orderNo}（仅测试环境可用）'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
              FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('模拟支付成功')),
            ],
          ),
        );
        if (ok == true) {
          await ref.read(payApiProvider).mockConfirm(order.orderNo);
          if (mounted) {
            ScaffoldMessenger.of(context)
                .showSnackBar(const SnackBar(content: Text('支付成功')));
          }
        }
        await _load();
        return;
      }
      if (channel == 'ALIPAY') {
        await _showAlipayQr(order);
      }
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// 当面付：展示收款码 PNG + 轮询订单直至 DELIVERED / CLOSED。
  Future<void> _showAlipayQr(PayOrder order) async {
    Uint8List? qrBytes;
    try {
      final bytes = await ref.read(payApiProvider).orderQrPng(order.orderNo);
      qrBytes = Uint8List.fromList(bytes);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('收款码获取失败：${e.message}')));
        return;
      }
    }
    if (!mounted) return;

    var delivered = false;
    var pollStarted = false;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          // 轮询直到 DELIVERED / CLOSED（3s 间隔，最长 ~5 分钟）。
          // builder 可能被多次调用：轮询循环只允许启动一次。
          if (!pollStarted) {
            pollStarted = true;
            Future<void>.microtask(() async {
            for (var i = 0; i < 100; i++) {
              await Future<void>.delayed(const Duration(seconds: 3));
              try {
                final o =
                    await ref.read(payApiProvider).getOrder(order.orderNo);
                if (o.isDelivered) {
                  delivered = true;
                  if (dialogCtx.mounted) Navigator.of(dialogCtx).pop();
                  return;
                }
                if (o.isClosed) {
                  if (dialogCtx.mounted) Navigator.of(dialogCtx).pop();
                  return;
                }
              } on ApiException catch (_) {
                // 单次轮询失败继续
              }
            }
            if (dialogCtx.mounted) Navigator.of(dialogCtx).pop();
            });
          }
          return AlertDialog(
            title: const Text('支付宝扫码支付'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (qrBytes != null)
                  Image.memory(qrBytes, width: 220, height: 220)
                else
                  const SizedBox(
                      width: 200,
                      height: 200,
                      child: Center(child: Text('二维码加载失败'))),
                const SizedBox(height: 12),
                Text('订单 ${order.orderNo}'),
                Text('¥${formatCents(order.amountCents)}'),
                const SizedBox(height: 8),
                const Text('支付完成后自动关闭',
                    style: TextStyle(fontSize: 12.5, color: Colors.grey)),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogCtx).pop(),
                child: const Text('稍后支付'),
              ),
            ],
          );
        },
      ),
    );
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(delivered
              ? '支付成功，会员已开通'
              : '订单未完成，可在订单记录中继续支付')));
    }
  }

  Future<void> _cancelOrder(PayOrder o) async {
    try {
      await ref.read(payApiProvider).cancelOrder(o.orderNo);
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _showOrders() async {
    await showGlassSheet<void>(
      context: context,
      builder: (_) => SafeArea(
        child: _orders.isEmpty
            ? const Padding(
                padding: EdgeInsets.all(24), child: Center(child: Text('暂无订单')))
            : ListView.separated(
                shrinkWrap: true,
                itemCount: _orders.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (context, i) {
                  final o = _orders[i];
                  return ListTile(
                    title: Text(o.productTitle),
                    subtitle: Text(
                      '${o.orderNo}\n${formatDateTimeIso(o.createdAt)} · ¥${formatCents(o.amountCents)}',
                      style: const TextStyle(fontSize: 11),
                    ),
                    isThreeLine: true,
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        StatusBadge(status: o.status),
                        if (o.isCreated)
                          TextButton(
                            onPressed: () {
                              Navigator.pop(context);
                              _cancelOrder(o);
                            },
                            child: const Text('取消'),
                          ),
                      ],
                    ),
                  );
                },
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final selected = _products
        .where((x) => x.code == _selectedSku)
        .cast<PayProduct?>()
        .firstOrNull;
    final hasBody = !_loading && _error == null;
    return Scaffold(
      appBar: AppBar(
        title: const Text('会员中心'),
        actions: [
          TextButton(onPressed: _showOrders, child: const Text('订单')),
        ],
      ),
      // Google 式底部统一 CTA：选中套餐后一把开通，商品卡不做每卡一钮
      bottomNavigationBar: hasBody && selected != null
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: FilledButton(
                  onPressed: () => _buy(selected),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                  ),
                  child: Text('立即开通 · ¥${formatCents(selected.priceCents)}'),
                ),
              ),
            )
          : null,
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
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                  children: [
                    _MembershipIdentityCard(membership: _membership),
                    const SizedBox(height: 20),
                    if (_products.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 32),
                        child: Column(
                          children: [
                            Icon(Icons.inventory_2_outlined,
                                size: 40,
                                color: Theme.of(context)
                                    .hintColor
                                    .withValues(alpha: 0.5)),
                            const SizedBox(height: 10),
                            Text('暂无在售商品',
                                style: TextStyle(
                                    fontSize: 13,
                                    color: Theme.of(context).hintColor)),
                          ],
                        ),
                      )
                    else ...[
                      Padding(
                        padding: const EdgeInsets.only(left: 4, bottom: 8),
                        child: Text('选择套餐',
                            style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: Theme.of(context).hintColor)),
                      ),
                      for (final prod in _products)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: _ProductOptionCard(
                            product: prod,
                            selected: prod.code == _selectedSku,
                            onTap: () =>
                                setState(() => _selectedSku = prod.code),
                          ),
                        ),
                    ],
                    if (_channels
                        .where((c) => c.enabled)
                        .isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Padding(
                        padding: const EdgeInsets.only(left: 4),
                        child: Text(
                          '支付方式：${_channels.where((c) => c.enabled).map((c) => c.code == 'ALIPAY' ? '支付宝' : (c.code == 'MOCK' ? '模拟支付（测试）' : c.code)).join(' · ')}',
                          style: TextStyle(
                              fontSize: 11.5,
                              color: Theme.of(context).hintColor),
                        ),
                      ),
                    ],
                  ],
                ),
    );
  }
}

/// 会员身份卡：Google 式扁平 —— surface 卡 + 正常色文字，无渐变无反白。
class _MembershipIdentityCard extends StatelessWidget {
  const _MembershipIdentityCard({required this.membership});

  final PayMembership? membership;

  @override
  Widget build(BuildContext context) {
    final m = membership;
    final isMember = m != null && !m.isFree;
    final tierLabel = !isMember
        ? '免费版'
        : (m.tier == 'SVIP' ? 'SVIP 会员' : 'VIP 会员');
    final remainDays = isMember
        ? DateTime.tryParse(m.expireAt ?? '')
            ?.difference(DateTime.now())
            .inDays
        : null;
    final subtitle = !isMember
        ? '开通会员解锁更高配额与优先排队'
        : '有效期至 ${formatDateTimeIso(m.expireAt)}'
            '${remainDays != null && remainDays >= 0 ? ' · 剩 $remainDays 天' : ''}';

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: Theme.of(context)
                    .colorScheme
                    .primary
                    .withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                isMember ? Icons.workspace_premium : Icons.auto_awesome_outlined,
                size: 22,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(tierLabel,
                      style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                          height: 1.2)),
                  const SizedBox(height: 3),
                  Text(subtitle,
                      style: TextStyle(
                          fontSize: 12.5, color: Theme.of(context).hintColor)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 套餐选择卡：Material 单选视觉（圆圈）+ 标题/时长 + 右侧价格；点选高亮描边。
class _ProductOptionCard extends StatelessWidget {
  const _ProductOptionCard({
    required this.product,
    required this.selected,
    required this.onTap,
  });

  final PayProduct product;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final durationLabel = product.durationDays >= 365
        ? '年卡 · ${product.durationDays} 天'
        : (product.durationDays >= 30
            ? '${product.durationDays ~/ 30} 个月 · ${product.durationDays} 天'
            : '${product.durationDays} 天');
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: selected
          ? (isDark
              ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.10)
              : AppTheme.surfaceTintLight)
          : Theme.of(context).cardTheme.color,
      borderRadius: BorderRadius.circular(20),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: selected
                  ? Theme.of(context).colorScheme.primary
                  : Theme.of(context).dividerColor,
              width: selected ? 1.4 : 1,
            ),
          ),
          padding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(
            children: [
              Icon(
                selected
                    ? Icons.radio_button_checked
                    : Icons.radio_button_off,
                size: 20,
                color: selected
                    ? Theme.of(context).colorScheme.primary
                    : Theme.of(context).hintColor,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(product.title,
                        style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            height: 1.25)),
                    const SizedBox(height: 3),
                    Text(durationLabel,
                        style: TextStyle(
                            fontSize: 12.5,
                            color: Theme.of(context).hintColor)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Text(
                '¥${formatCents(product.priceCents)}',
                style: const TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
