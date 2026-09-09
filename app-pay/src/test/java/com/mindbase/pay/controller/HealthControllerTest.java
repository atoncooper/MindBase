package com.mindbase.pay.controller;

import com.mindbase.pay.config.PayProperties;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.redirectedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 根路径：测试/本地形态重定向到控制台；生产形态 404 不暴露入口。 */
class HealthControllerTest {

    @Test
    void testEnabledRootRedirectsToConsole() throws Exception {
        PayProperties props = new PayProperties(null, null, null, null, null, null,
                new PayProperties.Job(8, 10000, 120, 600, 60, 300, 60));
        MockMvc mockMvc = MockMvcBuilders.standaloneSetup(
                        new HealthController(overrideTestEnabled(props, true))).build();

        mockMvc.perform(get("/"))
                .andExpect(status().is(HttpStatus.FOUND.value()))
                .andExpect(redirectedUrl("/pay-console.html"));
    }

    @Test
    void productionRootIs404() throws Exception {
        PayProperties props = new PayProperties(null, null, null, null, null, null,
                new PayProperties.Job(8, 10000, 120, 600, 60, 300, 60));
        MockMvc mockMvc = MockMvcBuilders.standaloneSetup(
                        new HealthController(overrideTestEnabled(props, false))).build();

        mockMvc.perform(get("/"))
                .andExpect(status().isNotFound())
                .andExpect(header().doesNotExist("Location"));
    }

    private PayProperties overrideTestEnabled(PayProperties props, boolean enabled) {
        // record 无可变字段：用反射绕过不优雅，直接重建一份带 test.enabled 的等价配置
        return new PayProperties(props.rdbms(), props.mock(), props.order(), props.alipay(),
                new PayProperties.Test(enabled, props.test() != null ? props.test().token() : ""),
                props.apptask(), props.job());
    }
}
