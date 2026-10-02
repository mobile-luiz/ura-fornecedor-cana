# URA de Consulta — Fornecedores de Cana (Tonelagem e ATR)

Bot de WhatsApp em que o fornecedor de cana consulta sua tonelagem e seu ATR
informando o CPF.

## Como funciona

1. O fornecedor manda qualquer mensagem e o bot dá boas-vindas e pede o CPF.
2. O fornecedor digita o CPF, com ou sem pontuação.
3. O bot confere o formato, os dígitos verificadores e o cadastro.
4. Com o CPF encontrado, aparece o menu:
   - **1**: última entrega (data, toneladas, ATR)
   - **2**: acumulado da safra (total de toneladas, ATR médio ponderado, nº de entregas)
   - **3**: falar com um atendente

Comandos que funcionam em qualquer momento: **menu**, **sair** e **atendente**
(maiúsculas ou minúsculas, tanto faz).

## Como rodar

Requer Node.js 20.12 ou mais novo.

```bash
npm install
copy .env.example .env      (no Linux/Mac: cp .env.example .env)
node bot.js
```

Abra http://localhost:3000 e escaneie o QR Code com o WhatsApp que vai ser o
bot (use um número dedicado, não o pessoal). A página se atualiza sozinha.

Para testar o fluxo sem WhatsApp:

```bash
node teste.js
```

## Configuração (`.env`)

| Variável | Para que serve |
|---|---|
| `PORT` | Porta do painel (padrão 3000) |
| `PAINEL_SENHA` | Senha do painel do QR Code. Vazio = painel só abre no próprio PC |
| `ATENDENTE_NUMERO` | WhatsApp que recebe aviso quando alguém escolhe a opção 3 (ex.: 5581999999999) |
| `NOME_USINA` | Nome mostrado na mensagem de boas-vindas |
| `LOG_LEVEL` | Log do Baileys: `silent`, `error`, `warn`, `info`, `debug` |

## Atendimento humano (opção 3)

Quando o fornecedor pede atendente, o bot avisa o `ATENDENTE_NUMERO` (se
configurado) com o nome do fornecedor e o link `wa.me` do contato, e **fica em
silêncio nessa conversa por 60 minutos**. O atendente responde pelo próprio
WhatsApp do bot. Se o fornecedor digitar **menu**, o atendimento automático
volta na hora.

## Segurança

- **A pasta `auth/` é a sessão do WhatsApp.** Quem tiver esses arquivos
  controla o número do bot. Ela está no `.gitignore` e nunca deve ir para o
  GitHub.
- **O painel do QR Code é protegido.** Quem escanear o QR vira o dono do bot.
  Sem `PAINEL_SENHA`, o painel só abre em `localhost`. Em servidor (Render,
  VPS), defina uma senha; o navegador vai pedir usuário (qualquer um) e senha.
- **Limite de tentativas.** Depois de 3 CPFs não cadastrados, a conversa fica
  bloqueada por 15 minutos, para impedir que alguém fique testando CPFs.
- **Sessão expira.** Depois de 10 minutos parado, o bot pede o CPF de novo.
- **Logs mascarados.** O terminal mostra só o final do CPF (LGPD).
- Para mudar esses tempos e limites, edite o bloco `CONFIG` no início do `bot.js`.

## Se o celular desconectar o bot

Se você remover o aparelho em *WhatsApp → Aparelhos conectados*, o bot apaga
a sessão antiga sozinho e gera um QR Code novo no painel. É só escanear de novo.

## Trocando a fonte de dados

Os dados ficam em `dados-fornecedores.json`, indexados por CPF (só números).
Os CPFs do arquivo são fictícios (válidos só para teste). Para produção,
troque a função `buscarFornecedor()` no `bot.js` por uma consulta à planilha
Google, ao banco de dados ou ao sistema de pesagem da usina.

Formato esperado:

```json
{
  "CPF_SEM_PONTUACAO": {
    "nome": "Nome do Fornecedor",
    "codigo": "Código interno",
    "entregas": [
      { "data": "AAAA-MM-DD", "toneladas": 42.3, "atr": 138.45 }
    ]
  }
}
```

As entregas podem estar em qualquer ordem (o bot ordena pela data), e os
números podem vir como texto no formato brasileiro (`"42,3"`, `"1.042,30"`),
como costuma acontecer com planilhas. Entregas com data ou número inválido
são ignoradas.

## Próximos passos para produção

- Guardar as sessões em Redis ou banco (hoje ficam na memória e somem se o
  bot reiniciar).
- Vincular o número de WhatsApp ao CPF depois da primeira consulta.
- Definir uma política de retenção e acesso aos dados (LGPD).
