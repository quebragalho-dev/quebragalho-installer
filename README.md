# Instalador Quebra-galho

Instala `quebragalho` em `~/.local/bin` para abrir diferentes harnesses com modelos de um gateway. Inspirado em `ollama launch`, sem copiar seu código. Requer macOS/Linux, Node.js 22+ e os harnesses desejados instalados.

## Claude: oficial e QG separados

O installer **não modifica `~/.claude/settings.json`, credenciais, aliases ou modelos do Claude oficial**. O QG usa um perfil próprio. Adicionar linhas ao mesmo `/model` não troca a conexão de API por modelo; por isso o installer não mistura modelos oficiais e QG sob um único gateway.

No macOS, com Claude Code 2.1.242+ instalado:

```sh
git clone https://github.com/nikolasdehor/quebragalho-installer.git
cd quebragalho-installer
sh install.sh
```

O instalador oferece configurar um **perfil separado**. Informe a URL (Enter usa Quebra-galho) e cole a chave no campo oculto. Depois:

```sh
claude               # Claude oficial, com sua configuração original
quebragalho claude   # Perfil QG; escolha os modelos QG em /model
```

Não precisa repetir exports. No perfil QG, `/model` salva a escolha somente nesse perfil. Para configurar ou atualizar o catálogo: `quebragalho setup claude`.

O setup grava apenas `~/.config/quebragalho/claude/settings.json` (ou `$XDG_CONFIG_HOME/quebragalho/claude/settings.json`). A chave fica no Chaves do macOS; o perfil usa `apiKeyHelper`. Perfis e credenciais anteriores são preservados por backup privado e gravação atômica. O perfil QG não copia hooks, plugins ou credenciais pessoais do Claude oficial. Políticas gerenciadas e configurações de projeto continuam podendo interferir. O setup é exclusivo do macOS; `launch` funciona em macOS/Linux.

Se usou o setup antigo, que editava o Claude oficial, restaure o backup `~/.claude/settings.json.quebragalho-backup-*` antes de usar a nova versão. O setup novo não migra nem sobrescreve sua configuração oficial automaticamente.

## Outros harnesses e uso por sessão

```sh
export QUEBRAGALHO_BASE_URL="https://SEU-GATEWAY"
# Defina QUEBRAGALHO_API_KEY no ambiente com sua chave.
quebragalho launch
quebragalho launch codex
quebragalho launch opencode
quebragalho launch aider
quebragalho launch pi
quebragalho launch t3
quebragalho launch codex --model ID -- exec "Explique este projeto"
quebragalho launch t3 --model ID -- --no-browser
```

`launch` sem nome oferece escolha interativa de harness. O catálogo vem de `GET /v1/models` no formato `{"data":[{"id":"modelo"}]}`. A URL base aceita a raiz ou o sufixo `/v1`. Com vários modelos, o launcher oferece seleção; sem terminal interativo, exige `--model`. Argumentos depois de `--` seguem literalmente para o harness (para `t3`, vão ao CLI do T3, ex `--no-browser`). O código de saída e os sinais de encerramento são preservados.

| Harness | Isolamento da sessão QG | API exigida |
| --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` próprio | /v1/messages, SSE e ferramentas |
| Codex | `CODEX_HOME` próprio, provider por sessão | /v1/responses, SSE e ferramentas |
| OpenCode | HOME/XDG e `OPENCODE_CONFIG_DIR` próprios; provider inline | /v1/chat/completions, SSE e ferramentas |
| Aider | Configuração, dotenv e históricos privados | /v1/chat/completions |
| Pi | `PI_CODING_AGENT_DIR` próprio e extensão privada | /v1/chat/completions, SSE e ferramentas |
| T3 | HOME/XDG, `T3CODE_HOME` e base-dir próprios; só provider OpenCode QG (`quebragalho/ID`) | /v1/chat/completions, SSE e ferramentas |

Todos os `launch` usam HOME e diretórios XDG temporários, sem carregar ou substituir o estado pessoal dos harnesses. Escolhas de modelo, credenciais e históricos da sessão QG não viram preferências oficiais. Esses diretórios são removidos ao terminar: os históricos QG temporários não ficam disponíveis para retomar a sessão. `quebragalho claude` usa o perfil QG persistente separado já descrito acima.

`launch t3 --model ID` sobe um servidor T3 próprio em foreground (host loopback, HOME/XDG, `T3CODE_HOME` e base-dir temporários) com só o provider OpenCode QG habilitado. O modelo `quebragalho/ID` é usado na conversa, títulos e tarefas auxiliares de controle de versão. O binário OpenCode é resolvido no PATH antes de iniciar o T3, evitando que a hidratação do shell escolha outra instalação. O que vem depois de `--` vai para o CLI do T3 (ex `--no-browser`), não para o agente. Requer `t3` e `opencode` instalados; use a versão de OpenCode recomendada pela sua versão do T3 em Settings → Providers, não apenas a mais recente. O provider é OpenCode, não genérico, e não reaproveita desktop/app pessoal nem instala service. Ao terminar (Ctrl-C/SIGTERM) o temporário some e o histórico não é retomável. A chave viaja só no ambiente (placeholder `{env:QUEBRAGALHO_API_KEY}` no config inline); o launcher não grava segredo.

Validação T3 em 08/10/2026: T3 0.0.45 com OpenCode 1.14.19 (versão recomendada pela UI) executou um prompt na interface web e exibiu `QG-OK`, encerrando o turno. O gateway HTTP local simulado recebeu Chat Completions com streaming SSE e `qg-smoke` tanto na conversa quanto na geração auxiliar. O launcher usado foi o código atual, sem alterar os settings temporários manualmente. SIGTERM encerrou o servidor e o perfil privado foi removido. Tentativas anteriores sofreram timeout neste ambiente próximo do limite de memória, com eventos OOM; após liberar um processo auxiliar da sessão e navegadores residuais, o fluxo terminou sem aumentar timeouts. Um aviso anterior do health check de 4 segundos permaneceu na UI, mas não impediu a conversa. OpenCode 2.0.25 foi marcado incompatível pelo T3 0.0.45. Essa prova usa gateway simulado: não comprova inferência nem ferramentas em serviço real.

O diretório do projeto permanece o mesmo: arquivos de trabalho ainda podem ser alterados pelo harness conforme sua tarefa. Configurações de projeto, políticas gerenciadas e flags explicitamente encaminhadas podem interferir ou escolher outros caminhos; o isolamento de perfil não é uma sandbox.

O launcher não traduz protocolos. Catálogo disponível não comprova suporte a ferramentas ou a cada API; validar isso no gateway. Para Pi, os limites são conservadores (32K contexto, 4096 saída), entrada só texto e sem raciocínio declarado. Custos zero são placeholders do SDK, não indicação de gratuidade; não use a estimativa do Pi para faturamento. Substituir por metadados oficiais antes de distribuir em produção.

`launch` não grava chaves nem edita configs globais dos harnesses ou arquivos do shell. `setup claude` modifica apenas o perfil QG e guarda a chave no Chaves conforme descrito acima. `launch claude` usa um perfil temporário para não gravar escolhas no Claude oficial. Configurações de projeto e políticas gerenciadas podem interferir; confira o provider e modelo na sessão. OpenCode preserva campos existentes no JSON inline e acrescenta o provider. Os perfis temporários dos seis harnesses são removidos em saída normal, falha de execução e SIGINT/SIGTERM. SIGKILL ou queda da máquina podem deixar o diretório: arquivos de estado produzidos pelo próprio harness podem conter dados da sessão, embora o launcher não grave a chave em sua configuração.

O tráfego da sessão vai para o gateway selecionado. O instalador não usa sudo, preserva executáveis existentes e não baixa harnesses automaticamente. `QUEBRAGALHO_BIN_DIR` escolhe outro destino; se ele não estiver no PATH, o instalador avisa.

## Verificação

```sh
npm test
node --check quebragalho.mjs
sh -n install.sh
```

Os testes executam o instalador, o launcher instalado e seis executáveis simulados. Mockam a consulta HTTP para não abrir sockets nem usar credenciais reais. Verificam configs, catálogo, argumentos literais, códigos de saída, sinais, limpeza e erros. O setup usa um Chaves simulado para verificar perfil separado, atalho sem exports, preservação byte a byte das configurações oficiais, backup privado, modelo padrão, reconfiguração e falhas sem vazamento de chave. Os seis launches também verificam HOME/XDG privados, diretórios específicos, remoção de caminhos oficiais herdados e limpeza de estado, preservando arquivos oficiais byte a byte na suíte simulada. Não comprovam inferência, streaming ou ferramentas nos serviços reais.

Validação real em 30/09/2026, sem expor credenciais no repositório ou nos logs:

- `npm test`, `node --check` e `sh -n`: verdes; instalação temporária e comando `list` conferidos.
- Publicação: acesso anônimo HTTP 200; clone público novo passou nos testes, verificações de sintaxe, instalação temporária e `list`.
- Gateway `https://api.quebragalho.dev`: catálogo HTTP 200, com 17 modelos.
- Messages e Chat Completions: HTTP 200 e resposta `OK` com `gpt-6-luna`.
- Validação adicional com `gpt-6-luna`: streaming SSE com resposta `OK` e encerramento do fluxo; chamada de ferramenta `echo` com argumentos válidos, devolução do resultado e resposta final `OK` nos dois protocolos. Isso verifica a troca de mensagens de ferramenta; não executa comandos nem comprova todos os modelos.
- Responses: HTTP 404. O gateway testado não confirmou compatibilidade com Codex; o launcher exige esse protocolo e não o traduz.
- Setup antigo do Claude (30/09, substituído): redirecionava a conexão e a lista oficiais. Foi removido do perfil pessoal; a versão atual configura somente um perfil QG separado.
- Claude Code 2.1.286: `launch` com `gpt-6-luna` respondeu `OK` e saiu com código zero; houve aviso de modelo desconhecido/limites de contexto. Com `claude-opus-5.5`, a tentativa foi encerrada após 150 segundos sem resposta.
- Codex 0.159.2: `launch` selecionou o provider e modelo corretos, mas saiu com código 1 após HTTP 404 em `/v1/responses`.
- OpenCode 1.18.31: `launch` com `gpt-6-luna` respondeu `OK` e saiu com código zero.
- Aider e Pi: integrações verificadas por testes locais com executáveis simulados; binários não testados ao vivo.

Validação da correção em 01/10/2026: `quebragalho claude -p` respondeu `OK` em perfil temporário, sem exports de gateway. O catálogo tinha 17 modelos; `~/.claude/settings.json` permaneceu byte a byte intacto, nenhuma instalação pessoal foi refeita e a credencial temporária foi removida. A suíte local passou com preservação de configurações dos cinco harnesses e do provider existente no OpenCode.

Validação do isolamento ampliado em 01/10/2026: os cinco launches passaram na suíte local com HOME/XDG e caminhos específicos privados. Claude e OpenCode reais responderam `OK`; Codex iniciou no perfil privado, mas continuou recebendo HTTP 404 em Responses. Os arquivos pessoais de configuração e autenticação verificados permaneceram idênticos antes e depois. Aider e Pi continuam verificados apenas por executáveis simulados; nenhuma instalação pessoal foi refeita.

O repositório distribui o installer por clone; não há pacote npm ou release. As verificações acima não comprovam todos os modelos ou todos os recursos de streaming. O installer também preserva links simbólicos com destino inexistente, com teste de regressão local.

Referências: [Ollama](https://docs.ollama.com/integrations/claude-code), [Claude Code](https://code.claude.com/docs/en/model-config#add-a-custom-model-option), [Codex](https://learn.chatgpt.com/docs/config-file/config-advanced), [OpenCode](https://opencode.ai/docs/providers/#custom-provider), [Aider](https://aider.chat/docs/llms/openai-compat.html), [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md), [T3 install](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md), [T3 OpenCode](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-opencode.md).
