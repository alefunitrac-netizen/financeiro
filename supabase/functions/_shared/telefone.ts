/**
 * Normaliza um número de WhatsApp para dígitos E.164.
 *
 * Pegadinha do Brasil: para muitos celulares, o WhatsApp entrega o `wa_id` SEM o
 * nono dígito (ex.: 551187654321 em vez de 5511987654321). Para comparar com o
 * número cadastrado, recolocamos o 9 em celulares (número local começando com 6–9).
 * Para RESPONDER, use sempre o wa_id original que veio da Meta.
 */
export function normalizarWhatsapp(numero: string): string {
  const d = numero.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4])) {
    return `${d.slice(0, 4)}9${d.slice(4)}`;
  }
  return d;
}
