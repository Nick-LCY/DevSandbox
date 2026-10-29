-- 002_indexes.sql —— 索引
--
-- 迁移按文件名顺序执行，这个文件演示「多份迁移」的排序机制。

CREATE INDEX IF NOT EXISTS seed_items_name_idx ON seed_items (name);
