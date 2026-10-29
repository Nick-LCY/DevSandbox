-- 001_sample_records.sql —— 全栈示例应用的业务表
--
-- 这张表是真实业务表（不是演示空表）：
--   - 应用通过 POST /api/records 写入；
--   - 附件本身存在 MinIO（S3 协议），这里只记对象键与元信息。
--
-- 结构来源：本文件是唯一权威版本；端到端基建里有一份同样的内容
-- （platform/e2e/migrations/003_sample_records.sql），两处保持一致。

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
