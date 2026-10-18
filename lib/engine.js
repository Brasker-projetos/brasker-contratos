// Motor de apuração: contrato versionado + medições -> pré-fatura da competência.
// Ordem de cálculo: franquia/lotes -> piso -> teto -> descontos. Reajuste por índice
// é uma proposta separada que, aprovada, cria nova versão do contrato com vigência.
(function () {
const { METRICAS, PROCESSOS, familiaPreco, regraCobranca } =
  typeof module !== 'undefined' ? require('./catalog') : globalThis.BraskerCatalog;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function addMeses(competencia, n) {
  const [a, m] = competencia.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Planilha: aba "Ago25 - Comp_Jun25" usa data de referência - 60 dias => competência = mês de faturamento - 2.
function competenciaMedicao(competenciaFaturamento, defasagemMeses = 2) {
  return addMeses(competenciaFaturamento, -defasagemMeses);
}

function versaoVigente(contrato, competencia) {
  const vs = (contrato.versoes || [])
    .filter((v) => v.vigenciaInicio <= competencia)
    .sort((a, b) => a.vigenciaInicio.localeCompare(b.vigenciaInicio));
  return vs[vs.length - 1] || null;
}

function lotes(qtd, tamanhoLote) {
  if (tamanhoLote <= 1) return qtd;
  // Planilha: if(ROUNDUP(q/lote)=0, 1, ROUNDUP(q/lote)) -> no mínimo 1 lote.
  return Math.max(1, Math.ceil(qtd / tamanhoLote));
}

function precoDe(chave, contrato, versao, tabela) {
  if (!chave) return { preco: null, origem: null };
  const negociado = versao.precos && versao.precos[chave];
  if (negociado != null && negociado !== '') return { preco: Number(negociado), origem: 'contrato' };
  const fam = familiaPreco(contrato.plano);
  const proc = contrato.processo === PROCESSOS.AUTO ? 'auto' : 'manual';
  const linha = (tabela || {})[chave];
  const p = linha && fam && linha[fam] ? linha[fam][proc] : null;
  return { preco: p == null ? null : Number(p), origem: p == null ? null : 'tabela' };
}

function descontoVigente(contrato, competencia) {
  return (contrato.descontos || []).filter(
    (d) => d.inicio <= competencia && (!d.fim || d.fim >= competencia),
  );
}

/**
 * @param {object} p
 * @param {object} p.contrato
 * @param {Object<string,{valor:number,fonte:string,evidencia?:string}>} p.medicoes por métrica
 * @param {string} p.competenciaFaturamento 'YYYY-MM'
 * @param {object} [p.tabelaPrecos]
 * @param {object} [p.config] { defasagemMeses, tetoAumentoPct }
 */
function apurar({ contrato, medicoes = {}, competenciaFaturamento, tabelaPrecos, config = {} }) {
  const compMed = competenciaMedicao(competenciaFaturamento, config.defasagemMeses ?? 2);
  const versao = versaoVigente(contrato, competenciaFaturamento);
  const alertas = [];
  if (!versao) {
    return { competenciaFaturamento, competenciaMedicao: compMed, linhas: [], valorBase: 0, adicionais: 0, descontos: 0, total: 0,
      alertas: [{ tipo: 'sem_versao', msg: 'Contrato sem versão vigente nesta competência' }] };
  }
  if (!contrato.processo) {
    alertas.push({ tipo: 'premissa', msg: 'Processo de recebimentos não informado: assumido "Recebimentos Manuais"' });
  }

  const linhas = [];
  for (const [metrica, meta] of Object.entries(METRICAS)) {
    const regra = regraCobranca(metrica, contrato);
    const franquia = versao.franquias ? versao.franquias[metrica] : undefined;
    const med = medicoes[metrica];
    const linha = {
      metrica, rotulo: meta.rotulo, cobrada: meta.cobrada,
      contratado: franquia ?? null, medido: med ? med.valor : null,
      fonte: med ? med.fonte : null, evidencia: med ? med.evidencia || null : null,
      lote: regra ? regra.lote : null, lotesContratados: null, lotesMedidos: null,
      excedente: 0, precoUnit: null, origemPreco: null, valor: 0, status: 'ok',
      premissa: regra && regra.premissa ? regra.premissa : null,
    };
    linhas.push(linha);

    if (!regra) { linha.status = 'nao_aplicavel'; continue; }
    if (med == null) { linha.status = 'ausente'; if (meta.cobrada && franquia != null) alertas.push({ tipo: 'dado_ausente', metrica, msg: `Sem medição de ${meta.rotulo} em ${compMed}` }); continue; }
    if (!meta.cobrada) {
      linha.status = 'monitorada';
      if (franquia != null) {
        linha.lotesContratados = lotes(franquia, regra.lote);
        linha.lotesMedidos = lotes(med.valor, regra.lote);
        if (linha.lotesMedidos > linha.lotesContratados) linha.status = 'acima_monitorada';
      }
      continue;
    }
    if (franquia == null) {
      linha.status = 'sem_franquia';
      if (med.valor > 0) alertas.push({ tipo: 'sem_franquia', metrica, msg: `${meta.rotulo}: medido ${med.valor}, mas o contrato não tem franquia cadastrada` });
      continue;
    }

    linha.lotesContratados = lotes(franquia, regra.lote);
    linha.lotesMedidos = lotes(med.valor, regra.lote);
    const exc = linha.lotesMedidos - linha.lotesContratados;
    if (exc <= 0) { linha.status = exc < 0 ? 'abaixo' : 'ok'; continue; } // piso: nunca reduz

    const { preco, origem } = precoDe(regra.precoChave, contrato, versao, tabelaPrecos);
    linha.excedente = exc;
    linha.precoUnit = preco;
    linha.origemPreco = origem;
    if (preco == null) {
      linha.status = 'sem_preco';
      alertas.push({ tipo: 'sem_preco', metrica, msg: `${meta.rotulo}: ${exc} excedente(s), mas não há preço para o plano/processo` });
      continue;
    }
    linha.valor = round2(exc * preco);
    linha.status = 'excedente';
  }

  const valorBase = round2(Number(versao.valorBase) || 0);
  let adicionais = round2(linhas.reduce((s, l) => s + l.valor, 0));
  let adicionaisRetidos = 0;
  if (config.tetoAumentoPct != null && valorBase > 0) {
    const teto = round2(valorBase * config.tetoAumentoPct / 100);
    if (adicionais > teto) {
      adicionaisRetidos = round2(adicionais - teto);
      adicionais = teto;
      alertas.push({ tipo: 'teto', msg: `Adicionais limitados a ${config.tetoAumentoPct}% da base; R$ ${adicionaisRetidos.toFixed(2)} vão para aditivo` });
    }
  }

  const subtotal = round2(valorBase + adicionais);
  let descontos = 0;
  const descontosAplicados = [];
  for (const d of descontoVigente(contrato, competenciaFaturamento)) {
    const v = d.tipo === 'pct' ? round2(subtotal * d.valor / 100) : round2(Number(d.valor));
    descontos = round2(descontos + v);
    descontosAplicados.push({ ...d, valorAplicado: v });
  }
  const total = round2(Math.max(0, subtotal - descontos));

  return {
    competenciaFaturamento, competenciaMedicao: compMed, versaoVigencia: versao.vigenciaInicio,
    linhas, valorBase, adicionais, adicionaisRetidos, descontos, descontosAplicados, total, alertas,
  };
}

// Reajuste anual: no mês de aniversário, propõe base * produto(1 + índice mensal) dos 12 meses anteriores.
function propostaReajuste(contrato, competenciaFaturamento, indices) {
  if (!contrato.dataInicio || !contrato.indice) return null;
  const [anoIni, mesIni] = contrato.dataInicio.slice(0, 7).split('-').map(Number);
  const [ano, mes] = competenciaFaturamento.split('-').map(Number);
  if (mes !== mesIni || ano <= anoIni) return null;
  const versao = versaoVigente(contrato, competenciaFaturamento);
  if (!versao || versao.vigenciaInicio === competenciaFaturamento) return null; // já reajustado
  const serie = (indices || {})[contrato.indice] || {};
  let fator = 1;
  const faltando = [];
  for (let i = 12; i >= 1; i--) {
    const c = addMeses(competenciaFaturamento, -i);
    if (serie[c] == null) faltando.push(c); else fator *= 1 + Number(serie[c]) / 100;
  }
  return {
    indice: contrato.indice, fator: Math.round(fator * 1e6) / 1e6,
    percentual: round2((fator - 1) * 100), valorAtual: Number(versao.valorBase),
    novoValorBase: round2(Number(versao.valorBase) * fator), mesesFaltando: faltando,
  };
}

// Cliente defasado: excedente cobrável em N competências seguidas -> sugere aditivo com nova franquia.
function analisarDefasagem(apuracoesOrdenadas, minMeses = 3) {
  const ultimas = apuracoesOrdenadas.slice(-minMeses);
  if (ultimas.length < minMeses) return null;
  const sugestao = {};
  for (const m of Object.keys(METRICAS)) {
    const linhas = ultimas.map((a) => a.linhas.find((l) => l.metrica === m));
    if (linhas.every((l) => l && l.status === 'excedente')) {
      const maxLotes = Math.max(...linhas.map((l) => l.lotesMedidos));
      const lote = linhas[0].lote;
      sugestao[m] = { franquiaAtual: linhas[0].contratado, novaFranquia: lote > 1 ? maxLotes * lote : maxLotes,
        adicionalMedio: round2(linhas.reduce((s, l) => s + l.valor, 0) / linhas.length) };
    }
  }
  return Object.keys(sugestao).length ? { meses: minMeses, sugestao } : null;
}

const BraskerEngine = { apurar, propostaReajuste, analisarDefasagem, competenciaMedicao, versaoVigente, addMeses, lotes, round2 };
if (typeof module !== 'undefined') module.exports = BraskerEngine; else globalThis.BraskerEngine = BraskerEngine;})();
