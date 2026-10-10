#!/usr/bin/env bash
set -Eeuo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fail() { echo "安装失败：$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || fail "请在 Linux 上以 root 运行：sudo bash install.sh"
[[ -d /run/systemd/system ]] || fail "需要正在运行的 systemd"
case $(uname -m) in x86_64|aarch64) ;; *) fail "仅支持 x86_64 和 aarch64" ;; esac
for tool in install cp flock useradd tar readlink; do command -v "$tool" >/dev/null || fail "缺少 $tool"; done
exec 9>/run/codexer-install.lock
flock -n 9 || fail "另一个安装或更新正在进行"
if [[ -x $source_dir/codexer && -f $source_dir/server-bundle.json ]]; then
  binary=$source_dir/codexer
else
  command -v go >/dev/null && command -v node >/dev/null && command -v npm >/dev/null || fail "从源码构建需要 Go >=1.26、Node >=22.13 和 npm；安装发布包无需这些工具"
  (cd "$source_dir" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build:server)
  binary=$source_dir/dist/codexer
fi
version=$("$binary" version) || fail "发布包架构不适合这台服务器"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "无效的发布版本"
app_root=/opt/codexer
release_root=$app_root/releases
config_dir=/etc/codexer
config_file=$config_dir/relay.env
data_root=/var/lib/codexer
data_dir=$data_root/relay
unit_file=/etc/systemd/system/codexer-relay.service
command_file=/usr/local/bin/codexer
if [[ -f $unit_file ]]; then
  rg_marker=$(head -n 1 "$unit_file")
  [[ $rg_marker == '# Managed by Codexer installer' ]] || fail "已有非安装器管理的同名服务，请先人工核对"
fi
[[ ! -e $app_root/current || -L $app_root/current ]] || fail "current 必须是安装器管理的符号链接"
if [[ -e $command_file && ! -L $command_file ]]; then
  [[ $(head -n 2 "$command_file") == *'# Managed by Codexer installer'* ]] || fail "管理命令已被其他程序占用"
fi
temporary=$(mktemp -d /var/tmp/codexer-install.XXXXXXXX)
chmod 700 "$temporary"
active=0
systemctl is-active --quiet codexer-relay.service && active=1 || true
old_link=$(readlink "$app_root/current" 2>/dev/null || true)
managed_files=("$config_file" "$unit_file" "$command_file" /etc/systemd/system/codexer-updater.service /etc/systemd/system/codexer-updater.timer /usr/local/lib/codexer-updater/codexer)
main_enabled=0
updater_enabled=0
systemctl is-enabled --quiet codexer-relay.service && main_enabled=1 || true
systemctl is-enabled --quiet codexer-updater.timer && updater_enabled=1 || true
updater_active=0
systemctl is-active --quiet codexer-updater.timer && updater_active=1 || true
for item in "${managed_files[@]}"; do [[ ! -e $item && ! -L $item ]] || cp -a "$item" "$temporary/${item//\//_}"; done
migration_active=0
pm2_stopped=0
pm2_id=
pm2_bin=$(command -v pm2 || true)
pm2_owner=root
if [[ -z $pm2_bin && -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then
  pm2_bin=$(sudo -Hiu "$SUDO_USER" bash -lc 'command -v pm2' 2>/dev/null || true)
  [[ -z $pm2_bin ]] || pm2_owner=$SUDO_USER
fi
pm2_run() {
 if [[ $pm2_owner == root ]]; then "$pm2_bin" "$@"; else sudo -Hiu "$pm2_owner" -- "$pm2_bin" "$@"; fi
}
legacy_dir=${CODEXER_LEGACY_DIR:-${old_link:-$source_dir}}
rollback() {
  echo '验收失败，恢复旧程序与配置。' >&2
  systemctl stop codexer-relay.service codexer-updater.timer || true
  systemctl disable codexer-relay.service codexer-updater.timer || true
  if [[ -n $old_link ]]; then ln -sfn "$old_link" "$app_root/current"; else rm -f "$app_root/current"; fi
  for item in "${managed_files[@]}"; do
    rm -f "$item"
    [[ ! -e $temporary/${item//\//_} && ! -L $temporary/${item//\//_} ]] || cp -a "$temporary/${item//\//_}" "$item"
  done
  systemctl daemon-reload || true
  [[ $main_enabled -eq 0 ]] || systemctl enable codexer-relay.service || true
  [[ $updater_enabled -eq 0 ]] || systemctl enable codexer-updater.timer || true
  [[ $active -eq 0 ]] || systemctl start codexer-relay.service || true
  [[ $updater_active -eq 0 ]] || systemctl start codexer-updater.timer || true
  [[ $pm2_stopped -eq 0 ]] || pm2_run restart "$pm2_id" || true
}
cleanup() { [[ $migration_active -eq 0 ]] || rollback; rm -rf -- "$temporary"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -z $old_link && -n $pm2_bin ]]; then
  pm2_run jlist >"$temporary/pm2.json"
  pm2_id=$("$binary" pm2-field "$temporary/pm2.json" pm_id)
  if [[ -z $pm2_id && -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then
    user_pm2=$(sudo -Hiu "$SUDO_USER" bash -lc 'command -v pm2' 2>/dev/null || true)
    if [[ -n $user_pm2 ]]; then
      pm2_bin=$user_pm2
      pm2_owner=$SUDO_USER
      pm2_run jlist >"$temporary/pm2.json"
      pm2_id=$("$binary" pm2-field "$temporary/pm2.json" pm_id)
    fi
  fi
  if [[ -n $pm2_id ]]; then
    discovered=$("$binary" pm2-field "$temporary/pm2.json" pm_cwd)
    [[ -z ${CODEXER_LEGACY_DIR:-} || $discovered == "$CODEXER_LEGACY_DIR" ]] || fail "旧 PM2 目录不匹配"
    legacy_dir=$discovered
    [[ -f $legacy_dir/infra/.env ]] || fail "旧 PM2 安装缺少 infra/.env"
  fi
fi
if [[ $legacy_dir != /* ]]; then legacy_dir=$app_root/$legacy_dir; fi
legacy_env=$legacy_dir/infra/.env
existing_url=
if [[ -f $config_file ]]; then existing_url=$("$binary" env-value "$config_file" RELAY_ALLOWED_ORIGINS); fi
existing_url=${existing_url%%,*}
public_url=${CODEXER_PUBLIC_URL:-}
if [[ -z $public_url ]]; then
  [[ -r /dev/tty ]] || fail "请设置 CODEXER_PUBLIC_URL=http://服务器IP:端口"
  read -r -p "访问地址 [$existing_url]：" public_url </dev/tty
  public_url=${public_url:-$existing_url}
fi
port=$("$binary" origin-port "$public_url") || fail "访问地址应为 HTTP 根地址"
install -d -m 0755 "$release_root"
release="$release_root/$version-install-$(date -u +%Y%m%d%H%M%S)"
install -d -m 0755 "$release"
install -m 0755 "$binary" "$release/codexer"
printf '%s\n' "$version" >"$release/VERSION"
if [[ -f $source_dir/server-bundle.json ]]; then cp "$source_dir/server-bundle.json" "$release/"; else
  case $(uname -m) in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  printf '{"kind":"codexer-server-bundle","runtime":"go","version":"%s","os":"linux","arch":"%s"}\n' "$version" "$arch" >"$release/server-bundle.json"
fi
id codexer >/dev/null 2>&1 || useradd --system --user-group --home-dir "$data_root" --shell /usr/sbin/nologin codexer
install -d -o codexer -g codexer -m 0700 "$data_root" "$data_dir"
install -d -o root -g codexer -m 0750 "$config_dir"
legacy_data=
env_source=$config_file
[[ -f $env_source ]] || env_source=$legacy_env
if [[ -f $env_source ]]; then
  database_url=$("$binary" env-value "$env_source" DATABASE_URL)
  if [[ -z $database_url ]]; then
    legacy_data=$("$binary" env-value "$env_source" RELAY_DATA_DIR)
    legacy_data=${legacy_data:-$legacy_dir/.local/relay}
    [[ $legacy_data == /* ]] || legacy_data=$legacy_dir/$legacy_data
    [[ -d $legacy_data && $legacy_data != / ]] || fail "旧数据目录不存在，拒绝初始化为空数据库"
  fi
fi
migration_active=1
systemctl stop codexer-updater.timer 2>/dev/null || true
[[ $active -eq 0 ]] || systemctl stop codexer-relay.service
if [[ -n $pm2_id ]]; then pm2_run stop "$pm2_id"; pm2_stopped=1; fi
if [[ -n $legacy_data && $legacy_data != "$data_dir" ]]; then
  [[ -z $(ls -A "$data_dir") ]] || fail "新旧数据目录都有内容，拒绝覆盖"
  cp -a "$legacy_data/." "$data_dir/"
fi
if [[ -f $data_dir/PG_VERSION && ! -f $data_dir/relay.sqlite ]]; then
  "$binary" migrate-pglite --legacy-release "$legacy_dir" --data-dir "$data_dir" || fail "旧数据库迁移失败，原数据保留"
fi
"$binary" configure "$config_file" "$legacy_env" "$public_url"
chown -R codexer:codexer "$data_root"
chown root:codexer "$config_file"
chmod 0640 "$config_file"
ln -sfn "$release" "$app_root/current"
"$binary" service-unit >"$unit_file"
rm -f "$command_file"
printf '#!/usr/bin/env bash\n# Managed by Codexer installer\nexport CODEXER_ENV_FILE=/etc/codexer/relay.env\nif [[ $# -eq 0 ]]; then set -- menu; fi\nexec /opt/codexer/current/codexer "$@"\n' >"$command_file"
chmod 0755 "$command_file"
install -d -o root -g root -m 0755 /var/lib/codexer-updater /usr/local/lib/codexer-updater
install -d -o codexer -g codexer -m 0700 /var/lib/codexer-updater/inbox
install -o root -g root -m 0755 "$binary" /usr/local/lib/codexer-updater/codexer
cat >/etc/systemd/system/codexer-updater.service <<'UNIT'
# Managed by Codexer installer
[Unit]
Description=Codexer Go updater
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
Environment=PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/flock -n /run/codexer-install.lock /usr/local/lib/codexer-updater/codexer updater
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
# Git builds are available when build tools and an isolated build account exist.
if [[ ${CODEXER_GIT_UPDATES:-0} == 1 ]]; then
  for tool in go node npm git systemd-run; do command -v "$tool" >/dev/null || fail "Git 更新构建需要 $tool"; done
  id codexer-builder >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin codexer-builder
fi
systemctl daemon-reload
systemctl enable codexer-relay.service
systemctl start codexer-relay.service
"$binary" health "http://127.0.0.1:$port"
CODEXER_ENV_FILE="$config_file" "$binary" verify
"$binary" updater
systemctl enable --now codexer-updater.timer
migration_active=0
if [[ $pm2_stopped -eq 1 ]]; then pm2_run delete "$pm2_id" && pm2_run save; fi
# Old updater JavaScript is no longer used.
rm -rf -- /usr/local/lib/codexer-updater/scripts /usr/local/lib/codexer-updater/packages
rm -f /usr/local/lib/codexer-updater/package.json
echo "Codexer $version 已安装：$public_url"
echo "管理后台：${public_url%/}/admin/；管理菜单：sudo codexer"
echo "运行时只有一个 Go 执行文件，网页与后台已内嵌。请放行 TCP $port。"
