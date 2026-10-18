// Regras de aplicação no navegador: carrega do brasker-dados, calcula com o motor e grava pelas
// funções do banco. Rascunho é sempre recalculado; aprovado e finalizado ficam congelados no banco.
(function () {
const { rpc } = globalThis.BraskerApi;
const E = globalThis.BraskerEngine;
const P = globalThis.BraskerParsers;
const { METRICAS } = globalThis.BraskerCatalog;

const brl = (v) => (v == null ? '-' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const LOTE_MEDICOES = 1500;

// ---------- conversão banco <-> motor ----------
function deDb(c) {
  return { id: c.id, nome: c.nome, cnpj: c.cnpj, status: c.status, plano: c.plano, processo: c.processo, indice: c.indice,
    tributacao: c.tributacao, dataInicio: c.data_inicio, dataFim: c.data_fim, tipoAdicionalFuncionario: c.tipo_adicional_funcionario,
    ultimoValorCobrado: c.ultimo_valor_cobrado == null ? null : Number(c.ultimo_valor_cobrado), versoes: c.versoes || [], descontos: c.descontos || [] };
}
function paraDb(c) {
  return { id: String(c.id), nome: c.nome, nome_norm: P.normalizarNome(c.nome), cnpj: P.normalizarCnpj(c.cnpj), status: c.status || 'Ativo',
    plano: c.plano || null, processo: c.processo || null, indice: c.indice || null, tributacao: c.tributacao || null,
    data_inicio: c.dataInicio || null, data_fim: c.dataFim || null, tipo_adicional_funcionario: c.tipoAdicionalFuncionario || 'lote',
    ultimo_valor_cobrado: c.ultimoValorCobrado ?? null, versoes: c.versoes, descontos: c.descontos || [] };
}
function cfgMotor(cfg) {
  return { defasagemMeses: cfg.defasagem_meses ?? 2, tetoAumentoPct: cfg.teto_aumento_pct == null ? null : Number(cfg.teto_aumento_pct),
    minMesesDefasagem: cfg.min_meses_defasagem ?? 3 };
}

// ---------- carga da competência ----------
const estado = { contratos: {}, config: {}, indices: {}, meds: {}, aps: {}, comp: null };

async function carregarBase() {
  const d = await rpc('contratos_carregar');
  estado.contratos = Object.fromEntries((d.contratos || []).map((c) => [c.id, deDb(c)]));
  estado.config = d.config || {};
  estado.indices = d.indices || {};
  return estado;
}

async function carregarCompetencia(comp) {
  await carregarBase();
  const cfg = cfgMotor(estado.config);
  const meses = Math.max(6, cfg.minMesesDefasagem);
  const primeiro = E.addMeses(comp, -(meses - 1));
  const [meds, aps] = await Promise.all([
    rpc('contratos_medicoes', { p_de: E.addMeses(primeiro, -cfg.defasagemMeses), p_ate: E.addMeses(comp, -cfg.defasagemMeses) }),
    rpc('contratos_apuracoes', { p_de: primeiro, p_ate: comp }),
  ]);
  estado.meds = {};
  for (const m of meds || []) {
    const k = `${m.cnpj}|${m.competencia}`;
    (estado.meds[k] ||= {})[m.metrica] = { valor: Number(m.valor), fonte: m.fonte, evidencia: m.evidencia };
  }
  estado.aps = Object.fromEntries((aps || []).map((a) => [`${a.contrato_id}|${a.competencia}`, a]));
  estado.comp = comp;
}

function calcular(contrato, comp) {
  const cfg = cfgMotor(estado.config);
  const compMed = E.addMeses(comp, -cfg.defasagemMeses);
  const medicoes = contrato.cnpj ? estado.meds[`${contrato.cnpj}|${compMed}`] || {} : {};
  return E.apurar({ contrato, medicoes, competenciaFaturamento: comp, tabelaPrecos: estado.config.tabela_precos || {}, config: cfg });
}

function apuracao(contratoId, comp) {
  const c = estado.contratos[contratoId];
  const salvo = estado.aps[`${contratoId}|${comp}`];
  if (salvo && salvo.status !== 'rascunho') {
    return { status: salvo.status, competencia: comp, resultado: salvo.resultado, valorFinal: salvo.valor_final == null ? null : Number(salvo.valor_final),
      observacao: salvo.observacao || '', historico: salvo.historico || [] };
  }
  return { status: 'rascunho', competencia: comp, resultado: calcular(c, comp),
    valorFinal: salvo && salvo.valor_final != null ? Number(salvo.valor_final) : null,
    observacao: salvo ? salvo.observacao || '' : '', historico: salvo ? salvo.historico || [] : [] };
}

const valorCobrado = (a) => (a.valorFinal != null ? a.valorFinal : a.resultado.total);

function historico(contratoId, comp, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(apuracao(contratoId, E.addMeses(comp, -i)).resultado);
  return out;
}

// ---------- painel e detalhe ----------
async function painel(comp) {
  await carregarCompetencia(comp);
  const cfg = cfgMotor(estado.config);
  const tot = { contratosAtivos: 0, semParametrizacao: 0, semCnpj: 0, adicionaisCalculados: 0, receitaNaoAprovada: 0, retidosTeto: 0,
    porStatus: { rascunho: 0, aprovado: 0, finalizado: 0 }, defasados: 0, reajustesPendentes: 0, alertasDados: 0 };
  const linhas = [];
  for (const c of Object.values(estado.contratos)) {
    if (c.status !== 'Ativo') continue;
    tot.contratosAtivos++;
    const v = E.versaoVigente(c, comp);
    const parametrizado = !!v && Object.keys(v.franquias || {}).length > 0;
    if (!parametrizado) tot.semParametrizacao++;
    if (!c.cnpj) tot.semCnpj++;
    const a = apuracao(c.id, comp);
    const r = a.resultado;
    tot.porStatus[a.status]++;
    tot.adicionaisCalculados += r.adicionais;
    tot.retidosTeto += r.adicionaisRetidos || 0;
    if (a.status === 'rascunho') tot.receitaNaoAprovada += r.adicionais;
    const alertasDados = r.alertas.filter((x) => ['dado_ausente', 'sem_franquia', 'sem_preco'].includes(x.tipo)).length;
    tot.alertasDados += alertasDados;
    const reajuste = E.propostaReajuste(c, comp, estado.indices);
    if (reajuste) tot.reajustesPendentes++;
    const defas = parametrizado ? E.analisarDefasagem(historico(c.id, comp, cfg.minMesesDefasagem), cfg.minMesesDefasagem) : null;
    if (defas) tot.defasados++;
    linhas.push({ id: c.id, nome: c.nome, cnpj: c.cnpj, plano: c.plano, processo: c.processo, parametrizado, status: a.status,
      valorBase: r.valorBase, adicionais: r.adicionais, descontos: r.descontos, total: r.total, valorFinal: a.valorFinal,
      ultimoValorCobrado: c.ultimoValorCobrado, variacao: c.ultimoValorCobrado ? E.round2(valorCobrado(a) - c.ultimoValorCobrado) : null,
      excedentes: r.linhas.filter((l) => l.status === 'excedente').map((l) => l.rotulo),
      alertas: r.alertas.length, alertasDados, reajuste: !!reajuste, defasado: !!defas });
  }
  for (const k of ['adicionaisCalculados', 'receitaNaoAprovada', 'retidosTeto']) tot[k] = E.round2(tot[k]);
  linhas.sort((a, b) => b.adicionais - a.adicionais || a.nome.localeCompare(b.nome));
  const pend = await rpc('contratos_pendencias');
  return { competencia: comp, competenciaMedicao: E.addMeses(comp, -cfg.defasagemMeses), totais: tot, linhas, pendentesMapeamento: (pend || []).length };
}

async function detalhe(contratoId, comp) {
  if (estado.comp !== comp) await carregarCompetencia(comp);
  const c = estado.contratos[contratoId];
  const n = cfgMotor(estado.config).minMesesDefasagem;
  return { contrato: c, apuracao: apuracao(contratoId, comp), reajuste: E.propostaReajuste(c, comp, estado.indices),
    defasagem: E.analisarDefasagem(historico(contratoId, comp, n), n),
    historico: historico(contratoId, comp, 6).map((r) => ({ comp: r.competenciaFaturamento, total: r.total, adicionais: r.adicionais })) };
}

async function acao(contratoId, comp, { acao: tipo, valorFinal, observacao }) {
  const a = apuracao(contratoId, comp);
  const vf = valorFinal === '' || valorFinal == null ? null : Number(valorFinal);
  const salvo = await rpc('contratos_acao_apuracao', {
    p_contrato: contratoId, p_competencia: comp, p_acao: tipo,
    p_resultado: a.status === 'rascunho' ? a.resultado : null,
    p_valor_final: tipo === 'ajustar' ? vf : null, p_observacao: tipo === 'ajustar' ? observacao ?? null : null,
  });
  estado.aps[`${contratoId}|${comp}`] = salvo;
  if (tipo === 'finalizar') await carregarCompetencia(comp);
  return salvo;
}

async function aplicarReajuste(contratoId, comp) {
  const c = estado.contratos[contratoId];
  const p = E.propostaReajuste(c, comp, estado.indices);
  if (!p) throw new Error('Sem reajuste pendente nesta competência');
  if (p.mesesFaltando.length) throw new Error(`Índice ${p.indice} sem valor em: ${p.mesesFaltando.join(', ')}`);
  const atual = E.versaoVigente(c, comp);
  const novo = { ...c, versoes: [...c.versoes, { ...JSON.parse(JSON.stringify(atual)), vigenciaInicio: comp, valorBase: p.novoValorBase,
    origem: `Reajuste ${p.indice} ${p.percentual}% aplicado em ${new Date().toISOString().slice(0, 10)}` }] };
  await salvarContrato(novo);
  await carregarCompetencia(comp);
}

function comunicado(contratoId, comp) {
  const c = estado.contratos[contratoId];
  const a = apuracao(contratoId, comp);
  const r = a.resultado;
  const reajuste = E.propostaReajuste(c, comp, estado.indices);
  const exc = r.linhas.filter((l) => l.status === 'excedente');
  const partes = [`Assunto: Brasker – composição da mensalidade de ${comp}`, '', `Olá, ${c.nome}.`, '',
    `Informamos a composição da sua assinatura para a competência ${comp}, com base no volume apurado em ${r.competenciaMedicao}:`, '',
    `Valor base do contrato: ${brl(r.valorBase)}`];
  if (exc.length) {
    partes.push('', 'Adicionais por volume acima da franquia contratada:',
      ...exc.map((l) => `• ${l.rotulo}: contratado ${l.contratado}, apurado ${l.medido} em ${r.competenciaMedicao} → ${l.excedente} ${l.lote > 1 ? `lote(s) de ${l.lote}` : 'unidade(s)'} × ${brl(l.precoUnit)} = ${brl(l.valor)}`),
      `Total de adicionais: ${brl(r.adicionais)}`);
  } else partes.push('', 'Neste mês o volume ficou dentro da franquia contratada; não há adicionais.');
  if (r.descontos) partes.push(`Descontos: -${brl(r.descontos)}`);
  partes.push('', `Valor da mensalidade: ${brl(valorCobrado(a))}`);
  if (reajuste && !reajuste.mesesFaltando.length) partes.push('', `Reajuste anual previsto em contrato (${reajuste.indice} acumulado 12 meses: ${reajuste.percentual}%): nova base ${brl(reajuste.novoValorBase)}.`);
  partes.push('', 'O detalhamento das quantidades (notas, funcionários e transações) está disponível mediante solicitação.', '', 'Atenciosamente,', 'Equipe Brasker');
  return partes.join('\n');
}

// ---------- contratos ----------
async function contratos() { await carregarBase(); return Object.values(estado.contratos).sort((a, b) => a.nome.localeCompare(b.nome)); }
async function salvarContrato(c) {
  if (!c.nome || !Array.isArray(c.versoes) || !c.versoes.length) throw new Error('Contrato precisa de nome e ao menos uma versão');
  const salvo = await rpc('contratos_salvar_contrato', { p: paraDb(c) });
  estado.contratos[salvo.id] = deDb(salvo);
  return estado.contratos[salvo.id];
}

// ---------- importação (o arquivo é lido no navegador; só as contagens vão para o banco) ----------
function lerAba(buf, prefixo) {
  const X = globalThis.XLSX;
  const nomes = X.read(buf, { type: 'array', bookSheets: true }).SheetNames;
  const nome = (prefixo && nomes.find((n) => n.startsWith(prefixo))) || nomes[0];
  const wb = X.read(buf, { type: 'array', sheets: [nome], cellDates: false });
  const ws = wb.Sheets[nome];
  if (!ws || !ws['!ref']) return { nome, linhas: [] };
  const faixa = X.utils.decode_range(ws['!ref']);
  faixa.s.r = 0; faixa.s.c = 0; // mantém linha 1 / coluna A como na planilha
  ws['!ref'] = X.utils.encode_range(faixa);
  const linhas = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true }).map((r) => [null, ...r]);
  return { nome, linhas };
}

async function importar(arquivo, tipo, competencia, progresso = () => {}) {
  progresso('Lendo o arquivo no seu computador…');
  const buf = new Uint8Array(await arquivo.arrayBuffer());
  if (tipo === 'contratos') {
    const { linhas } = lerAba(buf, 'CadastrosSaldos');
    const lista = P.parseContratosPlanilha(linhas).map(paraDb);
    let gravados = 0;
    for (let i = 0; i < lista.length; i += 40) {
      progresso(`Gravando contratos ${i + 1}–${Math.min(i + 40, lista.length)} de ${lista.length}…`);
      gravados += await rpc('contratos_carga_inicial', { p_lista: lista.slice(i, i + 40), p_sobrescrever: false });
    }
    return { tipo, lidos: lista.length, gravados };
  }
  const parser = P.PARSERS[tipo];
  if (!parser) throw new Error('Tipo de importação inválido');
  const { nome, linhas } = lerAba(buf, parser.aba);
  const res = parser.fn(linhas, competencia || null);
  if (!res.medicoes.length) throw new Error(`Nenhuma medição encontrada na aba "${nome}". Confira o tipo de relatório escolhido.`);
  const meds = res.medicoes.map((m) => ({ ...m, nomeNorm: P.normalizarNome(m.nome) }));
  const id = await rpc('contratos_iniciar_importacao', { p_tipo: tipo, p_arquivo: arquivo.name, p_avisos: res.avisos || [] });
  for (let i = 0; i < meds.length; i += LOTE_MEDICOES) {
    progresso(`Enviando medições ${i + 1}–${Math.min(i + LOTE_MEDICOES, meds.length)} de ${meds.length}…`);
    await rpc('contratos_adicionar_medicoes', { p_importacao: id, p_medicoes: meds.slice(i, i + LOTE_MEDICOES),
      p_mapeamentos: i === 0 ? res.mapeamentos || [] : [] });
  }
  return rpc('contratos_concluir_importacao', { p_importacao: id });
}

const importacoes = () => rpc('contratos_importacoes');
const pendencias = () => rpc('contratos_pendencias');
const mapear = (nomeNorm, cnpj) => rpc('contratos_mapear_nome', { p_nome_norm: nomeNorm, p_cnpj: P.normalizarCnpj(cnpj) });

// ---------- índices, regras e equipe ----------
async function indices() { await carregarBase(); return estado.indices; }
async function salvarIndices(i) { await rpc('contratos_salvar_indices', { p: i }); estado.indices = i; }
async function config() { await carregarBase(); return estado.config; }
async function salvarConfig(c) { estado.config = await rpc('contratos_salvar_config', { p: c }); return estado.config; }
const equipe = () => rpc('contratos_equipe');
const liberar = (usuarioId, papel) => rpc('contratos_liberar_acesso', { p_usuario: usuarioId, p_papel: papel });
const tirar = (usuarioId) => rpc('contratos_tirar_acesso', { p_usuario: usuarioId });
const meuAcesso = () => rpc('contratos_meu_acesso');

globalThis.BraskerServico = { painel, detalhe, acao, aplicarReajuste, comunicado, contratos, salvarContrato, importar, importacoes,
  pendencias, mapear, indices, salvarIndices, config, salvarConfig, equipe, liberar, tirar, meuAcesso, METRICAS };
})();
