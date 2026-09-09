package com.mindbase.pay.common;

import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * 服务时区单一事实来源（plan/1.0.7-Pay：全部按 Asia/Shanghai 墙上时间）。
 *
 * <p>三处必须同源：① 业务取时（注入的 Clock 以此构造）；② 实体字段初始化器
 * （MyBatis-Plus 插入时未显式赋值的 NOT NULL 列靠它们兜底——用系统默认时区会在
 * 非北京时区的机器上产生 8 小时偏差）；③ 对外注册委托的 trigger_time 换算。
 * Docker 里 TZ 已强制 Asia/Shanghai，但代码不依赖该环境保证。
 */
public final class PayTime {

    public static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private PayTime() {
    }

    /** 当前北京墙上时间（实体初始化器与无 Clock 注入场景使用）。 */
    public static LocalDateTime now() {
        return LocalDateTime.now(ZONE);
    }
}
