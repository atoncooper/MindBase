package service

// Extraction-code at-rest encryption.
//
// 存储格式版本：
//   legacy: 64-char hex（SHA-256+pepper 单向哈希——不可查看，只能校验/重设）
//   v1:     "enc:v1:" + base64url(12-byte nonce || AES-256-GCM ciphertext)
//
// 密钥 = 部署级共享密钥文件（与 app-auth 的 user_oauth 字段加密同一来源，
// SECURITY__API_KEY_ENCRYPTION_KEY[_FILE]）。密钥不进数据库 —— DB 泄露
// 仍然不暴露可用提取码（沿用 hashExtractionCode 时代的设计不变量）。
// 未配置密钥时优雅降级为 legacy 哈希（行为与历史版本一致，不可查看）。

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"sync"
)

const encCodePrefix = "enc:v1:"

var (
	codeCipherOnce sync.Once
	codeAEAD       cipher.AEAD
	codeCipherErr  error
)

func extractionAEAD() cipher.AEAD {
	codeCipherOnce.Do(func() {
		keyB64 := strings.TrimSpace(os.Getenv("SECURITY__API_KEY_ENCRYPTION_KEY"))
		if keyB64 == "" {
			if path := strings.TrimSpace(os.Getenv("SECURITY__API_KEY_ENCRYPTION_KEY_FILE")); path != "" {
				if b, rerr := os.ReadFile(path); rerr == nil {
					keyB64 = strings.TrimSpace(string(b))
				}
			}
		}
		if keyB64 == "" {
			codeCipherErr = fmt.Errorf("no extraction-code encryption key configured")
			return
		}
		key, derr := base64.StdEncoding.DecodeString(keyB64)
		if derr != nil || len(key) != 32 {
			codeCipherErr = fmt.Errorf("extraction-code encryption key must be base64 of 32 bytes")
			return
		}
		block, aerr := aes.NewCipher(key)
		if aerr != nil {
			codeCipherErr = aerr
			return
		}
		gcm, gerr := cipher.NewGCM(block)
		if gerr != nil {
			codeCipherErr = gerr
			return
		}
		codeAEAD = gcm
	})
	return codeAEAD
}

// encryptionAvailable — 密钥是否就绪（决定新码存加密体还是 legacy 哈希）。
func encryptionAvailable() bool {
	return extractionAEAD() != nil
}

func encryptCode(plain string) (string, error) {
	aead := extractionAEAD()
	if aead == nil {
		return "", codeCipherErr
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := aead.Seal(nonce, nonce, []byte(plain), nil)
	return encCodePrefix + base64.RawURLEncoding.EncodeToString(ct), nil
}

func decryptCode(stored string) (string, bool) {
	if !strings.HasPrefix(stored, encCodePrefix) {
		return "", false
	}
	aead := extractionAEAD()
	if aead == nil {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(stored, encCodePrefix))
	if err != nil {
		return "", false
	}
	ns := aead.NonceSize()
	if len(raw) < ns {
		return "", false
	}
	plain, err := aead.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", false
	}
	return string(plain), true
}

func isEncryptedCode(stored string) bool {
	return strings.HasPrefix(stored, encCodePrefix)
}
