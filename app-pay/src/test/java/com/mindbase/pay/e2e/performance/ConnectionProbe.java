package com.mindbase.pay.e2e.performance;

import com.mindbase.pay.e2e.support.PayTestConfig;
import org.slf4j.Logger;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Locale;

/**
 * Measures fresh TCP connect and TLS handshake latency.
 *
 * <p>HTTP keep-alive reuses connections, so per-request handshake time is not
 * visible in latency samples. This probe opens new connections before the load
 * phase to report baseline connect/TLS cost separately.
 */
public final class ConnectionProbe {

    private ConnectionProbe() {
    }

    public record Report(boolean available, int samples,
                         double connectAvgMs, double connectMaxMs,
                         double tlsAvgMs, double tlsMaxMs,
                         String note) {

        public void log(Logger log) {
            if (!available) {
                log.warn("[perf][connect] unavailable: {}", note);
                return;
            }
            log.info("");
            log.info("CONNECTION PROBE  samples={}", samples);
            log.info("  tcp connect: avg={}ms  max={}ms",
                    format("%.2f", connectAvgMs), format("%.2f", connectMaxMs));
            log.info("  tls handshake: avg={}ms  max={}ms",
                    format("%.2f", tlsAvgMs), format("%.2f", tlsMaxMs));
        }

        private static String format(String pattern, double value) {
            return String.format(Locale.ROOT, pattern, value);
        }
    }

    /** Probe fresh connections; failures are reported, not thrown. */
    public static Report probe(PayTestConfig config, int samples) {
        if (samples <= 0) {
            return new Report(false, 0, 0, 0, 0, 0, "metrics.connection-probe-samples=0");
        }
        URI uri;
        try {
            uri = URI.create(config.baseUrl());
        } catch (Exception e) {
            return new Report(false, 0, 0, 0, 0, 0, "invalid base URL: " + e.getMessage());
        }
        String host = uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort()
                : ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80);
        boolean tls = "https".equalsIgnoreCase(uri.getScheme());
        if (host == null) {
            return new Report(false, 0, 0, 0, 0, 0, "base URL has no host: " + config.baseUrl());
        }

        long connectTotal = 0;
        long connectMax = 0;
        long tlsTotal = 0;
        long tlsMax = 0;
        int ok = 0;
        for (int i = 0; i < samples; i++) {
            try (Socket socket = new Socket()) {
                long connectStart = System.nanoTime();
                socket.connect(new InetSocketAddress(host, port), config.connectTimeoutMs());
                long connectNanos = System.nanoTime() - connectStart;
                connectTotal += connectNanos;
                connectMax = Math.max(connectMax, connectNanos);
                if (tls) {
                    SSLSocketFactory factory = trustAllContext().getSocketFactory();
                    try (SSLSocket sslSocket =
                                 (SSLSocket) factory.createSocket(socket, host, port, true)) {
                        long tlsStart = System.nanoTime();
                        sslSocket.startHandshake();
                        long tlsNanos = System.nanoTime() - tlsStart;
                        tlsTotal += tlsNanos;
                        tlsMax = Math.max(tlsMax, tlsNanos);
                    }
                }
                ok++;
            } catch (Exception e) {
                return new Report(false, ok, 0, 0, 0, 0,
                        "connection probe failed: " + e.getClass().getSimpleName()
                                + ": " + e.getMessage());
            }
        }
        if (ok == 0) {
            return new Report(false, 0, 0, 0, 0, 0, "no successful connection probes");
        }
        return new Report(true, ok,
                connectTotal / (double) ok / 1_000_000.0,
                connectMax / 1_000_000.0,
                tls ? tlsTotal / (double) ok / 1_000_000.0 : 0,
                tls ? tlsMax / 1_000_000.0 : 0,
                "ok");
    }

    private static SSLContext trustAllContext() {
        try {
            TrustManager[] trustAll = new TrustManager[]{
                    new X509TrustManager() {
                        @Override
                        public void checkClientTrusted(X509Certificate[] chain, String authType) {
                        }

                        @Override
                        public void checkServerTrusted(X509Certificate[] chain, String authType) {
                        }

                        @Override
                        public X509Certificate[] getAcceptedIssuers() {
                            return new X509Certificate[0];
                        }
                    }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustAll, new SecureRandom());
            return context;
        } catch (Exception e) {
            throw new IllegalStateException("failed to initialize probe SSLContext", e);
        }
    }
}