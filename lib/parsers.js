// Leitores dos relatórios do Domínio e do Bauner (roda no navegador e nos testes).
// Cada parser recebe linhas (arrays 1-indexados, como o exceljs entrega) e devolve medições
// por CNPJ/nome + competência. Formatos extraídos das abas "Colar ..." da planilha de análise.
(function () {
const { normalizarPlano, normalizarProcesso } =
  typeof module !== 'undefined' ? require('./catalog') : globalThis.BraskerCatalog;

const txt = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function normalizarCnpj(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11) return d; // CPF
  if (d.length >= 12 && d.length <= 14) return d.padStart(14, '0');
  return d; // fora do padrão: mantido para revisão manual
}

function normalizarNome(v) {
  return txt(v).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function competenciaDe(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}`;
  if (typeof v === 'number') { // serial do Excel
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return competenciaDe(d);
  }
  const s = String(v);
  let m = s.match(/(\d{2})\/(\d{4})\s*$/) || s.match(/(\d{2})\/(\d{4})/);
  if (m) return `${m[2]}-${m[1]}`;
  m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}`;
  m = s.match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function acharColunas(linha, mapa) {
  const out = {};
  linha.forEach((v, i) => {
    const t = normalizarNome(v);
    for (const [chave, padrao] of Object.entries(mapa)) if (out[chave] == null && padrao.test(t)) out[chave] = i;
  });
  return out;
}

// Domínio > Administrar > Relatórios > Movimentação de Empregados
function parseMovimentoFuncionarios(linhas, competenciaInformada) {
  let comp = competenciaInformada || null;
  let cols = null;
  const medicoes = [];
  const mapeamentos = [];
  for (const l of linhas) {
    const c0 = txt(l[1]);
    if (!competenciaInformada && /^Per[ií]odo/i.test(c0)) {
      const m = c0.match(/a\s+(\d{2}\/\d{4})/); comp = competenciaDe(m ? m[1] : c0);
    }
    if (!cols && l.some((v) => /^Saldo$/i.test(txt(v))) && l.some((v) => /^C[oó]digo$/i.test(txt(v)))) {
      cols = acharColunas(l, { codigo: /^CODIGO$/, nome: /^NOME DA EMPRESA/, cnpj: /^CNPJ/, saldo: /^SALDO$/ });
      continue;
    }
    if (!cols || num(l[cols.codigo]) == null) continue;
    const cnpj = normalizarCnpj(l[cols.cnpj]);
    const nome = txt(l[cols.nome]);
    const codigo = String(num(l[cols.codigo]));
    mapeamentos.push({ codigoDominio: codigo, nome, cnpj });
    medicoes.push({ cnpj, nome, codigoDominio: codigo, competencia: comp, metrica: 'funcionarios', valor: num(l[cols.saldo]) ?? 0,
      fonte: 'Domínio', evidencia: `Movimentação de Empregados ${comp}: cód. ${codigo}, saldo ${num(l[cols.saldo]) ?? 0}` });
  }
  return { medicoes, mapeamentos, avisos: comp ? [] : ['Competência não identificada no relatório'] };
}

// Domínio > Relatório Origem de Notas Lançadas (blocos por empresa, identificados só pelo nome)
function parseOrigemNotas(linhas, competenciaInformada) {
  let comp = competenciaInformada || null;
  let cols = null;
  let empresa = null;
  const medicoes = [];
  for (const l of linhas) {
    const c0 = txt(l[1]);
    if (/^Per[ií]odo/i.test(c0) && !competenciaInformada) comp = competenciaDe(txt(l[2])) || comp;
    if (/^Origem$/i.test(c0)) { cols = acharColunas(l, { entradas: /^ENTRADAS$/, saidas: /^SAIDAS$/, servicos: /^SERVICOS$/ }); continue; }
    if (/^Empresa:?$/i.test(c0)) {
      const ehCabecalhoPagina = l.some((v) => /^P[aá]gina/i.test(txt(v)));
      if (!ehCabecalhoPagina) empresa = txt(l[3]) || txt(l[2]);
      continue;
    }
    if (/^Total:?$/i.test(c0) && empresa && cols) {
      const ev = `Origem de Notas ${comp}: ${empresa}`;
      for (const [chave, metrica] of [['entradas', 'nf_entradas'], ['saidas', 'nf_saidas'], ['servicos', 'recebimentos']]) {
        medicoes.push({ cnpj: null, nome: empresa, competencia: comp, metrica, valor: num(l[cols[chave]]) ?? 0, fonte: 'Domínio', evidencia: `${ev} (${chave})` });
      }
      empresa = null;
    }
  }
  return { medicoes, mapeamentos: [], avisos: comp ? [] : ['Competência não identificada no relatório'] };
}

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

// Domínio > Quantidade de lançamentos contábeis (grade anual por empresa)
function parseLancamentos(linhas) {
  let ano = null;
  let empresa = null;
  let cabecalho = null;
  const medicoes = [];
  for (const l of linhas) {
    const c0 = txt(l[1]);
    if (/^Ano:?$/i.test(c0)) { ano = num(l[2]); continue; }
    if (/^Empresa:?$/i.test(c0)) {
      const codigo = l.slice(2).find((v) => num(v) != null);
      const nome = l.slice(2).find((v) => v != null && num(v) == null);
      empresa = { codigo: codigo != null ? String(num(codigo)) : null, nome: txt(nome) };
      cabecalho = null; continue;
    }
    if (empresa && !cabecalho && normalizarNome(c0) === 'JANEIRO') {
      cabecalho = [];
      l.forEach((v, i) => { const k = MESES.indexOf(normalizarNome(v)); if (k >= 0) cabecalho.push({ col: i, mes: k + 1 }); });
      continue;
    }
    if (empresa && cabecalho && l.some((v) => num(v) != null)) {
      l.forEach((v, i) => {
        if (num(v) == null) return;
        const h = cabecalho.filter((x) => x.col <= i).pop();
        if (!h || !ano) return;
        const comp = `${ano}-${String(h.mes).padStart(2, '0')}`;
        medicoes.push({ cnpj: null, nome: empresa.nome, codigoDominio: empresa.codigo, competencia: comp, metrica: 'lancamentos', valor: num(v), fonte: 'Domínio', evidencia: `Lançamentos ${comp}: cód. ${empresa.codigo}` });
      });
      empresa = null; cabecalho = null;
    }
  }
  return { medicoes, mapeamentos: [], avisos: ano ? [] : ['Ano não identificado'] };
}

// Bauner (BPO financeiro): Empresa | CNPJ | Qt. Contas Correntes | Qt. Cartão | Qt. Gateway | Qt. Recebimentos | Qt. Pagamentos | Total | Data
function parseBauner(linhas, competenciaInformada) {
  let cols = null;
  const medicoes = [];
  const avisos = [];
  const mapa = { contas_bancarias: 'contas', cartoes: 'cartoes', gateways: 'gateways', recebimentos: 'receb', pagamentos: 'pag', transacoes: 'total' };
  for (const l of linhas) {
    if (!cols) {
      if (l.some((v) => /CONTAS CORRENTES/.test(normalizarNome(v)))) {
        cols = acharColunas(l, { empresa: /^EMPRESA$/, cnpj: /^CNPJ/, contas: /CONTAS CORRENTES/, cartoes: /CARTAO/, gateways: /GATEWAY/, receb: /^QT RECEBIMENTOS/, pag: /^QT PAGAMENTOS/, total: /^TOTAL/, data: /^DATA$/ });
      }
      continue;
    }
    const nome = txt(l[cols.empresa]);
    if (!nome) continue;
    const comp = competenciaInformada || competenciaDe(l[cols.data]);
    if (!comp) { avisos.push(`Sem data: ${nome}`); continue; }
    const cnpj = normalizarCnpj(l[cols.cnpj]);
    for (const [metrica, k] of Object.entries(mapa)) {
      if (cols[k] == null) continue;
      medicoes.push({ cnpj, nome, competencia: comp, metrica, valor: num(l[cols[k]]) ?? 0, fonte: 'Bauner', evidencia: `Bauner ${comp}: ${nome}` });
    }
  }
  if (!cols) avisos.push('Cabeçalho do Bauner não encontrado');
  return { medicoes, mapeamentos: [], avisos };
}

// Carga inicial a partir da aba CadastrosSaldos da planilha "Gestão de Contratos".
function parseContratosPlanilha(linhas) {
  const L = (c) => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const contratos = [];
  for (let i = 4; i < linhas.length; i++) {
    const l = linhas[i] || [];
    const id = num(l[L('A')]);
    if (id == null) continue;
    const g = (c) => l[L(c)];
    const dataIni = g('D') instanceof Date ? g('D').toISOString().slice(0, 10) : (competenciaDe(g('D')) ? `${competenciaDe(g('D'))}-01` : null);
    const dataFim = g('E') instanceof Date ? g('E').toISOString().slice(0, 10) : null;
    const franquias = {};
    for (const [col, m] of [['K', 'contas_bancarias'], ['L', 'gateways'], ['M', 'cartoes'], ['N', 'funcionarios'], ['P', 'nf_saidas'], ['R', 'recebimentos'], ['U', 'pagamentos'], ['W', 'transacoes']]) {
      const v = num(g(col)); if (v != null) franquias[m] = v;
    }
    const precos = {};
    for (const [col, k] of [['AB', 'recebimentos_lote20'], ['AC', 'recebimentos_lote100'], ['AD', 'pagamentos_lote20'], ['AE', 'conta_bancaria'], ['AF', 'gateway'], ['AG', 'cartao'], ['AH', 'funcionarios_lote6'], ['AI', 'funcionario_unitario']]) {
      const v = num(g(col)); if (v != null) precos[k] = v;
    }
    const valorBase = num(g('AA')) ?? num(g('AN')) ?? 0;
    const indiceTxt = normalizarNome(g('J'));
    contratos.push({
      id: String(id), nome: txt(g('B')), cnpj: normalizarCnpj(g('C')),
      status: txt(g('F')) || 'Ativo', plano: normalizarPlano(g('H')), processo: normalizarProcesso(g('I')),
      indice: indiceTxt.includes('IGP') ? 'IGP-M' : indiceTxt.includes('INPC') ? 'INPC' : null,
      tributacao: txt(g('Y')) || null, dataInicio: dataIni, dataFim,
      tipoAdicionalFuncionario: /FUNCIONARIO/.test(normalizarNome(g('G'))) ? 'unitario' : 'lote',
      ultimoValorCobrado: num(g('AN')),
      versoes: [{ vigenciaInicio: dataIni ? dataIni.slice(0, 7) : '2024-01', valorBase, franquias, precos, origem: 'Planilha Gestão de Contratos - 2025' }],
      descontos: [],
    });
  }
  return contratos;
}

const PARSERS = {
  funcionarios: { rotulo: 'Domínio – Movimentação de Empregados', fn: parseMovimentoFuncionarios, aba: '2- Colar Movimento' },
  notas: { rotulo: 'Domínio – Origem de Notas Lançadas', fn: parseOrigemNotas, aba: '3- Colar Origem' },
  lancamentos: { rotulo: 'Domínio – Quantidade de Lançamentos', fn: parseLancamentos, aba: '5- Colar Qt' },
  bauner: { rotulo: 'Bauner – Movimentação', fn: parseBauner, aba: '6- Colar Dados' },
};

const BraskerParsers = {
  parseMovimentoFuncionarios, parseOrigemNotas, parseLancamentos, parseBauner, parseContratosPlanilha,
  normalizarCnpj, normalizarNome, competenciaDe, PARSERS,
};
if (typeof module !== 'undefined') module.exports = BraskerParsers; else globalThis.BraskerParsers = BraskerParsers;
})();
