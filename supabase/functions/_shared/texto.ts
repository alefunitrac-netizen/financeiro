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

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** O termo aparece no texto como palavra (ou palavras) inteira(s)? Os dois já em chave(). */
export function contemTermo(textoChave: string, termoChave: string): boolean {
  const t = termoChave.trim();
  if (!t) return false;
  return new RegExp(`(?<![a-z0-9])${escapar(t).replace(/\s+/g, "\\s+")}(?![a-z0-9])`).test(textoChave);
}
