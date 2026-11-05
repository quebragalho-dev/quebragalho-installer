#!/bin/sh
# Instalador do Quebra-galho para macOS, Linux, WSL e FreeBSD (melhor esforço).
#   Remoto: curl -fsSL https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main/install.sh | sh
#   Clone:  sh install.sh
# Variáveis: QUEBRAGALHO_BIN_DIR (onde fica o comando), QUEBRAGALHO_HOME (onde ficam os arquivos),
#            QUEBRAGALHO_NO_PROMPT=1 (sem perguntas), QUEBRAGALHO_RAW_URL (origem dos arquivos).
# Tudo fica dentro de main: se o download do script for cortado, nada executa pela metade.
set -eu
umask 022

MARKER='quebragalho-installer:managed'
RAW_URL=${QUEBRAGALHO_RAW_URL:-https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main}
FILES='quebragalho.mjs lib/catalog.mjs lib/claude-setup.mjs lib/commands.mjs lib/context.mjs lib/device.mjs lib/doctor.mjs lib/exec.mjs lib/format.mjs lib/gateway.mjs lib/harness.mjs lib/launch.mjs lib/login.mjs lib/proc.mjs lib/util.mjs lib/vault.mjs'

die() { printf 'quebragalho: %s\n' "$*" >&2; exit 1; }

# Escapa para aspas simples do sh: abc'def -> 'abc'\''def'
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Baixa $1 para $2 por HTTPS (curl ou wget). file:// só com curl, para testes.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    case $1 in
      https://*) curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1" ;;
      file://*) curl -fsSL -o "$2" "$1" ;;
      *) die 'QUEBRAGALHO_RAW_URL deve usar HTTPS.' ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    case $1 in https://*) ;; *) die 'QUEBRAGALHO_RAW_URL deve usar HTTPS (sem curl, só https com wget).' ;; esac
    wget -q -O "$2" "$1"
  else
    die 'Instale curl ou wget para baixar o Quebra-galho.'
  fi
}

# Nosso: tem o marcador no início ou é o launcher antigo de arquivo único.
is_ours() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  head -n 5 "$1" 2>/dev/null | grep -q -F "$MARKER" && return 0
  [ "$(head -n 1 "$1" 2>/dev/null)" = '#!/usr/bin/env node' ] || return 1
  grep -q -F "const harnesses = ['claude', 'codex', 'opencode', 'aider', 'pi'];" "$1" 2>/dev/null
}

check_node() {
  command -v node >/dev/null 2>&1 || die 'Instale Node.js 22+ primeiro: https://nodejs.org'
  node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || die 'Requer Node.js 22+.'
}

# Onde ler respostas: o terminal mesmo com o script vindo de um pipe (curl | sh).
tty_input() {
  [ -n "${QUEBRAGALHO_NO_PROMPT:-}" ] && return 0
  if [ -t 0 ]; then echo /dev/stdin
  elif (: </dev/tty) 2>/dev/null; then echo /dev/tty
  fi
}

populate() { # $1 = diretório de destino
  src=''
  case $0 in *.sh) is_script=1 ;; *) is_script='' ;; esac
  if [ -n "$is_script" ] && [ -f "$0" ]; then
    here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
    [ -f "$here/quebragalho.mjs" ] && [ -d "$here/lib" ] && src=$here
  fi
  for f in $FILES; do
    mkdir -p "$1/$(dirname "$f")"
    if [ -n "$src" ]; then cp "$src/$f" "$1/$f"; else fetch "$RAW_URL/$f" "$1/$f" || die "Falha ao baixar $f; nada foi instalado."; fi
    [ -s "$1/$f" ] || die "Arquivo vazio: $f; nada foi instalado."
    chmod 644 "$1/$f"
  done
  printf 'managed by %s\n' "$MARKER" > "$1/.managed"
}

stage=''
old=''
wrapper=''
app_dir=''
cleanup() {
  # Troca interrompida entre os dois mv: devolve a instalação anterior antes de limpar.
  if [ -n "$old" ] && [ -n "$app_dir" ] && [ ! -e "$app_dir" ]; then mv "$old" "$app_dir" && old=''; fi
  for path in "$stage" "$old" "$wrapper"; do [ -n "$path" ] && rm -rf "${path:?}"; done
  return 0
}

main() {
  : "${HOME:?HOME não definido}"
  check_node
  bin_dir=${QUEBRAGALHO_BIN_DIR:-$HOME/.local/bin}
  app_dir=${QUEBRAGALHO_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/quebragalho}
  case $bin_dir in /*) ;; *) die 'QUEBRAGALHO_BIN_DIR deve ser um caminho absoluto.' ;; esac
  case $app_dir in /*) ;; *) die 'QUEBRAGALHO_HOME deve ser um caminho absoluto.' ;; esac
  launcher=$bin_dir/quebragalho

  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    is_ours "$launcher" || die "Já existe $launcher e ele não é do Quebra-galho; instalação interrompida para preservar o arquivo."
  fi
  if [ -e "$app_dir" ] || [ -L "$app_dir" ]; then
    { [ -d "$app_dir" ] && [ ! -L "$app_dir" ] && { [ -f "$app_dir/.managed" ] || [ -z "$(ls -A "$app_dir")" ]; }; } || die "Já existe $app_dir e ele não é do Quebra-galho; use QUEBRAGALHO_HOME para outro destino."
  fi

  parent=$(dirname "$app_dir")
  mkdir -p "$parent" "$bin_dir"
  stage=$(mktemp -d "$parent/.quebragalho-stage.XXXXXX")
  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP
  chmod 755 "$stage"
  populate "$stage"

  wrapper=$(mktemp "$bin_dir/.quebragalho-new.XXXXXX")
  {
    printf '#!/bin/sh\n# %s (gerado por install.sh; reinstale para atualizar)\n' "$MARKER"
    printf 'QUEBRAGALHO_LAUNCHER=%s; export QUEBRAGALHO_LAUNCHER\n' "$(sq "$launcher")"
    printf 'exec node %s "$@"\n' "$(sq "$app_dir/quebragalho.mjs")"
  } > "$wrapper"
  chmod 755 "$wrapper"

  if [ -e "$app_dir" ]; then old=$(mktemp -u "$parent/.quebragalho-old.XXXXXX"); mv "$app_dir" "$old"; fi
  mv "$stage" "$app_dir"
  stage=''
  mv -f "$wrapper" "$launcher"
  wrapper=''
  echo "Instalado em $launcher (arquivos em $app_dir)"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "Adicione $bin_dir ao PATH do seu terminal (por exemplo, em ~/.profile ou ~/.zshrc)." ;;
  esac
  next_steps "$launcher"
}

next_steps() {
  launcher=$1
  shift
  input=$(tty_input)
  if [ -z "$input" ]; then
    echo 'Próximo passo: quebragalho login (depois: quebragalho doctor)'
    return 0
  fi
  if command -v claude >/dev/null 2>&1; then
    question='Configurar agora um perfil Claude separado do Quebra-galho (inclui o login)? [S/n] '
    set -- setup claude
  else
    question='Entrar na sua conta Quebra-galho agora? [S/n] '
    set -- login
  fi
  printf '%s' "$question"
  IFS= read -r choice < "$input" || choice=n
  case $choice in
    ''|s|S|y|Y) "$launcher" "$@" < "$input" || echo "Não concluído. Quando quiser: quebragalho $*" ;;
    *) echo "Quando quiser: quebragalho $*" ;;
  esac
}

main "$@"
