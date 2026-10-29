-- v1.sql —— 种子数据（版本 v1）
--
-- 载入规则：
--   1. 可重复执行（幂等）：主键固定、冲突即跳过；
--   2. 同一版本在任意用例库载入后结果一致 —— 行数与内容指纹相同；
--   3. 版本号记在 seed_meta 表，随种子一起克隆进用例库。

INSERT INTO seed_meta (version) VALUES ('v1') ON CONFLICT (version) DO NOTHING;

INSERT INTO seed_items (id, name, price_cents) VALUES
    (1, '笔记本',   1999),
    (2, '机械键盘', 4999),
    (3, '显示器',   129900),
    (4, '扩展坞',   2599),
    (5, '耳机',     899)
ON CONFLICT (id) DO NOTHING;
