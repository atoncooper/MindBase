package com.mindbase.pay.common;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.client.j2se.MatrixToImageWriter;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.io.ByteArrayOutputStream;

/** QR code PNG rendering (shared by the Alipay face-to-face payment collection code and the test console; the only zxing call site). */
public final class QrCodes {

    public static final int DEFAULT_SIZE = 320;

    private QrCodes() {
    }

    public static byte[] png(String text, int size) {
        try {
            BitMatrix matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            MatrixToImageWriter.writeToStream(matrix, "PNG", out);
            return out.toByteArray();
        } catch (Exception e) {
            throw ApiException.internalServerError("QR_ENCODE_FAILED", "QR code generation failed");
        }
    }
}
