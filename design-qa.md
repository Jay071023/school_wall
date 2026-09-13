# 设计 QA：顶部控件与每日签到（复核版）

## 对照材料

- 设计参考：`path/to/reference-image.png`
- PC 实际渲染：`artifacts/review-screens/home-controls-restored-desktop-review.png`
- PC 1440 同宽操作态：`artifacts/review-screens/home-checkin-same-width-action-1440.png`
- PC 1280 同宽操作态：`artifacts/review-screens/home-checkin-same-width-action-1280.png`
- PC 签到卡局部：`artifacts/review-screens/checkin-card-element-restored-final.png`
- 移动端实际渲染：`artifacts/review-screens/profile-controls-restored-mobile-final.png`
- 聚焦对照图：`artifacts/review-screens/design-qa-focused-comparison-restored.png`
- 对照环境：Edge；PC CSS 视口 1440×1000；平板 1024×800；手机 320/390/768×844；deviceScaleFactor 1。
- 页面为本地静态预览；截图中的签到状态使用审核用 mock 数据，仅用于视觉和交互状态检查，不代表真实接口成功。

## 本轮还原结果

- 顶部通知、退出：恢复为浅灰线稿图标，图标置于独立圆角方框，文字放在方框外，并用细分隔线分组；桌面显示“通知/退出”，平板收缩为图标控件，移动端按现有导航规则隐藏用户操作组。
- PC 每日签到：恢复为“日历图标 + 每日签到 + 坚持签到，收获成长值”的标题说明区，下面是独立的暖杏色操作行；连续天数靠左，签到按钮靠右；等级/积分详情不再塞进浮动卡。
- 移动端个人中心：签到按钮保留小尺寸暖杏色实底，强制靠积分行最右侧，不再挤在文字后面。

## Findings

- 未发现 P0、P1、P2 问题。
- [P3 / 有意适配] 参考板中的 PC 签到卡是宽版展示卡，现有首页右侧栏需要在真实页面中保持轻量窄栏，因此改为与普通右侧卡相同的 `130px` 盒宽；标题和说明改为竖向堆叠，独立操作行压缩到卡内，右边缘与下面卡片对齐。
- [P3 / 有意适配] 参考板的顶部用户组占用更大的展示区域，现有站点保留首页导航链接和主题入口，因此按 64px 导航栏高度等比例收敛方框和间距。
- 右侧签到卡与今日歌单可见内容的水平间距已复核：1440px 时为 195px，1280px 时为 115px；两种宽度均无覆盖和横向溢出。签到卡与下面普通右侧卡均为 130px 宽、右边缘一致。1200px 及以下隐藏浮动侧栏，避免窄窗口叠加主内容。

## 必查视觉面

- 字体与排版：沿用项目现有字体；顶部标签使用 0.9rem 中等字重；签到标题、说明、连续天数和按钮层级清晰；“签到 / 签到中...”不换行。
- 间距与布局：PC 签到卡操作态实测 1280/1440px 均为 130×144.08 CSS px，下面普通侧卡为 130×125.98 CSS px；签到卡内宽 112px，操作行高 44px，按钮为 42×30px 并靠右；加载态卡高 136.55px；顶部两个控件高度 44px。
- 色彩与 Token：顶部使用浅灰描边和半透明白色图标方框；签到卡使用浅薄荷底色、暖杏色操作行和深色按钮文字；避免大面积强阴影。
- 图片与图标：通知、退出使用现有 SVG 线稿，显式 `fill:none`，实际计算样式为 `fill:none`、浅灰 `stroke`；没有新增位图或占位图资源。
- 文案：顶部为“通知 / 退出”；签到标题为“每日签到”；说明为“坚持签到，收获成长值”；加载态为“签到中...”。

## 响应式与交互

- 桌面 1280/1440px：签到卡固定沿用普通右侧卡的 130px 盒宽，内容通过竖向标题区和紧凑操作行适配；顶部标签可见，签到操作行横向排列，无横向溢出。
- 平板 1024px：顶部标签隐藏，控件 34×34px，图标方框 34×34px，无横向溢出。
- 手机 320/390/768px：用户操作组按既有移动端规则隐藏，无横向溢出；个人中心签到按钮在积分行最右侧。
- 签到点击状态已验证：进入 `disabled=true` 和“签到中...”，模拟失败后恢复 `disabled=false` 和“签到”。首页与个人中心两条入口均通过。
- 顶部按钮保留 `title` / `aria-label`；SVG 设置 `aria-hidden`；`:focus-visible` 提供可见键盘焦点；既有减少动效规则继续生效。

## 实现检查

- `node --check`：`frontend/js/home.js`、`frontend/js/profile.js` 及 public 镜像通过。
- CSS 花括号：2308 / 2308。
- `frontend` 与 `public` 的 CSS、HTML、签到相关 JS 镜像内容一致；5 个页面镜像哈希均一致。
- `git diff --check`：通过；仅有 Git 关于 Windows 换行转换的提示。

final result: passed
