package com.mindbase.pay.scheduler;

/**
 * 可被 {@link JitteredBackoffTrigger} 驱动的周期任务：执行体 + 本轮是否有工作。
 * hadWork 驱动空跑退避：连续无工作拉长间隔，一旦有工作回到 base。
 */
public interface AdaptiveJob {

    void run();

    /** 刚结束的一轮是否发现了工作（触发退避/重置的依据）。 */
    boolean lastRunHadWork();
}
