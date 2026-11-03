"""启动模板接口测试：模板库落盘、四条接口行为、内置种子与删除墓碑。

模板库只落文件，不碰宿主与容器：这里全部在临时平台数据根里跑。
分层契约（服务层不直接碰宿主）由 ``test_source_contract.py`` 统一检测，
本文件不再重复。
"""

from __future__ import annotations

import json
import stat
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import ConfigError, PlatformConfig
from sandbox_console import create_app
from sandbox_console import templates as templates_module
from sandbox_console.templates import (
    BUILTIN_DIRNAME,
    BUILTIN_STATE_FILENAME,
    TEMPLATES_DIRNAME,
    TemplateRecord,
    TemplateStore,
    _valid_template_id,
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
BUILTIN_TARGET = "sandbox_console.templates.BUILTIN_TEMPLATES"

# 真实内置模板清单第一条（常量里的内容，不替换常量）：pi agent
PI_TEMPLATE_ID = "tpl_pi_dev"
PI_TEMPLATE_NAME = "pi agent"
# 真实内置模板的文件注入声明（五条，逐字）：ssh 整目录 + pi 的四个凭证/配置文件
PI_TEMPLATE_FILES = [
    "~/.ssh:/root/.ssh",
    "~/.pi/agent/auth.json:/root/.pi/agent/auth.json",
    "~/.pi/agent/models-store.json:/root/.pi/agent/models-store.json",
    "~/.pi/agent/models.json:/root/.pi/agent/models.json",
    "~/.pi/agent/settings.json:/root/.pi/agent/settings.json",
]


# ---------------------------------------------------------------- 夹具
@pytest.fixture
def templates_client(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    """测试客户端（模板库落在临时平台数据根里）。

    **内置种子按空清单隔离**：本文件里的既有用例断言的是「用户模板」的行为
    （列表恰好两条、删完恰好为空），真实内置清单一旦非空，这些断言就会被
    环境里多出来的那条内置模板顶掉。把内置清单常量替成空元组，既有用例的
    断言一字不动；真实清单由 ``builtin_seed_client`` 那组用例单独验。
    """
    # 前端目录指向不存在的路径：静态托管是否挂载的断言才稳定
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    monkeypatch.setattr(BUILTIN_TARGET, ())
    app = create_app()
    return TestClient(app)


@pytest.fixture
def builtin_seed_client(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    """测试客户端（**不替换内置清单常量**：真实内置模板照常注入）。

    数据根仍是临时目录（``platform_home`` 夹具）：注入、墓碑都落在临时目录里，
    不碰真实环境的数据根。
    """
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
    """标识非法（路径穿越形态）：按不存在处理，不碰宿主文件系统。

    注意：这类请求会被框架的路由匹配先短路成 404，压根进不到处理器，
    真正的标识守卫由 ``test_template_id_guard_rejects_path_traversal`` 直接打。
    """
    response = templates_client.delete("/api/templates/..%2F..%2Fetc")
    assert response.status_code == 404


def test_template_id_guard_rejects_path_traversal(store: TemplateStore) -> None:
    """模板标识守卫：路径穿越与隐藏目录名一律拒绝（直接打守卫函数）。

    守卫有两道：``_valid_template_id`` 判真假，``path_for`` 命中就报错。
    """
    assert _valid_template_id("tpl_ok") is True
    for illegal in ("../../etc/passwd", "..", ".builtin", "", "a/b", "tpl/../x"):
        assert _valid_template_id(illegal) is False
        with pytest.raises(ConfigError):
            store.path_for(illegal)


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


def test_template_config_with_files_is_persisted(
    templates_client: TestClient, platform_home: Path
) -> None:
    """含 files 的模板：配置体原样落盘并回显。"""
    response = templates_client.post(
        "/api/templates",
        json={
            "name": "带文件注入",
            "config": {"files": ["/tmp/demo/secret:/run/secret"]},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["config"]["files"] == ["/tmp/demo/secret:/run/secret"]
    stored = read_stored(platform_home, body["id"])
    assert stored["config"]["files"] == ["/tmp/demo/secret:/run/secret"]


def test_template_config_without_files_key_omits_it(
    templates_client: TestClient, platform_home: Path
) -> None:
    """不传 files：落盘 JSON 里没有 files 键（``exclude_unset`` 口径）。"""
    created = templates_client.post(
        "/api/templates",
        json={"name": "无文件注入", "config": {"image": "busybox:1.37"}},
    ).json()
    assert "files" not in created["config"]
    stored = read_stored(platform_home, created["id"])
    assert "files" not in stored["config"]


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


def test_concurrent_builtin_deletes_keep_both_tombstone_keys(
    store: TemplateStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """并发删两个内置模板：墓碑条目不互相覆盖（两个 key 都在）。

    墓碑是「读-改-写」：没有进程内锁时，两个线程各读到旧集合、各写一份，
    后写的会覆盖先写的条目（漏记墓碑 → 被删的内置模板又被复活）。
    """
    original_read = templates_module.TemplateStore.builtin_deleted_keys

    def slow_read(self: TemplateStore) -> set[str]:
        keys = original_read(self)
        time.sleep(0.05)  # 拉长「读-改-写」窗口，逼出丢更新
        return keys

    monkeypatch.setattr(templates_module.TemplateStore, "builtin_deleted_keys", slow_read)

    barrier = threading.Barrier(2)

    def delete_one(template_id: str) -> None:
        barrier.wait()
        store.mark_builtin_deleted(template_id)

    threads = [
        threading.Thread(target=delete_one, args=(template_id,))
        for template_id in ("tpl_builtin_a", "tpl_builtin_b")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert store.builtin_deleted_keys() == {"tpl_builtin_a", "tpl_builtin_b"}


def test_ensure_builtin_templates_survives_read_only_dir(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """模板目录不可写（只读）：种子注入只记日志，不抛异常。"""

    def raise_permission_error(config: PlatformConfig) -> Path:
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(
        templates_module, "prepare_templates_dir", raise_permission_error
    )
    assert ensure_builtin_templates(PlatformConfig.from_env()) == []


def test_list_templates_survives_seed_failure(
    templates_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """种子注入意外失败：列表接口照常返回 200（不因种子失败而 500）。"""

    def raise_runtime_error(config: PlatformConfig) -> list[str]:
        raise RuntimeError("种子注入炸了")

    monkeypatch.setattr(
        "sandbox_console.routes.templates.ensure_builtin_templates",
        raise_runtime_error,
    )
    response = templates_client.get("/api/templates")
    assert response.status_code == 200
    assert response.json() == []


def test_lifespan_survives_seed_failure(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """启动钩子里的种子注入意外失败：服务照常启动（不阻断）。"""

    def raise_runtime_error(config: PlatformConfig) -> list[str]:
        raise RuntimeError("种子注入炸了")

    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    monkeypatch.setattr("sandbox_console.app.ensure_builtin_templates", raise_runtime_error)
    app = create_app()
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200


# ---------------------------------------------------------------- 真实内置模板
def test_builtin_pi_template_constant_declares_files_only() -> None:
    """真实内置清单：pi agent 的配置体**只含 files 一个键**。

    内置种子是原样拷贝配置体字典的：多写的键会被前端当「出现字段」整组替换
    表单（镜像、挂载、命令……），所以这里钉死「只有文件注入声明」。
    """
    items = [
        item
        for item in templates_module.BUILTIN_TEMPLATES
        if item.get("id") == PI_TEMPLATE_ID
    ]
    assert len(items) == 1
    assert items[0]["name"] == PI_TEMPLATE_NAME
    assert items[0]["config"] == {"files": PI_TEMPLATE_FILES}
    assert list(items[0]["config"].keys()) == ["files"]


def test_builtin_pi_template_is_listed(builtin_seed_client: TestClient) -> None:
    """真实内置模板（不替换常量）：列表里看得到它，名称与配置体逐字正确。"""
    response = builtin_seed_client.get("/api/templates")
    assert response.status_code == 200
    items = response.json()
    matched = [item for item in items if item["id"] == PI_TEMPLATE_ID]
    assert len(matched) == 1
    assert matched[0]["name"] == PI_TEMPLATE_NAME
    assert matched[0]["config"] == {"files": PI_TEMPLATE_FILES}
    assert matched[0]["created_at"]
    assert matched[0]["updated_at"]


def test_builtin_pi_template_injection_is_idempotent(
    builtin_seed_client: TestClient,
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """注入幂等：连读两次列表、重建服务再读，都只出现一份。

    落盘也只留一个记录文件（种子注入不覆盖已有文件、不重复写入）。
    """
    first = builtin_seed_client.get("/api/templates").json()
    second = builtin_seed_client.get("/api/templates").json()
    assert [item["id"] for item in first].count(PI_TEMPLATE_ID) == 1
    assert [item["id"] for item in second].count(PI_TEMPLATE_ID) == 1

    # 重建服务（走启动钩子那条注入路径）再读：仍然只有一份。
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    with TestClient(create_app()) as restarted:
        third = restarted.get("/api/templates").json()
    assert [item["id"] for item in third].count(PI_TEMPLATE_ID) == 1

    record = templates_dir_of(platform_home) / f"{PI_TEMPLATE_ID}.json"
    assert record.is_file()
    assert json.loads(record.read_text(encoding="utf-8"))["config"] == {
        "files": PI_TEMPLATE_FILES
    }


def test_delete_builtin_pi_template_writes_tombstone_and_does_not_revive(
    builtin_seed_client: TestClient, platform_home: Path
) -> None:
    """删真实内置模板：写墓碑，后续注入与列表都不复活它。

    墓碑落在临时平台数据根里（``platform_home`` 夹具），不碰真实环境。
    """
    assert builtin_seed_client.get("/api/templates").status_code == 200
    response = builtin_seed_client.delete(f"/api/templates/{PI_TEMPLATE_ID}")
    assert response.status_code == 200
    assert response.json() == {"id": PI_TEMPLATE_ID, "deleted": True}

    tombstone = tombstone_path_of(platform_home)
    assert tombstone.is_file()
    assert json.loads(tombstone.read_text(encoding="utf-8"))["deleted"] == [
        PI_TEMPLATE_ID
    ]

    # 再读列表、再跑一次注入：都不复活。
    # 断言「列表里没有 tpl_pi_dev」而不是「列表恰好为空」：内置清单将来再加条目时本用例不会误红
    listed = builtin_seed_client.get("/api/templates").json()
    assert all(item["id"] != PI_TEMPLATE_ID for item in listed)
    assert ensure_builtin_templates(PlatformConfig.from_env()) == []
    assert not (templates_dir_of(platform_home) / f"{PI_TEMPLATE_ID}.json").exists()


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


def test_store_skips_non_utf8_record_file(store: TemplateStore, platform_home: Path) -> None:
    """记录文件不是 UTF-8：按不存在处理（跳过），不抛解码错误。"""
    prepare_templates_dir(PlatformConfig.from_env())
    path = templates_dir_of(platform_home) / "tpl_binary.json"
    path.write_bytes(b"\xff\xfe\x00 not utf-8")
    assert store.load("tpl_binary") is None
    assert store.list_all() == []


def test_store_load_uses_file_name_as_template_id(store: TemplateStore, platform_home: Path) -> None:
    """记录内容里的 id 与文件名不一致：以文件名为准（标识只认路径）。"""
    prepare_templates_dir(PlatformConfig.from_env())
    path = templates_dir_of(platform_home) / "tpl_real.json"
    path.write_text(
        json.dumps({"id": "tpl_other", "name": "拷来的", "config": {}}, ensure_ascii=False),
        encoding="utf-8",
    )
    record = store.load("tpl_real")
    assert record is not None
    assert record.id == "tpl_real"
    assert record.name == "拷来的"


def test_store_treats_corrupt_tombstone_as_empty_set(
    store: TemplateStore, platform_home: Path
) -> None:
    """墓碑文件损坏：按空集处理，不外抛（坏墓碑不得让接口 500）。"""
    prepare_templates_dir(PlatformConfig.from_env())
    tombstone = tombstone_path_of(platform_home)
    tombstone.parent.mkdir(parents=True, exist_ok=True)
    tombstone.write_text("{ 这不是合法 JSON", encoding="utf-8")
    assert store.builtin_deleted_keys() == set()


def test_store_treats_non_utf8_tombstone_as_empty_set(
    store: TemplateStore, platform_home: Path
) -> None:
    """墓碑文件不是 UTF-8：按空集处理，不抛解码错误。"""
    prepare_templates_dir(PlatformConfig.from_env())
    tombstone = tombstone_path_of(platform_home)
    tombstone.parent.mkdir(parents=True, exist_ok=True)
    tombstone.write_bytes(b"\xff\xfe\x00 not utf-8")
    assert store.builtin_deleted_keys() == set()


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
