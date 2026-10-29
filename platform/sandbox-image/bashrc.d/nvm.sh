# sandbox-platform：node 工具链初始化（nvm + node LTS）
#
# 镜像构建时把本文件放到两处，保证任何一种 shell 都能拿到 node 工具链：
#   /etc/profile.d/sandbox-platform-nvm.sh —— 登录 shell（bash -l）
#   /root/.bashrc 末尾追加一行引用        —— 交互式非登录 shell（bash -i、docker exec -it ... bash）
#
# 容器入口脚本执行的是 `exec bash -i`，属于交互式非登录 shell，
# 只会读 ~/.bashrc，所以 nvm 的初始化必须写进 .bashrc，只写 /etc/profile 不生效。
export NVM_DIR="/usr/local/nvm"

if [ -s "${NVM_DIR}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR}/nvm.sh"
fi
