package service

import "encoding/base64"

func b64Encode(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
