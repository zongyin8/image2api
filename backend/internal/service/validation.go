package service

import (
	"errors"
	"net/mail"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	MinUsernameLength = 6
	MaxUsernameLength = 24
	MinPasswordLength = 8
	MaxPasswordLength = 24
)

var (
	usernamePattern = regexp.MustCompile(`^[A-Za-z0-9]{6,24}$`)
	// 登录标识专用:兼容从 ChatGPT2API 迁入的存量用户名(3-24 位、允许下划线)。
	// 注册仍走 usernamePattern 的严格规则,这条只用于登录时的账号校验。
	loginUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9_]{3,24}$`)
	emailCodePattern     = regexp.MustCompile(`^\d{6}$`)
)

func ValidateEmail(email string) (string, error) {
	normalized := strings.TrimSpace(strings.ToLower(email))
	if normalized == "" {
		return "", errors.New("邮箱不能为空")
	}
	if len(normalized) > 254 {
		return "", errors.New("邮箱长度不能超过 254 个字符")
	}
	addr, err := mail.ParseAddress(normalized)
	if err != nil || strings.TrimSpace(strings.ToLower(addr.Address)) != normalized {
		return "", errors.New("邮箱格式不正确")
	}
	local, domain, ok := strings.Cut(normalized, "@")
	if !ok || local == "" || domain == "" || strings.Contains(domain, "..") || !strings.Contains(domain, ".") {
		return "", errors.New("邮箱格式不正确")
	}
	return normalized, nil
}

func ValidateUsername(username string) (string, error) {
	normalized := strings.TrimSpace(username)
	if normalized == "" {
		return "", errors.New("用户名不能为空")
	}
	length := utf8.RuneCountInString(normalized)
	if length < MinUsernameLength || length > MaxUsernameLength {
		return "", errors.New("用户名长度需为 6 到 24 个字符")
	}
	if !usernamePattern.MatchString(normalized) {
		return "", errors.New("用户名只能使用字母和数字")
	}
	return normalized, nil
}

func ValidatePassword(password string) error {
	// 放宽:只要求长度 ≥6(上限保留),不再强制大小写/数字/符号。
	length := utf8.RuneCountInString(password)
	if length < 6 || length > MaxPasswordLength {
		return errors.New("密码长度需为 6 到 24 个字符")
	}
	for _, r := range password {
		if unicode.IsSpace(r) {
			return errors.New("密码不能包含空白字符")
		}
		if !isAllowedPasswordRune(r) {
			return errors.New("密码包含不允许的字符")
		}
	}
	return nil
}

func isAllowedPasswordRune(r rune) bool {
	if unicode.IsLetter(r) || unicode.IsDigit(r) {
		return true
	}
	switch r {
	case '(', ')', '~', '!', '@', '#', '$', '%', '^', '&', '*', '-', '_', '+', '=', '|',
		'{', '}', '[', ']', ':', ';', '\'', '<', '>', ',', '.', '?', '/':
		return true
	default:
		return false
	}
}

func ValidateEmailCode(code string) (string, error) {
	normalized := strings.TrimSpace(code)
	if !emailCodePattern.MatchString(normalized) {
		return "", errors.New("邮箱验证码必须是 6 位纯数字")
	}
	return normalized, nil
}

func ValidateLoginIdentifier(identifier string) (string, error) {
	normalized := strings.TrimSpace(identifier)
	if normalized == "" {
		return "", errors.New("账号不能为空")
	}
	if strings.Contains(normalized, "@") {
		return ValidateEmail(normalized)
	}
	// 登录用宽松规则(兼容存量用户名),而非注册的 ValidateUsername 严格规则。
	if !loginUsernamePattern.MatchString(normalized) {
		return "", errors.New("账号格式不正确")
	}
	return normalized, nil
}

func ValidateAllowedEmailDomains(domains []string) []string {
	out := make([]string, 0, len(domains))
	seen := map[string]struct{}{}
	for _, raw := range domains {
		normalized := strings.TrimSpace(strings.ToLower(strings.TrimPrefix(raw, "@")))
		if normalized == "" || strings.Contains(normalized, " ") {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out
}

func EmailDomainAllowed(email string, domains []string) bool {
	if len(domains) == 0 {
		return true
	}
	_, domain, ok := strings.Cut(strings.ToLower(strings.TrimSpace(email)), "@")
	if !ok {
		return false
	}
	for _, allowed := range ValidateAllowedEmailDomains(domains) {
		if domain == allowed {
			return true
		}
	}
	return false
}
