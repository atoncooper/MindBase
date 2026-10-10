package com.mindbase.pay.testutil;

import com.mindbase.pay.config.PayProperties;

/**
 * Test PayProperties builder: the record has many nested fields, so defaults are centralized to
 * avoid repeating the argument order in every test (adding a field only requires changing this class).
 */
public final class TestPayProperties {

    private TestPayProperties() {
    }

    public static Builder builder() {
        return new Builder();
    }

    public static PayProperties defaults() {
        return builder().build();
    }

    public static final class Builder {
        private PayProperties.Rdbms rdbms = new PayProperties.Rdbms("jdbc:mysql://localhost:3306/app_pay", "u", "p");
        private PayProperties.Mock mock = new PayProperties.Mock(true);
        private PayProperties.Order order = new PayProperties.Order(30, 10);
        private PayProperties.Alipay alipay = new PayProperties.Alipay(false,
                "https://openapi-sandbox.dl.alipaydev.com/gateway.do", "app", "pk", "pbk", "", 2000, 5000);
        private PayProperties.Test test = new PayProperties.Test(true, "token", false);
        private PayProperties.Apptask apptask = new PayProperties.Apptask(
                "http://apptask-test", "secret-key", false, "http://app-pay:8002");
        private PayProperties.Job job = new PayProperties.Job(
                8, 10000, 120, 600, 60, 300, 60, 4, 900, 3600, 24);
        private PayProperties.Internal internal = new PayProperties.Internal("");
        private PayProperties.Refund refund = new PayProperties.Refund(true, 365);

        public Builder rdbms(PayProperties.Rdbms v) { this.rdbms = v; return this; }
        public Builder mock(PayProperties.Mock v) { this.mock = v; return this; }
        public Builder order(PayProperties.Order v) { this.order = v; return this; }
        public Builder alipay(PayProperties.Alipay v) { this.alipay = v; return this; }
        public Builder test(PayProperties.Test v) { this.test = v; return this; }
        public Builder apptask(PayProperties.Apptask v) { this.apptask = v; return this; }
        public Builder job(PayProperties.Job v) { this.job = v; return this; }
        public Builder internal(PayProperties.Internal v) { this.internal = v; return this; }
        public Builder refund(PayProperties.Refund v) { this.refund = v; return this; }

        public PayProperties build() {
            return new PayProperties(rdbms, mock, order, alipay, test, apptask, job, internal, refund);
        }
    }
}
