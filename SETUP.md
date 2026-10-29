# 启用完整功能（网站版）

网站版的录入数据、传照片、照片识别、问 Claude 靠 Supabase（数据库 + 文件 + 登录）和一个 Edge Function（替网站调用 Claude）。
没做完下面的步骤时，网站是"离线预览"：知识页面、换算器、盈利模型照常能用，其余功能不可用。

## 最简方式：链接密钥（不用登录）

给网站地址加上 `?k=你的密钥` 打开一次，浏览器会记住密钥并把它从地址栏抹掉；以后直接打开网站地址就行，这个浏览器就有编辑权限。没有密钥的人只能看知识页和计算器，读不到、也写不了任何数据。

- 密钥不在仓库里，数据库里只存它的 SHA-256 哈希（`public.access_keys`）。
- 新增或撤销密钥的 SQL 写在 `supabase/schema.sql` 末尾。密钥一旦泄露，删掉对应行再换一个新的。
- 带密钥的链接等于一把钥匙：谁拿到谁就能改你的数据、用你的 Claude 额度，别发到群里。
- 这种模式下实时推送收不到，页面每 10 秒自动刷新一次，别人的修改最多 10 秒后可见。
- 下面的“登录”方式仍然可用，两种可以并存。

## 权限设计（登录方式）

| 身份 | 能做什么 |
| --- | --- |
| 未登录的任何人 | 只能看知识页面和计算器；**读不到任何录入数据** |
| 受邀成员（viewer） | 登录后可看全部数据、问 Claude；不能改 |
| 受邀编辑（editor） | 可录入、修改、删除、上传照片和文件 |

只有被你邀请的邮箱能登录（公开注册要关掉）。照片和文件放在私有存储里，用 1 小时有效的签名链接打开。

## 步骤

1. **新建 Supabase 项目**：<https://supabase.com> 注册（免费档即可）→ New project。记下 Project URL 和 `anon` / publishable 密钥（Project Settings → API）。这两个值是公开的，可以写进 `config.js`。**不要**把 `service_role` 密钥发给任何人。
2. **建表和权限**：控制台 → SQL Editor → 粘贴 `supabase/schema.sql` 全文 → Run；再粘贴 `supabase/seed.sql` → Run（导入备份里的两条初始记录）。
3. **登录设置**：Authentication → Sign In / Providers → 关闭 "Allow new users to sign up"。Authentication → URL Configuration：Site URL 和 Redirect URLs 都填 `https://ericccczhuuu.github.io/png-alluvial-gold/`。
4. **邀请成员**：Authentication → Users → Add user → Create new user，填邮箱，勾选 Auto Confirm User（密码随便填，不会用到）。然后在 SQL Editor 授权：
   ```sql
   insert into public.members (user_id, role)
   select id, 'editor' from auth.users where email in ('你的邮箱@example.com');
   -- 只读成员把 'editor' 换成 'viewer'
   ```
5. **部署 Claude 代理**：Edge Functions → Deploy a new function → 名字填 `claude` → 把 `supabase/functions/claude/index.ts` 全文粘进去 → Deploy。再到 Edge Functions → Secrets 新增 `ANTHROPIC_API_KEY`（你自己的 Anthropic 密钥，只放在这里）。可选再加 `CLAUDE_MODEL` 改模型，默认 `claude-sonnet-5-5`。
6. **填 `config.js`**：把 Project URL 和 anon 密钥填进去，提交并推送。网站 1–2 分钟后更新，右上角会出现"登录"。

## 登录方式

输入受邀邮箱 → 收到登录链接 → **在发起登录的同一个浏览器里**点开。换浏览器点会登录失败，重新发一次即可。
Supabase 自带的邮件服务每小时只能发很少几封；成员多或常登录，就在 Authentication → SMTP Settings 接入自己的邮件服务（如 Resend）。

## 费用与限制

- 问 Claude 和照片识别按你的 Anthropic 账号计费，只有登录成员能触发。
- Supabase 免费档：500 MB 数据库、1 GB 文件、项目 7 天无访问会被暂停。
- 单个文件 ≤ 20 MB；照片识别每次最多 4 张，会在浏览器里先压缩到长边 1600 像素。

## 文件

| 文件 | 作用 |
| --- | --- |
| `config.js` | Supabase 地址和公开密钥 |
| `supabase-shim.js` | 在网页里提供 `window.claude`（数据、文件、登录、Claude），让 `index.html` 不用改业务代码 |
| `supabase/schema.sql` | 建表、行级安全、存储桶 |
| `supabase/seed.sql` | 初始记录 |
| `supabase/functions/claude/index.ts` | Claude 代理 |
