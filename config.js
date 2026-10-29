/* Supabase 连接配置。填好后网站才会启用登录、数据同步、照片上传和 Claude。
   这两个值是"公开"的（浏览器本来就要用），真正的权限由 supabase/schema.sql 里的行级安全策略控制。
   不要把 service_role 密钥或 Anthropic 密钥写在这里。 */
window.PNG_CONFIG = {
  supabaseUrl: "",
  supabaseKey: ""
};
