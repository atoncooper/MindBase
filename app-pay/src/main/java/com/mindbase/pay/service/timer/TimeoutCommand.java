package com.mindbase.pay.service.timer;

/** app-task 超时委托的执行命令（payload 原文）。 */
public record TimeoutCommand(String orderNo, int version) {
}
