package service

import "errors"

var (
	errEmailFormat = errors.New("邮箱格式不正确")
	errPhoneFormat = errors.New("手机号格式不正确")
)
