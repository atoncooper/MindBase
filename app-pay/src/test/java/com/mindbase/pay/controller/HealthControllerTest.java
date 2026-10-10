package com.mindbase.pay.controller;

import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.redirectedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Root-path redirect + /health must truly probe the database (DB unavailable -> 503, so the gateway removes the upstream). */
class HealthControllerTest {

    private static PayProperties props(boolean testEnabled) {
        return TestPayProperties.builder()
                .test(new PayProperties.Test(testEnabled, "", false))
                .build();
    }

    private static DataSource reachable() throws SQLException {
        DataSource ds = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        Statement statement = mock(Statement.class);
        when(ds.getConnection()).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        return ds;
    }

    private static DataSource unreachable() throws SQLException {
        DataSource ds = mock(DataSource.class);
        when(ds.getConnection()).thenThrow(new SQLException("db down"));
        return ds;
    }

    @Test
    void testEnabledRootRedirectsToConsole() throws Exception {
        MockMvc mockMvc = MockMvcBuilders.standaloneSetup(
                new HealthController(props(true), reachable())).build();

        mockMvc.perform(get("/"))
                .andExpect(status().is(HttpStatus.FOUND.value()))
                .andExpect(redirectedUrl("/pay-console.html"));
    }

    @Test
    void productionRootIs404() throws Exception {
        MockMvc mockMvc = MockMvcBuilders.standaloneSetup(
                new HealthController(props(false), reachable())).build();

        mockMvc.perform(get("/"))
                .andExpect(status().isNotFound())
                .andExpect(header().doesNotExist("Location"));
    }

    @Test
    void healthUpWhenDbReachable() throws Exception {
        MockMvc mockMvc = MockMvcBuilders.standaloneSetup(
                new HealthController(props(false), reachable())).build();

        mockMvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void healthDownWhenDbUnreachable() throws Exception {
        MockMvc mockMvc = MockMvcBuilders.standaloneSetup(
                new HealthController(props(false), unreachable())).build();

        mockMvc.perform(get("/health"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.status").value("DOWN"));
    }
}
