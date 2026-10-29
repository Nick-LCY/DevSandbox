-- 003_sample_records.sql —— 全栈示例应用的业务表
--
-- 这张表是真实业务表（不是演示空表）：
--   - 应用通过 POST /api/records 写入；
--   - 端到端用例按 worker 独占一个数据库克隆自模板库，因此结构天然一致；
--   - 附件本身存在 MinIO（S3 协议），这里只记对象键与元信息。
--
-- 结构来源：platform/examples/fullstack-sample/backend/migrations/001_sample_records.sql
-- （示例项目自带一份，便于脱离端到端门禁单独运行；两处内容保持一致）。

CREATE TABLE IF NOT EXISTS sample_records (
    id           uuid PRIMARY KEY,
    title        text NOT NULL,
    content      text NOT NULL DEFAULT '',
    owner_id     text NOT NULL,
    owner_name   text NOT NULL DEFAULT '',
    object_key   text,
    object_name  text,
    object_size  bigint,
    content_type text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sample_records_created_at_idx ON sample_records (created_at DESC);
CREATE INDEX IF NOT EXISTS sample_records_owner_id_idx ON sample_records (owner_id);
