package com.mindbase.pay.mapper;

import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;

/**
 * Cross-instance lease for fallback jobs. Hand-written SQL lives in
 * resources/mapper/PayJobLockMapper.xml.
 * BaseMapper is not used: there are only two atomic acquire statements and no entity CRUD is needed.
 */
public interface PayJobLockMapper {

    /** Take over an expired lease (row exists and locked_until < now). @return 1=takeover succeeded */
    int tryTakeOver(@Param("name") String name, @Param("owner") String owner,
                    @Param("until") LocalDateTime until, @Param("now") LocalDateTime now);

    /** Create the lease for the first time (when the row does not exist). @return 1=created, 0=already held by someone else */
    int tryInsert(@Param("name") String name, @Param("owner") String owner,
                  @Param("until") LocalDateTime until, @Param("now") LocalDateTime now);
}
