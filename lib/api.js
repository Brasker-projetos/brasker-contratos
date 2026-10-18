// Login no brasker-dados (mesma conta do Copilot) e chamadas às funções public.contratos_*.
// Fala direto com o Auth e o REST do Supabase por HTTP, como o Smart BPO. A chave abaixo é a
// publicável: sozinha não lê nada; quem decide o acesso é o schema `acesso`, conferido em
// toda função do banco.
(function () {
const SUPABASE_URL = 'https://ermnhxwzuhirxwkzrfoe.supabase.co';
const CHAVE_PUBLICA = 'sb_publishable_G_EsppeiJaQS5NVKw_gfSg_GvGe_rN2';
const CHAVE_STORAGE = 'brasker-contratos.sessao';
const MARGEM_RENOVACAO_S = 60;

let memoria = null;
function ler() { try { return memoria || JSON.parse(localStorage.getItem(CHAVE_STORAGE) || 'null'); } catch { return memoria; } }
function gravar(s) { memoria = s; try { s ? localStorage.setItem(CHAVE_STORAGE, JSON.stringify(s)) : localStorage.removeItem(CHAVE_STORAGE); } catch { /* sem storage: vale só nesta aba */ } }

async function pedirToken(grant, corpo) {
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { apikey: CHAVE_PUBLICA, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
  } catch { throw new Error('Sem conexão com o servidor de login. Confira a internet.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (grant !== 'password') throw new Error('Sessão expirada. Entre de novo.');
    // Motivo real da recusa (antes tudo virava "senha incorreta", até bloqueio por excesso de tentativas).
    const codigo = d.error_code || d.code || '';
    if (r.status === 429 || /rate_limit/.test(codigo)) {
      throw new Error('Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.');
    }
    if (codigo === 'email_not_confirmed') throw new Error('E-mail ainda não confirmado. Fale com a Tecnologia.');
    if (codigo === 'user_banned') throw new Error('Este login está bloqueado. Fale com a Tecnologia.');
    if (r.status >= 500) throw new Error('O servidor de login está instável. Tente de novo em instantes.');
    throw new Error('E-mail ou senha incorretos. Use o mesmo login do Copilot; se esqueceu a senha, use "Esqueci minha senha" na tela de login do Copilot.');
  }
  return { email: d.user && d.user.email, accessToken: d.access_token, refreshToken: d.refresh_token,
    expiraEm: Math.floor(Date.now() / 1000) + (d.expires_in || 3600) };
}

async function token() {
  const s = ler();
  if (!s) throw Object.assign(new Error('Entre com o login do Copilot.'), { semSessao: true });
  if (s.expiraEm - MARGEM_RENOVACAO_S > Date.now() / 1000) return s.accessToken;
  try {
    const novo = await pedirToken('refresh_token', { refresh_token: s.refreshToken });
    gravar({ ...s, ...novo });
    return novo.accessToken;
  } catch (e) { gravar(null); throw Object.assign(e, { semSessao: true }); }
}

const MENSAGENS = {
  SEM_ACESSO: 'Seu login não tem permissão para esta ação no Brasker Contratos. Fale com a Tecnologia ou com a liderança do BPO.',
};

async function rpc(fn, args = {}) {
  const t = await token();
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: CHAVE_PUBLICA, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch { throw new Error('Sem conexão com o banco de dados. Confira a internet.'); }
  if (r.status === 204) return null;
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401) { gravar(null); throw Object.assign(new Error('Sessão expirada. Entre de novo.'), { semSessao: true }); }
    const msg = (d && d.message) || `Erro ${r.status}`;
    const chave = Object.keys(MENSAGENS).find((k) => msg.startsWith(k));
    throw new Error(chave ? MENSAGENS[chave] : msg);
  }
  return d;
}

async function entrar(email, senha) {
  const s = await pedirToken('password', { email: String(email).trim().toLowerCase(), password: senha });
  gravar(s);
  return s;
}

function sair() { gravar(null); }
function sessao() { const s = ler(); return s ? { email: s.email } : null; }

globalThis.BraskerApi = { rpc, entrar, sair, sessao };
})();
