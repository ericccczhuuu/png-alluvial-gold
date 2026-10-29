-- 把 data-backup-2026-10-29.json 的初始记录导入。可重复运行（已存在的 id 会跳过）。
insert into public.docs (id, collection, data) values
  ($j$seed-lae-visit$j$, 'journal', $j${"date": "2026-10-19", "title": "技术人员赴莱城（Lae）周边考察多个地点", "body": "上周（10 月 19–25 日这一周）技术人员到莱城一带看了几个地方，目前还在寻找合适的开采点。待补：具体去了哪些地点、土地主是谁、有没有淘盘或取样结果。"}$j$::jsonb),
  ($j$seed-lae-sites$j$, 'tasks', $j${"title": "把上周莱城周边考察的每个地点建成矿点记录（位置、土地主、租约状态、照片）", "status": "待办", "stage": "寻找矿点"}$j$::jsonb)
on conflict (id) do nothing;
