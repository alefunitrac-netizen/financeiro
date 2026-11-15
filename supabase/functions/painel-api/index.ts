// Edge Function: https://<projeto>.supabase.co/functions/v1/painel-api
// API do painel web. Publicar com verify_jwt = false: a autenticação é a sessão do painel
// (Authorization: Bearer <sessão>), criada a partir do link de uso único que o bot manda.
//
//   POST /entrar           {codigo}        → {token, nome}
//   POST /sair                             → encerra esta sessão
//   GET  /resumo?mes=AAAA-MM               → tudo que o painel mostra
//   PUT  /renda            {...ConfigRenda}
//   POST /calcular-renda   {...ConfigRenda}  → holerite, sem salvar
//   POST /fixas            {nome, tipo, valorCentavos, diaVencimento}
//   PUT  /fixas/:id        idem
//   DELETE /fixas/:id
//   POST /aportes          {valorCentavos, data?, descricao?}
//   DELETE /aportes/:id
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { hojeNoFuso, somarDias, somarMeses } from "../_shared/datas.ts";
import { inicioDoMes } from "../_shared/previsao.ts";
import {
  type DadosPainel,
  gerarSegredo,
  hashSegredo,
  montarPainel,
  SESSAO_DIAS,
  validarAporte,
  validarFixa,
  validarRenda,
} from "../_shared/painel.ts";
import { calcularHolerite, type ConfigRenda } from "../_shared/salario.ts";

const env = (n: string) => Deno.env.get(n) ?? "";
function chaveSecreta(): string {
  try {
    const k = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}").default;
    if (k) return k;
  } catch { /* legada */ }
  return env("SUPABASE_SERVICE_ROLE_KEY");
}
const db = createClient(env("SUPABASE_URL"), chaveSecreta(), { auth: { persistSession: false, autoRefreshToken: false } });

const ORIGENS = [/^https:\/\/alefunitrac-netizen\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const log = (evento: string, dados: Record<string, unknown> = {}) => console.log(JSON.stringify({ evento, ...dados }));

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

class ErroHttp extends Error {
  constructor(readonly status: number, mensagem: string) {
    super(mensagem);
  }
}
function falhar(op: string, e: { message: string }): never {
  throw new Error(`${op}: ${e.message}`);
}

async function usuarioDaSessao(req: Request): Promise<{ usuarioId: string; sessaoId: string }> {
  const token = /^Bearer\s+(\S{20,200})$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) throw new ErroHttp(401, "sem sessão");
  const { data, error } = await db
    .from("acessos_painel")
    .select("id, usuario_id, expira_em, revogado")
    .eq("hash", await hashSegredo(token))
    .eq("tipo", "sessao")
    .maybeSingle();
  if (error) falhar("sessao", error);
  if (!data || data.revogado || Date.parse(data.expira_em) < Date.now()) throw new ErroHttp(401, "sessão expirada");
  return { usuarioId: data.usuario_id, sessaoId: data.id };
}

async function entrar(codigo: unknown) {
  if (typeof codigo !== "string" || codigo.length < 20 || codigo.length > 200) throw new ErroHttp(400, "código inválido");
  // Marca o código como usado num único UPDATE: dois cliques no mesmo link não abrem duas sessões.
  const { data, error } = await db
    .from("acessos_painel")
    .update({ usado_em: new Date().toISOString() })
    .eq("hash", await hashSegredo(codigo))
    .eq("tipo", "codigo")
    .is("usado_em", null)
    .eq("revogado", false)
    .gt("expira_em", new Date().toISOString())
    .select("usuario_id")
    .maybeSingle();
  if (error) falhar("entrar", error);
  if (!data) throw new ErroHttp(401, "link expirado ou já usado: mande \"painel\" no bot para receber outro");
  const token = gerarSegredo();
  const { error: e2 } = await db.from("acessos_painel").insert({
    usuario_id: data.usuario_id,
    tipo: "sessao",
    hash: await hashSegredo(token),
    expira_em: new Date(Date.now() + SESSAO_DIAS * 86_400_000).toISOString(),
  });
  if (e2) falhar("sessao", e2);
  const { data: u } = await db.from("usuarios").select("nome").eq("id", data.usuario_id).single();
  log("painel_entrou");
  return { token, nome: (u?.nome ?? "").split(" ")[0] };
}

const deRenda = (r: Linha | null): ConfigRenda | null =>
  r
    ? {
      regime: r.regime,
      brutoCentavos: Number(r.bruto_centavos),
      dependentes: r.dependentes,
      descontos: r.descontos ?? [],
      inssManual: r.inss_manual == null ? null : Number(r.inss_manual),
      irrfManual: r.irrf_manual == null ? null : Number(r.irrf_manual),
      metaPercentual: Number(r.meta_percentual),
    }
    : null;

async function resumo(usuarioId: string, mesPedido: string | null) {
  const { data: u, error: eu } = await db
    .from("usuarios")
    .select("nome, fuso_horario, renda_mensal_centavos")
    .eq("id", usuarioId)
    .single();
  if (eu) falhar("usuario", eu);
  const hoje = hojeNoFuso(u.fuso_horario);
  const mes = mesPedido && /^\d{4}-\d{2}$/.test(mesPedido) ? `${mesPedido}-01` : inicioDoMes(hoje);
  const fim = somarDias(somarMeses(mes, 1), -1);
  const anterior = somarMeses(mes, -1);
  const atual = inicioDoMes(hoje);

  const q = <T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, op: string) =>
    Promise.resolve(p).then(({ data, error }) => {
      if (error) falhar(op, error);
      return data as T;
    });
  const [cat, catAnt, fat, contas, renda, fluxo, primeira, fixas, aportes, lanc] = await Promise.all([
    q<Linha[]>(db.rpc("resumo_por_categoria", { p_usuario: usuarioId, p_inicio: mes, p_fim: fim }), "categorias"),
    q<Linha[]>(db.rpc("resumo_por_categoria", { p_usuario: usuarioId, p_inicio: anterior, p_fim: somarDias(mes, -1) }), "anterior"),
    q<Linha[]>(db.rpc("faturas_abertas", { p_usuario: usuarioId, p_hoje: hoje }), "faturas"),
    q<Linha[]>(
      db.from("contas").select("nome, tipo, saldo_centavos, limite_centavos").eq("usuario_id", usuarioId).eq("ativa", true).order("nome"),
      "contas",
    ),
    q<Linha | null>(db.from("renda_config").select("*").eq("usuario_id", usuarioId).maybeSingle(), "renda"),
    q<Linha[]>(
      db.rpc("fluxo_mensal", { p_usuario: usuarioId, p_inicio: somarMeses(atual, -3), p_fim: somarDias(somarMeses(atual, 4), -1) }),
      "fluxo",
    ),
    q<Linha | null>(
      db.from("transacoes").select("data_transacao").eq("usuario_id", usuarioId).neq("status", "cancelado")
        .order("data_transacao").limit(1).maybeSingle(),
      "primeira",
    ),
    q<Linha[]>(
      db.from("despesas_fixas").select("id, nome, tipo, valor_centavos, dia_vencimento").eq("usuario_id", usuarioId).eq("ativa", true)
        .order("nome"),
      "fixas",
    ),
    q<Linha[]>(db.from("aportes").select("id, data, valor_centavos, descricao").eq("usuario_id", usuarioId).order("data"), "aportes"),
    q<Linha[]>(
      db.from("transacoes")
        .select("data_transacao, descricao, valor_centavos, tipo, categorias(nome), contas(nome)")
        .eq("usuario_id", usuarioId).neq("status", "cancelado").in("tipo", ["despesa", "receita"])
        .gte("data_transacao", mes).lte("data_transacao", fim).order("data_transacao", { ascending: false }).limit(500),
      "lancamentos",
    ),
  ]);

  const resumoLinha = (l: Linha) => ({
    tipo: l.tipo,
    categoria: l.categoria,
    totalCentavos: Number(l.total_centavos),
    quantidade: Number(l.quantidade),
  });
  const dados: DadosPainel = {
    nome: u.nome,
    hoje,
    mes,
    categorias: (cat ?? []).map(resumoLinha),
    categoriasAnterior: (catAnt ?? []).map(resumoLinha),
    faturas: (fat ?? []).map((l) => ({
      contaId: l.conta_id,
      conta: l.conta,
      vencimento: l.vencimento,
      totalCentavos: Number(l.total_centavos),
      informada: Boolean(l.informada),
    })),
    contas: (contas ?? []).map((c) => ({
      nome: c.nome,
      tipo: c.tipo,
      saldoCentavos: c.saldo_centavos == null ? null : Number(c.saldo_centavos),
      limiteCentavos: c.limite_centavos == null ? null : Number(c.limite_centavos),
    })),
    renda: deRenda(renda),
    rendaInformada: u.renda_mensal_centavos == null ? null : Number(u.renda_mensal_centavos),
    historico: (fluxo ?? []).map((l) => ({
      mes: String(l.mes).slice(0, 10),
      receitas: Number(l.receitas),
      gastosAvulsos: Number(l.gastos_avulsos),
      parcelas: Number(l.parcelas),
    })),
    primeiraData: primeira?.data_transacao ?? null,
    fixas: (fixas ?? []).map((f) => ({
      id: f.id,
      nome: f.nome,
      tipo: f.tipo,
      valorCentavos: Number(f.valor_centavos),
      diaVencimento: f.dia_vencimento,
    })),
    aportes: (aportes ?? []).map((a) => ({ id: a.id, data: a.data, valorCentavos: Number(a.valor_centavos), descricao: a.descricao })),
    lancamentos: (lanc ?? []).map((l) => ({
      data: l.data_transacao,
      descricao: l.descricao,
      valorCentavos: Number(l.valor_centavos),
      tipo: l.tipo,
      categoria: l.categorias?.nome ?? null,
      conta: l.contas?.nome ?? null,
    })),
  };
  return montarPainel(dados);
}

async function salvarRenda(usuarioId: string, corpo: Record<string, unknown>) {
  const r = validarRenda(corpo);
  if (typeof r === "string") throw new ErroHttp(400, r);
  const { error } = await db.from("renda_config").upsert({
    usuario_id: usuarioId,
    regime: r.regime,
    bruto_centavos: r.brutoCentavos,
    dependentes: r.dependentes,
    descontos: r.descontos,
    inss_manual: r.inssManual,
    irrf_manual: r.irrfManual,
    meta_percentual: r.metaPercentual,
    atualizado_em: new Date().toISOString(),
  });
  if (error) falhar("renda", error);
  // O líquido vira a renda das simulações do bot ("vou comprar... cabe?").
  // Sem salário preenchido (ex.: só mudou a meta), a renda que o bot já tinha fica como está.
  const liquido = r.brutoCentavos > 0 ? calcularHolerite(r).liquido : 0;
  if (liquido > 0) {
    const { error: e2 } = await db.from("usuarios").update({ renda_mensal_centavos: liquido }).eq("id", usuarioId);
    if (e2) falhar("renda_usuario", e2);
  }
  return { ok: true, holerite: r.brutoCentavos > 0 ? calcularHolerite(r) : null };
}

async function lerCorpo(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch { /* cai no erro */ }
  throw new ErroHttp(400, "JSON inválido");
}

const UUID = /^[0-9a-f-]{36}$/;

async function rotear(req: Request): Promise<unknown> {
  const url = new URL(req.url);
  const partes = url.pathname.split("/").filter(Boolean);
  const i = partes.indexOf("painel-api");
  const [recurso, id] = partes.slice(i + 1);

  if (req.method === "POST" && recurso === "entrar") return entrar((await lerCorpo(req)).codigo);

  const { usuarioId, sessaoId } = await usuarioDaSessao(req);
  if (id !== undefined && !UUID.test(id)) throw new ErroHttp(400, "id inválido");

  if (req.method === "GET" && recurso === "resumo") return resumo(usuarioId, url.searchParams.get("mes"));
  if (req.method === "POST" && recurso === "sair") {
    await db.from("acessos_painel").update({ revogado: true }).eq("id", sessaoId);
    return { ok: true };
  }
  if (req.method === "PUT" && recurso === "renda") return salvarRenda(usuarioId, await lerCorpo(req));
  // O "calculador": mostra o líquido enquanto você digita, sem salvar.
  if (req.method === "POST" && recurso === "calcular-renda") {
    const r = validarRenda(await lerCorpo(req));
    if (typeof r === "string") throw new ErroHttp(400, r);
    return { holerite: calcularHolerite(r) };
  }

  if (recurso === "fixas") {
    if (req.method === "DELETE" && id) {
      const { error } = await db.from("despesas_fixas").update({ ativa: false }).eq("id", id).eq("usuario_id", usuarioId);
      if (error) falhar("fixas", error);
      return { ok: true };
    }
    const f = validarFixa(await lerCorpo(req));
    if (typeof f === "string") throw new ErroHttp(400, f);
    const linha = { nome: f.nome, tipo: f.tipo, valor_centavos: f.valorCentavos, dia_vencimento: f.diaVencimento };
    const { error } = req.method === "PUT" && id
      ? await db.from("despesas_fixas").update(linha).eq("id", id).eq("usuario_id", usuarioId)
      : req.method === "POST"
      ? await db.from("despesas_fixas").insert({ ...linha, usuario_id: usuarioId })
      : { error: { message: "método" } };
    if (error) falhar("fixas", error);
    return { ok: true };
  }

  if (recurso === "aportes") {
    if (req.method === "DELETE" && id) {
      const { error } = await db.from("aportes").delete().eq("id", id).eq("usuario_id", usuarioId);
      if (error) falhar("aportes", error);
      return { ok: true };
    }
    if (req.method === "POST") {
      const { data: u } = await db.from("usuarios").select("fuso_horario").eq("id", usuarioId).single();
      const a = validarAporte(await lerCorpo(req), hojeNoFuso(u?.fuso_horario ?? "America/Sao_Paulo"));
      if (typeof a === "string") throw new ErroHttp(400, a);
      const { error } = await db.from("aportes").insert({
        usuario_id: usuarioId,
        data: a.data,
        valor_centavos: a.valorCentavos,
        descricao: a.descricao,
      });
      if (error) falhar("aportes", error);
      return { ok: true };
    }
  }
  throw new ErroHttp(404, "não encontrado");
}

Deno.serve(async (req) => {
  const origem = req.headers.get("origin") ?? "";
  const cors: Record<string, string> = ORIGENS.some((r) => r.test(origem))
    ? {
      "Access-Control-Allow-Origin": origem,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    }
    : { "Vary": "Origin" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    return Response.json(await rotear(req), { headers: { ...cors, "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof ErroHttp) return Response.json({ erro: e.message }, { status: e.status, headers: cors });
    log("erro_painel", { erro: e instanceof Error ? e.message : String(e) });
    return Response.json({ erro: "erro interno" }, { status: 500, headers: cors });
  }
});
