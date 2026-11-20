package com.mindbase.pay.e2e.performance;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Unit tests for nearest-rank percentile and merge behavior. */
@DisplayName("LatencyDigest percentile calculations")
class LatencyDigestTest {

    @Test
    @DisplayName("all reported percentiles use nearest-rank on the merged sample set")
    void computesAllPercentiles() {
        LatencyDigest digest = new LatencyDigest();
        for (int ms = 1; ms <= 1000; ms++) {
            digest.add(ms * 1_000_000L);
        }

        assertThat(digest.size()).isEqualTo(1000);
        assertThat(digest.percentileMs(0.0)).isEqualTo(1.0);
        assertThat(digest.percentileMs(0.25)).isEqualTo(250.0);
        assertThat(digest.percentileMs(0.50)).isEqualTo(500.0);
        assertThat(digest.percentileMs(0.75)).isEqualTo(750.0);
        assertThat(digest.percentileMs(0.90)).isEqualTo(900.0);
        assertThat(digest.percentileMs(0.95)).isEqualTo(950.0);
        assertThat(digest.percentileMs(0.99)).isEqualTo(990.0);
        assertThat(digest.percentileMs(0.999)).isEqualTo(999.0);
        assertThat(digest.percentileMs(0.9999)).isEqualTo(1000.0);
        assertThat(digest.maxMs()).isEqualTo(1000.0);
        assertThat(digest.averageMs()).isEqualTo(500.5);
    }

    @Test
    @DisplayName("merging per-worker digests preserves all samples")
    void mergesWorkerDigests() {
        LatencyDigest first = new LatencyDigest();
        first.add(1_000_000L);
        first.add(3_000_000L);
        LatencyDigest second = new LatencyDigest();
        second.add(2_000_000L);
        second.add(4_000_000L);

        LatencyDigest merged = new LatencyDigest();
        merged.addAll(first);
        merged.addAll(second);

        assertThat(merged.size()).isEqualTo(4);
        assertThat(merged.percentileMs(0.50)).isEqualTo(2.0);
        assertThat(merged.maxMs()).isEqualTo(4.0);
    }

    @Test
    @DisplayName("empty digest returns zero instead of throwing")
    void emptyDigestIsSafe() {
        LatencyDigest digest = new LatencyDigest();
        assertThat(digest.size()).isZero();
        assertThat(digest.percentileMs(0.99)).isZero();
        assertThat(digest.averageMs()).isZero();
        assertThat(digest.maxMs()).isZero();
    }
}