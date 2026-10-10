package com.mindbase.pay.scheduler;

import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayJobLockMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.lang.management.ManagementFactory;
import java.time.Clock;
import java.time.LocalDateTime;
import java.util.UUID;

/**
 * Cross-instance lease for fallback jobs (mutual exclusion across replicas). At any moment only one instance actually
 * runs the job; the others skip, avoiding duplicate outbound order queries/duplicate processing. An expired lease can be
 * taken over automatically (a crashed holder never holds the lock forever).
 *
 * <p>Correctness does not depend on the lease: order state transitions are still decided by conditional updates; the lease only eliminates duplicate work.
 */
@Slf4j
@Component
public class JobLease {

    private final PayJobLockMapper lockMapper;
    private final PayProperties props;
    private final Clock clock;
    private final String owner;

    public JobLease(PayJobLockMapper lockMapper, PayProperties props, Clock clock) {
        this.lockMapper = lockMapper;
        this.props = props;
        this.clock = clock;
        this.owner = ManagementFactory.getRuntimeMXBean().getName() + "-"
                + UUID.randomUUID().toString().substring(0, 8);
    }

    /** Try to acquire/renew the job lease; the current holder may renew its own lease. */
    public boolean tryAcquire(String jobName) {
        LocalDateTime now = LocalDateTime.now(clock);
        LocalDateTime until = now.plusSeconds(Math.max(30, props.job().leaseTtlSeconds()));
        try {
            if (lockMapper.tryTakeOver(jobName, owner, until, now) == 1) {
                return true;
            }
            return lockMapper.tryInsert(jobName, owner, until, now) == 1;
        } catch (Exception e) {
            // A lease-table failure must not stall the fallback job: log and proceed on this instance (correctness is guaranteed by conditional updates)
            log.error("[PAY] job_lease_failed job={} -- proceeding without lease", jobName, e);
            return true;
        }
    }
}
