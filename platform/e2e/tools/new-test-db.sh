#!/usr/bin/env bash
# new-test-db.sh —— 每用例独立数据库工具
#
# 用法：
#   new-test-db.sh create <库名>    以模板库克隆出一个用例库
#   new-test-db.sh drop <库名>       销毁一个用例库
#   new-test-db.sh bench [次数]      连续克隆计时（默认 10 次），单库耗时上限 5 秒
#   new-test-db.sh list              列出用例库与模板库
#
# 环境变量：
#   E2E_PG_CONTAINER  postgres 容器名（默认 postgres）
#   E2E_PG_USER       postgres 用户名（默认 postgres）
#   E2E_TEMPLATE_DB   模板库名（默认 e2e_template）
#
# psql 一律经 docker exec 到 postgres 容器内执行（沙箱镜像内没有 psql 客户端）。
set -euo pipefail

PG_CONTAINER="${E2E_PG_CONTAINER:-postgres}"
PG_USER="${E2E_PG_USER:-postgres}"
TEMPLATE_DB="${E2E_TEMPLATE_DB:-e2e_template}"
ADMIN_DB="postgres"

# 单库克隆耗时上限（毫秒），与完成标准一致。
MAX_SINGLE_MS=5000

log() { echo "[db] $*"; }

# psql_run <数据库> <SQL>
psql_run() {
  docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$1" -c "$2"
}

# 以模板库克隆出一个库
create_db() {
  local db="$1"
  psql_run "$ADMIN_DB" "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" >/dev/null 2>&1
  psql_run "$ADMIN_DB" "CREATE DATABASE \"$db\" TEMPLATE \"$TEMPLATE_DB\";" >/dev/null
}

# 销毁一个库（连带断开残留连接）
drop_db() {
  local db="$1"
  psql_run "$ADMIN_DB" "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" >/dev/null
}

# 连续克隆计时
bench_db() {
  local count="${1:-10}"
  local i db start end ms
  local total=0 max=0 min=999999999
  local -a created=()

  for ((i = 1; i <= count; i += 1)); do
    db="e2e_bench_$(date +%s)_$i"
    start=$(date +%s%N)
    create_db "$db"
    end=$(date +%s%N)
    ms=$(( (end - start) / 1000000 ))
    created+=("$db")
    total=$((total + ms))
    if ((ms > max)); then max=$ms; fi
    if ((ms < min)); then min=$ms; fi
    log "第 ${i} 次克隆 ${db} 耗时 ${ms} 毫秒"
  done

  for db in "${created[@]}"; do
    drop_db "$db"
  done

  local avg=$((total / count))
  echo
  echo "克隆耗时汇总（连续 ${count} 个用例库，模板库 ${TEMPLATE_DB}）"
  echo "  单库最短 ${min} 毫秒"
  echo "  单库最长 ${max} 毫秒"
  echo "  单库平均 ${avg} 毫秒"
  echo "  合计 ${total} 毫秒"
  if ((max > MAX_SINGLE_MS)); then
    echo "判定：不通过 —— 单库耗时上限 ${MAX_SINGLE_MS} 毫秒，实测最长 ${max} 毫秒"
    return 1
  fi
  echo "判定：通过 —— 单库耗时均不超过 ${MAX_SINGLE_MS} 毫秒"
}

usage() {
  echo "用法：" >&2
  echo "  new-test-db.sh create <库名>" >&2
  echo "  new-test-db.sh drop <库名>" >&2
  echo "  new-test-db.sh bench [次数]" >&2
  echo "  new-test-db.sh list" >&2
}

action="${1:-}"
case "$action" in
  create)
    [ -n "${2:-}" ] || { usage; exit 2; }
    create_db "$2"
    log "已克隆用例库 $2（模板库 ${TEMPLATE_DB}）"
    ;;
  drop)
    [ -n "${2:-}" ] || { usage; exit 2; }
    drop_db "$2"
    log "已销毁用例库 $2"
    ;;
  bench)
    bench_db "${2:-10}"
    ;;
  list)
    psql_run "$ADMIN_DB" "SELECT datname FROM pg_database WHERE datname LIKE 'e2e%' ORDER BY datname;"
    ;;
  *)
    usage
    exit 2
    ;;
esac
