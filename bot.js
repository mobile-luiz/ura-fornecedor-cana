/**
 * URA de consulta de tonelagem e ATR para fornecedores de cana (WhatsApp)
 *
 * Fluxo:
 *   1. Fornecedor manda qualquer mensagem -> bot dá boas-vindas e pede o CPF
 *   2. Bot valida o CPF (formato, dígitos verificadores e cadastro)
 *   3. Menu: 1 última entrega | 2 acumulado da safra | 3 falar com atendente
 *
 * Como rodar:  npm install  ->  node bot.js
 * Painel do QR Code: http://localhost:3000 (porta configurável no .env)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lê o arquivo .env, se existir (Node 20.12+). Sem .env, usa os valores padrão.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* sem .env: segue com os padrões */
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  normalizeMessageContent,
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

// =====================================================================
// Configuração
// =====================================================================
const CONFIG = {
  porta: Number(process.env.PORT) || 3000,
  senhaPainel: process.env.PAINEL_SENHA || '',
  numeroAtendente: (process.env.ATENDENTE_NUMERO || '').replace(/\D/g, ''),
  nomeUsina: process.env.NOME_USINA || 'Usina',
  logLevel: process.env.LOG_LEVEL || 'silent',

  maxTentativasCPF: 3,                    // CPFs não encontrados antes de bloquear
  bloqueioMs: 15 * 60 * 1000,             // bloqueio após errar demais: 15 min
  sessaoExpiraMs: 10 * 60 * 1000,         // inatividade que exige CPF de novo: 10 min
  atendimentoHumanoMs: 60 * 60 * 1000,    // bot fica em silêncio com o atendente: 60 min
  limpezaSessoesMs: 2 * 60 * 60 * 1000,   // apaga da memória sessões paradas há 2 h
};

const PASTA_AUTH = path.join(__dirname, 'auth');
const CAMINHO_DADOS = path.join(__dirname, 'dados-fornecedores.json');

// Conversas que o bot ignora: grupos, status, listas de transmissão, canais
const JIDS_IGNORADOS = ['@g.us', '@broadcast', '@newsletter'];

// =====================================================================
// Estado da conexão (usado pelo painel web)
// =====================================================================
let qrCodeAtual = null;            // QR Code como imagem (data URL) ou null
let statusConexao = 'aguardando';  // aguardando | conectado | desconectado | deslogado

// =====================================================================
// Painel web (QR Code) — protegido
// =====================================================================
function ehLocalhost(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function senhaConfere(senhaDigitada) {
  const a = Buffer.from(String(senhaDigitada));
  const b = Buffer.from(CONFIG.senhaPainel);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Quem escanear o QR Code vira o "dono" do bot, então o painel não pode ficar aberto.
// Com PAINEL_SENHA: pede usuário/senha (qualquer usuário, a senha do .env).
// Sem PAINEL_SENHA: só abre no próprio computador (localhost).
function protegerPainel(req, res, next) {
  if (CONFIG.senhaPainel) {
    const [tipo, valor] = (req.headers.authorization || '').split(' ');
    if (tipo === 'Basic' && valor) {
      const credenciais = Buffer.from(valor, 'base64').toString('utf-8');
      const senha = credenciais.slice(credenciais.indexOf(':') + 1);
      if (senhaConfere(senha)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Painel URA", charset="UTF-8"');
    return res.status(401).send('Acesso restrito. Informe a senha do painel.');
  }

  if (ehLocalhost(req)) return next();
  return res
    .status(403)
    .send('Painel disponível só neste computador. Defina PAINEL_SENHA no .env para acessar de fora.');
}

function iniciarServidor() {
  const app = express();
  app.disable('x-powered-by');
  app.use(protegerPainel);
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: statusConexao, qr: qrCodeAtual });
  });

  app.listen(CONFIG.porta, () => {
    console.log(`🌐 Painel do QR Code: http://localhost:${CONFIG.porta}`);
    if (!CONFIG.senhaPainel) {
      console.log('🔒 Sem PAINEL_SENHA: o painel só abre neste computador.');
    }
  });
}

// =====================================================================
// Dados dos fornecedores (trocar depois por planilha/SQL em buscarFornecedor)
// =====================================================================
function carregarDados() {
  try {
    return JSON.parse(fs.readFileSync(CAMINHO_DADOS, 'utf-8'));
  } catch (erro) {
    console.error('❌ Não foi possível ler dados-fornecedores.json:', erro.message);
    return null;
  }
}

// Aceita número (42.3) ou texto vindo de planilha ("42,3", "1.042,30", "42.3")
function paraNumero(valor) {
  if (typeof valor === 'number') return valor;
  if (typeof valor !== 'string') return NaN;
  const limpo = valor.trim();
  if (limpo.includes(',')) return Number(limpo.replace(/\./g, '').replace(',', '.'));
  return Number(limpo);
}

/**
 * Retorna o fornecedor já normalizado, com as entregas válidas
 * ordenadas da mais recente para a mais antiga. Retorna null se não existir.
 * Lança erro se a base estiver indisponível.
 */
function buscarFornecedor(cpf) {
  const dados = carregarDados();
  if (!dados) throw new Error('Base de dados indisponível');

  const bruto = dados[cpf];
  if (!bruto) return null;

  const entregas = (Array.isArray(bruto.entregas) ? bruto.entregas : [])
    .map((e) => ({
      data: String(e?.data || ''),
      toneladas: paraNumero(e?.toneladas),
      atr: paraNumero(e?.atr),
    }))
    .filter(
      (e) =>
        /^\d{4}-\d{2}-\d{2}$/.test(e.data) &&
        Number.isFinite(e.toneladas) &&
        Number.isFinite(e.atr)
    )
    .sort((a, b) => b.data.localeCompare(a.data));

  return {
    nome: String(bruto.nome || 'Fornecedor'),
    codigo: String(bruto.codigo || '-'),
    entregas,
  };
}

// =====================================================================
// Utilitários
// =====================================================================
function limparCPF(texto) {
  return texto.replace(/\D/g, '');
}

// Valida os dígitos verificadores do CPF
function validarCPF(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(cpf.slice(0, 9));
  const d2 = digito(cpf.slice(0, 9) + d1);
  return cpf.endsWith(`${d1}${d2}`);
}

// Mostra só o fim do CPF nos logs (LGPD)
function mascararCPF(cpf) {
  return cpf ? `***.***.${cpf.slice(6, 9)}-${cpf.slice(9)}` : '-';
}

function formatarData(dataISO) {
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarNumero(valor, casas) {
  return valor.toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
}

function minutos(ms) {
  return Math.round(ms / 60000);
}

// =====================================================================
// Mensagens
// =====================================================================
function montarBoasVindas() {
  return (
    `👋 Olá! Bem-vindo à Central de Consulta da ${CONFIG.nomeUsina}.\n\n` +
    `Por aqui você pode consultar:\n` +
    `🚛 Sua última entrega (tonelagem e ATR)\n` +
    `📊 O acumulado da sua safra\n\n` +
    `Para começar, digite o número do seu *CPF* (somente números).`
  );
}

function montarMenu(nome) {
  return (
    `Olá, ${nome}! 👋\nO que você deseja consultar?\n\n` +
    `1️⃣ Última entrega\n` +
    `2️⃣ Acumulado da safra\n` +
    `3️⃣ Falar com um atendente\n\n` +
    `Digite o número da opção, ou *sair* para encerrar.`
  );
}

const RODAPE = 'Digite *menu* para ver as opções ou *sair* para encerrar.';
const SEM_ENTREGAS = '📭 Ainda não há entregas registradas para você nesta safra.';

function montarUltimaEntrega(fornecedor) {
  if (fornecedor.entregas.length === 0) return SEM_ENTREGAS;
  const ultima = fornecedor.entregas[0];
  return (
    `📋 Fornecedor: ${fornecedor.nome} (Cód. ${fornecedor.codigo})\n` +
    `📅 Última entrega: ${formatarData(ultima.data)}\n` +
    `🚛 Tonelagem: ${formatarNumero(ultima.toneladas, 3)} t\n` +
    `🧪 ATR: ${formatarNumero(ultima.atr, 2)} kg/t`
  );
}

function montarAcumuladoSafra(fornecedor) {
  const { entregas } = fornecedor;
  if (entregas.length === 0) return SEM_ENTREGAS;

  const totalToneladas = entregas.reduce((soma, e) => soma + e.toneladas, 0);
  // ATR médio ponderado pela tonelagem (entrega maior pesa mais)
  const atrMedio =
    totalToneladas > 0
      ? entregas.reduce((soma, e) => soma + e.atr * e.toneladas, 0) / totalToneladas
      : 0;

  return (
    `📊 Fornecedor: ${fornecedor.nome} (Cód. ${fornecedor.codigo})\n` +
    `🚛 Total entregue na safra: ${formatarNumero(totalToneladas, 3)} t\n` +
    `🧪 ATR médio (ponderado): ${formatarNumero(atrMedio, 2)} kg/t\n` +
    `📦 Nº de entregas registradas: ${entregas.length}`
  );
}

// =====================================================================
// Sessões por conversa (em memória)
// Em produção, trocar por Redis/banco para sobreviver a um restart.
// =====================================================================
const sessoes = new Map();

function novaSessao() {
  return {
    etapa: 'inicio',          // inicio | aguardando_cpf | menu | atendente
    cpf: null,
    telefone: null,
    tentativas: 0,
    bloqueadoAte: 0,
    avisouBloqueio: false,
    atendenteAte: 0,
    ultimaAtividade: Date.now(),
  };
}

function getSessao(id) {
  if (!sessoes.has(id)) sessoes.set(id, novaSessao());
  return sessoes.get(id);
}

// Volta ao início sem perder o controle de tentativas/bloqueio
function encerrarSessao(sessao) {
  sessao.etapa = 'inicio';
  sessao.cpf = null;
  sessao.atendenteAte = 0;
}

// Remove da memória conversas paradas há muito tempo
setInterval(() => {
  const agora = Date.now();
  for (const [id, s] of sessoes) {
    const parada = agora - s.ultimaAtividade > CONFIG.limpezaSessoesMs;
    if (parada && s.bloqueadoAte < agora && s.atendenteAte < agora) sessoes.delete(id);
  }
}, 10 * 60 * 1000).unref();

// =====================================================================
// Processamento da mensagem recebida
// =====================================================================
async function encaminharAtendente(sock, sessao, enviar) {
  sessao.etapa = 'atendente';
  sessao.atendenteAte = Date.now() + CONFIG.atendimentoHumanoMs;

  await enviar(
    '👤 Certo! Um atendente vai continuar a conversa por aqui em breve.\n\n' +
      'Enquanto isso, o atendimento automático fica pausado. ' +
      'Para voltar ao menu, digite *menu*.'
  );

  if (!CONFIG.numeroAtendente) return;

  let identificacao = 'Não identificado (ainda não informou o CPF)';
  if (sessao.cpf) {
    try {
      const f = buscarFornecedor(sessao.cpf);
      if (f) identificacao = `${f.nome} (Cód. ${f.codigo})`;
    } catch {
      /* base fora do ar: segue sem o nome */
    }
  }
  const contato = sessao.telefone ? `wa.me/${sessao.telefone}` : 'veja a conversa no WhatsApp do bot';

  try {
    await sock.sendMessage(`${CONFIG.numeroAtendente}@s.whatsapp.net`, {
      text: `🔔 *Pedido de atendimento*\nFornecedor: ${identificacao}\nContato: ${contato}`,
    });
  } catch (erro) {
    console.error('⚠️ Não consegui avisar o atendente:', erro.message);
  }
}

async function registrarCPFNaoEncontrado(sessao, enviar) {
  sessao.tentativas++;

  if (sessao.tentativas >= CONFIG.maxTentativasCPF) {
    sessao.tentativas = 0;
    sessao.bloqueadoAte = Date.now() + CONFIG.bloqueioMs;
    sessao.avisouBloqueio = true;
    await enviar(
      `🔒 Muitas tentativas com CPF não cadastrado. Por segurança, a consulta foi ` +
        `bloqueada por ${minutos(CONFIG.bloqueioMs)} minutos.\n\n` +
        `Se precisar de ajuda, procure o atendimento da ${CONFIG.nomeUsina}.`
    );
    return;
  }

  const restantes = CONFIG.maxTentativasCPF - sessao.tentativas;
  await enviar(
    `❗ CPF não encontrado em nosso cadastro. Confira o número e tente de novo ` +
      `(${restantes} tentativa${restantes > 1 ? 's' : ''} restante${restantes > 1 ? 's' : ''}).\n\n` +
      `Se o problema continuar, digite *atendente*.`
  );
}

async function processarMensagem(sock, id, textoRecebido, telefone = null) {
  const agora = Date.now();
  const sessao = getSessao(id);
  if (telefone) sessao.telefone = telefone;

  const texto = textoRecebido.trim().toLowerCase();
  const enviar = (msg) => sock.sendMessage(id, { text: msg });

  // --- Bloqueado por excesso de tentativas: avisa uma vez e fica quieto ---
  if (sessao.bloqueadoAte > agora) {
    if (!sessao.avisouBloqueio) {
      sessao.avisouBloqueio = true;
      const resta = Math.max(1, minutos(sessao.bloqueadoAte - agora));
      await enviar(`🔒 Consulta bloqueada temporariamente. Tente novamente em ${resta} min.`);
    }
    return;
  }
  sessao.avisouBloqueio = false;

  // --- Em atendimento humano: o bot fica em silêncio ---
  if (sessao.etapa === 'atendente') {
    const pausaAtiva = agora < sessao.atendenteAte;
    if (pausaAtiva && texto !== 'menu') {
      sessao.ultimaAtividade = agora;
      return;
    }
    sessao.atendenteAte = 0;
    sessao.etapa = sessao.cpf ? 'menu' : 'inicio';
    // (se a sessão expirou, a verificação abaixo pede o CPF de novo)
  }

  // --- Sessão expirada por inatividade: pede o CPF de novo ---
  if (sessao.cpf && agora - sessao.ultimaAtividade > CONFIG.sessaoExpiraMs) {
    sessao.cpf = null;
    sessao.etapa = 'aguardando_cpf';
    sessao.ultimaAtividade = agora;
    await enviar(
      '⏱️ Sua sessão expirou por inatividade. Por segurança, digite seu *CPF* novamente.'
    );
    return;
  }
  sessao.ultimaAtividade = agora;

  // --- Comandos que valem em qualquer etapa ---
  if (texto === 'sair') {
    encerrarSessao(sessao);
    await enviar('👋 Consulta encerrada. Quando precisar, é só mandar uma mensagem.');
    return;
  }

  if (texto === 'atendente') {
    await encaminharAtendente(sock, sessao, enviar);
    return;
  }

  // --- Etapa 0: primeira mensagem ---
  if (sessao.etapa === 'inicio') {
    sessao.etapa = 'aguardando_cpf';
    await enviar(montarBoasVindas());
    return;
  }

  // --- Etapa 1: aguardando CPF ---
  if (sessao.etapa === 'aguardando_cpf') {
    if (texto === 'menu') {
      await enviar('Para ver o menu, primeiro digite o número do seu *CPF*.');
      return;
    }

    const cpf = limparCPF(texto);
    if (cpf.length !== 11) {
      await enviar('❗ Digite apenas os números do seu CPF (11 dígitos).');
      return;
    }
    if (!validarCPF(cpf)) {
      await enviar('❗ Esse CPF não é válido. Confira os números e digite de novo.');
      return;
    }

    const fornecedor = buscarFornecedor(cpf);
    if (!fornecedor) {
      console.log(`🔎 CPF não encontrado: ${mascararCPF(cpf)}`);
      await registrarCPFNaoEncontrado(sessao, enviar);
      return;
    }

    sessao.tentativas = 0;
    sessao.cpf = cpf;
    sessao.etapa = 'menu';
    console.log(`✅ Fornecedor identificado: ${fornecedor.nome} (${mascararCPF(cpf)})`);
    await enviar(montarMenu(fornecedor.nome));
    return;
  }

  // --- Etapa 2: menu ---
  if (sessao.etapa === 'menu') {
    const fornecedor = buscarFornecedor(sessao.cpf);
    if (!fornecedor) {
      // Fornecedor saiu da base durante a conversa
      sessao.cpf = null;
      sessao.etapa = 'aguardando_cpf';
      await enviar('❗ Não encontrei mais seu cadastro. Digite seu *CPF* novamente.');
      return;
    }

    switch (texto) {
      case '1':
        await enviar(montarUltimaEntrega(fornecedor));
        await enviar(RODAPE);
        break;
      case '2':
        await enviar(montarAcumuladoSafra(fornecedor));
        await enviar(RODAPE);
        break;
      case '3':
        await encaminharAtendente(sock, sessao, enviar);
        break;
      case 'menu':
        await enviar(montarMenu(fornecedor.nome));
        break;
      default:
        await enviar('Não entendi. Digite *1*, *2* ou *3* — ou *menu* para ver as opções.');
    }
  }
}

// =====================================================================
// Conexão com o WhatsApp
// =====================================================================
function extrairTexto(msg) {
  const conteudo = normalizeMessageContent(msg.message);
  if (!conteudo) return '';
  return conteudo.conversation || conteudo.extendedTextMessage?.text || '';
}

// Número de telefone (para o link wa.me do atendente). Com LID, ele vem em remoteJidAlt.
function extrairTelefone(key) {
  const jid = [key.remoteJid, key.remoteJidAlt].find((j) => j?.endsWith('@s.whatsapp.net'));
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

let reconexaoAgendada = null;

function agendarReconexao(ms) {
  if (reconexaoAgendada) return; // evita abrir duas conexões ao mesmo tempo
  reconexaoAgendada = setTimeout(() => {
    reconexaoAgendada = null;
    iniciarBot().catch((erro) => {
      console.error('❌ Falha ao iniciar o bot:', erro.message);
      agendarReconexao(10000);
    });
  }, ms);
}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: CONFIG.logLevel }),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrCodeAtual = await QRCode.toDataURL(qr);
        statusConexao = 'aguardando';
        console.log('📱 Novo QR Code gerado — abra o painel para escanear.');
      } catch (erro) {
        console.error('Erro ao gerar a imagem do QR Code:', erro.message);
      }
    }

    if (connection === 'open') {
      statusConexao = 'conectado';
      qrCodeAtual = null;
      console.log('✅ Bot conectado ao WhatsApp!');
      return;
    }

    if (connection === 'close') {
      qrCodeAtual = null;
      const codigo = lastDisconnect?.error?.output?.statusCode;

      if (codigo === DisconnectReason.loggedOut) {
        // Sessão encerrada no celular: apaga a sessão antiga e gera um QR novo
        statusConexao = 'deslogado';
        console.log('🚪 Sessão encerrada no celular. Apagando a sessão e gerando um novo QR Code...');
        fs.rmSync(PASTA_AUTH, { recursive: true, force: true });
        agendarReconexao(2000);
        return;
      }

      statusConexao = 'desconectado';
      const espera = codigo === DisconnectReason.restartRequired ? 500 : 3000;
      console.log(`🔌 Conexão fechada (código ${codigo ?? 'desconhecido'}). Reconectando...`);
      agendarReconexao(espera);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = mensagens novas. Ignora histórico/sincronização ('append').
    if (type !== 'notify') return;

    for (const msg of messages) {
      const id = msg.key?.remoteJid;
      if (!id || !msg.message || msg.key.fromMe) continue;
      if (JIDS_IGNORADOS.some((sufixo) => id.endsWith(sufixo))) continue;

      const texto = extrairTexto(msg);
      if (!texto) continue;

      try {
        await processarMensagem(sock, id, texto, extrairTelefone(msg.key));
      } catch (erro) {
        console.error('Erro ao processar mensagem:', erro);
        try {
          await sock.sendMessage(id, {
            text: '⚠️ Ocorreu um erro. Tente novamente em instantes.',
          });
        } catch {
          /* sem conexão: nada a fazer */
        }
      }
    }
  });
}

// Não deixa o processo cair por um erro inesperado
process.on('unhandledRejection', (erro) => {
  console.error('⚠️ Erro não tratado:', erro);
});

// =====================================================================
// Inicialização
// =====================================================================
if (require.main === module) {
  iniciarServidor();
  agendarReconexao(0);
}

// Exportado para testes (teste.js)
module.exports = {
  processarMensagem,
  validarCPF,
  paraNumero,
  buscarFornecedor,
  montarAcumuladoSafra,
  sessoes,
  CONFIG,
};