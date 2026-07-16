package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// CaptchaService 算术验证码:后端出题(如 "3 + 5 = ?"),答案存 Redis,一次性消费。
// 承接 ChatGPT2API 前端熟悉的「算术题」体验(纯文本,无图、无字体依赖)。
type CaptchaService struct {
	rdb *redis.Client
	ttl time.Duration
}

func NewCaptchaService(rdb *redis.Client) *CaptchaService {
	return &CaptchaService{rdb: rdb, ttl: 5 * time.Minute}
}

func randInt(n int) int {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(v.Int64())
}

func randomCaptchaID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b)
}

// Generate 返回 (captchaID, 算术题文本, error)。答案存 Redis,一次性消费。
func (s *CaptchaService) Generate(ctx context.Context) (string, string, error) {
	var question string
	var answer int
	switch randInt(3) {
	case 0: // 加法
		a, b := randInt(20)+1, randInt(20)+1
		question, answer = fmt.Sprintf("%d + %d = ?", a, b), a+b
	case 1: // 减法(保证非负)
		a, b := randInt(20)+1, randInt(20)+1
		if a < b {
			a, b = b, a
		}
		question, answer = fmt.Sprintf("%d - %d = ?", a, b), a-b
	default: // 乘法(小数)
		a, b := randInt(9)+1, randInt(9)+1
		question, answer = fmt.Sprintf("%d × %d = ?", a, b), a*b
	}
	id := randomCaptchaID()
	if err := s.rdb.Set(ctx, "captcha:"+id, strconv.Itoa(answer), s.ttl).Err(); err != nil {
		return "", "", err
	}
	return id, question, nil
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
	return stored == answer
}
