package com.mindbase.pay.e2e.performance;

import java.util.Arrays;

/**
 * 延迟样本集合：记录纳秒延迟并计算分位数。
 *
 * <p>实现为可增长 long 数组，单线程写入、结束后合并；不引入 HdrHistogram 等额外依赖。
 * 每个压测线程各自持有一份（无锁），最终在主线程合并，避免高并发下同步开销污染延迟。
 */
public final class LatencyDigest {

    private long[] values = new long[256];
    private int size;

    /** 记录一次成功请求的耗时（纳秒）。 */
    public void add(long latencyNanos) {
        if (size == values.length) {
            values = Arrays.copyOf(values, values.length * 2);
        }
        values[size++] = latencyNanos;
    }

    /** 合并另一个样本集合（用于汇总各压测线程）。 */
    public void addAll(LatencyDigest other) {
        if (other == null || other.size == 0) {
            return;
        }
        ensureCapacity(size + other.size);
        System.arraycopy(other.values, 0, values, size, other.size);
        size += other.size;
    }

    private void ensureCapacity(int required) {
        if (required > values.length) {
            values = Arrays.copyOf(values, Math.max(required, values.length * 2));
        }
    }

    public int size() {
        return size;
    }

    /** 最近秩（nearest-rank）分位数，单位毫秒；percentile 取值 0~1。 */
    public double percentileMs(double percentile) {
        if (size == 0) {
            return 0;
        }
        long[] sorted = Arrays.copyOf(values, size);
        Arrays.sort(sorted);
        int index = (int) Math.ceil(percentile * size) - 1;
        index = Math.max(0, Math.min(size - 1, index));
        return sorted[index] / 1_000_000.0;
    }

    public double averageMs() {
        if (size == 0) {
            return 0;
        }
        long sum = 0;
        for (int i = 0; i < size; i++) {
            sum += values[i];
        }
        return sum / (double) size / 1_000_000.0;
    }

    public double maxMs() {
        if (size == 0) {
            return 0;
        }
        long max = values[0];
        for (int i = 1; i < size; i++) {
            max = Math.max(max, values[i]);
        }
        return max / 1_000_000.0;
    }
}