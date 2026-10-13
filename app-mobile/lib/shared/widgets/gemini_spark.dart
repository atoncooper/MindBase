import 'package:flutter/material.dart';

/// Gemini 风格四角星标（concave 四芒星）+ 渐变色板。
///
/// 设计参考 Google Gemini：蓝→紫→粉线性渐变（#4285F4 → #9B72CB → #D96570），
/// 用在品牌位（抽屉 logo、问候空态、回答头像、发送按钮）。
class GeminiGradients {
  GeminiGradients._();

  /// Gemini 渐变三色。
  static const List<Color> colors = [
    Color(0xFF4285F4),
    Color(0xFF9B72CB),
    Color(0xFFD96570),
  ];

  /// 默认线性渐变（左上 → 右下）。
  static const LinearGradient linear = LinearGradient(
    colors: colors,
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );
}

/// Gemini 四芒星标。
///
/// [gradient] 缺省为 [GeminiGradients.linear]；需要单色时传
/// `LinearGradient(colors: [c, c])`。
class GeminiSpark extends StatelessWidget {
  const GeminiSpark({
    super.key,
    this.size = 24,
    this.gradient = GeminiGradients.linear,
  });

  final double size;
  final Gradient? gradient;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.square(size),
      painter: _SparkPainter(gradient ?? GeminiGradients.linear),
    );
  }
}

class _SparkPainter extends CustomPainter {
  const _SparkPainter(this.gradient);

  final Gradient gradient;

  @override
  void paint(Canvas canvas, Size size) {
    final r = size.shortestSide / 2;
    final c = Offset(size.width / 2, size.height / 2);
    // 内凹程度：控制点越靠近中心，星臂越尖锐
    const k = 0.18;

    final path = Path()
      ..moveTo(c.dx, c.dy - r)
      ..quadraticBezierTo(c.dx + r * k, c.dy - r * k, c.dx + r, c.dy)
      ..quadraticBezierTo(c.dx + r * k, c.dy + r * k, c.dx, c.dy + r)
      ..quadraticBezierTo(c.dx - r * k, c.dy + r * k, c.dx - r, c.dy)
      ..quadraticBezierTo(c.dx - r * k, c.dy - r * k, c.dx, c.dy - r)
      ..close();

    final paint = Paint()
      ..shader = gradient.createShader(
        Rect.fromLTWH(0, 0, size.width, size.height),
      )
      ..style = PaintingStyle.fill;
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_SparkPainter oldDelegate) =>
      oldDelegate.gradient != gradient;
}
