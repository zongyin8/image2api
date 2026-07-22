# 图片点位编辑协议

## 结论

2026-07-22 对 ChatGPT Image 2.0 网页版实际请求进行 HAR 取证后确认：

- 点位不是独立的 `annotations` 或 `coordinates` 请求字段。
- 网页端把每个点转换为相对原图的百分比坐标，并直接拼入提示词。
- 网页端同时把当前成品图作为 transformation 原图引用。

提示词格式如下：

```text
1. (x: 30.6%, y: 28.5%) 这里的头发换成红色

2. (x: 73.8%, y: 30.2%) 修改眼镜

补充整体修改要求
```

HAR 可能包含认证信息，只用于本机取证，不得提交到仓库或部署到服务器。

## 二开实现

image2api 已有图生图链路，所以不需要新增后端接口。前端发送点位编辑时执行以下步骤：

1. 按图片实际显示区域计算 `x/y` 百分比，保留一位小数。
2. 按上述格式生成提示词。
3. 将正在查看的原图作为唯一参考图。
4. 切换到支持图生图的 `gpt-image-2`，单次只生成一张。
5. 继续使用既有余额检查、扣费、失败退款和任务恢复逻辑。

三个用户入口分别位于：

- Vue `/new/`：`frontend/src/components/MediaLightbox.vue` 和 `frontend/src/views/PlaygroundView.vue`
- image2api 经典 `/`：`classic-web/index.html`、`classic-web/assets/app.portal.js`、`classic-web/assets/app.css`
- ChatGPT2API 旧用户前端：`web-user/index.html`、`web-user/assets/app.js`、`web-user/assets/app.css`

注意：后台日志、作品管理等页面也复用 `MediaLightbox`，但只有用户生成页传入 `editable=true`，后台预览不会出现生成入口。
