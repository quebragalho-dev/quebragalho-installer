# Quebra-galho: instalador e launcher

`quebragalho` abre o Claude Code, o Codex, o OpenCode, o Aider e o Pi usando os modelos do gateway Quebra-galho (QG), sem tocar na configuração oficial de nenhum deles. Também mostra saldo, consumo, status e catálogo, e faz o login da sua conta.

Funciona em macOS, Linux, WSL, Windows 10/11 e FreeBSD (melhor esforço), em x64 e ARM. É só Node.js: não há binário por arquitetura.

## Instalar (uma linha)

Requer [Node.js 22+](https://nodejs.org). Não pede `sudo` nem administrador.

macOS, Linux, WSL e FreeBSD:

```sh
curl -fsSL https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main/install.sh | sh
```

Windows 10/11, no PowerShell:

```powershell
irm https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main/install.ps1 | iex
```

Windows, no Prompt de Comando (cmd):

```bat
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/quebragalho-dev/quebragalho-installer/main/install.ps1 | iex"
```

Depois, num terminal novo:

```sh
quebragalho login      # abre o navegador, você aprova o código e pronto
quebragalho doctor     # confere Node, cofre, gateway e harnesses
quebragalho launch     # escolhe harness e modelo
```

Rodar o instalador de novo atualiza para a versão mais recente. Ele só sobrescreve o que é dele (arquivo com o marcador `quebragalho-installer:managed`); um arquivo ou link simbólico seu com o mesmo nome é preservado e a instalação para com aviso.

Prefere ler antes de rodar? Baixe o script, leia e rode, ou clone:

```sh
git clone https://github.com/quebragalho-dev/quebragalho-installer.git
cd quebragalho-installer
sh install.sh                                           # macOS, Linux, WSL, FreeBSD
powershell -ExecutionPolicy Bypass -File .\install.ps1  # Windows
```

### Onde fica cada coisa

| Sistema | Comando | Arquivos |
| --- | --- | --- |
| macOS, Linux, WSL, FreeBSD | `~/.local/bin/quebragalho` | `~/.local/share/quebragalho` |
| Windows | `%LOCALAPPDATA%\Programs\quebragalho\quebragalho.cmd` | `...\quebragalho\quebragalho-app` |

No Windows o instalador soma a pasta ao PATH **do usuário** (sem administrador); abra um terminal novo depois. No macOS e no Linux, se `~/.local/bin` não estiver no PATH, o instalador avisa.

Variáveis do instalador: `QUEBRAGALHO_BIN_DIR` (onde fica o comando), `QUEBRAGALHO_HOME` (arquivos; só macOS/Linux), `QUEBRAGALHO_NO_PROMPT=1` (sem perguntas), `QUEBRAGALHO_NO_MODIFY_PATH=1` (Windows: não altera o PATH), `QUEBRAGALHO_RAW_URL` (origem dos arquivos; para fixar uma versão, use a URL raw de um commit).

O download baixa só os arquivos do launcher, por HTTPS. Se qualquer um falhar, nada é instalado e nenhum arquivo parcial fica. Sem confirmação de integridade além do HTTPS: confie apenas se confiar neste repositório.

Se aparecer "harness não encontrado", o erro mostra o comando oficial de instalação dele.

## Comandos

| Comando | O que faz |
| --- | --- |
| `quebragalho login [--chave]` | Entra na conta por código no navegador. `--chave` cola uma chave de API. Guarda no cofre do sistema. `--sem-navegador` só mostra o código. |
| `quebragalho logout` | Remove a chave do cofre. |
| `quebragalho saldo` | Saldo disponível, recarregado e bônus. |
| `quebragalho uso [--periodo 24h\|7d\|30d]` | Requisições e tokens da chave atual. |
| `quebragalho conta` | Nome da chave, prefixo e plano. Nenhum dado pessoal. |
| `quebragalho status [modelo]` | Estado do gateway e dos modelos. |
| `quebragalho modelos [--busca X] [--visao] [--ferramentas] [--decisao]` | Catálogo com preço por 1M de tokens em USD e BRL, contexto, saída máxima, capacidades e oferta. |
| `quebragalho doctor` | Diagnóstico: Node, sistema, PATH, cofre, gateway, chave, saldo e quais harnesses estão instalados e funcionam. |
| `quebragalho launch [harness] [--model ID] [-- args]` | Abre o harness com um modelo. |
| `quebragalho setup claude` | Cria o perfil Claude do QG (veja abaixo). Depois: `quebragalho claude`. |
| `quebragalho list` | Lista os harnesses. |

Todos os comandos de leitura aceitam `--json`. O código de saída é 0 em sucesso e 1 em erro; `doctor` só sai com 1 quando algo está realmente quebrado (por exemplo, chave recusada), nunca por falta de rede.

Sem `QUEBRAGALHO_API_KEY` no ambiente, os comandos usam a chave do `quebragalho login`. A variável sempre tem prioridade. A URL padrão é `https://api.quebragalho.dev`; `QUEBRAGALHO_BASE_URL` troca o gateway (aceita a raiz ou o sufixo `/v1`). A chave do login oficial nunca é enviada a uma URL diferente da oficial.

Consultas de conta têm limite de 60 por minuto por chave; ao passar, o erro diz em quantos segundos tentar de novo.

## Cofre de chaves

A chave nunca vai em argumento de processo nem no `settings.json`.

| Sistema | Onde a chave fica |
| --- | --- |
| macOS | Chaves (Keychain), como sempre. Perfis já configurados continuam funcionando. |
| Linux | libsecret (`secret-tool`) quando existe e funciona. Senão, um arquivo (diretório 0700, arquivo 0600) com **aviso explícito**: ele só é protegido por permissões. Instale `libsecret-tools` e um chaveiro para mais proteção. |
| WSL, FreeBSD, contêineres | Normalmente o arquivo 0600 acima. |
| Windows | DPAPI do usuário (via PowerShell), em arquivo dentro de `%APPDATA%\quebragalho\vault`. Só a sua conta Windows decifra. |

`QUEBRAGALHO_VAULT=file` força o arquivo 0600 em qualquer sistema (útil em CI); nesse caso o `apiKeyHelper` do perfil Claude também lê do arquivo. Chaves precisam ser ASCII visível, até 512 caracteres. O Chaves do macOS e o arquivo 0600 não impedem que outro processo seu leia a chave: proteja a conta do usuário.

## Claude: oficial e QG separados

O instalador **não modifica `~/.claude/settings.json`, credenciais, aliases ou modelos do Claude oficial**. O QG usa um perfil próprio, em `~/.config/quebragalho/claude` (ou `$XDG_CONFIG_HOME/quebragalho/claude`; no Windows, `%APPDATA%\quebragalho\claude`).

Com Claude Code 2.1.242+ instalado:

```sh
quebragalho setup claude   # login, catálogo e perfil, uma vez
claude                     # Claude oficial, com sua configuração original
quebragalho claude         # perfil QG; escolha os modelos QG em /model
```

No perfil QG, o `apiKeyHelper` lê a chave do cofre: no macOS pelo próprio `security`; no Linux e no Windows chamando o próprio `quebragalho` com um subcomando interno que só imprime a chave desse perfil. Perfis e credenciais anteriores são preservados por backup privado e gravação atômica. O perfil não copia hooks, plugins nem credenciais pessoais. Políticas gerenciadas e configurações de projeto ainda podem interferir.

## Outros harnesses

```sh
quebragalho launch                       # menu de harness e de modelo
quebragalho launch opencode --model ID
quebragalho launch codex --model ID -- exec "Explique este projeto"
```

Argumentos depois de `--` seguem literalmente para o harness, inclusive no Windows (onde o `.cmd` do harness é chamado com citação segura para o `cmd.exe`, sem busca no diretório atual e sem expansão de `!VAR!`). `%VAR%` em argumentos não é expandido. O código de saída é preservado.

| Harness | API exigida | Observação |
| --- | --- | --- |
| Claude Code | `/v1/messages` | Perfil temporário em `launch`; persistente em `setup claude`. |
| Codex | `/v1/responses` | **Indisponível enquanto o gateway não tiver `/v1/responses`.** O `launch codex` falha antes de abrir, com mensagem clara. `--forcar` ignora o teste. O launcher não traduz protocolos. |
| OpenCode | `/v1/chat/completions` | Usa contexto, saída, capacidades e preço do catálogo. |
| Aider | `/v1/chat/completions` | |
| Pi | `/v1/chat/completions` | Usa contexto, saída, capacidades e preço (USD por 1M) do catálogo; sem metadado, cai em 32K de contexto e 4096 de saída. |

Modelos de decisão (`type: "decision"` ou sem endpoint de chat) não aparecem em nenhum seletor e `--model` com eles recusa. Veja-os com `quebragalho modelos --decisao`.

Com saldo zerado ou abaixo de R$ 5,00, o `launch` avisa no stderr antes de abrir o harness e segue. Se a leitura do saldo falhar, abre normalmente.

### Isolamento

Todo `launch` usa HOME e diretórios XDG temporários (no Windows, também `USERPROFILE`, `APPDATA` e `LOCALAPPDATA`), sem carregar nem substituir o estado pessoal dos harnesses. Os diretórios são removidos ao terminar (saída normal, falha, SIGINT e SIGTERM); SIGKILL ou queda da máquina podem deixá-los. O diretório do projeto é o mesmo: o harness pode alterar seus arquivos. Isolamento de perfil não é sandbox.

O launcher recusa redirecionamentos, exige HTTPS (HTTP só em loopback), e nenhum erro mostra chave, URL ou corpo do provedor. O tráfego da sessão vai para o gateway selecionado.

## Desenvolvimento

```sh
npm ci --ignore-scripts
npm test                        # suíte completa, sem rede
npm run coverage                # cobertura
npm run mutation                # testes de mutação (Stryker)
node --check quebragalho.mjs && sh -n install.sh
```

O CI (`.github/workflows/ci.yml`) roda a suíte em Ubuntu, macOS e Windows com Node 22 e 24, valida a sintaxe do `install.sh` e do `install.ps1` e faz uma instalação real em cada sistema.

Estrutura: `quebragalho.mjs` (entrada) e `lib/` (módulos). Os instaladores baixam essa lista fixa de arquivos; um teste garante que as listas do `install.sh` e do `install.ps1` batem com os arquivos reais. Sem dependências em tempo de execução.

Histórico de verificações reais: [docs/VALIDACAO.md](docs/VALIDACAO.md).

Referências: [Ollama](https://docs.ollama.com/integrations/claude-code), [Claude Code](https://code.claude.com/docs/en/model-config#add-a-custom-model-option), [Codex](https://learn.chatgpt.com/docs/config-file/config-advanced), [OpenCode](https://opencode.ai/docs/providers/#custom-provider), [Aider](https://aider.chat/docs/llms/openai-compat.html), [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md).
