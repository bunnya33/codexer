#!/usr/bin/env bash
set -Eeuo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_root=/opt/codexer
release_root=$app_root/releases
config_dir=/etc/codexer
config_file=$config_dir/relay.env
data_root=/var/lib/codexer
data_dir=$data_root/relay
unit_file=/etc/systemd/system/codexer-relay.service
command_file=/usr/local/bin/codexer

fail() { echo "安装失败：$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail "仅支持 Linux"
[[ $EUID -eq 0 ]] || fail "请以 root 运行：sudo bash install.sh"
[[ -d /run/systemd/system ]] && systemctl show --property=Version --value >/dev/null 2>&1 || fail "需要正在运行的 systemd"
case $(uname -m) in x86_64|aarch64) ;; *) fail "仅支持 x86_64 或 aarch64" ;; esac
for tool in tar mktemp cp install readlink flock getent useradd; do
  command -v "$tool" >/dev/null || fail "缺少 $tool"
done
available_kb=$(df -Pk "$source_dir" | awk 'NR==2 {print $4}')
[[ $available_kb =~ ^[0-9]+$ && $available_kb -ge 1048576 ]] || fail "构建位置至少需要 1 GiB 可用空间"

exec 9>/run/codexer-install.lock
flock -n 9 || fail "另一个安装器正在运行"
temporary=$(mktemp -d /var/tmp/codexer-install.XXXXXXXX)
chmod 700 "$temporary"
staging=
migration_active=0
cleanup() {
  if [[ $migration_active -eq 1 ]]; then rollback || true; fi
  [[ -z $staging || ! -d $staging ]] || rm -rf -- "$staging"
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -f $unit_file ]]; then
  grep -Fqx '# Managed by Codexer installer' "$unit_file" || fail "已有非安装器管理的同名 systemd unit：$unit_file；请先核对数据目录并人工迁移"
  grep -Fqx 'WorkingDirectory=/opt/codexer/current' "$unit_file" || fail "现有 systemd unit 指向其他程序目录"
fi
if [[ -L $command_file ]]; then
  # 识别旧安装的命令链接，迁移到当前入口。
  [[ $(readlink -f "$command_file") == */manage-server.sh ]] || fail "$command_file 已被其他命令占用"
elif [[ -e $command_file ]]; then
  [[ -f $command_file ]] && grep -Fq '# Managed by Codexer installer' "$command_file" || fail "$command_file 已被其他命令占用"
fi
[[ ! -e $app_root/current || -L $app_root/current ]] || fail "$app_root/current 不是安装器管理的符号链接"

node_ok() {
  command -v node >/dev/null && command -v npm >/dev/null \
    && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=13) ? 0 : 1)'
}
if ! node_ok; then
  command -v curl >/dev/null || fail "安装 Node.js 24 需要 curl"
  echo "安装 Node.js 24..."
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_24.x -o "$temporary/nodesource.sh"
    bash "$temporary/nodesource.sh"
    apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_24.x -o "$temporary/nodesource.sh"
    bash "$temporary/nodesource.sh"
    dnf install -y nodejs
  else
    fail "未找到 apt-get 或 dnf；请先安装 Node.js >=22.13 和 npm"
  fi
  node_ok || fail "Node.js 安装后版本仍低于 22.13"
fi
node_path=$(readlink -f "$(command -v node)")
[[ $node_path == /* && $node_path != *' '* ]] || fail "Node.js 路径不适用于 systemd：$node_path"
[[ $node_path != /root/* && $node_path != /home/* ]] || fail "Node.js 安装在用户主目录，受 systemd 目录保护限制；请安装系统级 Node.js 24"
if ! command -v git >/dev/null; then
  if command -v apt-get >/dev/null; then apt-get update && apt-get install -y git
  elif command -v dnf >/dev/null; then dnf install -y git
  else fail "Git tag 更新需要 git；请先安装 git"; fi
fi
command -v systemd-run >/dev/null || fail "Git 构建需要 systemd-run"
if ! getent passwd codexer-builder >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin codexer-builder
fi
builder_uid=$(id -u codexer-builder)
builder_gid=$(id -g codexer-builder)
[[ $builder_uid -gt 0 && $builder_gid -gt 0 && $(id -gn codexer-builder) == codexer-builder ]] \
  || fail "codexer-builder 必须是非 root 的独立构建账号及组"
[[ $(id -G codexer-builder) == "$builder_gid" ]] || fail "codexer-builder 不应加入其他系统组"

existing_url=
if [[ -f $config_file ]]; then
  existing_url=$(node -e 'const {parseEnv}=require("node:util"),fs=require("node:fs");const e=parseEnv(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(e.RELAY_ALLOWED_ORIGINS?.split(",")[0]??"")' "$config_file")
fi
public_url=${CODEXER_PUBLIC_URL:-}
if [[ -z $public_url ]]; then
  [[ -r /dev/tty ]] || fail "无交互终端时必须设置 CODEXER_PUBLIC_URL=http://服务器IP:端口"
  if [[ -n $existing_url ]]; then
    read -r -p "访问地址 [$existing_url]：" public_url </dev/tty || fail "无法读取终端输入"
    public_url=${public_url:-$existing_url}
  else
    read -r -p '访问地址（例如 http://服务器IP:8899）：' public_url </dev/tty || fail "无法读取终端输入"
  fi
fi
CODEXER_PUBLIC_URL=$public_url node -e 'const u=new URL(process.env.CODEXER_PUBLIC_URL);if(u.protocol!=="http:"||u.username||u.password||u.search||u.hash||u.pathname!=="/"||["0.0.0.0","192.0.2.10"].includes(u.hostname))process.exit(1);const p=Number(u.port||80);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1)' \
  || fail "访问地址必须是有效的 HTTP 根地址，例如 http://服务器IP:8899"
port=$(CODEXER_PUBLIC_URL=$public_url node -e 'process.stdout.write(String(new URL(process.env.CODEXER_PUBLIC_URL).port||80))')

# Inspect only the root and invoking user's PM2 instances. An unrecognized listener is rejected below.
pm2_user=
pm2_bin=
pm2_home=
for candidate in root "${SUDO_USER:-root}"; do
  [[ -z $pm2_bin || $candidate == root ]] || continue
  if [[ $candidate == root ]]; then
    candidate_bin=$(command -v pm2 || true)
  else
    candidate_bin=$(runuser -l "$candidate" -c 'command -v pm2' 2>/dev/null | tail -n 1 || true)
  fi
  [[ $candidate_bin == /* && -x $candidate_bin ]] || continue
  pm2_user=$candidate
  pm2_bin=$candidate_bin
  pm2_home=$(getent passwd "$candidate" | cut -d: -f6)
  if [[ $candidate == root ]]; then
    "$pm2_bin" jlist >"$temporary/pm2-$candidate.json"
  else
    runuser -u "$candidate" -- env HOME="$pm2_home" PATH="$(dirname "$pm2_bin"):$PATH" "$pm2_bin" jlist >"$temporary/pm2-$candidate.json"
  fi
  if node -e 'const p=require(process.argv[1]);process.exit(p.some(x=>x.name==="codexer-relay")?0:1)' "$temporary/pm2-$candidate.json"; then
    cp "$temporary/pm2-$candidate.json" "$temporary/pm2.json"
    break
  fi
  pm2_bin=
done

legacy_dir=${CODEXER_LEGACY_DIR:-$source_dir}
pm2_id=
pm2_online=0
if [[ -f $temporary/pm2.json ]]; then
  node -e 'const p=require(process.argv[1]).filter(x=>x.name==="codexer-relay");if(p.length!==1)process.exit(1);require("node:fs").writeFileSync(process.argv[2],JSON.stringify(p[0]))' "$temporary/pm2.json" "$temporary/legacy-pm2.json" \
    || fail "检测到多个旧 PM2 Relay，无法安全迁移"
  pm2_id=$(node -e 'process.stdout.write(String(require(process.argv[1]).pm_id))' "$temporary/legacy-pm2.json")
  legacy_dir=$(node -e 'process.stdout.write(require(process.argv[1]).pm2_env?.pm_cwd??"")' "$temporary/legacy-pm2.json")
  pm2_exec=$(node -e 'process.stdout.write(require(process.argv[1]).pm2_env?.pm_exec_path??"")' "$temporary/legacy-pm2.json")
  pm2_status=$(node -e 'process.stdout.write(require(process.argv[1]).pm2_env?.status??"")' "$temporary/legacy-pm2.json")
  [[ -d $legacy_dir && $pm2_exec == "$legacy_dir/dist/apps/relay/src/main.js" ]] || fail "PM2 的工程路径异常；请人工核对后再迁移"
  [[ -z ${CODEXER_LEGACY_DIR:-} || ${CODEXER_LEGACY_DIR:-} == "$legacy_dir" ]] || fail "CODEXER_LEGACY_DIR 与运行中的 PM2 工程目录不一致"
  [[ -f $legacy_dir/infra/.env || -f $config_file ]] || fail "旧 PM2 工程缺少 infra/.env，无法确认令牌和数据库位置"
  [[ $pm2_status != online ]] || pm2_online=1
fi
if [[ -n ${CODEXER_LEGACY_DIR:-} ]]; then
  [[ -f $legacy_dir/infra/.env ]] || fail "CODEXER_LEGACY_DIR 缺少 infra/.env：$legacy_dir"
elif [[ ! -f $legacy_dir/infra/.env && ! -f $config_file ]]; then
  legacy_dir=$source_dir
fi
legacy_env=$legacy_dir/infra/.env

legacy_data=
if [[ ! -f $config_file && -f $legacy_env ]]; then
  legacy_data=$(node -e 'const fs=require("node:fs"),path=require("node:path"),{parseEnv}=require("node:util");const e=parseEnv(fs.readFileSync(process.argv[1],"utf8"));if(e.DATABASE_URL)process.exit(0);process.stdout.write(path.resolve(process.argv[2],e.RELAY_DATA_DIR||".local/relay"))' "$legacy_env" "$legacy_dir")
  [[ -z $legacy_data || -d $legacy_data ]] || fail "旧数据目录不存在：$legacy_data；拒绝迁移为空数据库"
  if [[ -f $temporary/legacy-pm2.json ]]; then
    node -e 'const fs=require("node:fs"),{parseEnv}=require("node:util");const p=require(process.argv[1]).pm2_env,e=parseEnv(fs.readFileSync(process.argv[2],"utf8"));if((p.DATABASE_URL||"")!==(e.DATABASE_URL||"")||(p.RELAY_DATA_DIR||"")!==(e.RELAY_DATA_DIR||"")||(p.RELAY_ADMIN_TOKEN&&e.RELAY_ADMIN_TOKEN&&p.RELAY_ADMIN_TOKEN!==e.RELAY_ADMIN_TOKEN))process.exit(1)' "$temporary/legacy-pm2.json" "$legacy_env" \
      || fail "PM2 数据库设置与旧 infra/.env 不一致，拒绝自动迁移"
  fi
fi
[[ -z $legacy_data || $legacy_data != / ]] || fail "旧数据路径不能是根目录"
if [[ -n $legacy_data && $legacy_data != "$data_dir" && -d $legacy_data && -n $(ls -A "$legacy_data") && -n $(ls -A "$data_dir" 2>/dev/null || true) ]]; then
  fail "新旧数据目录都有内容，拒绝覆盖：$data_dir"
fi

if [[ $pm2_online -eq 0 && ! -f $unit_file ]]; then
  CODEXER_CHECK_PORT=$port node -e 'const n=require("node:net"),s=n.createServer();s.on("error",()=>process.exit(1));s.listen(Number(process.env.CODEXER_CHECK_PORT),"0.0.0.0",()=>s.close())' \
    || fail "端口 $port 已被占用；请停止占用进程或换端口"
fi

if [[ -f $source_dir/server-bundle.json && -f $source_dir/dist/apps/relay/src/main.js && -f $source_dir/apps/admin/dist/index.html && -f $source_dir/apps/web/dist/index.html ]]; then
  echo "使用已构建的 Relay、控制端和管理后台..."
else
  echo "构建 Codexer Relay、控制端与管理后台..."
  (cd "$source_dir" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build:server)
fi
install -d -m 0755 "$release_root"
version=$(node -p 'require(process.argv[1]).version' "$source_dir/package.json")
revision=$(git -C "$source_dir" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)
release="$release_root/${version}-${revision}-$(date -u +%Y%m%d%H%M%S)"
staging=$(mktemp -d "$release_root/.staging.XXXXXXXX")
cp "$source_dir/package.json" "$source_dir/package-lock.json" "$staging/"
install -d "$staging/apps/web" "$staging/apps/mobile" "$staging/apps/admin" "$staging/apps/desktop"
cp "$source_dir/apps/mobile/package.json" "$staging/apps/mobile/"
cp "$source_dir/apps/admin/package.json" "$staging/apps/admin/"
cp "$source_dir/apps/desktop/package.json" "$staging/apps/desktop/"
cp -a "$source_dir/apps/web/dist" "$staging/apps/web/"
cp -a "$source_dir/apps/admin/dist" "$staging/apps/admin/"
cp -a "$source_dir/dist" "$staging/"
(cd "$staging" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev --workspaces=false)
printf '%s\n' "$version ($revision)" >"$staging/VERSION"
chown -R root:root "$staging"
chmod 0755 "$staging"
mv "$staging" "$release"
staging=

if ! id codexer >/dev/null 2>&1; then
  useradd --system --home-dir "$data_root" --shell /usr/sbin/nologin codexer
fi
install -d -o codexer -g codexer -m 0700 "$data_root" "$data_dir"
install -d -o root -g codexer -m 0750 "$config_dir"
[[ ! -f $config_file ]] || cp -a "$config_file" "$temporary/old.env"
[[ ! -f $unit_file ]] || cp -a "$unit_file" "$temporary/old.service"
[[ ! -f $command_file ]] || cp -a "$command_file" "$temporary/old.command"
old_link=$(readlink "$app_root/current" 2>/dev/null || true)
old_active=0
systemctl is-active --quiet codexer-relay.service && old_active=1 || true
old_enabled=0
systemctl is-enabled --quiet codexer-relay.service && old_enabled=1 || true

run_pm2() {
  if [[ $pm2_user == root ]]; then "$pm2_bin" "$@"
  else runuser -u "$pm2_user" -- env HOME="$pm2_home" PATH="$(dirname "$pm2_bin"):$PATH" "$pm2_bin" "$@"; fi
}
pm2_stopped=0
rollback() {
  set +e
  echo "服务验收失败，恢复原程序与配置..." >&2
  systemctl stop codexer-relay.service >/dev/null 2>&1 || true
  if [[ -n $old_link ]]; then ln -sfn "$old_link" "$app_root/current"; else rm -f "$app_root/current"; fi
  if [[ -f $temporary/old.env ]]; then cp -a "$temporary/old.env" "$config_file"; else rm -f "$config_file"; fi
  if [[ -f $temporary/old.service ]]; then cp -a "$temporary/old.service" "$unit_file"; else rm -f "$unit_file"; fi
  rm -f "$command_file"
  if [[ -e $temporary/old.command || -L $temporary/old.command ]]; then cp -a "$temporary/old.command" "$command_file"; fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ $old_enabled -eq 0 ]]; then systemctl disable codexer-relay.service >/dev/null 2>&1 || true; fi
  if [[ $old_active -eq 1 ]]; then systemctl start codexer-relay.service >/dev/null 2>&1 || true; fi
  if [[ $pm2_stopped -eq 1 ]]; then run_pm2 restart "$pm2_id" >/dev/null 2>&1 || true; fi
}

migration_active=1
if [[ $pm2_online -eq 1 ]]; then
  pm2_stopped=1
  run_pm2 stop "$pm2_id" || fail "无法停止旧 PM2 实例"
fi

activate() {
  if [[ -n $legacy_data && $legacy_data != "$data_dir" && -d $legacy_data && -n $(ls -A "$legacy_data") ]]; then
    cp -a "$legacy_data/." "$data_dir/" || return 1
  fi
  chown -R codexer:codexer "$data_root" || return 1
  chmod 0700 "$data_root" "$data_dir" || return 1
  "$node_path" "$release/dist/scripts/install-config.js" "$config_file" "$legacy_env" "$public_url" >"$temporary/result.json" || return 1
  chown root:codexer "$config_file" || return 1
  chmod 0640 "$config_file" || return 1
  ln -sfn "$release" "$app_root/current" || return 1
  "$node_path" "$release/dist/scripts/print-service-unit.js" "$node_path" >"$unit_file" || return 1
  chmod 0644 "$unit_file" || return 1
  rm -f "$command_file" || return 1
  printf '#!/usr/bin/env bash\n# Managed by Codexer installer\nexec %q /opt/codexer/current/dist/scripts/server-menu.js "$@"\n' "$node_path" >"$command_file" || return 1
  chmod 0755 "$command_file" || return 1
  # Privileged updater code and status stay outside Relay-writable directories.
  install -d -o root -g root -m 0755 /var/lib/codexer-updater /usr/local/lib/codexer-updater/scripts /usr/local/lib/codexer-updater/packages/shared/src || return 1
  install -d -o codexer -g codexer -m 0700 /var/lib/codexer-updater/inbox || return 1
  install -o root -g root -m 0644 "$release/dist/scripts/server-updater.js" /usr/local/lib/codexer-updater/scripts/server-updater.mjs || return 1
  install -o root -g root -m 0644 "$release/dist/packages/shared/src/server-update.js" /usr/local/lib/codexer-updater/packages/shared/src/server-update.js || return 1
  printf '{"type":"module"}\n' >/usr/local/lib/codexer-updater/package.json || return 1
  cat >/etc/systemd/system/codexer-updater.service <<UNIT
# Managed by Codexer installer
[Unit]
Description=Codexer release and Git tag updater
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=$(command -v flock) -n /run/codexer-install.lock $node_path /usr/local/lib/codexer-updater/scripts/server-updater.mjs
TimeoutStartSec=3600
UMask=0022
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/codexer /var/lib/codexer-updater /run
UNIT
  cat >/etc/systemd/system/codexer-updater.timer <<'UNIT'
# Managed by Codexer installer
[Unit]
Description=Process Codexer update requests
[Timer]
OnBootSec=30s
OnUnitInactiveSec=30s
AccuracySec=5s
Unit=codexer-updater.service
[Install]
WantedBy=timers.target
UNIT
  chmod 0644 /etc/systemd/system/codexer-updater.service /etc/systemd/system/codexer-updater.timer || return 1
  systemctl daemon-reload || return 1
  systemctl enable codexer-relay.service || return 1
  systemctl restart codexer-relay.service || return 1
  "$node_path" "$release/dist/scripts/install-health.js" "$config_file" || return 1
  # Initialize capability without taking the installer lock again. The timer takes it on subsequent runs.
  "$node_path" /usr/local/lib/codexer-updater/scripts/server-updater.mjs || return 1
  systemctl enable --now codexer-updater.timer || return 1
}
if ! activate; then fail "未通过服务与管理员认证检查；查看 journalctl -u codexer-relay.service -n 100"; fi
migration_active=0

if [[ -n $pm2_id ]]; then
  run_pm2 delete "$pm2_id" && run_pm2 save || echo "旧 PM2 实例已停止，但清理 PM2 记录失败，请人工检查。" >&2
fi
new_account=$(node -e 'const a=require(process.argv[1]).newAccount;process.stdout.write(a?JSON.stringify(a):"")' "$temporary/result.json")
echo "Codexer 已安装：$public_url"
echo "账号管理后台：${public_url%/}/admin；Web 控制端：${public_url%/}/"
echo "管理菜单：sudo codexer；状态：sudo codexer status；日志：sudo codexer logs"
echo "服务器更新：后台左上角版本入口；自动准备默认关闭，重启始终需要单独确认；更新服务日志：journalctl -u codexer-updater.service"
echo "数据目录：$data_dir；配置文件：$config_file"
[[ -z $new_account ]] || echo "首次管理员账号密码（请保存）：$new_account"
echo "请在服务器防火墙和云安全组放行 TCP $port；地址变更后同步修改 PC Agent 的服务器地址。"
