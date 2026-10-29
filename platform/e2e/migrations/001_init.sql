-- 001_init.sql —— 端到端测试用最小数据模型
--
-- 迁移进模板库后，每个用例库由模板库克隆而来，因此结构天然一致。

CREATE TABLE IF NOT EXISTS seed_meta (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seed_items (
    id          integer PRIMARY KEY,
    name        text NOT NULL,
    price_cents integer NOT NULL CHECK (price_cents >= 0)
);
