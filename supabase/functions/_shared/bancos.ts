// Bancos brasileiros que o sistema reconhece pelo nome, em mensagens e em contas do Open Finance.
import { chave } from "./texto.ts";

/**
 * Nome oficial e como o banco aparece escrito (texto já em chave(): minúsculo e sem acento).
 * Os marcados como ambíguos são palavras comuns ("caixa de som", "inter"): numa mensagem só
 * contam depois de "cartão", "conta", "banco"...
 */
const AMBIGUOS = new Set(["Caixa", "Inter", "XP", "Next", "Banco do Brasil"]);
const BANCOS: [RegExp, string][] = [
  [/\bitau\b/, "Itaú"],
  [/\bnubank\b|\bnu pagamentos\b|\broxinho\b/, "Nubank"],
  [/\bbradesco\b/, "Bradesco"],
  [/\bsantander\b/, "Santander"],
  [/\bbanco do brasil\b|\bbb\b/, "Banco do Brasil"],
  [/\bcaixa\b|\bcef\b/, "Caixa"],
  [/\binter\b/, "Inter"],
  [/\bc6\b|\bc6 bank\b/, "C6 Bank"],
  [/\bbtg\b/, "BTG"],
  [/\bxp\b/, "XP"],
  [/\bpicpay\b/, "PicPay"],
  [/\bmercado pago\b/, "Mercado Pago"],
  [/\bsicoob\b/, "Sicoob"],
  [/\bsicredi\b/, "Sicredi"],
  [/\bneon\b/, "Neon"],
  [/\bpagbank\b|\bpagseguro\b/, "PagBank"],
  [/\bsafra\b/, "Safra"],
  [/\bbanrisul\b/, "Banrisul"],
  [/\bwill bank\b|\bwillbank\b/, "Will Bank"],
  [/\bnext\b/, "Next"],
];

const CONTEXTO = /\b(?:cartao|conta|banco|debito|credito|fatura|pix)\s+(?:(?:do|da|de|no|na)\s+)?$/;

/**
 * Primeiro banco citado no texto (com a posição, para recortar), ou null.
 * `mensagem`: texto livre digitado por você, onde os nomes ambíguos pedem contexto.
 */
export function acharBanco(texto: string, mensagem = false): { nome: string; inicio: number; fim: number } | null {
  const k = chave(texto);
  let melhor: { nome: string; inicio: number; fim: number } | null = null;
  for (const [re, nome] of BANCOS) {
    const global = new RegExp(re.source, "g");
    for (const m of k.matchAll(global)) {
      if (mensagem && AMBIGUOS.has(nome) && !CONTEXTO.test(k.slice(0, m.index))) continue;
      if (!melhor || m.index! < melhor.inicio) melhor = { nome, inicio: m.index!, fim: m.index! + m[0].length };
      break;
    }
  }
  return melhor;
}

/** Nome oficial do banco citado, ou null. */
export function bancoDoTexto(texto: string): string | null {
  return acharBanco(texto)?.nome ?? null;
}
