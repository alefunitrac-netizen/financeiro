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
