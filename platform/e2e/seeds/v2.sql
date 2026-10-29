-- v2.sql —— 种子数据（版本 v2）
--
-- v2 起把全栈示例应用的业务表也纳入种子：
--   - 两条初始记录，列表页一进来就有内容可看；
--   - 记录 id 固定，重复执行幂等；
--   - 同一版本在任意用例库载入后行数与内容指纹相同。

INSERT INTO seed_meta (version) VALUES ('v2') ON CONFLICT (version) DO NOTHING;

INSERT INTO sample_records (id, title, content, owner_id, owner_name) VALUES
    ('11111111-1111-4111-8111-111111111111', '初始记录 · 环境自检', '由种子 v2 写入，用于验证列表页渲染。', 'seed', '种子数据'),
    ('22222222-2222-4222-8222-222222222222', '初始记录 · 附件示例', '这条记录带附件，附件字节存在 MinIO 的 sample-records 桶里。', 'seed', '种子数据')
ON CONFLICT (id) DO NOTHING;
