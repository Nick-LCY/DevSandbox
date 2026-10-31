"""启动模板接口测试：模板库落盘、四条接口行为、内置种子与删除墓碑。

模板库只落文件，不碰宿主与容器：这里全部在临时平台数据根里跑。
分层契约（服务层不直接碰宿主）由 ``test_source_contract.py`` 统一检测，
本文件不再重复。
"""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import PlatformConfig
from sandbox_platform.server import create_app
from sandbox_platform.server.templates import (
    BUILTIN_DIRNAME,
    BUILTIN_STATE_FILENAME,
    TEMPLATES_DIRNAME,
    TemplateRecord,
    TemplateStore,
    ensure_builtin_templates,
    new_template_id,
    prepare_templates_dir,
)

# 内置模板种子（测试里替身常量用）
BUILTIN_FIXTURE = {
    "id": "tpl_builtin_demo",
    "name": "内置演示模板",
    "config": {"image": "busybox:1.37"},
}

# 内置种子常量的模块内路径（monkeypatch 用）
BUILTIN_TARGET = "sandbox_platform.server.templates.BUILTIN_TEMPLATES"


# ---------------------------------------------------------------- 夹具
@pytest.fixture
def templates_client(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    """测试客户端（模板库落在临时平台数据根里）。"""
    # 前端目录指向不存在的路径：静态托管是否挂载的断言才稳定
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    return TestClient(app)


@pytest.fixture
def store(platform_home: Path) -> TemplateStore:
    """模板库实例（平台数据根指向临时目录）。"""
    return TemplateStore(PlatformConfig.from_env())


def templates_dir_of(platform_home: Path) -> Path:
    """模板库目录。"""
    return platform_home / TEMPLATES_DIRNAME


def tombstone_path_of(platform_home: Path) -> Path:
    """内置模板墓碑文件路径。"""
    return templates_dir_of(platform_home) / BUILTIN_DIRNAME / BUILTIN_STATE_FILENAME


def read_stored(platform_home: Path, template_id: str) -> dict:
    """读模板落盘文件的内容。"""
    path = templates_dir_of(platform_home) / f"{template_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- 四条接口
def test_create_template_returns_201_with_full_record(templates_client: TestClient) -> None:
    """创建模板：201，响应含标识、名称、配置体与两个时间戳。"""
    response = templates_client.post(
        "/api/templates",
        json={"name": "演示模板", "config": {"image": "busybox:1.37"}},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["id"].startswith("tpl_")
    assert body["name"] == "演示模板"
    assert body["config"] == {"image": "busybox:1.37"}
    assert body["created_at"]
    assert body["updated_at"]


def test_list_templates_returns_bare_array(templates_client: TestClient) -> None:
    """列表：裸数组（不包对象），每项带完整配置体。"""
    templates_client.post("/api/templates", json={"name": "甲", "config": {"image": "a"}})
    templates_client.post("/api/templates", json={"name": "乙", "config": {"image": "b"}})
    response = templates_client.get("/api/templates")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    assert sorted(item["name"] for item in body) == ["乙", "甲"]
    assert sorted(item["config"]["image"] for item in body) == ["a", "b"]


def test_rename_template_only_changes_name(templates_client: TestClient) -> None:
    """重命名：只改名称，标识与其余字段一律不动。"""
    created = templates_client.post(
        "/api/templates",
        json={"name": "旧名", "config": {"image": "busybox:1.37", "mounts": ["/tmp/x:/data"]}},
    ).json()
    response = templates_client.post(
        f"/api/templates/{created['id']}/rename", json={"name": "新名"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "新名"
    assert body["id"] == created["id"]
    assert body["config"] == created["config"]


def test_rename_missing_template_returns_404(templates_client: TestClient) -> None:
    """重命名不存在的模板：404。"""
    response = templates_client.post("/api/templates/tpl_missing/rename", json={"name": "x"})
    assert response.status_code == 404
    assert "模板不存在" in response.json()["detail"]


def test_rename_rejects_unknown_field(templates_client: TestClient) -> None:
    """重命名的请求体多传字段：400，不静默忽略。"""
    created = templates_client.post("/api/templates", json={"name": "旧名"}).json()
    response = templates_client.post(
        f"/api/templates/{created['id']}/rename", json={"name": "新名", "config": {}}
    )
    assert response.status_code == 400
    assert "不允许的字段" in response.json()["detail"]


def test_delete_template_removes_record(templates_client: TestClient, platform_home: Path) -> None:
    """删除模板：记录文件删掉，列表里也不再出现。"""
    created = templates_client.post("/api/templates", json={"name": "待删"}).json()
    response = templates_client.delete(f"/api/templates/{created['id']}")
    assert response.status_code == 200
    assert response.json() == {"id": created["id"], "deleted": True}
    assert not (templates_dir_of(platform_home) / f"{created['id']}.json").exists()
    assert templates_client.get("/api/templates").json() == []


def test_delete_missing_template_returns_404(templates_client: TestClient) -> None:
    """删除不存在的模板：404。"""
    response = templates_client.delete("/api/templates/tpl_missing")
    assert response.status_code == 404
    assert "模板不存在" in response.json()["detail"]


def test_delete_template_with_illegal_id_returns_404(templates_client: TestClient) -> None:
    """标识非法（路径穿越形态）：按不存在处理，不碰宿主文件系统。"""
    response = templates_client.delete("/api/templates/..%2F..%2Fetc")
    assert response.status_code == 404


# ---------------------------------------------------------------- 名称零限制
@pytest.mark.parametrize(
    "name",
    ["", "   ", "中文模板", "带\n换行", "带\t制表", "a" * 500, "-_./ 混排"],
)
def test_template_name_accepts_any_string(templates_client: TestClient, name: str) -> None:
    """名称零限制：不 strip、不限长、不校验字符集——原样存、原样回。"""
    response = templates_client.post("/api/templates", json={"name": name})
    assert response.status_code == 201
    assert response.json()["name"] == name


# ---------------------------------------------------------------- 配置体口径
def test_template_config_rejects_unknown_field(templates_client: TestClient) -> None:
    """配置体多传字段：400（``extra="forbid"``）。"""
    response = templates_client.post(
        "/api/templates",
        json={"name": "拼错字段", "config": {"images": "busybox:1.37"}},
    )
    assert response.status_code == 400
    assert "不允许的字段" in response.json()["detail"]


def test_template_config_keeps_missing_and_null_distinct(
    templates_client: TestClient, platform_home: Path
) -> None:
    """「字段没出现」与「字段填了空值」不混同：落盘与响应都分得清。"""
    missing = templates_client.post(
        "/api/templates", json={"name": "缺字段", "config": {"image": "busybox:1.37"}}
    ).json()
    nulled = templates_client.post(
        "/api/templates", json={"name": "空值", "config": {"image": None}}
    ).json()
    assert missing["config"] == {"image": "busybox:1.37"}
    assert nulled["config"] == {"image": None}
    stored = read_stored(platform_home, missing["id"])
    assert stored["config"] == {"image": "busybox:1.37"}
    assert "mounts" not in stored["config"]


def test_template_config_absent_stays_empty(
    templates_client: TestClient, platform_home: Path
) -> None:
    """不传配置体：落盘与响应都是空配置体（不是六个字段的默认值全量导出）。"""
    created = templates_client.post("/api/templates", json={"name": "无配置"}).json()
    assert created["config"] == {}
    assert read_stored(platform_home, created["id"])["config"] == {}


def test_template_config_keeps_explicit_empty_list(
    templates_client: TestClient, platform_home: Path
) -> None:
    """显式填了空列表：算「出现过」，落盘保留（与「没填」区分得开）。"""
    created = templates_client.post(
        "/api/templates", json={"name": "空列表", "config": {"mounts": []}}
    ).json()
    assert created["config"] == {"mounts": []}
    assert read_stored(platform_home, created["id"])["config"] == {"mounts": []}


def test_template_keeps_tilde_and_placeholder_verbatim(
    templates_client: TestClient, platform_home: Path
) -> None:
    """模板里的 ``~`` 与 ``{name}`` 原样存取：服务端不改写用户的配置文本。"""
    response = templates_client.post(
        "/api/templates",
        json={
            "name": "带占位符",
            "config": {"mounts": ["~/data:/data"], "env": {"NAME": "{name}"}},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["config"]["mounts"] == ["~/data:/data"]
    assert body["config"]["env"] == {"NAME": "{name}"}
    stored = read_stored(platform_home, body["id"])
    assert stored["config"]["mounts"] == ["~/data:/data"]
    assert stored["config"]["env"] == {"NAME": "{name}"}


# ---------------------------------------------------------------- 内置种子与墓碑
def test_builtin_template_is_injected_on_list(
    templates_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """内置种子：列表读取时补一次（新增内置模板不必等重启）。"""
    monkeypatch.setattr(BUILTIN_TARGET, (BUILTIN_FIXTURE,))
    response = templates_client.get("/api/templates")
    assert response.status_code == 200
    items = response.json()
    assert len(items) == 1
    assert items[0]["id"] == "tpl_builtin_demo"
    assert items[0]["name"] == "内置演示模板"
    assert items[0]["config"] == {"image": "busybox:1.37"}


def test_builtin_template_is_injected_on_startup(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """内置种子：服务启动时注入一次。"""
    monkeypatch.setattr(BUILTIN_TARGET, (BUILTIN_FIXTURE,))
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    with TestClient(app) as client:
        items = client.get("/api/templates").json()
    assert [item["id"] for item in items] == ["tpl_builtin_demo"]


def test_ensure_builtin_templates_is_idempotent(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """种子注入幂等：第二次不重复注入，也不覆盖已有文件。"""
    monkeypatch.setattr(BUILTIN_TARGET, (BUILTIN_FIXTURE,))
    config = PlatformConfig.from_env()
    assert ensure_builtin_templates(config) == ["tpl_builtin_demo"]
    assert ensure_builtin_templates(config) == []
    record = TemplateStore(config).load("tpl_builtin_demo")
    assert record is not None
    assert record.name == "内置演示模板"


def test_ensure_builtin_templates_does_not_overwrite_existing(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同标识文件已存在：种子不覆盖（用户改过的内容保留）。"""
    monkeypatch.setattr(BUILTIN_TARGET, (BUILTIN_FIXTURE,))
    config = PlatformConfig.from_env()
    prepare_templates_dir(config)
    store = TemplateStore(config)
    store.save(
        TemplateRecord(
            id="tpl_builtin_demo",
            name="我改过的名字",
            config={"image": "my-own:1"},
            created_at="2026-10-31T00:00:00+00:00",
            updated_at="2026-10-31T00:00:00+00:00",
        )
    )
    assert ensure_builtin_templates(config) == []
    record = store.load("tpl_builtin_demo")
    assert record is not None
    assert record.name == "我改过的名字"
    assert record.config == {"image": "my-own:1"}


def test_delete_builtin_template_writes_tombstone_and_does_not_revive(
    templates_client: TestClient,
    platform_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """删内置模板：写墓碑，后续注入与列表都不复活它。"""
    monkeypatch.setattr(BUILTIN_TARGET, (BUILTIN_FIXTURE,))
    templates_client.get("/api/templates")  # 先触发注入
    response = templates_client.delete("/api/templates/tpl_builtin_demo")
    assert response.status_code == 200
    assert response.json()["deleted"] is True
    tombstone = tombstone_path_of(platform_home)
    assert tombstone.is_file()
    assert json.loads(tombstone.read_text(encoding="utf-8"))["deleted"] == ["tpl_builtin_demo"]
    # 再读列表、再跑一次注入：都不复活
    assert templates_client.get("/api/templates").json() == []
    assert ensure_builtin_templates(PlatformConfig.from_env()) == []
    assert not (templates_dir_of(platform_home) / "tpl_builtin_demo.json").exists()


def test_delete_user_template_does_not_write_tombstone(
    templates_client: TestClient, platform_home: Path
) -> None:
    """删用户模板：不写墓碑（墓碑只记内置模板）。"""
    created = templates_client.post("/api/templates", json={"name": "用户模板"}).json()
    templates_client.delete(f"/api/templates/{created['id']}")
    assert not tombstone_path_of(platform_home).exists()


# ---------------------------------------------------------------- 模板库落盘
def test_store_writes_file_with_0600(store: TemplateStore) -> None:
    """模板记录文件权限 0600（与平台其他元数据一致）。"""
    record = TemplateRecord(
        id=new_template_id(), name="x", config={}, created_at="t", updated_at="t"
    )
    path = store.save(record)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_store_list_all_ignores_builtin_subdirectory(
    store: TemplateStore, platform_home: Path
) -> None:
    """用户模板枚举只扫顶层 ``*.json``：内置状态子目录天然不参与。"""
    prepare_templates_dir(PlatformConfig.from_env())
    builtin_dir = templates_dir_of(platform_home) / BUILTIN_DIRNAME
    builtin_dir.mkdir(parents=True, exist_ok=True)
    (builtin_dir / BUILTIN_STATE_FILENAME).write_text(
        json.dumps({"deleted": []}), encoding="utf-8"
    )
    record = TemplateRecord(
        id=new_template_id(), name="用户模板", config={}, created_at="t", updated_at="t"
    )
    store.save(record)
    assert [item.id for item in store.list_all()] == [record.id]


def test_store_load_returns_none_for_corrupt_file(
    store: TemplateStore, platform_home: Path
) -> None:
    """坏数据不炸：记录文件损坏按不存在处理。"""
    prepare_templates_dir(PlatformConfig.from_env())
    path = templates_dir_of(platform_home) / "tpl_broken.json"
    path.write_text("{ 这不是合法 JSON", encoding="utf-8")
    assert store.load("tpl_broken") is None


def test_store_load_returns_none_for_unknown_id(store: TemplateStore) -> None:
    """不存在的标识：读不到记录。"""
    assert store.load("tpl_missing") is None
    assert store.load("../../etc/passwd") is None


def test_store_delete_returns_false_for_missing_id(store: TemplateStore) -> None:
    """删不存在的记录：如实回报「没删掉」。"""
    assert store.delete("tpl_missing") is False


def test_new_template_id_format() -> None:
    """模板标识：``tpl_`` 前缀 + 12 位十六进制随机串。"""
    template_id = new_template_id()
    assert template_id.startswith("tpl_")
    assert len(template_id) == len("tpl_") + 12
    assert template_id != new_template_id()


# ---------------------------------------------------------------- 启动钩子
def test_lifespan_prepares_templates_dir(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """启动钩子：准备模板库目录。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    with TestClient(app) as client:
        assert client.get("/api/templates").status_code == 200
    assert templates_dir_of(platform_home).is_dir()
