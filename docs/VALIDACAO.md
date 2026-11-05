# Histórico de validações

Registro do que foi realmente verificado, por data. O que não aparece aqui não foi verificado. Nenhuma chave real é guardada no repositório nem nos logs.

## 05/11/2026: versão multiplataforma (launcher em `lib/`, login, cofre, comandos de conta)

Verificado por testes automatizados (rede e cofres simulados) no macOS:

- Instalação por clone e por `curl | sh` (origem simulada por `file://`), reinstalação que atualiza só arquivo nosso, preservação de arquivo, link simbólico e diretório alheios, abortar sem arquivo parcial quando um download falha, caminhos com espaços e aspas.
- Login por código (aprovado, negado, expirado, `slow_down`, 429 com `Retry-After`), com o mesmo laço do CLI oficial.
- Cofre do Chaves, libsecret, arquivo 0600 e DPAPI **simulados** (o sistema operacional é trocado no teste): o segredo só passa por stdin.
- `setup claude` nos três cofres, `apiKeyHelper` por sistema, `__key`, falhas sem alterar o `settings.json`.
- Filtro de modelos de decisão, uso do catálogo real no Pi e no OpenCode, `launch codex` com 404 e com `--forcar`, aviso de saldo, harness ausente com o comando de instalação.
- Citação para `cmd.exe` (espaços, aspas, `& | % ^`) contra um modelo do `cmd.exe` e do runtime C, mais testes baseados em propriedades.

Verificado ao vivo no macOS, sem chave:

- Instalação em diretório temporário pelo `install.sh`, `--help`, `list` e `doctor --json` (gateway alcançável, chave ausente, saída 0).
- `quebragalho login --sem-navegador` contra o servidor real: pediu o código, mostrou o código e a URL, ficou aguardando; o processo foi interrompido com SIGINT sem aprovar, nada foi guardado e nenhum processo ou arquivo temporário ficou.

Fatos do gateway informados pelo mantenedor em 05/11/2026 (não reconferidos nesta rodada, pois não havia chave): catálogo com 18 modelos e campos de metadados e preço, dois modelos de decisão sem endpoint de chat, `/v1/balance`, `/v1/key`, `/v1/usage`, `/v1/status`, limite de 60 leituras por minuto por chave e `/v1/responses` respondendo 404.

**Não verificado** (depende do CI ou de ambiente que não havia aqui):

- Windows (PowerShell 5.1, PowerShell 7, cmd.exe): `install.ps1`, `quebragalho.cmd`, PATH do usuário, DPAPI real, `launch` chamando `.cmd` de harness com argumentos hostis. Os testes "Windows real" e o job de instalação do CI cobrem isso; até o CI passar nos três sistemas, trate como não validado.
- Linux, WSL e FreeBSD reais, libsecret real, gnome-keyring e KWallet.
- Aprovação real do login no navegador e gravação real no cofre; `saldo`, `uso`, `conta`, `status` e `modelos` contra o gateway real com uma chave.
- Claude Code, Codex, OpenCode, Aider e Pi reais com esta versão do launcher.
- Codex: continua dependendo de `/v1/responses` no gateway; o launcher não traduz protocolo.

## 30/09/2026 e 01/10/2026: versão anterior (arquivo único, macOS e Linux)

Resultados da versão anterior, mantidos como histórico. Não foram repetidos com a versão multiplataforma.

- Gateway `https://api.quebragalho.dev`: catálogo HTTP 200 (17 modelos na época). Messages e Chat Completions responderam `OK` com `gpt-6-luna`; streaming SSE e chamada de ferramenta `echo` nos dois protocolos.
- Responses: HTTP 404. O Codex 0.159.2 saiu com código 1 após HTTP 404 em `/v1/responses`.
- Claude Code 2.1.286: `launch` com `gpt-6-luna` respondeu `OK` (houve aviso de modelo desconhecido e limites de contexto); com `claude-opus-5.5` a tentativa foi encerrada após 150 s sem resposta. `quebragalho claude -p` respondeu `OK` em perfil temporário, sem exports de gateway.
- OpenCode 1.18.31: `launch` com `gpt-6-luna` respondeu `OK`.
- Aider e Pi: verificados apenas por executáveis simulados.
- Isolamento dos cinco harnesses (HOME, XDG e caminhos específicos): arquivos pessoais de configuração e autenticação idênticos antes e depois; Claude e OpenCode reais responderam `OK`.
- Setup antigo do Claude (30/09), que editava o Claude oficial, foi substituído pelo perfil separado. Se você usou aquele setup, restaure o backup `~/.claude/settings.json.quebragalho-backup-*`; o setup novo não migra nem sobrescreve a configuração oficial.
- Publicação: acesso anônimo HTTP 200 e clone público novo passando testes, verificações de sintaxe, instalação temporária e `list`.
