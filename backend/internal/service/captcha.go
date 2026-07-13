package service

import (
	"context"
	"strings"
	"time"

	"github.com/mojocn/base64Captcha"
	"github.com/redis/go-redis/v9"
)

// CaptchaService 图形验证码:数字验证码,答案存 Redis,一次性消费。
// 用于承接 ChatGPT2API 前端的"图形验证码注册"(image2api 原生只有邮箱验证码)。
type CaptchaService struct {
	rdb    *redis.Client
	ttl    time.Duration
	driver base64Captcha.Driver
}

func NewCaptchaService(rdb *redis.Client) *CaptchaService {
	// 高50 宽130 4位数字, maxSkew 0.7, dotCount 80
	driver := base64Captcha.NewDriverDigit(50, 130, 4, 0.7, 80)
	return &CaptchaService{rdb: rdb, ttl: 5 * time.Minute, driver: driver}
}

// Generate 返回 (captchaID, base64图片DataURL, error)。
func (s *CaptchaService) Generate(ctx context.Context) (string, string, error) {
	id, content, answer := s.driver.GenerateIdQuestionAnswer()
	item, err := s.driver.DrawCaptcha(content)
	if err != nil {
		return "", "", err
	}
	if err := s.rdb.Set(ctx, "captcha:"+id, answer, s.ttl).Err(); err != nil {
		return "", "", err
	}
	return id, item.EncodeB64string(), nil
}

// Verify 校验并一次性消费(命中即删,防重放)。
func (s *CaptchaService) Verify(ctx context.Context, id, answer string) bool {
	id = strings.TrimSpace(id)
	answer = strings.TrimSpace(answer)
	if id == "" || answer == "" {
		return false
	}
	key := "captcha:" + id
	stored, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		return false
	}
	s.rdb.Del(ctx, key)
	return strings.EqualFold(stored, answer)
}
