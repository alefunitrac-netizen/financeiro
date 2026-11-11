// Regras de categoria que você ensina ("roberto é moradia").
import { chave, contemTermo } from "./texto.ts";
import type { Categoria, RegraCategoria, TipoLancamento } from "./tipos.ts";

/** Categoria dada por uma regra sua para esta descrição, ou null. O termo mais longo vence. */
export function categoriaPorRegra(
  descricao: string,
  tipo: TipoLancamento,
  regras: RegraCategoria[],
  categorias: Categoria[],
): Categoria | null {
  const k = chave(descricao);
  const ordenadas = [...regras].sort((a, b) => b.termo.length - a.termo.length);
  for (const r of ordenadas) {
    const cat = categorias.find((c) => c.id === r.categoriaId && c.tipo === tipo);
    if (cat && contemTermo(k, r.termo)) return cat;
  }
  return null;
}

// O que vem antes do nome de quem recebeu/pagou na descrição do banco.
const PREFIXOS =
  /^(?:(?:pix|ted|doc|transf\w*|transferencia|pagamento|pagto|pgto|compra|debito|credito|entrada|saida|enviad[oa]|recebid[oa]|de|da|do|para|pra|qr|code|no|na|em|ec)\s+)+/;

/**
 * Termo que identifica o lançamento numa regra: "Pix enviado Roberto Augusto Costa" → "roberto augusto costa",
 * "Compra débito Ty Grill" → "ty grill". Null se não sobrar nada útil.
 */
export function termoDaDescricao(descricao: string): string | null {
  const k = chave(descricao).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().replace(PREFIXOS, "");
  const termo = k.split(" ").filter(Boolean).slice(0, 5).join(" ");
  return termo.length >= 3 ? termo : null;
}
