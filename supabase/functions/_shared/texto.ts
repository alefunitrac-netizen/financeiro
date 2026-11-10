// Utilidades de texto usadas pelo interpretador e pela integração com bancos.

/** Minúsculas e sem acento, com o MESMO comprimento do original (para recortar o original pelos índices). */
export function chave(texto: string): string {
  let saida = "";
  for (const ch of texto) {
    let base = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (base.length !== ch.length) base = " ".repeat(ch.length);
    saida += base;
  }
  return saida;
}
