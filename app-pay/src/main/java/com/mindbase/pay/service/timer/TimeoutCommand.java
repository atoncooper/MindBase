package com.mindbase.pay.service.timer;

/** Execution command for an app-task timeout delegation (raw payload). */
public record TimeoutCommand(String orderNo, int version) {
}
