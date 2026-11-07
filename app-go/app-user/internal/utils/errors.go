package utils

import "errors"

// ErrEmailFormat / ErrPhoneFormat are the validation errors used by the auth
// flow (kept identical to the Python-era messages).
var (
	ErrEmailFormat = errors.New("邮箱格式不正确")
	ErrPhoneFormat = errors.New("手机号格式不正确")
)

// HTTPError carries an HTTP status through the service layer; the transport
// layer maps it without leaking internals.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

// AsHTTPError unwraps err into *HTTPError when present.
func AsHTTPError(err error) (*HTTPError, bool) {
	var target *HTTPError
	if errors.As(err, &target) {
		return target, true
	}
	return nil, false
}
