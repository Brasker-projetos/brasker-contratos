const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (v == null ? '–' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const cnpjFmt = (c) => (c && c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c || '–');

const svc = globalThis.BraskerServico;
const api = globalThis.BraskerApi;
const { PLANOS, PROCESSOS } = globalThis.BraskerCatalog;
const { PARSERS } = globalThis.BraskerParsers;

const estado = { painel: null, contratos: [], aba: 'apuracao', papel: null, config: {} };
const PAPEL_ROTULO = { administrador: 'Administrador', editor: 'Editor', visualizador: 'Visualizador' };
// Visualizador (Gerência) só acompanha; editor e administrador operam. A regra vale de novo no banco.
const leitura = () => estado.papel === 'visualizador';
const comp = () => $('#competencia').value;

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('oculta'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('oculta'), 5000); }
const tentar = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) {
    if (e.semSessao) return mostrarLogin(e.message);
    toast(e.message);
  }
};

// ---------- Login ----------
function mostrarLogin(msg = '') {
  $('#app').classList.add('oculta');
  $('#painel-lateral').classList.add('oculta');
  $('#tela-login').classList.remove('oculta');
  $('#login-erro').textContent = msg;
}

async function abrirApp() {
  let acesso;
  try { acesso = await svc.meuAcesso(); } catch (e) {
    api.sair();
    if (e.semSessao) return mostrarLogin(e.message);
    return mostrarLogin(`Login aceito, mas não foi possível consultar o acesso: ${e.message}`);
  }
  if (!acesso || !acesso.papel) {
    api.sair();
    const quem = acesso && acesso.email ? ` (${acesso.email})` : '';
    const motivo = acesso && !acesso.nome ? ' Este e-mail não está cadastrado como usuário ativo do Copilot.' : '';
    return mostrarLogin(`Seu login${quem} não tem acesso ao Brasker Contratos.${motivo} Fale com a Tecnologia ou com a liderança do BPO.`);
  }
  estado.papel = acesso.papel;
  $('#usuario-nome').textContent = acesso.nome || acesso.email;
  $('#usuario-papel').textContent = PAPEL_ROTULO[acesso.papel];
  $('#aba-btn-equipe').classList.toggle('oculta', acesso.papel !== 'administrador');
  document.body.classList.toggle('somente-leitura', leitura());
  $('#tela-login').classList.add('oculta');
  $('#app').classList.remove('oculta');
  trocarAba('apuracao');
}

// ---------- Apuração ----------
const STATUS_TAG = { rascunho: 'alerta', aprovado: 'pri', finalizado: 'ok' };
const STATUS_LINHA = { excedente: ['erro', 'Excedente'], ok: ['ok', 'Dentro'], abaixo: ['ok', 'Abaixo (piso)'], ausente: ['', 'Sem medição'],
  sem_franquia: ['alerta', 'Sem franquia'], sem_preco: ['alerta', 'Sem preço'], nao_aplicavel: ['', 'N/A'], monitorada: ['', 'Monitorada'], acima_monitorada: ['alerta', 'Acima (sem preço)'] };

async function carregarPainel() {
  $('#sub-apuracao').textContent = 'Calculando…';
  estado.painel = await svc.painel(comp());
  const p = estado.painel, t = p.totais;
  $('#sub-apuracao').textContent = `Faturamento ${p.competencia} · volumes medidos na competência ${p.competenciaMedicao}`;
  const kpi = (rotulo, valor, cls = '', filtro = '') => `<div class="kpi ${cls}" ${filtro ? `data-filtro="${filtro}"` : ''}><small>${rotulo}</small><b>${valor}</b></div>`;
  $('#kpis').innerHTML = [
    kpi('Contratos ativos', t.contratosAtivos),
    kpi('Adicionais calculados', brl(t.adicionaisCalculados), 'ok', 'adicionais'),
    kpi('Ainda não aprovados', brl(t.receitaNaoAprovada), t.receitaNaoAprovada ? 'alerta' : '', 'rascunho'),
    kpi('Clientes defasados', t.defasados, t.defasados ? 'alerta' : '', 'defasado'),
    kpi('Reajustes no mês', t.reajustesPendentes, '', 'reajuste'),
    kpi('Sem franquia cadastrada', t.semParametrizacao, t.semParametrizacao ? 'alerta' : '', 'semparam'),
    kpi('Alertas de dados', t.alertasDados, t.alertasDados ? 'alerta' : '', 'alertas'),
    kpi('De-para pendente', p.pendentesMapeamento, p.pendentesMapeamento ? 'alerta' : ''),
    kpi('Rascunho / aprovado / finalizado', `${t.porStatus.rascunho} / ${t.porStatus.aprovado} / ${t.porStatus.finalizado}`),
  ].join('');
  document.querySelectorAll('.kpi[data-filtro]').forEach((k) => k.onclick = () => { $('#filtro').value = k.dataset.filtro; renderApuracao(); });
  renderApuracao();
}

function renderApuracao() {
  if (!estado.painel) return;
  const q = $('#busca').value.toLowerCase(), f = $('#filtro').value;
  const linhas = estado.painel.linhas.filter((l) => {
    if (q && !`${l.nome} ${l.cnpj || ''} ${l.id}`.toLowerCase().includes(q)) return false;
    if (f === 'adicionais') return l.adicionais > 0;
    if (f === 'alertas') return l.alertasDados > 0;
    if (f === 'defasado') return l.defasado;
    if (f === 'reajuste') return l.reajuste;
    if (f === 'semparam') return !l.parametrizado;
    if (f === 'rascunho') return l.status === 'rascunho';
    return true;
  });
  $('#tabela-apuracao').innerHTML = `<thead><tr><th>Cliente</th><th>Plano</th><th class="n">Base</th><th class="n">Adicionais</th><th class="n">Descontos</th><th class="n">Total</th><th class="n">Último cobrado</th><th class="n">Variação</th><th>Sinais</th><th>Status</th></tr></thead><tbody>${
    linhas.map((l) => `<tr class="clicavel" data-id="${esc(l.id)}">
      <td><b>${esc(l.nome)}</b><br><small class="sub">${cnpjFmt(l.cnpj)} · #${esc(l.id)}</small></td>
      <td>${esc(l.plano || '–')}</td><td class="n">${brl(l.valorBase)}</td>
      <td class="n">${l.adicionais ? `<b>${brl(l.adicionais)}</b>` : '–'}</td><td class="n">${l.descontos ? brl(-l.descontos) : '–'}</td>
      <td class="n"><b>${brl(l.valorFinal ?? l.total)}</b>${l.valorFinal != null ? '<br><small class="sub">ajustado</small>' : ''}</td>
      <td class="n">${brl(l.ultimoValorCobrado)}</td>
      <td class="n ${l.variacao > 0 ? 'pos' : l.variacao < 0 ? 'neg' : ''}">${l.variacao == null ? '–' : brl(l.variacao)}</td>
      <td>${!l.parametrizado ? '<span class="tag alerta">sem franquia</span>' : ''}${l.defasado ? '<span class="tag erro">defasado</span>' : ''}${l.reajuste ? '<span class="tag pri">reajuste</span>' : ''}${l.alertasDados ? `<span class="tag alerta">${l.alertasDados} alerta(s)</span>` : ''}</td>
      <td><span class="tag ${STATUS_TAG[l.status] || ''}">${esc(l.status)}</span></td></tr>`).join('') || '<tr><td colspan="10" class="sub">Nenhum contrato neste filtro. Faça a carga inicial da planilha de contratos na aba Importações.</td></tr>'
  }</tbody>`;
  document.querySelectorAll('#tabela-apuracao tr.clicavel').forEach((tr) => tr.onclick = tentar(() => abrirDetalhe(tr.dataset.id)));
}

async function abrirDetalhe(id) {
  const d = await svc.detalhe(id, comp());
  const { contrato: c, apuracao: a, reajuste, defasagem, historico } = d;
  const r = a.resultado;
  const ro = leitura();
  const linhas = r.linhas.filter((l) => l.status !== 'nao_aplicavel' && (l.contratado != null || l.medido != null));
  $('#conteudo-lateral').innerHTML = `
    <h2>${esc(c.nome)}</h2>
    <div class="sub">${cnpjFmt(c.cnpj)} · ${esc(c.plano || '')} · ${esc(c.processo || 'processo não informado')} · índice ${esc(c.indice || '–')}</div>
    <div class="sub">Faturamento ${esc(a.competencia)} · medição ${esc(r.competenciaMedicao)} · versão do contrato desde ${esc(r.versaoVigencia || '–')} · <span class="tag ${STATUS_TAG[a.status] || ''}">${esc(a.status)}</span></div>
    <div class="resumo">
      <div><small>Base</small><b>${brl(r.valorBase)}</b></div>
      <div><small>Adicionais</small><b>${brl(r.adicionais)}</b></div>
      <div><small>Descontos</small><b>${brl(-r.descontos)}</b></div>
      <div><small>Calculado</small><b>${brl(r.total)}</b></div>
      <div><small>Último cobrado</small><b>${brl(c.ultimoValorCobrado)}</b></div>
    </div>
    ${r.alertas.map((x) => `<div class="aviso">${esc(x.msg)}</div>`).join('')}
    ${r.adicionaisRetidos ? `<div class="aviso">Retido pelo teto: ${brl(r.adicionaisRetidos)} — candidato a aditivo.</div>` : ''}
    ${defasagem ? `<div class="aviso">Excedente em ${defasagem.meses} meses seguidos. Sugestão de aditivo: ${Object.entries(defasagem.sugestao).map(([m, s]) => `${esc(svc.METRICAS[m].rotulo)} ${s.franquiaAtual} → ${s.novaFranquia} (média ${brl(s.adicionalMedio)}/mês)`).join('; ')}</div>` : ''}
    ${reajuste ? `<div class="aviso info">Aniversário do contrato: ${esc(reajuste.indice)} acumulado ${reajuste.percentual}% → nova base ${brl(reajuste.novoValorBase)}${reajuste.mesesFaltando.length ? ` (faltam índices: ${reajuste.mesesFaltando.join(', ')})` : ''}
      ${!ro && !reajuste.mesesFaltando.length ? '<button class="sec" id="btn-reajuste">Aplicar reajuste</button>' : ''}</div>` : ''}
    <h3>Medido × contratado</h3>
    <div class="tabela-wrap"><table><thead><tr><th>Métrica</th><th class="n">Contratado</th><th class="n">Medido</th><th class="n">Lote</th><th class="n">Lotes c/m</th><th class="n">Exced.</th><th class="n">Preço</th><th class="n">Valor</th><th>Situação</th><th>Evidência</th></tr></thead><tbody>
    ${linhas.map((l) => { const [cls, txt] = STATUS_LINHA[l.status] || ['', l.status]; return `<tr>
      <td>${esc(l.rotulo)}${l.premissa ? ' <span class="tag alerta" title="' + esc(l.premissa) + '">premissa</span>' : ''}</td>
      <td class="n">${esc(l.contratado ?? '–')}</td><td class="n">${esc(l.medido ?? '–')}</td><td class="n">${esc(l.lote ?? '–')}</td>
      <td class="n">${esc(l.lotesContratados ?? '–')} / ${esc(l.lotesMedidos ?? '–')}</td><td class="n">${esc(l.excedente || '–')}</td>
      <td class="n">${l.precoUnit != null ? brl(l.precoUnit) + (l.origemPreco === 'contrato' ? '*' : '') : '–'}</td>
      <td class="n">${l.valor ? `<b>${brl(l.valor)}</b>` : '–'}</td><td><span class="tag ${cls}">${esc(txt)}</span></td>
      <td class="evid">${esc(l.fonte || '')}${l.evidencia ? ': ' + esc(l.evidencia) : ''}</td></tr>`; }).join('') || '<tr><td colspan="10" class="sub">Sem franquias nem medições para este contrato.</td></tr>'}
    </tbody></table></div>
    <small class="sub">* preço negociado no contrato. Lotes c/m = lotes contratados / medidos (mínimo 1 lote, arredondado para cima).</small>
    <h3>Últimos 6 meses (calculado)</h3>
    <div class="sub">${historico.map((h) => `${esc(h.comp)}: ${brl(h.total)}${h.adicionais ? ` (+${brl(h.adicionais)})` : ''}`).join(' · ')}</div>
    <h3>Pré-fatura</h3>
    <div class="linha-form">
      <label>Valor final negociado <input type="number" step="0.01" id="valor-final" value="${esc(a.valorFinal ?? '')}" placeholder="${esc(r.total)}" ${ro || a.status !== 'rascunho' ? 'disabled' : ''}></label>
      <label class="cresce">Observação / motivo <input id="obs" value="${esc(a.observacao || '')}" ${ro || a.status !== 'rascunho' ? 'disabled' : ''}></label>
    </div>
    <div class="acoes">
      ${!ro && a.status === 'rascunho' ? '<button class="sec" data-acao="ajustar">Salvar ajuste</button><button data-acao="aprovar">Aprovar pré-fatura</button>' : ''}
      ${!ro && a.status === 'aprovado' ? '<button data-acao="finalizar">Finalizar (faturado)</button><button class="sec" data-acao="reabrir">Reabrir</button>' : ''}
      <button class="sec" id="btn-comunicado">Gerar comunicado ao cliente</button>
    </div>
    <div id="area-comunicado"></div>
    ${a.historico.length ? `<h3>Histórico</h3><div class="sub">${a.historico.map((h) => `${esc(String(h.em).slice(0, 16).replace('T', ' '))} · ${esc(h.por)} · ${esc(h.acao)}${h.valor != null ? ' ' + brl(h.valor) : ''}${h.observacao ? ' — ' + esc(h.observacao) : ''}`).join('<br>')}</div>` : ''}`;
  $('#painel-lateral').classList.remove('oculta');
  document.querySelectorAll('[data-acao]').forEach((b) => b.onclick = tentar(async () => {
    b.disabled = true;
    if (b.dataset.acao === 'aprovar' || b.dataset.acao === 'ajustar') {
      await svc.acao(id, comp(), { acao: 'ajustar', valorFinal: $('#valor-final').value, observacao: $('#obs').value });
    }
    if (b.dataset.acao !== 'ajustar') await svc.acao(id, comp(), { acao: b.dataset.acao });
    toast('Apuração atualizada'); await carregarPainel(); await abrirDetalhe(id);
  }));
  const br = $('#btn-reajuste');
  if (br) br.onclick = tentar(async () => { await svc.aplicarReajuste(id, comp()); toast('Reajuste aplicado: nova versão do contrato criada'); await carregarPainel(); await abrirDetalhe(id); });
  $('#btn-comunicado').onclick = () => {
    $('#area-comunicado').innerHTML = `<h3>Comunicado (revise antes de enviar)</h3><textarea id="txt-com">${esc(svc.comunicado(id, comp()))}</textarea><div class="acoes"><button class="sec" id="copiar">Copiar texto</button></div>`;
    $('#copiar').onclick = () => { navigator.clipboard.writeText($('#txt-com').value); toast('Copiado'); };
  };
}

// ---------- Contratos ----------
async function carregarContratos() { estado.contratos = await svc.contratos(); estado.config = await svc.config(); renderContratos(); }
function renderContratos() {
  const q = $('#busca-contratos').value.toLowerCase();
  const lista = estado.contratos.filter((c) => !q || `${c.nome} ${c.cnpj} ${c.id}`.toLowerCase().includes(q));
  $('#tabela-contratos').innerHTML = `<thead><tr><th>Contrato</th><th>Status</th><th>Plano</th><th>Processo</th><th>Índice</th><th>Início</th><th class="n">Base vigente</th><th>Franquias</th></tr></thead><tbody>${
    lista.map((c) => { const v = c.versoes[c.versoes.length - 1] || {}; const nf = Object.keys(v.franquias || {}).length; return `<tr class="clicavel" data-id="${esc(c.id)}">
      <td><b>${esc(c.nome)}</b><br><small class="sub">${cnpjFmt(c.cnpj)} · #${esc(c.id)}</small></td><td><span class="tag ${c.status === 'Ativo' ? 'ok' : ''}">${esc(c.status)}</span></td>
      <td>${esc(c.plano || '–')}</td><td>${esc(c.processo || '–')}</td><td>${esc(c.indice || '–')}</td><td>${esc(c.dataInicio || '–')}</td>
      <td class="n">${brl(v.valorBase)}</td><td>${nf ? `${nf} métrica(s)` : '<span class="tag alerta">não cadastradas</span>'}</td></tr>`; }).join('')
      || '<tr><td colspan="8" class="sub">Nenhum contrato. Faça a carga inicial na aba Importações.</td></tr>'
  }</tbody>`;
  document.querySelectorAll('#tabela-contratos tr.clicavel').forEach((tr) => tr.onclick = () => editarContrato(tr.dataset.id));
}

function editarContrato(id) {
  const c = JSON.parse(JSON.stringify(estado.contratos.find((x) => x.id === id)));
  const v = c.versoes[c.versoes.length - 1];
  const ro = leitura() ? 'disabled' : '';
  const sel = (idc, ops, val) => `<select id="${idc}" ${ro}><option value=""></option>${ops.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const chavesPreco = [...new Set([...Object.keys(estado.config.tabela_precos || {}), 'funcionario_unitario'])];
  $('#conteudo-lateral').innerHTML = `
    <h2>${esc(c.nome)}</h2><div class="sub">#${esc(c.id)} · ${c.versoes.length} versão(ões): ${c.versoes.map((x) => `${esc(x.vigenciaInicio)} (${brl(x.valorBase)})`).join(', ')}</div>
    <h3>Cadastro</h3><div class="form-grid">
      <label>Nome <input id="c-nome" value="${esc(c.nome)}" ${ro}></label>
      <label>CNPJ <input id="c-cnpj" value="${esc(c.cnpj || '')}" ${ro}></label>
      <label>Status ${sel('c-status', ['Ativo', 'Cancelado'], c.status)}</label>
      <label>Plano ${sel('c-plano', Object.values(PLANOS), c.plano)}</label>
      <label>Processo de recebimentos ${sel('c-processo', Object.values(PROCESSOS), c.processo)}</label>
      <label>Índice de reajuste ${sel('c-indice', ['INPC', 'IGP-M'], c.indice)}</label>
      <label>Início do contrato <input type="date" id="c-inicio" value="${esc(c.dataInicio || '')}" ${ro}></label>
      <label>Adicional de funcionário ${sel('c-tipofunc', ['lote', 'unitario'], c.tipoAdicionalFuncionario)}</label>
    </div>
    <h3>Versão vigente (desde ${esc(v.vigenciaInicio)})</h3>
    <div class="form-grid">
      <label>Valor base (R$) <input type="number" step="0.01" id="v-base" value="${esc(v.valorBase ?? '')}" ${ro}></label>
      <label>Nova versão a partir de <input type="month" id="v-nova" ${ro}><small>vazio = editar a versão atual</small></label>
    </div>
    <h3>Franquias contratadas</h3><div class="form-grid">
      ${Object.entries(svc.METRICAS).map(([k, mt]) => `<label>${esc(mt.rotulo)}${mt.cobrada ? '' : ' (monitorada)'} <input type="number" data-fr="${esc(k)}" value="${esc(v.franquias?.[k] ?? '')}" ${ro}></label>`).join('')}
    </div>
    <h3>Preços negociados (vazio = tabela padrão)</h3><div class="form-grid">
      ${chavesPreco.map((k) => `<label>${esc(k.replace(/_/g, ' '))} <input type="number" step="0.01" data-pr="${esc(k)}" value="${esc(v.precos?.[k] ?? '')}" ${ro}></label>`).join('')}
    </div>
    <h3>Descontos (um por linha: pct|valor; valor; início AAAA-MM; fim AAAA-MM opcional; motivo)</h3>
    <textarea id="c-desc" class="baixo" ${ro}>${esc((c.descontos || []).map((d) => [d.tipo, d.valor, d.inicio, d.fim || '', d.motivo || ''].join('; ')).join('\n'))}</textarea>
    ${ro ? '' : '<div class="acoes"><button id="salvar-contrato">Salvar contrato</button></div>'}`;
  $('#painel-lateral').classList.remove('oculta');
  if (ro) return;
  $('#salvar-contrato').onclick = tentar(async () => {
    const franquias = {}, prec = {};
    document.querySelectorAll('[data-fr]').forEach((i) => { if (i.value !== '') franquias[i.dataset.fr] = Number(i.value); });
    document.querySelectorAll('[data-pr]').forEach((i) => { if (i.value !== '') prec[i.dataset.pr] = Number(i.value); });
    const nova = { vigenciaInicio: $('#v-nova').value || v.vigenciaInicio, valorBase: Number($('#v-base').value) || 0, franquias, precos: prec, origem: `Editado em ${new Date().toISOString().slice(0, 10)}` };
    if ($('#v-nova').value && $('#v-nova').value !== v.vigenciaInicio) c.versoes.push(nova); else c.versoes[c.versoes.length - 1] = nova;
    Object.assign(c, { nome: $('#c-nome').value, cnpj: $('#c-cnpj').value, status: $('#c-status').value || 'Ativo', plano: $('#c-plano').value || null,
      processo: $('#c-processo').value || null, indice: $('#c-indice').value || null, dataInicio: $('#c-inicio').value || null, tipoAdicionalFuncionario: $('#c-tipofunc').value || 'lote' });
    c.descontos = $('#c-desc').value.split('\n').map((l) => l.split(';').map((s) => s.trim())).filter((p) => p[0])
      .map(([tipo, valor, inicio, fim, motivo]) => ({ tipo: tipo === 'pct' ? 'pct' : 'valor', valor: Number(valor), inicio, fim: fim || null, motivo }));
    await svc.salvarContrato(c);
    toast('Contrato salvo'); await carregarContratos(); editarContrato(c.id);
  });
}

// ---------- Importações ----------
async function carregarImportacoes() {
  $('#form-import').classList.toggle('oculta', leitura());
  const [hist, pend] = await Promise.all([svc.importacoes(), svc.pendencias()]);
  $('#tabela-importacoes').innerHTML = `<thead><tr><th>Quando</th><th>Tipo</th><th>Arquivo</th><th>Por</th><th class="n">Medições</th><th class="n">Vinculadas</th><th class="n">Sem vínculo</th><th>Avisos</th></tr></thead><tbody>${
    (hist || []).map((h) => `<tr><td>${new Date(h.em).toLocaleString('pt-BR')}</td><td>${esc(PARSERS[h.tipo] ? PARSERS[h.tipo].rotulo : h.tipo)}</td><td>${esc(h.arquivo)}</td><td>${esc(h.por_nome || '')}</td>
      <td class="n">${h.total ?? '–'}</td><td class="n">${h.vinculadas ?? '–'}</td><td class="n">${h.sem_vinculo ?? '–'}</td><td class="evid">${esc((h.avisos || []).join('; '))}${h.concluida ? '' : ' <span class="tag alerta">incompleta</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="sub">Nenhuma importação ainda.</td></tr>'
  }</tbody>`;
  const lista = (pend || []).slice(0, 300);
  $('#tabela-pendencias').innerHTML = `<thead><tr><th>Empresa no relatório</th><th>Fonte</th><th>CNPJ informado</th><th>Competência</th><th>CNPJ do contrato</th></tr></thead><tbody>${
    lista.map((p, i) => `<tr><td>${esc(p.nome)}</td><td>${esc(p.fonte)}</td><td>${esc(p.cnpj_informado || '–')}</td><td>${esc(p.competencia || '')}</td>
      <td>${leitura() ? '' : `<input id="map-${i}" placeholder="CNPJ" size="20"> <button class="sec" data-map="${i}">Vincular</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="sub">Nada pendente.</td></tr>'
  }</tbody>`;
  document.querySelectorAll('[data-map]').forEach((b) => b.onclick = tentar(async () => {
    const p = lista[Number(b.dataset.map)];
    const n = await svc.mapear(p.nome_norm, $(`#map-${b.dataset.map}`).value);
    toast(`Vínculo salvo (${n} medições atualizadas)`); carregarImportacoes();
  }));
}

// ---------- Índices e regras ----------
async function carregarIndices() {
  estado.config = await svc.config();
  estado.indices = await svc.indices();
  $('#cfg-defasagem').value = estado.config.defasagem_meses; $('#cfg-teto').value = estado.config.teto_aumento_pct ?? ''; $('#cfg-min').value = estado.config.min_meses_defasagem;
  document.querySelectorAll('#aba-indices input, #aba-indices button').forEach((el) => { el.disabled = leitura(); });
  renderIndices();
}
function renderIndices() {
  const nome = $('#idx-nome').value, serie = estado.indices[nome] || {};
  const meses = []; const [a, m] = comp().split('-').map(Number);
  for (let i = 24; i >= 1; i--) { const d = new Date(Date.UTC(a, m - 1 - i, 1)); meses.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
  $('#grade-indices').innerHTML = meses.map((c) => `<label>${c}<input type="number" step="0.01" data-idx="${c}" value="${serie[c] ?? ''}" ${leitura() ? 'disabled' : ''}></label>`).join('');
}

// ---------- Equipe (administradores: Tecnologia e Líder do BPO) ----------
async function carregarEquipe() {
  const { membros, candidatos } = await svc.equipe();
  $('#tabela-equipe').innerHTML = `<thead><tr><th>Pessoa</th><th>Departamento</th><th>Papel</th><th>Origem</th><th></th></tr></thead><tbody>${
    membros.map((m) => `<tr><td><b>${esc(m.nome)}</b><br><small class="sub">${esc(m.email)}</small></td><td>${esc(m.departamento || '–')}</td>
      <td><span class="tag ${m.papel === 'administrador' ? 'pri' : m.papel === 'editor' ? 'ok' : ''}">${PAPEL_ROTULO[m.papel]}</span></td>
      <td>${m.origem === 'individual' ? 'Liberado individualmente' : 'Regra do departamento'}</td>
      <td>${m.origem === 'departamento' && m.papel === 'administrador'
        ? '<span class="tag" title="Administrador pela regra do departamento: só a Tecnologia altera">Protegido</span>'
        : `<button class="sec" data-tirar="${esc(m.usuario_id)}" data-nome="${esc(m.nome)}">Remover acesso</button>`}</td></tr>`).join('')
  }</tbody>`;
  $('#eq-pessoa').innerHTML = `<option value="">Escolha a pessoa (login do Copilot)</option>${candidatos.map((c) => `<option value="${esc(c.usuario_id)}">${esc(c.nome)} — ${esc(c.departamento || 'sem setor')}</option>`).join('')}`;
  document.querySelectorAll('[data-tirar]').forEach((b) => b.onclick = tentar(async () => {
    if (!confirm(`Remover o acesso de ${b.dataset.nome} ao Brasker Contratos?`)) return;
    await svc.tirar(b.dataset.tirar); toast('Acesso removido'); carregarEquipe();
  }));
}

// ---------- Inicialização ----------
function trocarAba(aba) {
  estado.aba = aba;
  document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === aba));
  document.querySelectorAll('.aba').forEach((s) => s.classList.toggle('oculta', s.id !== `aba-${aba}`));
  $('#painel-lateral').classList.add('oculta');
  tentar(({ apuracao: carregarPainel, contratos: carregarContratos, importacoes: carregarImportacoes, indices: carregarIndices, equipe: carregarEquipe })[aba])();
}

(function init() {
  // Contra clickjacking: o Pages não envia frame-ancestors/X-Frame-Options, então o app se recusa a abrir dentro de iframe.
  if (window.top !== window.self) {
    document.body.textContent = 'Abra o Brasker Contratos diretamente pelo endereço oficial.';
    return;
  }
  const hoje = new Date();
  $('#competencia').value = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  $('#imp-tipo').innerHTML = `<option value="contratos">Planilha Gestão de Contratos (carga inicial)</option>${Object.entries(PARSERS).map(([k, v]) => `<option value="${k}">${esc(v.rotulo)}</option>`).join('')}`;
  document.querySelectorAll('#abas button').forEach((b) => b.onclick = () => trocarAba(b.dataset.aba));
  $('#competencia').onchange = () => trocarAba(estado.aba);
  $('#busca').oninput = renderApuracao; $('#filtro').onchange = renderApuracao;
  $('#busca-contratos').oninput = renderContratos;
  $('#fechar-lateral').onclick = () => $('#painel-lateral').classList.add('oculta');
  $('#idx-nome').onchange = renderIndices;
  $('#sair').onclick = () => { api.sair(); mostrarLogin(); };

  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('#login-botao'); b.disabled = true; b.textContent = 'Entrando…'; $('#login-erro').textContent = '';
    try { await api.entrar($('#login-email').value, $('#login-senha').value); $('#login-senha').value = ''; await abrirApp(); }
    catch (err) { $('#login-erro').textContent = err.message; }
    finally { b.disabled = false; b.textContent = 'Entrar'; }
  };

  $('#form-import').onsubmit = tentar(async (e) => {
    e.preventDefault();
    const arq = $('#imp-arquivo').files[0];
    const b = $('#imp-botao'); b.disabled = true;
    try {
      const r = await svc.importar(arq, $('#imp-tipo').value, $('#imp-comp').value || null, (m) => { $('#imp-status').textContent = m; });
      $('#imp-status').textContent = r.tipo === 'contratos' ? `${r.lidos} contratos lidos, ${r.gravados} novos gravados (os já existentes não foram sobrescritos).`
        : `${r.total} medições, ${r.vinculadas} vinculadas a contratos, ${r.sem_vinculo} empresas sem vínculo.`;
      carregarImportacoes();
    } catch (err) { $('#imp-status').textContent = `Falhou: ${err.message}`; throw err; }
    finally { b.disabled = false; }
  });
  $('#form-config').onsubmit = tentar(async (e) => {
    e.preventDefault();
    estado.config = await svc.salvarConfig({ defasagem_meses: Number($('#cfg-defasagem').value), teto_aumento_pct: $('#cfg-teto').value === '' ? null : Number($('#cfg-teto').value), min_meses_defasagem: Number($('#cfg-min').value) });
    toast('Regras salvas');
  });
  $('#form-indices').onsubmit = tentar(async (e) => {
    e.preventDefault();
    const nome = $('#idx-nome').value; const ind = JSON.parse(JSON.stringify(estado.indices || {})); ind[nome] = ind[nome] || {};
    document.querySelectorAll('[data-idx]').forEach((i) => { if (i.value === '') delete ind[nome][i.dataset.idx]; else ind[nome][i.dataset.idx] = Number(i.value); });
    await svc.salvarIndices(ind); estado.indices = ind;
    toast('Índices salvos');
  });
  $('#form-equipe').onsubmit = tentar(async (e) => {
    e.preventDefault();
    await svc.liberar($('#eq-pessoa').value, $('#eq-papel').value);
    toast('Acesso liberado'); carregarEquipe();
  });

  if (api.sessao()) tentar(abrirApp)(); else mostrarLogin();
})();
