/**
 * Teste do fluxo da URA sem precisar de WhatsApp de verdade.
 * Rode com:  node teste.js
 */
const assert = require('assert');
const { processarMensagem, validarCPF, paraNumero, sessoes, CONFIG } = require('./bot');

CONFIG.numeroAtendente = '5581900000000';

// WhatsApp falso: guarda o que o bot enviaria
const enviadas = [];
const sockFalso = {
  sendMessage: async (para, { text }) => enviadas.push({ para, text }),
};

const ID = '558190000001@s.whatsapp.net';

async function falar(texto, id = ID) {
  enviadas.length = 0;
  await processarMensagem(sockFalso, id, texto, id.split('@')[0]);
  return enviadas.map((m) => m.text).join('\n---\n');
}

let ok = 0;
async function teste(nome, fn) {
  await fn();
  ok++;
  console.log(`✔ ${nome}`);
}

(async () => {
  await teste('validação de CPF', () => {
    assert(validarCPF('52998224725'));
    assert(!validarCPF('12345678900'));
    assert(!validarCPF('11111111111'));
  });

  await teste('números vindos de planilha', () => {
    assert.strictEqual(paraNumero('55,0'), 55);
    assert.strictEqual(paraNumero('1.042,30'), 1042.3);
    assert.strictEqual(paraNumero('42.3'), 42.3);
    assert(Number.isNaN(paraNumero('abc')));
  });

  await teste('boas-vindas na primeira mensagem', async () => {
    assert.match(await falar('oi'), /Bem-vindo/);
  });

  await teste('texto que não é CPF não conta tentativa', async () => {
    assert.match(await falar('bom dia'), /11 dígitos/);
    assert.strictEqual(sessoes.get(ID).tentativas, 0);
  });

  await teste('CPF com dígito errado', async () => {
    assert.match(await falar('123.456.789-00'), /não é válido/);
  });

  await teste('menu com maiúscula antes do CPF', async () => {
    assert.match(await falar('MENU'), /primeiro digite/);
  });

  await teste('CPF com pontuação entra no menu', async () => {
    const r = await falar('529.982.247-25');
    assert.match(r, /João Silva/);
    assert.match(r, /3️⃣ Falar com um atendente/);
  });

  await teste('última entrega pega a data mais recente (JSON fora de ordem)', async () => {
    const r = await falar('1');
    assert.match(r, /05\/09\/2026/);
    assert.match(r, /42,300 t/);
  });

  await teste('acumulado com ATR ponderado', async () => {
    const r = await falar('2');
    assert.match(r, /80,400 t/);
    // (38,1*135,90 + 42,3*138,45) / 80,4 = 137,24
    assert.match(r, /137,24 kg\/t/);
  });

  await teste('opção inválida', async () => {
    assert.match(await falar('9'), /Não entendi/);
  });

  await teste('"Menu" com maiúscula funciona', async () => {
    assert.match(await falar('Menu'), /O que você deseja consultar/);
  });

  await teste('opção 3 avisa o atendente e pausa o bot', async () => {
    await falar('3');
    assert(enviadas.some((m) => m.para === '5581900000000@s.whatsapp.net' && /João Silva/.test(m.text)));
    assert.strictEqual(await falar('quero falar do pagamento'), ''); // bot calado
    assert.match(await falar('menu'), /O que você deseja consultar/); // volta
  });

  await teste('sair encerra a sessão', async () => {
    assert.match(await falar('sair'), /encerrada/);
    assert.match(await falar('oi'), /Bem-vindo/);
  });

  await teste('números vindos como texto ("55,0")', async () => {
    const id = '558190000002@s.whatsapp.net';
    await falar('oi', id);
    await falar('39053344705', id);
    assert.match(await falar('1', id), /55,000 t/);
  });

  await teste('fornecedor sem entregas não quebra', async () => {
    const id = '558190000003@s.whatsapp.net';
    await falar('oi', id);
    await falar('11144477735', id);
    assert.match(await falar('1', id), /Ainda não há entregas/);
    assert.match(await falar('2', id), /Ainda não há entregas/);
  });

  await teste('bloqueio após 3 CPFs não cadastrados', async () => {
    const id = '558190000004@s.whatsapp.net';
    await falar('oi', id);
    assert.match(await falar('85351346893', id), /2 tentativas restantes/);
    assert.match(await falar('85351346893', id), /1 tentativa restante/);
    assert.match(await falar('85351346893', id), /bloqueada por 15 minutos/);
    assert.strictEqual(await falar('52998224725', id), ''); // nem CPF certo passa
  });

  await teste('sessão expira por inatividade', async () => {
    const id = '558190000005@s.whatsapp.net';
    await falar('oi', id);
    await falar('52998224725', id);
    sessoes.get(id).ultimaAtividade -= CONFIG.sessaoExpiraMs + 1000;
    assert.match(await falar('1', id), /expirou/);
    assert.match(await falar('1', id), /11 dígitos/);
  });

  console.log(`\n✅ ${ok} testes passaram.`);
  process.exit(0);
})().catch((erro) => {
  console.error('\n❌ Teste falhou:', erro.message);
  process.exit(1);
});
