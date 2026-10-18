// Catálogo de métricas, planos e tabela de preços padrão.
// Origem: aba "Preços" e fórmulas das abas "<Mês> - Comp_<Mês>" da planilha
// "Gestão de Contratos - 2025.xlsx" (ver docs/engenharia-reversa.md).
(function () {
const PLANOS = {
  BPO: 'BPO Financeiro',
  BPO_CONTABIL: 'BPO Financeiro + Contabilidade',
  PEJOTA: 'BPO Financeiro + Contabilidade (Pejota)',
  CONTABIL: 'Contabilidade',
  LICENCA: 'Licença de Software',
  RECUPERA: 'Recupera+',
};

const PROCESSOS = {
  MANUAL: 'Recebimentos Manuais',
  AUTO: 'Recebimentos Automáticos/Integrados',
};

// Normaliza as várias grafias encontradas na planilha
// ("BPO financeiro", "BPO Fin + Contabilidade (Pejota)", "... - Pejota").
function normalizarPlano(txt) {
  const t = String(txt || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t.trim()) return null;
  if (t.includes('pejota')) return PLANOS.PEJOTA;
  if (t.includes('bpo') && t.includes('contab')) return PLANOS.BPO_CONTABIL;
  if (t.includes('bpo')) return PLANOS.BPO;
  if (t.includes('contab')) return PLANOS.CONTABIL;
  if (t.includes('licen')) return PLANOS.LICENCA;
  if (t.includes('recupera')) return PLANOS.RECUPERA;
  return String(txt).trim();
}

function normalizarProcesso(txt) {
  const t = String(txt || '').toLowerCase();
  if (t.includes('autom') || t.includes('integr')) return PROCESSOS.AUTO;
  if (t.includes('manua')) return PROCESSOS.MANUAL;
  return null;
}

// Família de preço: Pejota não tem coluna própria na aba Preços; usa a de BPO + Contabilidade.
function familiaPreco(plano) {
  if (plano === PLANOS.BPO) return 'bpo';
  if (plano === PLANOS.BPO_CONTABIL || plano === PLANOS.PEJOTA) return 'bpoContabil';
  if (plano === PLANOS.CONTABIL) return 'contabil';
  return null;
}

// A tabela de preços padrão NÃO fica no código (o site é público): vem do banco (contratos.config.tabela_precos).

// Métricas medidas. `cobrada: false` = só monitoramento (planilha não tem preço para elas).
const METRICAS = {
  contas_bancarias: { rotulo: 'Contas bancárias', fonte: 'Bauner', agregacao: 'última contagem', cobrada: true },
  gateways: { rotulo: 'Gateways de pagamento', fonte: 'Bauner', agregacao: 'última contagem', cobrada: true },
  cartoes: { rotulo: 'Cartões corporativos', fonte: 'Bauner', agregacao: 'última contagem', cobrada: true },
  funcionarios: { rotulo: 'Funcionários / sócios', fonte: 'Domínio (Movimentação de Empregados)', agregacao: 'saldo na competência', cobrada: true },
  recebimentos: { rotulo: 'NF serviços / recebimentos', fonte: 'Domínio (Origem de Notas) ou Bauner', agregacao: 'soma no mês', cobrada: true },
  pagamentos: { rotulo: 'Pagamentos', fonte: 'Bauner', agregacao: 'soma no mês', cobrada: true },
  nf_saidas: { rotulo: 'NF saídas', fonte: 'Domínio (Origem de Notas)', agregacao: 'soma no mês', cobrada: false },
  nf_entradas: { rotulo: 'NF entradas', fonte: 'Domínio (Origem de Notas)', agregacao: 'soma no mês', cobrada: false },
  transacoes: { rotulo: 'Total de transações', fonte: 'Bauner', agregacao: 'soma no mês', cobrada: false },
  lancamentos: { rotulo: 'Lançamentos contábeis', fonte: 'Domínio (Lançamentos)', agregacao: 'soma no mês', cobrada: false },
};

// Regra de cobrança de cada métrica para um contrato: tamanho do lote e chave de preço.
// Reproduz as fórmulas da planilha, com as correções listadas em docs/engenharia-reversa.md.
function regraCobranca(metrica, contrato) {
  const { plano, processo } = contrato;
  const pejota = plano === PLANOS.PEJOTA;
  const auto = processo === PROCESSOS.AUTO;
  switch (metrica) {
    case 'contas_bancarias': return { lote: 1, precoChave: 'conta_bancaria' };
    case 'gateways': return { lote: 1, precoChave: 'gateway' };
    case 'cartoes': return { lote: 1, precoChave: 'cartao' };
    case 'funcionarios':
      if (plano === PLANOS.BPO) return null; // BPO puro não tem DP
      if (contrato.tipoAdicionalFuncionario === 'unitario') return { lote: 1, precoChave: 'funcionario_unitario' };
      return { lote: 6, precoChave: 'funcionarios_lote6' };
    case 'recebimentos':
      if (pejota) return { lote: auto ? 10 : 2, precoChave: auto ? 'recebimentos_lote100' : 'recebimentos_lote20', premissa: 'Pejota: lote 2/10 da planilha; preço da coluna BPO + Contabilidade (planilha não define preço Pejota)' };
      return { lote: auto ? 100 : 20, precoChave: auto ? 'recebimentos_lote100' : 'recebimentos_lote20' };
    case 'pagamentos': return { lote: pejota ? 5 : 20, precoChave: 'pagamentos_lote20' };
    case 'transacoes': return { lote: auto ? 500 : 100, precoChave: null };
    default: return { lote: 1, precoChave: null };
  }
}

const BraskerCatalog = {
  PLANOS, PROCESSOS, METRICAS,
  normalizarPlano, normalizarProcesso, familiaPreco, regraCobranca,
};
if (typeof module !== 'undefined') module.exports = BraskerCatalog; else globalThis.BraskerCatalog = BraskerCatalog;})();
